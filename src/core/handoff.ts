import { transaction } from "./transaction.ts";
import { supportsHandoff, supportsSessions } from "./adapters.ts";
import { randomUUID } from "node:crypto";
import { memoryScopeFor } from "./deliver.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureHub, hubPaths, loadConfig } from "./config.ts";
import { HubError } from "./errors.ts";
import { assertSafeName, readRegularText, exists, writeText } from "./fsx.ts";
import { requireSecretMaterial, redactOrOmit, redactDerived } from "./secrets.ts";
import { getSession, rebuildIndex } from "./sessions.ts";
import { skillRecords } from "./skills.ts";
import { isAgentId, type AgentId, type HandoffRecord, type ResumePlan } from "./types.ts";

function stampId(from: AgentId, to: AgentId, sessionId: string): string {
  const short = sessionId.replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "session";
  return `${Date.now().toString(36)}-${from}-${to}-${short}-${randomUUID().slice(0, 8)}`;
}

export function resumePlan(input: {
  from: AgentId;
  to: AgentId;
  sessionId: string;
  cwd: string;
  handoffPath: string;
}): ResumePlan {
  if (!supportsHandoff(input.to)) throw new HubError(`${input.to} 尚不支持交接`, 400);
  const cwd = input.cwd || process.cwd();
  const prompt = `Hub 交接。请阅读 ${input.handoffPath}，按其中结论在 ${cwd} 继续，不要重放整场原文。`;
  if (input.to === "grok" && input.from === "grok") {
    return {
      kind: "grok-resume",
      argv: ["grok", "--resume", input.sessionId, "--cwd", cwd, "--prompt-file", input.handoffPath],
      cwd,
      note: "同源 Grok：grok --resume 并读交接条。Cursor 里用 grok_resume，不要 --continue。",
      mcp: {
        tool: "grok_resume",
        args: { session_id: input.sessionId, cwd, prompt },
      },
    };
  }
  if (input.to === "grok") {
    return {
      kind: "grok-start",
      argv: ["grok", "--cwd", cwd, "--prompt-file", input.handoffPath],
      cwd,
      note: "跨 Agent 交给 Grok：新开一场并读交接条。Cursor 用 grok_start。",
      mcp: { tool: "grok_start", args: { cwd, prompt } },
    };
  }
  if (input.to === "codex" && input.from === "codex") {
    return {
      kind: "codex-resume",
      argv: ["codex", "resume", input.sessionId, prompt],
      cwd,
      note: "同源 Codex：codex resume <id>，并把交接条作为续写提示。",
      mcp: null,
    };
  }
  if (input.to === "codex") {
    return {
      kind: "codex-start",
      argv: ["codex", prompt],
      cwd,
      note: "跨 Agent 交给 Codex：在该 cwd 新开并读交接条。不要把 jsonl 拷进 Hub。",
      mcp: null,
    };
  }
  if (input.to === "cursor") {
    return {
      kind: "cursor-open",
      argv: ["cursor", input.cwd || ".", input.handoffPath],
      cwd,
      note: `Open Cursor on ${cwd || "."} and read ${input.handoffPath}. If the cursor CLI is missing: open -a Cursor ${input.handoffPath}`,
      mcp: null,
    };
  }
  if (input.to === "hyper") {
    return {
      kind: "hyper-start",
      argv: ["grok-hyper"],
      cwd,
      note: `Start grok-hyper in ${cwd} and read ${input.handoffPath}.`,
      mcp: null,
    };
  }
  if (input.to === "claude") {
    return {
      kind: "claude-start",
      argv: ["claude"],
      cwd,
      note: `Start Claude Code in ${cwd} and read ${input.handoffPath}.`,
      mcp: null,
    };
  }
  if (input.to === "hermes") {
    return {
      kind: "hermes-start",
      argv: ["hermes"],
      cwd,
      note: `Start Hermes in ${cwd} and read ${input.handoffPath}.`,
      mcp: null,
    };
  }
  throw new HubError(`${input.to} does not support handoff yet`, 400);
}

function renderHandoff(input: {
  id: string;
  from: AgentId;
  to: AgentId;
  sessionId: string;
  cwd: string;
  title: string;
  summary: string;
  sourcePath: string;
  skills: string[];
  resume: ResumePlan;
  createdAt: string;
}): string {
  const skills = input.skills.length ? input.skills.map((name) => `- ${name}`).join("\n") : "- （无）";
  const mcp = input.resume.mcp
    ? `\nMCP：\`${input.resume.mcp.tool}\` ${JSON.stringify(input.resume.mcp.args)}\n`
    : "";
  const cmd = input.resume.argv.length ? `\`${input.resume.argv.map(shellQuote).join(" ")}\`` : "（无命令，见说明）";
  const recap = input.summary && input.summary !== input.title ? `\n\n${input.summary}` : "";
  return `# Handoff ${input.id}

- from: ${input.from}
- to: ${input.to}
- cwd: ${input.cwd || "（未知）"}
- source_session: ${input.sessionId}
- source_path: ${input.sourcePath}
- created: ${input.createdAt}

## 上一场

${input.title || "（无标题）"}${recap}

## 建议 skill

${skills}

## 怎么接着干

${input.resume.note}

命令：${cmd}
${mcp}
原文仍在各家目录，Hub 不搬 jsonl。
`;
}

export async function createHandoff(input: {
  from: AgentId;
  to: AgentId;
  sessionId: string;
  cwd?: string;
  forceOwn?: boolean;
}): Promise<{ record: HandoffRecord; markdown: string; resume: ResumePlan }> {
  if (!isAgentId(input.from) || !isAgentId(input.to)) throw new HubError("invalid agent", 400);
  if (!supportsHandoff(input.to) || !supportsSessions(input.from)) throw new HubError("该 Agent 尚不支持会话交接", 400);
  await ensureHub();
  const config = await loadConfig();
  if (!config.agents.enabled.includes(input.from) || !config.agents.enabled.includes(input.to)) throw new HubError("agent is disabled", 400);
  if (config.bind[input.from].sessions === "own" && !input.forceOwn) {
    throw new HubError(`${input.from} 的 Sessions=own，交接需要显式揭隐（--own / forceOwn）`, 403);
  }
  await rebuildIndex(input.from);
  const session = getSession(input.from, input.sessionId);
  if (!session) throw new Error(`session not in index: ${input.from} ${input.sessionId}`);
  const cwd = input.cwd?.trim() || session.cwd;
  const id = stampId(input.from, input.to, input.sessionId);
  const file = path.join(hubPaths().handoff, `${id}.md`);
  let skills: string[] = [];
  try {
    const records = await skillRecords(config);
    skills = records.filter((item) => item.links[input.to] === "linked").map((item) => item.name);
  } catch {
    skills = [];
  }
  const resume = resumePlan({
    from: input.from,
    to: input.to,
    sessionId: input.sessionId,
    cwd,
    handoffPath: file,
  });
  const createdAt = new Date().toISOString();
  const scopedMemory = await memoryScopeFor(input.to, cwd);
  const memoryPath = scopedMemory && await exists(scopedMemory) ? scopedMemory : null;
  const markdown = renderHandoff({
    id,
    from: input.from,
    to: input.to,
    sessionId: input.sessionId,
    cwd,
    title: await redactDerived(session.title),
    summary: await redactDerived(session.summary ?? ""),
    sourcePath: session.source_path,
    skills,
    resume,
    createdAt,
  });
  const delivered = markdown + (memoryPath ? `\n## 当前工作区记忆\n\n请阅读已生成的工作区记忆 ${memoryPath}，不要读取其他工作区的项目记忆。此交接未重新同步 Memory；如需更新，请先在 Memory 页同步加载入口。\n` : "");
  await writeText(file, delivered);
  return {
    record: {
      id,
      path: file,
      from: input.from,
      to: input.to,
      sessionId: input.sessionId,
      cwd,
      createdAt,
    },
    markdown: delivered,
    resume,
  };
}

export async function listHandoffs(limit = 40): Promise<HandoffRecord[]> {
  await requireSecretMaterial();
  await ensureHub();
  const dir = hubPaths().handoff;
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: HandoffRecord[] = [];
  for (const name of names.sort().reverse()) {
    if (!name.endsWith(".md")) continue;
    const file = path.join(dir, name);
    const text = await readRegularText(file);
    if (!text || !/^# Handoff(?: |\n)/.test(text)) continue;
    const fromRaw = text.match(/^- from: (\w+)/m)?.[1];
    const toRaw = text.match(/^- to: (\w+)/m)?.[1];
    if (!isAgentId(fromRaw) || !isAgentId(toRaw)) continue;
    const from = fromRaw;
    const to = toRaw;
    const sessionId = text.match(/^- source_session: (\S+)/m)?.[1] ?? "";
    const cwd = text.match(/^- cwd: (.+)$/m)?.[1] ?? "";
    const createdAt = text.match(/^- created: (\S+)/m)?.[1] ?? "";
    out.push({
      id: name.replace(/\.md$/, ""),
      path: file,
      from,
      to,
      sessionId,
      cwd: cwd === "（未知）" ? "" : cwd,
      createdAt,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export async function execResume(plan: ResumePlan): Promise<{ code: number | null }> {
  if (plan.argv.length === 0) throw new Error("no resume command");
  const bin = plan.argv[0]!;
  const args = plan.argv.slice(1);
  const cwd = plan.cwd && plan.cwd !== "（未知）" ? plan.cwd : undefined;
  return await new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code }));
  });
}

export function revealArgv(sourcePath: string): string[] {
  return ["open", "-R", sourcePath];
}

export function openEditorArgv(target: string): string[] {
  return ["open", "-t", target];
}

export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

export function terminalScript(plan: ResumePlan): string {
  if (!plan.argv.length) throw new Error("此 Agent 需要在应用中手动读取交接条");
  return `#!/bin/sh
cd ${shellQuote(plan.cwd || process.cwd())} || exit 1
exec ${plan.argv.map(shellQuote).join(" ")}
`;
}

/** Only server-generated handoff plans are launchable; HTTP never accepts shell/argv. */
export async function launchHandoff(id: string, forceOwn = false): Promise<{ status: string }> {
  assertSafeName(id, "handoff id");
  const record = (await listHandoffs(10000)).find((r) => r.id === id);
  if (!record) throw new HubError("handoff not found", 404);
  const config = await loadConfig();
  if (!config.agents.enabled.includes(record.to) || !config.agents.enabled.includes(record.from)) throw new HubError("agent is disabled", 400);
  if (config.bind[record.from].sessions === "own" && !forceOwn) throw new HubError("Sessions=own requires explicit reveal", 403);
  const plan = resumePlan({ ...record, handoffPath: record.path });
  const script = path.join(hubPaths().handoff, `${id}.command`);
  await writeText(script, terminalScript(plan));
  await fs.chmod(script, 0o700);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("open", ["-a", "Terminal", script], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Terminal launch failed: ${code}`)));
  });
  return { status: "terminal-opened" };
}

/** Explicit maintenance only; ordinary indexing never rewrites handoff documents. */
export async function scrubHandoffs(): Promise<{ changed: number }> {
  return transaction(async () => {
    const material = await requireSecretMaterial();
    let changed = 0;
    for (const entry of await fs.readdir(hubPaths().handoff, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const file = path.join(hubPaths().handoff, entry.name);
      const old = await readRegularText(file);
      if (old === null || !old.startsWith("# Handoff ")) continue;
      const clean = redactOrOmit(old, material);
      if (old !== clean) { await writeText(file, clean); changed++; }
    }
    return { changed };
  });
}
