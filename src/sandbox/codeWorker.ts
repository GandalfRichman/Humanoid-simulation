/// <reference lib="webworker" />
/**
 * User-code sandbox. Receives the program source and a MessagePort wired
 * straight to the simulation worker, builds the `robot` proxy API on top of
 * that port, and runs the code inside an async function.
 *
 * The worker answers pings from the main thread so a blocked event loop
 * (busy-wait without await) can be detected and terminated.
 */

import type { FromCode, RobotCall, RpcResponse, ToCode } from "../lib/types";

const post = (msg: FromCode) => (self as unknown as Worker).postMessage(msg);

let simPort: MessagePort | null = null;
let rpcSeq = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function rpc<T>(call: RobotCall): Promise<T> {
  if (!simPort) return Promise.reject(new Error("Simulation not connected"));
  const rpcId = rpcSeq++;
  return new Promise<T>((resolve, reject) => {
    pending.set(rpcId, { resolve: resolve as (v: unknown) => void, reject });
    simPort!.postMessage({ rpcId, call });
  });
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

  const robot = {
    // locomotion — sets targets the learned balance policy tracks
    walkForward: (meters: unknown, speed?: unknown) =>
      rpc({ kind: "walk", meters: num(meters, "meters"), speed: speed === undefined ? undefined : num(speed, "speed") }),
    walkBackward: (meters: unknown, speed?: unknown) =>
      rpc({ kind: "walk", meters: -num(meters, "meters"), speed: speed === undefined ? undefined : num(speed, "speed") }),
    turn: (degrees: unknown) => rpc({ kind: "turn", degrees: num(degrees, "degrees") }),
    stand: () => rpc({ kind: "stand" }),
    setVelocity: (vx: unknown, vy: unknown, yawRate: unknown) =>
      rpc({ kind: "setVelocity", vx: num(vx, "vx"), vy: num(vy, "vy"), yawRate: num(yawRate, "yawRate") }),

    // direct posture + inspection.
    // setJoint is documented as void but returns the RPC promise: bad joint
    // names reject it, which surfaces through unhandledrejection with a
    // friendly message even when the caller doesn't await.
    setJoint: (name: unknown, degrees: unknown) =>
      rpc({ kind: "setJoint", name: String(name), degrees: num(degrees, "degrees") }),
    moveJoint: (name: unknown, degrees: unknown, seconds: unknown) =>
      rpc({ kind: "moveJoint", name: String(name), degrees: num(degrees, "degrees"), seconds: num(seconds, "seconds") }),
    getJoint: (name: unknown) => rpc<number>({ kind: "getJoint", name: String(name) }),
    listJoints: () => rpc<string[]>({ kind: "listJoints" }),
    listSensors: () => rpc<string[]>({ kind: "listSensors" }),
    getSensor: (name: unknown) => rpc<number | number[]>({ kind: "getSensor", name: String(name) }),
    getPose: () => rpc<{ position: number[]; quaternion: number[]; yawDeg: number }>({ kind: "getPose" }),
    wait: (seconds: unknown) => rpc({ kind: "wait", seconds: num(seconds, "seconds") }),

    // hands — G1 EDU U6 only (the sim replies with a friendly error on Basic)
    setFinger: (hand: unknown, finger: unknown, amount: unknown) =>
      rpc({
        kind: "setFinger", hand: handName(hand),
        finger: String(finger) as "thumb", amount: num(amount, "amount"),
      }),
    grasp: (hand: unknown, strength?: unknown) =>
      rpc({ kind: "grasp", hand: handName(hand), strength: strength === undefined ? 0.85 : num(strength, "strength") }),
    release: (hand: unknown) => rpc({ kind: "release", hand: handName(hand) }),
    getFingerForce: (hand: unknown, finger: unknown) =>
      rpc<number>({ kind: "getFingerForce", hand: handName(hand), finger: String(finger) as "thumb" }),
  };

  const print = (...args: unknown[]) => post({ type: "print", parts: args.map(formatValue) });
  return { robot, print };
}

/** Map an engine stack line back to the user's 1-based source line. */
function extractLine(err: unknown, probeLine: number): number | null {
  if (!(err instanceof Error) || !err.stack) return null;
  const match = err.stack.match(/<anonymous>:(\d+):\d+/) ?? err.stack.match(/Function:(\d+):\d+/);
  if (!match) return null;
  const line = parseInt(match[1], 10) - probeLine;
  return line >= 1 ? line : null;
}

async function run(source: string) {
  const { robot, print } = buildApi();
  const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor as new (
    ...args: string[]
  ) => (...fnArgs: unknown[]) => Promise<unknown>;

  // probe the engine's line offset inside new Function() so runtime errors
  // can be mapped back to editor lines exactly
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
    // syntax errors: engines report them at throw time without stack lines we
    // can trust, so just forward the message
    post({
      type: "runtimeError",
      message: err instanceof Error ? err.message : String(err),
      line: null,
    });
    return;
  }

  try {
    await fn(robot, print);
    post({ type: "done" });
  } catch (err) {
    post({
      type: "runtimeError",
      message: err instanceof Error ? err.message : String(err),
      line: extractLine(err, probeLine - 1),
    });
  }
}

self.addEventListener("unhandledrejection", (ev) => {
  ev.preventDefault();
  const reason = (ev as PromiseRejectionEvent).reason;
  post({
    type: "runtimeError",
    message: reason instanceof Error ? reason.message : String(reason),
    line: null,
  });
});

self.onmessage = (ev: MessageEvent<ToCode>) => {
  const msg = ev.data;
  if (msg.type === "ping") {
    post({ type: "pong" });
    return;
  }
  if (msg.type === "run") {
    simPort = msg.simPort;
    simPort.onmessage = (e: MessageEvent<RpcResponse>) => {
      const res = e.data;
      const p = pending.get(res.rpcId);
      if (!p) return;
      pending.delete(res.rpcId);
      if (res.ok) p.resolve(res.value);
      else p.reject(new Error(res.error));
    };
    void run(msg.source);
  }
};
