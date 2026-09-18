import { assertSafeWritePath, exists, writeText } from "./fsx.ts";
import { withHubLock } from "./transaction.ts";
import { randomBytes } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { supportsSessions, adapter, homedir, isAgentPresent, hyperConfiguredSkillDir, resolveUserPath } from "./adapters.ts";
import {
  AGENT_IDS,
  CORE_AGENT_IDS,
  isAgentId,
  type AdapterOverride,
  type AgentBind,
  type AgentId,
  type HubConfig,
  type Layer,
} from "./types.ts";

export const DEFAULT_BIND: Record<AgentId, AgentBind> = {
  ...Object.fromEntries(AGENT_IDS.map(id => [id, { skills: "own", ctx: "own", memory: "own", sessions: "own", vault: "off" }])) as Record<AgentId, AgentBind>,
  grok: { skills: "hub", ctx: "own", memory: "own", sessions: "index", vault: "off" },
  cursor: { skills: "hub", ctx: "own", memory: "own", sessions: "index", vault: "off" },
  codex: { skills: "hub", ctx: "own", memory: "own", sessions: "index", vault: "off" },
  hyper: { skills: "hub", ctx: "own", memory: "own", sessions: "index", vault: "off" },
  hermes: { skills: "own", ctx: "own", memory: "own", sessions: "own", vault: "off" },
  claude: { skills: "own", ctx: "own", memory: "own", sessions: "own", vault: "off" },
  workbuddy: { skills: "own", ctx: "own", memory: "own", sessions: "own", vault: "off" },
};

export function initialEnabled(home = homedir()): AgentId[] {
  const detected = new Set(AGENT_IDS.filter((id) => isAgentPresent(id, home)));
  return AGENT_IDS.filter((id) => CORE_AGENT_IDS.includes(id) || detected.has(id));
}

export function defaultConfig(): HubConfig {
  return {
    schema_version: 5,
    agents: { enabled: initialEnabled() },
    layers: {
      skills: { default_targets: ["*"] },
      ctx: { project_agents_md: "in-repo", global_targets: ["hyper", "workbuddy", "grok"] },
      memory: { write: "hub-only" },
      sessions: { index: ["grok", "cursor", "codex", "hyper"], store_transcripts: false },
      vault: { default: "off" },
    },
    bind: structuredClone(DEFAULT_BIND),
    adapters: {},
  };
}

function pointerConfigPath(): string {
  return path.join(homedir(), ".agent-hub", "config.toml");
}

function rootFromPointerFile(): string | null {
  try {
    const text = fsSync.readFileSync(pointerConfigPath(), "utf8");
    const parsed = parse(text) as Record<string, unknown>;
    if (typeof parsed.root === "string" && parsed.root.trim()) {
      return resolveUserPath(parsed.root, homedir());
    }
  } catch {
    // missing pointer config is the default layout
  }
  return null;
}

export function hubRoot(): string {
  const override = process.env.AGENT_HUB_ROOT?.trim();
  if (override) return path.resolve(override);
  return rootFromPointerFile() ?? path.join(homedir(), ".agent-hub");
}

let cachedAdapters: NonNullable<HubConfig["adapters"]> = {};

export function resolvedSkillDir(id: AgentId, home = homedir(), config?: HubConfig): string {
  const over = (config?.adapters ?? cachedAdapters)[id]?.skill_dir?.trim();
  if (over) return resolveUserPath(over, home);
  if (id === "hyper") return hyperConfiguredSkillDir(home) ?? adapter(id).skillDir(home);
  return adapter(id).skillDir(home);
}

export function hubPaths(root = hubRoot()) {
  return {
    root,
    config: path.join(root, "config.toml"),
    skills: path.join(root, "skills"),
    ctx: path.join(root, "ctx"),
    userMd: path.join(root, "ctx", "USER.md"),
    memory: path.join(root, "memory"),
    memoryGlobal: path.join(root, "memory", "global.md"),
    memoryProjects: path.join(root, "memory", "projects"),
    sessions: path.join(root, "sessions"),
    sessionIndex: path.join(root, "sessions", "index.sqlite"),
    handoff: path.join(root, "sessions", "handoff"),
    vault: path.join(root, "vault"),
    vaultBin: path.join(root, "vault", "vault.bin"),
    token: path.join(root, "session.token"),
    backups: path.join(root, "backups"),
  };
}

export function syncPathWarning(root: string): string | null {
  if (/(^|\/)(desktop|documents|dropbox|onedrive)(\/|$)|library\/(mobile documents|cloudstorage)|icloud/i.test(root)) {
    return `Agent Hub 数据目录疑似同步路径，密文和索引可能被云盘同步或改写：${root}。建议将 Hub 数据目录迁至非同步的本地目录。`;
  }
  return null;
}

function warnSyncPath(root: string): void {
  const warning = syncPathWarning(root);
  if (warning) console.warn(warning);
}

export async function ensureSessionToken(): Promise<string> {
  return withHubLock(async () => {
    const file = hubPaths().token;
    await assertSafeWritePath(file);
    try {
      const current = (await fs.readFile(file, "utf8")).trim();
      if (current.length >= 32) { await fs.chmod(file, 0o600); return current; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const token = randomBytes(32).toString("hex");
    await writeText(file, token);
    await fs.chmod(file, 0o600);
    return token;
  });
}

const USER_MD_SEED = `# USER.md

这份文件描述使用者，不是某个 Agent 的人设。Identity 在 Agents 页各自编辑。
`;

const GLOBAL_MEMORY_SEED = `# Memory

跨项目长期记忆。只在 Hub 改这一份。
`;

export async function ensureHub(): Promise<void> {
  return withHubLock(async () => {
    const p = hubPaths();
    warnSyncPath(p.root);
    await fs.mkdir(p.skills, { recursive: true });
    await fs.mkdir(p.ctx, { recursive: true });
    await fs.mkdir(p.memoryProjects, { recursive: true });
    await fs.mkdir(p.handoff, { recursive: true });
    await fs.mkdir(p.vault, { recursive: true, mode: 0o700 });
    await fs.mkdir(p.backups, { recursive: true });
    try {
      await fs.chmod(p.vault, 0o700);
    } catch {
      // ignore if the volume does not support chmod
    }
    try {
      await fs.writeFile(path.join(p.vault, ".gitignore"), "*\n", { flag: "wx", encoding: "utf8" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    await ensureSessionToken();
    if (!(await exists(p.config))) await writeText(p.config, stringify(defaultConfig()));
    if (!(await exists(p.userMd))) await writeText(p.userMd, USER_MD_SEED);
    if (!(await exists(p.memoryGlobal))) await writeText(p.memoryGlobal, GLOBAL_MEMORY_SEED);
  });
}

function asAgentId(value: unknown): AgentId | null {
  return isAgentId(value) ? value : null;
}

function mergeBind(id: AgentId, raw: unknown): AgentBind {
  const base = { ...DEFAULT_BIND[id] };
  if (!raw || typeof raw !== "object") return base;
  const obj = raw as Record<string, unknown>;
  if (obj.skills === "hub" || obj.skills === "own") base.skills = obj.skills;
  if (obj.ctx === "hub" || obj.ctx === "own") base.ctx = obj.ctx;
  if (obj.memory === "hub" || obj.memory === "own") base.memory = obj.memory;
  if (obj.sessions === "own" || obj.sessions === "index") base.sessions = obj.sessions;
  if (obj.vault === "off" || obj.vault === "own" || obj.vault === "hub") base.vault = obj.vault;
  if (!supportsSessions(id) && base.sessions !== "own") throw new Error(`config.toml: ${id} 不支持 Sessions=index`);
  if (adapter(id).memoryOnly && (base.skills !== "own" || base.ctx !== "own" || base.vault !== "off")) throw new Error(`config.toml: ${id} 仅支持 Memory`);
  return base;
}

export async function loadConfig(): Promise<HubConfig> {
  await ensureHub();
  const p = hubPaths();
  const text = await fs.readFile(p.config, "utf8");
  const parsed = parse(text) as Record<string, unknown>;
  const defaults = defaultConfig();
  const agentsSection = parsed.agents as { enabled?: unknown } | undefined;
  const enabledRaw = agentsSection?.enabled;
  const enabled: AgentId[] = [];
  if (!agentsSection || !Object.prototype.hasOwnProperty.call(agentsSection, "enabled") || enabledRaw == null) {
    enabled.push(...initialEnabled());
  } else if (Array.isArray(enabledRaw)) {
    for (const item of enabledRaw) {
      const id = asAgentId(item);
      if (id) enabled.push(id);
    }
  }

  const bindRaw = (parsed.bind as Record<string, unknown> | undefined) ?? {};
  const bind = { ...DEFAULT_BIND };
  for (const id of AGENT_IDS) {
    bind[id] = mergeBind(id, bindRaw[id]);
  }

  const adapters = mergeAdapters(parsed.adapters);
  cachedAdapters = adapters;

  const loaded: HubConfig = {
    schema_version: 5,
    agents: { enabled },
    layers: mergeLayers(parsed.layers, defaults.layers),
    bind,
    adapters,
  };
  if (typeof parsed.root === "string" && parsed.root.trim()) loaded.root = parsed.root.trim();
  return loaded;
}

function mergeAdapters(raw: unknown): NonNullable<HubConfig["adapters"]> {
  const out: NonNullable<HubConfig["adapters"]> = {};
  if (!raw || typeof raw !== "object") return out;
  const obj = raw as Record<string, unknown>;
  for (const id of AGENT_IDS) {
    const row = obj[id];
    if (!row || typeof row !== "object") continue;
    const skill_dir = (row as AdapterOverride).skill_dir;
    if (typeof skill_dir === "string" && skill_dir.trim()) {
      out[id] = { skill_dir: skill_dir.trim() };
    }
  }
  return out;
}

function mergeLayers(raw: unknown, defaults: HubConfig["layers"]): HubConfig["layers"] {
  const layers: HubConfig["layers"] = {
    skills: { default_targets: [...defaults.skills.default_targets] },
    ctx: { project_agents_md: "in-repo", global_targets: [...defaults.ctx.global_targets] },
    memory: { write: "hub-only" },
    sessions: { index: [...defaults.sessions.index], store_transcripts: false },
    vault: { default: defaults.vault.default },
  };
  if (!raw || typeof raw !== "object") return layers;
  const obj = raw as Record<string, unknown>;
  const skills = obj.skills as { default_targets?: unknown } | undefined;
  if (Array.isArray(skills?.default_targets) && skills.default_targets.every((item) => typeof item === "string")) {
    layers.skills.default_targets = skills.default_targets as string[];
  }
  const ctx = obj.ctx as { global_targets?: unknown } | undefined;
  if (Array.isArray(ctx?.global_targets)) {
    const ids = ctx.global_targets.filter(isAgentId);
    layers.ctx.global_targets = ids;
  }
  const sessions = obj.sessions as { index?: unknown } | undefined;
  if (Array.isArray(sessions?.index)) {
    const ids = sessions.index.filter(isAgentId);
    layers.sessions.index = ids;
  }
  return layers;
}

export async function saveConfig(config: HubConfig): Promise<void> {
  return withHubLock(async () => {
    await ensureHub();
    const p = hubPaths();
    for (const id of AGENT_IDS) mergeBind(id, config.bind[id]);
    await writeText(p.config, stringify(config));
  });
}

export async function setBind(
  agent: AgentId,
  layer: Layer,
  value: string,
): Promise<HubConfig> {
  return withHubLock(async () => {
    if (!isAgentId(agent)) throw new Error(`unknown agent: ${agent}`);
    if (layer === "sessions" && value === "index" && !supportsSessions(agent)) throw new Error(`${agent} 不支持 Sessions=index`);
    if (adapter(agent).memoryOnly && ((layer === "skills" || layer === "ctx") && value !== "own" || layer === "vault" && value !== "off")) throw new Error(`${agent} 仅支持 Memory`);
    const config = await loadConfig();
    const bind = { ...config.bind[agent] };
    if (layer === "skills" && (value === "hub" || value === "own")) bind.skills = value;
    else if (layer === "ctx" && (value === "hub" || value === "own")) bind.ctx = value;
    else if (layer === "memory" && (value === "hub" || value === "own")) bind.memory = value;
    else if (layer === "sessions" && (value === "own" || value === "index")) bind.sessions = value;
    else if (layer === "vault" && (value === "off" || value === "own" || value === "hub")) {
      bind.vault = value;
    } else {
      throw new Error(`invalid bind ${agent}.${layer}=${value}`);
    }
    config.bind[agent] = bind;
    if (!config.agents.enabled.includes(agent)) {
      config.agents.enabled = AGENT_IDS.filter((id) => id === agent || config.agents.enabled.includes(id));
    }
    await saveConfig(config);
    return config;
  });
}

export async function setAgentEnabled(agent: AgentId, enabled: boolean): Promise<HubConfig> {
  return withHubLock(async () => {
    if (!isAgentId(agent)) throw new Error(`unknown agent: ${agent}`);
    const config = await loadConfig();
    const set = new Set(config.agents.enabled);
    if (enabled) set.add(agent);
    else set.delete(agent);
    config.agents.enabled = AGENT_IDS.filter((id) => set.has(id));
    await saveConfig(config);
    return config;
  });
}
