import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { adapter, adapterCommand } from "./adapters.ts";
import { CURRENT_SCHEMA, ensureHub, hubPaths, loadConfig } from "./config.ts";
import { parseJsonConfig } from "./config-reference.ts";
import { protectMemoryTarget } from "./delivery-safety.ts";
import { HubError } from "./errors.ts";
import { exists, parseJsonOr, pruneBackupDir, prunePrefixedFiles, writeText } from "./fsx.ts";
import { execResume, openEditorArgv, revealArgv, resumePlan, shellQuote, terminalScript } from "./handoff.ts";
import { identityNativeTarget } from "./identity-native.ts";
import { composeInject, INJECT_CAP, remember } from "./memory.ts";
import { memoryLoadingInfo } from "./autoload.ts";
import { MIN_REDACT_SECRET_LENGTH, redactSecrets } from "./secrets.ts";
import { buildSnapshot } from "./snapshot.ts";
import { withHubLock } from "./transaction.ts";
import { loadVault, restoreVaultPrevious, saveVaultFromMarkdown } from "./vault.ts";
import { diskEpoch, startHubWatch } from "./watch.ts";
import { closeSessionIndex } from "./sessions.ts";
import { apiErrorPayload } from "../server.ts";

const exec = promisify(execFile);
const previous = { ...process.env };
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-modules-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "d4".repeat(32);
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

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 2500): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return Boolean(await pred());
}

test("HubError carries HTTP status", () => {
  const err = new HubError("session required", 401);
  assert.equal(err.status, 401);
  assert.equal(err.message, "session required");
});

test("parseJsonOr degrades corrupt JSON", () => {
  assert.deepEqual(parseJsonOr("{", { ok: false }), { ok: false });
  assert.deepEqual(parseJsonOr("null", { ok: true }), { ok: true });
  assert.equal(parseJsonOr('{"n":1}', { n: 0 }).n, 1);
});

test("pruneBackupDir keeps the newest files and current.json", async () => {
  const dir = path.join(hubPaths().backups, "prune-demo");
  await writeText(path.join(dir, "current.json"), "{}");
  for (let i = 0; i < 8; i++) await writeText(path.join(dir, `${String(i).padStart(2, "0")}.md`), "x");
  await pruneBackupDir(dir, 3);
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, ["05.md", "06.md", "07.md", "current.json"]);
});

test("prunePrefixedFiles keeps the newest prefix matches", async () => {
  const dir = path.join(hubPaths().root, "prefix-prune");
  await fs.mkdir(dir, { recursive: true });
  await writeText(path.join(dir, "keep.txt"), "ok");
  for (let i = 0; i < 6; i++) await writeText(path.join(dir, `vault.bin.broken-0${i}`), "x");
  await prunePrefixedFiles(dir, "vault.bin.broken-", 2);
  const names = (await fs.readdir(dir)).sort();
  assert.deepEqual(names, ["keep.txt", "vault.bin.broken-04", "vault.bin.broken-05"]);
});

test("short secrets are skipped by redactSecrets", () => {
  const pin = "1234";
  assert.ok(pin.length < MIN_REDACT_SECRET_LENGTH);
  assert.equal(redactSecrets("meet at 1234", [pin]), "meet at 1234");
  assert.equal(redactSecrets("token sk-live-secret-value", ["sk-live-secret-value"]), "token ***");
});

test("adapterCommand and identity native targets", () => {
  assert.equal(adapterCommand("hyper"), "grok-hyper");
  assert.equal(adapter("roo").label, "Roo Code（已归档）");
  assert.equal(identityNativeTarget("cline"), null);
  assert.equal(identityNativeTarget("hyper", home)?.native, true);
  assert.match(identityNativeTarget("cursor", home)!.path, /hub-generated-identity\.mdc$/);
});

test("resumePlan uses grok-hyper for Hyper", () => {
  const plan = resumePlan({ from: "cursor", to: "hyper", sessionId: "s1", cwd: "/tmp/demo", handoffPath: "/tmp/h.md" });
  assert.equal(plan.kind, "hyper-start");
  assert.deepEqual(plan.argv, ["grok-hyper"]);
});

test("parseJsonConfig rejects arrays", () => {
  assert.throws(() => parseJsonConfig("[]"), /invalid JSON/);
  assert.equal((parseJsonConfig('{ "instructions": ["a"] }') as { instructions: string[] }).instructions[0], "a");
});

test("protectMemoryTarget refuses cloud-synced Documents paths", async () => {
  await assert.rejects(protectMemoryTarget(path.join(home, "Documents", "notes.md")), /云盘|sync/i);
});

test("composeInject clips oversized global memory", async () => {
  await remember("G".repeat(INJECT_CAP + 80));
  const composed = await composeInject();
  assert.match(composed, /已截断/);
  assert.ok(composed.length < INJECT_CAP + 40);
});

test("memoryLoadingInfo joins note fragments with spaces", async () => {
  const info = await memoryLoadingInfo("grok");
  assert.match(info.note, /原生入口：/);
  assert.doesNotMatch(info.note, /读取。原生入口/);
  assert.match(info.note, /读取。 原生入口/);
});

test("loadConfig refuses a newer schema_version", async () => {
  await fs.writeFile(hubPaths().config, `schema_version = ${CURRENT_SCHEMA + 1}\nagents = { enabled = ["grok"] }\n`, "utf8");
  await assert.rejects(loadConfig(), (err: unknown) => err instanceof HubError && err.status === 409 && /schema/.test((err as Error).message));
});

test("snapshot stays up when skills scan is empty", async () => {
  const snap = await buildSnapshot();
  assert.equal(snap.vault.status, "ready");
  assert.ok(Array.isArray(snap.catalog));
  assert.ok(snap.catalog.some((row) => row.id === "roo"));
  assert.equal(snap.diskEpoch, diskEpoch());
  assert.equal(typeof snap.sessions.all, "number");
  assert.ok(snap.sessions.all >= snap.sessions.count);
});

test("restoreVaultPrevious reloads the last pre-save ciphertext", async () => {
  await saveVaultFromMarkdown("## demo\n密钥: FIRST-SECRET-VALUE\n");
  await saveVaultFromMarkdown("## demo\n密钥: SECOND-SECRET-VALUE\n");
  const restored = await restoreVaultPrevious();
  assert.equal(restored.entries[0]!.fields[0]!.value, "FIRST-SECRET-VALUE");
  assert.equal((await loadVault()).entries[0]!.fields[0]!.value, "FIRST-SECRET-VALUE");
});

test("restoreVaultPrevious 404s when no previous file exists", async () => {
  await assert.rejects(restoreVaultPrevious(), (err: unknown) => err instanceof HubError && err.status === 404);
});

test("restoreVaultPrevious prunes old vault.bin.broken files", async () => {
  await saveVaultFromMarkdown("## demo\n密钥: FIRST-SECRET-VALUE\n");
  await saveVaultFromMarkdown("## demo\n密钥: SECOND-SECRET-VALUE\n");
  const dir = path.dirname(hubPaths().vaultBin);
  for (let i = 0; i < 22; i++) {
    await fs.writeFile(path.join(dir, `vault.bin.broken-2020-01-01T00-00-${String(i).padStart(2, "0")}Z`), "x", { mode: 0o600 });
  }
  await restoreVaultPrevious();
  const broken = (await fs.readdir(dir)).filter((name) => name.startsWith("vault.bin.broken-"));
  assert.equal(broken.length, 20);
});

test("handoff helpers quote, reveal, and exec a local command", async () => {
  assert.equal(shellQuote("a'b"), "'a'\"'\"'b'");
  assert.deepEqual(revealArgv("/tmp/x"), ["open", "-R", "/tmp/x"]);
  assert.deepEqual(openEditorArgv("/tmp/x"), ["open", "-t", "/tmp/x"]);
  const plan = resumePlan({ from: "grok", to: "cursor", sessionId: "s", cwd: home, handoffPath: path.join(home, "h.md") });
  assert.match(terminalScript(plan), /exec 'cursor'/);
  const ran = await execResume({ ...plan, argv: [process.execPath, "-e", "0"] });
  assert.equal(ran.code, 0);
  await assert.rejects(execResume({ ...plan, argv: [] }), /no resume command/);
});

test("apiErrorPayload hides unexpected filesystem paths", () => {
  const payload = apiErrorPayload(new Error("ENOENT: no such file or directory, open '/Users/william/.agent-hub/vault.bin'"));
  assert.equal(payload.status, 500);
  assert.equal(payload.error, "internal error");
  const syntax = apiErrorPayload(new SyntaxError("Unexpected token /Users/secret at position 0"));
  assert.equal(syntax.status, 400);
  assert.equal(syntax.error, "invalid JSON");
});

test("recursive watch bumps epoch for nested skill files", async () => {
  const stop = await startHubWatch();
  try {
    const before = diskEpoch();
    await writeText(path.join(hubPaths().skills, "nested", "demo", "SKILL.md"), "# nested\n");
    const bumped = await waitFor(() => diskEpoch() > before, 3000);
    assert.ok(bumped, "recursive fs.watch should notice a nested SKILL.md");
  } finally {
    stop();
  }
});

test("a live writer lock blocks a second process until release", async () => {
  const started = path.join(hubPaths().root, "lock-started");
  const child = exec(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `import { withHubLock } from ${JSON.stringify(new URL("./transaction.ts", import.meta.url).pathname)};
       import fs from "node:fs/promises";
       await withHubLock(async () => {
         await fs.writeFile(${JSON.stringify(started)}, "1");
         await new Promise((resolve) => setTimeout(resolve, 500));
       });`,
    ],
    { env: { ...process.env } },
  );
  assert.equal(await waitFor(() => exists(started), 4000), true);
  const waited = Date.now();
  await withHubLock(async () => {});
  assert.ok(Date.now() - waited >= 200, "second locker should wait for the live owner");
  await child;
});
