import fs from "node:fs";
import { loadConfig, hubPaths, resolvedSkillDir } from "./config.ts";
import { adapter, homedir } from "./adapters.ts";

let epoch = 0;
let watchers: fs.FSWatcher[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let sessionNotify: (() => void) | null = null;

export type HubWatchOptions = { onSessionChange?: () => void };

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

function watchDir(dir: string, sessions = false): void {
  try {
    if (!fs.existsSync(dir)) return;
    const onEvent = () => {
      if (sessions) sessionNotify?.();
      else bump();
    };
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false, recursive: true }, onEvent);
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
  try {
    const config = await loadConfig();
    const p = hubPaths();
    for (const dir of [p.skills, p.memory, p.ctx, p.sessions]) watchDir(dir);
    const home = homedir();
    for (const id of config.agents.enabled.slice(0, 24)) {
      watchDir(resolvedSkillDir(id, home, config));
      const root = adapter(id).sessionRoot?.(home);
      if (root) watchDir(root, true);
    }
  } catch {
    // Config may not exist yet during first boot.
  }
  return stopHubWatch;
}

export function stopHubWatch(): void {
  sessionNotify = null;
  for (const watcher of watchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  watchers = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}