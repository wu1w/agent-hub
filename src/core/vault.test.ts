import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setBind } from "./config.ts";
import { applyLayerBind } from "./deliver.ts";
import { readText } from "./fsx.ts";
import {
  parseVaultMarkdown,
  renderVaultMarkdown,
  saveVaultFromMarkdown,
  setVaultGrants,
  VAULT_MASK,
  vaultBinContainsPlaintext,
  vaultCatalogFor,
  renderVaultGetMeta,
  vaultEnvVars,
  vaultGet,
} from "./vault.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-vault-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;
const prevKey = process.env.AGENT_HUB_VAULT_KEY;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = randomBytes(32).toString("hex");
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".cursor", "projects"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".grok-hyper", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".workbuddy", "sessions"), { recursive: true });
});

after(async () => {
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  if (prevKey) process.env.AGENT_HUB_VAULT_KEY = prevKey;
  else delete process.env.AGENT_HUB_VAULT_KEY;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("parse treats 密钥 as secret and 说明 as plaintext", () => {
  const store = parseVaultMarkdown(`# Vault

## xai-api
说明: xAI
地址: https://api.x.ai
密钥: sk-live-secret
`);
  const entry = store.entries[0]!;
  assert.equal(entry.id, "xai-api");
  assert.equal(entry.agents.length, 0);
  const key = entry.fields.find((field) => field.name === "密钥")!;
  const note = entry.fields.find((field) => field.name === "说明")!;
  assert.equal(key.secret, true);
  assert.equal(note.secret, false);
  assert.match(renderVaultMarkdown(store), /sk-live-secret/);
});

test("vault.bin is ciphertext and get requires hub bind plus grant", async () => {
  const secret = "sk-live-secret-value";
  await saveVaultFromMarkdown(`# Vault

## xai-api
说明: xAI API
密钥: ${secret}
`);
  assert.equal(await vaultBinContainsPlaintext(secret), false);
  await assert.rejects(() => vaultGet("grok", "xai-api"), /不是 Hub|未授权/);
  await setBind("grok", "vault", "hub");
  await assert.rejects(() => vaultGet("grok", "xai-api"), /未授权/);
  await setVaultGrants("xai-api", ["grok"]);
  const got = await vaultGet("grok", "xai-api");
  assert.equal(got.fields.find((field) => field.name === "密钥")?.value, secret);
  const meta = renderVaultGetMeta(got);
  assert.match(meta, /xai-api/);
  assert.doesNotMatch(meta, new RegExp(secret));
  const env = vaultEnvVars(got);
  assert.equal(env.HUB_VAULT_XAI_API, secret);
  assert.equal(env.HUB_VAULT_XAI_API_KEY, secret);
  const catalog = await vaultCatalogFor("grok");
  assert.equal(catalog.length, 1);
  assert.equal(catalog[0]?.id, "xai-api");
  assert.doesNotMatch(JSON.stringify(catalog), /sk-live-secret-value/);
  await applyLayerBind("grok", "vault", "hub");
  const injected = await readText(path.join(home, ".grok", "memory", "hub-generated-vault.md"));
  assert.match(injected ?? "", /xai-api/);
  assert.doesNotMatch(injected ?? "", /sk-live-secret-value/);
  assert.doesNotMatch(injected ?? "", /skills/);
});

test("masked markdown save keeps the previous secret and grants", async () => {
  const secret = "sk-keep-me";
  await saveVaultFromMarkdown(`# Vault

## kept
说明: stay
密钥: ${secret}
`);
  await setVaultGrants("kept", ["hyper"]);
  const masked = `# Vault

## kept
说明: stay
密钥: ${VAULT_MASK}
`;
  const store = await saveVaultFromMarkdown(masked);
  const entry = store.entries.find((item) => item.id === "kept")!;
  assert.equal(entry.fields.find((field) => field.name === "密钥")?.value, secret);
  assert.deepEqual(entry.agents, ["hyper"]);
});

test("empty vault markdown has no example entry", () => {
  const empty = renderVaultMarkdown({ version: 1, entries: [] });
  assert.equal(empty.includes("## example"), false);
  assert.match(empty, /^# Vault\n/);
});

test("multiline vault fields round-trip colons inside indented values", () => {
  const markdown = `# Vault

## demo
说明: first
  extra: still a note
密钥: sk-live-secret-value
`;
  const store = parseVaultMarkdown(markdown);
  const entry = store.entries[0]!;
  assert.equal(entry.fields.find((field) => field.name === "说明")?.value, "first\nextra: still a note");
  assert.equal(entry.fields.find((field) => field.name === "密钥")?.value, "sk-live-secret-value");
  assert.equal(entry.fields.some((field) => field.name === "extra"), false);
  const rendered = renderVaultMarkdown(store);
  assert.match(rendered, /^说明: first$/m);
  assert.match(rendered, /^  extra: still a note$/m);
  const again = parseVaultMarkdown(rendered);
  assert.equal(again.entries[0]!.fields.find((field) => field.name === "说明")?.value, "first\nextra: still a note");
});
