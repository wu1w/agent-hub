import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { beforeEach, afterEach, test } from "node:test";
import { parse } from "yaml";
import { agentHome, isAgentPresent } from "./adapters.ts";
import { applyBind } from "./bind.ts";
import { ensureHub, hubPaths, loadConfig, setBind } from "./config.ts";
import { selectMemoryProject, syncMemoryInjects } from "./deliver.ts";
import { createMemoryProject, readAllowed, writeAllowed } from "./files.ts";
import { parseHubTargets, setHubTargets } from "./frontmatter.ts";
import { exists, readText, writeText } from "./fsx.ts";
import { createHandoff } from "./handoff.ts";
import { writeGlobalMemory, writeProjectMemory } from "./memory.ts";
import { closeSessionIndex, getSession, rebuildIndex } from "./sessions.ts";
import { adoptSkills, detachAgentSkills, relinkHubSkills, removeHubSkill, setSkillTargets } from "./skills.ts";
import { loadMasterKey, loadVault, saveVaultFromMarkdown, vaultUiPayload } from "./vault.ts";
import { memoryLoadingInfo } from "./autoload.ts";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";

const exec = promisify(execFile);
const previous = { ...process.env };
let home: string;
const envKeys = ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY", "CODEX_HOME", "GROK_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "XDG_CONFIG_HOME", "PATH"];
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-audit-sept17-"));
  for (const key of envKeys) delete process.env[key];
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "ac".repeat(32);
  process.env.PATH = "/usr/bin:/bin";
  await ensureHub();
});
afterEach(async () => {
  closeSessionIndex();
  await fs.rm(home, { recursive: true, force: true });
  for (const key of envKeys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
});
async function installed(id: Parameters<typeof agentHome>[0]) {
  await fs.mkdir(path.join(agentHome(id), id === "cursor" ? "projects" : "sessions"), { recursive: true });
}

test("A01 masked entry and field renames reject without changing ciphertext/revision", async () => {
  await saveVaultFromMarkdown("## original\n密钥: ORIGINAL_SECRET");
  const before = await vaultUiPayload();
  const bytes = await fs.readFile(hubPaths().vaultBin);
  for (const md of [before.masked.replace("original", "renamed"), before.masked.replace("密钥:", "custom:")]) {
    await assert.rejects(saveVaultFromMarkdown(md, undefined, undefined, before.revision), /无法还原掩码/);
    assert.deepEqual(await fs.readFile(hubPaths().vaultBin), bytes);
    assert.equal((await vaultUiPayload()).revision, before.revision);
  }
  await saveVaultFromMarkdown(before.masked, undefined, undefined, before.revision);
  assert.equal((await loadVault()).entries[0]!.fields[0]!.value, "ORIGINAL_SECRET");
  const backup = await fs.readFile(`${hubPaths().vaultBin}.previous`);
  assert.deepEqual(backup, bytes);
  assert.equal(backup.includes(Buffer.from("ORIGINAL_SECRET")), false);
});

test("A02/A15 decoded multiline secrets are redacted before truncation and handoff refreshes latest result", async () => {
  const secret = "MULTILINE_ALPHA_6381\nMULTILINE_BETA_2374";
  await saveVaultFromMarkdown(`## entry\n密钥: ${secret}`);
  for (const agent of ["codex", "cursor", "hyper"] as const) await installed(agent);
  const codex = path.join(agentHome("codex"), "sessions/rollout-fixture.jsonl");
  const records = [
    { type: "session_meta", payload: { id: "fixture", cwd: home } },
    { type: "response_item", payload: { role: "user", content: [{ text: "x".repeat(3990) + secret }] } },
    { type: "response_item", payload: { role: "assistant", channel: "final", content: [{ text: `FINAL_RESULT_FIXTURE ${secret}` }] } },
  ];
  await writeText(codex, records.map(r => JSON.stringify(r)).join("\n") + "\n");
  const cursor = path.join(agentHome("cursor"), "projects/demo/agent-transcripts/cursor-fixture/cursor-fixture.jsonl");
  await writeText(cursor, JSON.stringify({ role: "user", message: { content: [{ text: `<user_query>${secret}</user_query>` }] } }) + "\n");
  await writeText(path.join(agentHome("hyper"), "sessions/hyper-fixture.jsonl"), JSON.stringify({ type: "user", text: secret }) + "\n");
  await writeText(path.join(hubPaths().handoff, "legacy.md"), `# Handoff legacy\n${secret.replace(/\s+/g, " ")}`);
  await rebuildIndex();
  for (const [id, sid] of [["codex", "fixture"], ["cursor", "cursor-fixture"], ["hyper", "hyper-fixture"]] as const) {
    const row = getSession(id, sid)!;
    assert.ok(row);
    assert.doesNotMatch(row.title + row.summary, /MULTILINE_(ALPHA|BETA)/);
  }
  assert.match((await readText(path.join(hubPaths().handoff, "legacy.md")))!, /MULTILINE/);
  await (await import("./handoff.ts")).scrubHandoffs();
  assert.doesNotMatch((await readText(path.join(hubPaths().handoff, "legacy.md")))!, /MULTILINE/);
  assert.match(getSession("codex", "fixture")!.summary, /FINAL_RESULT_FIXTURE/);
  await fs.appendFile(codex, JSON.stringify({ type: "response_item", payload: { role: "assistant", channel: "final", content: [{ text: "NEW_FINAL_RESULT" }] } }) + "\n");
  const handoff = await createHandoff({ from: "codex", to: "grok", sessionId: "fixture" });
  assert.match(handoff.markdown, /NEW_FINAL_RESULT/);
  assert.doesNotMatch(handoff.markdown, /MULTILINE/);
  assert.equal((await fs.stat(hubPaths().sessionIndex)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(hubPaths().sessionIndex))).mode & 0o777, 0o700);
});

test("A03 global Git tracked instructions reject atomically", async () => {
  await installed("codex");
  const file = path.join(agentHome("codex"), "AGENTS.md");
  await writeText(file, "TRACKED ORIGINAL");
  await exec("git", ["-C", home, "init", "-q"]);
  await exec("git", ["-C", home, "add", ".codex/AGENTS.md"]);
  await assert.rejects(applyBind({ agent: "codex", layer: "memory", value: "hub" }), /Git 已跟踪/);
  assert.equal(await readText(file), "TRACKED ORIGINAL");
  assert.equal((await loadConfig()).bind.codex.memory, "own");
});

test("A04 nested physical aliases are excluded, detached as copies, and removed", async () => {
  const nested = path.join(agentHome("grok"), "skills/group/sample");
  await writeText(path.join(nested, "SKILL.md"), "# Nested skill\n");
  await adoptSkills("adopt", { only: "grok" });
  assert.ok((await fs.lstat(nested)).isSymbolicLink());
  await setSkillTargets("sample", []);
  assert.equal(await exists(nested), false);
  await setSkillTargets("sample", ["grok"]);
  await fs.symlink(path.join(hubPaths().skills, "sample"), nested);
  await detachAgentSkills("grok", "detach-copy");
  assert.equal((await fs.lstat(nested)).isSymbolicLink(), false);
  await fs.rm(nested, { recursive: true });
  await fs.symlink(path.join(hubPaths().skills, "sample"), nested);
  await removeHubSkill("sample");
  assert.equal(await exists(nested), false);
});

test("A05 stale skill editor cannot undo new targets", async () => {
  await writeText(path.join(hubPaths().skills, "sample/SKILL.md"), "---\nname: sample\n---\n\nOriginal");
  const draft = await readAllowed("skill", undefined, "sample");
  await setSkillTargets("sample", ["grok"]);
  await assert.rejects(writeAllowed("skill", draft.content + " EDIT", undefined, "sample", draft.revision), /文件已被其他操作修改/);
  assert.deepEqual(parseHubTargets((await readAllowed("skill", undefined, "sample")).content), ["grok"]);
  assert.equal(await exists(path.join(agentHome("codex"), "skills/sample")), false);
});

test("A07 project creation reserves global and refuses duplicate IDs", async () => {
  await writeGlobalMemory("GLOBAL ORIGINAL");
  for (const name of ["global", "global.md", "GLOBAL"]) await assert.rejects(createMemoryProject(name, "BAD"));
  await createMemoryProject("project", "ORIGINAL");
  await assert.rejects(createMemoryProject("project", "BAD"), /已存在/);
  assert.equal(await readText(hubPaths().memoryGlobal), "GLOBAL ORIGINAL");
  assert.equal((await readAllowed("memory", undefined, "project")).content, "ORIGINAL");
});

test("A08 YAML namespace, quotes, wildcard and unrelated metadata roundtrip", () => {
  const original = '---\r\nname: sample\r\nother:\r\n  targets: [codex]\r\nhub:\r\n  note: keep\r\n  targets:\r\n    - "grok"\r\n---\r\n\r\nBody';
  assert.deepEqual(parseHubTargets(original), ["grok"]);
  assert.equal(parseHubTargets("---\nother:\n  targets: [codex]\n---\nBody"), null);
  const changed = setHubTargets(original, ["*"]);
  const parsed = parse(changed.split("---")[1]!);
  assert.deepEqual(parsed.hub.targets, ["*"]);
  assert.equal(parsed.hub.note, "keep");
  assert.deepEqual(parsed.other.targets, ["codex"]);
  assert.throws(() => parseHubTargets("---\nhub:\n  targets: [*]\n---\n"), /有效 YAML/);
  assert.throws(() => setHubTargets(original, ["not-an-agent"]), /有效 Agent/);
});

test("A10 deleted workspaces do not block saves and can be unregistered", async () => {
  await installed("grok");
  await applyBind({ agent: "grok", layer: "memory", value: "hub" });
  const cwd = path.join(home, "workspace"); await fs.mkdir(cwd);
  await selectMemoryProject("grok", undefined, cwd, true);
  await fs.rm(cwd, { recursive: true });
  await writeGlobalMemory("NEW_GLOBAL");
  await syncMemoryInjects();
  assert.match((await readText(path.join(agentHome("grok"), "rules/hub-memory.md")))!, /NEW_GLOBAL/);
  await selectMemoryProject("grok", undefined, cwd);
  const state = JSON.parse((await readText(path.join(hubPaths().memory, "inject-state.json")))!);
  assert.deepEqual(state.scopes, []);
  assert.equal(await exists(cwd), false);
});

test("A12 relink cannot manufacture installed clients", async () => {
  await writeText(path.join(hubPaths().skills, "sample/SKILL.md"), "# skill");
  const ids = ["grok", "cursor", "codex", "hyper"] as const;
  for (const id of ids) { await setBind(id, "skills", "hub"); assert.equal(isAgentPresent(id), false); }
  await relinkHubSkills();
  for (const id of ids) assert.equal(isAgentPresent(id), false);
});

test("A13 Keychain write failures never expose generated key argv", async () => {
  delete process.env.AGENT_HUB_VAULT_KEY;
  const bin = path.join(home, "bin/security");
  await writeText(bin, '#!/bin/sh\ncase "$1" in find-generic-password) exit 44;; *) echo "$@" >&2; exit 1;; esac\n');
  await fs.chmod(bin, 0o700);
  process.env.PATH = path.dirname(bin);
  await assert.rejects(loadMasterKey(), error => {
    assert.match(String(error), /KEYCHAIN_WRITE_FAILED/);
    assert.doesNotMatch(String(error), /[0-9a-f]{64}|add-generic-password/);
    return true;
  });
});

test("A14 conflicting shared scopes reject, same scopes update, Own warns about shared reads", async () => {
  for (const id of ["codex", "opencode"] as const) { await installed(id); await applyBind({ agent: id, layer: "memory", value: "hub" }); }
  const cwd = path.join(home, "workspace"); await fs.mkdir(cwd);
  await writeProjectMemory("alpha", "ALPHA"); await writeProjectMemory("beta", "BETA");
  await selectMemoryProject("codex", "alpha", cwd);
  await assert.rejects(selectMemoryProject("opencode", "beta", cwd), /共享原生入口/);
  assert.doesNotMatch((await readText(path.join(cwd, "AGENTS.md")))!, /BETA/);
  await selectMemoryProject("opencode", "alpha", cwd);
  await writeProjectMemory("alpha", "NEW_ALPHA"); await syncMemoryInjects();
  assert.match((await readText(path.join(cwd, "AGENTS.md")))!, /NEW_ALPHA/);
  assert.match((await memoryLoadingInfo("opencode")).note, /Own.*不隔离/);
});

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`) >= 0 ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

test("A11 rejected bind restores selection and enables control", async () => {
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  let message = "";
  const context = vm.createContext(i18nSandbox({
    api: async () => { throw new Error("HTTP 409"); },
    banner: (s: string) => { message = s; },
    confirmBox: async () => "ok",
    renderAll() {},
    refreshBanner() {},
    pillTxt: (value: string) => value,
    LAYER_META: { memory: { labelKey: "layer.memory" } },
  }));
  vm.runInContext(await i18nPrelude() + "\n" + extractFunction(source, "onBind"), context);
  const select = { value: "hub", disabled: false };
  await context.onBind({ id: "codex", label: "Codex", bind: { memory: "own" } }, "memory", "hub", select);
  assert.equal(select.value, "own"); assert.equal(select.disabled, false); assert.match(message, /409/);
});

test("agent drafts survive card rebuild and keep original revision on conflict", async () => {
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const drafts = new Map();
  const context = vm.createContext(i18nSandbox({ window: { addEventListener() {} }, agentDrafts: drafts, renderAgentDraftStatus() {}, api: async () => { throw new Error("409"); } }));
  vm.runInContext(await i18nPrelude() + "\n" + extractFunction(source, "attachAgentDraft") + "\n" + extractFunction(source, "saveAgentDraft"), context);
  const editor = { value: "", oninput: () => {} };
  context.attachAgentDraft(editor, "identity:codex", { content: "BASE", revision: "r1" });
  editor.value = "LOCAL DRAFT"; editor.oninput();
  const replacement = { value: "", oninput: () => {} };
  context.attachAgentDraft(replacement, "identity:codex", { content: "EXTERNAL", revision: "r2" });
  assert.equal(replacement.value, "LOCAL DRAFT");
  await assert.rejects(context.saveAgentDraft(replacement, "identity:codex", "/api/file"), /409/);
  assert.equal(drafts.get("identity:codex").revision, "r1");
});

test("CLI passes child option terminators unchanged and concurrent grants compose", async () => {
  const cli = new URL("../cli.ts", import.meta.url).pathname;
  await installed("grok");
  await saveVaultFromMarkdown("## cli-test\n密钥: SYNTHETIC_CLI_SECRET");
  const run = (args: string[]) => exec(process.execPath, ["--import", "tsx", cli, ...args], { env: { ...process.env } });
  await Promise.all([
    run(["vault", "grant", "cli-test", "--for", "grok"]),
    run(["vault", "grant", "cli-test", "--for", "codex"]),
  ]);
  assert.deepEqual(new Set((await loadVault()).entries[0]!.agents), new Set(["grok", "codex"]));
  await setBind("grok", "vault", "hub");
  const result = await run(["vault", "get", "cli-test", "--for", "grok", "--exec", "--", process.execPath, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "--", "--flag", "--", "tail"]);
  assert.deepEqual(JSON.parse(result.stdout), ["--flag", "--", "tail"]);
});

test("frontend targets save includes dirty body and revision, then updates the editor", async () => {
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const editor = { value: "DIRTY BODY", disabled: false };
  const button = { disabled: false };
  let payload: Record<string, unknown> = {};
  const context = vm.createContext(i18nSandbox({
    selectedSkill: "sample", skillBusy: false, skillRevision: "r1", skillDirty: true, snap: {},
    $: (selector: string) => selector === "#skill-editor" ? editor : button,
    api: async (_url: string, options: { body: string }) => { payload = JSON.parse(options.body); return { snapshot: {}, file: { content: "MERGED YAML AND BODY", revision: "r2" } }; },
    renderSkills() {}, renderSkillTargets() {}, banner() {}, notice() {},
  }));
  vm.runInContext(await i18nPrelude() + "\n" + extractFunction(source, "saveSkillTargets"), context);
  await context.saveSkillTargets(["grok"]);
  assert.equal(payload.content, "DIRTY BODY"); assert.equal(payload.revision, "r1");
  assert.equal(editor.value, "MERGED YAML AND BODY"); assert.equal(context.skillRevision, "r2");
  assert.equal(context.skillDirty, false); assert.equal(button.disabled, false);
});

test("repair migrates legacy bare wildcard YAML and detaches stale Own aliases", async () => {
  const { repairLinks } = await import("./skills.ts");
  const file = path.join(hubPaths().skills, "legacy/SKILL.md");
  await writeText(file, "---\nname: legacy\nhub:\n  targets: [*]\n  custom: keep\n---\n\nORIGINAL BODY");
  const nested = path.join(agentHome("grok"), "skills/group/legacy");
  await fs.mkdir(path.dirname(nested), { recursive: true });
  await fs.symlink(path.dirname(file), nested);
  await setBind("grok", "skills", "own");
  const repaired = await repairLinks();
  assert.ok(repaired.repaired.includes("legacy:yaml-wildcard"));
  const fixed = (await readText(file))!;
  assert.deepEqual(parse(fixed.split("---")[1]!).hub.targets, ["*"]);
  assert.match(fixed, /custom: keep/); assert.match(fixed, /ORIGINAL BODY/);
  assert.equal((await fs.lstat(nested)).isSymbolicLink(), false);
});

test("frontend AGENTS save uses loaded workspace and new project uses create-only API", async () => {
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const listeners = new Map<string, Map<string, (...args: unknown[]) => Promise<void>>>();
  const elements = new Map<string, { value: string; dataset: Record<string, string>; addEventListener: (event: string, fn: (...args: unknown[]) => Promise<void>) => void }>();
  function element(key: string) {
    if (!elements.has(key)) elements.set(key, { value: "", dataset: {}, addEventListener(event, fn) { if (!listeners.has(key)) listeners.set(key, new Map()); listeners.get(key)!.set(event, fn); } });
    return elements.get(key)!;
  }
  const calls: { url: string; method: string; body: Record<string, unknown> }[] = [];
  const context = vm.createContext(i18nSandbox({
    $: element, $$: () => [], window: { addEventListener() {} },
    loadedAgentsCwd: "/loaded/A", agentsRevision: "r1", selectedMemory: "global",
    memoryBusy: false, memoryPending: false, memoryLoadEpoch: 0, updateMemoryControls() {},
    filterAgentCards() {}, banner() {}, notice() {}, refresh: async () => {}, openMemory: async () => {}, prompt: () => "new-project",
    api: async (url: string, options: { method: string; body: string }) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { revision: "r2", content: "DRAFT FROM A" };
    },
  }));
  vm.runInContext(await i18nPrelude() + "\n" + extractFunction(source, "bindChrome"), context);
  context.bindChrome();
  element("#agents-cwd").value = "/edited/B";
  element("#agents-editor").value = "DRAFT FROM A";
  await listeners.get("#btn-save-agents")!.get("click")!();
  assert.match(calls[0]!.url, /%2Floaded%2FA/); assert.equal(calls[0]!.body.revision, "r1");
  await listeners.get("#btn-new-project")!.get("click")!();
  assert.equal(calls[1]!.method, "POST");
});
