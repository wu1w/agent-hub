import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { ensureHub, hubPaths } from "./core/config.ts";
import { closeSessionIndex } from "./core/sessions.ts";
import { startServer } from "./server.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-api-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;
const prevKey = process.env.AGENT_HUB_VAULT_KEY;

let server: http.Server;
let port = 0;
let hubToken = "";

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = randomBytes(32).toString("hex");
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".cursor", "projects"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".grok-hyper", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".workbuddy", "sessions"), { recursive: true });
  const grokSid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const grokDir = path.join(home, ".grok", "sessions", encodeURIComponent("/tmp/demo"), grokSid);
  await fs.mkdir(grokDir, { recursive: true });
  await fs.writeFile(
    path.join(grokDir, "summary.json"),
    JSON.stringify({
      info: { id: grokSid, cwd: "/tmp/demo" },
      generated_title: "API smoke",
      session_summary: "Indexed from the HTTP test.",
      updated_at: "2026-09-16T00:00:00.000Z",
    }),
  );
  await ensureHub();
  hubToken = (await fs.readFile(hubPaths().token, "utf8")).trim();
  server = await startServer(0);
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("server has no address");
  port = addr.port;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  closeSessionIndex();
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  if (prevKey) process.env.AGENT_HUB_VAULT_KEY = prevKey;
  else delete process.env.AGENT_HUB_VAULT_KEY;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function api(
  pathname: string,
  init?: RequestInit,
  auth = true,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (auth) headers["x-hub-token"] = hubToken;
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    ...init,
    headers,
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

test("memory source commits with an explicit delivery failure; a failed target retains its native projection", async () => {
  const bind = await api("/api/bind", { method: "POST", body: JSON.stringify({ agent: "workbuddy", layer: "memory", value: "hub" }) });
  assert.equal(bind.status, 200);
  const before = await fs.readFile(hubPaths().memoryGlobal, "utf8");
  const native = path.join(home, ".workbuddy/MEMORY.md");
  const originalNative = await fs.readFile(native, "utf8");
  const saved = await api("/api/file?kind=memory&name=global", { method: "PUT", body: JSON.stringify({ content: "x".repeat(4500) }) });
  assert.equal(saved.status, 200);
  assert.equal(await fs.readFile(hubPaths().memoryGlobal, "utf8"), "x".repeat(4500));
  const delivery = saved.body.delivery as { failures: { agent: string; error: string }[] };
  assert.ok(delivery.failures.some(f => f.agent === "workbuddy" && /上限/.test(f.error)));
  assert.equal(await fs.readFile(native, "utf8"), originalNative);
  // Retrying with content inside the budget repairs the target and clears failures.
  const recovered = await api("/api/file?kind=memory&name=global", { method: "PUT", body: JSON.stringify({ content: before }) });
  assert.equal(recovered.status, 200);
  assert.deepEqual((recovered.body.delivery as { failures: unknown[] }).failures, []);
  const off = await api("/api/bind", { method: "POST", body: JSON.stringify({ agent: "workbuddy", layer: "memory", value: "own" }) });
  assert.equal(off.status, 200);
});

test("memory scope API can register global-only Cursor automatic loading", async () => {
  const workspace = path.join(home, "api-workspace");
  await fs.mkdir(workspace);
  await api("/api/bind", { method: "POST", body: JSON.stringify({ agent: "cursor", layer: "memory", value: "hub" }) });
  const result = await api("/api/memory/scope", { method: "POST", body: JSON.stringify({ agent: "cursor", cwd: workspace, globalOnly: true }) });
  assert.equal(result.status, 200);
  assert.match(await fs.readFile(String(result.body.path), "utf8"), /alwaysApply: true/);
  await api("/api/memory/scope", { method: "POST", body: JSON.stringify({ agent: "cursor", cwd: workspace }) });
  await assert.rejects(fs.stat(String(result.body.path)));
  await api("/api/bind", { method: "POST", body: JSON.stringify({ agent: "cursor", layer: "memory", value: "own" }) });
});

test("snapshot and invalid bind are wired", async () => {
  const snap = await api("/api/snapshot");
  assert.equal(snap.status, 200);
  assert.equal(typeof snap.body.hubRoot, "string");
  const bad = await api("/api/bind", {
    method: "POST",
    body: JSON.stringify({ agent: "nope", layer: "skills", value: "hub" }),
  });
  assert.equal(bad.status, 400);
});

test("file allowlist rejects path escape and skill read does not need agent", async () => {
  const missing = await api("/api/file?kind=skill&name=no-such-skill");
  assert.equal(missing.status, 200);
  assert.equal(missing.body.exists, false);
  const res = await api("/api/file?kind=skill&name=../vault", {
    method: "PUT",
    body: JSON.stringify({ content: "x", revision: "path-validation-fixture" }),
  });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /invalid skill/);
});

test("remember, vault get authorization, and index/handoff round-trip", async () => {
  const remembered = await api("/api/remember", {
    method: "POST",
    body: JSON.stringify({ text: "api-note" }),
  });
  assert.equal(remembered.status, 200);

  const revision = (await api("/api/vault")).body.revision;
  const saved = await api("/api/vault", {
    method: "PUT",
    body: JSON.stringify({
      revision,
      markdown: "# Vault\n\n## api-key\n说明: test\n密钥: sk-http-secret\n",
    }),
  });
  assert.equal(saved.status, 200);
  const denied = await api("/api/vault/get", {
    method: "POST",
    body: JSON.stringify({ agent: "grok", id: "api-key" }),
  });
  assert.equal(denied.status, 500);
  await api("/api/bind", {
    method: "POST",
    body: JSON.stringify({ agent: "grok", layer: "vault", value: "hub" }),
  });
  await api("/api/vault/grant", {
    method: "POST",
    body: JSON.stringify({ id: "api-key", agents: ["grok"], revision: (await api("/api/vault")).body.revision }),
  });
  const metadata = await api("/api/vault/get", {
    method: "POST", body: JSON.stringify({ agent: "grok", id: "api-key" }),
  });
  assert.equal(metadata.status, 200);
  assert.doesNotMatch(JSON.stringify(metadata.body), /sk-http-secret/);
  assert.equal(metadata.body.fields, undefined);
  const got = await api("/api/vault/get", {
    method: "POST", body: JSON.stringify({ agent: "grok", id: "api-key", reveal: true }),
  });
  assert.equal(got.status, 200);
  const fields = got.body.fields as { name: string; value: string }[];
  assert.equal(fields.find((field) => field.name === "密钥")?.value, "sk-http-secret");
  const catalog = await api("/api/vault/catalog?agent=grok");
  assert.doesNotMatch(JSON.stringify(catalog.body), /sk-http-secret/);

  const indexed = await api("/api/index", { method: "POST", body: "{}" });
  assert.equal(indexed.status, 200);
  const sessions = await api("/api/sessions?limit=5");
  assert.equal(sessions.status, 200);
  const rows = sessions.body.sessions as { session_id: string; summary: string }[];
  assert.ok(rows.some((row) => row.summary.includes("HTTP test")));
  const handoff = await api("/api/handoff", {
    method: "POST",
    body: JSON.stringify({
      from: "grok",
      to: "grok",
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    }),
  });
  assert.equal(handoff.status, 200);
  assert.match(String((handoff.body.record as { path: string }).path), /handoff/);
});

test("project-skills requires absolute cwd", async () => {
  const missing = await api("/api/project-skills");
  assert.equal(missing.status, 400);
  const rel = await api("/api/project-skills?cwd=relative");
  assert.equal(rel.status, 500);
  const repo = path.join(home, "repo");
  await fs.mkdir(path.join(repo, ".agents", "skills", "from-repo"), { recursive: true });
  await fs.writeFile(
    path.join(repo, ".agents", "skills", "from-repo", "SKILL.md"),
    "---\nname: from-repo\n---\n\n# from-repo\n",
  );
  const listed = await api(`/api/project-skills?cwd=${encodeURIComponent(repo)}`);
  assert.equal(listed.status, 200);
  const skills = listed.body.skills as { name: string }[];
  assert.ok(skills.some((item) => item.name === "from-repo"));
  const promoted = await api("/api/promote", {
    method: "POST",
    body: JSON.stringify({ cwd: repo, name: "from-repo" }),
  });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.copied, true);
});

test("F11/R1 vault and snapshot require a session; anonymous GET cannot mint a cookie", async () => {
  const secret = "sk-http-admin-boundary";
  const revision = (await api("/api/vault")).body.revision;
  const saved = await api("/api/vault", {
    method: "PUT",
    body: JSON.stringify({
      revision,
      markdown: `# Vault\n\n## boundary\n说明: synthetic\n密钥: ${secret}\n`,
    }),
  });
  assert.equal(saved.status, 200);

  const anonSnap = await fetch(`http://127.0.0.1:${port}/api/snapshot`);
  assert.equal(anonSnap.status, 401);
  const setCookie = anonSnap.headers.get("set-cookie") ?? "";
  assert.equal(setCookie.includes("hub_session="), false);

  const anon = await api("/api/vault", undefined, false);
  assert.equal(anon.status, 401);

  const revealDenied = await api("/api/vault?reveal=1", undefined, false);
  assert.equal(revealDenied.status, 401);

  const cookieReveal = await fetch(`http://127.0.0.1:${port}/api/vault?reveal=1`, {
    headers: { cookie: setCookie },
  });
  assert.equal(cookieReveal.status, 401);

  const revealed = await api("/api/vault?reveal=1");
  assert.equal(revealed.status, 200);
  assert.match(String(revealed.body.markdown), new RegExp(secret));

  const csrf = await api("/api/bind", {
    method: "POST",
    headers: { origin: "https://untrusted.example", "content-type": "application/json" },
    body: JSON.stringify({ agent: "grok", layer: "vault", value: "hub" }),
  });
  assert.equal(csrf.status, 403);

  const plain = await fetch(`http://127.0.0.1:${port}/api/bind`, {
    method: "POST",
    headers: { "content-type": "text/plain", "x-hub-token": hubToken },
    body: JSON.stringify({ agent: "grok", layer: "vault", value: "hub" }),
  });
  assert.equal(plain.status, 415);

  const noSession = await api(
    "/api/bind",
    {
      method: "POST",
      body: JSON.stringify({ agent: "workbuddy", layer: "skills", value: "hub" }),
    },
    false,
  );
  assert.equal(noSession.status, 401);
});

test("static pages require a session; query token cannot mint a cookie", async () => {
  const anon = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login.html");
  assert.equal((anon.headers.get("set-cookie") ?? "").includes("hub_session="), false);

  const login = await fetch(`http://127.0.0.1:${port}/login.html`);
  assert.equal(login.status, 200);
  assert.match(await login.text(), /不要把口令写进地址栏/);

  const js = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(js.status, 401);

  const i18n = await fetch(`http://127.0.0.1:${port}/i18n.js`);
  assert.equal(i18n.status, 200);
  const errors = await fetch(`http://127.0.0.1:${port}/errors.js`);
  assert.equal(errors.status, 200);

  const query = await fetch(`http://127.0.0.1:${port}/?hub_token=${hubToken}`, { redirect: "manual" });
  assert.equal(query.status, 302);
  assert.equal(query.headers.get("location"), "/login.html");
  assert.equal((query.headers.get("set-cookie") ?? "").includes("hub_session="), false);

  const authed = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { "x-hub-token": hubToken },
    redirect: "manual",
  });
  assert.equal(authed.status, 200);
  assert.match(await authed.text(), /Agent Hub/);
});

test("Vault HTTP writes require a revision and reject stale editors", async () => {
  const missing = await api("/api/vault", { method: "PUT", body: JSON.stringify({ markdown: "## revision\n密钥: TEST" }) });
  assert.equal(missing.status, 428);
  const version = (await api("/api/vault")).body.revision;
  const save = await api("/api/vault", { method: "PUT", body: JSON.stringify({ markdown: "## revision\n密钥: TEST", revision: version }) });
  assert.equal(save.status, 200);
  const stale = await api("/api/vault", { method: "PUT", body: JSON.stringify({ markdown: "## revision\n密钥: OLD", revision: version }) });
  assert.equal(stale.status, 409);
});

test("same-host different-port origin is rejected", async () => {
  const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: "POST", headers: { origin: "http://127.0.0.1:1", "content-type": "application/json" }, body: "{}",
  });
  assert.equal(response.status, 403);
});

test("A06 Vault save and grants roll back ciphertext/revision when catalog delivery fails", async () => {
  const { saveVaultFromMarkdown, vaultUiPayload, loadVault } = await import("./core/vault.ts");
  const { setBind } = await import("./core/config.ts");
  await saveVaultFromMarkdown("## transactional\n密钥: BEFORE");
  await setBind("grok", "vault", "hub");
  const catalog = path.join(home, ".grok/memory/hub-generated-vault.md");
  await fs.rm(catalog, { force: true }); await fs.mkdir(catalog, { recursive: true });
  const before = await vaultUiPayload();
  const bytes = await fs.readFile(hubPaths().vaultBin);
  const saved = await api("/api/vault", { method: "PUT", body: JSON.stringify({ markdown: "## transactional\n密钥: AFTER", revision: before.revision }) });
  assert.equal(saved.status, 500);
  assert.deepEqual(await fs.readFile(hubPaths().vaultBin), bytes);
  assert.equal((await vaultUiPayload()).revision, before.revision);
  const grant = await api("/api/vault/grant", { method: "POST", body: JSON.stringify({ id: "transactional", agents: ["grok"], revision: before.revision }) });
  assert.equal(grant.status, 500);
  assert.deepEqual((await loadVault()).entries[0]!.agents, []);
  assert.equal((await vaultUiPayload()).revision, before.revision);
  await fs.rm(catalog, { recursive: true });
  const retry = await api("/api/vault", { method: "PUT", body: JSON.stringify({ markdown: "## transactional\n密钥: AFTER", revision: before.revision }) });
  assert.equal(retry.status, 200);
  await setBind("grok", "vault", "own");
});

test("A07 create-only API preserves global and existing project memory", async () => {
  const before = await fs.readFile(hubPaths().memoryGlobal, "utf8");
  const create = (name: string) => api(`/api/file?kind=memory&name=${name}`, { method: "POST", body: JSON.stringify({ content: "NEW" }) });
  assert.equal((await create("global")).status, 409);
  assert.equal(await fs.readFile(hubPaths().memoryGlobal, "utf8"), before);
  assert.equal((await create("create-once")).status, 201);
  assert.equal((await create("create-once")).status, 409);
});

test("A05 targets and dirty editor content commit together with version conflict checks", async () => {
  const file = path.join(hubPaths().skills, "target-test/SKILL.md");
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, "# Initial");
  const draft = await api("/api/file?kind=skill&name=target-test");
  const updated = await api("/api/skill-targets", { method: "POST", body: JSON.stringify({ name: "target-test", targets: ["grok"], content: "# Unsaved draft", revision: draft.body.revision }) });
  assert.equal(updated.status, 200);
  assert.match(await fs.readFile(file, "utf8"), /Unsaved draft/);
  assert.equal((await api("/api/file?kind=skill&name=target-test", { method: "PUT", body: JSON.stringify({ content: draft.body.content, revision: draft.body.revision }) })).status, 409);
  assert.equal(await fs.lstat(path.join(home, ".codex/skills/target-test")).catch(() => null), null);
});

test("A09 malformed unauthenticated URL returns 400 and server handles next request", async () => {
  const net = await import("node:net");
  const response = await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = "";
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("request timed out")); });
    socket.on("connect", () => socket.write("GET http://[ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    socket.on("data", chunk => { data += chunk.toString(); });
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
  });
  assert.match(response, /HTTP\/1.1 400/);
  assert.equal((await api("/api/snapshot")).status, 200);
});

test("R6 bad Skill YAML cannot block Vault grant/revoke/save or snapshot access", async () => {
  const { saveVaultFromMarkdown, vaultUiPayload, setVaultGrants, loadVault } = await import("./core/vault.ts");
  const { setBind } = await import("./core/config.ts");
  await saveVaultFromMarkdown("## revoke-test\n密钥: BEFORE");
  await setVaultGrants("revoke-test", ["grok"]);
  await setBind("grok", "vault", "hub");
  const broken = path.join(hubPaths().skills, "bad-yaml");
  await fs.mkdir(broken, { recursive: true }); await fs.writeFile(path.join(broken, "SKILL.md"), "---\nhub:\n  targets: [*]\n---\nBad");
  try {
    const revision = (await vaultUiPayload()).revision;
    const revoked = await api("/api/vault/grant", { method: "POST", body: JSON.stringify({ id: "revoke-test", agents: [], revision }) });
    assert.equal(revoked.status, 200);
    assert.notEqual(revoked.body.revision, revision);
    assert.equal("snapshot" in revoked.body, false);
    assert.deepEqual((await loadVault()).entries[0]!.agents, []);
    const denied = await api("/api/vault/get", { method: "POST", body: JSON.stringify({ agent: "grok", id: "revoke-test" }) });
    assert.notEqual(denied.status, 200);
    const catalog = await fs.readFile(path.join(home, ".grok/memory/hub-generated-vault.md"), "utf8");
    assert.doesNotMatch(catalog, /`revoke-test`/);
    const saved = await api("/api/vault", { method: "PUT", body: JSON.stringify({ markdown: "## revoke-test\n密钥: AFTER", revision: revoked.body.revision }) });
    assert.equal(saved.status, 200);
    assert.doesNotMatch(JSON.stringify(saved.body), /BEFORE|AFTER/);
    const snapshot = await api("/api/snapshot");
    assert.equal(snapshot.status, 200); assert.equal(snapshot.body.skillsStatus, "unavailable");
  } finally { await fs.rm(broken, { recursive: true }); await setBind("grok", "vault", "own"); }
});

test("R6 unavailable Vault gates HTTP index, sessions, handoff and reveal without rewriting files", async () => {
  const { rebuildIndex, closeSessionIndex } = await import("./core/sessions.ts");
  await rebuildIndex(); closeSessionIndex();
  const file = path.join(hubPaths().handoff, "keep-original.md");
  await fs.writeFile(file, "# Handoff fixture\nUNCHANGED CONTENT\n");
  const before = await fs.readFile(file);
  const index = await fs.readFile(hubPaths().sessionIndex);
  const key = process.env.AGENT_HUB_VAULT_KEY;
  process.env.AGENT_HUB_VAULT_KEY = "fe".repeat(32);
  try {
    for (const [route, method, body] of [
      ["/api/index", "POST", {}], ["/api/sessions", "GET", undefined],
      ["/api/handoff/launch", "POST", { id: "keep-original" }],
      ["/api/reveal", "POST", { agent: "grok", sessionId: "sid" }],
    ] as const) {
      const response = await api(route, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(response.status, 503);
      assert.deepEqual(await fs.readFile(file), before);
      assert.deepEqual(await fs.readFile(hubPaths().sessionIndex), index);
    }
  } finally { process.env.AGENT_HUB_VAULT_KEY = key; }
  await rebuildIndex(); assert.deepEqual(await fs.readFile(file), before);
});

test("Accept-Language localizes HTTP errors; omitted header keeps the original", async () => {
  const raw = await api("/api/login", { method: "POST", body: JSON.stringify({ token: "nope" }) }, false);
  assert.equal(raw.status, 401);
  assert.equal(raw.body.error, "session required");

  const zh = await api(
    "/api/login",
    { method: "POST", body: JSON.stringify({ token: "nope" }), headers: { "accept-language": "zh-CN" } },
    false,
  );
  assert.equal(zh.body.error, "需要本机会话");

  const en = await api("/api/adopt", { method: "POST", body: JSON.stringify({ names: "bad" }), headers: { "accept-language": "en" } });
  assert.equal(en.status, 400);
  assert.equal(en.body.error, "names must be an array of skill names");
});

test("session content API normalizes roles and falls back to raw for thin transcripts", async () => {
  const grokSid = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
  const grokDir = path.join(home, ".grok", "sessions", encodeURIComponent("/tmp/demo"), grokSid);
  await fs.writeFile(path.join(grokDir, "chat_history.jsonl"), [
    JSON.stringify({ type: "system", content: "You are helpful." }),
    JSON.stringify({ type: "user_message", content: "hello there" }),
    JSON.stringify({ type: "agent_message", content: "hi, how can I help" }),
    JSON.stringify({ type: "user_message", content: "tell me a joke" }),
  ].join("\n") + "\n");
  const thinSid = "cccccccc-dddd-eeee-ffff-aaaaaaaaaaaa";
  const thinDir = path.join(home, ".grok", "sessions", encodeURIComponent("/tmp/demo"), thinSid);
  await fs.mkdir(thinDir, { recursive: true });
  await fs.writeFile(path.join(thinDir, "summary.json"), JSON.stringify({ info: { id: thinSid, cwd: "/tmp/demo" }, generated_title: "thin" }));
  await fs.writeFile(path.join(thinDir, "chat_history.jsonl"), JSON.stringify({ type: "user", content: "only one" }) + "\n");
  const indexed = await api("/api/index", { method: "POST", body: "{}" });
  assert.equal(indexed.status, 200);

  assert.equal((await api("/api/session/content?agent=nope&id=x")).status, 400);
  assert.equal((await api("/api/session/content?agent=grok")).status, 400);
  const missing = await api("/api/session/content?agent=grok&id=no-such-session");
  assert.equal(missing.status, 404);
  assert.match(String(missing.body.error), /session not in index/);

  const ok = await api(`/api/session/content?agent=grok&id=${grokSid}`);
  assert.equal(ok.status, 200);
  assert.match(String(ok.body.path), /chat_history\.jsonl$/);
  const messages = ok.body.messages as { role: string; text: string }[];
  assert.ok(messages.length >= 3);
  assert.ok(messages.some((msg) => msg.role === "user" && msg.text === "hello there"));
  assert.ok(messages.some((msg) => msg.role === "assistant" && msg.text === "hi, how can I help"));
  assert.ok(messages.every((msg) => ["user", "assistant", "tool", "system", "other"].includes(msg.role)));
  assert.equal(ok.body.raw, undefined);

  const thin = await api(`/api/session/content?agent=grok&id=${thinSid}`);
  assert.equal(thin.status, 200);
  assert.equal((thin.body.messages as unknown[]).length, 1);
  assert.match(String(thin.body.raw), /only one/);
});

test("agent-layer API reads ctx and memory projections without writing", async () => {
  assert.equal((await api("/api/agent-layer?agent=nope&layer=ctx")).status, 400);
  const badLayer = await api("/api/agent-layer?agent=grok&layer=skills");
  assert.equal(badLayer.status, 400);
  assert.match(String(badLayer.body.error), /layer must be ctx or memory/);
  const noProjection = await api("/api/agent-layer?agent=hermes&layer=ctx");
  assert.equal(noProjection.status, 400);
  assert.match(String(noProjection.body.error), /no ctx projection/);

  const missing = await api("/api/agent-layer?agent=grok&layer=ctx");
  assert.equal(missing.status, 200);
  assert.equal(missing.body.exists, false);
  assert.equal(missing.body.content, "");
  assert.match(String(missing.body.path), /USER\.md$/);

  const projection = String(missing.body.path);
  await fs.mkdir(path.dirname(projection), { recursive: true });
  await fs.writeFile(projection, "# projected ctx");
  const present = await api("/api/agent-layer?agent=grok&layer=ctx");
  assert.equal(present.status, 200);
  assert.equal(present.body.exists, true);
  assert.equal(present.body.content, "# projected ctx");

  const memory = await api("/api/agent-layer?agent=hermes&layer=memory");
  assert.equal(memory.status, 200);
  assert.equal(typeof memory.body.path, "string");
  assert.equal(typeof memory.body.exists, "boolean");
});

test("startup token is printed only on a TTY; redirected stdout gets a file pointer", async () => {
  const { tokenLogLines } = await import("./server.ts");
  const token = "a".repeat(64);
  const tty = tokenLogLines(token, true);
  assert.ok(tty.some((line) => line === token));
  const redirected = tokenLogLines(token, false);
  assert.ok(redirected.length > 0);
  assert.ok(redirected.every((line) => !line.includes(token)));
  assert.ok(redirected.some((line) => line.includes("session.token")));
});

test("catalog API enables an adapter without leaking vault secrets on exec-plan", async () => {
  const before = await api("/api/snapshot");
  assert.equal(before.status, 200);
  const catalog = before.body.catalog as { id: string; enabled: boolean }[];
  const target = catalog.find((row) => !row.enabled);
  assert.ok(target);
  const on = await api("/api/catalog", { method: "POST", body: JSON.stringify({ agent: target.id, enabled: true }) });
  assert.equal(on.status, 200);
  assert.ok((on.body.agents as { id: string }[]).some((row) => row.id === target.id));
  const off = await api("/api/catalog", { method: "POST", body: JSON.stringify({ agent: target.id, enabled: false }) });
  assert.equal(off.status, 200);
  assert.ok(!(off.body.agents as { id: string }[]).some((row) => row.id === target.id));
  const plan = await api("/api/vault/exec-plan?agent=grok&command=grok");
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.body.argv, ["hub", "vault", "exec", "--for", "grok", "--", "grok"]);
  assert.doesNotMatch(JSON.stringify(plan.body), /sk-http-secret|HUB_VAULT_/);
});
