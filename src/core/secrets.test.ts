import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { HubError } from "./errors.ts";
import {
  MIN_REDACT_SECRET_LENGTH,
  knownSecrets,
  loadSecretMaterial,
  redactOrOmit,
  redactSecrets,
  requireSecretMaterial,
} from "./secrets.ts";
import { closeSessionIndex } from "./sessions.ts";
import { saveVaultFromMarkdown } from "./vault.ts";
import { ensureHub } from "./config.ts";

const previous = { ...process.env };
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-secrets-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "c3".repeat(32);
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await ensureHub();
});

afterEach(async () => {
  closeSessionIndex();
  await fs.rm(home, { recursive: true, force: true });
  for (const key of ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("redactSecrets skips values shorter than 8 and redacts length 8", () => {
  const pin = "1234";
  const exact = "abcd1234";
  assert.equal(pin.length, 4);
  assert.equal(exact.length, MIN_REDACT_SECRET_LENGTH);
  assert.equal(redactSecrets("lunch at 1234", [pin]), "lunch at 1234");
  assert.equal(redactSecrets("token abcd1234 done", [exact]), "token *** done");
});

test("redactSecrets trims vault values, collapses whitespace, and JSON-escapes quotes", () => {
  assert.equal(redactSecrets('say "s3cret!!"', ["  s3cret!!  "]), 'say "***"');
  assert.equal(redactSecrets("x ab cdefgh y", ["ab  cdefgh"]), "x *** y");
  const quoted = 'he said "p@ssword"';
  assert.equal(redactSecrets(JSON.stringify(quoted), ['"p@ssword"']), JSON.stringify("he said ***"));
});

test("redactSecrets replaces the longest loaded secret first", async () => {
  await saveVaultFromMarkdown("## demo\n密钥: sk-live-secret-value\n密码: sk-live-secret\n");
  const loaded = await loadSecretMaterial();
  assert.deepEqual(loaded.secrets, ["sk-live-secret-value", "sk-live-secret"]);
  assert.equal(redactSecrets("use sk-live-secret-value", loaded.secrets), "use ***");
});

test("redactOrOmit blanks the transcript when the vault is unavailable", () => {
  assert.equal(redactOrOmit("keep this", { ok: false, secrets: [] }), "");
  assert.equal(redactOrOmit("token sk-live-secret-value", { ok: true, secrets: ["sk-live-secret-value"] }), "token ***");
  assert.equal(redactOrOmit("nothing secret", { ok: true, secrets: [] }), "nothing secret");
});

test("loadSecretMaterial ignores non-secret fields and short secrets", async () => {
  await saveVaultFromMarkdown("## demo\n说明: public-note\n密钥: sk-live-secret-value\n密码: 1234\n");
  const loaded = await loadSecretMaterial();
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.secrets, ["sk-live-secret-value"]);
  assert.deepEqual(await knownSecrets(), ["sk-live-secret-value"]);
});

test("requireSecretMaterial uses the English protocol key when the vault cannot be read", async () => {
  await fs.writeFile(path.join(home, ".agent-hub", "vault", "vault.bin"), "not-ciphertext", "utf8");
  await assert.rejects(
    requireSecretMaterial(),
    (err: unknown) =>
      err instanceof HubError &&
      err.status === 503 &&
      err.message === "Vault unavailable; indexing and handoff are paused. Source files are unchanged. Restore the vault and retry.",
  );
  assert.deepEqual(await knownSecrets(), []);
  const loaded = await loadSecretMaterial();
  assert.equal(loaded.ok, false);
  assert.deepEqual(loaded.secrets, []);
});
