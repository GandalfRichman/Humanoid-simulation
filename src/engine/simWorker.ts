/// <reference lib="webworker" />
/**
 * Simulation worker: owns MuJoCo (WASM) and the ONNX locomotion policy.
 *
 * Pipeline per control tick (every `decimation` physics steps, 50 Hz):
 *   observation (99) -> policy -> 29 joint position targets -> PD actuators
 * Policy slots for joints a robot variant doesn't have (G1 Basic) read as
 * "at default pose, zero velocity" and their actions are dropped.
 * Arm slots are held by user targets (robot.setJoint / moveJoint); leg and
 * waist slots belong to the policy unless explicitly overridden.
 *
 * The worker also answers the `robot` API RPCs coming from the user-code
 * worker over a MessagePort, and streams render frames through a
 * SharedArrayBuffer (postMessage fallback).
 */

// ORT is loaded at runtime from its pristine (unbundled) wasm-only build —
// bundling its Emscripten loader breaks pthread/worker spawning. Types only:
type OrtApi = typeof import("onnxruntime-web");
type OrtSession = import("onnxruntime-web").InferenceSession;
let ort: OrtApi | null = null;
import type {
  FromSim,
  GeomSpec,
  JointMeta,
  LoadPayload,
  MeshSpec,
  PolicyMeta,
  RpcRequest,
  RpcResponse,
  SceneSpec,
  SensorMeta,
  ToSim,
} from "../lib/types";
import { frameFloats } from "../lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */
type MjModule = any;
type MjModel = any;
type MjData = any;

const post = (msg: FromSim, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

const log = (level: "info" | "warn" | "error", text: string) =>
  post({ type: "log", level, text });

let mujoco: MjModule = null;
let model: MjModel = null;
let data: MjData = null;
let meta: PolicyMeta | null = null;
let session: OrtSession | null = null;

let running = false;
let speed = 1;
let simTime = 0;
let wallAnchor = 0; // performance.now() at last sync
let stepCount = 0;
let fallen = false;
let disposed = false;

/** policy slot plumbing (29 slots) */
let slotQposAdr: Int32Array;
let slotDofAdr: Int32Array;
let slotActId: Int32Array;
let slotPresent: Uint8Array;
let slotIsArm: Uint8Array;
let defaultPose: Float32Array;
let actionScales: Float32Array;
let lastAction: Float32Array;
let obsBuf: Float32Array;
let cmd = new Float32Array(3);
let policyTargets: Float32Array; // full 29-slot targets from last inference
/** per-slot override: user took a policy-owned joint (setJoint on leg/waist) */
let slotOverride: Uint8Array;
let warnedOverride = false;

/** per-actuator user-held targets (arms, fingers, overridden slots), by actuator id */
let userTargets: Float64Array;

/** actuator id -> ctrl range */
let actRange: Array<[number, number]> = [];

let joints: JointMeta[] = [];
let sensors: SensorMeta[] = [];
let nbody = 0;
let nsensordata = 0;

/** code-worker state mirror (for synchronous getters) */
let codePorts: MessagePort[] = [];
let codeStateBuf: Float32Array | null = null;

/** frame publishing */
let sab: SharedArrayBuffer | null = null;
let sabCtl: Int32Array | null = null;
let sabBufs: [Float32Array, Float32Array] | null = null;
let frameLen = 0;
let lastFramePost = 0;

/* ------------------------------------------------------------------ */
/* Task engine                                                         */
/* ------------------------------------------------------------------ */

interface PendingTask {
  rpcId: number;
  port: MessagePort | null; // null => main-thread rpc
  fail: (msg: string) => void;
  done: (value: unknown) => void;
}

interface LocomotionTask extends PendingTask {
  kind: "walk" | "turn" | "stand";
  // walk
  targetMeters?: number;
  speedCmd?: number;
  startXY?: [number, number];
  heading?: [number, number];
  // turn
  targetRad?: number;
  accumYaw?: number;
  lastYaw?: number;
  // stand / shared
  untilSim?: number;
  timeoutSim?: number;
}

interface JointMove extends PendingTask {
  actId: number;
  from: number;
  to: number;
  t0: number;
  dur: number;
}

interface WaitTask extends PendingTask {
  untilSim: number;
}

interface SettleTask extends PendingTask {
  actIds: number[];
  untilSim: number; // hard timeout
  jointDofs: number[];
}

let locomotion: LocomotionTask | null = null;
let jointMoves: JointMove[] = [];
let waits: WaitTask[] = [];
let settles: SettleTask[] = [];

function respond(task: PendingTask, res: RpcResponse) {
  if (task.port) task.port.postMessage(res);
  else post({ type: "rpcResponse", res } as unknown as FromSim);
}

function makeTask(rpcId: number, port: MessagePort | null): PendingTask {
  const base: PendingTask = {
    rpcId,
    port,
    done(value: unknown) {
      respond(this, { rpcId, ok: true, value });
    },
    fail(error: string) {
      respond(this, { rpcId, ok: false, error });
    },
  };
  return base;
}

function cancelAllTasks(reason: string) {
  locomotion?.fail(reason);
  locomotion = null;
  for (const t of [...jointMoves, ...waits, ...settles]) t.fail(reason);
  jointMoves = [];
  waits = [];
  settles = [];
}

/* ------------------------------------------------------------------ */
/* Math helpers                                                        */
/* ------------------------------------------------------------------ */

function quatRotateInv(q: Float64Array | number[], v: [number, number, number]): [number, number, number] {
  // rotate v by conjugate of unit quaternion q (wxyz)
  const w = q[0], x = q[1], y = q[2], z = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] - w * tx + (y * tz - z * ty),
    v[1] - w * ty + (z * tx - x * tz),
    v[2] - w * tz + (x * ty - y * tx),
  ];
}

function baseYaw(): number {
  const q = data.qpos;
  const w = q[3], x = q[4], y = q[5], z = q[6];
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

const deg2rad = (d: number) => (d * Math.PI) / 180;
const rad2deg = (r: number) => (r * 180) / Math.PI;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

async function handleLoad(payload: LoadPayload) {
  try {

    meta = payload.policyMeta;

    if (!mujoco) {
      // Import the unbundled Emscripten glue from its static URL: the pthread
      // build spawns nested workers from import.meta.url, which must be the
      // pristine glue file — never this bundled chunk.
      const glue = (await import(
        /* @vite-ignore */ payload.wasmBase + "mujoco/mujoco.js"
      )) as { default: (opts?: unknown) => Promise<MjModule> };
      mujoco = await glue.default();
      mujoco.FS.mkdir("/working");
      mujoco.FS.mkdir("/working/meshes");
    }

    // (re)write VFS content
    for (const [name, buf] of Object.entries(payload.meshFiles)) {
      mujoco.FS.writeFile("/working/meshes/" + name, new Uint8Array(buf));
    }
    mujoco.FS.writeFile("/working/robot.xml", payload.robotXml);
    mujoco.FS.writeFile("/working/scene.xml", payload.sceneXml);

    if (model) {
      try { data?.delete(); model?.delete(); } catch { /* ignore */ }
      model = data = null;
    }
    model = mujoco.MjModel.mj_loadXML("/working/scene.xml");
    data = new mujoco.MjData(model);

    if (!session) {
      if (!ort) {
        ort = (await import(
          /* @vite-ignore */ payload.wasmBase + "ort/ort.wasm.min.mjs"
        )) as OrtApi;
      }
      ort.env.wasm.wasmPaths = payload.wasmBase + "ort/";
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(payload.policyModel, {
        executionProviders: ["wasm"],
        graphOptimizationLevel: "all",
        externalData: [
          { path: "walker.onnx.data", data: new Uint8Array(payload.policyData) },
        ],
      });
    }

    buildPlumbing();
    resetState();

    const spec = buildSceneSpec(payload);
    frameLen = frameFloats(nbody, joints.length, nsensordata);
    sab = null;
    if (payload.useSab && typeof SharedArrayBuffer !== "undefined") {
      sab = new SharedArrayBuffer(8 + frameLen * 2 * 4);
      sabCtl = new Int32Array(sab, 0, 2);
      sabBufs = [
        new Float32Array(sab, 8, frameLen),
        new Float32Array(sab, 8 + frameLen * 4, frameLen),
      ];
    }

    const transfers: Transferable[] = [];
    for (const mesh of spec.meshes) {
      transfers.push(mesh.vertices.buffer, mesh.normals.buffer, mesh.faces.buffer);
    }
    post({ type: "loaded", spec, sab, frameFloats: frameLen }, transfers);
    publishFrame(true);
  } catch (err) {
    post({ type: "loadError", message: String(err instanceof Error ? err.message : err) });
  }
}

function buildPlumbing() {
  const m = meta!;
  const n = m.jointOrder.length;
  slotQposAdr = new Int32Array(n).fill(-1);
  slotDofAdr = new Int32Array(n).fill(-1);
  slotActId = new Int32Array(n).fill(-1);
  slotPresent = new Uint8Array(n);
  slotIsArm = new Uint8Array(n);
  defaultPose = new Float32Array(n);
  actionScales = new Float32Array(n);
  lastAction = new Float32Array(n);
  policyTargets = new Float32Array(n);
  slotOverride = new Uint8Array(n);
  obsBuf = new Float32Array(m.obsSize);

  for (let i = 0; i < n; i++) {
    const name = m.jointOrder[i];
    defaultPose[i] = m.defaultPose[name] ?? 0;
    actionScales[i] = m.actionScales[name] ?? 0.25;
    slotIsArm[i] = /shoulder|elbow|wrist/.test(name) ? 1 : 0;
    try {
      const j = model.jnt(name);
      slotQposAdr[i] = Number(j.qposadr);
      slotDofAdr[i] = Number(j.dofadr);
      slotPresent[i] = 1;
    } catch {
      slotPresent[i] = 0; // welded on this variant (G1 Basic)
    }
    try {
      slotActId[i] = model.actuator(name).id;
    } catch {
      slotActId[i] = -1;
    }
  }

  nbody = model.nbody;
  nsensordata = model.nsensordata;

  userTargets = new Float64Array(model.nu);
  actRange = [];
  for (let a = 0; a < model.nu; a++) {
    const r = model.actuator(a).ctrlrange;
    actRange.push([r[0], r[1]]);
  }

  joints = buildJointMeta();
  sensors = buildSensorMeta();
}

function classifyJoint(name: string): { group: JointMeta["group"]; side: JointMeta["side"] } {
  const side = name.startsWith("left_") ? "left" : name.startsWith("right_") ? "right" : "center";
  if (/hip|knee|ankle/.test(name)) return { group: "leg", side };
  if (/shoulder|elbow|wrist/.test(name)) return { group: "arm", side };
  if (/waist/.test(name)) return { group: "waist", side };
  return { group: "hand", side };
}

function buildJointMeta(): JointMeta[] {
  const out: JointMeta[] = [];
  const policySet = new Set(meta!.jointOrder);
  for (let i = 0; i < model.njnt; i++) {
    const j = model.jnt(i);
    if (Number(j.type) !== 3) continue; // hinge joints only (skip freejoints)
    const name: string = j.name;
    if (!name) continue;
    const { group, side } = classifyJoint(name);
    let actuated = true;
    try { model.actuator(name); } catch { actuated = false; }
    const range = Array.from(j.range) as number[];
    out.push({
      name,
      id: j.id,
      qposAdr: Number(j.qposadr),
      dofAdr: Number(j.dofadr),
      range: [rad2deg(range[0]), rad2deg(range[1])],
      bodyId: Number(j.bodyid),
      bodyName: model.body(Number(j.bodyid)).name,
      actuated,
      policyOwned: policySet.has(name) && (group === "leg" || group === "waist"),
      group,
      side,
    });
  }
  return out;
}

const SENSOR_KINDS: Record<number, string> = {
  40: "gyro", 41: "accelerometer", 0: "touch",
};

function buildSensorMeta(): SensorMeta[] {
  const out: SensorMeta[] = [];
  for (let i = 0; i < model.nsensor; i++) {
    const s = model.sensor(i);
    const name: string = s.name;
    if (!name) continue;
    const dim = Number(s.dim);
    const type = Number(s.type);
    out.push({
      name,
      id: i,
      adr: Number(s.adr),
      dim,
      kind: SENSOR_KINDS[type] ?? `type${type}`,
      bodyOrSite: "",
    });
  }
  return out;
}

function buildSceneSpec(payload: LoadPayload): SceneSpec {
  const geoms: GeomSpec[] = [];
  for (let g = 0; g < model.ngeom; g++) {
    const geom = model.geom(g);
    const rgba = Array.from(geom.rgba) as number[];
    let effective = rgba as [number, number, number, number];
    const matId = Number(geom.matid);
    const isDefaultRgba =
      Math.abs(rgba[0] - 0.5) < 1e-6 && Math.abs(rgba[1] - 0.5) < 1e-6 && Math.abs(rgba[2] - 0.5) < 1e-6;
    if (matId >= 0 && isDefaultRgba) {
      effective = Array.from(model.mat(matId).rgba) as [number, number, number, number];
    }
    geoms.push({
      name: geom.name || "",
      bodyId: Number(geom.bodyid),
      type: Number(geom.type),
      size: Array.from(geom.size) as [number, number, number],
      pos: Array.from(geom.pos) as [number, number, number],
      quat: Array.from(geom.quat) as [number, number, number, number],
      rgba: effective,
      group: Number(geom.group),
      meshId: Number(geom.dataid),
    });
  }

  const meshes: MeshSpec[] = [];
  const usedMeshIds = new Set(geoms.filter((g) => g.type === 7 && g.meshId >= 0).map((g) => g.meshId));
  for (const id of usedMeshIds) {
    const mesh = model.mesh(id);
    const vertAdr = Number(mesh.vertadr), vertNum = Number(mesh.vertnum);
    const faceAdr = Number(mesh.faceadr), faceNum = Number(mesh.facenum);
    meshes.push({
      id,
      name: mesh.name,
      vertices: new Float32Array(model.mesh_vert.subarray(vertAdr * 3, (vertAdr + vertNum) * 3)),
      normals: new Float32Array(model.mesh_normal.subarray(vertAdr * 3, (vertAdr + vertNum) * 3)),
      faces: new Uint32Array(model.mesh_face.subarray(faceAdr * 3, (faceAdr + faceNum) * 3)),
    });
  }

  const bodies = [];
  for (let b = 0; b < nbody; b++) {
    bodies.push({ name: model.body(b).name || `body_${b}`, id: b, jointNames: [] as string[] });
  }
  for (const j of joints) bodies[j.bodyId].jointNames.push(j.name);

  const welded = meta!.jointOrder.filter((_, i) => !slotPresent[i]);

  return {
    nbody,
    bodies,
    geoms,
    meshes,
    joints,
    sensors,
    robotId: payload.robotId as SceneSpec["robotId"],
    sceneId: payload.sceneId as SceneSpec["sceneId"],
    weldedPolicySlots: welded,
  };
}

/* ------------------------------------------------------------------ */
/* Reset + state                                                       */
/* ------------------------------------------------------------------ */

function resetState() {
  mujoco.mj_resetData(model, data);
  const qpos = data.qpos;
  qpos[2] = meta!.spawnHeight;
  qpos[3] = 1; qpos[4] = 0; qpos[5] = 0; qpos[6] = 0;
  for (let i = 0; i < slotQposAdr.length; i++) {
    if (slotPresent[i]) qpos[slotQposAdr[i]] = defaultPose[i];
  }
  mujoco.mj_forward(model, data);

  lastAction.fill(0);
  cmd.fill(0);
  slotOverride.fill(0);
  policyTargets.set(defaultPose);
  fallen = false;
  simTime = data.time;
  stepCount = 0;

  // user targets: policy joints at default pose, everything else 0
  userTargets.fill(0);
  for (let i = 0; i < slotActId.length; i++) {
    if (slotActId[i] >= 0) userTargets[slotActId[i]] = defaultPose[i];
  }
}

/* ------------------------------------------------------------------ */
/* Control + stepping                                                  */
/* ------------------------------------------------------------------ */

function buildObs(): Float32Array {
  const qpos = data.qpos, qvel = data.qvel;
  const quat = [qpos[3], qpos[4], qpos[5], qpos[6]];
  const linVel = quatRotateInv(quat, [qvel[0], qvel[1], qvel[2]]);
  const grav = quatRotateInv(quat, [0, 0, -1]);
  const o = obsBuf;
  o[0] = linVel[0]; o[1] = linVel[1]; o[2] = linVel[2];
  o[3] = qvel[3]; o[4] = qvel[4]; o[5] = qvel[5];
  o[6] = grav[0]; o[7] = grav[1]; o[8] = grav[2];
  const n = slotQposAdr.length;
  for (let i = 0; i < n; i++) {
    if (slotPresent[i]) {
      o[9 + i] = qpos[slotQposAdr[i]] - defaultPose[i];
      o[9 + n + i] = qvel[slotDofAdr[i]];
    } else {
      o[9 + i] = 0;
      o[9 + n + i] = 0;
    }
    o[9 + 2 * n + i] = lastAction[i];
  }
  o[9 + 3 * n] = cmd[0]; o[9 + 3 * n + 1] = cmd[1]; o[9 + 3 * n + 2] = cmd[2];
  return o;
}

async function controlStep() {
  updateLocomotionTask();
  const feeds = { [session!.inputNames[0]]: new ort!.Tensor("float32", buildObs(), [1, meta!.obsSize]) };
  const result = await session!.run(feeds);
  const action = result[session!.outputNames[0]].data as Float32Array;
  lastAction.set(action);
  for (let i = 0; i < action.length; i++) {
    policyTargets[i] = defaultPose[i] + action[i] * actionScales[i];
  }
}

function applyControls() {
  const ctrl = data.ctrl;
  // start from user-held targets for every actuator (arms, fingers, overrides)
  for (let a = 0; a < userTargets.length; a++) {
    const [lo, hi] = actRange[a];
    ctrl[a] = clamp(userTargets[a], lo, hi);
  }
  // policy-owned slots (legs + waist, not overridden, not arm)
  for (let i = 0; i < policyTargets.length; i++) {
    const a = slotActId[i];
    if (a < 0) continue;
    if (slotIsArm[i] || slotOverride[i]) continue;
    const [lo, hi] = actRange[a];
    ctrl[a] = clamp(policyTargets[i], lo, hi);
  }
}

function detectFall() {
  const qpos = data.qpos;
  const grav = quatRotateInv([qpos[3], qpos[4], qpos[5], qpos[6]], [0, 0, -1]);
  const wasFallen = fallen;
  if (grav[2] > -0.4 || qpos[2] < 0.35) fallen = true;
  if (fallen && !wasFallen) {
    post({ type: "policyEvent", event: "fell" });
    cancelAllTasks("the robot fell over — press Reset to stand it back up");
    cmd.fill(0);
  }
}

function progressTasks() {
  const t = data.time;

  // joint interpolations
  jointMoves = jointMoves.filter((mv) => {
    const k = clamp((t - mv.t0) / mv.dur, 0, 1);
    userTargets[mv.actId] = mv.from + (mv.to - mv.from) * k;
    if (k >= 1) { mv.done(undefined); return false; }
    return true;
  });

  waits = waits.filter((w) => {
    if (t >= w.untilSim) { w.done(undefined); return false; }
    return true;
  });

  settles = settles.filter((s) => {
    if (t >= s.untilSim) { s.done(undefined); return false; }
    let still = true;
    for (const dof of s.jointDofs) {
      if (Math.abs(data.qvel[dof]) > 0.35) { still = false; break; }
    }
    if (still && t >= s.untilSim - 1.2) { s.done(undefined); return false; }
    return true;
  });
}

function updateLocomotionTask() {
  const lt = locomotion;
  if (!lt) return;
  const t = data.time;
  if (lt.timeoutSim && t > lt.timeoutSim) {
    cmd.fill(0);
    locomotion = null;
    // forgiving: report progress but let the program continue
    const progress =
      lt.kind === "walk"
        ? `${(Math.abs((data.qpos[0] - lt.startXY![0]) * lt.heading![0] + (data.qpos[1] - lt.startXY![1]) * lt.heading![1])).toFixed(2)} of ${Math.abs(lt.targetMeters!).toFixed(2)} m`
        : lt.kind === "turn"
          ? `${((Math.abs(lt.accumYaw ?? 0) * 180) / Math.PI).toFixed(0)} of ${((Math.abs(lt.targetRad!) * 180) / Math.PI).toFixed(0)}°`
          : "";
    log("warn", `${lt.kind} ran out of time (${progress}) — continuing with the next command.`);
    lt.done(undefined);
    return;
  }
  if (lt.kind === "walk") {
    const dx = data.qpos[0] - lt.startXY![0];
    const dy = data.qpos[1] - lt.startXY![1];
    const along = dx * lt.heading![0] + dy * lt.heading![1];
    if (Math.abs(along) >= Math.abs(lt.targetMeters!)) {
      cmd.fill(0);
      locomotion = null;
      lt.done(undefined);
    }
  } else if (lt.kind === "turn") {
    const yaw = baseYaw();
    let d = yaw - (lt.lastYaw ?? yaw);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    lt.accumYaw = (lt.accumYaw ?? 0) + d;
    lt.lastYaw = yaw;
    if (Math.abs(lt.accumYaw) >= Math.abs(lt.targetRad!)) {
      cmd.fill(0);
      locomotion = null;
      lt.done(undefined);
    }
  } else if (lt.kind === "stand") {
    if (t >= lt.untilSim!) {
      locomotion = null;
      lt.done(undefined);
    }
  }
}

let pumping = false;
async function pump() {
  if (pumping || !running || !model || disposed) return;
  pumping = true;
  try {
    const now = performance.now();
    let wallTarget = simTime + ((now - wallAnchor) / 1000) * speed;
    // never try to catch up more than 100 ms of sim time in one pump
    if (wallTarget - simTime > 0.1) {
      simTime = wallTarget - 0.1;
    }
    const dt = model.opt.timestep as number;
    while (simTime < wallTarget && running) {
      if (stepCount % meta!.controlDecimation === 0) await controlStep();
      applyControls();
      mujoco.mj_step(model, data);
      stepCount++;
      simTime += dt;
      progressTasks();
      detectFall();
    }
    wallAnchor = performance.now();
    publishFrame();
  } catch (err) {
    running = false;
    log("error", "Simulation error: " + String(err instanceof Error ? err.message : err));
  } finally {
    pumping = false;
  }
}

setInterval(pump, 8);
setInterval(() => {
  if (model) {
    post({ type: "status", running, fallen, simTime: data?.time ?? 0, realtimeFactor: speed });
  }
}, 250);

async function stepOnce(count: number) {
  if (!model || running) return;
  for (let i = 0; i < count; i++) {
    if (stepCount % meta!.controlDecimation === 0) await controlStep();
    applyControls();
    mujoco.mj_step(model, data);
    stepCount++;
    progressTasks();
    detectFall();
  }
  simTime = data.time;
  publishFrame(true);
}

/* ------------------------------------------------------------------ */
/* Frame publishing                                                    */
/* ------------------------------------------------------------------ */

function fillFrame(buf: Float32Array) {
  buf[0] = data.time;
  buf[1] = fallen ? 1 : 0;
  const xpos = data.xpos, xquat = data.xquat;
  let o = 2;
  for (let b = 0; b < nbody; b++) {
    buf[o++] = xpos[b * 3]; buf[o++] = xpos[b * 3 + 1]; buf[o++] = xpos[b * 3 + 2];
  }
  for (let b = 0; b < nbody; b++) {
    buf[o++] = xquat[b * 4]; buf[o++] = xquat[b * 4 + 1];
    buf[o++] = xquat[b * 4 + 2]; buf[o++] = xquat[b * 4 + 3];
  }
  const qpos = data.qpos, ctrl = data.ctrl;
  for (const j of joints) buf[o++] = qpos[j.qposAdr];
  for (const j of joints) {
    let target = NaN;
    if (j.actuated) {
      try { target = ctrl[model.actuator(j.name).id]; } catch { /* unnamed */ }
    }
    buf[o++] = target;
  }
  const sd = data.sensordata;
  for (let i = 0; i < nsensordata; i++) buf[o++] = sd[i];
}

function publishFrame(force = false) {
  if (!model) return;
  const now = performance.now();
  if (!force && now - lastFramePost < 15) return;
  lastFramePost = now;
  if (sab && sabCtl && sabBufs) {
    const next = 1 - Atomics.load(sabCtl, 1);
    fillFrame(sabBufs[next]);
    Atomics.store(sabCtl, 1, next);
    Atomics.add(sabCtl, 0, 1);
  } else {
    const buf = new Float32Array(frameLen);
    fillFrame(buf);
    post({ type: "frame", buffer: buf } as FromSim, [buf.buffer]);
  }
  publishCodeState();
}

/** Compact state block feeding the code worker's synchronous getters.
 *  Layout matches CODE_STATE_* in types.ts. */
function buildCodeState(): Float32Array {
  const buf = codeStateBuf ?? (codeStateBuf = new Float32Array(2 + 13 + joints.length + nsensordata));
  const qpos = data.qpos, qvel = data.qvel, sd = data.sensordata;
  buf[0] = data.time;
  buf[1] = fallen ? 1 : 0;
  // base pose + velocity (world frame), from the free joint
  for (let i = 0; i < 7; i++) buf[2 + i] = qpos[i];
  for (let i = 0; i < 6; i++) buf[9 + i] = qvel[i];
  let o = 2 + 13;
  for (const j of joints) buf[o++] = qpos[j.qposAdr];
  for (let i = 0; i < nsensordata; i++) buf[o++] = sd[i];
  return buf;
}

function publishCodeState() {
  if (!codePorts.length || !model) return;
  const buf = buildCodeState();
  for (const port of codePorts) {
    // copy so each port gets an independent snapshot (structured clone)
    port.postMessage({ state: buf.slice(0) });
  }
}

/* ------------------------------------------------------------------ */
/* Robot RPC                                                           */
/* ------------------------------------------------------------------ */

const FINGER_JOINTS: Record<string, string[]> = {
  thumb: ["thumb_2"], index: ["index_1"], middle: ["middle_1"],
  ring: ["ring_1"], little: ["little_1"],
};

function fingerActId(hand: string, frag: string): number {
  try { return model.actuator(`${hand}_${frag}_joint`).id; } catch { return -1; }
}

function hasHands(): boolean {
  return fingerActId("left", "index_1") >= 0;
}

function jointByName(name: string): JointMeta | undefined {
  return joints.find((j) => j.name === name);
}

function friendlyJointError(name: string): string {
  const suggestions = joints
    .filter((j) => j.name.includes(name.split("_")[0]) || name.split("_").some((p) => p.length > 2 && j.name.includes(p)))
    .slice(0, 4)
    .map((j) => j.name);
  const hint = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : " Call robot.listJoints() to see all joints.";
  return `Joint "${name}" doesn't exist on this robot.${hint}`;
}

function handGuard(): string | null {
  if (!hasHands()) {
    return "This robot (G1 Basic) has fixed, non-articulated hands. Switch to the G1 EDU U6 to use fingers, grasping and finger force sensing.";
  }
  return null;
}

function handleCall(req: RpcRequest, port: MessagePort | null) {
  const { rpcId, call } = req;
  const task = makeTask(rpcId, port);
  // Not-ready guard: reject clearly instead of ever answering from a
  // half-initialised state (e.g. model compiled but joint metadata not yet
  // built), which is what makes listJoints() look like it "returned nothing".
  if (!model || joints.length === 0) {
    return task.fail(
      "The robot isn't loaded yet — wait for loading to finish (or press Reset) before calling the robot API.",
    );
  }

  try {
    switch (call.kind) {
      case "setVelocity": {
        if (fallen) return task.fail("The robot has fallen — Reset the simulation first.");
        clearOverrides();
        const lim = meta!.commandLimits;
        cmd[0] = clamp(call.vx, lim.vx[0], lim.vx[1]);
        cmd[1] = clamp(call.vy, lim.vy[0], lim.vy[1]);
        cmd[2] = clamp(call.yawRate, lim.yawRate[0], lim.yawRate[1]);
        locomotion?.fail("superseded by a newer locomotion command");
        locomotion = null;
        return task.done(undefined);
      }
      case "walk": {
        if (fallen) return task.fail("The robot has fallen — Reset the simulation first.");
        if (!Number.isFinite(call.meters) || call.meters === 0) return task.fail("walkForward needs a non-zero distance in meters.");
        clearOverrides();
        locomotion?.fail("superseded by a newer locomotion command");
        const speedCmd = clamp(Math.abs(call.speed ?? 0.75), 0.2, meta!.commandLimits.vx[1]);
        const yaw = baseYaw();
        const lt = task as LocomotionTask;
        lt.kind = "walk";
        lt.targetMeters = call.meters;
        lt.startXY = [data.qpos[0], data.qpos[1]];
        lt.heading = [Math.cos(yaw), Math.sin(yaw)];
        lt.timeoutSim = data.time + (Math.abs(call.meters) / speedCmd) * 3 + 8;
        cmd[0] = Math.sign(call.meters) * speedCmd;
        cmd[1] = 0; cmd[2] = 0;
        locomotion = lt;
        return;
      }
      case "turn": {
        if (fallen) return task.fail("The robot has fallen — Reset the simulation first.");
        if (!Number.isFinite(call.degrees) || call.degrees === 0) return task.fail("turn needs a non-zero angle in degrees (positive = left).");
        clearOverrides();
        locomotion?.fail("superseded by a newer locomotion command");
        const lt = task as LocomotionTask;
        lt.kind = "turn";
        lt.targetRad = deg2rad(call.degrees);
        lt.lastYaw = baseYaw();
        lt.accumYaw = 0;
        lt.timeoutSim = data.time + Math.abs(deg2rad(call.degrees)) / 0.35 + 8;
        // this joystick policy tracks yaw poorly when standing still — a small
        // forward bias makes it step and turn ~6x faster (gentle arc)
        cmd[0] = 0.2; cmd[1] = 0;
        cmd[2] = Math.sign(call.degrees) * 1.0;
        locomotion = lt;
        return;
      }
      case "stand": {
        clearOverrides();
        locomotion?.fail("superseded by a newer locomotion command");
        cmd.fill(0);
        const lt = task as LocomotionTask;
        lt.kind = "stand";
        lt.untilSim = data.time + 0.6;
        locomotion = lt;
        return;
      }
      case "setJoint":
      case "moveJoint": {
        const j = jointByName(call.name);
        if (!j) return task.fail(friendlyJointError(call.name));
        if (!j.actuated) return task.fail(`Joint "${call.name}" is a passive coupled joint — drive "${call.name.replace(/_[34]_joint/, "_2_joint").replace(/_2_joint$/, "_1_joint")}" instead.`);
        const actId = model.actuator(call.name).id;
        const target = clamp(deg2rad(call.degrees), deg2rad(j.range[0]), deg2rad(j.range[1]));
        if (j.policyOwned && !slotOverride[metaSlot(call.name)]) {
          slotOverride[metaSlot(call.name)] = 1;
          if (!warnedOverride) {
            warnedOverride = true;
            log("warn", `Taking "${call.name}" away from the balance policy — direct leg/waist control can make the robot fall. It returns to the policy on walk/stand/setVelocity.`);
          }
        }
        if (call.kind === "setJoint") {
          userTargets[actId] = target;
          return task.done(undefined);
        }
        const secs = Math.max(0.05, call.seconds);
        const mv = task as JointMove;
        mv.actId = actId;
        mv.from = userTargets[actId];
        mv.to = target;
        mv.t0 = data.time;
        mv.dur = secs;
        jointMoves.push(mv);
        return;
      }
      case "getJoint": {
        const j = jointByName(call.name);
        if (!j) return task.fail(friendlyJointError(call.name));
        return task.done(rad2deg(data.qpos[j.qposAdr]));
      }
      case "listJoints":
        return task.done(joints.map((j) => j.name));
      case "listSensors":
        return task.done([
          ...sensors.map((s) => s.name),
          "base_position", "base_orientation", "base_linear_velocity", "base_angular_velocity",
        ]);
      case "getSensor": {
        const virtual = readVirtualSensor(call.name);
        if (virtual) return task.done(virtual.length === 1 ? virtual[0] : Array.from(virtual));
        const s = sensors.find((x) => x.name === call.name);
        if (!s) return task.fail(`Sensor "${call.name}" doesn't exist. Call robot.listSensors() to see all sensors.`);
        const vals = Array.from(data.sensordata.subarray(s.adr, s.adr + s.dim)) as number[];
        return task.done(vals.length === 1 ? vals[0] : vals);
      }
      case "wait": {
        if (!Number.isFinite(call.seconds) || call.seconds < 0) return task.fail("wait needs a non-negative number of seconds.");
        const w = task as WaitTask;
        w.untilSim = data.time + call.seconds;
        waits.push(w);
        return;
      }
      case "setFinger": {
        const guard = handGuard();
        if (guard) return task.fail(guard);
        const frags = FINGER_JOINTS[call.finger];
        if (!frags) return task.fail(`Unknown finger "${call.finger}". Fingers: thumb, index, middle, ring, little.`);
        const amount = clamp(call.amount, 0, 1);
        for (const frag of frags) {
          const a = fingerActId(call.hand, frag);
          if (a >= 0) {
            const [lo, hi] = actRange[a];
            userTargets[a] = lo + (hi - lo) * amount;
          }
        }
        return task.done(undefined);
      }
      case "grasp": {
        const guard = handGuard();
        if (guard) return task.fail(guard);
        const strength = clamp(call.strength ?? 0.85, 0, 1);
        const dofs: number[] = [];
        const actIds: number[] = [];
        // thumb opposition + curl, then all finger curls
        for (const frag of ["thumb_1", "thumb_2", "index_1", "middle_1", "ring_1", "little_1"]) {
          const a = fingerActId(call.hand, frag);
          if (a < 0) continue;
          const [lo, hi] = actRange[a];
          const k = frag === "thumb_1" ? 0.55 : strength;
          userTargets[a] = lo + (hi - lo) * k;
          actIds.push(a);
          const j = jointByName(`${call.hand}_${frag}_joint`);
          if (j) dofs.push(j.dofAdr);
        }
        const st = task as SettleTask;
        st.actIds = actIds;
        st.jointDofs = dofs;
        st.untilSim = data.time + 1.6;
        settles.push(st);
        return;
      }
      case "release": {
        const guard = handGuard();
        if (guard) return task.fail(guard);
        const dofs: number[] = [];
        for (const frag of ["thumb_1", "thumb_2", "index_1", "middle_1", "ring_1", "little_1"]) {
          const a = fingerActId(call.hand, frag);
          if (a < 0) continue;
          userTargets[a] = 0;
          const j = jointByName(`${call.hand}_${frag}_joint`);
          if (j) dofs.push(j.dofAdr);
        }
        const st = task as SettleTask;
        st.actIds = [];
        st.jointDofs = dofs;
        st.untilSim = data.time + 1.2;
        settles.push(st);
        return;
      }
      case "getFingerForce": {
        const guard = handGuard();
        if (guard) return task.fail(guard);
        const s = sensors.find((x) => x.name === `${call.hand}_${call.finger}_touch`);
        if (!s) return task.fail(`No touch sensor for finger "${call.finger}". Fingers: thumb, index, middle, ring, little.`);
        return task.done(data.sensordata[s.adr]);
      }
      case "getPose": {
        const q = data.qpos;
        return task.done({
          position: [q[0], q[1], q[2]],
          quaternion: [q[3], q[4], q[5], q[6]],
          yawDeg: rad2deg(baseYaw()),
        });
      }
      default:
        return task.fail(`Unknown robot call: ${(call as { kind: string }).kind}`);
    }
  } catch (err) {
    task.fail(String(err instanceof Error ? err.message : err));
  }
}

function metaSlot(name: string): number {
  return meta!.jointOrder.indexOf(name);
}

function clearOverrides() {
  if (slotOverride.some((v) => v)) {
    slotOverride.fill(0);
    log("info", "Leg/waist joints returned to the balance policy.");
  }
}

function readVirtualSensor(name: string): number[] | null {
  const q = data.qpos, v = data.qvel;
  switch (name) {
    case "base_position": return [q[0], q[1], q[2]];
    case "base_orientation": return [q[3], q[4], q[5], q[6]];
    case "base_linear_velocity": return [v[0], v[1], v[2]];
    case "base_angular_velocity": return [v[3], v[4], v[5]];
    default: return null;
  }
}

/* ------------------------------------------------------------------ */
/* Message handling                                                    */
/* ------------------------------------------------------------------ */

self.onmessage = (ev: MessageEvent<ToSim | { type: "rpc"; req: RpcRequest }>) => {
  const msg = ev.data;
  switch (msg.type) {
    case "load":
      void handleLoad(msg.payload);
      break;
    case "play":
      if (!running) {
        running = true;
        wallAnchor = performance.now();
      }
      break;
    case "pause":
      running = false;
      publishFrame(true);
      break;
    case "reset":
      cancelAllTasks("the simulation was reset");
      resetState();
      publishFrame(true);
      break;
    case "stepOnce":
      void stepOnce(msg.count);
      break;
    case "setSpeed":
      speed = msg.speed;
      wallAnchor = performance.now();
      break;
    case "connectCode": {
      const port = msg.port;
      port.onmessage = (e: MessageEvent<RpcRequest>) => handleCall(e.data, port);
      // one code worker runs at a time (the runner stops the prior one), so
      // replace rather than accumulate — avoids pushing to dead ports
      codePorts = [port];
      if (model) port.postMessage({ state: buildCodeState().slice(0) });
      break;
    }
    case "cancelTasks":
      cancelAllTasks(msg.reason);
      cmd.fill(0);
      clearOverrides();
      break;
    case "rpc":
      handleCall(msg.req, null);
      break;
  }
};
