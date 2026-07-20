/** Shared types across main thread, sim worker and user-code worker. */

export type RobotId = "g1_basic" | "g1_edu_u6";
export type SceneId = "flat" | "table" | "obstacles";
export type EditorMode = "js" | "blocks";

export interface RobotInfo {
  id: RobotId;
  label: string;
  tagline: string;
  dof: number;
  hands: string;
  details: string[];
}

/* ------------------------------------------------------------------ */
/* Scene description (worker -> main, once per load)                   */
/* ------------------------------------------------------------------ */

export interface GeomSpec {
  name: string;
  bodyId: number;
  /** mjtGeom: 0 plane, 2 sphere, 3 capsule, 4 ellipsoid, 5 cylinder, 6 box, 7 mesh */
  type: number;
  size: [number, number, number];
  pos: [number, number, number];
  quat: [number, number, number, number]; // wxyz
  rgba: [number, number, number, number];
  group: number;
  meshId: number; // -1 unless type is mesh
}

export interface MeshSpec {
  id: number;
  name: string;
  vertices: Float32Array; // 3 * nvert (MuJoCo-processed, centered)
  normals: Float32Array; // 3 * nvert
  faces: Uint32Array; // 3 * nface
}

export interface JointMeta {
  name: string;
  id: number;
  qposAdr: number;
  dofAdr: number;
  /** degrees */
  range: [number, number];
  bodyId: number;
  bodyName: string;
  actuated: boolean;
  /** the locomotion policy drives this joint while balancing */
  policyOwned: boolean;
  /** leg | arm | waist | hand */
  group: "leg" | "arm" | "waist" | "hand";
  side: "left" | "right" | "center";
}

export interface SensorMeta {
  name: string;
  id: number;
  adr: number;
  dim: number;
  /** human-readable type, e.g. gyro, accelerometer, touch */
  kind: string;
  bodyOrSite: string;
}

export interface BodyMeta {
  name: string;
  id: number;
  jointNames: string[];
}

export interface SceneSpec {
  nbody: number;
  bodies: BodyMeta[];
  geoms: GeomSpec[];
  meshes: MeshSpec[];
  joints: JointMeta[];
  sensors: SensorMeta[];
  robotId: RobotId;
  sceneId: SceneId;
  /** names of the 29 policy slots missing on this robot (welded) */
  weldedPolicySlots: string[];
}

/* ------------------------------------------------------------------ */
/* Frame streaming (worker -> main, every render tick)                 */
/* ------------------------------------------------------------------ */

/** Float32 layout: [time, fallen, nbody*3 xpos, nbody*4 xquat,
 *  njoint qpos(rad), njoint target(rad), nsensordata] */
export interface FrameHeader {
  time: number;
  fallen: boolean;
}

export const frameFloats = (nbody: number, njoint: number, nsensordata: number) =>
  2 + nbody * 7 + njoint * 2 + nsensordata;

/* ------------------------------------------------------------------ */
/* Main <-> sim worker protocol                                        */
/* ------------------------------------------------------------------ */

export interface LoadPayload {
  robotId: RobotId;
  sceneId: SceneId;
  robotXml: string;
  sceneXml: string;
  meshFiles: Record<string, ArrayBuffer>;
  policyModel: ArrayBuffer;
  policyData: ArrayBuffer;
  policyMeta: PolicyMeta;
  wasmBase: string; // absolute base URL for vendor wasm assets
  useSab: boolean;
}

export interface PolicyMeta {
  obsSize: number;
  actionSize: number;
  physicsTimestep: number;
  controlDecimation: number;
  jointOrder: string[];
  defaultPose: Record<string, number>;
  actionScales: Record<string, number>;
  commandLimits: { vx: [number, number]; vy: [number, number]; yawRate: [number, number] };
  spawnHeight: number;
}

export type ToSim =
  | { type: "load"; payload: LoadPayload }
  | { type: "play" }
  | { type: "pause" }
  | { type: "reset" }
  | { type: "stepOnce"; count: number }
  | { type: "setSpeed"; speed: number }
  | { type: "connectCode"; port: MessagePort }
  | { type: "cancelTasks"; reason: string };

export type FromSim =
  | { type: "loaded"; spec: SceneSpec; sab: SharedArrayBuffer | null; frameFloats: number }
  | { type: "loadError"; message: string }
  | { type: "frame"; buffer: Float32Array } // postMessage fallback path
  | { type: "status"; running: boolean; fallen: boolean; simTime: number; realtimeFactor: number }
  | { type: "policyEvent"; event: "fell" | "recovered" }
  | { type: "log"; level: "info" | "warn" | "error"; text: string };

/* ------------------------------------------------------------------ */
/* Code worker <-> sim worker RPC (over MessageChannel)                */
/* ------------------------------------------------------------------ */

export type RobotCall =
  | { kind: "setVelocity"; vx: number; vy: number; yawRate: number }
  | { kind: "walk"; meters: number; speed?: number }
  | { kind: "turn"; degrees: number }
  | { kind: "stand" }
  | { kind: "setJoint"; name: string; degrees: number }
  | { kind: "moveJoint"; name: string; degrees: number; seconds: number }
  | { kind: "getJoint"; name: string }
  | { kind: "listJoints" }
  | { kind: "listSensors" }
  | { kind: "getSensor"; name: string }
  | { kind: "wait"; seconds: number }
  | { kind: "setFinger"; hand: Hand; finger: Finger; amount: number }
  | { kind: "grasp"; hand: Hand; strength: number }
  | { kind: "release"; hand: Hand }
  | { kind: "getFingerForce"; hand: Hand; finger: Finger }
  | { kind: "getPose" };

export type Hand = "left" | "right";
export type Finger = "thumb" | "index" | "middle" | "ring" | "little";

export interface RpcRequest {
  rpcId: number;
  call: RobotCall;
}

export type RpcResponse =
  | { rpcId: number; ok: true; value: unknown }
  | { rpcId: number; ok: false; error: string };

/* ------------------------------------------------------------------ */
/* Main <-> code worker protocol                                       */
/* ------------------------------------------------------------------ */

/** Compact metadata the code worker needs to answer synchronous getters and
 *  validate synchronous setters without any round-trip to the sim worker. */
export interface CodeMeta {
  robotId: RobotId;
  hasHands: boolean;
  /** ordered exactly like the live-state joint-angle block */
  joints: {
    name: string;
    range: [number, number]; // degrees
    actuated: boolean;
    policyOwned: boolean;
    group: JointMeta["group"];
  }[];
  sensors: { name: string; adr: number; dim: number; kind: string }[];
}

/**
 * Live sim state pushed sim-worker -> code-worker over the RPC port so the
 * synchronous getters can read a recent snapshot locally. Float32 layout:
 *   [ time, fallen,
 *     baseP(3), baseQuat(4, wxyz), baseLinVel(3), baseAngVel(3),   // 13
 *     jointAngles(nJoint, rad), sensordata(nsensordata) ]
 */
export const CODE_STATE_BASE = 13;
export const CODE_STATE_HEADER = 2;

export type ToCode =
  | { type: "run"; source: string; simPort: MessagePort; meta: CodeMeta }
  | { type: "ping" };

export type FromCode =
  | { type: "print"; parts: string[] }
  | { type: "done" }
  | { type: "runtimeError"; message: string; line: number | null }
  | { type: "pong" };

/** Sim -> code over the port: either an RPC response or a live-state frame. */
export type PortToCode = RpcResponse | { state: Float32Array };

/* ------------------------------------------------------------------ */
/* Console + project                                                   */
/* ------------------------------------------------------------------ */

export interface ConsoleEntry {
  id: number;
  kind: "log" | "error" | "system" | "warn";
  text: string;
  line?: number | null;
  time: string;
}

export interface ProjectData {
  version: 1;
  robot: RobotId;
  mode: EditorMode;
  jsSource: string;
  blocklyState: object | null;
  scene: SceneId;
  name: string;
}

export interface StoredProject {
  id: string;
  savedAt: number;
  data: ProjectData;
}

export const GEOM_PLANE = 0;
export const GEOM_SPHERE = 2;
export const GEOM_CAPSULE = 3;
export const GEOM_ELLIPSOID = 4;
export const GEOM_CYLINDER = 5;
export const GEOM_BOX = 6;
export const GEOM_MESH = 7;
