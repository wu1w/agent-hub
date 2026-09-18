import path from "node:path";
import { parse as parseYaml } from "yaml";
import fs from "node:fs/promises";
import { HubError } from "./errors.ts";
import { agentHome, homedir } from "./adapters.ts";
import { exists, isDir, readText } from "./fsx.ts";
import { parseJsonConfig, type ConfigReference } from "./config-reference.ts";
import type { AgentId } from "./types.ts";

export type MemoryTarget = { path: string; limit?: number; maxBytes?: number; preamble?: string; reference?: ConfigReference };

async function existing(paths: string[], fallback: string): Promise<string> {
  for (const file of paths) if (await exists(file)) return file;
  return fallback;
}
function filename(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value === "." || value === ".." || /[/\\\x00-\x1f]/.test(value)) throw new Error("context filename must be a plain filename; refusing an unsafe path");
  return value;
}
function writableNames(names: string[], agent: string): string[] {
  const own = names.filter(name => !["claude.md", ".cursorrules"].includes(name.toLowerCase()));
  if (!own.length) throw new HubError(`${agent} 配置仅指向 CLAUDE.md / .cursorrules，Hub 不写入其他客户端规则。请在原生配置中添加专用文件名（如 HUB-MEMORY.md）后重试；原有规则可继续只读加载。`, 409);
  return own;
}
async function contextFile(agent: "gemini" | "qwen", cwd?: string): Promise<string> {
  let value: unknown = agent === "gemini" ? "GEMINI.md" : "QWEN.md";
  const settings = [path.join(agentHome(agent), "settings.json")];
  if (cwd) settings.push(path.join(cwd, `.${agent}/settings.json`));
  for (const file of settings) {
    const text = await readText(file);
    if (text === null) continue;
    const config = parseJsonConfig(text);
    const context = config.context as { fileName?: unknown } | undefined;
    if (context?.fileName !== undefined) value = context.fileName;
  }
  const names = (Array.isArray(value) ? value : [value]).map(filename);
  if (!names.length) throw new Error(`${agent} context.fileName disables context files`);
  const root = cwd || agentHome(agent);
  const own = writableNames(names, agent);
  return existing(own.map(n => path.join(root, n)), path.join(root, own[0]!));
}
async function kiloConfig(root: string): Promise<string> {
  const json = path.join(root, "kilo.json"), jsonc = path.join(root, "kilo.jsonc");
  if (await exists(json) && await exists(jsonc)) throw new Error("同时存在 kilo.json 和 kilo.jsonc，请先明确原生配置来源");
  return await exists(json) ? json : jsonc;
}

export async function popularMemoryTarget(agent: AgentId, cwd?: string): Promise<MemoryTarget | null> {
  const root = cwd || agentHome(agent);
  switch (agent) {
    case "zcode": case "kimi": return { path: path.join(root, "AGENTS.md") };
    // These desktop clients have no verified local instruction autoloader.
    case "grokbot": case "doubao": return null;
    case "gemini": case "qwen": return { path: await contextFile(agent, cwd) };
    case "opencode": case "pi": {
      const native = agent === "pi" ? ["AGENTS.override.md", "AGENTS.md"] : ["AGENTS.md"];
      const dest = await existing(native.map(n => path.join(root, n)), path.join(root, "AGENTS.md"));
      const foreign = cwd || agent === "pi" ? path.join(root, "CLAUDE.md") : path.join(homedir(), ".claude/CLAUDE.md");
      if (!await exists(dest) && await exists(foreign)) throw new HubError(`${agent} 当前回退读取 CLAUDE.md；Hub 不会写入它，也不会新建高优先级文件遮蔽它。请先将所需指令整理到 ${dest} 后重试。`, 409);
      return { path: dest };
    }
    case "cline": {
      if (!cwd) return null; // Documents may be iCloud-backed; require an explicit local workspace.
      const file = path.join(cwd, ".clinerules");
      return { path: await exists(file) && !await isDir(file) ? file : path.join(file, "hub-memory.md") };
    }
    case "roo": {
      const legacy = cwd && path.join(cwd, ".roorules");
      // Prefer the native directory; avoid suppressing an existing legacy file.
      return { path: legacy && await exists(legacy) && !(await fs.readdir(path.join(cwd!, ".roo/rules")).catch(() => [])).length ? legacy : path.join(root, cwd ? ".roo/rules/hub-memory.md" : "rules/hub-memory.md") };
    }
    case "kilo": return {
      path: path.join(root, cwd ? ".kilo/rules/hub-memory.md" : "rules/hub-memory.md"),
      reference: { path: await kiloConfig(root), key: "instructions", format: "jsonc" },
    };
    case "windsurf": return cwd ? {
      path: path.join(cwd, await exists(path.join(cwd, ".devin")) ? ".devin/rules/hub-memory.md" : ".windsurf/rules/hub-memory.md"),
      preamble: "---\ntrigger: always_on\n---\n\n", limit: 12000,
    } : { path: path.join(root, "memories/global_rules.md"), limit: 6000 };
    case "copilot": return { path: path.join(root, cwd ? ".github/copilot-instructions.md" : "copilot-instructions.md") };
    case "goose": {
      const configPath = path.join(agentHome("goose"), "config.yaml");
      const text = await readText(configPath);
      let names: unknown;
      try {
        const config = text === null ? {} : parseYaml(text);
        if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("invalid config");
        names = config.CONTEXT_FILE_NAMES ?? [".goosehints", "AGENTS.md"];
        if (!Array.isArray(names) || !names.length) throw new Error("invalid names");
      } catch { throw new HubError(`Goose ${configPath} 的 CONTEXT_FILE_NAMES 必须是文件名数组，请检查原生配置。`, 400); }
      const safe = writableNames((names as unknown[]).map(filename), "Goose");
      const preferred = safe.includes(".goosehints") ? ".goosehints" : safe[0]!;
      return { path: path.join(root, preferred) };
    }
    case "openclaw": return cwd ? { path: path.join(cwd, "MEMORY.md"), limit: 20000 } : null;
    case "aider": return {
      path: path.join(root, cwd ? ".agent-hub/hub-native-memory-aider.md" : "hub-native-memory.md"),
      reference: { path: path.join(cwd || homedir(), ".aider.conf.yml"), key: "read", format: "yaml" },
    };
    default: return null;
  }
}
