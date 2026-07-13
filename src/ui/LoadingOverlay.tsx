import { useStore } from "../state/store";
import { reloadSimulation } from "../state/actions";

export function LoadingOverlay() {
  const bootState = useStore((s) => s.bootState);
  const phase = useStore((s) => s.loadPhase);
  const done = useStore((s) => s.loadDone);
  const total = useStore((s) => s.loadTotal);
  const error = useStore((s) => s.bootError);

  if (bootState === "ready") return null;

  return (
    <div className="absolute inset-0 z-40 grid place-items-center bg-zinc-950/85 backdrop-blur-sm">
      <div className="w-80 rounded-xl border border-zinc-800 bg-zinc-900 p-6 text-center shadow-2xl">
        {bootState === "error" ? (
          <>
            <div className="text-3xl">🛠️</div>
            <h2 className="mt-2 text-sm font-semibold text-zinc-100">Failed to load the simulation</h2>
            <p className="mt-2 max-h-40 overflow-y-auto break-words text-[12px] text-red-400">{error}</p>
            <button
              type="button"
              onClick={() => void reloadSimulation()}
              className="mt-4 rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
            >
              Retry
            </button>
          </>
        ) : (
          <>
            <div className="animate-bounce text-3xl">🤖</div>
            <h2 className="mt-2 text-sm font-semibold text-zinc-100">Preparing the robot lab</h2>
            <p className="mt-1 text-[12px] text-zinc-400">{phase}</p>
            <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full rounded-full bg-sky-500 transition-[width] duration-200"
                style={{ width: `${total > 0 ? Math.round((done / total) * 100) : 10}%` }}
              />
            </div>
            <p className="mt-2 text-[10.5px] text-zinc-600">
              MuJoCo physics + ONNX policy load once, then everything runs locally.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
