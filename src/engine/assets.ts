import { meshUrl, POLICY_URLS, robotXmlUrl, sceneXmlUrl } from "../lib/robots";
import type { PolicyMeta, RobotId, SceneId } from "../lib/types";

export interface LoadedAssets {
  robotXml: string;
  sceneXml: string;
  meshFiles: Record<string, ArrayBuffer>;
  policyModel: ArrayBuffer;
  policyData: ArrayBuffer;
  policyMeta: PolicyMeta;
}

export type ProgressFn = (phase: string, done: number, total: number) => void;

const meshCache = new Map<string, ArrayBuffer>();
let policyCache: { model: ArrayBuffer; data: ArrayBuffer; meta: PolicyMeta } | null = null;

async function fetchBuf(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res.arrayBuffer();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

/** Every mesh referenced by the robot XML must land in the VFS before
 *  compile — MuJoCo fails otherwise, so the manifest is derived from the
 *  XML itself and can never go stale. */
function meshManifest(robotXml: string): string[] {
  return [...robotXml.matchAll(/file="([^"]+\.(?:STL|stl|obj|msh))"/g)].map((m) => m[1]);
}

export async function loadRobotAssets(
  robotId: RobotId,
  sceneId: SceneId,
  onProgress: ProgressFn,
): Promise<LoadedAssets> {
  onProgress("Fetching robot model", 0, 1);
  const [robotXml, sceneXml] = await Promise.all([
    fetchText(robotXmlUrl(robotId)),
    fetchText(sceneXmlUrl(sceneId)),
  ]);

  const files = meshManifest(robotXml);
  const missing = files.filter((f) => !meshCache.has(f));
  let done = files.length - missing.length;
  onProgress("Fetching meshes", done, files.length);

  const CONCURRENCY = 8;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < missing.length) {
        const file = missing[cursor++];
        meshCache.set(file, await fetchBuf(meshUrl(file)));
        onProgress("Fetching meshes", ++done, files.length);
      }
    }),
  );

  if (!policyCache) {
    onProgress("Fetching locomotion policy", 0, 1);
    const [model, data, meta] = await Promise.all([
      fetchBuf(POLICY_URLS.model),
      fetchBuf(POLICY_URLS.data),
      fetch(POLICY_URLS.meta).then((r) => r.json() as Promise<PolicyMeta>),
    ]);
    policyCache = { model, data, meta };
  }
  onProgress("Starting physics", 0, 1);

  const meshFiles: Record<string, ArrayBuffer> = {};
  // slice() so the transferable copy sent to the worker leaves the cache intact
  for (const f of files) meshFiles[f] = meshCache.get(f)!.slice(0);

  return {
    robotXml,
    sceneXml,
    meshFiles,
    policyModel: policyCache.model.slice(0),
    policyData: policyCache.data.slice(0),
    policyMeta: policyCache.meta,
  };
}
