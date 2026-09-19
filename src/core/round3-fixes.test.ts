import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, afterEach, test } from "node:test";
import { ensureHub, ensureSessionToken, hubPaths, loadConfig, saveConfig } from "./config.ts";
import { applyBind } from "./bind.ts";
import { adoptSkills, conflictRows, relinkHubSkills, resolveSkillConflict, skillTreeBlocked } from "./skills.ts";
import { listIdentityBackups, restoreIdentity, writeAllowed } from "./files.ts";
import { loadVault, saveVaultFromMarkdown, setVaultGrants, vaultEnvVars, vaultUiPayload } from "./vault.ts";
import { selectMemoryProject, syncMemoryInjects, workspaceMemoryPath } from "./deliver.ts";
import { writeProjectMemory } from "./memory.ts";
import { terminalScript } from "./handoff.ts";
import { withHubLock, transaction } from "./transaction.ts";
import { exists, writeText } from "./fsx.ts";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";
import { closeSessionIndex, listSessions, rebuildIndex } from "./sessions.ts";

const exec = promisify(execFile);
const previous = { ...process.env };
let home: string;
async function put(file: string, value: string) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, value); }
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-fixed-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "a1".repeat(32);
  for (const folder of [".grok", ".cursor", ".codex", ".grok-hyper", ".workbuddy"]) await fs.mkdir(path.join(home, folder, folder === ".cursor" ? "projects" : "sessions"), { recursive: true });
  await ensureHub();
});
afterEach(async () => {
  closeSessionIndex();
  await fs.rm(home, { recursive: true, force: true });
  for (const key of ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});
function child(code: string) { return exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: { ...process.env } }); }

test("T01 real delivery failure rolls back moved files, links and bind", async (t) => {
  const source = path.join(home, ".workbuddy/skills/demo");
  await put(path.join(source, "SKILL.md"), "ORIGINAL");
  const original = fs.symlink;
  t.mock.method(fs, "symlink", async (...args: Parameters<typeof fs.symlink>) => {
    if (String(args[1]).includes(".codex/skills")) throw Object.assign(new Error("injected disk failure"), { code: "ENOSPC" });
    return original(...args);
  });
  await assert.rejects(applyBind({ agent: "workbuddy", layer: "skills", value: "hub", skillsMode: "adopt" }), /injected/);
  assert.equal(await fs.readFile(path.join(source, "SKILL.md"), "utf8"), "ORIGINAL");
  assert.equal(await exists(path.join(hubPaths().skills, "demo")), false);
  assert.equal(await exists(path.join(home, ".grok/skills/demo")), false);
  assert.equal((await loadConfig()).bind.workbuddy.skills, "own");
});

test("T02 explicit adoption rewires personal symlink without deleting its original target", async () => {
  const source = path.join(home, "shared/demo");
  const mount = path.join(home, ".workbuddy/skills/demo");
  await put(path.join(source, "SKILL.md"), "ORIGINAL");
  await fs.mkdir(path.dirname(mount), { recursive: true }); await fs.symlink(source, mount);
  await applyBind({ agent: "workbuddy", layer: "skills", value: "hub", skillsMode: "adopt" });
  assert.equal(await fs.realpath(mount), await fs.realpath(path.join(hubPaths().skills, "demo")));
  assert.equal(await fs.readFile(path.join(source, "SKILL.md"), "utf8"), "ORIGINAL");
});

test("T03 first import conflict is visible and can adopt an explicitly selected source", async () => {
  const source = path.join(home, ".grok/skills/demo");
  await put(path.join(source, "SKILL.md"), "GROK");
  await put(path.join(home, ".cursor/skills/demo/SKILL.md"), "CURSOR");
  assert.equal((await adoptSkills()).conflicts.length, 1);
  assert.equal((await conflictRows()).length, 2);
  await resolveSkillConflict("demo", "agent", source);
  assert.equal(await fs.readFile(path.join(hubPaths().skills, "demo/SKILL.md"), "utf8"), "GROK");
  assert.equal(await fs.readFile(path.join(home, ".cursor/skills/demo/SKILL.md"), "utf8"), "CURSOR");
  await resolveSkillConflict("demo", "hub");
  assert.equal((await conflictRows()).length, 0);
});

test("T04 separate processes revoke grants and change different binds without lost updates", async () => {
  await saveVaultFromMarkdown("## one\n密钥: FIRST\n## two\n密钥: SECOND", { one: ["grok"], two: ["grok"] });
  await Promise.all([
    child('import {setVaultGrants} from "./src/core/vault.ts"; import {setBind} from "./src/core/config.ts"; await setVaultGrants("one", []); await setBind("grok", "memory", "hub");'),
    child('import {setVaultGrants} from "./src/core/vault.ts"; import {setBind} from "./src/core/config.ts"; await setVaultGrants("two", []); await setBind("cursor", "memory", "hub");'),
  ]);
  assert.ok((await loadVault()).entries.every((e) => e.agents.length === 0));
  const config = await loadConfig();
  assert.equal(config.bind.grok.memory, "hub"); assert.equal(config.bind.cursor.memory, "hub");
});

test("T04 stale full-document saves cannot resurrect a revoked grant", async () => {
  await saveVaultFromMarkdown("## one\n密钥: SECRET", { one: ["grok"] });
  const draft = await vaultUiPayload(true);
  await setVaultGrants("one", []);
  await assert.rejects(saveVaultFromMarkdown(draft.markdown!, { one: ["grok"] }, undefined, draft.revision), /其他操作/);
  assert.deepEqual((await loadVault()).entries[0]!.agents, []);
});

test("T05 subagent UI name creates a listed, correctly restorable backup", async () => {
  await put(path.join(home, ".grok/agents/helper.md"), "OLD");
  // Resolve through the adapter; no assumptions about its subagent directory.
  const { allowedRead } = await import("./files.ts");
  const source = await allowedRead("subagent", "grok", "helper");
  await put(source, "OLD"); await writeAllowed("subagent", "NEW", "grok", "helper");
  const backup = (await listIdentityBackups("grok"))[0]!;
  assert.equal(backup.kind, "subagent");
  await restoreIdentity("grok", backup.name);
  assert.equal(await fs.readFile(source, "utf8"), "OLD");
});

test("T06 untyped legacy backup requires explicit original kind and never defaults to Identity", async () => {
  const { allowedRead } = await import("./files.ts");
  const identity = await allowedRead("identity", "workbuddy");
  await put(identity, "IDENTITY");
  await put(path.join(hubPaths().backups, "identity/workbuddy/2026-01-01.md"), "OLD_SOUL");
  assert.equal((await listIdentityBackups("workbuddy"))[0]!.kind, "unknown");
  await assert.rejects(restoreIdentity("workbuddy", "2026-01-01.md"), /来源未知/);
  await restoreIdentity("workbuddy", "2026-01-01.md", { kind: "soul" });
  assert.equal(await fs.readFile(identity, "utf8"), "IDENTITY");
  assert.equal(await fs.readFile(await allowedRead("soul", "workbuddy"), "utf8"), "OLD_SOUL");
});

test("T07 Ctx cannot write through a symlink or hard link into Identity", async () => {
  const target = path.join(home, ".workbuddy/IDENTITY.md");
  const alias = path.join(home, ".workbuddy/USER.md");
  await put(target, "IDENTITY"); await fs.symlink(target, alias);
  await assert.rejects(applyBind({ agent: "workbuddy", layer: "ctx", value: "hub" }), /symlink/);
  assert.equal(await fs.readFile(target, "utf8"), "IDENTITY");
  await fs.unlink(alias); await fs.link(target, alias);
  await assert.rejects(applyBind({ agent: "workbuddy", layer: "ctx", value: "hub" }), /hard link/);
  assert.equal(await fs.readFile(target, "utf8"), "IDENTITY");
});

test("T08 graph scan follows directory aliases and prevents protected mounts", async () => {
  const skill = path.join(home, ".grok/skills/demo");
  await put(path.join(skill, "SKILL.md"), "DEMO");
  await fs.mkdir(path.join(home, "shared"));
  await fs.symlink(hubPaths().vault, path.join(home, "shared/nested-vault"));
  await fs.symlink(path.join(home, "shared"), path.join(skill, "assets"));
  assert.equal(await skillTreeBlocked(skill), true);
  const config = await loadConfig();
  config.adapters ??= {};
  config.adapters.grok = { skill_dir: hubPaths().vault };
  await saveConfig(config);
  await put(path.join(hubPaths().skills, "safe/SKILL.md"), "SAFE");
  await assert.rejects(relinkHubSkills(), /protected/);
  assert.equal(await exists(path.join(hubPaths().vault, "safe")), false);
});

test("T09 environment mapping retains all colliding Chinese and ASCII field values", () => {
  const env = vaultEnvVars({ id: "demo", fields: ["密钥", "密码", "私钥", "a-b", "a_b"].map((name, n) => ({ name, value: `VALUE_${n}`, secret: true })) });
  for (let n = 0; n < 5; n++) assert.ok(Object.values(env).includes(`VALUE_${n}`));
});

test("T10 visible agent predicate is applied before LIMIT", async () => {
  await put(path.join(home, ".grok/sessions/repo/g/summary.json"), JSON.stringify({ info: { id: "g", cwd: home }, generated_title: "NEW", updated_at: "2026-09-15T00:00:00Z" }));
  await put(path.join(home, ".cursor/projects/repo/agent-transcripts/c/c.jsonl"), JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "OLD" }] } }));
  await rebuildIndex();
  const rows = listSessions({ allowedAgents: ["cursor"], limit: 1 });
  assert.equal(rows.length, 1); assert.equal(rows[0]!.agent_id, "cursor");
  assert.deepEqual(listSessions({ allowedAgents: [], limit: 1 }), []);
});

test("T11 two workspaces of the same Agent retain independent project snippets", async () => {
  const a = path.join(home, "repo-a"), b = path.join(home, "repo-b");
  await fs.mkdir(a); await fs.mkdir(b);
  // Bind performs initial global delivery; scope registration now touches only its own workspace.
  await applyBind({ agent: "grok", layer: "memory", value: "hub" });
  await writeProjectMemory("alpha", "ALPHA"); await writeProjectMemory("beta", "BETA");
  await selectMemoryProject("grok", "alpha", a); await selectMemoryProject("grok", "beta", b);
  await syncMemoryInjects("beta");
  assert.match(await fs.readFile(workspaceMemoryPath("grok", a), "utf8"), /ALPHA/);
  assert.doesNotMatch(await fs.readFile(workspaceMemoryPath("grok", a), "utf8"), /BETA/);
  assert.match(await fs.readFile(workspaceMemoryPath("grok", b), "utf8"), /BETA/);
  assert.doesNotMatch(await fs.readFile(path.join(home, ".grok/memory/hub-generated.md"), "utf8"), /ALPHA|BETA/);
  await applyBind({ agent: "grok", layer: "memory", value: "own" });
  assert.equal(await exists(workspaceMemoryPath("grok", a)), false);
  assert.equal(await exists(workspaceMemoryPath("grok", b)), false);
});

test("T12/T13 real editor functions hide custom multiline fields and preserve a dirty draft on reveal", async () => {
  const app = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const functions = app.slice(app.indexOf("function maskNow("), app.indexOf("async function scanProjectSkills("));
  const editor = { value: "", focus() {} };
  const state = { markdown: "## test\n账号: CUSTOM\n密钥: FIRST\nSECOND", secretFields: { test: ["账号"] }, reveal: false, dirty: true };
  const ctx = vm.createContext(i18nSandbox({ vaultBusy: false, vaultRevealEpoch: 0, setVaultBusy() {}, vaultState: state, $: () => editor, api: () => { throw new Error("must not reload dirty draft"); } }));
  vm.runInContext(await i18nPrelude() + "\n" + functions, ctx);
  const masked = vm.runInContext("maskNow(vaultState.markdown)", ctx) as string;
  assert.doesNotMatch(masked, /CUSTOM|FIRST|SECOND/);
  assert.equal(masked.split("\n").length, state.markdown.split("\n").length);
  await vm.runInContext("toggleVaultReveal()", ctx);
  assert.equal(editor.value, state.markdown);
  const helper = await fs.readFile(new URL("../../web/vault-draft.js", import.meta.url), "utf8");
  vm.runInContext(helper.replaceAll("export function", "function"), ctx);
  ctx.edited = masked + "\n说明: NEW_NOTE";
  const merged = vm.runInContext("mergeVaultDraft(edited, vaultState.markdown)", ctx) as string;
  assert.match(merged, /CUSTOM/); assert.match(merged, /FIRST\n  SECOND/); assert.match(merged, /NEW_NOTE/);
});

test("crashed writer journal recovers the original file before the next writer proceeds", async () => {
  const file = path.join(hubPaths().root, "recover.md"); await put(file, "BEFORE");
  await assert.rejects(child('import {transaction} from "./src/core/transaction.ts"; import {writeText} from "./src/core/fsx.ts"; import {hubPaths} from "./src/core/config.ts"; await transaction(async()=>{await writeText(hubPaths().root+"/recover.md", "AFTER"); process.kill(process.pid,"SIGKILL");});'));
  assert.equal(await fs.readFile(file, "utf8"), "AFTER");
  await withHubLock(async () => { assert.equal(await fs.readFile(file, "utf8"), "BEFORE"); });
});

test("atomic write failure keeps previous bytes and rollback handles nested targets", async () => {
  const file = path.join(home, "nested/file.md"); await put(file, "BEFORE");
  await assert.rejects(transaction(async () => { await writeText(file, "AFTER"); throw new Error("abort"); }), /abort/);
  assert.equal(await fs.readFile(file, "utf8"), "BEFORE");
  assert.equal(new Set(await Promise.all(Array.from({ length: 8 }, () => ensureSessionToken()))).size, 1);
});

test("terminal launch script quotes hostile argument text without executing substitutions", async () => {
  const marker = path.join(home, "must-not-exist");
  const value = `hello ' $(touch ${marker})`;
  const script = terminalScript({ kind: "codex-start", argv: ["printf", "%s", value], cwd: home, note: "", mcp: null });
  const file = path.join(home, "launch.sh"); await put(file, script);
  const result = await exec("sh", [file]);
  assert.equal(result.stdout, value); assert.equal(await exists(marker), false);
});

test("empty capability lists remain empty and forbid Ctx Hub", async () => {
  const config = await loadConfig(); config.layers.ctx.global_targets = []; config.layers.sessions.index = [];
  await saveConfig(config);
  assert.deepEqual((await loadConfig()).layers.sessions.index, []);
  await assert.rejects(applyBind({ agent: "grok", layer: "ctx", value: "hub" }), /不支持/);
});

test("failed Ctx projection leaves no stale restore state; absent original stays absent", async () => {
  const user = path.join(home, ".workbuddy/USER.md");
  const identity = path.join(home, ".workbuddy/IDENTITY.md");
  await put(identity, "PERSONA"); await fs.symlink(identity, user);
  await assert.rejects(applyBind({ agent: "workbuddy", layer: "ctx", value: "hub" }));
  assert.equal(await exists(path.join(hubPaths().backups, "ctx/workbuddy/current.json")), false);
  await fs.unlink(user);
  await applyBind({ agent: "workbuddy", layer: "ctx", value: "hub" });
  await applyBind({ agent: "workbuddy", layer: "ctx", value: "own" });
  assert.equal(await exists(user), false);
  assert.equal(await fs.readFile(identity, "utf8"), "PERSONA");
});

test("failed atomic rename retains readable prior Vault ciphertext", async (t) => {
  await saveVaultFromMarkdown("## entry\n密钥: BEFORE");
  const original = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === hubPaths().vaultBin) throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    return original(...args);
  });
  await assert.rejects(saveVaultFromMarkdown("## entry\n密钥: AFTER"), /disk full/);
  assert.equal((await loadVault()).entries[0]!.fields[0]!.value, "BEFORE");
});

test("explicit conflict resolution cannot delete Skills=Own content", async () => {
  await put(path.join(home, ".workbuddy/skills/demo/SKILL.md"), "PRIVATE");
  await put(path.join(hubPaths().skills, "demo/SKILL.md"), "HUB");
  await assert.rejects(resolveSkillConflict("demo", "hub", undefined, "workbuddy"), /Skills=Own/);
  assert.equal(await fs.readFile(path.join(home, ".workbuddy/skills/demo/SKILL.md"), "utf8"), "PRIVATE");
});

test("environment field names remain stable when colliding fields are reordered", () => {
  const fields = ["密钥", "密码", "私钥", "a-b", "a_b"].map((name) => ({ name, value: name, secret: true }));
  const a = vaultEnvVars({ id: "entry", fields });
  const b = vaultEnvVars({ id: "entry", fields: [...fields].reverse() });
  delete a.HUB_VAULT_ENTRY; delete b.HUB_VAULT_ENTRY;
  assert.deepEqual(a, b);
});
