import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, test } from "node:test";
import { ADAPTERS, isAgentPresent } from "./adapters.ts";
import { applyBind } from "./bind.ts";
import { initialEnabled, loadConfig, saveConfig, setAgentEnabled, setBind } from "./config.ts";
import { writeAllowed } from "./files.ts";
import { identityNativeTarget } from "./identity-native.ts";
import { nativeMemoryTarget } from "./autoload.ts";
import { resumePlan } from "./handoff.ts";
import { closeSessionIndex, getSession, rebuildIndex } from "./sessions.ts";
import { buildSnapshot } from "./snapshot.ts";
import { AGENT_IDS, CORE_AGENT_IDS } from "./types.ts";
import { saveVaultFromMarkdown, setVaultGrants, vaultEnvForAgent } from "./vault.ts";
import { readText, writeText } from "./fsx.ts";

const execFile = promisify(execFileCb);
const keys = ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY", "PATH"];
const previous = { ...process.env };
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-review-"));
  for (const key of keys) delete process.env[key];
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = randomBytes(32).toString("hex");
  process.env.PATH = "/usr/bin:/bin";
});

afterEach(async () => {
  closeSessionIndex();
  await fs.rm(home, { recursive: true, force: true });
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("ADAPTERS and AGENT_IDS are the same set", () => {
  assert.deepEqual(ADAPTERS.map((item) => item.id).sort(), [...AGENT_IDS].sort());
});

test("empty home enables the original five, not the full catalogue", async () => {
  const enabled = initialEnabled(home);
  assert.ok(CORE_AGENT_IDS.every((id) => enabled.includes(id)));
  assert.ok(enabled.length < AGENT_IDS.length);
  for (const id of enabled) {
    assert.ok(CORE_AGENT_IDS.includes(id) || isAgentPresent(id, home));
  }
  const snap = await buildSnapshot();
  assert.deepEqual(snap.agents.map((row) => row.id), enabled);
  assert.equal(snap.catalog.length, AGENT_IDS.length);
  assert.equal(snap.catalog.filter((row) => row.enabled).length, enabled.length);
});

test("detected extra runtimes join the default enable list", async () => {
  await writeText(path.join(home, ".hermes/config.yaml"), "{}\n");
  assert.ok(initialEnabled(home).includes("hermes"));
  assert.ok(!initialEnabled(home).includes("gemini"));
});

test("catalog on/off persists without changing binds", async () => {
  await setBind("grok", "skills", "hub");
  await setAgentEnabled("gemini", true);
  assert.ok((await loadConfig()).agents.enabled.includes("gemini"));
  await setAgentEnabled("gemini", false);
  assert.ok(!(await loadConfig()).agents.enabled.includes("gemini"));
  assert.equal((await loadConfig()).bind.grok.skills, "hub");
});

test("binding a disabled adapter enables it", async () => {
  await setBind("gemini", "memory", "hub");
  assert.ok((await loadConfig()).agents.enabled.includes("gemini"));
  assert.equal((await loadConfig()).bind.gemini.memory, "hub");
});

test("Cursor/Grok/Codex identity saves a native load path", async () => {
  await writeAllowed("identity", "# I am Grok\n", "grok");
  const grok = identityNativeTarget("grok", home)!;
  assert.match((await readText(grok.path))!, /I am Grok/);
  await writeAllowed("identity", "# I am Cursor\n", "cursor");
  const cursor = identityNativeTarget("cursor", home)!;
  assert.match((await readText(cursor.path))!, /alwaysApply: true/);
  assert.match((await readText(cursor.path))!, /I am Cursor/);
  await writeText(path.join(home, ".codex/AGENTS.md"), "USER RULES\n");
  await writeAllowed("identity", "# I am Codex\n", "codex");
  const agents = (await readText(path.join(home, ".codex/AGENTS.md")))!;
  assert.match(agents, /I am Codex/);
  assert.match(agents, /USER RULES/);
  assert.equal(identityNativeTarget("hyper", home)?.native, true);
  const snap = await buildSnapshot();
  assert.equal(snap.agents.find((row) => row.id === "grok")?.identityNative, false);
  assert.equal(snap.agents.find((row) => row.id === "hyper")?.identityNative, true);
});

test("Cursor global memory has a native autoload path", async () => {
  const dest = (await nativeMemoryTarget("cursor"))!.path;
  assert.equal(dest, path.join(home, ".cursor/rules/hub-generated.mdc"));
  await fs.mkdir(path.join(home, ".cursor/projects"), { recursive: true });
  await applyBind({ agent: "cursor", layer: "memory", value: "hub" });
  assert.match((await readText(dest))!, /Hub Memory/);
});

test("Hermes and Claude sessions can be indexed", async () => {
  await writeText(path.join(home, ".hermes/config.yaml"), "{}\n");
  await writeText(path.join(home, ".claude/settings.json"), "{}\n");
  const hermesSid = "hermes-session-1";
  await writeText(
    path.join(home, ".hermes/sessions", `${hermesSid}.jsonl`),
    `${JSON.stringify({ type: "user", message: { role: "user", content: "Hermes ping" } })}\n`,
  );
  const claudeSid = "claude-session-1";
  await writeText(
    path.join(home, ".claude/projects/-Users-demo-app", `${claudeSid}.jsonl`),
    `${JSON.stringify({ type: "user", message: { role: "user", content: "Claude ping" } })}\n`,
  );
  await setBind("hermes", "sessions", "index");
  await setBind("claude", "sessions", "index");
  const cfg = await loadConfig();
  cfg.agents.enabled = ["hermes", "claude"];
  await saveConfig(cfg);
  const report = await rebuildIndex();
  assert.equal(report.byAgent.hermes, 1);
  assert.equal(report.byAgent.claude, 1);
  assert.match(getSession("hermes", hermesSid)?.title ?? "", /Hermes ping/);
  assert.match(getSession("claude", claudeSid)?.title ?? "", /Claude ping/);
});

test("vault exec env includes every granted entry and handoff argv is executable", async () => {
  await saveVaultFromMarkdown("## xai-api\n说明: xAI\n密钥: sk-live-exec\n");
  await setBind("grok", "vault", "hub");
  await setVaultGrants("xai-api", ["grok"]);
  const env = await vaultEnvForAgent("grok");
  assert.equal(env.HUB_VAULT_XAI_API, "sk-live-exec");
  const cursor = resumePlan({ from: "grok", to: "cursor", sessionId: "s", cwd: home, handoffPath: "/tmp/h.md" });
  assert.ok(cursor.argv.length > 0);
  assert.equal(cursor.argv[0], "cursor");
  const hyper = resumePlan({ from: "grok", to: "hyper", sessionId: "s", cwd: home, handoffPath: "/tmp/h.md" });
  assert.ok(hyper.argv.length > 0);
  assert.equal(hyper.kind, "hyper-start");
});

test("vault exec runs a child with injected env", async () => {
  await saveVaultFromMarkdown("## demo\n密钥: SECRET_CHILD_VALUE\n");
  await setBind("grok", "vault", "hub");
  await setVaultGrants("demo", ["grok"]);
  const cli = new URL("../cli.ts", import.meta.url).pathname;
  const result = await execFile(process.execPath, ["--import", "tsx", cli, "vault", "exec", "--for", "grok", "--", process.execPath, "-e", "process.stdout.write(process.env.HUB_VAULT_DEMO || '')"], {
    env: { ...process.env },
  });
  assert.equal(result.stdout, "SECRET_CHILD_VALUE");
});
