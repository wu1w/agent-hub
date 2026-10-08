import path from "node:path";
import { parseDocument } from "yaml";
import { agentHome } from "./adapters.ts";
import { readText } from "./fsx.ts";

// Matches the conservative whole-file cap enforced by nativeMemoryTarget.
export const HERMES_HUB_MEMORY_LIMIT = 2200;

export type MemoryCapacity = {
  agent: "hermes";
  path: string;
  usedChars: number;
  nativeLimit: number;
  deliveryLimit: number;
  effectiveLimit: number;
  remainingChars: number;
  nearLimit: boolean;
};

/** Read-only capacity check. Report both caps; never alter native memory or its config. */
export async function hermesMemoryCapacity(): Promise<MemoryCapacity | null> {
  const root = agentHome("hermes");
  const target = path.join(root, "memories", "MEMORY.md");
  const content = await readText(target);
  if (content === null) return null;
  let nativeLimit = 2200;
  const rawConfig = await readText(path.join(root, "config.yaml"));
  if (rawConfig) {
    const doc = parseDocument(rawConfig);
    // Do not present guessed capacity for a malformed native configuration.
    if (doc.errors.length) return null;
    const raw = doc.toJS()?.memory?.memory_char_limit;
    if (raw !== undefined) {
      const value = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value <= 0) return null;
      nativeLimit = value;
    }
  }
  const effectiveLimit = Math.min(nativeLimit, HERMES_HUB_MEMORY_LIMIT);
  const usedChars = content.length;
  const remainingChars = effectiveLimit - usedChars;
  return {
    agent: "hermes", path: target, usedChars, nativeLimit,
    deliveryLimit: HERMES_HUB_MEMORY_LIMIT, effectiveLimit, remainingChars,
    nearLimit: remainingChars < effectiveLimit * 0.1,
  };
}
