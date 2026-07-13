import { useState } from "react";
import { useStore } from "../state/store";
import {
  exportCurrent, importFromFile, openProject, playPause, resetSim, runProgram,
  saveCurrentProject, setSpeed, shareCurrent, stepSim, stopProgram, switchRobot, switchScene,
} from "../state/actions";
import { ROBOTS, SCENES } from "../lib/robots";
import type { RobotId, SceneId } from "../lib/types";
import { IconButton, Menu, MenuItem, Modal } from "./primitives";
import { deleteProject, listProjects } from "../persistence/projects";

const SPEEDS = [0.25, 0.5, 1, 2];

export function TopBar() {
  const s = useStore();
  const [shareState, setShareState] = useState<{ url: string; tooLong: boolean } | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const busy = s.bootState !== "ready";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-zinc-800 bg-zinc-950 px-3">
      <div className="mr-1 flex items-center gap-2">
        <span aria-hidden className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 text-[15px]">🤖</span>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold text-zinc-100">G1 Robot Studio</div>
          <div className="text-[10px] text-zinc-500">MuJoCo · learned locomotion · in your browser</div>
        </div>
      </div>

      <Menu label={<span className="max-w-40 truncate">{s.projectName}{s.dirty ? " •" : ""}</span>}>
        <MenuItem onClick={() => { saveCurrentProject(); }}>Save project</MenuItem>
        <MenuItem onClick={() => setProjectsOpen(true)}>Open project…</MenuItem>
        <MenuItem
          onClick={() => {
            const name = prompt("Project name", s.projectName);
            if (name?.trim()) s.setProjectName(name.trim());
          }}
        >
          Rename…
        </MenuItem>
        <div className="my-1 border-t border-zinc-800" />
        <MenuItem onClick={() => { exportCurrent(); }}>Export .robotproj.json</MenuItem>
        <MenuItem onClick={() => { void importFromFile().catch((e) => s.pushConsole("error", String(e.message ?? e))); }}>
          Import from file…
        </MenuItem>
      </Menu>

      <div className="mx-1 h-6 w-px bg-zinc-800" />

      {/* Run / Stop / Reset / Step */}
      {!s.programRunning ? (
        <IconButton accent title="Run program (executes your code in a sandboxed worker)" onClick={runProgram} disabled={busy}>
          <svg width="11" height="12" viewBox="0 0 11 12"><path d="M0 0l11 6-11 6z" fill="currentColor" /></svg>
          Run
        </IconButton>
      ) : (
        <IconButton title="Stop the running program" onClick={stopProgram}>
          <svg width="11" height="11" viewBox="0 0 11 11"><rect width="11" height="11" rx="1.5" fill="#f87171" /></svg>
          Stop
        </IconButton>
      )}
      <IconButton title="Reset simulation to the initial pose" onClick={resetSim} disabled={busy}>
        ↺ Reset
      </IconButton>
      <IconButton title={s.simRunning ? "Pause physics" : "Resume physics"} onClick={playPause} disabled={busy}>
        {s.simRunning ? "⏸" : "⏵"}
      </IconButton>
      <IconButton title="Advance one control tick (paused stepping)" onClick={stepSim} disabled={busy}>
        ⏭
      </IconButton>

      <div className="ml-1 flex items-center overflow-hidden rounded-md border border-zinc-800" role="group" aria-label="Simulation speed">
        {SPEEDS.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setSpeed(v)}
            className={`px-2 py-1 text-[11.5px] font-medium transition-colors ${
              s.speed === v ? "bg-sky-600 text-white" : "text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {v}×
          </button>
        ))}
      </div>

      <div className="mx-1 h-6 w-px bg-zinc-800" />

      <Menu label={<span>🦾 {ROBOTS[s.robotId].label}</span>} width="w-80">
        {(Object.keys(ROBOTS) as RobotId[]).map((id) => (
          <MenuItem key={id} onClick={() => void switchRobot(id)} hint={ROBOTS[id].tagline}>
            {s.robotId === id ? "✓ " : ""}{ROBOTS[id].label}
          </MenuItem>
        ))}
      </Menu>

      <Menu label={<span>🌍 {SCENES[s.sceneId].label}</span>} width="w-72">
        {(Object.keys(SCENES) as SceneId[]).map((id) => (
          <MenuItem key={id} onClick={() => void switchScene(id)} hint={SCENES[id].blurb}>
            {s.sceneId === id ? "✓ " : ""}{SCENES[id].label}
          </MenuItem>
        ))}
      </Menu>

      <div className="grow" />

      <div className="hidden items-center gap-2 text-[11px] tabular-nums text-zinc-500 md:flex" aria-live="off">
        <span>t = {s.simTime.toFixed(1)} s</span>
        {s.fallen && <span className="rounded bg-red-950 px-1.5 py-0.5 font-medium text-red-400">fallen</span>}
      </div>

      <IconButton title="Save project" onClick={() => saveCurrentProject()}>💾 Save</IconButton>
      <IconButton
        title="Share via URL"
        onClick={() => { setCopied(false); setShareState(shareCurrent()); }}
      >
        🔗 Share
      </IconButton>
      <IconButton
        title="Toggle collision geometry overlay"
        active={s.showCollision}
        onClick={() => s.toggleCollision()}
      >
        ⚙
      </IconButton>

      {shareState && (
        <Modal title="Share this project" onClose={() => setShareState(null)}>
          {shareState.tooLong ? (
            <div className="space-y-3 text-sm text-zinc-300">
              <p>
                This project is too large for a share link (URL would be{" "}
                {Math.round(shareState.url.length / 1000)}k characters). Export it as a file instead:
              </p>
              <button
                type="button"
                className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
                onClick={() => { exportCurrent(); setShareState(null); }}
              >
                Export .robotproj.json
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-zinc-300">
                Everything (robot choice, scene, code/blocks) is compressed into the URL fragment —
                nothing is uploaded anywhere.
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  value={shareState.url}
                  onFocus={(e) => e.currentTarget.select()}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-300"
                />
                <button
                  type="button"
                  className="shrink-0 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500"
                  onClick={() => {
                    void navigator.clipboard.writeText(shareState.url).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}

      {projectsOpen && (
        <Modal title="Your projects (saved in this browser)" onClose={() => setProjectsOpen(false)}>
          <ProjectList onClose={() => setProjectsOpen(false)} />
        </Modal>
      )}
    </header>
  );
}

function ProjectList({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState(listProjects());
  const setProject = useStore((st) => st.setProject);
  if (!projects.length) {
    return <p className="text-sm text-zinc-400">No saved projects yet — press 💾 Save to create one.</p>;
  }
  return (
    <ul className="max-h-80 space-y-1 overflow-y-auto">
      {projects.map((p) => (
        <li key={p.id} className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2">
          <button
            type="button"
            className="grow text-left"
            onClick={() => {
              setProject(p.id, p.data.name);
              void openProject(p.data);
              onClose();
            }}
          >
            <div className="text-sm font-medium text-zinc-100">{p.data.name}</div>
            <div className="text-[11px] text-zinc-500">
              {ROBOTS[p.data.robot].label} · {p.data.mode === "js" ? "JavaScript" : "Blocks"} ·{" "}
              {new Date(p.savedAt).toLocaleString()}
            </div>
          </button>
          <button
            type="button"
            aria-label={`Delete ${p.data.name}`}
            className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-400"
            onClick={() => {
              deleteProject(p.id);
              setProjects(listProjects());
            }}
          >
            🗑
          </button>
        </li>
      ))}
    </ul>
  );
}
