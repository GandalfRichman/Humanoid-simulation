/// <reference lib="webworker" />
/**
 * User-code sandbox. Runs the program inside an async function with a `robot`
 * proxy API built on top of a MessagePort wired to the simulation worker.
 *
 * API shape follows the build brief §5:
 *   - read/instant methods are SYNCHRONOUS (getJoint, listJoints, getSensor,
 *     getFingerForce, getPose; setJoint, setVelocity, setFinger). They read a
 *     locally-mirrored snapshot of sim state (pushed over the port ~60 Hz) and
 *     validate against joint/sensor metadata, so no await is needed.
 *   - motion/time methods stay async and resolve on completion (walkForward,
 *     walkBackward, turn, stand, moveJoint, wait, grasp, release).
 *
 * Awaiting a synchronous method still works (`await robot.getJoint(x)` returns
 * the value), so both calling styles are valid.
 */

import type { CodeMeta, FromCode, RobotCall, RpcResponse, ToCode } from "../lib/types";
import { CODE_STATE_BASE, CODE_STATE_HEADER } from "../lib/types";

const post = (msg: FromCode) => (self as unknown as Worker).postMessage(msg);

let simPort: MessagePort | null = null;
let meta: CodeMeta | null = null;
let live: Float32Array | null = null; // latest state snapshot
let nJoint = 0;
let sensorBase = 0; // index in `live` where sensordata begins
const jointIndex = new Map<string, number>();

let rpcSeq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let onFirstState: (() => void) | null = null;

/* ------------------------------- helpers -------------------------------- */

const rad2deg = (r: number) => (r * 180) / Math.PI;
const clampAmt = (v: number) => Math.min(1, Math.max(0, v));

function rpc<T>(call: RobotCall): Promise<T> {
  if (!simPort) return Promise.reject(new Error("Simulation not connected"));
  const rpcId = rpcSeq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(rpcId, { resolve: resolve as (v: unknown) => void, reject });
    simPort!.postMessage({ rpcId, call });
  });
}

/** fire-and-forget: post the command, swallow any late sim-side rejection */
function fireForget(call: RobotCall) {
  void rpc(call).catch(() => {});
}

function requireState(): Float32Array {
  if (!live) throw new Error("The robot isn't ready yet.");
  return live;
}

function jointOrThrow(name: string): number {
  const idx = jointIndex.get(name);
  if (idx === undefined) {
    const parts = name.split("_").filter((p) => p.length > 2);
    const suggestions = meta!.joints
      .filter((j) => parts.some((p) => j.name.includes(p)))
      .slice(0, 4)
      .map((j) => j.name);
    const hint = suggestions.length
      ? ` Did you mean: ${suggestions.join(", ")}?`
      : " Call robot.listJoints() to see all joints.";
    throw new Error(`Joint "${name}" doesn't exist on this robot.${hint}`);
  }
  return idx;
}

function handGuard() {
  if (!meta!.hasHands) {
    throw new Error(
      "This robot (G1 Basic) has fixed, non-articulated hands. Switch to the G1 EDU U6 to use fingers, grasping and finger force sensing.",
    );
  }
}

function readSensor(name: string): number | number[] {
  const s = requireState();
  switch (name) {
    case "base_position": return [s[2], s[3], s[4]];
    case "base_orientation": return [s[5], s[6], s[7], s[8]];
    case "base_linear_velocity": return [s[9], s[10], s[11]];
    case "base_angular_velocity": return [s[12], s[13], s[14]];
  }
  // exact, then case-insensitive substring, then by sensor kind keyword
  const sensors = meta!.sensors;
  let match = sensors.find((x) => x.name === name);
  if (!match) {
    const low = name.toLowerCase();
    match = sensors.find((x) => x.name.toLowerCase().includes(low)) ??
      sensors.find((x) => x.kind.toLowerCase().includes(low) || low.includes(x.kind.toLowerCase()));
  }
  if (!match) {
    throw new Error(`Sensor "${name}" doesn't exist. Call robot.listSensors() to see all sensors.`);
  }
  const start = sensorBase + match.adr;
  const vals: number[] = [];
  for (let i = 0; i < match.dim; i++) vals.push(s[start + i]);
  return vals.length === 1 ? vals[0] : vals;
}

function formatValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (v === undefined) return "undefined";
  try {
    return JSON.stringify(v, (_k, val) => (typeof val === "number" ? Math.round(val * 10000) / 10000 : val));
  } catch {
    return String(v);
  }
}

/* --------------------------------- API ---------------------------------- */

function buildApi() {
  const num = (v: unknown, what: string): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${what} must be a finite number, got ${formatValue(v)}`);
    return n;
  };
  const handName = (h: unknown): "left" | "right" => {
    if (h !== "left" && h !== "right") throw new Error(`hand must be "left" or "right", got ${formatValue(h)}`);
    return h;
  };
  const FINGERS = ["thumb", "index", "middle", "ring", "little"];
  const fingerName = (f: unknown): string => {
    if (typeof f !== "string" || !FINGERS.includes(f)) {
      throw new Error(`finger must be one of ${FINGERS.join(", ")}, got ${formatValue(f)}`);
    }
    return f;
  };

  const robot = {
    // ---- locomotion (async: resolves when the motion completes) ----
    walkForward: (meters: unknown, speed?: unknown) =>
      rpc({ kind: "walk", meters: num(meters, "meters"), speed: speed === undefined ? undefined : num(speed, "speed") }),
    walkBackward: (meters: unknown, speed?: unknown) =>
      rpc({ kind: "walk", meters: -num(meters, "meters"), speed: speed === undefined ? undefined : num(speed, "speed") }),
    turn: (degrees: unknown) => rpc({ kind: "turn", degrees: num(degrees, "degrees") }),
    stand: () => rpc({ kind: "stand" }),

    // ---- instant setters (sync: void) ----
    setVelocity: (vx: unknown, vy: unknown, yawRate: unknown): void => {
      fireForget({ kind: "setVelocity", vx: num(vx, "vx"), vy: num(vy, "vy"), yawRate: num(yawRate, "yawRate") });
    },
    setJoint: (name: unknown, degrees: unknown): void => {
      const jn = String(name);
      jointOrThrow(jn);
      const j = meta!.joints.find((x) => x.name === jn)!;
      if (!j.actuated) {
        throw new Error(`Joint "${jn}" is a passive coupled joint and can't be driven directly.`);
      }
      fireForget({ kind: "setJoint", name: jn, degrees: num(degrees, "degrees") });
    },

    // ---- direct joint move (async) ----
    moveJoint: (name: unknown, degrees: unknown, seconds: unknown) => {
      const jn = String(name);
      jointOrThrow(jn);
      return rpc({ kind: "moveJoint", name: jn, degrees: num(degrees, "degrees"), seconds: num(seconds, "seconds") });
    },

    // ---- introspection (sync) ----
    getJoint: (name: unknown): number => {
      const idx = jointOrThrow(String(name));
      return rad2deg(requireState()[CODE_STATE_HEADER + CODE_STATE_BASE + idx]);
    },
    listJoints: (): string[] => meta!.joints.map((j) => j.name),
    listSensors: (): string[] => [
      ...meta!.sensors.map((s) => s.name),
      "base_position", "base_orientation", "base_linear_velocity", "base_angular_velocity",
    ],
    getSensor: (name: unknown): number | number[] => readSensor(String(name)),
    getPose: (): { position: number[]; quaternion: number[]; yawDeg: number } => {
      const s = requireState();
      const qw = s[5], qx = s[6], qy = s[7], qz = s[8];
      const yaw = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qy * qy + qz * qz));
      return {
        position: [s[2], s[3], s[4]],
        quaternion: [qw, qx, qy, qz],
        yawDeg: rad2deg(yaw),
      };
    },

    // ---- time (async) ----
    wait: (seconds: unknown) => rpc({ kind: "wait", seconds: num(seconds, "seconds") }),

    // ---- hands: G1 EDU U6 only ----
    setFinger: (hand: unknown, finger: unknown, amount: unknown): void => {
      handGuard();
      fireForget({ kind: "setFinger", hand: handName(hand), finger: fingerName(finger) as never, amount: clampAmt(num(amount, "amount")) });
    },
    grasp: (hand: unknown, strength?: unknown) => {
      handGuard();
      return rpc({ kind: "grasp", hand: handName(hand), strength: strength === undefined ? 0.85 : num(strength, "strength") });
    },
    release: (hand: unknown) => {
      handGuard();
      return rpc({ kind: "release", hand: handName(hand) });
    },
    getFingerForce: (hand: unknown, finger: unknown): number => {
      handGuard();
      const val = readSensor(`${handName(hand)}_${fingerName(finger)}_touch`);
      return Array.isArray(val) ? val[0] : val;
    },
  };

  const print = (...args: unknown[]) => post({ type: "print", parts: args.map(formatValue) });
  return { robot, print };
}

/* ------------------------------ execution ------------------------------- */

function extractLine(err: unknown, probeLine: number): number | null {
  if (!(err instanceof Error) || !err.stack) return null;
  const match = err.stack.match(/<anonymous>:(\d+):\d+/) ?? err.stack.match(/Function:(\d+):\d+/);
  if (!match) return null;
  const line = parseInt(match[1], 10) - probeLine;
  return line >= 1 ? line : null;
}

async function execute(source: string) {
  const { robot, print } = buildApi();
  const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor as new (
    ...args: string[]
  ) => (...fnArgs: unknown[]) => Promise<unknown>;

  let probeLine = 2;
  try {
    const probe = new AsyncFunction("__p", "throw new Error('__probe__')");
    await probe(null);
  } catch (e) {
    const m = e instanceof Error && e.stack ? e.stack.match(/<anonymous>:(\d+):\d+/) : null;
    if (m) probeLine = parseInt(m[1], 10);
  }

  let fn: (...args: unknown[]) => Promise<unknown>;
  try {
    fn = new AsyncFunction("robot", "print", `"use strict";${source}\n`);
  } catch (err) {
    post({ type: "runtimeError", message: err instanceof Error ? err.message : String(err), line: null });
    return;
  }

  try {
    await fn(robot, print);
    // The top-level function can finish while detached async work is still
    // running (e.g. `main().catch(...)` instead of `await main()`). Keep the
    // worker alive until no robot operations are in flight and none get
    // scheduled within a macrotask — that's when the program is truly idle.
    await drainPending();
    post({ type: "done" });
  } catch (err) {
    post({
      type: "runtimeError",
      message: err instanceof Error ? err.message : String(err),
      line: extractLine(err, probeLine - 1),
    });
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function drainPending() {
  for (;;) {
    while (pending.size > 0) await sleep(20);
    await sleep(0); // let the program schedule its next robot call, if any
    if (pending.size === 0) return;
  }
}

function setupPort(port: MessagePort) {
  simPort = port;
  port.onmessage = (e: MessageEvent<RpcResponse | { state: Float32Array }>) => {
    const d = e.data as { state?: Float32Array } & Partial<RpcResponse>;
    if (d.state instanceof Float32Array) {
      live = d.state;
      if (onFirstState) { const f = onFirstState; onFirstState = null; f(); }
      return;
    }
    const res = e.data as RpcResponse;
    const p = pending.get(res.rpcId);
    if (!p) return;
    pending.delete(res.rpcId);
    if (res.ok) p.resolve(res.value);
    else p.reject(new Error(res.error));
  };
}

self.addEventListener("unhandledrejection", (ev) => {
  ev.preventDefault();
  const reason = (ev as PromiseRejectionEvent).reason;
  post({ type: "runtimeError", message: reason instanceof Error ? reason.message : String(reason), line: null });
});

self.onmessage = async (ev: MessageEvent<ToCode>) => {
  const msg = ev.data;
  if (msg.type === "ping") {
    post({ type: "pong" });
    return;
  }
  if (msg.type === "run") {
    meta = msg.meta;
    nJoint = meta.joints.length;
    sensorBase = CODE_STATE_HEADER + CODE_STATE_BASE + nJoint;
    jointIndex.clear();
    meta.joints.forEach((j, i) => jointIndex.set(j.name, i));
    setupPort(msg.simPort);

    // wait for the first live-state snapshot so synchronous getters work
    if (!live) {
      await new Promise<void>((resolve) => {
        onFirstState = resolve;
        setTimeout(resolve, 8000); // safety: run anyway rather than hang
      });
    }
    void execute(msg.source);
  }
};
