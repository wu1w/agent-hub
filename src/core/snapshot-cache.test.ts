import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createSnapshotReadCache } from "./snapshot-cache.ts";
import { ensureHub, hubPaths, setBind } from "./config.ts";
import { closeSessionIndex } from "./sessions.ts";
import { buildCachedSnapshot, buildSnapshot, invalidateSnapshotCache, type Snapshot } from "./snapshot.ts";
import { diskEpoch, noteDiskChange, stopHubWatch } from "./watch.ts";
import { saveVaultFromMarkdown, setVaultGrants, vaultGet } from "./vault.ts";
import { startServer } from "../server.ts";

test("metadata cache coalesces concurrent scans, clones results and bounds freshness", async () => {
  let now = 0, scans = 0;
  const cache = createSnapshotReadCache<{ names: string[] }>({ ttlMs: 60, now: () => now });
  const load = async () => { scans += 1; return { names: [String(scans)] }; };
  const [first, concurrent] = await Promise.all([cache.read("a", load), cache.read("a", load)]);
  assert.equal(scans, 1);
  first.names.push("local mutation");
  assert.deepEqual(concurrent.names, ["1"]);
  now = 59;
  assert.deepEqual((await cache.read("a", load)).names, ["1"]);
  now = 60;
  assert.deepEqual((await cache.read("a", load)).names, ["2"]);
  assert.deepEqual((await cache.read("b", load)).names, ["3"]);
});

test("invalidation while a scan is pending cannot restore an obsolete cache entry", async () => {
  const cache = createSnapshotReadCache<string>({ ttlMs: 60_000 });
  let finish!: (value: string) => void;
  const old = cache.read("same", () => new Promise<string>(resolve => { finish = resolve; }));
  await Promise.resolve();
  cache.invalidate();
  assert.equal(await cache.read("same", async () => "new"), "new");
  finish("old");
  assert.equal(await old, "old");
  assert.equal(await cache.read("same", async () => "unexpected"), "new");
});

test("failed or unavailable scans are retried immediately", async () => {
  const cache = createSnapshotReadCache<string>({ ttlMs: 60_000, cacheable: value => value !== "unavailable" });
  await assert.rejects(cache.read("a", async () => { throw new Error("unreadable"); }), /unreadable/);
  assert.equal(await cache.read("a", async () => "unavailable"), "unavailable");
  assert.equal(await cache.read("a", async () => "recovered"), "recovered");
});

describe("cached snapshot reads", () => {
  const previous = { ...process.env };
  const envKeys = ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY", "GROK_HOME", "CODEX_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR"];
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-snapshot-cache-"));
    for (const key of envKeys) delete process.env[key];
    process.env.HOME = home;
    process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
    process.env.AGENT_HUB_VAULT_KEY = "c3".repeat(32);
    await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
    await ensureHub();
    stopHubWatch();
    invalidateSnapshotCache();
  });

  afterEach(async () => {
    stopHubWatch();
    invalidateSnapshotCache();
    closeSessionIndex();
    await fs.rm(home, { recursive: true, force: true });
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  test("memory and USER reads stay fresh without invalidating metadata", async () => {
    const before = await buildCachedSnapshot();
    await fs.writeFile(hubPaths().memoryGlobal, "fresh memory");
    await fs.writeFile(hubPaths().userMd, "fresh user context");
    const after = await buildCachedSnapshot();
    assert.equal(after.memory.global, "fresh memory");
    assert.equal(after.userMd.content, "fresh user context");
    assert.equal(after.metadataRevision, before.metadataRevision);
  });

  test("external Own changes bypass the cache immediately and revoke vault access", async () => {
    await setBind("grok", "vault", "hub");
    await saveVaultFromMarkdown("# Vault\n\n## demo\n说明: demo service\n密钥: test-secret-value\n");
    await setVaultGrants("demo", ["grok"]);
    const before = await buildCachedSnapshot();
    const epoch = diskEpoch();
    await setBind("grok", "vault", "own");
    await setBind("grok", "skills", "own");
    const after = await buildCachedSnapshot();
    assert.equal(diskEpoch(), epoch);
    assert.equal(after.config.bind.grok.vault, "own");
    assert.equal(after.agents.find(agent => agent.id === "grok")?.bind.skills, "own");
    assert.notEqual(after.metadataRevision, before.metadataRevision);
    await assert.rejects(vaultGet("grok", "demo"), /不是 Hub|未授权/);
    assert.doesNotMatch(JSON.stringify(after), /test-secret-value/);
  });

  test("a newly unavailable vault never reuses a previously readable summary", async () => {
    await saveVaultFromMarkdown("# Vault\n\n## demo\n说明: note\n密钥: test-secret-value\n");
    const before = await buildCachedSnapshot();
    assert.equal(before.vault.count, 1);
    process.env.AGENT_HUB_VAULT_KEY = "b4".repeat(32);
    const unavailable = await buildCachedSnapshot();
    assert.equal(unavailable.vault.status, "unavailable");
    assert.equal(unavailable.vault.count, null);
    assert.deepEqual(unavailable.vault.entries, []);
    process.env.AGENT_HUB_VAULT_KEY = "c3".repeat(32);
    assert.equal((await buildCachedSnapshot()).vault.count, 1);
  });

  test("disk events, explicit invalidation and forced reads refresh metadata", async () => {
    const skill = path.join(hubPaths().skills, "test-skill");
    await fs.mkdir(skill);
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: test-skill\ndescription: first\n---\n");
    const before = await buildCachedSnapshot();
    assert.equal(before.skills[0]?.targets, null);
    before.skills[0]!.name = "caller mutation";
    const cached = await buildCachedSnapshot();
    assert.equal(cached.skills[0]?.name, "test-skill");
    await fs.writeFile(path.join(skill, "SKILL.md"), "---\nname: test-skill\nhub:\n  targets: [grok]\n---\n");
    noteDiskChange();
    const changed = await buildCachedSnapshot();
    assert.deepEqual(changed.skills[0]?.targets, ["grok"]);
    assert.notEqual(changed.metadataRevision, cached.metadataRevision);
    invalidateSnapshotCache();
    assert.equal((await buildCachedSnapshot()).metadataRevision, changed.metadataRevision);
    await fs.rm(skill, { recursive: true });
    assert.equal((await buildSnapshot()).skills.length, 0);
    assert.equal((await buildCachedSnapshot()).skills.length, 0);
  });

  test("an API subagent write invalidates cached metadata even without watchers", async () => {
    const server = await startServer(0);
    try {
      stopHubWatch();
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      const base = `http://127.0.0.1:${addr.port}`;
      const headers = { "x-hub-token": (await fs.readFile(hubPaths().token, "utf8")).trim(), "content-type": "application/json" };
      const before = await (await fetch(`${base}/api/snapshot`, { headers })).json() as Snapshot;
      const write = await fetch(`${base}/api/file?kind=subagent&agent=grok&name=reviewer`, {
        headers, method: "POST", body: JSON.stringify({ content: "name: Reviewer\n" }),
      });
      assert.equal(write.status, 201);
      await write.json();
      const after = await (await fetch(`${base}/api/snapshot`, { headers })).json() as Snapshot;
      assert.ok(after.agents.find(agent => agent.id === "grok")?.subagents.some(sub => sub.name === "reviewer"));
      assert.notEqual(after.metadataRevision, before.metadataRevision);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
