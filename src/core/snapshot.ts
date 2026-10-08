import { backgroundSyncStatus } from "./runtime-status.ts";
import { hermesMemoryCapacity, type MemoryCapacity } from "./memory-capacity.ts";
import { memoryLoadingInfo } from "./autoload.ts";
import { identityNativeTarget } from "./identity-native.ts";
import { diskEpoch } from "./watch.ts";
import { withHubLock } from "./transaction.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createSnapshotReadCache } from "./snapshot-cache.ts";
import { supportsSessions, supportsHandoff, supportsVault, agentInstallationEvidence, adapter, adapterCommand, homedir, isAgentPresent } from "./adapters.ts";
import { syncPathWarning, ensureHub, hubPaths, loadConfig, resolvedSkillDir } from "./config.ts";
import { readText } from "./fsx.ts";
import { memorySnapshot, scanNativeMemory } from "./memory.ts";
import { sessionStats } from "./sessions.ts";
import { brokenRows, conflictRows, listHubSkills, scanUserSkills, scanVendorSkills, skillRecords } from "./skills.ts";
import { catalogItems, loadVault } from "./vault.ts";
import type { AgentSnapshot, HubConfig, MemoryProject, SkillRecord, VaultCatalogItem, VendorSkill } from "./types.ts";
import { AGENT_IDS } from "./types.ts";

async function listSubagents(agentId: AgentSnapshot["id"]): Promise<AgentSnapshot["subagents"]> {
  const ad = adapter(agentId);
  const dir = ad.subagentDir?.(homedir());
  if (!dir) return [];
  try {
    const entries = await fs.readdir(dir);
    const out: AgentSnapshot["subagents"] = [];
    for (const name of entries.filter((item) => item.endsWith(".md"))) {
      const file = path.join(dir, name);
      const md = await readText(file);
      const id = name.replace(/\.md$/, "");
      const named = md?.match(/^name:\s*(.+)$/m)?.[1]?.trim();
      const heading = md?.match(/^#\s+(.+)$/m)?.[1]?.trim();
      out.push({ name: id, path: file, title: named || heading || id });
    }
    return out;
  } catch {
    return [];
  }
}

export async function agentSnapshots(config: HubConfig): Promise<AgentSnapshot[]> {
  const home = homedir();
  const out: AgentSnapshot[] = [];
  for (const id of config.agents.enabled) {
    const ad = adapter(id);
    out.push({
      id: ad.id,
      label: ad.label,
      present: isAgentPresent(id, home),
      installation: agentInstallationEvidence(id, home),
      memoryOnly: ad.memoryOnly,
      manualMemory: ad.manualMemory,
      supportsSessions: supportsSessions(id),
      supportsHandoff: supportsHandoff(id),
      supportsVault: supportsVault(id),
      compatibilityNote: ad.compatibilityNote,
      bind: config.bind[ad.id],
      identityPath: ad.memoryOnly ? "" : ad.identityPath(home),
      identityNative: Boolean(identityNativeTarget(id, home)?.native),
      identityNativePath: identityNativeTarget(id, home)?.path ?? null,
      soulPath: ad.soulPath ? ad.soulPath(home) : null,
      skillDir: resolvedSkillDir(ad.id, home, config),
      vendorSkillDirs: ad.vendorSkillDirs(home),
      userMdProjection: ad.userMdProjection ? ad.userMdProjection(home) : null,
      memoryInjectPath: ad.memoryInjectPath(home),
      memoryLoading: await memoryLoadingInfo(id),
      vaultCatalogPath: ad.vaultCatalogPath(home),
      sessionRoot: ad.sessionRoot ? ad.sessionRoot(home) : null,
      command: adapterCommand(id),
      subagents: await listSubagents(ad.id),
    });
  }
  return out;
}

export type Snapshot = {
  hubRoot: string;
  diskEpoch: number;
  metadataRevision: string;
  sync: ReturnType<typeof backgroundSyncStatus>;
  memoryCapacity: MemoryCapacity | null;
  warnings: string[];
  config: HubConfig;
  agents: AgentSnapshot[];
  catalog: { id: AgentSnapshot["id"]; label: string; present: boolean; enabled: boolean; memoryOnly: boolean }[];
  skillsStatus: "ready" | "unavailable";
  skills: SkillRecord[];
  vendorSkills: VendorSkill[];
  unadopted: { agent: string; name: string; path: string }[];
  userMd: { path: string; content: string };
  memory: { globalPath: string; global: string; projects: MemoryProject[] };
  nativeMemory: { agent: string; name: string; path: string }[];
  sessions: { count: number; indexedAt: number | null; all: number };
  vault: VaultSummary;
  conflicts: { name: string; agent: string; path: string }[];
  broken: { name: string; agent: string; path: string }[];
};

type SnapshotMetadata = Pick<Snapshot, "agents" | "catalog" | "skillsStatus" | "skills" | "vendorSkills" | "unadopted" | "conflicts" | "broken" | "warnings">;

// Polling should not traverse every native/vendor skills tree on every request.
// The TTL also covers external agent locations that are not watched (or were
// missing when watchers started). Sensitive and frequently changing data below
// is deliberately excluded from this cache.
const metadataCache = createSnapshotReadCache<SnapshotMetadata>({
  ttlMs: 60_000,
  cacheable: value => value.skillsStatus === "ready",
});

export function invalidateSnapshotCache(): void { metadataCache.invalidate(); }

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function scanMetadata(config: HubConfig): Promise<SnapshotMetadata> {
  const warnings: string[] = [];
  let skillsStatus: Snapshot["skillsStatus"] = "ready";
  let skills: Snapshot["skills"] = [], vendorSkills: Snapshot["vendorSkills"] = [], unadopted: Snapshot["unadopted"] = [];
  let conflicts: Snapshot["conflicts"] = [], broken: Snapshot["broken"] = [];
  try {
    const mounted = await scanUserSkills(config);
    const hubNames = new Set((await listHubSkills()).map(item => item.name));
    unadopted = mounted.filter(item => !hubNames.has(item.name)).map(item => ({ agent: item.agent, name: item.name, path: item.path }));
    skills = await skillRecords(config, mounted);
    vendorSkills = await scanVendorSkills(config);
    conflicts = await conflictRows(config, skills, mounted);
    broken = await brokenRows(config, skills);
  } catch (error) {
    skillsStatus = "unavailable";
    skills = []; vendorSkills = []; unadopted = []; conflicts = []; broken = [];
    warnings.push(`Skills 状态不可用（不是空库），其他模块仍可使用：${error instanceof Error ? error.message : "扫描失败"}`);
  }
  return {
    warnings,
    agents: await agentSnapshots(config),
    catalog: AGENT_IDS.map((id) => {
      const ad = adapter(id);
      return {
        id,
        label: ad.label,
        present: isAgentPresent(id, homedir()),
        enabled: config.agents.enabled.includes(id),
        memoryOnly: Boolean(ad.memoryOnly),
      };
    }),
    skillsStatus, skills, vendorSkills,
    unadopted,
    conflicts, broken,
  };
}

/** A forced scan for CLI reads and mutation responses. */
export async function buildSnapshot(): Promise<Snapshot> { return readSnapshot(false); }

/** HTTP polling reuses only scan metadata; config and vault are always reread. */
export async function buildCachedSnapshot(): Promise<Snapshot> { return readSnapshot(true); }

async function readSnapshot(cached: boolean): Promise<Snapshot> {
  return withHubLock(async () => {
    await ensureHub();
    // Read before any cache lookup: an external Hub/Own or adapter-path change
    // must take effect even before a watcher fires or the fallback TTL expires.
    const config = await loadConfig();
    const p = hubPaths();
    if (!cached) invalidateSnapshotCache();
    const key = fingerprint({ root: p.root, home: homedir(), config, epoch: diskEpoch() });
    const metadata = await metadataCache.read(key, () => scanMetadata(config));
    const warnings = [syncPathWarning(p.root), ...metadata.warnings].filter((message): message is string => message !== null);
    return {
      ...metadata,
      hubRoot: p.root,
      diskEpoch: diskEpoch(),
      metadataRevision: fingerprint(metadata),
      sync: backgroundSyncStatus(),
      memoryCapacity: config.agents.enabled.includes("hermes") && config.bind.hermes.memory === "hub"
        ? await hermesMemoryCapacity().catch(() => null) : null,
      warnings,
      config,
      userMd: { path: p.userMd, content: (await readText(p.userMd)) ?? "" },
      memory: await memorySnapshot(),
      nativeMemory: await scanNativeMemory(config),
      sessions: (() => {
        const enabled = config.agents.enabled;
        const catalog = sessionStats(enabled.filter((id) => config.bind[id].sessions === "index"));
        return { ...catalog, all: sessionStats(enabled).count };
      })(),
      vault: await vaultSummary(),
    };
  });
}

type VaultSummary = { status: "ready" | "unavailable"; count: number | null; entries: VaultCatalogItem[]; path: string; error: string | null };

export async function vaultSummary(): Promise<VaultSummary> {
  const pathBin = hubPaths().vaultBin;
  try {
    const store = await loadVault();
    const entries = catalogItems(store);
    return { status: "ready", count: entries.length, entries, path: pathBin, error: null };
  } catch {
    return { status: "unavailable", count: null, entries: [], path: pathBin, error: "保险库读取失败，条目数未知。请解锁系统钥匙串，并在 Vault 页重试；若仍失败，请检查主密钥与 vault.bin 是否匹配。" };
  }
}
