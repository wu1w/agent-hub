import fs from "node:fs";
import { loadConfig, hubPaths, resolvedSkillDir } from "./config.ts";
import { adapter, homedir } from "./adapters.ts";

let epoch = 0;
let watchers: fs.FSWatcher[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

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

function watchDir(dir: string): void {
  try {
    if (!fs.existsSync(dir)) return;
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false, recursive: true }, () => bump());
    } catch {
      watcher = fs.watch(dir, { persistent: false }, () => bump());
    }
    watcher.on("error", () => {});
    watchers.push(watcher);
  } catch {
    // Watching is best-effort; snapshot polling still works.
  }
}

export async function startHubWatch(): Promise<() => void> {
  stopHubWatch();
  try {
    const config = await loadConfig();
    const p = hubPaths();
    for (const dir of [p.skills, p.memory, p.ctx, p.sessions]) watchDir(dir);
    const home = homedir();
    for (const id of config.agents.enabled.slice(0, 24)) {
      watchDir(resolvedSkillDir(id, home, config));
      const root = adapter(id).sessionRoot?.(home);
      if (root) watchDir(root);
    }
  } catch {
    // Config may not exist yet during first boot.
  }
  return stopHubWatch;
}

export function stopHubWatch(): void {
  for (const watcher of watchers) {
    try { watcher.close(); } catch { /* already closed */ }
  }
  watchers = [];
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}