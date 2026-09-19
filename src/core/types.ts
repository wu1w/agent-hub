export const AGENT_IDS = ["grok", "cursor", "codex", "hyper", "workbuddy", "hermes", "claude", "opencode", "gemini", "cline", "roo", "kilo", "windsurf", "copilot", "goose", "qwen", "pi", "openclaw", "aider", "zcode", "grokbot", "doubao", "kimi"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const LAYERS = ["skills", "ctx", "memory", "sessions", "vault"] as const;
export type Layer = (typeof LAYERS)[number];

export function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

export function isLayer(value: unknown): value is Layer {
  return typeof value === "string" && (LAYERS as readonly string[]).includes(value);
}

export type SkillsBind = "hub" | "own";
export type CtxBind = "hub" | "own";
export type MemoryBind = "hub" | "own";
export type SessionsBind = "own" | "index";
export type VaultBind = "off" | "own" | "hub";

export type AgentBind = {
  skills: SkillsBind;
  ctx: CtxBind;
  memory: MemoryBind;
  sessions: SessionsBind;
  vault: VaultBind;
};

export type AdapterOverride = {
  skill_dir?: string;
};

export const CORE_AGENT_IDS: AgentId[] = ["grok", "cursor", "codex", "hyper", "workbuddy"];

export type HubConfig = {
  schema_version?: 2 | 3 | 4 | 5;
  root?: string;
  agents: { enabled: AgentId[] };
  layers: {
    skills: { default_targets: string[] };
    ctx: { project_agents_md: "in-repo"; global_targets: AgentId[] };
    memory: { write: "hub-only" };
    sessions: { index: AgentId[]; store_transcripts: false };
    vault: { default: VaultBind };
  };
  bind: Record<AgentId, AgentBind>;
  adapters?: Partial<Record<AgentId, AdapterOverride>>;
};

export type LinkState =
  | "linked"
  | "own"
  | "vendor"
  | "broken"
  | "conflict"
  | "excluded"
  | "missing";

export type SkillRecord = {
  name: string;
  hubPath: string;
  updatedAt: string;
  targets: string[] | null;
  links: Record<AgentId, LinkState>;
};

export type VendorSkill = {
  agent: AgentId;
  name: string;
  path: string;
  updatedAt: string;
};

export type SubagentFile = {
  name: string;
  path: string;
  title: string;
};

export type ProjectSkill = {
  name: string;
  path: string;
  rel: string;
  inHub: boolean;
};

export type AgentSnapshot = {
  id: AgentId;
  label: string;
  present: boolean;
  memoryOnly?: boolean;
  manualMemory?: boolean;
  supportsSessions?: boolean;
  supportsHandoff?: boolean;
  supportsVault?: boolean;
  compatibilityNote?: string;
  bind: AgentBind;
  installation?: { configDirectory: boolean; profileEvidence: boolean; executable: boolean; extensionEvidence: boolean; login: "unverified"; consumption: "unverified" };
  identityPath: string;
  identityNative: boolean;
  identityNativePath: string | null;
  soulPath: string | null;
  skillDir: string;
  vendorSkillDirs: string[];
  userMdProjection: string | null;
  memoryInjectPath: string;
  memoryLoading: { mode: "global" | "workspace" | "manual"; paths: string[]; note: string };
  vaultCatalogPath: string;
  sessionRoot: string | null;
  command: string;
  subagents: SubagentFile[];
};

export type SessionRecord = {
  agent_id: AgentId;
  session_id: string;
  cwd: string;
  title: string;
  summary: string;
  mtime: number;
  source_path: string;
  indexed_at: number;
};

export type MemoryProject = {
  id: string;
  path: string;
  mtime: number;
};

export type HandoffRecord = {
  id: string;
  path: string;
  from: AgentId;
  to: AgentId;
  sessionId: string;
  cwd: string;
  createdAt: string;
};

export type ResumePlan = {
  kind: "grok-resume" | "grok-start" | "codex-resume" | "codex-start" | "cursor-open" | "hyper-start" | "claude-start" | "hermes-start";
  argv: string[];
  cwd: string;
  note: string;
  mcp: { tool: string; args: Record<string, string> } | null;
};

export type AdoptReport = {
  moved: string[];
  linked: string[];
  skipped: { name: string; reason: string }[];
  conflicts: { name: string; paths: string[] }[];
};

export type AdoptMode = "adopt" | "link-existing";
export type DetachMode = "detach-copy" | "unlink";
export type ConflictKeep = "hub" | "agent";

export type VaultField = {
  name: string;
  value: string;
  secret: boolean;
};

export type VaultEntry = {
  id: string;
  fields: VaultField[];
  agents: AgentId[];
  updatedAt: string;
};

export type VaultStore = {
  version: 1;
  entries: VaultEntry[];
};

export type VaultCatalogItem = {
  id: string;
  note: string;
  agents: AgentId[];
};
