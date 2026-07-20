import type { FromCode } from "../lib/types";
import { simClient } from "../engine/SimClient";

export interface RunnerEvents {
  onPrint: (text: string) => void;
  onError: (message: string, line: number | null) => void;
  onDone: () => void;
  onStuck: () => void;
}

/**
 * Owns the user-code worker lifecycle: spawn per Run, terminate on Stop,
 * and a ping/pong watchdog that catches busy-wait loops which never yield
 * to the event loop.
 */
export class CodeRunner {
  private worker: Worker | null = null;
  private watchdog: number | null = null;
  private lastPong = 0;
  running = false;

  run(source: string, events: RunnerEvents) {
    this.stop("superseded");
    this.worker = new Worker(new URL("./codeWorker.ts", import.meta.url), { type: "module" });
    this.running = true;
    this.lastPong = performance.now();

    this.worker.onmessage = (ev: MessageEvent<FromCode>) => {
      const msg = ev.data;
      switch (msg.type) {
        case "print":
          events.onPrint(msg.parts.join(" "));
          break;
        case "runtimeError":
          events.onError(msg.message, msg.line);
          this.stop("errored");
          events.onDone();
          break;
        case "done":
          this.stop("finished");
          events.onDone();
          break;
        case "pong":
          this.lastPong = performance.now();
          break;
      }
    };
    this.worker.onerror = (e) => {
      events.onError(e.message || "Worker crashed", e.lineno ?? null);
      this.stop("crashed");
      events.onDone();
    };

    const meta = simClient.buildCodeMeta();
    if (!meta) {
      events.onError("The robot isn't loaded yet — wait for loading to finish, then Run.", null);
      this.stop("no-model");
      events.onDone();
      return;
    }
    const simPort = simClient.connectCodePort();
    this.worker.postMessage({ type: "run", source, simPort, meta }, [simPort]);

    this.watchdog = window.setInterval(() => {
      if (!this.worker) return;
      this.worker.postMessage({ type: "ping" });
      if (performance.now() - this.lastPong > 5000) {
        events.onError(
          "Your program is hogging the CPU without yielding (an endless while-loop?). " +
            "Use `await robot.wait(seconds)` inside long loops. The program was stopped.",
          null,
        );
        this.stop("watchdog");
        events.onDone();
      }
    }, 1000);
  }

  stop(reason: string) {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      simClient.cancelTasks(
        reason === "user" ? "the program was stopped" : "the program ended",
      );
    }
    this.running = false;
  }
}

export const codeRunner = new CodeRunner();
