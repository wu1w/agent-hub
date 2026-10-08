import fs from "node:fs";
import { loadConfig, hubPaths, resolvedSkillDir } from "./config.ts";
import { adapter, homedir } from "./adapters.ts";

let epoch = 0;
let watchers: fs.FSWatcher[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sessionNotify: (() => void) | null = null;
let assetNotify: (() => void) | null = null;

export type HubWatchOptions = { onSessionChange?: () => void; onAssetChange?: () => void };

export function diskEpoch(): number {
  return epoch;
}

export function noteDiskChange(): void {
  epoch += 1;
}

function bump(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    noteDiskChange();
  }, 400);
}

type WatchOptions = {
  sessions?: boolean;
  recursive?: boolean;
  accept?: (name: string | null) => boolean;
  source?: (name: string | null) => boolean;
};

function watchDir(dir: string, options: WatchOptions = {}): void {
  try {
    if (!fs.existsSync(dir)) return;
    const onEvent = (_event: string, filename: string | Buffer | null) => {
      const name = filename?.toString().replaceAll("\\", "/") ?? null;
      if (options.accept && !options.accept(name)) return;
      if (options.sessions) sessionNotify?.();
      else {
        bump();
        if (options.source?.(name)) assetNotify?.();
      }
    };
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false, recursive: options.recursive ?? true }, onEvent);
    } catch {
      watcher = fs.watch(dir, { persistent: false }, onEvent);
    }
    watcher.on("error", () => {});
    watchers.push(watcher);
  } catch {
    // Watching is best-effort; snapshot polling still works.
  }
}

export async function startHubWatch(options: HubWatchOptions = {}): Promise<() => void> {
  stopHubWatch();
  sessionNotify = options.onSessionChange ?? null;
  assetNotify = options.onAssetChange ?? null;
  try {
    const config = await loadConfig();
    const p = hubPaths();
    // Watch the directory so atomic config replacements do not orphan a file watcher.
    const isConfig = (name: string | null) => name === null || name === "config.toml";
    watchDir(p.root, { recursive: false, accept: isConfig, source: isConfig });
    watchDir(p.skills, { source: () => true });
    watchDir(p.memory, {
      // inject-state is user scope configuration; autoload.json and exports are generated.
      source: (name) => name === null || name === "global.md" || name === "inject-state.json"
        || name === "projects" || /^projects\/[^/]+\.md$/.test(name),
    });
    watchDir(p.ctx, { source: (name) => name === null || name === "USER.md" });
    watchDir(p.sessions);
    const home = homedir();
    for (const id of config.agents.enabled.slice(0, 24)) {
      watchDir(resolvedSkillDir(id, home, config));
      const root = adapter(id).sessionRoot?.(home);
      if (root) watchDir(root, { sessions: true });
    }
  } catch {
    // Config may not exist yet during first boot.
  }
  return stopHubWatch;
}

export function stopHubWatch(): void {
  sessionNotify = null;
  assetNotify = null;
  for (const watcher of watchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  watchers = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
