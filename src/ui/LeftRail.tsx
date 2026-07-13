import { useState } from "react";
import { useStore } from "../state/store";
import { switchRobot, switchScene } from "../state/actions";
import { ROBOTS, SCENES } from "../lib/robots";
import type { JointMeta, RobotId, SceneId } from "../lib/types";

type Tab = "robots" | "scenes" | "inspect";

export function LeftRail() {
  const [tab, setTab] = useState<Tab>("robots");
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      <nav className="flex border-b border-zinc-800" role="tablist" aria-label="Sidebar">
        {(["robots", "scenes", "inspect"] as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`flex-1 px-2 py-2 text-[11.5px] font-medium uppercase tracking-wide transition-colors ${
              tab === t ? "border-b-2 border-sky-500 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tab === "robots" && <RobotsTab />}
        {tab === "scenes" && <ScenesTab />}
        {tab === "inspect" && <InspectTab />}
      </div>
    </aside>
  );
}

function RobotsTab() {
  const robotId = useStore((s) => s.robotId);
  return (
    <div className="space-y-2">
      {(Object.keys(ROBOTS) as RobotId[]).map((id) => {
        const r = ROBOTS[id];
        const active = robotId === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => void switchRobot(id)}
            className={`w-full rounded-lg border p-3 text-left transition-colors ${
              active
                ? "border-sky-600 bg-sky-950/40"
                : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
            }`}
          >
            <div className="flex items-baseline justify-between">
              <span className="text-[13px] font-semibold text-zinc-100">{r.label}</span>
              <span className="text-[11px] text-sky-400">{r.dof} DOF</span>
            </div>
            <div className="mt-0.5 text-[11px] text-zinc-400">{r.hands}</div>
            <ul className="mt-2 space-y-1 text-[11px] leading-snug text-zinc-500">
              {r.details.map((d) => (
                <li key={d}>· {d}</li>
              ))}
            </ul>
          </button>
        );
      })}
      <p className="px-1 pt-1 text-[10.5px] leading-relaxed text-zinc-600">
        Both robots balance with a learned 29-slot walking policy (ONNX, in-browser). The EDU U6
        drives all 29 body joints; on the Basic, slots for missing joints are welded shut.
      </p>
    </div>
  );
}

function ScenesTab() {
  const sceneId = useStore((s) => s.sceneId);
  return (
    <div className="space-y-2">
      {(Object.keys(SCENES) as SceneId[]).map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => void switchScene(id)}
          className={`w-full rounded-lg border p-3 text-left transition-colors ${
            sceneId === id
              ? "border-sky-600 bg-sky-950/40"
              : "border-zinc-800 bg-zinc-900/40 hover:border-zinc-700"
          }`}
        >
          <div className="text-[13px] font-semibold text-zinc-100">{SCENES[id].label}</div>
          <div className="mt-0.5 text-[11px] text-zinc-400">{SCENES[id].blurb}</div>
        </button>
      ))}
    </div>
  );
}

const GROUP_ORDER: JointMeta["group"][] = ["leg", "waist", "arm", "hand"];
const GROUP_LABEL: Record<JointMeta["group"], string> = {
  leg: "Legs", waist: "Waist", arm: "Arms", hand: "Hands (Inspire RH56)",
};

function InspectTab() {
  const spec = useStore((s) => s.spec);
  const selection = useStore((s) => s.selection);
  const select = useStore((s) => s.select);
  if (!spec) return <p className="p-2 text-[12px] text-zinc-500">Loading robot…</p>;

  return (
    <div className="space-y-3">
      {GROUP_ORDER.map((group) => {
        const joints = spec.joints.filter((j) => j.group === group);
        if (!joints.length) return null;
        return (
          <div key={group}>
            <h3 className="px-1 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-zinc-500">
              {GROUP_LABEL[group]} <span className="font-normal">({joints.length})</span>
            </h3>
            <ul>
              {joints.map((j) => (
                <li key={j.name}>
                  <button
                    type="button"
                    onClick={() => select({ kind: "joint", name: j.name })}
                    className={`w-full truncate rounded px-2 py-[3px] text-left font-mono text-[11px] transition-colors ${
                      selection?.kind === "joint" && selection.name === j.name
                        ? "bg-sky-900/60 text-sky-200"
                        : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                    }`}
                    title={`${j.name} — click to inspect`}
                  >
                    {j.name.replace(/_joint$/, "")}
                    {!j.actuated && <span className="pl-1 text-zinc-600">(coupled)</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p className="px-1 text-[10.5px] leading-relaxed text-zinc-600">
        Tip: click any part of the robot in the 3D view to select its joint.
      </p>
    </div>
  );
}
