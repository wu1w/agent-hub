import path from "node:path";
import { adapter, agentHome, homedir } from "./adapters.ts";
import { protectMemoryTarget } from "./delivery-safety.ts";
import { readText, writeText } from "./fsx.ts";
import type { AgentId } from "./types.ts";

const CURSOR_PREAMBLE = `---
description: Agent Hub identity. Edit in Agent Hub.
alwaysApply: true
---

`;

export type IdentityNative = {
  path: string;
  native: boolean;
  kind: "file" | "block";
  preamble?: string;
};

export function identityNativeTarget(agent: AgentId, home = homedir()): IdentityNative | null {
  if (adapter(agent).memoryOnly) return null;
  if (agent === "cursor") {
    return { path: path.join(agentHome("cursor", home), "rules", "hub-generated-identity.mdc"), native: false, kind: "file", preamble: CURSOR_PREAMBLE };
  }
  if (agent === "grok") {
    return { path: path.join(agentHome("grok", home), "rules", "hub-identity.md"), native: false, kind: "file" };
  }
  if (agent === "codex") {
    return { path: path.join(agentHome("codex", home), "AGENTS.md"), native: false, kind: "block" };
  }
  return { path: adapter(agent).identityPath(home), native: true, kind: "file" };
}

function markers(agent: AgentId): [string, string] {
  return [`<!-- agent-hub:${agent}:identity:start -->`, `<!-- agent-hub:${agent}:identity:end -->`];
}

function wrapFile(agent: AgentId, content: string, preamble?: string): string {
  return `${preamble ?? ""}<!-- hub-generated: agent-hub-identity -->
<!-- Read-only copy. Edit identity in Agent Hub. -->

# Hub Identity (${agent})

${content.trim()}\n`;
}

function withoutBlock(text: string, agent: AgentId): string {
  const [start, end] = markers(agent);
  const a = text.indexOf(start), b = text.indexOf(end);
  if (a < 0 && b < 0) return text;
  if (a < 0 || b < a || text.indexOf(start, a + start.length) >= 0 || text.indexOf(end, b + end.length) >= 0) {
    throw new Error("Hub identity markers are damaged; fix them and retry. User content was not overwritten.");
  }
  let tail = b + end.length;
  if (text.slice(tail, tail + 2) === "\n\n") tail += 2;
  return text.slice(0, a) + text.slice(tail);
}

export async function syncIdentityNative(agent: AgentId, content: string): Promise<string | null> {
  const target = identityNativeTarget(agent);
  if (!target || target.native) return target?.path ?? null;
  await protectMemoryTarget(target.path);
  if (target.kind === "file") {
    await writeText(target.path, wrapFile(agent, content, target.preamble));
    return target.path;
  }
  const [start, end] = markers(agent);
  const current = (await readText(target.path)) ?? "";
  const remaining = withoutBlock(current, agent);
  const next = `${start}\n# Hub Identity (read-only; edit in Agent Hub)\n\n${content.trim()}\n${end}\n\n${remaining}`;
  if (next !== current) await writeText(target.path, next);
  return target.path;
}
