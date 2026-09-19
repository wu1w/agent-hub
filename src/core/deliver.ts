import { protectMemoryTarget } from "./delivery-safety.ts";
import { nativeMemoryTarget, syncNativeMemory } from "./autoload.ts";
import { transaction, withHubLock } from "./transaction.ts";
import { HubError } from "./errors.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { adapter, homedir, isAgentPresent } from "./adapters.ts";
import { hubPaths, loadConfig } from "./config.ts";
import { exists, isDir, readText, removeFile, writeText, parseJsonOr, pruneBackupDir } from "./fsx.ts";
import { assertProjectId, composeInject, projectExists } from "./memory.ts";
import { renderCatalogMarkdown, VAULT_MARK, vaultCatalogFor } from "./vault.ts";
import { AGENT_IDS, isAgentId, type AgentId, type HubConfig, type Layer } from "./types.ts";

export const HUB_MARK = "<!-- hub-generated: agent-hub -->";

export function isHubGenerated(content: string | null): boolean {
  return Boolean(content && content.includes(HUB_MARK));
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function backupUserFile(kind: "memory" | "ctx" | "vault", agent: AgentId, target: string): Promise<void> {
  const current = await readText(target);
  if (isHubGenerated(current) || current?.includes(VAULT_MARK)) return;
  const dir = path.join(hubPaths().backups, kind, agent);
  let backup: string | null = null;
  if (current !== null) {
    backup = `${stamp()}-${process.hrtime.bigint()}${path.extname(target) || ".md"}`;
    await writeText(path.join(dir, backup), current);
    await pruneBackupDir(dir);
  }
  // Record absence too: a later Own transition must not resurrect a previous cycle's file.
  await writeText(path.join(dir, "current.json"), JSON.stringify({ backup }));
}

async function latestBackup(kind: "memory" | "ctx" | "vault", agent: AgentId): Promise<string | null> {
  const dir = path.join(hubPaths().backups, kind, agent);
  const manifest = await readText(path.join(dir, "current.json"));
  if (manifest) {
    const { backup } = JSON.parse(manifest) as { backup: string | null };
    if (!backup) return null;
    if (path.basename(backup) !== backup) throw new Error("invalid projection backup");
    return path.join(dir, backup);
  }
  // Compatibility for projections written by the previous release.
  try {
    const names = (await fs.readdir(dir)).filter((n) => n !== "current.json").sort();
    return names.length ? path.join(dir, names[names.length - 1]!) : null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function wrapInject(body: string, extraFront?: string): string {
  const head = extraFront ? `${extraFront.trimEnd()}\n\n` : "";
  return `${head}${HUB_MARK}
<!-- 只读注入。改记忆请到 Agent Hub，下次同步会覆盖这份文件。 -->

# Hub Memory

${body.trim()}\n`;
}

export async function injectMemory(agent: AgentId, preferProject?: string, cwd?: string): Promise<string | null> {
  return transaction(async () => {
    const home = homedir();
    const ad = adapter(agent);
    if (!isAgentPresent(agent, home)) return null;
    if (preferProject && !cwd) throw new Error("project memory requires a workspace");
    const dest = cwd ? workspaceMemoryPath(agent, cwd) : ad.memoryInjectPath(home);
    if (await isDir(dest)) throw new Error(`memory 注入路径是目录：${dest}`);
    // Workspace-only loaders (Cline, Hyper, OpenClaw) have no global consumer.
    // Do not write a cache file nobody reads; bind still succeeds so scopes can attach later.
    if (!cwd && !ad.manualMemory && !(await nativeMemoryTarget(agent))) return dest;
    if (!cwd) await backupUserFile("memory", agent, dest);
    else if (await exists(dest) && !isHubGenerated(await readText(dest))) throw new Error("workspace memory path contains a user file");
    const body = await composeInject(preferProject);
    const extra = agent === "cursor"
      ? `---\ndescription: Agent Hub 只读记忆注入。不要手改。\nalwaysApply: true\n---`
      : undefined;
    await protectMemoryTarget(dest, cwd);
    await writeText(dest, wrapInject(body, extra));
    await syncNativeMemory(agent, body, cwd, preferProject);
    return dest;
  });
}

export async function removeMemoryInject(agent: AgentId): Promise<void> {
  return transaction(async () => {
    await syncNativeMemory(agent, null);
    const dest = adapter(agent).memoryInjectPath(homedir());
    const current = await readText(dest);
    if (!isHubGenerated(current)) return;
    await removeFile(dest);
    const bak = await latestBackup("memory", agent);
    if (bak) await writeText(dest, await fs.readFile(bak, "utf8"));
  });
}

type MemoryScope = { agent: AgentId; cwd: string; project?: string };
type MemoryInjectState = { scopes: MemoryScope[] };

export function workspaceMemoryPath(agent: AgentId, cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new Error("workspace must be absolute");
  return agent === "cursor" ? path.join(cwd, ".cursor/rules/hub-generated-memory.mdc")
    : path.join(cwd, ".agent-hub", `hub-generated-memory-${agent}.md`);
}

async function loadMemoryInjectState(): Promise<MemoryInjectState> {
  const raw = await readText(path.join(hubPaths().memory, "inject-state.json"));
  const parsed = parseJsonOr<Partial<MemoryInjectState>>(raw, { scopes: [] });
  // Legacy per-agent project choices have no workspace identity and are not replayed globally.
  return { scopes: (parsed.scopes ?? []).filter((s) => isAgentId(s.agent) && path.isAbsolute(s.cwd)) };
}

async function saveMemoryInjectState(state: MemoryInjectState): Promise<void> {
  await writeText(path.join(hubPaths().memory, "inject-state.json"), JSON.stringify(state, null, 2));
}

type MemorySyncFilter = { agent?: AgentId; cwd?: string };
type MemorySyncTarget = { agent: AgentId; cwd?: string; project?: string };
export type MemorySyncReport = { written: string[]; failures: { agent?: AgentId; cwd?: string; error: string }[] };

async function memorySyncTargets(changedProject?: string, filter: MemorySyncFilter = {}): Promise<MemorySyncTarget[]> {
  if (changedProject !== undefined) assertProjectId(changedProject);
  const state = await loadMemoryInjectState();
  const targets: MemorySyncTarget[] = changedProject === undefined && filter.cwd === undefined
    ? AGENT_IDS.filter(agent => !filter.agent || filter.agent === agent).map(agent => ({ agent })) : [];
  for (const scope of state.scopes) {
    if (filter.agent && filter.agent !== scope.agent) continue;
    if (filter.cwd !== undefined && path.resolve(filter.cwd) !== scope.cwd) continue;
    if (changedProject !== undefined && scope.project !== changedProject) continue;
    targets.push(scope);
  }
  return targets;
}

async function syncMemoryTarget(target: MemorySyncTarget, config: HubConfig): Promise<string | null> {
  const { agent, cwd, project } = target;
  if (cwd && !await isDir(cwd)) return null; // Unavailable scopes remain registered for a later retry.
  const enabled = config.agents.enabled.includes(agent) && config.bind[agent].memory === "hub";
  if (enabled) return injectMemory(agent, project, cwd);
  if (!cwd) await removeMemoryInject(agent);
  else {
    await syncNativeMemory(agent, null, cwd);
    const dest = workspaceMemoryPath(agent, cwd);
    if (isHubGenerated(await readText(dest))) await removeFile(dest);
  }
  return null;
}

/** Atomic delivery for one binding/scope operation; callers may explicitly request all targets. */
export async function syncMemoryInjects(changedProject?: string, filter: MemorySyncFilter = {}): Promise<string[]> {
  return transaction(async () => {
    const config = await loadConfig();
    const written: string[] = [];
    for (const target of await memorySyncTargets(changedProject, filter)) {
      const dest = await syncMemoryTarget(target, config);
      if (dest) written.push(dest);
    }
    return written;
  });
}

/** User-facing fan-out: each target has its own rollback; committed source edits stay saved.
 * Call after the source transaction, never inside it. Failures are returned, not hidden.
 */
export async function syncMemoryReport(changedProject?: string): Promise<MemorySyncReport> {
  const report: MemorySyncReport = { written: [], failures: [] };
  try {
    await withHubLock(async () => {
      const config = await loadConfig();
      for (const target of await memorySyncTargets(changedProject)) {
        try {
          const dest = await transaction(() => syncMemoryTarget(target, config));
          if (dest) report.written.push(dest);
        } catch (error) {
          report.failures.push({ agent: target.agent, cwd: target.cwd, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });
  } catch (error) {
    report.failures.push({ error: error instanceof Error ? error.message : String(error) });
  }
  return report;
}

export async function memoryScopeFor(agent: AgentId, cwd: string): Promise<string | null> {
  if (!cwd) return null;
  const config = await loadConfig();
  if (config.bind[agent].memory !== "hub") return null;
  const state = await loadMemoryInjectState();
  return state.scopes.some((s) => s.agent === agent && s.cwd === path.resolve(cwd)) ? workspaceMemoryPath(agent, cwd) : null;
}

export async function injectCtx(agent: AgentId): Promise<string | null> {
  return transaction(async () => {
    const home = homedir();
    const ad = adapter(agent);
    if (!ad.userMdProjection || !(await loadConfig()).layers.ctx.global_targets.includes(agent)) return null;
    if (!isAgentPresent(agent, home)) return null;
    const dest = ad.userMdProjection(home);
    if (await isDir(dest)) throw new Error(`ctx 投影路径是目录：${dest}`);
    await backupUserFile("ctx", agent, dest);
    const source = (await readText(hubPaths().userMd)) ?? "";
    const extra = agent === "cursor"
      ? `---\ndescription: Agent Hub USER.md 投影。不要当人设用。\nalwaysApply: true\n---\n\n`
      : "";
    await writeText(
      dest,
      `${extra}${HUB_MARK}
<!-- 只读投影 Hub ctx/USER.md。改用户短文件请到 Agent Hub。不要当人设用。 -->

${source.trim()}\n`,
    );
    return dest;
  });
}

export async function removeCtxInject(agent: AgentId): Promise<void> {
  return transaction(async () => {
    const ad = adapter(agent);
    if (!ad.userMdProjection) return;
    const dest = ad.userMdProjection(homedir());
    const current = await readText(dest);
    if (!isHubGenerated(current)) return;
    await removeFile(dest);
    const bak = await latestBackup("ctx", agent);
    if (bak) await writeText(dest, await fs.readFile(bak, "utf8"));
  });
}

export async function syncCtxInjects(): Promise<string[]> {
  return transaction(async () => {
    const config = await loadConfig();
    const written: string[] = [];
    for (const id of config.agents.enabled) {
      if (config.bind[id].ctx !== "hub") {
        await removeCtxInject(id);
        continue;
      }
      const dest = await injectCtx(id);
      if (dest) written.push(dest);
    }
    return written;
  });
}

export async function injectVaultCatalog(
  agent: AgentId,
  opts?: { assumeHub?: boolean },
): Promise<string | null> {
  return transaction(async () => {
    const home = homedir();
    const ad = adapter(agent);
    if (!isAgentPresent(agent, home)) return null;
    const dest = ad.vaultCatalogPath(home);
    await backupUserFile("vault", agent, dest);
    const items = await vaultCatalogFor(agent, opts);
    const extra = agent === "cursor"
      ? `---\ndescription: Agent Hub Vault 目录（不含密钥）。\nalwaysApply: true\n---\n\n`
      : "";
    await writeText(dest, extra + renderCatalogMarkdown(agent, items));
    return dest;
  });
}

export async function removeVaultCatalog(agent: AgentId): Promise<void> {
  return transaction(async () => {
    const dest = adapter(agent).vaultCatalogPath(homedir());
    const current = await readText(dest);
    if (!current || !current.includes(VAULT_MARK)) return;
    await removeFile(dest);
    const bak = await latestBackup("vault", agent);
    if (bak) await writeText(dest, await fs.readFile(bak, "utf8"));
  });
}

export async function syncVaultCatalogs(): Promise<string[]> {
  return transaction(async () => {
    const config = await loadConfig();
    const written: string[] = [];
    for (const id of config.agents.enabled) {
      if (config.bind[id].vault !== "hub") {
        await removeVaultCatalog(id);
        continue;
      }
      const dest = await injectVaultCatalog(id);
      if (dest) written.push(dest);
    }
    return written;
  });
}

export async function applyLayerBind(
  agent: AgentId,
  layer: Layer,
  value: string,
): Promise<void> {
  if (layer === "memory") {
    if (value === "hub") await injectMemory(agent);
    else await removeMemoryInject(agent);
  }
  if (layer === "ctx") {
    if (value === "hub") await injectCtx(agent);
    else await removeCtxInject(agent);
  }
  if (layer === "vault") {
    if (value === "hub") await injectVaultCatalog(agent, { assumeHub: true });
    else await removeVaultCatalog(agent);
  }
}

/** Select one workspace; separate workspaces never share a project projection. */
export async function selectMemoryProject(agent: AgentId, project: string | undefined, cwd: string, globalOnly = false): Promise<string> {
  return transaction(async () => {
    if (!isAgentId(agent) || !path.isAbsolute(cwd) || ((project || globalOnly) && !(await isDir(cwd)))) throw new Error("valid agent and absolute workspace directory required");
    if (project) assertProjectId(project);
    if (globalOnly && project) throw new Error("globalOnly cannot be combined with project");
    const native = (project || globalOnly) ? await nativeMemoryTarget(agent, cwd) : null;
    const global = (project || globalOnly) ? await nativeMemoryTarget(agent) : null;
    if ((project || globalOnly) && native && global && native.path === global.path) {
      throw new Error("workspace entrypoint overlaps global memory; choose a project directory");
    }
    if (project && !await projectExists(project)) throw new HubError("project memory not found", 404);
    const state = await loadMemoryInjectState();
    cwd = path.resolve(cwd);
    state.scopes = state.scopes.filter((s) => s.agent !== agent || s.cwd !== cwd);
    if (project || globalOnly) state.scopes.push({ agent, project, cwd });
    else {
      await syncNativeMemory(agent, null, cwd);
      const dest = workspaceMemoryPath(agent, cwd);
      if (isHubGenerated(await readText(dest))) await removeFile(dest);
    }
    await saveMemoryInjectState(state);
    await syncMemoryInjects(undefined, { agent, cwd });
    return workspaceMemoryPath(agent, cwd);
  });
}
