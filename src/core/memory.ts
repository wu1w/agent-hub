import { HubError } from "./errors.ts";
import { transaction } from "./transaction.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { adapter, homedir } from "./adapters.ts";
import { ensureHub, hubPaths, loadConfig } from "./config.ts";
import { exists, mtimeMs, readText, writeText } from "./fsx.ts";
import type { AgentId, HubConfig, MemoryProject } from "./types.ts";

const PROJECT_ID = /^[A-Za-z0-9._-]+$/;
const INJECT_CAP = 24_000;

export function assertProjectId(id: string): string {
  if (typeof id !== "string" || !PROJECT_ID.test(id) || id === "." || id === "..") throw new HubError(`invalid project id: ${id}`, 400);
  return id;
}

export function slugRepo(cwd: string, home: string): string {
  const abs = path.resolve(cwd);
  const rel = abs === home || abs.startsWith(home + path.sep)
    ? abs.slice(home.length).replace(/^\/+/, "")
    : abs.replace(/^\/+/, "");
  const slug = rel.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "root";
}

export async function listMemoryProjects(): Promise<MemoryProject[]> {
  await ensureHub();
  const dir = hubPaths().memoryProjects;
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: MemoryProject[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const id = name.slice(0, -3);
    if (!PROJECT_ID.test(id)) continue;
    const target = path.join(dir, name);
    out.push({ id, path: target, mtime: await mtimeMs(target) });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export async function readGlobalMemory(): Promise<string> {
  await ensureHub();
  return (await readText(hubPaths().memoryGlobal)) ?? "";
}

export async function writeGlobalMemory(content: string): Promise<string> {
  return transaction(async () => {
    await ensureHub();
    const target = hubPaths().memoryGlobal;
    await writeText(target, content);
    return target;
  });
}

export async function readProjectMemory(id: string): Promise<string> {
  const target = path.join(hubPaths().memoryProjects, `${assertProjectId(id)}.md`);
  return (await readText(target)) ?? "";
}

export async function writeProjectMemory(id: string, content: string): Promise<string> {
  return transaction(async () => {
    await ensureHub();
    const target = path.join(hubPaths().memoryProjects, `${assertProjectId(id)}.md`);
    await writeText(target, content);
    return target;
  });
}

function todayStamp(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function appendBullet(existing: string, text: string, now = new Date()): string {
  const day = todayStamp(now);
  const bullet = `- ${text.trim()}`;
  const heading = `## ${day}`;
  const body = existing.replace(/\s+$/, "");
  if (body.includes(`\n${heading}\n`) || body.startsWith(`${heading}\n`)) {
    const idx = body.lastIndexOf(heading);
    const after = body.slice(idx);
    if (!after.slice(heading.length).includes("\n## ")) {
      return `${body}\n${bullet}\n`;
    }
  }
  const sep = body.length ? "\n\n" : "";
  return `${body}${sep}${heading}\n\n${bullet}\n`;
}

export async function remember(text: string, projectId?: string): Promise<{ path: string }> {
  return transaction(async () => {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("empty memory");
    await ensureHub();
    if (projectId) {
      const id = assertProjectId(projectId);
      const prev = (await readProjectMemory(id)) || `# ${id}\n\n项目记忆。只在 Hub 改这一份。\n`;
      const target = await writeProjectMemory(id, appendBullet(prev, trimmed));
      return { path: target };
    }
    const prev = await readGlobalMemory();
    const target = await writeGlobalMemory(appendBullet(prev, trimmed));
    return { path: target };
  });
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n\n…（已截断）\n`;
}

export async function composeInject(preferProject?: string): Promise<string> {
  const global = (await readGlobalMemory()).trim() || "（还没有全局记忆）";
  if (!preferProject) return `${global}\n`;
  assertProjectId(preferProject);
  if (!await projectExists(preferProject)) throw new HubError("project memory not found", 404);
  const raw = (await readProjectMemory(preferProject)).trim();
  if (!raw) return `${global}\n`;
  return `${global}\n\n## 项目 ${preferProject}\n\n${clip(raw, INJECT_CAP)}\n`;
}

export async function memorySnapshot(): Promise<{
  globalPath: string;
  global: string;
  projects: MemoryProject[];
}> {
  await ensureHub();
  return {
    globalPath: hubPaths().memoryGlobal,
    global: await readGlobalMemory(),
    projects: await listMemoryProjects(),
  };
}

export async function projectExists(id: string): Promise<boolean> {
  return exists(path.join(hubPaths().memoryProjects, `${assertProjectId(id)}.md`));
}

export async function scanNativeMemory(
  config?: HubConfig,
): Promise<{ agent: AgentId; name: string; path: string }[]> {
  const cfg = config ?? (await loadConfig());
  const home = homedir();
  const out: { agent: AgentId; name: string; path: string }[] = [];
  for (const id of cfg.agents.enabled) {
    const dirs = adapter(id).nativeMemoryDirs?.(home) ?? [];
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        if (name.includes("hub-generated")) continue;
        const target = path.join(dir, name);
        try {
          const st = await fs.lstat(target);
          if (!st.isFile() && !st.isSymbolicLink()) continue;
        } catch {
          continue;
        }
        out.push({ agent: id, name: name.replace(/\.md$/, ""), path: target });
      }
    }
  }
  return out;
}

export async function importNativeMemory(only?: AgentId): Promise<{ imported: string[]; skipped: string[] }> {
  return transaction(async () => {
    await ensureHub();
    const rows = (await scanNativeMemory()).filter((row) => !only || row.agent === only);
    const imported: string[] = [];
    const skipped: string[] = [];
    for (const row of rows) {
      const id = assertProjectId(`native-${row.agent}-${row.name}`.replace(/[^A-Za-z0-9._-]+/g, "-"));
      const dest = path.join(hubPaths().memoryProjects, `${id}.md`);
      if (await exists(dest)) {
        skipped.push(id);
        continue;
      }
      const text = await readText(row.path);
      if (!text || text.includes("hub-generated: agent-hub") || text?.includes("<!-- agent-hub:")) {
        skipped.push(id);
        continue;
      }
      await writeText(
        dest,
        `# ${id}\n\n<!-- imported once from ${row.path}; Hub 不再回写原生目录 -->\n\n${text}`,
      );
      imported.push(id);
    }
    return { imported, skipped };
  });
}
