import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import type http from "node:http";
import { beforeEach, afterEach, test } from "node:test";
import { defaultConfig, ensureHub, hubPaths, saveConfig } from "./config.ts";
import { createMemoryProject, readAllowed, writeAllowed } from "./files.ts";
import { closeSessionIndex } from "./sessions.ts";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";
import { startServer } from "../server.ts";

const env = { ...process.env };
const envKeys = ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY", "CODEX_HOME", "GROK_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "XDG_CONFIG_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "OPENCLAW_STATE_DIR", "PATH"];
let home: string, base: string, token: string;
let server: http.Server | undefined;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-runtime-ui-fixes-"));
  for (const key of envKeys) delete process.env[key];
  process.env.HOME = home; process.env.AGENT_HUB_ROOT = path.join(home, "hub"); process.env.AGENT_HUB_VAULT_KEY = "b2".repeat(32); process.env.PATH = "/usr/bin:/bin";
  await ensureHub(); const config = defaultConfig(); config.agents.enabled = []; await saveConfig(config);
  server = await startServer(0); const addr = server.address(); assert.ok(addr && typeof addr === "object");
  base = `http://127.0.0.1:${addr.port}`; token = (await fs.readFile(hubPaths().token, "utf8")).trim();
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); server = undefined; }
  closeSessionIndex(); await fs.rm(home, { recursive: true, force: true });
  for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
});
type Options = { method?: string; body?: string };
async function httpApi(url: string, opts: Options = {}) {
  const res = await fetch(base + url, { ...opts, headers: { "x-hub-token": token, "content-type": "application/json" } });
  const data = await res.json();
  if (!res.ok) { const error = Object.assign(new Error(data.error), { status: res.status }); throw error; }
  return data;
}
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
function node() {
  return { value: "", textContent: "", disabled: false, readOnly: false, hidden: false, dataset: {} as Record<string, string>, style: {}, children: [] as unknown[], listeners: new Map<string, (...args: unknown[]) => unknown>(),
    append(...items: unknown[]) { this.children.push(...items); }, replaceChildren() { this.children = []; }, addEventListener(event: string, fn: (...args: unknown[]) => unknown) { this.listeners.set(event, fn); },
    classList: { contains: () => false, toggle() {}, add() {}, remove() {} },
  };
}
async function ui(request: typeof httpApi = httpApi) {
  const elements = new Map<string, ReturnType<typeof node>>();
  const get = (key: string) => { if (!elements.has(key)) elements.set(key, node()); return elements.get(key)!; };
  const choices = { confirm: true, name: "new-project", confirmations: 0 };
  const context = vm.createContext(i18nSandbox({ document: { querySelector: get, querySelectorAll: () => [], createElement: node }, window: node(), confirm: () => { choices.confirmations++; return choices.confirm; }, fixtures: { api: request, ask: () => choices.name } }));
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const helper = await fs.readFile(new URL("../../web/vault-draft.js", import.meta.url), "utf8");
  vm.runInContext(await i18nPrelude() + "\n" + helper.replaceAll("export function", "function") + "\n" + source.replace(/^(?:import[^\n]+\n)+/, "").split("/* ================= boot ================= */")[0], context);
  vm.runInContext('api = fixtures.api; askText = fixtures.ask; refresh = async () => {}; renderMemory = () => {}; snap = { agents: [], userMd: {} }; bindChrome();', context);
  return { context, get, choices, state: (expression: string) => vm.runInContext(expression, context), click: async (key: string) => { await get(key).listeners.get("click")!(); }, input: (key: string, value: string) => { get(key).value = value; get(key).listeners.get("input")?.(); } };
}

test("AH02: out-of-order reads cannot mismatch title/target even with identical revisions; pending reads cannot save", async () => {
  await createMemoryProject("race-A", "SAME"); await createMemoryProject("race-B", "SAME");
  const a = deferred(), b = deferred(); let writes = 0;
  const x = await ui(async (url, opts = {}) => { const result = await httpApi(url, opts); if (opts.method === "PUT") writes++; if (!opts.method && url.includes("race-A")) await a.promise; if (!opts.method && url.includes("race-B")) await b.promise; return result; });
  const first = x.context.openMemory("race-A"), second = x.context.openMemory("race-B");
  await x.click("#btn-save-memory"); assert.equal(writes, 0); assert.equal(x.get("#btn-save-memory").disabled, true);
  b.release(); await second; a.release(); await first;
  assert.equal(x.state("selectedMemory"), "race-B"); assert.equal(x.get("#memory-title").textContent, "projects/race-B.md");
  x.input("#memory-editor", "EDIT_FOR_B"); await x.click("#btn-save-memory");
  assert.equal((await readAllowed("memory", undefined, "race-A")).content, "SAME");
  assert.equal((await readAllowed("memory", undefined, "race-B")).content, "EDIT_FOR_B"); assert.equal(writes, 1);
});

test("AH02: typing during a pending read preserves the currently loaded document and draft", async () => {
  await createMemoryProject("typing-A", "A"); await createMemoryProject("typing-B", "B"); const wait = deferred();
  const x = await ui(async (url, opts = {}) => { const result = await httpApi(url, opts); if (!opts.method && url.includes("typing-B")) await wait.promise; return result; });
  await x.context.openMemory("typing-A"); const loading = x.context.openMemory("typing-B");
  x.input("#memory-editor", "NEW_DRAFT_A"); wait.release(); assert.equal(await loading, false);
  assert.equal(x.state("selectedMemory"), "typing-A"); assert.equal(x.get("#memory-editor").value, "NEW_DRAFT_A"); assert.equal(x.state("memoryDirty"), true);
  await x.click("#btn-save-memory"); assert.equal((await readAllowed("memory", undefined, "typing-A")).content, "NEW_DRAFT_A");
});

test("AH03: HTTP 409 keeps draft/base revision; explicit merge retries with the displayed latest revision", async () => {
  await createMemoryProject("conflict", "INITIAL"); const x = await ui(); await x.context.openMemory("conflict"); const baseRevision = x.state("memoryRevision");
  x.input("#memory-editor", "MY_DRAFT"); await writeAllowed("memory", "REMOTE_1", undefined, "conflict", baseRevision);
  await x.click("#btn-save-memory");
  assert.equal(x.get("#memory-editor").value, "MY_DRAFT"); assert.equal(x.state("memoryDirty"), true); assert.equal(x.state("memoryRevision"), baseRevision);
  assert.equal(x.get("#memory-remote").value, "REMOTE_1"); assert.equal(x.get("#memory-conflict").hidden, false); assert.equal(x.choices.confirmations, 0);
  await writeAllowed("memory", "REMOTE_2", undefined, "conflict");
  x.input("#memory-editor", "MY_DRAFT_WITH_REMOTE_1"); await x.click("#btn-memory-merge");
  assert.equal((await readAllowed("memory", undefined, "conflict")).content, "REMOTE_2");
  assert.equal(x.get("#memory-editor").value, "MY_DRAFT_WITH_REMOTE_1"); assert.equal(x.get("#memory-remote").value, "REMOTE_2");
  x.input("#memory-editor", "MY_DRAFT_WITH_REMOTE_2"); await x.click("#btn-memory-merge");
  assert.equal((await readAllowed("memory", undefined, "conflict")).content, "MY_DRAFT_WITH_REMOTE_2"); assert.equal(x.state("memoryDirty"), false); assert.equal(x.get("#memory-conflict").hidden, true);
});

test("AH03: typing while a save response is delayed keeps dirty state; cancelling navigation preserves newer edits", async () => {
  await createMemoryProject("pending", "INITIAL"); await createMemoryProject("other", "OTHER"); const written = deferred(), response = deferred(); let delay = true;
  const x = await ui(async (url, opts = {}) => { const result = await httpApi(url, opts); if (opts.method === "PUT" && delay) { written.release(); await response.promise; } return result; });
  await x.context.openMemory("pending"); x.input("#memory-editor", "FIRST_EDIT"); const saving = x.click("#btn-save-memory");
  await written.promise; x.input("#memory-editor", "SECOND_EDIT"); response.release(); await saving;
  assert.equal((await readAllowed("memory", undefined, "pending")).content, "FIRST_EDIT"); assert.equal(x.state("memoryDirty"), true);
  x.choices.confirm = false; assert.equal(await x.context.openMemory("other"), false); assert.equal(x.get("#memory-editor").value, "SECOND_EDIT"); assert.equal(x.choices.confirmations, 1);
  delay = false; await x.click("#btn-save-memory"); assert.equal((await readAllowed("memory", undefined, "pending")).content, "SECOND_EDIT");
});

test("AH02: cancelling discard after project creation never retargets the existing draft", async () => {
  await createMemoryProject("cancel-A", "INITIAL_A"); const x = await ui(); await x.context.openMemory("cancel-A");
  x.input("#memory-editor", "DRAFT_A"); x.choices.name = "cancel-B"; x.choices.confirm = false;
  await x.click("#btn-new-project"); assert.equal(x.choices.confirmations, 1);
  assert.equal(x.state("selectedMemory"), "cancel-A"); assert.equal(x.get("#memory-title").textContent, "projects/cancel-A.md"); assert.equal(x.get("#memory-editor").value, "DRAFT_A");
  await x.click("#btn-save-memory"); assert.equal((await readAllowed("memory", undefined, "cancel-A")).content, "DRAFT_A");
  assert.notEqual((await readAllowed("memory", undefined, "cancel-B")).content, "DRAFT_A");
});

test("AH03: remember preserves edits and another note typed during the request; committed append is not duplicated", async () => {
  await createMemoryProject("notes", "INITIAL"); const written = deferred(), response = deferred();
  const x = await ui(async (url, opts = {}) => { const result = await httpApi(url, opts); if (url === "/api/remember") { written.release(); await response.promise; } return result; });
  await x.context.openMemory("notes"); x.get("#remember-text").value = "NOTE_ONE"; const append = x.click("#btn-remember");
  await written.promise; x.input("#memory-editor", "DRAFT_WHILE_APPENDING"); x.get("#remember-text").value = "NOTE_TWO"; response.release(); await append;
  assert.equal(x.get("#remember-text").value, "NOTE_TWO"); assert.equal(x.get("#memory-editor").value, "DRAFT_WHILE_APPENDING"); assert.equal(x.state("memoryDirty"), true);
  assert.match(x.get("#memory-remote").value, /NOTE_ONE/);
  assert.equal((await readAllowed("memory", undefined, "notes")).content.split("NOTE_ONE").length, 2);
});

test("AH03: failed conflict refresh cannot erase local text, and ordinary remember saves dirty drafts first", async () => {
  await createMemoryProject("conflict-read", "INITIAL"); let rejectRead = false;
  const x = await ui(async (url, opts = {}) => { if (rejectRead && !opts.method) throw new Error("synthetic read failure"); return httpApi(url, opts); });
  await x.context.openMemory("conflict-read"); x.input("#memory-editor", "DRAFT"); await writeAllowed("memory", "REMOTE", undefined, "conflict-read"); rejectRead = true;
  await x.click("#btn-save-memory"); assert.equal(x.get("#memory-editor").value, "DRAFT"); assert.equal(x.state("memoryDirty"), true);
  rejectRead = false; await x.context.openMemory("conflict-read"); x.input("#memory-editor", "MERGED_BASE"); x.get("#remember-text").value = "APPEND";
  await x.click("#btn-remember"); const disk = (await readAllowed("memory", undefined, "conflict-read")).content;
  assert.match(disk, /MERGED_BASE/); assert.match(disk, /APPEND/); assert.equal(x.get("#memory-editor").value, disk); assert.equal(x.state("memoryDirty"), false);
});

test("AH03: USER.md also keeps edits made during save and retains a conflicting draft", async () => {
  const written = deferred(), response = deferred(); let delay = true;
  const x = await ui(async (url, opts = {}) => { const result = await httpApi(url, opts); if (opts.method === "PUT" && delay) { written.release(); await response.promise; } return result; });
  await x.context.loadUserMd(); x.input("#user-editor", "FIRST_USER_EDIT"); const saving = x.click("#btn-save-user");
  await written.promise; x.input("#user-editor", "SECOND_USER_EDIT"); response.release(); await saving;
  assert.equal(x.state("userDirty"), true); assert.equal(x.get("#user-editor").value, "SECOND_USER_EDIT");
  delay = false; await writeAllowed("user-md", "EXTERNAL_USER_EDIT"); await x.click("#btn-save-user");
  assert.equal(x.state("userDirty"), true); assert.equal(x.get("#user-editor").value, "SECOND_USER_EDIT"); assert.equal((await readAllowed("user-md")).content, "EXTERNAL_USER_EDIT");
});

test("AH04: partial delivery message identifies failures rather than claiming everything synced", async () => {
  const x = await ui();
  const result = x.context.memoryDeliveryMessage({ delivery: { failures: [{ agent: "codex", error: "synthetic failure" }] } }, "banner.savedMemory");
  assert.match(result, /同步未全部完成/); assert.match(result, /codex/); assert.doesNotMatch(result, /已保存并同步到加载入口/);
  x.state('setLang("en")'); assert.match(x.context.memoryDeliveryMessage({ delivery: { failures: [{ agent: "codex", error: "synthetic failure" }] } }, "banner.savedMemory"), /Sync is incomplete/);
});
