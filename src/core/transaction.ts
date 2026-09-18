import fs from "node:fs/promises";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { hubRoot } from "./config.ts";

type Entry = { target: string; backup: string; existed: boolean };
type Context = { root: string; active: boolean; journal?: string; entries: Entry[] };
const context = new AsyncLocalStorage<Context>();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function restore(entries: Entry[]): Promise<void> {
  // Missing recovery material must not delete the only remaining target copy.
  for (const entry of entries) if (entry.existed) await fs.lstat(entry.backup);
  for (const entry of [...entries].reverse()) {
    await fs.rm(entry.target, { recursive: true, force: true });
    if (entry.existed) {
      await fs.mkdir(path.dirname(entry.target), { recursive: true });
      await fs.cp(entry.backup, entry.target, { recursive: true, verbatimSymlinks: true });
    }
  }
}

/** Cross-process, reentrant writer lock. A dead owner is reclaimed; a live owner is never timed out. */
export async function withHubLock<T>(run: () => Promise<T>): Promise<T> {
  const root = hubRoot();
  const parent = context.getStore();
  if (parent?.active && parent.root === root) return run();
  await fs.mkdir(root, { recursive: true });
  const lock = path.join(root, ".writer.lock");
  // Publish a complete owner file atomically, avoiding an ownerless mkdir window.
  const candidate = path.join(root, `.writer-${randomUUID()}`);
  await fs.writeFile(candidate, String(process.pid), { mode: 0o600, flag: "wx" });
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      try { await fs.link(candidate, lock); break; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const pid = Number(await fs.readFile(lock, "utf8"));
          if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid writer lock; manual inspection required");
          try { process.kill(pid, 0); } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ESRCH") {
              // Only one stale-owner reaper may inspect/remove the lock.
              const gate = lock + ".reap";
              try { await fs.mkdir(gate); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("stale lock recovery is busy; inspect .writer.lock.reap if it persists");
                throw error;
              }
              try {
                const owner = Number(await fs.readFile(lock, "utf8"));
                try { process.kill(owner, 0); } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === "ESRCH") await fs.unlink(lock);
                }
              } finally { await fs.rmdir(gate); }
            }
          }
        } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        if (Date.now() > deadline) throw new Error("Hub is busy; retry after the other writer completes");
        await pause(25);
      }
    }
    const state: Context = { root, active: true, entries: [] };
    return await context.run(state, async () => {
      try {
        const pending = path.join(root, ".transaction");
        let entries: Entry[] | null = null;
        try {
          entries = JSON.parse(await fs.readFile(path.join(pending, "journal.json"), "utf8")) as Entry[];
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          // Only absence of the journal means these are post-commit leftovers.
          await fs.rm(pending, { recursive: true, force: true });
        }
        if (entries) {
          await restore(entries);
          await fs.rm(pending, { recursive: true, force: true });
        }
        return await run();
      } finally { state.active = false; }
    });
  } finally {
    // Only remove the lock if it is still our hard link.
    try { if ((await fs.stat(lock)).ino === (await fs.stat(candidate)).ino) await fs.unlink(lock); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    await fs.rm(candidate, { force: true });
  }
}

/** Capture before mutation; journal rename is complete before the target is touched. */
export async function checkpoint(target: string): Promise<void> {
  const state = context.getStore();
  if (!state?.active || !state.journal) return;
  target = path.resolve(target);
  if (state.entries.some((e) => target === e.target || target.startsWith(e.target + path.sep))) return;
  const backup = path.join(state.journal, String(state.entries.length));
  let existed = false;
  try { await fs.lstat(target); existed = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  if (existed) await fs.cp(target, backup, { recursive: true, verbatimSymlinks: true });
  state.entries.push({ target, backup, existed });
  const staging = path.join(state.journal, "journal.tmp");
  const journal = await fs.open(staging, "w", 0o600);
  try { await journal.writeFile(JSON.stringify(state.entries)); await journal.sync(); } finally { await journal.close(); }
  await fs.rename(staging, path.join(state.journal, "journal.json"));
}

export async function transaction<T>(run: () => Promise<T>): Promise<T> {
  return withHubLock(async () => {
    const state = context.getStore()!;
    if (state.journal) return run();
    const dir = path.join(state.root, ".transaction");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    state.journal = dir;
    state.entries = [];
    let committed = false;
    try {
      const result = await run();
      // Removing the journal is the commit point. Leftover backup files are harmless.
      await fs.rm(path.join(dir, "journal.json"), { force: true });
      committed = true;
      // Commit has succeeded; cleanup must not report a failed save to callers.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return result;
    } catch (error) {
      if (!committed) await restore(state.entries);
      await fs.rm(dir, { recursive: true, force: true });
      throw error;
    } finally { state.journal = undefined; state.entries = []; }
  });
}
