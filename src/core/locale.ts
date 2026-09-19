import { langFromHeader, translateError } from "../../web/errors.js";

export type Lang = "zh" | "en";

export { langFromHeader, translateError };

const CLI: Record<Lang, Record<string, string>> = {
  zh: {
    help: `hub — Agent Hub

  hub scan                 扫描本机适配器与 skill
  hub status               用户 skill × Agent 挂载状态
  hub adopt [--mode adopt|link-existing]
  hub repair               修复 Skills=Hub 的断链
  hub conflict <skill> --keep hub|agent [--from <path>]
  hub bind <agent> <layer> <value> [--mode adopt|link-existing|detach-copy|unlink]
  hub sync-memory
  hub memory-scope <agent> --cwd <workspace> [--project <id> | --global] (omit both to detach)
  hub restore-identity <agent> [--list] [--backup <name>] [--kind identity|soul|subagent] [--subagent <name>]
  hub rm-skill <name>
  hub enable <skill> --for a,b
  hub disable <skill> --for a
  hub remember "<text>" [--project <repo-id>]
  hub import-memory [--agent id]
  hub index [--agent id]
  hub scrub-handoffs       显式清理历史交接中的当前已知秘密
  hub sessions [--agent id] [--limit 30] [--q text] [--own]
  hub handoff --from <agent> --to <agent> --session <id> [--cwd <abs>] [--exec] [--own]
  hub catalog              列出适配器启用状态
  hub catalog on|off <id>  启用或停用适配器（不改绑定）
  hub vault exec --for <agent> -- <cmd>
                           把已授权条目注入子进程环境后执行
  hub vault get <id> --for <agent> [--exec -- <cmd>]
  hub vault grant <id> --for a,b
  hub vault revoke <id> --for a
  hub vault restore-previous  用保存前的密文覆盖 vault.bin
  hub project-skills --cwd <abs>
  hub promote --cwd <abs> <name>
  hub subagents [--agent grok]
  hub web [--port 3950]

  --lang zh|en             界面语言（也可设 HUB_LANG）
`,
    "memory.deliveryPartial": "{count} 个记忆投递目标失败；已保存的源记忆保留，请修复目标后重试同步。",
    "scan.vaultFail": "读取失败（条目数未知）",
    "status.empty": "Hub 里还没有用户 skill。运行 hub adopt。",
    "restore.none": "{agent} 没有备份",
    "sessions.empty": "索引是空的。运行 hub index。",
    "project.empty": "没有项目 skill：{cwd}",
    "sub.empty": "{agent} 没有子代理文件",
    "vault.empty": "保险库是空的。到 Hub → Vault 用 Markdown 写条目。",
    "vault.nobody": "无人授权",
    "vault.restored": "已用上一份保险库备份覆盖 vault.bin",
    "web.listen": "Agent Hub  {url}",
    "web.token": "本机会话口令（只粘贴到登录框，不要放进 URL）：",
    "web.token_file": "非交互终端，不打印口令；本机会话口令见 {path}（0600，仅本用户可读）。",
  },
  en: {
    help: `hub — Agent Hub

  hub scan                 Scan local adapters and skills
  hub status               User-skill × agent mount table
  hub adopt [--mode adopt|link-existing]
  hub repair               Repair Skills=Hub broken links
  hub conflict <skill> --keep hub|agent [--from <path>]
  hub bind <agent> <layer> <value> [--mode adopt|link-existing|detach-copy|unlink]
  hub sync-memory
  hub memory-scope <agent> --cwd <workspace> [--project <id> | --global] (omit both to detach)
  hub restore-identity <agent> [--list] [--backup <name>] [--kind identity|soul|subagent] [--subagent <name>]
  hub rm-skill <name>
  hub enable <skill> --for a,b
  hub disable <skill> --for a
  hub remember "<text>" [--project <repo-id>]
  hub import-memory [--agent id]
  hub index [--agent id]
  hub scrub-handoffs       Scrub currently known secrets from historical handoffs
  hub sessions [--agent id] [--limit 30] [--q text] [--own]
  hub handoff --from <agent> --to <agent> --session <id> [--cwd <abs>] [--exec] [--own]
  hub catalog              List adapter enablement
  hub catalog on|off <id>  Enable or disable an adapter (bindings unchanged)
  hub vault exec --for <agent> -- <cmd>
                           Run a command with granted vault entries in env
  hub vault get <id> --for <agent> [--exec -- <cmd>]
  hub vault grant <id> --for a,b
  hub vault revoke <id> --for a
  hub vault restore-previous  Replace vault.bin with the last pre-save ciphertext
  hub project-skills --cwd <abs>
  hub promote --cwd <abs> <name>
  hub subagents [--agent grok]
  hub web [--port 3950]

  --lang zh|en             UI language (or set HUB_LANG)
`,
    "memory.deliveryPartial": "{count} memory delivery targets failed. Saved source memory is retained; fix the targets and retry sync.",
    "scan.vaultFail": "read failed (count unknown)",
    "status.empty": "Hub has no user skills yet. Run hub adopt.",
    "restore.none": "{agent} has no backups",
    "sessions.empty": "Index is empty. Run hub index.",
    "project.empty": "No project skills: {cwd}",
    "sub.empty": "{agent} has no subagent files",
    "vault.empty": "Vault is empty. Add ## id entries in Hub → Vault.",
    "vault.nobody": "no grants",
    "vault.restored": "Restored vault.bin from the previous ciphertext",
    "web.listen": "Agent Hub  {url}",
    "web.token": "Local session passphrase (paste into the sign-in box; do not put it in the URL):",
    "web.token_file": "Non-interactive terminal: passphrase not printed; find the local session passphrase in {path} (0600, owner-only).",
  },
};

let current: Lang = "zh";

function parseLang(value: string | undefined | null): Lang | null {
  if (!value) return null;
  const raw = value.trim().toLowerCase().replace(/_/g, "-");
  if (raw === "en" || raw.startsWith("en-")) return "en";
  if (raw === "zh" || raw.startsWith("zh-")) return "zh";
  return null;
}

export function detectLang(env: NodeJS.ProcessEnv = process.env): Lang {
  return parseLang(env.HUB_LANG) ?? "zh";
}

export function getLang(): Lang {
  return current;
}

export function setLang(lang: string | null | undefined): Lang {
  current = lang === "en" ? "en" : "zh";
  return current;
}

export function consumeLangFlag(argv: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  current = detectLang(env);
  const out: string[] = [];
  let passthrough = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") passthrough = true;
    if (!passthrough && arg === "--lang" && argv[i + 1]) {
      const parsed = parseLang(argv[++i]);
      if (parsed) current = parsed;
      continue;
    }
    if (!passthrough && arg.startsWith("--lang=")) {
      const parsed = parseLang(arg.slice(7));
      if (parsed) current = parsed;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, k) => (vars[k] == null ? "" : String(vars[k])));
}

export function t(key: string, vars?: Record<string, unknown>): string {
  const table = CLI[current] ?? CLI.zh;
  return interpolate(table[key] ?? CLI.zh[key] ?? key, vars);
}

export function localizeResponse<T>(body: T, lang: Lang | null): T {
  if (!lang || body == null || typeof body !== "object") return body;
  if (Array.isArray(body)) return body.map((item) => localizeResponse(item, lang)) as T;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  if (typeof out.error === "string") out.error = translateError(out.error, lang);
  if (Array.isArray(out.warnings)) out.warnings = out.warnings.map((item) => (typeof item === "string" ? translateError(item, lang) : item));
  if (out.vault && typeof out.vault === "object") out.vault = localizeResponse(out.vault, lang);
  if (out.snapshot && typeof out.snapshot === "object") out.snapshot = localizeResponse(out.snapshot, lang);
  if (out.delivery && typeof out.delivery === "object") out.delivery = localizeResponse(out.delivery, lang);
  if (Array.isArray(out.failures)) out.failures = out.failures.map((item) => localizeResponse(item, lang));
  if (typeof out.label === "string") out.label = translateError(out.label, lang);
  if (typeof out.compatibilityNote === "string") out.compatibilityNote = translateError(out.compatibilityNote, lang);
  if (out.memoryLoading && typeof out.memoryLoading === "object") {
    const loading = { ...(out.memoryLoading as Record<string, unknown>) };
    if (typeof loading.note === "string") loading.note = translateError(loading.note, lang);
    out.memoryLoading = loading;
  }
  if (Array.isArray(out.agents)) out.agents = out.agents.map((item) => localizeResponse(item, lang));
  if (Array.isArray(out.catalog)) out.catalog = out.catalog.map((item) => localizeResponse(item, lang));
  return out as T;
}
