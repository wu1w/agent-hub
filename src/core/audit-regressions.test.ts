import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyBind } from "./bind.ts";
import { hubPaths, loadConfig, saveConfig } from "./config.ts";
import { injectCtx } from "./deliver.ts";
import { HubError } from "./errors.ts";
import { writeAllowed } from "./files.ts";
import { createHandoff, resumePlan } from "./handoff.ts";
import { composeInject, importNativeMemory, writeProjectMemory } from "./memory.ts";
import { closeSessionIndex, getSession, rebuildIndex } from "./sessions.ts";
import {
  adoptSkills,
  listHubSkills,
  relinkHubSkills,
  repairLinks,
  setSkillTargets,
  skillRecords,
  writeHubSkill,
} from "./skills.ts";
import { agentSnapshots } from "./snapshot.ts";
import { saveVaultFromMarkdown } from "./vault.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-audit-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;
const prevKey = process.env.AGENT_HUB_VAULT_KEY;

async function put(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function has(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = randomBytes(32).toString("hex");
  for (const dir of [".grok", ".cursor", ".codex", ".grok-hyper", ".workbuddy"]) {
    await fs.mkdir(path.join(home, dir, dir === ".cursor" ? "projects" : "sessions"), { recursive: true });
  }
});

after(async () => {
  closeSessionIndex();
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  if (prevKey) process.env.AGENT_HUB_VAULT_KEY = prevKey;
  else delete process.env.AGENT_HUB_VAULT_KEY;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("F01 excluded hub skill is unlinked and status matches", async () => {
  const p = hubPaths();
  await put(path.join(p.skills, "demo", "SKILL.md"), "---\nname: demo\n---\n\n# demo\n");
  await relinkHubSkills();
  await setSkillTargets("demo", ["grok"]);
  assert.equal(await has(path.join(home, ".cursor", "skills", "demo")), false);
  const rec = (await skillRecords(await loadConfig())).find((item) => item.name === "demo");
  assert.equal(rec?.links.cursor, "excluded");
  assert.equal(rec?.links.grok, "linked");
});

test("F02 default_targets apply when hub.targets is absent", async () => {
  const cfg = await loadConfig();
  cfg.layers.skills.default_targets = ["grok"];
  await saveConfig(cfg);
  const p = hubPaths();
  await put(path.join(p.skills, "defaults", "SKILL.md"), "# defaults\n");
  await relinkHubSkills();
  assert.equal(await has(path.join(home, ".grok", "skills", "defaults")), true);
  assert.equal(await has(path.join(home, ".cursor", "skills", "defaults")), false);
  const rec = (await skillRecords(await loadConfig())).find((item) => item.name === "defaults");
  assert.equal(rec?.links.cursor, "excluded");
  assert.equal(rec?.links.grok, "linked");
});

test("F03 global adopt leaves Skills=Own content in place", async () => {
  const dir = path.join(home, ".workbuddy", "skills", "private");
  await put(path.join(dir, "SKILL.md"), "---\nname: private\n---\n\n# private\n");
  await adoptSkills("adopt");
  assert.equal((await fs.lstat(dir)).isDirectory(), true);
  assert.equal(await has(path.join(hubPaths().skills, "private")), false);
});

test("F04 repair does not replace a valid foreign symlink", async () => {
  const cfg = await loadConfig();
  cfg.layers.skills.default_targets = ["*"];
  await saveConfig(cfg);
  const p = hubPaths();
  await put(path.join(p.skills, "shared", "SKILL.md"), "---\nname: shared\n---\n\n# shared\n");
  await relinkHubSkills();
  const external = path.join(home, "external-shared");
  await put(path.join(external, "SKILL.md"), "# external\n");
  const dest = path.join(home, ".cursor", "skills", "shared");
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.unlink(dest);
  } catch {
    // missing is fine
  }
  await fs.symlink(external, dest);
  await repairLinks();
  assert.equal(await fs.realpath(dest), await fs.realpath(external));
  const rec = (await skillRecords(await loadConfig())).find((item) => item.name === "shared");
  assert.equal(rec?.links.cursor, "conflict");
});

test("F05 vendor symlink is not adopted and cannot be written via Hub", async () => {
  const vendor = path.join(home, ".grok", "bundled", "skills", "vendor-demo");
  await put(path.join(vendor, "SKILL.md"), "# vendor original\n");
  const mount = path.join(home, ".grok", "skills", "vendor-demo");
  await fs.mkdir(path.dirname(mount), { recursive: true });
  try {
    await fs.unlink(mount);
  } catch {
    // missing
  }
  await fs.symlink(vendor, mount);
  const report = await adoptSkills("adopt");
  assert.ok(report.skipped.some((item) => item.name === "vendor-demo"));
  assert.equal(await has(path.join(hubPaths().skills, "vendor-demo")), false);
  const hubLink = path.join(hubPaths().skills, "vendor-demo");
  await fs.symlink(vendor, hubLink);
  await assert.rejects(() => writeHubSkill("vendor-demo", "# overwritten\n"), /vendor|vault|outside/i);
  await assert.rejects(() => writeAllowed("skill", "# overwritten\n", undefined, "vendor-demo"), /vendor|vault|outside/i);
  assert.equal(await fs.readFile(path.join(vendor, "SKILL.md"), "utf8"), "# vendor original\n");
  await fs.unlink(hubLink);
});

test("F06 composeInject only includes the selected project", async () => {
  await writeProjectMemory("alpha", "ALPHA_ONLY");
  await writeProjectMemory("beta", "BETA_ONLY");
  const alpha = await composeInject("alpha");
  assert.match(alpha, /ALPHA_ONLY/);
  assert.doesNotMatch(alpha, /BETA_ONLY/);
  const globalOnly = await composeInject();
  assert.doesNotMatch(globalOnly, /ALPHA_ONLY/);
  assert.doesNotMatch(globalOnly, /BETA_ONLY/);
});

test("F07 Hyper Ctx=Hub writes USER.md", async () => {
  const dest = await injectCtx("hyper");
  assert.ok(dest?.endsWith("USER.md"));
  const text = await fs.readFile(dest!, "utf8");
  assert.match(text, /hub-generated: agent-hub/);
  assert.equal(await has(path.join(home, ".grok-hyper", "AGENT.md")), false);
});

test("F08 identity save backs up the previous file", async () => {
  const identity = path.join(home, ".grok", "IDENTITY.md");
  await put(identity, "# original\n");
  await writeAllowed("identity", "# changed\n", "grok");
  const bakDir = path.join(hubPaths().backups, "identity", "grok");
  const names = await fs.readdir(bakDir);
  assert.ok(names.some((name) => name.endsWith(".md")));
  assert.equal(await fs.readFile(identity, "utf8"), "# changed\n");
});

test("F09 known vault secrets are redacted in the session index and handoff", async () => {
  const secret = "audit-fake-secret-09876";
  await saveVaultFromMarkdown(`# Vault\n\n## test\n说明: synthetic\n密钥: ${secret}\n`);
  const sid = "audit-session";
  await put(
    path.join(home, ".grok", "sessions", encodeURIComponent(home), sid, "summary.json"),
    JSON.stringify({
      info: { id: sid, cwd: home },
      generated_title: "synthetic",
      session_summary: `talked about ${secret}`,
    }),
  );
  await rebuildIndex("grok");
  const row = getSession("grok", sid);
  assert.ok(row);
  assert.doesNotMatch(row.summary, new RegExp(secret));
  assert.match(row.summary, /\*\*\*/);
  const hand = await createHandoff({ from: "grok", to: "codex", sessionId: sid });
  assert.doesNotMatch(hand.markdown, new RegExp(secret));
});

test("F10 cross-agent grok argv carries the handoff path", () => {
  const plan = resumePlan({
    from: "cursor",
    to: "grok",
    sessionId: "s1",
    cwd: home,
    handoffPath: "/tmp/example-handoff.md",
  });
  assert.ok(plan.argv.includes("--prompt-file"));
  assert.ok(plan.argv.includes("/tmp/example-handoff.md"));
  const same = resumePlan({
    from: "grok",
    to: "grok",
    sessionId: "s1",
    cwd: home,
    handoffPath: "/tmp/example-handoff.md",
  });
  assert.ok(same.argv.includes("--resume"));
  assert.ok(same.argv.includes("--prompt-file"));
});

test("F12 explicit empty enabled list stays empty and snapshots follow it", async () => {
  const cfg = await loadConfig();
  cfg.agents.enabled = [];
  await saveConfig(cfg);
  const loaded = await loadConfig();
  assert.deepEqual(loaded.agents.enabled, []);
  assert.equal((await agentSnapshots(loaded)).length, 0);
  cfg.agents.enabled = ["grok", "cursor", "codex", "hyper", "workbuddy"];
  await saveConfig(cfg);
});

test("F13 Own→Hub requires an explicit mode and failed inject does not commit bind", async () => {
  await assert.rejects(
    () => applyBind({ agent: "workbuddy", layer: "skills", value: "hub" }),
    (err: unknown) => err instanceof HubError && err.status === 400,
  );
  assert.equal((await loadConfig()).bind.workbuddy.skills, "own");

  await fs.mkdir(path.join(home, ".grok", "memory", "hub-generated.md"), { recursive: true });
  await assert.rejects(
    () => applyBind({ agent: "grok", layer: "memory", value: "hub" }),
    (err: unknown) => err instanceof HubError && err.status === 409,
  );
  assert.equal((await loadConfig()).bind.grok.memory, "own");
});

test("nested vendor skills are discovered and native memory import is one-shot", async () => {
  const nested = path.join(home, ".codex", "plugins", "cache", "pack", "nested-skill", "SKILL.md");
  await put(nested, "---\nname: nested-skill\n---\n\n# nested\n");
  const { scanVendorSkills } = await import("./skills.ts");
  const vendors = await scanVendorSkills(await loadConfig());
  assert.ok(vendors.some((item) => item.name === "nested-skill"));

  await put(path.join(home, ".workbuddy", "memory", "journal.md"), "# wb memory\nWB_NATIVE\n");
  const imported = await importNativeMemory("workbuddy");
  assert.ok(imported.imported.some((id) => id.includes("journal")));
  const again = await importNativeMemory("workbuddy");
  assert.ok(again.skipped.some((id) => id.includes("journal")));
  const text = await fs.readFile(
    path.join(hubPaths().memoryProjects, `${imported.imported[0]}.md`),
    "utf8",
  );
  assert.match(text, /WB_NATIVE/);
});

test("hyper config.toml skills.dir is honored", async () => {
  const custom = path.join(home, "hyper-skills");
  await put(path.join(home, ".grok-hyper", "config.toml"), `[skills]\ndir = "${custom}"\n`);
  const { resolvedSkillDir } = await import("./config.ts");
  assert.equal(resolvedSkillDir("hyper", home), custom);
});

test("hub skill list still contains adopted user skills after regressions", async () => {
  const listed = await listHubSkills();
  assert.ok(listed.some((item) => item.name === "demo"));
});
