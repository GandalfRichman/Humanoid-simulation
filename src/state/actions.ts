import { simClient } from "../engine/SimClient";
import { codeRunner } from "../sandbox/CodeRunner";
import { useStore } from "./store";
import type { ProjectData, RobotId, SceneId } from "../lib/types";
import {
  buildShareUrl, exportProjectFile, importProjectFile, parseShareFragment, saveProject,
} from "../persistence/projects";

const store = () => useStore.getState();

/* ------------------------------ boot ------------------------------ */

export async function bootApp() {
  const s = store();
  simClient.onLog = (level, text) =>
    s.pushConsole(level === "info" ? "system" : level === "warn" ? "warn" : "error", text);
  simClient.onFell = () => {
    store().pushConsole("system", "💥 The robot fell over. Press Reset ↺ to stand it back up.");
  };
  simClient.onStatus = (running, fallen, t) => store().setSimStatus(running, fallen, t);

  const shared = parseShareFragment();
  if (shared) {
    s.applyProject(shared);
    s.pushConsole("system", `Opened shared project “${shared.name}”.`);
    history.replaceState(null, "", location.pathname + location.search);
  }

  if (!simClient.crossOriginIsolated) {
    s.pushConsole(
      "warn",
      "crossOriginIsolated is false — SharedArrayBuffer is unavailable, falling back to " +
        "postMessage frame streaming (slightly higher latency). Check COOP/COEP headers.",
    );
  }

  await reloadSimulation();
}

export async function reloadSimulation() {
  const s = store();
  s.setBoot("loading");
  stopProgram();
  try {
    const spec = await simClient.load(s.robotId, s.sceneId, (phase, done, total) =>
      store().setLoad(phase, done, total),
    );
    store().setSpec(spec);
    store().setBoot("ready");
    if (spec.weldedPolicySlots.length) {
      store().pushConsole(
        "system",
        `${spec.robotId === "g1_basic" ? "G1 Basic" : "Robot"} loaded — ${spec.joints.length} joints. ` +
          `The shared 29-slot policy treats missing joints (${spec.weldedPolicySlots.length}) as welded.`,
      );
    } else {
      store().pushConsole("system", `Robot loaded — ${spec.joints.length} joints, ready to run.`);
    }
    simClient.play();
    store().setSimRunning(true);
  } catch (err) {
    store().setBoot("error", err instanceof Error ? err.message : String(err));
  }
}

/* --------------------------- sim controls -------------------------- */

export function playPause() {
  const s = store();
  if (s.simRunning) {
    simClient.pause();
    s.setSimRunning(false);
  } else {
    simClient.play();
    s.setSimRunning(true);
  }
}

export function resetSim() {
  stopProgram();
  simClient.reset();
  store().pushConsole("system", "Simulation reset to the initial pose.");
}

export function stepSim() {
  const s = store();
  if (s.simRunning) {
    simClient.pause();
    s.setSimRunning(false);
  }
  simClient.stepOnce(4); // one control tick (decimation 4)
}

export function setSpeed(speed: number) {
  simClient.setSpeed(speed);
  store().setSpeed(speed);
}

export async function switchRobot(id: RobotId) {
  if (store().robotId === id) return;
  store().setRobot(id);
  await reloadSimulation();
}

export async function switchScene(id: SceneId) {
  if (store().sceneId === id) return;
  store().setScene(id);
  await reloadSimulation();
}

/* ------------------------------ program ---------------------------- */

export function runProgram() {
  const s = store();
  const source = s.mode === "js" ? s.jsSource : s.generatedJs;
  if (!source.trim()) {
    s.pushConsole("warn", s.mode === "js" ? "Nothing to run — the editor is empty." : "Nothing to run — drag some blocks first.");
    return;
  }
  if (!s.simRunning) {
    simClient.play();
    s.setSimRunning(true);
  }
  s.pushConsole("system", `▶ Running ${s.mode === "js" ? "JavaScript" : "blocks"} program…`);
  s.setProgramRunning(true);
  codeRunner.run(source, {
    onPrint: (text) => store().pushConsole("log", text),
    onError: (message, line) =>
      store().pushConsole("error", line ? `${message}` : message, line),
    onDone: () => {
      store().setProgramRunning(false);
      store().pushConsole("system", "Program finished.");
    },
    onStuck: () => {},
  });
}

export function stopProgram() {
  if (codeRunner.running) {
    codeRunner.stop("user");
    store().setProgramRunning(false);
    store().pushConsole("system", "■ Program stopped.");
  }
}

/* ------------------------------ projects --------------------------- */

export function saveCurrentProject(): string {
  const s = store();
  const project = saveProject(s.projectId, s.snapshotProject());
  s.setProject(project.id, project.data.name);
  s.markSaved();
  s.pushConsole("system", `Saved “${project.data.name}”.`);
  return project.id;
}

export async function openProject(data: ProjectData) {
  const s = store();
  stopProgram();
  s.applyProject(data);
  await reloadSimulation();
}

export function shareCurrent(): { url: string; tooLong: boolean } {
  return buildShareUrl(store().snapshotProject());
}

export function exportCurrent() {
  exportProjectFile(store().snapshotProject());
}

export async function importFromFile() {
  const data = await importProjectFile();
  const s = store();
  s.setProject(null, data.name);
  await openProject(data);
}
