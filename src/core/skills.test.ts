import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { hubPaths, loadConfig } from "./config.ts";
import {
  adoptSkills,
  detachAgentSkills,
  listHubSkills,
  promoteProjectSkill,
  repairLinks,
  resolveSkillConflict,
  scanProjectSkills,
  setSkillTargets,
  skillRecords,
} from "./skills.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  await fs.mkdir(path.join(home, ".grok", "skills", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(home, ".grok", "skills", "demo", "SKILL.md"),
    "---\nname: demo\n---\n\n# demo\n",
  );
  await fs.mkdir(path.join(home, ".cursor", "projects"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".grok-hyper", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".workbuddy", "sessions"), { recursive: true });
});

after(async () => {
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("adopt moves skill into hub and links grok", async () => {
  const report = await adoptSkills("adopt");
  assert.ok(report.moved.includes("demo"));
  const hub = hubPaths();
  const hubSkill = path.join(hub.skills, "demo");
  const grokSkill = path.join(home, ".grok", "skills", "demo");
  const st = await fs.lstat(grokSkill);
  assert.equal(st.isSymbolicLink(), true);
  assert.equal(await fs.realpath(grokSkill), await fs.realpath(hubSkill));
  const listed = await listHubSkills();
  assert.equal(listed.some((item) => item.name === "demo"), true);
});

test("repair recreates a missing hub link", async () => {
  const dest = path.join(home, ".grok", "skills", "demo");
  await fs.unlink(dest);
  await repairLinks();
  const st = await fs.lstat(dest);
  assert.equal(st.isSymbolicLink(), true);
  const hub = hubPaths();
  assert.equal(await fs.realpath(dest), await fs.realpath(path.join(hub.skills, "demo")));
});

test("conflict keep-hub replaces agent copy with symlink", async () => {
  const cursorDemo = path.join(home, ".cursor", "skills", "demo");
  try {
    await fs.unlink(cursorDemo);
  } catch {
    // may be missing
  }
  await fs.mkdir(cursorDemo, { recursive: true });
  await fs.writeFile(path.join(cursorDemo, "SKILL.md"), "---\nname: demo\n---\n\n# agent copy\n");
  const result = await resolveSkillConflict("demo", "hub");
  assert.match(result.resolved, /keep-hub/);
  const st = await fs.lstat(cursorDemo);
  assert.equal(st.isSymbolicLink(), true);
  const hub = hubPaths();
  assert.equal(await fs.realpath(cursorDemo), await fs.realpath(path.join(hub.skills, "demo")));
});

test("promote copies a project skill into hub and leaves the repo copy", async () => {
  const repo = path.join(home, "repo");
  const src = path.join(repo, ".cursor", "skills", "local-hook");
  await fs.mkdir(src, { recursive: true });
  await fs.writeFile(path.join(src, "SKILL.md"), "---\nname: local-hook\n---\n\n# local-hook\n");
  const listed = await scanProjectSkills(repo);
  assert.equal(listed.some((item) => item.name === "local-hook" && !item.inHub), true);
  const result = await promoteProjectSkill(repo, "local-hook");
  assert.equal(result.copied, true);
  const hub = hubPaths();
  const dest = path.join(hub.skills, "local-hook", "SKILL.md");
  assert.equal(await fs.readFile(dest, "utf8"), await fs.readFile(path.join(src, "SKILL.md"), "utf8"));
  const srcStat = await fs.lstat(src);
  assert.equal(srcStat.isSymbolicLink(), false);
  await assert.rejects(() => promoteProjectSkill(repo, "local-hook"), /已有同名/);
});

test("global adopt does not move Skills=Own content", async () => {
  const dir = path.join(home, ".workbuddy", "skills", "private");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: private\n---\n\n# private\n");
  await adoptSkills("adopt");
  assert.equal((await fs.lstat(dir)).isDirectory(), true);
  const hub = hubPaths();
  await assert.rejects(fs.stat(path.join(hub.skills, "private")));
});

test("adopt with only=workbuddy does not require scanning other agents' copies", async () => {
  const dir = path.join(home, ".workbuddy", "skills", "wb-only");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: wb-only\n---\n\n# wb\n");
  const report = await adoptSkills("adopt", "workbuddy");
  assert.ok(report.moved.includes("wb-only"));
  const hub = hubPaths();
  assert.equal(await fs.stat(path.join(hub.skills, "wb-only", "SKILL.md")).then(() => true), true);
  const grokDemo = path.join(home, ".grok", "skills", "demo");
  assert.equal((await fs.lstat(grokDemo)).isSymbolicLink(), true);
});

test("link-existing skips skills that are not in hub", async () => {
  const dir = path.join(home, ".grok", "skills", "solo");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), "---\nname: solo\n---\n\n# solo\n");
  const report = await adoptSkills("link-existing", "grok");
  assert.ok(report.skipped.some((item) => item.name === "solo"));
  const hub = hubPaths();
  await assert.rejects(fs.stat(path.join(hub.skills, "solo")));
});

test("setSkillTargets writes hub.targets and unlinks excluded agents", async () => {
  await setSkillTargets("demo", ["grok"]);
  const config = await loadConfig();
  const rec = (await skillRecords(config)).find((item) => item.name === "demo");
  assert.deepEqual(rec?.targets, ["grok"]);
  assert.equal(rec?.links.cursor, "excluded");
  await assert.rejects(fs.lstat(path.join(home, ".cursor", "skills", "demo")));
});

test("conflict keep-agent replaces hub with the agent copy", async () => {
  const hub = hubPaths();
  const cursorHook = path.join(home, ".cursor", "skills", "local-hook");
  try {
    await fs.unlink(cursorHook);
  } catch {
    await fs.rm(cursorHook, { recursive: true, force: true });
  }
  await fs.mkdir(cursorHook, { recursive: true });
  await fs.writeFile(path.join(cursorHook, "SKILL.md"), "---\nname: local-hook\n---\n\n# cursor edition\n");
  const result = await resolveSkillConflict("local-hook", "agent");
  assert.match(result.resolved, /keep-agent/);
  const md = await fs.readFile(path.join(hub.skills, "local-hook", "SKILL.md"), "utf8");
  assert.match(md, /cursor edition/);
});

test("detach-copy turns a hub symlink into an independent directory", async () => {
  const dest = path.join(home, ".grok", "skills", "demo");
  const changed = await detachAgentSkills("grok", "detach-copy");
  assert.ok(changed.includes("demo"));
  const st = await fs.lstat(dest);
  assert.equal(st.isSymbolicLink(), false);
  assert.equal(st.isDirectory(), true);
});
