import { create } from "zustand";
import type {
  ConsoleEntry,
  EditorMode,
  ProjectData,
  RobotId,
  SceneId,
  SceneSpec,
} from "../lib/types";
import { DEFAULT_JS } from "../editor/snippets";

export interface Selection {
  kind: "joint" | "body";
  name: string;
}

interface AppState {
  bootState: "loading" | "ready" | "error";
  bootError: string | null;
  loadPhase: string;
  loadDone: number;
  loadTotal: number;

  robotId: RobotId;
  sceneId: SceneId;
  spec: SceneSpec | null;

  simRunning: boolean;
  simTime: number;
  fallen: boolean;
  speed: number;
  programRunning: boolean;

  mode: EditorMode;
  jsSource: string;
  blocklyState: object | null;
  generatedJs: string;

  projectId: string | null;
  projectName: string;
  dirty: boolean;

  consoleEntries: ConsoleEntry[];
  selection: Selection | null;
  showCollision: boolean;
  isolatedWarned: boolean;

  // actions
  setLoad: (phase: string, done: number, total: number) => void;
  setBoot: (s: AppState["bootState"], err?: string) => void;
  setSpec: (spec: SceneSpec | null) => void;
  setRobot: (id: RobotId) => void;
  setScene: (id: SceneId) => void;
  setSimRunning: (v: boolean) => void;
  setSimStatus: (running: boolean, fallen: boolean, t: number) => void;
  setSpeed: (v: number) => void;
  setProgramRunning: (v: boolean) => void;
  setMode: (m: EditorMode) => void;
  setJsSource: (s: string) => void;
  setBlockly: (state: object | null, js: string) => void;
  setProject: (id: string | null, name: string) => void;
  setProjectName: (name: string) => void;
  markSaved: () => void;
  pushConsole: (kind: ConsoleEntry["kind"], text: string, line?: number | null) => void;
  clearConsole: () => void;
  select: (sel: Selection | null) => void;
  toggleCollision: () => void;
  applyProject: (data: ProjectData) => void;
  snapshotProject: () => ProjectData;
}

let consoleSeq = 1;
const timeStr = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
};

export const useStore = create<AppState>((set, get) => ({
  bootState: "loading",
  bootError: null,
  loadPhase: "Booting",
  loadDone: 0,
  loadTotal: 1,

  robotId: "g1_basic",
  sceneId: "flat",
  spec: null,

  simRunning: false,
  simTime: 0,
  fallen: false,
  speed: 1,
  programRunning: false,

  mode: "js",
  jsSource: DEFAULT_JS,
  blocklyState: null,
  generatedJs: "",

  projectId: null,
  projectName: "Untitled project",
  dirty: false,

  consoleEntries: [],
  selection: null,
  showCollision: false,
  isolatedWarned: false,

  setLoad: (loadPhase, loadDone, loadTotal) => set({ loadPhase, loadDone, loadTotal }),
  setBoot: (bootState, err) => set({ bootState, bootError: err ?? null }),
  setSpec: (spec) => set({ spec }),
  setRobot: (robotId) => set({ robotId, dirty: true }),
  setScene: (sceneId) => set({ sceneId, dirty: true }),
  setSimRunning: (simRunning) => set({ simRunning }),
  setSimStatus: (running, fallen, t) =>
    set((s) =>
      s.simRunning === running && s.fallen === fallen && Math.abs(s.simTime - t) < 0.05
        ? s
        : { simRunning: running, fallen, simTime: t },
    ),
  setSpeed: (speed) => set({ speed }),
  setProgramRunning: (programRunning) => set({ programRunning }),
  setMode: (mode) => set({ mode, dirty: true }),
  setJsSource: (jsSource) => set({ jsSource, dirty: true }),
  setBlockly: (blocklyState, generatedJs) => set({ blocklyState, generatedJs, dirty: true }),
  setProject: (projectId, projectName) => set({ projectId, projectName }),
  setProjectName: (projectName) => set({ projectName, dirty: true }),
  markSaved: () => set({ dirty: false }),

  pushConsole: (kind, text, line) =>
    set((s) => ({
      consoleEntries: [
        ...s.consoleEntries.slice(-499),
        { id: consoleSeq++, kind, text, line: line ?? null, time: timeStr() },
      ],
    })),
  clearConsole: () => set({ consoleEntries: [] }),
  select: (selection) => set({ selection }),
  toggleCollision: () => set((s) => ({ showCollision: !s.showCollision })),

  applyProject: (data) =>
    set({
      robotId: data.robot,
      sceneId: data.scene,
      mode: data.mode,
      jsSource: data.jsSource,
      blocklyState: data.blocklyState,
      projectName: data.name,
      dirty: false,
    }),
  snapshotProject: () => {
    const s = get();
    return {
      version: 1,
      robot: s.robotId,
      mode: s.mode,
      jsSource: s.jsSource,
      blocklyState: s.blocklyState,
      scene: s.sceneId,
      name: s.projectName,
    };
  },
}));
