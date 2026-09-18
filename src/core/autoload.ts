import { protectMemoryTarget } from "./delivery-safety.ts";
import { HubError } from "./errors.ts";
import { popularMemoryTarget, type MemoryTarget } from "./popular-memory.ts";
import { attachReference, detachReference, type ReferenceState } from "./config-reference.ts";
import { createHash } from "node:crypto";
import { parse } from "smol-toml";
import path from "node:path";
import { agentHome, adapter, homedir } from "./adapters.ts";
import { hubPaths } from "./config.ts";
import { exists, readText, removeFile, writeText } from "./fsx.ts";
import type { AgentId } from "./types.ts";

type Target = MemoryTarget;
type Entry = { scope?: string; path: string; absent: boolean; preamble?: string; reference?: ReferenceState };
type Manifest = Record<string, Entry[]>;
const manifestPath = () => path.join(hubPaths().memory, "autoload.json");
const keyFor = (agent: AgentId, cwd?: string) => `${agent}:${cwd ? path.resolve(cwd) : "global"}`;
const markers = (agent: AgentId) => [`<!-- agent-hub:${agent}:memory:start -->`, `<!-- agent-hub:${agent}:memory:end -->`] as const;

async function firstNonempty(paths: string[], fallback: string): Promise<string> {
  for (const p of paths) if ((await readText(p))?.trim()) return p;
  return fallback;
}

/** Native entrypoints, verified against vendor docs / installed loader source. */
export async function nativeMemoryTarget(agent: AgentId, cwd?: string): Promise<Target | null> {
  const root = cwd || agentHome(agent);
  switch (agent) {
    case "cursor": return {
      path: cwd
        ? path.join(cwd, ".cursor/rules/hub-generated-memory.mdc")
        : path.join(agentHome("cursor"), "rules", "hub-generated.mdc"),
      preamble: "---\ndescription: Agent Hub read-only memory. Do not edit.\nalwaysApply: true\n---\n\n",
    };
    case "hyper": {
      if (!cwd) return null;
      const raw = await readText(path.join(agentHome(agent), "config.toml"));
      const context = raw ? (parse(raw).context as { agents_md_max_tokens?: number } | undefined) : undefined;
      const budget = context?.agents_md_max_tokens ?? 400;
      if (!Number.isInteger(budget) || budget <= 0) throw new Error("invalid Hyper agents_md_max_tokens");
      // UTF-8 bytes are a conservative upper bound on byte-BPE token count.
      // Fail visibly rather than letting Hyper silently omit the entire AGENTS.md.
      return { path: path.join(cwd, "AGENTS.md"), maxBytes: budget };
    }
    case "grok": return { path: path.join(root, cwd ? ".grok/rules/hub-memory.md" : "rules/hub-memory.md") };
    case "claude": return { path: path.join(root, cwd ? ".claude/rules/hub-memory.md" : "rules/hub-memory.md") };
    case "codex": return { path: await firstNonempty([path.join(root, "AGENTS.override.md")], path.join(root, "AGENTS.md")) };
    case "workbuddy": return { path: path.join(root, ...(cwd ? [process.env.WORKBUDDY_DATA_FOLDER_NAME || ".workbuddy", "memory", "MEMORY.md"] : ["MEMORY.md"])), limit: cwd ? 8000 : 4000 };
    case "hermes": {
      if (!cwd) return { path: path.join(root, "memories/MEMORY.md"), limit: 2200 };
      const dest = await firstNonempty([".hermes.md", "HERMES.md", "AGENTS.md"].map(p => path.join(cwd, p)), path.join(cwd, "AGENTS.md"));
      if (!await exists(dest) && (await exists(path.join(cwd, "CLAUDE.md")) || await exists(path.join(cwd, ".cursorrules")))) throw new HubError(`Hermes 当前使用其他客户端规则回退；请先整理到 ${dest} 后重试，Hub 不修改跨客户端规则。`, 409);
      return { path: dest };
    }
    default: return popularMemoryTarget(agent, cwd);
  }
}

function withoutBlock(text: string, agent: AgentId): string {
  const [start, end] = markers(agent);
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 && b < 0) return text;
  if (a < 0 || b < a || text.indexOf(start, a + start.length) >= 0 || text.indexOf(end, b + end.length) >= 0) {
    throw new Error("Hub memory 区块标记损坏，请修复后重试；未覆盖用户内容");
  }
  let tail = b + end.length;
  if (text.slice(tail, tail + 2) === "\n\n") tail += 2;
  return text.slice(0, a) + text.slice(tail);
}

async function loadManifest(): Promise<Manifest> {
  return JSON.parse((await readText(manifestPath())) || "{}");
}

async function detach(entry: Entry, agent: AgentId): Promise<void> {
  if (entry.reference) await detachReference(entry.reference);
  const current = await readText(entry.path);
  if (current === null) return;
  const stripped = withoutBlock(current, agent);
  if (stripped === current) return;
  if (entry.absent && (stripped === "" || stripped === entry.preamble)) await removeFile(entry.path);
  else await writeText(entry.path, stripped);
}

/** Called inside the delivery transaction. Only our bounded block is changed. */
export async function syncNativeMemory(agent: AgentId, body: string | null, cwd?: string, project?: string): Promise<void> {
  const state = await loadManifest();
  const key = keyFor(agent, cwd);
  const prior = state[key] || [];
  const target = body === null ? null : await nativeMemoryTarget(agent, cwd);
  // Cursor workspace projection is already a native .mdc file owned by deliver.ts.
  if (agent === "cursor") return;
  for (const entry of prior) if (entry.path !== target?.path) await detach(entry, agent);
  if (!target || body === null) delete state[key];
  else {
    await protectMemoryTarget(target.path, cwd);
    if (target.reference) await protectMemoryTarget(target.reference.path, cwd);
    for (const [otherKey, entries] of Object.entries(state)) {
      if (otherKey === key) continue;
      if (entries.some(entry => path.resolve(entry.path) === path.resolve(target.path))) {
        const other = otherKey.split(":")[0] as AgentId;
        const text = await readText(target.path) || "";
        const [a, b] = markers(other);
        const block = text.split(a + "\n# Hub Memory (read-only; edit in Agent Hub)\n\n")[1]?.split("\n" + b)[0];
        if (!entries.filter(entry => path.resolve(entry.path) === path.resolve(target.path)).every(entry => entry.scope === (project || "global") || (entry.scope === undefined && block === body.trim()))) throw new HubError("共享原生入口已有不同记忆作用域；请使用客户端专属入口或统一作用域", 409);
      }
    }
    const [start, end] = markers(agent);
    if (body.includes("<!-- agent-hub:")) throw new Error("memory contains reserved Hub block markers");
    const current = await readText(target.path);
    const tracked = prior.find(e => e.path === target.path);
    if (!tracked && (current?.includes(start) || current?.includes(end))) throw new Error("untracked Hub memory block; refusing to overwrite");
    let remaining = withoutBlock(current || "", agent);
    if (target.preamble) {
      if (remaining.startsWith(target.preamble)) remaining = remaining.slice(target.preamble.length);
      else if (current !== null) throw new Error("existing rule frontmatter differs; refusing to change its activation mode");
    }
    const next = `${target.preamble || ""}${start}\n# Hub Memory (read-only; edit in Agent Hub)\n\n${body.trim()}\n${end}\n\n${remaining}`;
    if (target.limit && next.length > target.limit) throw new Error(`${agent} 自动加载入口上限 ${target.limit} 字符（含原有内容），本次 ${next.length}；请缩短全局记忆或使用工作区记忆`);
    if (target.maxBytes && Buffer.byteLength(next) > target.maxBytes) throw new Error(`Hyper AGENTS.md 超过保守加载预算 ${target.maxBytes} UTF-8 字节；请精简或提高原生 context.agents_md_max_tokens，避免整份被忽略`);
    if (!tracked && current !== null) {
      const hash = createHash("sha256").update(target.path).digest("hex").slice(0, 16);
      await writeText(path.join(hubPaths().backups, "autoload", agent, `${hash}-${Date.now()}.md`), current);
    }
    if (next !== current) await writeText(target.path, next);
    if (tracked?.reference && (tracked.reference.path !== target.reference?.path)) await detachReference(tracked.reference);
    const reference = target.reference ? await attachReference(target.reference, target.path, tracked?.reference?.path === target.reference.path ? tracked.reference : undefined) : undefined;
    state[key] = [{ scope: project || "global", path: target.path, absent: tracked?.absent ?? current === null, preamble: target.preamble, reference }];
  }
  if (prior.length || target) await writeText(manifestPath(), JSON.stringify(state, null, 2));
}

export async function memoryLoadingInfo(agent: AgentId): Promise<{ mode: "global" | "workspace" | "manual"; paths: string[]; note: string }> {
  if (adapter(agent).manualMemory) {
    const file = adapter(agent).memoryInjectPath(homedir());
    const paths = await exists(file) ? [file] : [];
    const scopes = JSON.parse((await readText(path.join(hubPaths().memory, "inject-state.json"))) || "{}").scopes || [];
    for (const scope of scopes) if (scope.agent === agent) {
      const exported = path.join(scope.cwd, ".agent-hub", `hub-generated-memory-${agent}.md`);
      if (await exists(exported)) paths.push(exported);
    }
    return { mode: "manual", paths, note: "Manual memory export; import the file into the client. No verified native autoload entrypoint." };
  }
  let target: Target | null;
  try { target = await nativeMemoryTarget(agent); }
  catch (error) { return { mode: "global", paths: [], note: `原生配置需要处理：${(error as Error).message}` }; }
  const state = await loadManifest();
  const paths: string[] = [];
  for (const [key, entries] of Object.entries(state)) {
    if (!key.startsWith(`${agent}:`)) continue;
    for (const entry of entries) if (await exists(entry.path)) paths.push(entry.path);
  }
  if (agent === "cursor") {
    const scopes = JSON.parse((await readText(path.join(hubPaths().memory, "inject-state.json"))) || "{}").scopes || [];
    for (const scope of scopes) if (scope.agent === agent) {
      const dest = path.join(scope.cwd, ".cursor/rules/hub-generated-memory.mdc");
      if (await exists(dest)) paths.push(dest);
    }
  }
  const scopes = JSON.parse((await readText(path.join(hubPaths().memory, "inject-state.json"))) || "{}").scopes || [];
  const unavailable: string[] = [];
  for (const scope of scopes) if (scope.agent === agent && !(await exists(scope.cwd))) unavailable.push(scope.cwd);
  return {
    mode: target ? "global" : "workspace", paths,
    note: (unavailable.length ? `工作区不可用，已跳过投递（可注销）：${unavailable.join("、")}。` : "") + "Own 仅停止 Hub 投递，不隔离客户端读取；共享 AGENTS.md 等入口可能被其他客户端读取。" + (agent === "cline" ? "为避免 Documents/iCloud 同步，Hub 仅向明确登记的本地工作区 .clinerules 投递；请在 Memory 页登记工作区。"
      : agent === "openclaw" ? "需登记 OpenClaw 实际 agent workspace，加载 MEMORY.md；群聊、子代理及 bootstrap 预算由客户端决定。"
      : target
      ? `原生入口：${target.path}。新会话加载；尚不代表运行时已验收。${agent === "workbuddy" ? "需启用本地记忆。" : ""}`
      : "需在 Memory 页登记工作区，写入该项目的自动加载规则；仅写全局副本不会生效。"),
  };
}
