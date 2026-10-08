import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hubPaths } from "./config.ts";
import { syncCtxInjects, syncMemoryReport } from "./deliver.ts";
import { readText } from "./fsx.ts";
import { listHubSkills, relinkHubSkills } from "./skills.ts";

export const ASSET_SYNC_POLL_MS = 10_000;
export const ASSET_SYNC_QUIET_MS = 1_000;
export const ASSET_SYNC_LAYERS = ["memory", "ctx", "skills"] as const;
export type AssetSyncLayer = (typeof ASSET_SYNC_LAYERS)[number];
export type AssetSyncFailure = { layer: AssetSyncLayer; error: string; agent?: string; cwd?: string };
export type AssetSyncLayerStatus = {
  lastCheckedAt: number | null;
  lastSyncedAt: number | null;
  pending: boolean;
  errors: AssetSyncFailure[];
};
export type AssetSyncStatus = {
  running: boolean;
  stopped: boolean;
  startedAt: number;
  lastCheckedAt: number | null;
  lastSyncedAt: number | null;
  intervalMs: number;
  layers: Record<AssetSyncLayer, AssetSyncLayerStatus>;
};
export type AssetSyncHandle = {
  notify: () => void;
  runNow: () => Promise<void>;
  stop: () => Promise<void>;
  getStatus: () => AssetSyncStatus;
};

/** Hash authoritative inputs only: generated manifests/projections must not retrigger delivery. */
export async function assetSourceSignature(layer: AssetSyncLayer): Promise<string> {
  const p = hubPaths();
  const hash = createHash("sha256");
  const add = (name: string, value: string | null) => hash.update(JSON.stringify([name, value]));
  add("root", p.root);
  add("config", await readText(p.config));
  if (layer === "memory") {
    add("global", await readText(p.memoryGlobal));
    add("scopes", await readText(path.join(p.memory, "inject-state.json")));
    const names = await fs.readdir(p.memoryProjects).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const name of names.filter(name => name.endsWith(".md")).sort()) {
      add(`project:${name}`, await readText(path.join(p.memoryProjects, name)));
    }
  } else if (layer === "ctx") {
    add("user", await readText(p.userMd));
  } else {
    for (const skill of await listHubSkills()) {
      add(`skill:${skill.name}:path`, await fs.realpath(skill.path));
      add(`skill:${skill.name}:content`, await readText(path.join(skill.path, "SKILL.md")));
    }
  }
  return hash.digest("hex");
}

type Deliver = (layer: AssetSyncLayer) => Promise<AssetSyncFailure[]>;

async function deliverAssets(layer: AssetSyncLayer): Promise<AssetSyncFailure[]> {
  // Existing writers retain their locking, target ownership, and rollback boundaries.
  if (layer === "memory") return (await syncMemoryReport()).failures.map(failure => ({ layer, ...failure }));
  if (layer === "ctx") await syncCtxInjects();
  else await relinkHubSkills();
  return [];
}

/** Sync edits made outside the UI too; poll as a fallback for missed filesystem events. */
export function startAssetSync(options: {
  pollMs?: number;
  quietMs?: number;
  onStatus?: (status: AssetSyncStatus) => void;
  readSignature?: (layer: AssetSyncLayer) => Promise<string>;
  deliver?: Deliver;
  now?: () => number;
} = {}): AssetSyncHandle {
  const pollMs = options.pollMs ?? ASSET_SYNC_POLL_MS;
  const quietMs = options.quietMs ?? ASSET_SYNC_QUIET_MS;
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(quietMs) || quietMs < 0) {
    throw new RangeError("invalid asset sync interval");
  }
  const now = options.now ?? Date.now;
  const readSignature = options.readSignature ?? assetSourceSignature;
  const deliver = options.deliver ?? deliverAssets;
  const applied: Partial<Record<AssetSyncLayer, string>> = {};
  const initialLayer = (): AssetSyncLayerStatus => ({ lastCheckedAt: null, lastSyncedAt: null, pending: true, errors: [] });
  const status: AssetSyncStatus = {
    running: false, stopped: false, startedAt: now(), lastCheckedAt: null, lastSyncedAt: null, intervalMs: pollMs,
    layers: { memory: initialLayer(), ctx: initialLayer(), skills: initialLayer() },
  };
  let active: Promise<void> | null = null;
  let queued = false;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  const getStatus = () => structuredClone(status);
  const publish = () => {
    // Observers are presentation only; a broken observer must not interrupt delivery.
    try { options.onStatus?.(getStatus()); } catch { /* Keep the background worker alive. */ }
  };
  const pass = async () => {
    status.running = true;
    publish();
    for (const layer of ASSET_SYNC_LAYERS) {
      if (status.stopped) break;
      const state = status.layers[layer];
      state.lastCheckedAt = now();
      try {
        const signature = await readSignature(layer);
        if (status.stopped) break;
        if (signature === applied[layer] && !state.pending) continue;
        state.pending = true;
        const failures = await deliver(layer);
        state.errors = failures;
        if (failures.length) continue;
        // A writer may have changed the source while delivery was reading it. Do not mark
        // that mixed pass clean: retry it even if the source later returns to the old value.
        if (await readSignature(layer) !== signature) continue;
        applied[layer] = signature;
        state.pending = false;
        state.lastSyncedAt = now();
      } catch (error) {
        state.pending = true;
        state.errors = [{ layer, error: error instanceof Error ? error.message : String(error) }];
      }
    }
    status.lastCheckedAt = now();
    if (!status.stopped && ASSET_SYNC_LAYERS.every(layer => !status.layers[layer].pending)) {
      status.lastSyncedAt = status.lastCheckedAt;
    }
    status.running = false;
    publish();
  };
  const runNow = (): Promise<void> => {
    if (status.stopped) return active ?? Promise.resolve();
    if (active) {
      queued = true;
      return active;
    }
    active = (async () => {
      do {
        queued = false;
        await pass();
      } while (queued && !status.stopped);
    })().finally(() => { active = null; });
    return active;
  };
  const notify = () => {
    if (status.stopped || quiet) return;
    // First-event deadline avoids starvation when another process writes continuously.
    quiet = setTimeout(() => { quiet = null; void runNow(); }, quietMs);
    quiet.unref();
  };
  const interval = setInterval(() => { void runNow(); }, pollMs);
  interval.unref();
  // Reconcile once after every launch; later unchanged inputs do not rewrite destinations.
  void runNow();
  return {
    notify, runNow, getStatus,
    async stop() {
      status.stopped = true;
      queued = false;
      if (quiet) clearTimeout(quiet);
      quiet = null;
      clearInterval(interval);
      await active;
      publish();
    },
  };
}
