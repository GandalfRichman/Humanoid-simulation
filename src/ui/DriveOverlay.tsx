import { useEffect, useRef, useState } from "react";
import { simClient } from "../engine/SimClient";
import { useStore } from "../state/store";

/** Keyboard teleop: streams velocity commands to the balance policy while
 *  enabled. W/S forward/back, A/D strafe, Q/E (or ←/→) turn, Space stop. */
export function DriveOverlay() {
  const [driving, setDriving] = useState(false);
  const keys = useRef(new Set<string>());
  const bootState = useStore((s) => s.bootState);
  const fallen = useStore((s) => s.fallen);

  useEffect(() => {
    if (!driving) return;

    const send = () => {
      const k = keys.current;
      const vx = (k.has("w") || k.has("arrowup") ? 0.9 : 0) + (k.has("s") || k.has("arrowdown") ? -0.5 : 0);
      const vy = (k.has("a") ? 0.4 : 0) + (k.has("d") ? -0.4 : 0);
      const yaw = (k.has("q") || k.has("arrowleft") ? 0.9 : 0) + (k.has("e") || k.has("arrowright") ? -0.9 : 0);
      simClient.call({ kind: "setVelocity", vx, vy, yawRate: yaw }).catch(() => {});
    };

    const isTyping = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      return t.closest?.("input, textarea, [contenteditable], .monaco-editor") != null;
    };

    const down = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const key = e.key.toLowerCase();
      if (key === " ") {
        keys.current.clear();
        send();
        e.preventDefault();
        return;
      }
      if (["w", "a", "s", "d", "q", "e", "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        keys.current.add(key);
        send();
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      keys.current.delete(e.key.toLowerCase());
      send();
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      keys.current.clear();
      simClient.call({ kind: "stand" }).catch(() => {});
    };
  }, [driving]);

  if (bootState !== "ready") return null;

  return (
    <div className="absolute bottom-4 right-4 z-30 flex flex-col items-end gap-2">
      {driving && !fallen && (
        <div className="rounded-lg border border-zinc-700 bg-zinc-900/90 px-3 py-2 text-[11px] leading-relaxed text-zinc-300 shadow-lg backdrop-blur">
          <b className="text-zinc-100">W/S</b> walk · <b className="text-zinc-100">A/D</b> strafe ·{" "}
          <b className="text-zinc-100">Q/E</b> turn · <b className="text-zinc-100">Space</b> stop
        </div>
      )}
      <button
        type="button"
        onClick={() => setDriving((v) => !v)}
        className={`rounded-full px-4 py-1.5 text-[13px] font-medium shadow-lg transition-colors ${
          driving
            ? "bg-sky-600 text-white hover:bg-sky-500"
            : "border border-zinc-700 bg-zinc-900/90 text-zinc-300 backdrop-blur hover:bg-zinc-800"
        }`}
      >
        🎮 {driving ? "Driving — click to stop" : "Drive with keyboard"}
      </button>
    </div>
  );
}
