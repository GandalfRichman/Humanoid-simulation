import { useEffect, useRef, useState } from "react";
import { simClient } from "../engine/SimClient";
import { useStore } from "../state/store";
import type { JointMeta } from "../lib/types";
import { SNIPPETS } from "../editor/snippets";

export function BottomPanel() {
  return (
    <div className="flex h-48 shrink-0 border-t border-zinc-800 bg-zinc-950">
      <ConsolePane />
      <div className="w-px bg-zinc-800" />
      <InspectorPane />
    </div>
  );
}

/* ------------------------------ console ---------------------------- */

function ConsolePane() {
  const entries = useStore((s) => s.consoleEntries);
  const clearConsole = useStore((s) => s.clearConsole);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const color = {
    log: "text-zinc-200",
    error: "text-red-400",
    warn: "text-amber-400",
    system: "text-sky-400/90",
  } as const;

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Console">
      <div className="flex items-center justify-between border-b border-zinc-900 px-3 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Console</span>
        <button
          type="button"
          onClick={clearConsole}
          className="rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
        >
          clear
        </button>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-1 font-mono text-[12px] leading-relaxed">
        {entries.length === 0 && (
          <p className="py-2 text-zinc-600">
            print() output and errors appear here. Try an example from the ✨ menu in the editor.
          </p>
        )}
        {entries.map((e) => (
          <div key={e.id} className={color[e.kind]}>
            <span className="pr-2 text-[10px] text-zinc-600">{e.time}</span>
            {e.kind === "error" && <span className="pr-1">✗</span>}
            {e.text}
            {e.line != null && (
              <span className="pl-2 text-[11px] text-red-300/70">(line {e.line})</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

/* ----------------------------- inspector --------------------------- */

function useLiveJointValue(joint: JointMeta | null): { angle: number; target: number } {
  const [value, setValue] = useState({ angle: 0, target: NaN });
  useEffect(() => {
    if (!joint) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 100) return;
      last = t;
      const spec = simClient.spec;
      const frame = simClient.frame ?? simClient.readFrame();
      if (!spec || !frame) return;
      const idx = spec.joints.findIndex((j) => j.name === joint.name);
      if (idx < 0) return;
      setValue({
        angle: (frame.jointAngles[idx] * 180) / Math.PI,
        target: (frame.jointTargets[idx] * 180) / Math.PI,
      });
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [joint]);
  return value;
}

function InspectorPane() {
  const spec = useStore((s) => s.spec);
  const selection = useStore((s) => s.selection);
  const pushConsole = useStore((s) => s.pushConsole);
  const joint =
    (selection?.kind === "joint" && spec?.joints.find((j) => j.name === selection.name)) || null;
  const live = useLiveJointValue(joint);
  const [scrub, setScrub] = useState<number | null>(null);

  useEffect(() => setScrub(null), [joint?.name]);

  return (
    <section className="flex w-[24rem] shrink-0 flex-col" aria-label="Inspector">
      <div className="border-b border-zinc-900 px-3 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Inspector</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-[12px]">
        {!joint && <SensorSummary />}
        {joint && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[12.5px] font-semibold text-sky-300">{joint.name}</span>
              <span className="text-[11px] text-zinc-500">hinge · {joint.side}</span>
            </div>
            <dl className="grid grid-cols-[7rem_1fr] gap-y-1 text-zinc-300">
              <dt className="text-zinc-500">body</dt>
              <dd className="font-mono">{joint.bodyName}</dd>
              <dt className="text-zinc-500">range</dt>
              <dd className="font-mono tabular-nums">
                {joint.range[0].toFixed(1)}° … {joint.range[1].toFixed(1)}°
              </dd>
              <dt className="text-zinc-500">live angle</dt>
              <dd className="font-mono tabular-nums text-emerald-300">{live.angle.toFixed(2)}°</dd>
              <dt className="text-zinc-500">target</dt>
              <dd className="font-mono tabular-nums">
                {Number.isNaN(live.target) ? "—" : `${live.target.toFixed(2)}°`}
              </dd>
              <dt className="text-zinc-500">control</dt>
              <dd>
                {joint.policyOwned ? (
                  <span className="text-violet-300">balance policy</span>
                ) : joint.actuated ? (
                  <span className="text-emerald-300">direct (robot API)</span>
                ) : (
                  <span className="text-zinc-500">passive coupled linkage</span>
                )}
              </dd>
            </dl>
            {joint.actuated && !joint.policyOwned && (
              <div className="pt-1">
                <label className="mb-1 block text-[11px] text-zinc-500" htmlFor="scrub">
                  drive joint (sets robot API target)
                </label>
                <input
                  id="scrub"
                  type="range"
                  min={joint.range[0]}
                  max={joint.range[1]}
                  step={0.5}
                  value={scrub ?? live.angle}
                  onChange={(e) => {
                    const deg = Number(e.target.value);
                    setScrub(deg);
                    simClient
                      .call({ kind: "setJoint", name: joint.name, degrees: deg })
                      .catch((err) => pushConsole("error", String(err.message ?? err)));
                  }}
                  className="w-full accent-sky-500"
                />
              </div>
            )}
            {joint.policyOwned && (
              <p className="text-[11px] leading-snug text-zinc-600">
                This joint is being balanced by the learned policy. Calling{" "}
                <code className="text-zinc-400">robot.setJoint()</code> on it takes over control —
                and probably ends in a fall.
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function SensorSummary() {
  const spec = useStore((s) => s.spec);
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!spec) return;
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 200) return;
      last = t;
      const frame = simClient.frame ?? simClient.readFrame();
      if (!frame) return;
      const next: Record<string, string> = {};
      for (const s of spec.sensors) {
        const vals = Array.from(frame.sensordata.subarray(s.adr, s.adr + s.dim));
        next[s.name] = vals.map((v) => v.toFixed(2)).join(", ");
      }
      setValues(next);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [spec]);

  if (!spec) return null;
  return (
    <div>
      <p className="pb-2 text-[11px] text-zinc-500">
        Select a joint (click the robot or use the Inspect tab) to see its properties. Live sensors:
      </p>
      <dl className="space-y-1">
        {spec.sensors.map((s) => (
          <div key={s.name} className="grid grid-cols-[11rem_1fr] gap-2">
            <dt className="truncate font-mono text-[11px] text-zinc-400" title={s.name}>{s.name}</dt>
            <dd className="truncate font-mono text-[11px] tabular-nums text-emerald-300/90">
              {values[s.name] ?? "…"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* Snippet menu is exported for the RightPanel toolbar */
export function SnippetMenu({ onInsert }: { onInsert: (code: string) => void }) {
  const robotId = useStore((s) => s.robotId);
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded px-2 py-1 text-[11.5px] font-medium text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        ✨ Examples
      </button>
      {open && (
        <div
          className="absolute right-0 top-7 z-50 w-56 rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl"
          onMouseLeave={() => setOpen(false)}
        >
          {SNIPPETS.filter((sn) => !sn.eduOnly || robotId === "g1_edu_u6").map((sn) => (
            <button
              key={sn.id}
              type="button"
              className="block w-full rounded px-2.5 py-1.5 text-left text-[12.5px] text-zinc-200 hover:bg-zinc-800"
              onClick={() => {
                onInsert(sn.code);
                setOpen(false);
              }}
            >
              {sn.label}
              {sn.eduOnly && <span className="pl-1.5 text-[10px] text-violet-400">EDU</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
