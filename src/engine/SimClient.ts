import type {
  FromSim,
  RobotCall,
  RobotId,
  RpcRequest,
  RpcResponse,
  SceneId,
  SceneSpec,
  ToSim,
} from "../lib/types";
import { loadRobotAssets, type ProgressFn } from "./assets";

export interface FrameView {
  time: number;
  fallen: boolean;
  xpos: Float32Array; // nbody*3
  xquat: Float32Array; // nbody*4
  jointAngles: Float32Array; // per SceneSpec.joints, radians
  jointTargets: Float32Array;
  sensordata: Float32Array;
}

type Listener = () => void;

/**
 * Main-thread handle on the simulation worker. Owns the worker lifecycle,
 * frame buffers, and the RPC bridge used by the Inspector UI. The user-code
 * worker talks to the sim worker directly over a MessageChannel.
 */
export class SimClient {
  private worker: Worker | null = null;
  private sab: SharedArrayBuffer | null = null;
  private sabCtl: Int32Array | null = null;
  private sabBufs: [Float32Array, Float32Array] | null = null;
  private lastGen = -1;
  private frameLen = 0;
  private latest: Float32Array | null = null;

  spec: SceneSpec | null = null;
  frame: FrameView | null = null;

  private rpcSeq = 1;
  private rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  onLog: (level: "info" | "warn" | "error", text: string) => void = () => {};
  onFell: () => void = () => {};
  onStatus: (running: boolean, fallen: boolean, simTime: number) => void = () => {};
  onSpecChanged: Listener = () => {};

  get crossOriginIsolated(): boolean {
    return typeof crossOriginIsolated !== "undefined" && crossOriginIsolated;
  }

  async load(robotId: RobotId, sceneId: SceneId, onProgress: ProgressFn): Promise<SceneSpec> {
    this.disposeWorker();
    const assets = await loadRobotAssets(robotId, sceneId, onProgress);

    this.worker = new Worker(new URL("./simWorker.ts", import.meta.url), { type: "module" });
    const worker = this.worker;

    const spec = await new Promise<SceneSpec>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<FromSim>) => {
        const msg = ev.data;
        switch (msg.type) {
          case "loaded":
            this.sab = msg.sab;
            this.frameLen = msg.frameFloats;
            if (this.sab) {
              this.sabCtl = new Int32Array(this.sab, 0, 2);
              this.sabBufs = [
                new Float32Array(this.sab, 8, this.frameLen),
                new Float32Array(this.sab, 8 + this.frameLen * 4, this.frameLen),
              ];
            }
            this.latest = new Float32Array(this.frameLen);
            resolve(msg.spec);
            break;
          case "loadError":
            reject(new Error(msg.message));
            break;
          case "frame":
            this.latest = msg.buffer;
            break;
          case "status":
            this.onStatus(msg.running, msg.fallen, msg.simTime);
            break;
          case "policyEvent":
            if (msg.event === "fell") this.onFell();
            break;
          case "log":
            this.onLog(msg.level, msg.text);
            break;
          default: {
            const rpc = msg as unknown as { type: string; res: RpcResponse };
            if (rpc.type === "rpcResponse") this.settleRpc(rpc.res);
          }
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || "Simulation worker crashed"));

      const transfers: Transferable[] = [
        assets.policyModel,
        assets.policyData,
        ...Object.values(assets.meshFiles),
      ];
      this.send(
        {
          type: "load",
          payload: {
            robotId,
            sceneId,
            robotXml: assets.robotXml,
            sceneXml: assets.sceneXml,
            meshFiles: assets.meshFiles,
            policyModel: assets.policyModel,
            policyData: assets.policyData,
            policyMeta: assets.policyMeta,
            wasmBase: new URL("/vendor/", location.href).href,
            useSab: this.crossOriginIsolated,
          },
        },
        transfers,
      );
    });

    this.spec = spec;
    this.onSpecChanged();
    return spec;
  }

  private send(msg: ToSim | { type: "rpc"; req: RpcRequest }, transfer?: Transferable[]) {
    this.worker?.postMessage(msg, transfer ?? []);
  }

  play() { this.send({ type: "play" }); }
  pause() { this.send({ type: "pause" }); }
  reset() { this.send({ type: "reset" }); }
  stepOnce(count = 1) { this.send({ type: "stepOnce", count }); }
  setSpeed(speed: number) { this.send({ type: "setSpeed", speed }); }
  cancelTasks(reason: string) { this.send({ type: "cancelTasks", reason }); }

  /** MessagePort for a user-code worker to issue robot RPCs directly. */
  connectCodePort(): MessagePort {
    const channel = new MessageChannel();
    this.worker?.postMessage({ type: "connectCode", port: channel.port1 }, [channel.port1]);
    return channel.port2;
  }

  /** RPC from the main thread (Inspector scrubbing, quick controls). */
  call<T = unknown>(call: RobotCall): Promise<T> {
    // A call issued while the worker is being swapped (robot/scene reload)
    // would otherwise post into the void and hang forever.
    if (!this.worker) return Promise.reject(new Error("Simulation is reloading."));
    const rpcId = this.rpcSeq++;
    return new Promise<T>((resolve, reject) => {
      this.rpcPending.set(rpcId, { resolve: resolve as (v: unknown) => void, reject });
      this.send({ type: "rpc", req: { rpcId, call } });
    });
  }

  private settleRpc(res: RpcResponse) {
    const pending = this.rpcPending.get(res.rpcId);
    if (!pending) return;
    this.rpcPending.delete(res.rpcId);
    if (res.ok) pending.resolve(res.value);
    else pending.reject(new Error(res.error));
  }

  /** Pull the newest frame (called from the render loop). */
  readFrame(): FrameView | null {
    if (!this.spec || !this.latest) return null;
    if (this.sab && this.sabCtl && this.sabBufs) {
      const gen = Atomics.load(this.sabCtl, 0);
      if (gen !== this.lastGen) {
        this.lastGen = gen;
        this.latest.set(this.sabBufs[Atomics.load(this.sabCtl, 1)]);
      }
    }
    const buf = this.latest;
    const nbody = this.spec.nbody;
    const njoint = this.spec.joints.length;
    let o = 2;
    const xpos = buf.subarray(o, (o += nbody * 3));
    const xquat = buf.subarray(o, (o += nbody * 4));
    const jointAngles = buf.subarray(o, (o += njoint));
    const jointTargets = buf.subarray(o, (o += njoint));
    const sensordata = buf.subarray(o);
    this.frame = {
      time: buf[0],
      fallen: buf[1] > 0.5,
      xpos,
      xquat,
      jointAngles,
      jointTargets,
      sensordata,
    };
    return this.frame;
  }

  disposeWorker() {
    for (const [, p] of this.rpcPending) p.reject(new Error("simulation reloaded"));
    this.rpcPending.clear();
    this.worker?.terminate();
    this.worker = null;
    this.spec = null;
    this.latest = null;
    this.sab = null;
    this.lastGen = -1;
  }
}

export const simClient = new SimClient();
