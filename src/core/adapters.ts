import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { hubPaths } from "./config.ts";
import type { AgentId } from "./types.ts";

export type Adapter = {
  id: AgentId;
  memoryOnly?: boolean;
  manualMemory?: boolean;
  compatibilityNote?: string;
  command?: string;
  label: string;
  identityPath: (home: string) => string;
  soulPath?: (home: string) => string;
  subagentDir?: (home: string) => string;
  skillDir: (home: string) => string;
  vendorSkillDirs: (home: string) => string[];
  nativeMemoryDirs?: (home: string) => string[];
  userMdProjection?: (home: string) => string;
  memoryInjectPath: (home: string) => string;
  vaultCatalogPath: (home: string) => string;
  sessionRoot?: (home: string) => string;
  presentMarker: (home: string) => string;
};

export function resolveUserPath(raw: string, home: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/")) return path.join(home, trimmed.slice(2));
  return path.resolve(trimmed);
}

export function hyperConfiguredSkillDir(home: string): string | null {
  const file = path.join(home, ".grok-hyper", "config.toml");
  try {
    const parsed = parse(fsSync.readFileSync(file, "utf8")) as Record<string, unknown>;
    const skills = parsed.skills;
    if (skills && typeof skills === "object") {
      const row = skills as { dir?: unknown; path?: unknown };
      const dir = typeof row.dir === "string" ? row.dir : typeof row.path === "string" ? row.path : null;
      if (dir?.trim()) return resolveUserPath(dir, home);
    }
    if (typeof parsed.skills_dir === "string" && parsed.skills_dir.trim()) {
      return resolveUserPath(parsed.skills_dir, home);
    }
  } catch {
    // missing or unreadable hyper config: use the default mount
  }
  return null;
}

function homeJoin(home: string, ...parts: string[]): string {
  return path.join(home, ...parts);
}

/** Resolve the same profile root as the native runtime; never create an absent profile. */
export function agentHome(id: AgentId, home = homedir()): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  if (id === "opencode" || id === "goose" || id === "kilo") return path.join(xdg, id);
  const roots: Partial<Record<AgentId, [string, string]>> = {
    grok: ["GROK_HOME", ".grok"], cursor: ["", ".cursor"],
    codex: ["CODEX_HOME", ".codex"], hyper: ["", ".grok-hyper"],
    workbuddy: ["WORKBUDDY_CONFIG_DIR", process.env.WORKBUDDY_DATA_FOLDER_NAME || ".workbuddy"],
    hermes: ["HERMES_HOME", ".hermes"], claude: ["CLAUDE_CONFIG_DIR", ".claude"],
    gemini: ["", ".gemini"], qwen: ["", ".qwen"],
    cline: ["", "Documents/Cline"], roo: ["", ".roo"],
    windsurf: ["", ".codeium/windsurf"], copilot: ["", ".copilot"],
    pi: ["PI_CODING_AGENT_DIR", ".pi/agent"], openclaw: ["OPENCLAW_STATE_DIR", ".openclaw"],
    aider: ["", ".aider"],
    zcode: ["", ".zcode"], grokbot: ["", ".grokbot"],
    doubao: ["", "Doubao"], kimi: ["KIMI_CODE_HOME", ".kimi-code"],
  };
  const [env, fallback] = roots[id]!;
  return env && process.env[env]?.trim() ? resolveUserPath(process.env[env]!, home) : path.join(home, fallback);
}

/** Skill directories named in Hermes's sync manifest. Missing or unreadable manifests yield none. */
export function hermesBundledSkillDirs(home = homedir()): string[] {
  const root = path.join(agentHome("hermes", home), "skills");
  let text = "";
  try {
    text = fsSync.readFileSync(path.join(root, ".bundled_manifest"), "utf8");
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const name = line.split(":")[0]?.trim() ?? "";
    if (name && name === path.basename(name) && !name.startsWith(".")) names.add(name);
  }
  if (!names.size) return [];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fsSync.Dirent[] = [];
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (names.has(entry.name)) {
        try {
          if (fsSync.statSync(path.join(full, "SKILL.md")).isFile()) out.push(full);
        } catch { /* category directory, not a skill */ }
      }
      if (depth < 4) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export const ADAPTERS: Adapter[] = [
  {
    id: "grok",
    label: "Grok CLI",
    identityPath: (h) => homeJoin(agentHome("grok", h), "IDENTITY.md"),
    subagentDir: (h) => homeJoin(agentHome("grok", h), "agents"),
    skillDir: (h) => homeJoin(agentHome("grok", h), "skills"),
    vendorSkillDirs: (h) => [homeJoin(agentHome("grok", h), "bundled", "skills")],
    nativeMemoryDirs: (h) => [homeJoin(agentHome("grok", h), "memory")],
    userMdProjection: (h) => homeJoin(agentHome("grok", h), "USER.md"),
    memoryInjectPath: (h) => homeJoin(agentHome("grok", h), "memory", "hub-generated.md"),
    vaultCatalogPath: (h) => homeJoin(agentHome("grok", h), "memory", "hub-generated-vault.md"),
    sessionRoot: (h) => homeJoin(agentHome("grok", h), "sessions"),
    presentMarker: (h) => agentHome("grok", h),
  },
  {
    id: "cursor",
    label: "Cursor",
    identityPath: (h) => homeJoin(agentHome("cursor", h), "IDENTITY.md"),
    skillDir: (h) => homeJoin(agentHome("cursor", h), "skills"),
    vendorSkillDirs: (h) => [homeJoin(agentHome("cursor", h), "skills-cursor")],
    nativeMemoryDirs: () => [],
    userMdProjection: (h) => homeJoin(agentHome("cursor", h), "rules", "hub-generated-user.mdc"),
    memoryInjectPath: (h) => homeJoin(agentHome("cursor", h), "rules", "hub-generated.mdc"),
    vaultCatalogPath: (h) => homeJoin(agentHome("cursor", h), "rules", "hub-generated-vault.mdc"),
    sessionRoot: (h) => homeJoin(agentHome("cursor", h), "projects"),
    presentMarker: (h) => agentHome("cursor", h),
  },
  {
    id: "codex",
    label: "Codex",
    identityPath: (h) => homeJoin(agentHome("codex", h), "IDENTITY.md"),
    skillDir: (h) => homeJoin(agentHome("codex", h), "skills"),
    vendorSkillDirs: (h) => [
      homeJoin(agentHome("codex", h), "skills", ".system"),
      homeJoin(agentHome("codex", h), "vendor_imports"),
      homeJoin(agentHome("codex", h), "plugins"),
    ],
    nativeMemoryDirs: (h) => [homeJoin(agentHome("codex", h), "memory")],
    userMdProjection: (h) => homeJoin(agentHome("codex", h), "USER.md"),
    memoryInjectPath: (h) => homeJoin(agentHome("codex", h), "memory", "hub-generated.md"),
    vaultCatalogPath: (h) => homeJoin(agentHome("codex", h), "memory", "hub-generated-vault.md"),
    sessionRoot: (h) => homeJoin(agentHome("codex", h), "sessions"),
    presentMarker: (h) => agentHome("codex", h),
  },
  {
    id: "hyper",
    label: "grok-hyper",
    identityPath: (h) => homeJoin(agentHome("hyper", h), "AGENT.md"),
    skillDir: (h) => hyperConfiguredSkillDir(h) ?? homeJoin(agentHome("hyper", h), "skills"),
    vendorSkillDirs: () => [],
    nativeMemoryDirs: (h) => [homeJoin(agentHome("hyper", h), "memory")],
    userMdProjection: (h) => homeJoin(agentHome("hyper", h), "USER.md"),
    memoryInjectPath: (h) => homeJoin(agentHome("hyper", h), "memory", "hub-generated.md"),
    vaultCatalogPath: (h) => homeJoin(agentHome("hyper", h), "memory", "hub-generated-vault.md"),
    sessionRoot: (h) => homeJoin(agentHome("hyper", h), "sessions"),
    presentMarker: (h) => agentHome("hyper", h),
  },
  {
    id: "workbuddy",
    label: "WorkBuddy",
    identityPath: (h) => homeJoin(agentHome("workbuddy", h), "IDENTITY.md"),
    soulPath: (h) => homeJoin(agentHome("workbuddy", h), "SOUL.md"),
    skillDir: (h) => homeJoin(agentHome("workbuddy", h), "skills"),
    vendorSkillDirs: () => [],
    nativeMemoryDirs: (h) => [homeJoin(agentHome("workbuddy", h), "memory")],
    userMdProjection: (h) => homeJoin(agentHome("workbuddy", h), "USER.md"),
    memoryInjectPath: (h) => homeJoin(agentHome("workbuddy", h), "memory", "hub-generated.md"),
    vaultCatalogPath: (h) => homeJoin(agentHome("workbuddy", h), "memory", "hub-generated-vault.md"),
    presentMarker: (h) => agentHome("workbuddy", h),
  },
  ...(["hermes", "claude"] as const).map((id): Adapter => ({
    id, label: id === "hermes" ? "Hermes" : "Claude Code",
    identityPath: (h) => path.join(agentHome(id, h), id === "hermes" ? "SOUL.md" : "CLAUDE.md"),
    subagentDir: id === "claude" ? (h) => path.join(agentHome(id, h), "agents") : undefined,
    skillDir: (h) => path.join(agentHome(id, h), "skills"),
    vendorSkillDirs: id === "hermes" ? hermesBundledSkillDirs : () => [],
    nativeMemoryDirs: (h) => [path.join(agentHome(id, h), id === "hermes" ? "memories" : "memory")],
    memoryInjectPath: (h) => path.join(agentHome(id, h), "hub", "memory.md"),
    vaultCatalogPath: (h) => path.join(agentHome(id, h), "hub", "vault.md"),
    sessionRoot: (h) => path.join(agentHome(id, h), id === "hermes" ? "sessions" : "projects"),
    presentMarker: (h) => agentHome(id, h),
  })),
  ...([
    ["opencode", "OpenCode", "opencode"], ["gemini", "Gemini CLI", "gemini"],
    ["cline", "Cline", "cline"], ["roo", "Roo Code（已归档）", ""],
    ["kilo", "Kilo Code", "kilo"], ["windsurf", "Windsurf / Devin Desktop", "windsurf"],
    ["copilot", "GitHub Copilot CLI", "copilot"], ["goose", "Goose", "goose"],
    ["qwen", "Qwen Code", "qwen"], ["pi", "Pi", "pi"],
    ["openclaw", "OpenClaw", "openclaw"], ["aider", "Aider", "aider"],
    ["zcode", "ZCode", "zcode"], ["grokbot", "Grok Bot", ""],
    ["doubao", "Doubao", ""], ["kimi", "Kimi Code", "kimi"],
  ] as const).map(([id, label, command]): Adapter => ({
    id, label, command, memoryOnly: true,
    manualMemory: id === "grokbot" || id === "doubao",
    compatibilityNote: id === "grokbot" || id === "doubao" ? "Manual memory export; import the file into the client. No verified native autoload entrypoint." : "本轮支持 Memory / 原生规则自动加载；其他层未接管。未做本机模型运行验收。" + (id === "roo" ? " 上游仓库已归档，仅保留兼容。" : ""),
    identityPath: (h) => path.join(agentHome(id, h), "IDENTITY.md"),
    skillDir: (h) => path.join(agentHome(id, h), "skills"),
    vendorSkillDirs: () => [],
    memoryInjectPath: (h) => id === "grokbot" || id === "doubao" ? path.join(hubPaths().memory, "exports", `${id}.md`) : id === "cline" ? path.join(h, ".cache/agent-hub/cline/memory.md") : path.join(agentHome(id, h), "hub", "memory.md"),
    vaultCatalogPath: (h) => path.join(agentHome(id, h), "hub", "vault.md"),
    presentMarker: (h) => agentHome(id, h),
  })),
];

export function adapter(id: AgentId): Adapter {
  const found = ADAPTERS.find((item) => item.id === id);
  if (!found) throw new Error(`unknown agent: ${id}`);
  return found;
}

export function homedir(): string {
  return process.env.HOME?.trim() || os.homedir();
}

/** Read-only installation detection; a missing profile alone is not conclusive. */
export function agentInstallationEvidence(id: AgentId, home = homedir()) {
  const runtimeMarkers: string[] = ({
    claude: ["settings.json", ".credentials.json", "projects"], hermes: ["config.yaml", "auth.json", "sessions"],
    grok: ["config.json", "sessions"], cursor: ["projects", "extensions"],
    codex: ["config.toml", "auth.json", "sessions"], hyper: ["config.toml", "sessions"],
    workbuddy: ["config.json", "sessions"],
    zcode: ["v2", "cli"], grokbot: ["settings.json", ".grokbot-data-root-v1"],
    doubao: ["chats"], kimi: ["config.toml", "session_index.jsonl", "sessions"],
  } as Partial<Record<AgentId, string[]>>)[id] ?? ["config.json", "config.yaml", "config.toml", "sessions"];

  const profileEvidence = runtimeMarkers.some(name => fsSync.existsSync(path.join(agentHome(id, home), name)));
  const command = adapterCommand(id);
  const executable = Boolean(command && (process.env.PATH || "").split(path.delimiter).some(dir => {
    try { const file = path.join(dir, command); fsSync.accessSync(file, fsSync.constants.X_OK); return fsSync.statSync(file).isFile(); } catch { return false; }
  }));
  const extension: Partial<Record<AgentId, string>> = { cline: "saoudrizwan.claude-dev-", roo: "rooveterinaryinc.roo-cline-", kilo: "kilocode.kilo-code-", copilot: "github.copilot-" };
  let extensionEvidence = false;
  if (extension[id]) for (const folder of [".vscode/extensions", ".cursor/extensions", ".windsurf/extensions"]) {
    try { if (fsSync.readdirSync(path.join(home, folder)).some(n => n.startsWith(extension[id]!))) extensionEvidence = true; } catch { /* absent editor */ }
  }
  return {
    configDirectory: fsSync.existsSync(agentHome(id, home)),
    profileEvidence: profileEvidence || (id === "aider" && fsSync.existsSync(path.join(home, ".aider.conf.yml"))),
    executable, extensionEvidence,
    login: "unverified" as const, consumption: "unverified" as const,
  };
}

export function isAgentPresent(id: AgentId, home = homedir()): boolean {
  const evidence = agentInstallationEvidence(id, home);
  return evidence.profileEvidence || evidence.executable || evidence.extensionEvidence;
}

const COMMAND_BY_ID: Partial<Record<AgentId, string>> = {
  grok: "grok",
  cursor: "cursor",
  codex: "codex",
  hyper: "grok-hyper",
  claude: "claude",
  hermes: "hermes",
  workbuddy: "workbuddy",
};

/** CLI/binary name used for vault exec, PATH detection, and copy-paste hints. */
export function adapterCommand(id: AgentId): string {
  return adapter(id).command || COMMAND_BY_ID[id] || id;
}

export function supportsSessions(id: AgentId): boolean {
  return ["grok", "cursor", "codex", "hyper", "hermes", "claude"].includes(id);
}
export function supportsHandoff(id: AgentId): boolean { return !adapter(id).memoryOnly; }
export function supportsVault(id: AgentId): boolean { return !adapter(id).memoryOnly; }
