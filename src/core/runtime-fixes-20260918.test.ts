import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { beforeEach, afterEach, test } from "node:test";
import { defaultConfig, ensureHub, hubPaths, loadConfig, saveConfig } from "./config.ts";
import { applyBind } from "./bind.ts";
import { readAllowed, writeAllowed, listIdentityBackups } from "./files.ts";
import { readProjectMemory, remember, writeGlobalMemory, writeProjectMemory } from "./memory.ts";
import { selectMemoryProject, syncMemoryInjects } from "./deliver.ts";
import { closeSessionIndex, getSession, rebuildIndex, readSessionContent } from "./sessions.ts";
import { saveVaultFromMarkdown } from "./vault.ts";
import { readText, writeText } from "./fsx.ts";
import { startServer } from "../server.ts";
import type { AgentId } from "./types.ts";

const original = { ...process.env };
const keys = ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY", "CODEX_HOME", "GROK_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "XDG_CONFIG_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "OPENCLAW_STATE_DIR", "PATH"];
let home: string;
let server: http.Server | undefined;
let url: string;
let token: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-runtime-fixes-"));
  for (const key of keys) delete process.env[key];
  process.env.HOME = home; process.env.AGENT_HUB_ROOT = path.join(home, "hub");
  process.env.AGENT_HUB_VAULT_KEY = "b2".repeat(32); process.env.PATH = "/usr/bin:/bin";
  await ensureHub();
  const config = defaultConfig(); config.agents.enabled = ["grok", "codex"];
  await saveConfig(config);
  await writeText(path.join(home, ".grok/config.json"), "{}");
  await writeText(path.join(home, ".codex/config.toml"), "");
  server = await startServer(0);
  const address = server.address(); assert.ok(address && typeof address === "object");
  url = `http://127.0.0.1:${address.port}`;
  token = (await fs.readFile(hubPaths().token, "utf8")).trim();
});
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; }
  closeSessionIndex();
  await fs.rm(home, { recursive: true, force: true });
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
});
async function api(route: string, method = "GET", body?: unknown) {
  const response = await fetch(url + route, { method, headers: { "x-hub-token": token, "content-type": "application/json", "accept-language": "en" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, data: await response.json() };
}
async function installedMemory(...agents: AgentId[]) {
  await writeGlobalMemory("ORIGINAL_GLOBAL");
  for (const agent of agents) await applyBind({ agent, layer: "memory", value: "hub" });
}
async function transcript(id: string, messages: { role: string; text: string }[], newline = true) {
  const records = [{ type: "session_meta", payload: { id, cwd: home } }, ...messages.map(m => ({ type: "response_item", payload: { role: m.role, channel: "final", content: [{ text: m.text }] } }))];
  const file = path.join(home, ".codex/sessions", `rollout-${id}.jsonl`);
  await writeText(file, records.map(r => JSON.stringify(r)).join("\n") + (newline ? "\n" : ""));
  await rebuildIndex("codex");
  return file;
}

test("AH01: HTTP and core session content redact messages and escaped raw text before display truncation", async () => {
  const secret = 'SYNTHETIC_SECRET_9081_"quote\\slash';
  await saveVaultFromMarkdown(`## fixture\nsecret: ${secret}\n`);
  const file = await transcript("redaction", [{ role: "user", text: secret }, { role: "assistant", text: "x".repeat(3995) + secret + " done" }]);
  const originalBytes = await fs.readFile(file);
  const list = await api("/api/sessions"); assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.data).includes("SYNTHETIC_SECRET"));
  const result = await api("/api/session/content?agent=codex&id=redaction");
  assert.equal(result.status, 200); assert.equal(result.data.messages.length, 2);
  assert.ok(!JSON.stringify(result.data).includes("SYNTHETIC_SECRET"));
  assert.equal(result.data.messages[0].text, "***");
  assert.equal(result.data.raw, undefined);
  assert.ok(!JSON.stringify(await readSessionContent("codex", "redaction")).includes("SYNTHETIC_SECRET"));
  assert.deepEqual(await fs.readFile(file), originalBytes);
  process.env.AGENT_HUB_VAULT_KEY = "c3".repeat(32);
  await assert.rejects(readSessionContent("codex", "redaction"), (e: unknown) => (e as { status: number }).status === 503);
  assert.equal((await api("/api/session/content?agent=codex&id=redaction")).status, 503);
  assert.deepEqual(await fs.readFile(file), originalBytes);
});

test("AH07: complete newline-free final record is retained; an incomplete appended record is ignored", async () => {
  const file = await transcript("last-line", [{ role: "user", text: "QUESTION" }, { role: "assistant", text: "FINAL_COMPLETED" }], false);
  assert.match(getSession("codex", "last-line")!.summary, /FINAL_COMPLETED/);
  assert.equal((await readSessionContent("codex", "last-line")).messages.at(-1)!.text, "FINAL_COMPLETED");
  await fs.appendFile(file, '\n{"type":"response_item","payload":');
  await rebuildIndex("codex");
  assert.match(getSession("codex", "last-line")!.summary, /FINAL_COMPLETED/);
  assert.equal((await readSessionContent("codex", "last-line")).messages.length, 2);
  await transcript("with-newline", [{ role: "assistant", text: "WITH_NEWLINE" }]);
  assert.equal((await readSessionContent("codex", "with-newline")).messages[0]!.text, "WITH_NEWLINE");
});

test("AH04: broken Codex rule cannot block Grok detach; source save reports per-target failure and retries", async () => {
  await installedMemory("grok", "codex");
  const codex = path.join(home, ".codex/AGENTS.md");
  const validCodex = (await readText(codex))!;
  const broken = validCodex.replace("memory:end", "BROKEN:end"); await fs.writeFile(codex, broken);
  const detach = await api("/api/bind", "POST", { agent: "grok", layer: "memory", value: "own" });
  assert.equal(detach.status, 200); assert.equal((await loadConfig()).bind.grok.memory, "own");
  assert.equal(await readText(path.join(home, ".grok/rules/hub-memory.md")), null);
  assert.equal((await api("/api/bind", "POST", { agent: "grok", layer: "memory", value: "hub" })).status, 200);
  const saved = await api("/api/file?kind=memory&name=global", "PUT", { content: "NEW_GLOBAL", revision: (await readAllowed("memory", undefined, "global")).revision });
  assert.equal(saved.status, 200); assert.equal(saved.data.content, "NEW_GLOBAL");
  assert.deepEqual(saved.data.delivery.failures.map((f: { agent: string }) => f.agent), ["codex"]);
  assert.equal(await readText(hubPaths().memoryGlobal), "NEW_GLOBAL");
  assert.match((await readText(path.join(home, ".grok/rules/hub-memory.md")))!, /NEW_GLOBAL/);
  assert.equal(await readText(codex), broken);
  const append = await api("/api/remember", "POST", { text: "ADDED_ONCE" });
  assert.equal(append.status, 200); assert.equal(append.data.delivery.failures.length, 1);
  assert.equal((await readText(hubPaths().memoryGlobal))!.split("ADDED_ONCE").length, 2);
  await fs.writeFile(codex, validCodex);
  const retry = await api("/api/memory/sync", "POST", {});
  assert.equal(retry.status, 200); assert.deepEqual(retry.data.delivery.failures, []);
  assert.match((await readText(codex))!, /ADDED_ONCE/);
});

test("AH04: project save and scope registration do not replay unrelated broken workspaces", async () => {
  await installedMemory("grok", "codex");
  const a = path.join(home, "alpha"), b = path.join(home, "beta"), c = path.join(home, "gamma");
  for (const cwd of [a, b, c]) await fs.mkdir(cwd);
  await writeProjectMemory("alpha", "ALPHA_ORIGINAL"); await writeProjectMemory("beta", "BETA_ORIGINAL");
  await selectMemoryProject("grok", "alpha", a); await selectMemoryProject("codex", "beta", b);
  const badTarget = path.join(b, "AGENTS.md");
  const bad = (await fs.readFile(badTarget, "utf8")).replace("memory:end", "BROKEN:end"); await fs.writeFile(badTarget, bad);
  const saved = await api("/api/file?kind=memory&name=alpha", "PUT", { content: "ALPHA_UPDATED", revision: (await readAllowed("memory", undefined, "alpha")).revision });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.delivery.failures, []);
  assert.match((await readText(path.join(a, ".grok/rules/hub-memory.md")))!, /ALPHA_UPDATED/);
  await selectMemoryProject("grok", "alpha", c); await selectMemoryProject("grok", undefined, c);
  assert.equal(await fs.readFile(badTarget, "utf8"), bad);
  const registry = await fs.readFile(path.join(hubPaths().memory, "inject-state.json"));
  const missing = await api("/api/memory/scope", "POST", { agent: "grok", cwd: c, project: "missing" });
  assert.equal(missing.status, 404); assert.deepEqual(await fs.readFile(path.join(hubPaths().memory, "inject-state.json")), registry);
});

test("AH05: demo and demo.md are distinct literal IDs across CRUD, remember and native scope delivery", async () => {
  await installedMemory("codex");
  const plain = await api("/api/file?kind=memory&name=demo", "POST", { content: "PLAIN_MARKER" });
  const dotted = await api("/api/file?kind=memory&name=demo.md", "POST", { content: "DOTTED_MARKER" });
  assert.equal(plain.status, 201); assert.equal(dotted.status, 201);
  assert.equal(path.basename(plain.data.path), "demo.md"); assert.equal(path.basename(dotted.data.path), "demo.md.md");
  assert.equal(await readProjectMemory("demo"), "PLAIN_MARKER"); assert.equal(await readProjectMemory("demo.md"), "DOTTED_MARKER");
  await remember("APPENDED_DOTTED", "demo.md");
  const read = await api("/api/file?kind=memory&name=demo.md");
  assert.match(read.data.content, /DOTTED_MARKER/); assert.match(read.data.content, /APPENDED_DOTTED/);
  assert.equal(await readProjectMemory("demo"), "PLAIN_MARKER");
  const cwd = path.join(home, "project"); await fs.mkdir(cwd);
  const scope = await api("/api/memory/scope", "POST", { agent: "codex", cwd, project: "demo.md" });
  assert.equal(scope.status, 200);
  const native = await fs.readFile(path.join(cwd, "AGENTS.md"), "utf8");
  assert.match(native, /DOTTED_MARKER/); assert.doesNotMatch(native, /PLAIN_MARKER/);
  await writeAllowed("memory", "DOTTED_UPDATED", undefined, "demo.md", read.data.revision); await syncMemoryInjects("demo.md");
  assert.match(await fs.readFile(path.join(cwd, "AGENTS.md"), "utf8"), /DOTTED_UPDATED/);
});

test("AH06: subagent create is create-only; edits require a current revision", async () => {
  const route = "/api/file?kind=subagent&agent=grok&name=existing";
  const created = await api(route, "POST", { content: "ORIGINAL_SUBAGENT" }); assert.equal(created.status, 201);
  const duplicate = await api(route + ".md", "POST", { content: "NEW_SEED" }); assert.equal(duplicate.status, 409);
  const unsafeEdit = await api(route, "PUT", { content: "NEW_SEED" }); assert.equal(unsafeEdit.status, 428);
  assert.equal((await api(route)).data.content, "ORIGINAL_SUBAGENT"); assert.equal((await listIdentityBackups("grok")).length, 0);
  const edited = await api(route, "PUT", { content: "UPDATED_SUBAGENT", revision: created.data.revision }); assert.equal(edited.status, 200);
  assert.equal((await listIdentityBackups("grok")).length, 1);
  assert.equal((await api(route, "PUT", { content: "STALE", revision: created.data.revision })).status, 409);
  assert.equal((await api(route)).data.content, "UPDATED_SUBAGENT");
});
