import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import type { ProjectData, StoredProject } from "../lib/types";

const KEY = "g1studio.projects.v1";

/** Longest share URL we consider safe across browsers/chat apps. */
export const MAX_SHARE_URL = 12000;

function readAll(): Record<string, StoredProject> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, StoredProject>;
  } catch {
    return {};
  }
}

function writeAll(map: Record<string, StoredProject>) {
  localStorage.setItem(KEY, JSON.stringify(map));
}

export function listProjects(): StoredProject[] {
  return Object.values(readAll()).sort((a, b) => b.savedAt - a.savedAt);
}

export function saveProject(id: string | null, data: ProjectData): StoredProject {
  const map = readAll();
  const project: StoredProject = {
    id: id ?? `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    savedAt: Date.now(),
    data,
  };
  map[project.id] = project;
  writeAll(map);
  return project;
}

export function loadProject(id: string): StoredProject | null {
  return readAll()[id] ?? null;
}

export function deleteProject(id: string) {
  const map = readAll();
  delete map[id];
  writeAll(map);
}

/* ----------------------------- sharing ----------------------------- */

export function buildShareUrl(data: ProjectData): { url: string; tooLong: boolean } {
  const packed = compressToEncodedURIComponent(JSON.stringify(data));
  const url = `${location.origin}${location.pathname}#p=${packed}`;
  return { url, tooLong: url.length > MAX_SHARE_URL };
}

export function parseShareFragment(): ProjectData | null {
  const match = location.hash.match(/#p=([^&]+)/);
  if (!match) return null;
  try {
    const json = decompressFromEncodedURIComponent(match[1]);
    if (!json) return null;
    const data = JSON.parse(json) as ProjectData;
    if (data.version !== 1 || !data.robot || !data.mode) return null;
    return data;
  } catch {
    return null;
  }
}

/* --------------------------- file export --------------------------- */

export function exportProjectFile(data: ProjectData) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(data.name || "project").replace(/[^\w\- ]+/g, "").trim() || "project"}.robotproj.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function importProjectFile(): Promise<ProjectData> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.robotproj.json,application/json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error("No file selected"));
      try {
        const data = JSON.parse(await file.text()) as ProjectData;
        if (data.version !== 1 || !data.robot || !data.mode) {
          return reject(new Error("Not a valid .robotproj.json project file"));
        }
        resolve(data);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    input.click();
  });
}
