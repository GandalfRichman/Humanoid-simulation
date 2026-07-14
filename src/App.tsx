import { useEffect, useRef, useState } from "react";
import { TopBar } from "./ui/TopBar";
import { LeftRail } from "./ui/LeftRail";
import { RightPanel } from "./ui/RightPanel";
import { BottomPanel } from "./ui/BottomPanel";
import { LoadingOverlay } from "./ui/LoadingOverlay";
import { Viewport } from "./render/Viewport";
import { DriveOverlay } from "./ui/DriveOverlay";
import { useStore } from "./state/store";
import { bootApp, resetSim } from "./state/actions";

export default function App() {
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void bootApp();
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <LeftRail />
        <main className="relative min-w-0 flex-1">
          <Viewport />
          <FallenBanner />
          <DriveOverlay />
          <Onboarding />
          <LoadingOverlay />
        </main>
        <RightPanel />
      </div>
      <BottomPanel />
    </div>
  );
}

function FallenBanner() {
  const fallen = useStore((s) => s.fallen);
  if (!fallen) return null;
  return (
    <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-3 rounded-full border border-red-900 bg-red-950/90 px-4 py-1.5 text-[13px] text-red-200 shadow-lg">
        <span>💥 The robot fell — that's real physics.</span>
        <button
          type="button"
          onClick={resetSim}
          className="rounded-full bg-red-700 px-3 py-0.5 font-medium text-white hover:bg-red-600"
        >
          Reset ↺
        </button>
      </div>
    </div>
  );
}

function Onboarding() {
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem("g1studio.onboarded") === "1",
  );
  const bootState = useStore((s) => s.bootState);
  if (dismissed || bootState !== "ready") return null;
  const dismiss = () => {
    localStorage.setItem("g1studio.onboarded", "1");
    setDismissed(true);
  };
  return (
    <div className="absolute bottom-4 left-1/2 z-30 w-[26rem] -translate-x-1/2 rounded-xl border border-zinc-700 bg-zinc-900/95 p-4 shadow-2xl backdrop-blur">
      <h2 className="text-sm font-semibold text-zinc-100">Welcome to G1 Robot Studio 👋</h2>
      <ul className="mt-2 space-y-1 text-[12.5px] leading-relaxed text-zinc-400">
        <li>▶ <b className="text-zinc-300">Run</b> executes the program in the editor — the robot walks with a real learned policy under MuJoCo physics.</li>
        <li>🖱 Drag to orbit, scroll to zoom, click the robot to inspect joints.</li>
        <li>✨ Try the examples menu, or switch to <b className="text-zinc-300">Blocks</b> for drag-and-drop coding.</li>
        <li>🔗 Share bundles your whole project into a URL.</li>
      </ul>
      <button
        type="button"
        onClick={dismiss}
        className="mt-3 rounded-md bg-sky-600 px-3 py-1 text-[13px] font-medium text-white hover:bg-sky-500"
      >
        Got it
      </button>
    </div>
  );
}
