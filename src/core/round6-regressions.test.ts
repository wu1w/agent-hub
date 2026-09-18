import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import vm from "node:vm";
import { beforeEach, afterEach, test } from "node:test";
import { ensureHub, hubPaths } from "./config.ts";
import { closeSessionIndex, rebuildIndex, listSessionsForDisplay } from "./sessions.ts";
import { listHandoffs, launchHandoff, createHandoff, scrubHandoffs } from "./handoff.ts";
import { loadVault, saveVaultFromMarkdown, vaultUiPayload } from "./vault.ts";
import { writeText } from "./fsx.ts";
import { buildSnapshot } from "./snapshot.ts";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";

const previous = { ...process.env };
const keys = ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY", "CODEX_HOME", "GROK_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "XDG_CONFIG_HOME", "PATH"];
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-round6-"));
  for (const key of keys) delete process.env[key];
  process.env.HOME = home; process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "ab".repeat(32); process.env.PATH = "/usr/bin:/bin";
  await ensureHub();
});
afterEach(async () => {
  closeSessionIndex(); await fs.rm(home, { recursive: true, force: true });
  for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
});

async function fixture() {
  await saveVaultFromMarkdown("## sample\n密钥: FIXTURE_SECRET\ncredential: CUSTOM_VALUE");
  await writeText(path.join(home, ".grok/sessions/group/sid/summary.json"), JSON.stringify({ info: { id: "sid", cwd: home }, generated_title: "TITLE", session_summary: "Result FIXTURE_SECRET" }));
  await rebuildIndex("grok");
  const file = path.join(hubPaths().handoff, "existing.md");
  await writeText(file, "# Handoff existing\n- from: grok\n- to: grok\n- source_session: sid\n- cwd: /tmp\n- created: 2026-09-17\n\nRESULT FIXTURE_SECRET\n");
  return file;
}

test("R6 unavailable Vault aborts indexing, listing and launch without changing derived bytes; recovery resumes", async () => {
  const file = await fixture();
  closeSessionIndex();
  const original = await fs.readFile(file);
  const index = await fs.readFile(hubPaths().sessionIndex);
  process.env.AGENT_HUB_VAULT_KEY = "cd".repeat(32);
  for (const operation of [() => rebuildIndex(), () => listSessionsForDisplay({}), () => listHandoffs(), () => launchHandoff("existing"), () => createHandoff({ from: "grok", to: "grok", sessionId: "sid" }), () => scrubHandoffs()]) {
    await assert.rejects(operation(), error => (error as { status: number }).status === 503);
    assert.deepEqual(await fs.readFile(file), original);
    assert.deepEqual(await fs.readFile(hubPaths().sessionIndex), index);
  }
  process.env.AGENT_HUB_VAULT_KEY = "ab".repeat(32);
  await rebuildIndex();
  assert.deepEqual(await fs.readFile(file), original);
  assert.equal((await listHandoffs()).length, 1);
  assert.ok((await listSessionsForDisplay({})).length);
  assert.equal((await scrubHandoffs()).changed, 1);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /FIXTURE_SECRET/);
});

test("R6 explicit handoff scrub rolls back all documents if a later write fails", async t => {
  const file = await fixture();
  const second = path.join(hubPaths().handoff, "second.md");
  await fs.copyFile(file, second);
  const original = await fs.readFile(file);
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (String(args[1]) === second) throw new Error("fixture write failure");
    return rename(...args);
  });
  await assert.rejects(scrubHandoffs(), /fixture write failure/);
  assert.deepEqual(await fs.readFile(file), original);
  assert.deepEqual(await fs.readFile(second), original);
});

test("R6 malformed Skill isolates snapshot failure without hiding Vault", async () => {
  await fixture();
  await writeText(path.join(hubPaths().skills, "broken/SKILL.md"), "---\nhub:\n  targets: [*]\n---\nBody");
  const snap = await buildSnapshot();
  assert.equal(snap.skillsStatus, "unavailable");
  assert.ok(snap.warnings.some(text => text.includes("不是空库")));
  assert.equal(snap.vault.status, "ready");
  assert.equal(snap.vault.entries[0]!.id, "sample");
});

type Node = { value: string; textContent: string; disabled: boolean; readOnly: boolean; hidden: boolean; dataset: Record<string, string>; children: Node[]; listeners: Map<string, (...args: unknown[]) => unknown>; append: (...items: Node[]) => void; replaceChildren: () => void; addEventListener: (event: string, fn: (...args: unknown[]) => unknown) => void; classList: { contains: () => boolean; toggle: () => void }; };
function node(): Node {
  return { value: "", textContent: "", disabled: false, readOnly: false, hidden: false, dataset: {}, children: [], listeners: new Map(), append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; }, addEventListener(event, fn) { this.listeners.set(event, fn); }, classList: { contains: () => false, toggle() {} } };
}
async function ui(api: (url: string, options?: { body: string }) => Promise<unknown>) {
  const app = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const helper = await fs.readFile(new URL("../../web/vault-draft.js", import.meta.url), "utf8");
  const elements = new Map<string, Node>();
  const get = (key: string) => { if (!elements.has(key)) elements.set(key, node()); return elements.get(key)!; };
  const context = vm.createContext(i18nSandbox({ document: { querySelector: get, querySelectorAll: () => [], createElement: node }, window: node(), fixtures: { api, data: await vaultUiPayload() }, prompt: () => "credential", confirm: () => true }));
  vm.runInContext(await i18nPrelude() + "\n" + helper.replaceAll("export function", "function") + "\n" + app.replace(/^(?:import[^\n]+\n)+/, "").split("\nbindChrome();")[0], context);
  vm.runInContext('api = fixtures.api; snap = {agents: [], vault: {}}; bindChrome(); applyVaultPayload(fixtures.data);', context);
  return { context, get, state: () => vm.runInContext("vaultState", context) };
}

test("R6 real UI mark → reveal → hide → save preserves custom secret classification", async () => {
  await fixture();
  let message = "";
  const { context, get, state } = await ui(async (url, options) => {
    if (url === "/api/vault?reveal=1") return vaultUiPayload(true);
    if (url === "/api/vault") {
      const body = JSON.parse(options!.body);
      await saveVaultFromMarkdown(body.markdown, undefined, body.secretFields, body.revision);
      return vaultUiPayload();
    }
    throw new Error("unrelated snapshot failure");
  });
  context.capture = (text: string) => { message = text; };
  vm.runInContext("banner = capture", context);
  get("#vault-entries").children[0]!.children[2]!.listeners.get("click")!();
  assert.equal(state().dirty, true);
  await context.toggleVaultReveal();
  assert.ok(state().secretFields.sample.includes("credential"));
  assert.match(get("#vault-editor").value, /CUSTOM_VALUE/);
  await context.toggleVaultReveal();
  assert.doesNotMatch(get("#vault-editor").value, /CUSTOM_VALUE/);
  await get("#btn-save-vault").listeners.get("click")!();
  assert.equal((await loadVault()).entries[0]!.fields.find(field => field.name === "credential")!.secret, true);
  assert.equal(state().revision, (await vaultUiPayload()).revision);
  assert.equal(state().dirty, false);
  assert.match(message, /已写入加密保险库；其他页面刷新失败/);
  assert.equal(get("#vault-editor").readOnly, false);
});

test("R6 reveal revision conflict preserves the complete draft", async () => {
  await fixture();
  const { context, get, state } = await ui(async () => ({ ...(await vaultUiPayload(true)), revision: "conflict" }));
  get("#vault-entries").children[0]!.children[2]!.listeners.get("click")!();
  const original = JSON.stringify(state());
  await assert.rejects(context.toggleVaultReveal(), /保险库已改变/);
  assert.equal(JSON.stringify(state()), original);
  assert.equal(get("#vault-editor").readOnly, false);
});

test("R6 delayed reveal cannot reveal secrets after window blur", async () => {
  await fixture();
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { context, get, state } = await ui(async () => pending);
  const reveal = context.toggleVaultReveal();
  vm.runInContext('window.listeners.get("blur")()', context);
  release(await vaultUiPayload(true)); await reveal;
  assert.equal(state().reveal, false);
  assert.doesNotMatch(get("#vault-editor").value, /FIXTURE_SECRET/);
});

test("R6 slow Vault load cannot overwrite a newer local draft", async () => {
  await fixture();
  let release!: (value: unknown) => void;
  const pending = new Promise(resolve => { release = resolve; });
  const { context, get, state } = await ui(async () => pending);
  const load = context.loadVault();
  get("#vault-editor").value += "\n说明: NEW LOCAL DRAFT";
  get("#vault-editor").listeners.get("input")!();
  release(await vaultUiPayload()); await load;
  assert.equal(state().dirty, true);
  assert.match(state().markdown, /NEW LOCAL DRAFT/);
});

test("audit: a secret equal to an entry ID cannot corrupt masked Markdown identity", async () => {
  await saveVaultFromMarkdown("## sample\n密钥: sample\n账号: ordinary");
  const before = await vaultUiPayload();
  assert.match(before.masked, /## sample\n密钥: ••••••••/);
  await saveVaultFromMarkdown(before.masked, undefined, undefined, before.revision);
  assert.equal((await loadVault()).entries[0]!.id, "sample");
  assert.equal((await loadVault()).entries[0]!.fields[0]!.value, "sample");
});

test("audit: post-commit cleanup failure must return success and next transaction cleans residue", async t => {
  const { transaction } = await import("./transaction.ts");
  const file = path.join(hubPaths().root, "commit.md");
  await writeText(file, "ORIGINAL");
  const remove = fs.rm;
  let fail = true;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (String(args[0]) === path.join(hubPaths().root, ".transaction") && fail && (await fs.readFile(file, "utf8")) === "COMMITTED") {
      fail = false; throw new Error("cleanup fixture failure");
    }
    return remove(...args);
  });
  assert.equal(await transaction(async () => { await writeText(file, "COMMITTED"); return "saved"; }), "saved");
  assert.equal(await fs.readFile(file, "utf8"), "COMMITTED");
  await assert.rejects(transaction(async () => { await writeText(file, "ROLLBACK"); throw new Error("abort"); }), /abort/);
  assert.equal(await fs.readFile(file, "utf8"), "COMMITTED");
});

test("audit: a later failed scanner does not partially update earlier agent rows", async t => {
  await fixture();
  const before = await listSessionsForDisplay({});
  await writeText(path.join(home, ".grok/sessions/group/sid/summary.json"), JSON.stringify({ info: { id: "sid", cwd: home }, generated_title: "SHOULD NOT COMMIT" }));
  const codex = path.join(home, ".codex/sessions/rollout-fail.jsonl");
  await writeText(codex, JSON.stringify({ type: "session_meta", payload: { id: "broken", cwd: home } }) + "\n");
  const open = fs.open;
  // readHead is best-effort, so fail the tail after allowing the header read.
  let reads = 0;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]) === codex && ++reads > 1) throw new Error("scanner read failed");
    return open(...args);
  });
  await assert.rejects(rebuildIndex(), /scanner read failed/);
  assert.deepEqual(await listSessionsForDisplay({}), before);
});

test("audit: incomplete recovery journal preserves existing target and journal for repair", async () => {
  const { withHubLock } = await import("./transaction.ts");
  const target = path.join(hubPaths().root, "last-copy.md");
  await writeText(target, "ONLY SURVIVING COPY");
  const pending = path.join(hubPaths().root, ".transaction");
  await fs.mkdir(pending);
  const journal = JSON.stringify([{ target, backup: path.join(pending, "missing"), existed: true }]);
  await fs.writeFile(path.join(pending, "journal.json"), journal);
  await assert.rejects(withHubLock(async () => {}), /ENOENT/);
  assert.equal(await fs.readFile(target, "utf8"), "ONLY SURVIVING COPY");
  assert.equal(await fs.readFile(path.join(pending, "journal.json"), "utf8"), journal);
});


test("R7 real UI custom secret unmark and empty-value save survive reveal/hide", async () => {
  await saveVaultFromMarkdown("## sample\ncredential: CUSTOM_VALUE\ntoken: SECRET", undefined, { sample: ["credential"] });
  const { context, get, state } = await ui(async (url, options) => {
    if (url === "/api/vault?reveal=1") return vaultUiPayload(true);
    if (url === "/api/vault") {
      const body = JSON.parse(options!.body);
      await saveVaultFromMarkdown(body.markdown, undefined, body.secretFields, body.revision);
      return vaultUiPayload();
    }
    throw new Error("snapshot unavailable");
  });
  const unmark = get("#vault-entries").children[0]!.children[3]!.listeners.get("click")!;
  unmark();
  assert.ok(state().secretFields.sample.includes("credential"));
  await context.toggleVaultReveal();
  unmark();
  assert.deepEqual([...state().secretFields.sample], ["token"]);
  get("#vault-editor").value = "## sample\ncredential: CUSTOM_VALUE\ntoken: ";
  get("#vault-editor").listeners.get("input")!();
  await context.toggleVaultReveal();
  await get("#btn-save-vault").listeners.get("click")!();
  const fields = (await loadVault()).entries[0]!.fields;
  assert.equal(fields[0]!.secret, false);
  assert.equal(fields[1]!.value, "");
});

test("R7 Cmd/Ctrl+S saves only focused visible editor; Agent draft bar survives page switch", async () => {
  const { context, get } = await ui(async () => { throw new Error("unused"); });
  let clicks = 0, prevented = 0;
  const button = get("#btn-save-skill") as Node & { click: () => void };
  button.click = () => { clicks++; }; button.disabled = false;
  const editor = { id: "skill-editor", disabled: false, readOnly: false, closest: () => null, classList: { contains: () => false } };
  context.document.activeElement = editor;
  const event = { key: "s", metaKey: true, preventDefault() { prevented++; } };
  context.handleSaveShortcut(event);
  context.handleSaveShortcut({ ...event, metaKey: false, ctrlKey: true });
  assert.equal(clicks, 2); assert.equal(prevented, 2);
  editor.readOnly = true; context.handleSaveShortcut(event); assert.equal(clicks, 2);
  const draftEditor = { value: "", oninput() {} };
  context.attachAgentDraft(draftEditor, "identity:grok", { content: "BASE", revision: "r1" });
  draftEditor.value = "LOCAL"; draftEditor.oninput();
  assert.equal(get("#agent-draft-status").hidden, false);
  assert.match(get("#agent-draft-status").textContent, /identity:grok/);
  context.renderAgentDraftStatus();
  assert.equal(draftEditor.value, "LOCAL");
});


test("CUA index 503 clears stale sessions, metadata and launch controls", async () => {
  const { context, get } = await ui(async () => ({}));
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  context.sessionStorage = { getItem: () => "" };
  context.fetch = async () => ({ status: 503, ok: false, json: async () => ({ error: "Vault unavailable" }) });
  vm.runInContext(source.slice(source.indexOf("async function api("), source.indexOf("async function refresh(")), context);
  vm.runInContext('sessionState = {sessions: [], handoffs: [], selected: {agent_id:"grok",session_id:"stale"}};', context);
  get("#handoff-out").textContent = "stale launch";
  get("#session-path").textContent = "stale path";
  await assert.rejects(context.api("/api/index", { method: "POST" }), /Vault unavailable/);
  assert.equal(vm.runInContext("sessionState.selected", context), null);
  assert.equal(get("#handoff-out").textContent, "");
  assert.equal(get("#session-path").textContent, "");
  assert.equal(get("#btn-handoff").disabled, true);
  assert.match(get("#session-meta").textContent, /暂不可用/);
});
