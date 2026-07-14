import { lazy, Suspense } from "react";
import { useStore } from "../state/store";
import { SnippetMenu } from "./BottomPanel";

const MonacoPane = lazy(() =>
  import("../editor/MonacoPane").then((m) => ({ default: m.MonacoPane })),
);
const BlocklyPane = lazy(() =>
  import("../blocks/BlocklyPane").then((m) => ({ default: m.BlocklyPane })),
);

export function RightPanel() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const setJsSource = useStore((s) => s.setJsSource);

  return (
    <section className="flex w-[24rem] min-w-[18rem] shrink-0 flex-col border-l border-zinc-800 bg-zinc-950 lg:w-[30rem] xl:w-[34rem]">
      <div className="flex items-center border-b border-zinc-800">
        <div role="tablist" aria-label="Editor mode" className="flex">
          {(["js", "blocks"] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`px-4 py-2 text-[12.5px] font-medium transition-colors ${
                mode === m
                  ? "border-b-2 border-sky-500 text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {m === "js" ? "JavaScript" : "Blocks"}
            </button>
          ))}
        </div>
        <div className="grow" />
        {mode === "js" && (
          <div className="pr-2">
            <SnippetMenu onInsert={(code) => setJsSource(code)} />
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="grid h-full place-items-center text-sm text-zinc-500">
              loading editor…
            </div>
          }
        >
          {mode === "js" ? <MonacoPane /> : <BlocklyPane />}
        </Suspense>
      </div>
    </section>
  );
}
