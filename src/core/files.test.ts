import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { allowedRead, listIdentityBackups, restoreIdentity, writeAllowed } from "./files.ts";
import { writeHubSkill } from "./skills.ts";
import { ensureHub, hubPaths } from "./config.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-files-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  await fs.mkdir(path.join(home, ".grok", "agents"), { recursive: true });
  await ensureHub();
});

after(async () => {
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("skill and subagent names cannot escape their directories", async () => {
  await assert.rejects(() => allowedRead("skill", undefined, "../vault"), /invalid skill/);
  assert.equal(await allowedRead("skill", undefined, "a/b"), path.join(hubPaths().skills, "a/b/SKILL.md"));
  await assert.rejects(() => allowedRead("skill", undefined, "a/../b"), /invalid skill/);
  await assert.rejects(() => allowedRead("subagent", "grok", "../../IDENTITY.md"), /invalid subagent/);
  await assert.rejects(() => allowedRead("memory", undefined, "../USER"), /invalid memory/);
});

test("agents-md requires an absolute cwd", async () => {
  await assert.rejects(() => allowedRead("agents-md", undefined, "relative/repo"), /must be absolute/);
  const repo = path.join(home, "repo");
  await fs.mkdir(repo, { recursive: true });
  const written = await writeAllowed("agents-md", "# repo\n", undefined, repo);
  assert.equal(written.path, path.join(repo, "AGENTS.md"));
  const read = await allowedRead("agents-md", undefined, repo);
  assert.equal(read, path.join(repo, "AGENTS.md"));
});

test("writeAllowed skill uses the same vendor/outside boundary as writeHubSkill", async () => {
  const vendor = path.join(home, ".grok", "bundled", "skills", "vendor-demo");
  await fs.mkdir(vendor, { recursive: true });
  await fs.writeFile(path.join(vendor, "SKILL.md"), "# vendor original\n", "utf8");
  const hubLink = path.join(hubPaths().skills, "vendor-demo");
  await fs.mkdir(path.dirname(hubLink), { recursive: true });
  await fs.symlink(vendor, hubLink);
  await assert.rejects(() => writeHubSkill("vendor-demo", "# overwritten\n"), /vendor|vault|outside/i);
  await assert.rejects(() => writeAllowed("skill", "# overwritten\n", undefined, "vendor-demo"), /vendor|vault|outside/i);
  assert.equal(await fs.readFile(path.join(vendor, "SKILL.md"), "utf8"), "# vendor original\n");
  await fs.unlink(hubLink);
});

test("identity save writes a backup that restore can apply", async () => {
  const identity = path.join(home, ".grok", "IDENTITY.md");
  await fs.writeFile(identity, "# original identity\n", "utf8");
  await writeAllowed("identity", "# changed identity\n", "grok");
  assert.match((await fs.readFile(path.join(home, ".grok", "rules", "hub-identity.md"), "utf8")), /changed identity/);
  const bakDir = path.join(hubPaths().backups, "identity", "grok");
  const names = await fs.readdir(bakDir);
  assert.ok(names.some((name) => name.endsWith(".md")));
  const restored = await restoreIdentity("grok");
  assert.equal(await fs.readFile(identity, "utf8"), "# original identity\n");
  assert.match(await fs.readFile(path.join(home, ".grok", "rules", "hub-identity.md"), "utf8"), /original identity/);
  assert.equal(restored.path, identity);
});

test("restoreIdentity can apply a named backup, including soul", async () => {
  const identity = path.join(home, ".grok", "IDENTITY.md");
  const soul = path.join(home, ".workbuddy", "SOUL.md");
  await fs.mkdir(path.dirname(soul), { recursive: true });
  await fs.writeFile(identity, "# named-v1\n", "utf8");
  await writeAllowed("identity", "# named-v2\n", "grok");
  const listed = (await listIdentityBackups("grok")).filter((item) => item.kind === "identity");
  const named = listed[listed.length - 1];
  assert.ok(named);
  await writeAllowed("identity", "# named-v3\n", "grok");
  const restored = await restoreIdentity("grok", named.name);
  assert.equal(await fs.readFile(identity, "utf8"), "# named-v1\n");
  assert.equal(restored.from, named.path);

  await fs.writeFile(soul, "SOUL_V1\n", "utf8");
  await writeAllowed("soul", "SOUL_V2\n", "workbuddy");
  const soulBak = (await listIdentityBackups("workbuddy")).find((item) => item.kind === "soul");
  assert.ok(soulBak);
  const soulRestored = await restoreIdentity("workbuddy", soulBak.name);
  assert.equal(soulRestored.kind, "soul");
  assert.equal(await fs.readFile(soul, "utf8"), "SOUL_V1\n");
});
