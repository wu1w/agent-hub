import { supportsVault } from "./adapters.ts";
import { HubError } from "./errors.ts";
import { withHubLock } from "./transaction.ts";
import { execFile as execFileCb } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { AGENT_IDS, isAgentId, type AgentId, type VaultCatalogItem, type VaultEntry, type VaultField, type VaultStore } from "./types.ts";
import { ensureHub, hubPaths, loadConfig } from "./config.ts";
import path from "node:path";
import { prunePrefixedFiles, readBinary, writeBinary } from "./fsx.ts";

const execFile = promisify(execFileCb);
const MAGIC = Buffer.from("AHV1");
const KEYCHAIN_SERVICE = "agent-hub";
const KEYCHAIN_ACCOUNT = "vault-master";
const SECRET_NAME = /密钥|密码|token|key|secret/i;
const NOTE_NAME = /^(说明|desc|description)$/i;
const MASK = "••••••••";

export const VAULT_MASK = MASK;
export const VAULT_MARK = "<!-- hub-generated: agent-hub-vault -->";

function emptyStore(): VaultStore {
  return { version: 1, entries: [] };
}

export function isSecretFieldName(name: string): boolean {
  if (NOTE_NAME.test(name.trim())) return false;
  return SECRET_NAME.test(name);
}

export function noteOf(entry: VaultEntry): string {
  const hit = entry.fields.find((field) => NOTE_NAME.test(field.name));
  return hit?.value.trim() ?? "";
}

export function slugEntryId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Serialize a field so continuation lines cannot be parsed as new `name:` keys. */
export function renderVaultField(name: string, value: string): string {
  const parts = value.split("\n");
  return [`${name}: ${parts[0] ?? ""}`, ...parts.slice(1).map((line) => `  ${line}`)].join("\n");
}

export function parseVaultMarkdown(markdown: string, previous?: VaultStore): VaultStore {
  const prevById = new Map((previous?.entries ?? []).map((entry) => [entry.id, entry]));
  const entries: VaultEntry[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let current: VaultEntry | null = null;
  const now = new Date().toISOString();

  const flush = () => {
    if (!current) return;
    const prev = prevById.get(current.id);
    if (prev) {
      current.agents = prev.agents;
      for (const field of current.fields) {
        const old = prev.fields.find((item) => item.name === field.name);
        if (old?.secret) field.secret = true;
        if (field.secret && field.value.split("\n").every(line => line.trim() === MASK)) {
          field.value = old?.value ?? field.value;
        }
      }
      current.updatedAt = prev.updatedAt;
    }
    for (const field of current.fields) {
      if (field.value.includes(MASK)) throw new HubError("无法还原掩码：请保留原条目 ID 和字段名，或显示密钥后重命名", 409);
    }
    entries.push(current);
    current = null;
  };

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      flush();
      const id = slugEntryId(heading[1] ?? "");
      if (!id) throw new Error("vault entry id must contain ASCII letters or digits");
      current = { id, fields: [], agents: [], updatedAt: now };
      continue;
    }
    if (!current) continue;
    // Continuation lines are indented two spaces so a "Name: value" note stays
    // in the current field instead of opening a phantom one.
    if (line.startsWith("  ")) {
      const last = current.fields[current.fields.length - 1];
      if (last) last.value = last.value ? `${last.value}\n${line.slice(2)}` : line.slice(2);
      continue;
    }
    const field = line.match(/^([^ \t#:：][^:：]*)[:：]\s*(.*)$/);
    if (field) {
      const name = field[1]!.trim();
      const value = field[2] ?? "";
      current.fields.push({
        name,
        value,
        secret: isSecretFieldName(name),
      });
    } else if (line.trim() && !line.startsWith("#")) {
      const last = current.fields[current.fields.length - 1];
      if (last) last.value = last.value ? `${last.value}\n${line}` : line;
    }
  }
  flush();
  const seen = new Set<string>();
  const unique: VaultEntry[] = [];
  for (const entry of entries.reverse()) {
    if (seen.has(entry.id)) throw new Error(`duplicate vault entry: ${entry.id}`);
    if (new Set(entry.fields.map((f) => f.name)).size !== entry.fields.length) throw new Error(`duplicate vault field: ${entry.id}`);
    seen.add(entry.id);
    unique.push(entry);
  }
  unique.reverse();
  return { version: 1, entries: unique };
}

export function renderVaultMarkdown(store: VaultStore): string {
  if (store.entries.length === 0) {
    return `# Vault\n`;
  }
  const blocks = store.entries.map((entry) => {
    const rows = entry.fields.length
      ? entry.fields.map((field) => renderVaultField(field.name, field.value)).join("\n")
      : "说明: ";
    return `## ${entry.id}\n${rows}`;
  });
  return `# Vault\n\n${blocks.join("\n\n")}\n`;
}

export function maskVaultMarkdown(_markdown: string, store: VaultStore): string {
  // Secret values must not replace entry IDs or field names that happen to contain them.
  return renderVaultMarkdown({ ...store, entries: store.entries.map(entry => ({
    ...entry,
    fields: entry.fields.map(field => ({ ...field, value: field.secret ? MASK : field.value })),
  })) });
}

function encrypt(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, ciphertext]);
}

function decrypt(blob: Buffer, key: Buffer): Buffer {
  if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) {
    throw new Error("vault.bin 不是 Agent Hub 密文");
  }
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(16, 32);
  const ciphertext = blob.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}



async function keychainSet(hex: string): Promise<void> {
  await execFile(
    "security",
    ["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", hex, "-U"],
    { timeout: 8000, encoding: "utf8" },
  );
}

async function vaultBinExists(): Promise<boolean> {
  return (await readBinary(hubPaths().vaultBin)) != null;
}

async function keychainLookup(): Promise<{ hex: string | null; inaccessible: boolean }> {
  try {
    const result = await execFile(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { timeout: 8000, encoding: "utf8" },
    );
    const hex = result.stdout.trim();
    return { hex: /^[0-9a-f]{64}$/i.test(hex) ? hex : null, inaccessible: false };
  } catch (err) {
    const code = (err as { code?: string | number }).code;
    if (code === 44 || code === "44") return { hex: null, inaccessible: false };
    return { hex: null, inaccessible: true };
  }
}

export async function loadMasterKey(): Promise<Buffer> {
  const env = process.env.AGENT_HUB_VAULT_KEY?.trim();
  if (env) {
    if (!/^[0-9a-f]{64}$/i.test(env)) throw new Error("AGENT_HUB_VAULT_KEY 必须是 32 字节 hex");
    return Buffer.from(env, "hex");
  }
  const found = await keychainLookup();
  if (found.hex) return Buffer.from(found.hex, "hex");
  const hasCiphertext = await vaultBinExists();
  if (found.inaccessible) {
    throw new Error("无法读取 macOS Keychain。已有 vault.bin 时不会生成新主密钥。");
  }
  if (hasCiphertext) {
    throw new Error("Keychain 中没有主密钥，但 vault.bin 已存在。拒绝自动生成以免毁掉密文。");
  }
  const hex = randomBytes(32).toString("hex");
  try {
    await keychainSet(hex);
  } catch (err) {
    throw new Error(
      "无法写入 macOS Keychain（KEYCHAIN_WRITE_FAILED）。请检查钥匙串访问权限。",
    );
  }
  return Buffer.from(hex, "hex");
}

function parseStore(json: string): VaultStore {
  const parsed = JSON.parse(json) as VaultStore;
  if (parsed.version !== 1 || !Array.isArray(parsed.entries) || parsed.entries.some((e) =>
    typeof e.id !== "string" || !Array.isArray(e.agents) || e.agents.some((a) => !isAgentId(a)) ||
    !Array.isArray(e.fields) || e.fields.some((f) => typeof f.name !== "string" || typeof f.value !== "string" || typeof f.secret !== "boolean")
  )) throw new Error("invalid vault store; refusing to overwrite");
  return parsed;
}

export async function loadVault(): Promise<VaultStore> {
  await ensureHub();
  const blob = await readBinary(hubPaths().vaultBin);
  if (!blob) return emptyStore();
  const key = await loadMasterKey();
  return parseStore(decrypt(blob, key).toString("utf8"));
}

export async function saveVault(store: VaultStore): Promise<string> {
  return withHubLock(async () => {
    await ensureHub();
    const key = await loadMasterKey();
    const blob = encrypt(Buffer.from(JSON.stringify(store), "utf8"), key);
    const target = hubPaths().vaultBin;
    const previous = await readBinary(target);
    if (previous) await writeBinary(`${target}.previous`, previous, 0o600);
    await writeBinary(target, blob, 0o600);
    return target;
  });
}

/** Replace vault.bin with the last pre-save ciphertext. The discarded current file is kept as vault.bin.broken-*. */
export async function restoreVaultPrevious(): Promise<VaultStore> {
  return withHubLock(async () => {
    await ensureHub();
    const target = hubPaths().vaultBin;
    const previous = await readBinary(`${target}.previous`);
    if (!previous) throw new HubError("没有可用的上一份保险库备份", 404);
    const key = await loadMasterKey();
    let store: VaultStore;
    try {
      store = parseStore(decrypt(previous, key).toString("utf8"));
    } catch {
      throw new HubError("上一份保险库备份无法解密", 409);
    }
    const current = await readBinary(target);
    if (current) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await writeBinary(`${target}.broken-${stamp}`, current, 0o600);
      await prunePrefixedFiles(path.dirname(target), "vault.bin.broken-");
    }
    await writeBinary(target, previous, 0o600);
    return store;
  });
}

export async function saveVaultFromMarkdown(
  markdown: string,
  grants?: Record<string, AgentId[]>,
  secretFields?: Record<string, string[]>,
  expectedRevision?: string,
): Promise<VaultStore> {
  return withHubLock(async () => {
    if (grants && Object.values(grants).flat().some(id => !AGENT_IDS.includes(id) || !supportsVault(id))) throw new HubError("授权目标尚不支持 Vault", 400);
    const previous = await loadVault();
    if (expectedRevision !== undefined && expectedRevision !== vaultRevision(previous)) throw new HubError("保险库已被其他操作修改，请重新载入后合并草稿", 409);
    const next = parseVaultMarkdown(markdown, previous);
    if (grants) {
      for (const entry of next.entries) {
        if (grants[entry.id]) {
          entry.agents = grants[entry.id]!.filter((id) => AGENT_IDS.includes(id));
        }
      }
    }
    if (secretFields) {
      for (const entry of next.entries) {
        const names = new Set(secretFields[entry.id] ?? []);
        for (const field of entry.fields) {
          if (NOTE_NAME.test(field.name)) {
            field.secret = false;
            continue;
          }
          if (Object.hasOwn(secretFields, entry.id)) field.secret = isSecretFieldName(field.name) || names.has(field.name);
        }
      }
    }
    const changed = JSON.stringify(next.entries) !== JSON.stringify(previous.entries);
    if (changed) {
      const now = new Date().toISOString();
      for (const entry of next.entries) {
        const prev = previous.entries.find((item) => item.id === entry.id);
        if (!prev || JSON.stringify(prev.fields) !== JSON.stringify(entry.fields) || JSON.stringify(prev.agents) !== JSON.stringify(entry.agents)) {
          entry.updatedAt = now;
        }
      }
    }
    await saveVault(next);
    return next;
  });
}

export async function setVaultGrants(id: string, agents: AgentId[], expectedRevision?: string): Promise<VaultStore> {
  return withHubLock(async () => {
    if (agents.some(id => !AGENT_IDS.includes(id) || !supportsVault(id))) throw new HubError("授权目标尚不支持 Vault", 400);
    const store = await loadVault();
    if (expectedRevision !== undefined && expectedRevision !== vaultRevision(store)) throw new HubError("保险库已被其他操作修改，请重新载入", 409);
    const entry = store.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`unknown vault entry: ${id}`);
    entry.agents = agents.filter((item) => AGENT_IDS.includes(item));
    entry.updatedAt = new Date().toISOString();
    await saveVault(store);
    return store;
  });
}

export function catalogItems(store: VaultStore, q?: string): VaultCatalogItem[] {
  const needle = q?.trim().toLowerCase();
  return store.entries
    .filter((entry) => {
      if (!needle) return true;
      return entry.id.includes(needle) || noteOf(entry).toLowerCase().includes(needle);
    })
    .map((entry) => ({ id: entry.id, note: noteOf(entry), agents: entry.agents }));
}

function slugEnv(raw: string, fallback: string): string {
  const ascii = raw.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return ascii || fallback;
}

export function vaultEnvMapping(got: { id: string; fields: VaultField[] }): string[] {
  const id = slugEnv(got.id, "ENTRY");
  const suffixes = got.fields.map((f) => slugEnv(f.name, f.name === "密钥" ? "KEY" : `FIELD_${Buffer.from(f.name).toString("hex").toUpperCase()}`));
  const names = suffixes.map((suffix, index) => {
    const duplicates = suffixes.filter((s) => s === suffix).length > 1;
    return `HUB_VAULT_${id}_${suffix}${duplicates ? "_" + Buffer.from(got.fields[index]!.name).toString("hex").toUpperCase() : ""}`;
  });
  if (new Set(names).size !== names.length) throw new Error("ambiguous vault environment names");
  return names;
}

export function vaultEnvVars(got: { id: string; fields: VaultField[] }): Record<string, string> {
  const names = vaultEnvMapping(got);
  const env: Record<string, string> = {};
  got.fields.forEach((field, index) => { env[names[index]!] = field.value; });
  const firstSecret = got.fields.find((f) => f.secret);
  if (firstSecret) env[`HUB_VAULT_${slugEnv(got.id, "ENTRY")}`] = firstSecret.value;
  return env;
}

export async function vaultEnvForAgent(agent: AgentId): Promise<Record<string, string>> {
  const items = await vaultCatalogFor(agent);
  const env: Record<string, string> = {};
  for (const item of items) {
    Object.assign(env, vaultEnvVars(await vaultGet(agent, item.id)));
  }
  return env;
}

export function vaultExecArgv(agent: AgentId, command: string[]): string[] {
  return ["hub", "vault", "exec", "--for", agent, "--", ...command];
}

export function renderVaultGetMeta(got: { id: string; fields: VaultField[] }): string {
  const note = got.fields.find((field) => NOTE_NAME.test(field.name))?.value.trim();
  const names = got.fields.map((field) => field.name).join("、");
  const lines = [got.id];
  if (note) lines.push(`说明: ${note}`);
  if (names) lines.push(`字段: ${names}`);
  const mapping = vaultEnvMapping(got);
  got.fields.forEach((field, i) => lines.push(`${field.name} → ${mapping[i]}`));
  lines.push("值不会打印到 stdout。要用：hub vault get <id> --for <agent> --exec -- <命令>");
  return `${lines.join("\n")}\n`;
}

export async function vaultGet(
  agent: AgentId,
  id: string,
): Promise<{ id: string; fields: VaultField[] }> {
  if (!isAgentId(agent)) throw new Error(`unknown agent: ${agent}`);
  if (!supportsVault(agent)) throw new HubError(`${agent} 尚不支持 Vault`, 400);
  const config = await loadConfig();
  if (!config.agents.enabled.includes(agent) || config.bind[agent].vault !== "hub") {
    throw new Error(`${agent} 的 Vault 不是 Hub`);
  }
  const store = await loadVault();
  const entry = store.entries.find((item) => item.id === id);
  if (!entry || !entry.agents.includes(agent)) {
    throw new Error("未授权或不存在");
  }
  return { id: entry.id, fields: entry.fields };
}

export async function vaultCatalogFor(
  agent: AgentId,
  opts?: { assumeHub?: boolean },
): Promise<VaultCatalogItem[]> {
  if (!isAgentId(agent)) return [];
  if (!opts?.assumeHub) {
    const config = await loadConfig();
    if (config.bind[agent].vault !== "hub") return [];
  }
  const store = await loadVault();
  return catalogItems(store).filter((item) => item.agents.includes(agent));
}

export function renderCatalogMarkdown(agent: AgentId, items: VaultCatalogItem[]): string {
  const lines = items.length
    ? items.map((item) => `- \`${item.id}\`${item.note ? ` — ${item.note}` : ""}`)
    : ["- （还没有授权给这个 Agent 的条目）"];
  return `${VAULT_MARK}
<!-- 只读目录，不含密钥。不要把密钥打进日志或会话。取值走受控 env，不要 hub vault get 把明文打到 stdout。 -->

# Hub Vault 目录

${agent} 可用凭据名。值不会出现在这份文件里。

${lines.join("\n")}
`;
}

export async function vaultUiPayload(reveal = false): Promise<{
  markdown?: string;
  masked: string;
  entries: VaultCatalogItem[];
  path: string;
  revision: string;
  secretFields: Record<string, string[]>;
}> {
  const store = await loadVault();
  const markdown = renderVaultMarkdown(store);
  const masked = maskVaultMarkdown(markdown, store);
  return {
    markdown: reveal ? markdown : undefined,
    masked,
    entries: catalogItems(store),
    path: hubPaths().vaultBin,
    revision: vaultRevision(store),
    secretFields: Object.fromEntries(store.entries.map((e) => [e.id, e.fields.filter((f) => f.secret).map((f) => f.name)])),
  };
}

export async function vaultBinContainsPlaintext(secret: string): Promise<boolean> {
  const blob = await readBinary(hubPaths().vaultBin);
  if (!blob || !secret) return false;
  return blob.includes(Buffer.from(secret, "utf8"));
}

function vaultRevision(store: VaultStore): string {
  return createHash("sha256").update(JSON.stringify(store)).digest("hex");
}
