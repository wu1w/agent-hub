import { createHash } from "node:crypto";
import { HubError } from "./errors.ts";
import { assertProjectId } from "./memory.ts";
import { transaction } from "./transaction.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { adapter, homedir } from "./adapters.ts";
import { hubPaths } from "./config.ts";
import { assertAbsolutePath, assertSafeName, exists, isDir, readText, realpathOr, writeText } from "./fsx.ts";
import { assertSkillName, writeHubSkill } from "./skills.ts";
import { syncIdentityNative } from "./identity-native.ts";
import type { AgentId } from "./types.ts";

export type FileKind = "user-md" | "identity" | "soul" | "skill" | "subagent" | "memory" | "agents-md";

async function assertInside(root: string, target: string): Promise<void> {
  const resolved = path.resolve(target);
  const base = path.resolve(root);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("path escapes allowlist");
  }
  const realRoot = (await realpathOr(root)) ?? base;
  if (await exists(target)) {
    const realTarget = (await realpathOr(target)) ?? resolved;
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
      throw new Error("path escapes allowlist");
    }
  }
}

export async function allowedRead(kind: FileKind, agent?: AgentId, name?: string): Promise<string> {
  const home = homedir();
  const p = hubPaths();
  if (kind === "user-md") return p.userMd;
  if (kind === "agents-md") {
    if (!name) throw new Error("cwd required");
    const root = assertAbsolutePath(name, "cwd");
    const target = path.join(root, "AGENTS.md");
    await assertInside(root, target);
    return target;
  }
  if (kind === "memory") {
    if (!name || name === "global") return p.memoryGlobal;
    // `name` is a project ID, not a filename. Match remember/scope/composition exactly.
    // Thus IDs `demo` and `demo.md` refer to distinct demo.md and demo.md.md files.
    const safe = assertProjectId(assertSafeName(name, "memory"));
    const target = path.join(p.memoryProjects, `${safe}.md`);
    await assertInside(p.memoryProjects, target);
    return target;
  }
  if (kind === "skill") {
    if (!name) throw new Error("skill name required");
    const safe = assertSkillName(name);
    const target = path.join(p.skills, safe, "SKILL.md");
    await assertInside(p.skills, target);
    return target;
  }
  if (!agent) throw new Error("agent required");
  const ad = adapter(agent);
  if (ad.memoryOnly) throw new Error("该 Agent 仅支持 Memory 自动加载");
  if (kind === "identity") return ad.identityPath(home);
  if (kind === "soul") {
    if (!ad.soulPath) throw new Error("no soul file");
    return ad.soulPath(home);
  }
  if (kind === "subagent") {
    if (!name || !ad.subagentDir) throw new Error("subagent not available");
    const dir = ad.subagentDir(home);
    const file = name.endsWith(".md") ? name : `${name}.md`;
    assertSafeName(file.replace(/\.md$/, ""), "subagent");
    const target = path.join(dir, file);
    await assertInside(dir, target);
    return target;
  }
  throw new Error("unknown file kind");
}

export async function readAllowed(
  kind: FileKind,
  agent?: AgentId,
  name?: string,
): Promise<{ path: string; content: string; exists: boolean; revision: string }> {
  const target = await allowedRead(kind, agent, name);
  const content = await readText(target);
  return { path: target, content: content ?? "", exists: content != null, revision: fileRevision(content) };
}

export const fileRevision = (content: string | null): string => createHash("sha256").update(JSON.stringify(content)).digest("hex");

/** Read-only view of the file an agent actually receives for a layer (ctx = USER.md projection, memory = injected memory file). */
export async function readAgentLayer(agent: AgentId, layer: "ctx" | "memory"): Promise<{ path: string; content: string; exists: boolean }> {
  const ad = adapter(agent);
  const home = homedir();
  const target = layer === "ctx"
    ? (ad.userMdProjection ? ad.userMdProjection(home) : null)
    : ad.memoryInjectPath(home);
  if (!target) throw new HubError("agent has no ctx projection path", 400);
  const content = await readText(target);
  return { path: target, content: content ?? "", exists: content != null };
}

export async function createMemoryProject(name: string, content: string): Promise<{ path: string }> {
  return transaction(async () => {
    assertProjectId(name);
    if (name.toLowerCase().replace(/\.md$/, "") === "global") throw new HubError("global 是保留名称", 409);
    const target = await allowedRead("memory", undefined, name);
    if (await exists(target)) throw new HubError("项目记忆已存在", 409);
    await writeText(target, content);
    return { path: target };
  });
}

/** Create-only entrypoint; a duplicate can never become an unversioned overwrite. */
export async function createSubagent(agent: AgentId, name: string, content: string): Promise<{ path: string; content: string; exists: boolean; revision: string }> {
  return transaction(async () => {
    const target = await allowedRead("subagent", agent, name);
    if (await exists(target)) throw new HubError("subagent already exists", 409);
    await writeAllowed("subagent", content, agent, name, fileRevision(null));
    return readAllowed("subagent", agent, name);
  });
}

const IDENTITY_SEED = (label: string) => `# Identity

这份文件只属于 ${label}，不会同步到其他 Agent。
`;

export async function writeAllowed(
  kind: FileKind,
  content: string,
  agent?: AgentId,
  name?: string,
  expectedRevision?: string,
): Promise<{ path: string }> {
  return transaction(async () => {
    if (expectedRevision !== undefined && (await readAllowed(kind, agent, name)).revision !== expectedRevision) {
      throw new HubError("文件已被其他操作修改，请重新载入并合并草稿", 409);
    }
    if (kind === "skill" && name) {
      await writeHubSkill(name, content);
      return { path: await allowedRead("skill", undefined, name) };
    }
    const target = await allowedRead(kind, agent, name);
    if (kind === "agents-md") {
      const root = path.dirname(target);
      if (!(await isDir(root))) throw new Error("cwd not a directory");
      await writeText(target, content);
      return { path: target };
    }
    if (kind === "identity" || kind === "soul" || kind === "subagent") {
      if (!agent) throw new Error("agent required");
      if (await exists(target)) await backupAgentFile(kind, agent, target, name);
      await writeText(target, content);
      if (kind === "identity") await syncIdentityNative(agent, content);
      return { path: target };
    }
    if (kind === "user-md" || kind === "memory") {
      await writeText(target, content);
      return { path: target };
    }
    throw new Error("write not allowed");
  });
}

export type BackupKind = "identity" | "soul" | "subagent";

export type BackupRecord = {
  name: string;
  path: string;
  kind: BackupKind | "unknown";
  originalPath: string;
  subagent?: string;
};

type BackupMeta = {
  kind: BackupKind;
  agent: AgentId;
  originalPath: string;
  subagent?: string;
  createdAt: string;
};

function backupDir(agent: AgentId): string {
  return path.join(hubPaths().backups, "identity", agent);
}

async function writeBackupMeta(mdPath: string, meta: BackupMeta): Promise<void> {
  await writeText(`${mdPath}.meta.json`, JSON.stringify(meta));
}

async function readBackupMeta(mdPath: string, agent: AgentId): Promise<BackupMeta | null> {
  try {
    const raw = JSON.parse(await fs.readFile(`${mdPath}.meta.json`, "utf8")) as BackupMeta;
    if (raw.agent !== agent) return null;
    if (raw.kind === "identity" || raw.kind === "soul" || raw.kind === "subagent") {
      const expected = await allowedRead(raw.kind, agent, raw.subagent);
      if (path.resolve(raw.originalPath) !== expected) return null;
      return { ...raw, originalPath: expected };
    }
  } catch {
    // fall through to filename heuristics for older backups
  }
  const base = path.basename(mdPath);
  if (base.includes(".soul.")) {
    const soul = adapter(agent).soulPath?.(homedir());
    if (soul) return { kind: "soul", agent, originalPath: soul, createdAt: "" };
  }
  if (base.includes(".subagent.")) {
    const dir = adapter(agent).subagentDir?.(homedir());
    const sub = base.replace(/^.*\.subagent\./, "").replace(/\.md$/, "");
    if (dir && sub) {
      return {
        kind: "subagent",
        agent,
        originalPath: path.join(dir, sub.endsWith(".md") ? sub : `${sub}.md`),
        subagent: sub,
        createdAt: "",
      };
    }
  }
  if (base.includes(".identity.")) return { kind: "identity", agent, originalPath: adapter(agent).identityPath(homedir()), createdAt: "" };
  return null; // Legacy untyped backups must never be guessed as Identity.
}

async function backupAgentFile(
  kind: BackupKind,
  agent: AgentId,
  originalPath: string,
  subagent?: string,
): Promise<string> {
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.hrtime.bigint()}`;
  const subName = (subagent ?? path.basename(originalPath)).replace(/\.md$/, "") + ".md";
  const id =
    kind === "subagent"
      ? `${stamp}.subagent.${subName}`
      : `${stamp}.${kind}.md`;
  const dir = backupDir(agent);
  await fs.mkdir(dir, { recursive: true });
  const bak = path.join(dir, id);
  await writeText(bak, await fs.readFile(originalPath, "utf8"));
  await writeBackupMeta(bak, {
    kind,
    agent,
    originalPath,
    subagent: kind === "subagent" ? subName : undefined,
    createdAt: new Date().toISOString(),
  });
  return bak;
}

export async function listIdentityBackups(agent: AgentId): Promise<BackupRecord[]> {
  const dir = backupDir(agent);
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((item) => !item.endsWith(".meta.json") && !item.includes(".tmp-")).sort();
  } catch {
    return [];
  }
  const out: BackupRecord[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const meta = await readBackupMeta(file, agent);
    if (!meta) {
      out.push({ name, path: file, kind: "unknown", originalPath: "" });
      continue;
    }
    out.push({
      name,
      path: file,
      kind: meta.kind,
      originalPath: meta.originalPath,
      subagent: meta.subagent,
    });
  }
  return out;
}

export async function restoreIdentity(agent: AgentId, backupName?: string, legacy?: { kind: BackupKind; subagent?: string }): Promise<{ path: string; from: string; kind: BackupKind }> {
  return transaction(async () => {
    const listed = await listIdentityBackups(agent);
    if (listed.length === 0) throw new Error("没有可用的 Identity 备份");
    let pick: BackupRecord | undefined;
    if (backupName) {
      pick = listed.find((item) => item.name === backupName);
      if (!pick) throw new Error(`没有这份备份: ${backupName}`);
    } else {
      const identities = listed.filter((item) => item.kind === "identity");
      pick = identities[identities.length - 1];
      if (!pick) throw new Error("没有可用的 Identity 备份");
    }
    if (pick.kind === "unknown") {
      if (!legacy || !["identity", "soul", "subagent"].includes(legacy.kind)) throw new Error("旧备份来源未知，请明确指定 identity / soul / subagent");
      pick = { ...pick, kind: legacy.kind, subagent: legacy.subagent, originalPath: await allowedRead(legacy.kind, agent, legacy.subagent) };
    }
    const kind = pick.kind as BackupKind;
    const target = await allowedRead(kind, agent, pick.subagent);
    if (await exists(target)) {
      await backupAgentFile(kind, agent, target, pick.subagent);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const restored = await fs.readFile(pick.path, "utf8");
    await writeText(target, restored);
    if (kind === "identity") await syncIdentityNative(agent, restored);
    return { path: target, from: pick.path, kind };
  });
}

export async function ensureIdentityFile(agent: AgentId): Promise<void> {
  const ad = adapter(agent);
  if (ad.memoryOnly) throw new Error("该 Agent 仅支持 Memory 自动加载");
  const target = ad.identityPath(homedir());
  if (await exists(target)) return;
  await writeText(target, IDENTITY_SEED(ad.label));
}
