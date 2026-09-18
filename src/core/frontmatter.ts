import { parseDocument, isMap, isSeq, isAlias } from "yaml";
import { HubError } from "./errors.ts";
import { AGENT_IDS, type AgentId } from "./types.ts";

export function extractFrontmatter(markdown: string): { yaml: string; body: string } | null {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return null;
  const rest = markdown.replace(/^---\r?\n/, "");
  const end = rest.search(/\n---\s*(?:\n|$)/);
  if (end < 0) return null;
  const yaml = rest.slice(0, end).replace(/\r/g, "");
  const after = rest.slice(end).replace(/^\n---\s*/, "");
  const body = after.replace(/^\n/, "");
  return { yaml, body };
}

function targetDocument(yaml: string) {
  const doc = parseDocument(yaml);
  if (doc.errors.length) throw new HubError("SKILL.md frontmatter 不是有效 YAML，请修正后重试", 400);
  return doc;
}

function validateTargets(value: unknown): string[] {
  if (!Array.isArray(value) || value.some(v => typeof v !== "string" || (v !== "*" && !AGENT_IDS.includes(v as AgentId)))) {
    throw new HubError("hub.targets 必须是有效 Agent ID 或 * 的数组", 400);
  }
  return [...new Set(value)] as string[];
}

export function parseHubTargets(markdown: string): string[] | null {
  const fm = extractFrontmatter(markdown);
  if (!fm) return null;
  const doc = targetDocument(fm.yaml);
  const value = doc.toJS()?.hub?.targets;
  return value == null ? null : validateTargets(value);
}

export function targetsAllow(targets: string[] | null, agent: AgentId, defaultAll: boolean): boolean {
  if (targets == null) return defaultAll;
  if (targets.includes("*")) return true;
  return targets.includes(agent);
}

export function resolveEffectiveTargets(targets: string[] | null, defaultTargets: string[]): string[] {
  if (targets == null) return defaultTargets;
  return targets;
}

export function skillAllowedFor(targets: string[] | null, agent: AgentId, defaultTargets: string[]): boolean {
  const effective = resolveEffectiveTargets(targets, defaultTargets);
  if (effective.includes("*")) return true;
  return effective.includes(agent);
}

export function setHubTargets(markdown: string, targets: string[] | null): string {
  const fm = extractFrontmatter(markdown);
  const doc = targetDocument(fm?.yaml ?? "name: skill");
  if (!isMap(doc.contents)) throw new HubError("frontmatter 必须是映射", 400);
  if (targets === null) doc.deleteIn(["hub", "targets"]);
  else doc.setIn(["hub", "targets"], validateTargets(targets));
  const result = `---\n${doc.toString()}---\n\n${(fm ? fm.body : markdown).replace(/^\n/, "")}`;
  parseHubTargets(result);
  return result;
}

/** Repair only the invalid bare wildcard emitted by older Hub versions. */
export function repairLegacyHubWildcard(markdown: string): string {
  const fm = extractFrontmatter(markdown);
  if (!fm) return markdown;
  const doc = parseDocument(fm.yaml);
  if (!doc.errors.length) return markdown;
  const targets = doc.getIn(["hub", "targets"], true);
  if (!isSeq(targets)) return markdown;
  const ranges = targets.items.flatMap(item => isAlias(item) && item.source === "" && item.range ? [item.range] : []);
  if (!ranges.length || doc.errors.some(error => error.code !== "BAD_ALIAS" || !ranges.some(range => error.pos[0] >= range[0] && error.pos[0] <= range[1]))) return markdown;
  let yaml = fm.yaml;
  for (const range of ranges.sort((a, b) => b[0] - a[0])) yaml = yaml.slice(0, range[0]) + '"*"' + yaml.slice(range[1]);
  const repaired = `---\n${yaml}\n---\n\n${fm.body}`;
  parseHubTargets(repaired);
  return repaired;
}
