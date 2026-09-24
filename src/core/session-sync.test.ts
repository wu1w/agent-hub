import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { after, before, test } from "node:test";
import { hubPaths, setAgentEnabled, setBind } from "./config.ts";
import { closeSessionIndex, getSession, rebuildIndex, syncChangedSessions } from "./sessions.ts";
import { startSessionSync } from "./session-sync.ts";
import { withHubLock } from "./transaction.ts";
import { i18nPrelude, i18nSandbox } from "./ui-vm.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-sync-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;
const grokSid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`) >= 0 ? source.indexOf(`async function ${name}(`) : source.indexOf(`function ${name}(`);
  const next = source.slice(start + 1).search(/\n(?:async )?function /);
  return source.slice(start, next < 0 ? undefined : start + 1 + next);
}

async function writeCodex(id: string, user: string): Promise<string> {
  return writeRollout(id, id, user);
}

async function writeRollout(fileId: string, sessionId: string, user: string, assistant?: string): Promise<string> {
  const dir = path.join(home, ".codex", "sessions", "2026", "09", "23");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-23T00-00-00-${fileId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session_meta", payload: { session_id: sessionId, cwd: "/tmp/codex" } }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] },
    }),
  ];
  if (assistant) {
    lines.push(JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "text", text: assistant }] },
    }));
  }
  await fs.writeFile(file, lines.join("\n") + "\n");
  return file;
}

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  await fs.mkdir(home, { recursive: true });
});

after(async () => {
  closeSessionIndex();
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("unchanged grok summary is skipped and keeps its parsed mtime", async () => {
  const dir = path.join(home, ".grok", "sessions", encodeURIComponent("/tmp/grok"), grokSid);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, "summary.json");
  const updatedAt = "2026-09-12T23:43:55.401Z";
  await fs.writeFile(file, JSON.stringify({
    info: { id: grokSid, cwd: "/tmp/grok" },
    generated_title: "WorldRules lock",
    session_summary: "Locked the world object.",
    updated_at: updatedAt,
  }));
  await rebuildIndex();
  const indexed = getSession("grok", grokSid);
  assert.ok(indexed);
  assert.equal(indexed.mtime, Date.parse(updatedAt));
  await delay(20);
  await rebuildIndex();
  const rewritten = getSession("grok", grokSid);
  assert.ok(rewritten && rewritten.indexed_at > indexed.indexed_at);
  const report = await syncChangedSessions();
  const kept = getSession("grok", grokSid);
  assert.equal(report.updated, 0);
  assert.equal(report.skipped, false);
  assert.equal(kept?.indexed_at, rewritten.indexed_at);
  assert.equal(kept?.mtime, Date.parse(updatedAt));
});

test("codex sync updates one rollout, inserts a new file, prunes a deletion, and ignores sessions=own", async () => {
  const keepId = "11111111-1111-4111-8111-111111111111";
  const changeId = "22222222-2222-4222-8222-222222222222";
  const freshId = "33333333-3333-4333-8333-333333333333";
  const hermesId = "hermes-local-only";
  const keepFile = await writeCodex(keepId, "keep this rollout");
  const changeFile = await writeCodex(changeId, "change this rollout");
  await setAgentEnabled("hermes", true);
  await setBind("hermes", "sessions", "own");
  const hermesDir = path.join(home, ".hermes", "sessions");
  await fs.mkdir(hermesDir, { recursive: true });
  await fs.writeFile(path.join(hermesDir, `${hermesId}.jsonl`), `${JSON.stringify({
    type: "user",
    message: { role: "user", content: "hermes private" },
  })}\n`);
  await rebuildIndex();
  const keepBefore = getSession("codex", keepId);
  const changeBefore = getSession("codex", changeId);
  assert.ok(keepBefore && changeBefore);
  assert.equal(getSession("hermes", hermesId), null);
  await fs.appendFile(changeFile, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "text", text: "UPDATED_TAIL_MARKER" }] },
  })}\n`);
  await fs.utimes(changeFile, new Date(), new Date(Date.now() + 5000));
  const changed = await syncChangedSessions();
  assert.equal(changed.updated, 1);
  assert.equal(changed.skipped, false);
  const keepAfter = getSession("codex", keepId);
  const changeAfter = getSession("codex", changeId);
  assert.equal(keepAfter?.indexed_at, keepBefore.indexed_at);
  assert.match(changeAfter?.summary ?? "", /UPDATED_TAIL_MARKER/);
  assert.ok(changeAfter && changeAfter.indexed_at >= changeBefore.indexed_at);
  assert.equal(getSession("hermes", hermesId), null);
  await writeCodex(freshId, "brand new rollout");
  const inserted = await syncChangedSessions();
  assert.equal(inserted.updated, 1);
  assert.match(getSession("codex", freshId)?.title ?? "", /brand new rollout/);
  assert.equal(getSession("codex", keepId)?.indexed_at, keepBefore.indexed_at);
  await fs.rm(keepFile);
  const pruned = await syncChangedSessions();
  assert.equal(pruned.pruned, 1);
  assert.equal(pruned.updated, 0);
  assert.equal(getSession("codex", keepId), null);
  assert.ok(getSession("codex", freshId));
  assert.ok(getSession("codex", changeId));
});

test("codex indexes the newest rollout of a running session and follows later appends", async () => {
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const older = await writeRollout("44444444-4444-4444-8444-aaaaaaaaaaaa", sessionId, "older fork", "STALE_FORK");
  const newer = await writeRollout("44444444-4444-4444-8444-bbbbbbbbbbbb", sessionId, "live fork", "LIVE_TAIL");
  const past = new Date(Date.now() - 60_000);
  await fs.utimes(older, past, past);
  await fs.utimes(newer, new Date(), new Date());
  await rebuildIndex();
  const indexed = getSession("codex", sessionId);
  assert.equal(indexed?.source_path, newer);
  assert.match(indexed?.summary ?? "", /LIVE_TAIL/);
  assert.doesNotMatch(indexed?.summary ?? "", /STALE_FORK/);
  const quiet = await syncChangedSessions();
  assert.equal(quiet.updated, 0);
  assert.equal(getSession("codex", sessionId)?.indexed_at, indexed?.indexed_at);
  await fs.appendFile(newer, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "text", text: "LIVE_TAIL_2" }] },
  })}\n`);
  await fs.utimes(newer, new Date(), new Date(Date.now() + 10_000));
  const appended = await syncChangedSessions();
  assert.equal(appended.updated, 1);
  const live = getSession("codex", sessionId);
  assert.equal(live?.source_path, newer);
  assert.match(live?.summary ?? "", /LIVE_TAIL_2/);
  await fs.appendFile(older, `${JSON.stringify({
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "text", text: "OLD_NOW_LIVE" }] },
  })}\n`);
  await fs.utimes(older, new Date(), new Date(Date.now() + 30_000));
  await syncChangedSessions();
  const switched = getSession("codex", sessionId);
  assert.equal(switched?.source_path, older);
  assert.match(switched?.summary ?? "", /OLD_NOW_LIVE/);
  await fs.rm(older);
  const kept = await syncChangedSessions();
  assert.equal(kept.pruned, 0);
  const fallback = getSession("codex", sessionId);
  assert.equal(fallback?.source_path, newer);
  assert.match(fallback?.summary ?? "", /LIVE_TAIL_2/);
});

test("vault failure aborts incremental sync without rewriting the index", async () => {
  await rebuildIndex();
  const before = getSession("grok", grokSid);
  assert.ok(before);
  const vault = hubPaths().vaultBin;
  await fs.mkdir(path.dirname(vault), { recursive: true });
  await fs.writeFile(vault, "not-ciphertext");
  try {
    await assert.rejects(syncChangedSessions(), /Vault unavailable/);
    const after = getSession("grok", grokSid);
    assert.equal(after?.indexed_at, before.indexed_at);
    assert.equal(after?.title, before.title);
    assert.equal(after?.summary, before.summary);
  } finally {
    await fs.rm(vault, { force: true });
  }
});

test("a held writer lock skips incremental sync", async () => {
  const sid = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const dir = path.join(home, ".grok", "sessions", "lockgroup", sid);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify({
    info: { id: sid, cwd: "/tmp/lock" },
    generated_title: "locked out",
    session_summary: "must stay out",
    updated_at: "2026-09-20T00:00:00.000Z",
  }));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let acquired = false;
  const locking = withHubLock(async () => {
    acquired = true;
    await held;
  });
  const end = Date.now() + 2000;
  while (!acquired && Date.now() < end) await delay(10);
  assert.equal(acquired, true);
  try {
    const report = await syncChangedSessions();
    assert.deepEqual(report, { updated: 0, pruned: 0, skipped: true });
    assert.equal(getSession("grok", sid), null);
  } finally {
    release();
    await locking;
    await fs.rm(path.dirname(dir), { recursive: true, force: true });
  }
});

test("session sync quiet timer collapses a burst and the cap still runs", async () => {
  let n = 0;
  const quiet = startSessionSync({ quietMs: 50, capMs: 1000, run: async () => { n += 1; } });
  quiet.notify();
  quiet.notify();
  await delay(120);
  assert.equal(n, 1);
  quiet.stop();
  const stoppedAt = n;
  quiet.notify();
  await delay(80);
  assert.equal(n, stoppedAt);

  let bursts = 0;
  const capped = startSessionSync({ quietMs: 80, capMs: 150, run: async () => { bursts += 1; } });
  const ticker = setInterval(() => capped.notify(), 30);
  await delay(700);
  clearInterval(ticker);
  capped.stop();
  assert.ok(bursts >= 2);

  let live = 0;
  const running = startSessionSync({ quietMs: 40, capMs: 5000, run: async () => { live += 1; } });
  const again = setInterval(() => running.notify(), 15);
  await delay(400);
  clearInterval(again);
  running.stop();
  assert.ok(live >= 3);
});

test("acceptSnapshot reloads the sessions page only when indexedAt changes", async () => {
  const source = await fs.readFile(new URL("../../web/app.js", import.meta.url), "utf8");
  const calls = { load: 0, render: 0, notice: [] as string[] };
  const context = vm.createContext(i18nSandbox({
    snap: { diskEpoch: 1, sessions: { indexedAt: 10 } },
    currentPage: "sessions",
    renderAll() { calls.render += 1; },
    keepDiskChangedQuiet: () => false,
    notice(key: string) { calls.notice.push(key); },
    loadSessions: async () => { calls.load += 1; },
    banner() {},
  }));
  vm.runInContext(`${await i18nPrelude()}\n${extractFunction(source, "acceptSnapshot")}`, context);
  await context.acceptSnapshot({ diskEpoch: 1, sessions: { indexedAt: 11 } });
  assert.equal(calls.load, 1);
  assert.equal(calls.render, 0);
  assert.deepEqual(calls.notice, []);
  context.currentPage = "overview";
  await context.acceptSnapshot({ diskEpoch: 1, sessions: { indexedAt: 12 } });
  assert.equal(calls.load, 1);
  await context.acceptSnapshot({ diskEpoch: 2, sessions: { indexedAt: 12 } });
  assert.equal(calls.render, 1);
  assert.deepEqual(calls.notice, ["banner.diskChanged"]);
  assert.equal(calls.load, 1);
});
