import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { assetSourceSignature, startAssetSync, type AssetSyncHandle, type AssetSyncLayer } from "./asset-sync.ts";
import { ensureHub, hubPaths, setBind } from "./config.ts";

const previous = { ...process.env };
let home: string;
const handles: AssetSyncHandle[] = [];
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function put(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}

function start(options: Parameters<typeof startAssetSync>[0] = {}): AssetSyncHandle {
  const handle = startAssetSync({ pollMs: 60_000, ...options });
  handles.push(handle);
  return handle;
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-assets-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  // Native overrides from the real shell must not escape this isolated test home.
  for (const key of ["GROK_HOME", "CODEX_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR"]) delete process.env[key];
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await ensureHub();
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => handle.stop()));
  await fs.rm(home, { recursive: true, force: true });
  for (const key of ["HOME", "AGENT_HUB_ROOT", "GROK_HOME", "CODEX_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("asset sync delivers direct source edits, leaves Own content, and skips unchanged inputs", async () => {
  await setBind("grok", "memory", "hub");
  await setBind("grok", "ctx", "hub");
  await setBind("codex", "skills", "own");
  const own = path.join(home, ".codex", "AGENTS.md");
  await put(own, "local Codex rules\n");
  const p = hubPaths();
  await put(p.memoryGlobal, "# Shared\n\ni18n enabled\n");
  await put(p.userMd, "# User\n\nEnglish preferred\n");
  const skill = path.join(p.skills, "group", "hello", "SKILL.md");
  await put(skill, "---\nname: hello\ndescription: greeting\n---\n\nHello\n");
  const handle = start();
  await handle.runNow();
  const native = path.join(home, ".grok", "rules", "hub-memory.md");
  const ctx = path.join(home, ".grok", "USER.md");
  const linked = path.join(home, ".grok", "skills", "group", "hello");
  assert.match(await fs.readFile(native, "utf8"), /i18n enabled/);
  assert.match(await fs.readFile(ctx, "utf8"), /English preferred/);
  assert.equal(await fs.realpath(linked), await fs.realpath(path.dirname(skill)));
  assert.equal(await fs.readFile(own, "utf8"), "local Codex rules\n");
  await assert.rejects(fs.lstat(path.join(home, ".codex", "skills", "group", "hello")), { code: "ENOENT" });
  const before = await Promise.all([native, ctx].map(file => fs.stat(file, { bigint: true }).then(stat => stat.mtimeNs)));
  await delay(10);
  await handle.runNow();
  const after = await Promise.all([native, ctx].map(file => fs.stat(file, { bigint: true }).then(stat => stat.mtimeNs)));
  assert.deepEqual(after, before);
  await put(p.memoryGlobal, "# Shared\n\nChanged outside the UI\n");
  await put(p.userMd, "# User\n\nChanged user context\n");
  await put(skill, "---\nname: hello\ndescription: greeting\nhub:\n  targets: []\n---\n\nHello\n");
  await handle.runNow();
  assert.match(await fs.readFile(native, "utf8"), /Changed outside the UI/);
  assert.match(await fs.readFile(ctx, "utf8"), /Changed user context/);
  await assert.rejects(fs.lstat(linked), { code: "ENOENT" });
  assert.equal(await fs.readFile(own, "utf8"), "local Codex rules\n");
  assert.ok(handle.getStatus().lastSyncedAt);
  assert.equal(handle.getStatus().layers.memory.pending, false);
});

test("signatures track project/scope/content/config changes and ignore generated files", async () => {
  const p = hubPaths();
  const first = await assetSourceSignature("memory");
  await put(path.join(p.memory, "autoload.json"), "{}\n");
  await put(path.join(p.memory, "exports", "client.md"), "projection\n");
  assert.equal(await assetSourceSignature("memory"), first);
  await put(path.join(p.memoryProjects, "demo.md"), "project rules\n");
  const project = await assetSourceSignature("memory");
  assert.notEqual(project, first);
  await put(path.join(p.memory, "inject-state.json"), '{"scopes":[]}\n');
  assert.notEqual(await assetSourceSignature("memory"), project);
  const ctx = await assetSourceSignature("ctx");
  const oldTime = (await fs.stat(p.userMd)).mtime;
  await put(p.userMd, "same timestamp, different content\n");
  await fs.utimes(p.userMd, oldTime, oldTime);
  assert.notEqual(await assetSourceSignature("ctx"), ctx);
  const prior = await assetSourceSignature("skills");
  await setBind("grok", "skills", "own");
  assert.notEqual(await assetSourceSignature("skills"), prior);
});

test("source deletion removes Hub mounts but preserves Own and unrelated symlinks", async () => {
  await setBind("codex", "skills", "own");
  const p = hubPaths();
  const source = path.join(p.skills, "group", "deleted");
  const live = path.join(p.skills, "still-here");
  await put(path.join(source, "SKILL.md"), "---\nname: deleted\ndescription: delete test\n---\n");
  await put(path.join(live, "SKILL.md"), "---\nname: still-here\ndescription: keep test\n---\n");
  const handle = start();
  await handle.runNow();
  const grokSkills = path.join(home, ".grok", "skills");
  const mounted = path.join(grokSkills, "group", "deleted");
  const ownLink = path.join(home, ".codex", "skills", "own-deleted");
  const foreign = path.join(grokSkills, "foreign-deleted");
  const similarPrefix = path.join(grokSkills, "similar-prefix");
  const external = path.join(home, "user-library", "deleted");
  await fs.mkdir(path.dirname(ownLink), { recursive: true });
  await fs.symlink(source, ownLink);
  await fs.symlink(external, foreign);
  await fs.symlink(p.skills + "-other/deleted", similarPrefix);
  const localSkill = path.join(grokSkills, "local");
  await put(path.join(localSkill, "SKILL.md"), "---\nname: local\ndescription: own local data\n---\n");
  const localReference = path.join(localSkill, "source-ref");
  await fs.symlink(source, localReference);
  const userContainer = path.join(home, "user-container");
  await fs.mkdir(userContainer, { recursive: true });
  const userReference = path.join(userContainer, "user-ref");
  await fs.symlink(source, userReference);
  await fs.symlink(userContainer, path.join(grokSkills, "user-container"));
  // Cover relative link ownership as well as the absolute mounts Hub normally creates.
  const relativeLink = path.join(grokSkills, "relative-deleted");
  await fs.symlink(path.relative(grokSkills, source), relativeLink);
  await fs.rm(source, { recursive: true });
  await handle.runNow();
  for (const removed of [mounted, relativeLink]) await assert.rejects(fs.lstat(removed), { code: "ENOENT" });
  for (const kept of [ownLink, foreign, similarPrefix, localReference, userReference]) {
    assert.equal((await fs.lstat(kept)).isSymbolicLink(), true, kept);
  }
  assert.equal(await fs.realpath(path.join(grokSkills, "still-here")), await fs.realpath(live));
  assert.equal(handle.getStatus().layers.skills.pending, false);
  assert.deepEqual(handle.getStatus().layers.skills.errors, []);
});

test("source deletion never cleans links inside a vendor skill directory", async () => {
  const source = path.join(hubPaths().skills, "deleted");
  await put(path.join(source, "SKILL.md"), "---\nname: deleted\ndescription: test\n---\n");
  const handle = start();
  await handle.runNow();
  const vendorLink = path.join(home, ".codex", "skills", ".system", "vendor-link");
  await fs.mkdir(path.dirname(vendorLink), { recursive: true });
  await fs.symlink(source, vendorLink);
  await fs.rm(source, { recursive: true });
  await handle.runNow();
  await assert.rejects(fs.lstat(path.join(home, ".codex", "skills", "deleted")), { code: "ENOENT" });
  assert.equal((await fs.lstat(vendorLink)).isSymbolicLink(), true);
});

test("partial failures retry only failed layers and are visible until recovery", async () => {
  const calls: Record<AssetSyncLayer, number> = { memory: 0, ctx: 0, skills: 0 };
  let fail = true;
  const handle = start({
    readSignature: async layer => layer,
    onStatus: () => { throw new Error("observer failed"); },
    deliver: async layer => {
      calls[layer] += 1;
      return layer === "memory" && fail ? [{ layer, agent: "grok", error: "target unavailable" }] : [];
    },
  });
  await handle.runNow();
  assert.equal(handle.getStatus().layers.memory.pending, true);
  assert.equal(handle.getStatus().layers.memory.errors[0]?.error, "target unavailable");
  assert.equal(handle.getStatus().lastSyncedAt, null);
  const before = { ...calls };
  fail = false;
  await handle.runNow();
  assert.equal(calls.memory, before.memory + 1);
  assert.equal(calls.ctx, before.ctx);
  assert.equal(calls.skills, before.skills);
  assert.deepEqual(handle.getStatus().layers.memory.errors, []);
  assert.ok(handle.getStatus().lastSyncedAt);
  const detached = handle.getStatus();
  detached.layers.memory.pending = true;
  assert.equal(handle.getStatus().layers.memory.pending, false);
});

test("signature errors do not block other layers and retry without hiding the error", async () => {
  let fail = true;
  const delivered: AssetSyncLayer[] = [];
  const handle = start({
    readSignature: async layer => {
      if (layer === "skills" && fail) throw new Error("invalid skill metadata");
      return layer;
    },
    deliver: async layer => { delivered.push(layer); return []; },
  });
  await handle.runNow();
  assert.deepEqual(delivered, ["memory", "ctx"]);
  assert.equal(handle.getStatus().layers.skills.errors[0]?.error, "invalid skill metadata");
  fail = false;
  await handle.runNow();
  assert.deepEqual(delivered, ["memory", "ctx", "skills"]);
});

test("overlapping requests coalesce and a source edit during delivery is retried", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  let signature = "a", calls = 0, concurrent = 0, peak = 0;
  const handle = start({
    readSignature: async () => signature,
    deliver: async layer => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      if (layer === "memory" && calls++ === 0) { entered(); await gate; }
      concurrent -= 1;
      return [];
    },
  });
  await started;
  const one = handle.runNow(), two = handle.runNow();
  signature = "b";
  release();
  await Promise.all([one, two]);
  assert.equal(peak, 1);
  assert.equal(calls, 2);
  assert.equal(handle.getStatus().layers.memory.pending, false);
});

test("periodic fallback syncs without events and stop prevents further runs", async () => {
  let signature = "a", memory = 0;
  const handle = start({
    pollMs: 15, quietMs: 5,
    readSignature: async () => signature,
    deliver: async layer => { if (layer === "memory") memory += 1; return []; },
  });
  await handle.runNow();
  assert.equal(memory, 1);
  signature = "b";
  const end = Date.now() + 500;
  while (memory < 2 && Date.now() < end) await delay(10);
  assert.equal(memory, 2);
  await handle.stop();
  signature = "c";
  handle.notify();
  await handle.runNow();
  await delay(30);
  assert.equal(memory, 2);
  assert.equal(handle.getStatus().stopped, true);
});

test("stop waits for the current delivery and cancels queued layers", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered: () => void = () => {};
  const started = new Promise<void>(resolve => { entered = resolve; });
  const delivered: AssetSyncLayer[] = [];
  const handle = start({
    readSignature: async layer => layer,
    deliver: async layer => { delivered.push(layer); entered(); await gate; return []; },
  });
  await started;
  void handle.runNow();
  let stopped = false;
  const stopping = handle.stop().then(() => { stopped = true; });
  await delay(5);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.deepEqual(delivered, ["memory"]);
  assert.equal(handle.getStatus().running, false);
});
