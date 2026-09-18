import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyBind } from "./bind.ts";
import { hubPaths, loadConfig, saveConfig, setBind } from "./config.ts";
import { selectMemoryProject, workspaceMemoryPath, syncMemoryInjects } from "./deliver.ts";
import { listIdentityBackups, restoreIdentity, writeAllowed } from "./files.ts";
import { writeProjectMemory } from "./memory.ts";
import { closeSessionIndex, getSession, rebuildIndex } from "./sessions.ts";
import { adoptSkills, setSkillTargets, skillRecords } from "./skills.ts";
import { saveVaultFromMarkdown, vaultCatalogFor } from "./vault.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-r2-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;
const prevKey = process.env.AGENT_HUB_VAULT_KEY;

async function put(target: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
}

async function exists(target: string): Promise<boolean> {
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

test("R2 conflict plan does not move other Own skills or change bind", async () => {
  const p = hubPaths();
  await put(path.join(p.skills, "clash", "SKILL.md"), "# hub\n");
  await put(path.join(home, ".workbuddy", "skills", "clash", "SKILL.md"), "# own\n");
  await put(path.join(home, ".workbuddy", "skills", "unique", "SKILL.md"), "# unique\n");
  const result = await applyBind({ agent: "workbuddy", layer: "skills", value: "hub", skillsMode: "adopt" });
  assert.ok((result.extra as { conflicts: unknown[] }).conflicts.length >= 1);
  assert.equal(result.config.bind.workbuddy.skills, "own");
  assert.equal(await exists(path.join(home, ".workbuddy", "skills", "unique")), true);
  assert.equal(await exists(path.join(home, ".grok", "skills", "unique")), false);
});

test("R2b a unique Own skill adopts and commits Hub bind", async () => {
  await fs.rm(path.join(home, ".workbuddy", "skills", "clash"), { recursive: true, force: true });
  await put(path.join(home, ".workbuddy", "skills", "only-new", "SKILL.md"), "# unique\n");
  const result = await applyBind({ agent: "workbuddy", layer: "skills", value: "hub", skillsMode: "adopt" });
  assert.equal((result.extra as { conflicts: unknown[] }).conflicts.length, 0);
  assert.equal(result.config.bind.workbuddy.skills, "hub");
  assert.equal(await exists(path.join(hubPaths().skills, "only-new", "SKILL.md")), true);
  assert.equal((await fs.lstat(path.join(home, ".workbuddy", "skills", "only-new"))).isSymbolicLink(), true);
});

test("R3 soul backup restores SOUL.md not Identity", async () => {
  await put(path.join(home, ".workbuddy", "IDENTITY.md"), "IDENTITY_ORIGINAL");
  await put(path.join(home, ".workbuddy", "SOUL.md"), "SOUL_ORIGINAL");
  await writeAllowed("soul", "SOUL_CHANGED", "workbuddy");
  const backups = await listIdentityBackups("workbuddy");
  const soul = backups.find((item) => item.kind === "soul");
  assert.ok(soul);
  const restored = await restoreIdentity("workbuddy", soul.name);
  assert.equal(restored.kind, "soul");
  assert.equal(await fs.readFile(path.join(home, ".workbuddy", "IDENTITY.md"), "utf8"), "IDENTITY_ORIGINAL");
  assert.equal(await fs.readFile(path.join(home, ".workbuddy", "SOUL.md"), "utf8"), "SOUL_ORIGINAL");
});

test("R4 explicit wildcard is stored and enables every Hub agent", async () => {
  const p = hubPaths();
  const cfg = await loadConfig();
  cfg.layers.skills.default_targets = ["grok"];
  await saveConfig(cfg);
  await put(path.join(p.skills, "demo", "SKILL.md"), "# demo\n");
  await setSkillTargets("demo", ["*"]);
  const rec = (await skillRecords(await loadConfig())).find((item) => item.name === "demo");
  assert.deepEqual(rec?.targets, ["*"]);
  assert.equal(rec?.links.cursor, "linked");
});

test("R5 Vault Hub bind injects already-granted catalog entries", async () => {
  await saveVaultFromMarkdown("# Vault\n\n## synthetic\n说明: testing\n密钥: synthetic-secret\n", {
    synthetic: ["grok"],
  });
  await applyBind({ agent: "grok", layer: "vault", value: "hub" });
  assert.equal((await vaultCatalogFor("grok")).length, 1);
  const catalog = await fs.readFile(path.join(home, ".grok", "memory", "hub-generated-vault.md"), "utf8");
  assert.match(catalog, /`synthetic`/);
});

test("R6 vault decrypt failure aborts indexing without writing session text", async () => {
  const secret = "synthetic-fail-open-12345";
  await saveVaultFromMarkdown(`# Vault\n\n## synthetic\n密钥: ${secret}\n`);
  await put(
    path.join(home, ".grok", "sessions", "group", "sid", "summary.json"),
    JSON.stringify({ info: { id: "sid", cwd: home }, generated_title: "example", session_summary: secret }),
  );
  process.env.AGENT_HUB_VAULT_KEY = randomBytes(32).toString("hex");
  await assert.rejects(rebuildIndex("grok"), /保险库暂不可用/);
  assert.equal(getSession("grok", "sid"), null);
});

test("R7 internal vendor SKILL.md symlink is not adopted or rewritten", async () => {
  const vendor = path.join(home, ".grok", "bundled", "skills", "vendor", "SKILL.md");
  await put(vendor, "---\nname: vendor\n---\n\nVENDOR_ORIGINAL");
  await fs.mkdir(path.join(home, ".grok", "skills", "alias"), { recursive: true });
  await fs.symlink(vendor, path.join(home, ".grok", "skills", "alias", "SKILL.md"));
  const report = await adoptSkills();
  assert.ok(report.skipped.some((item) => item.name === "alias") || report.moved.includes("alias") === false);
  assert.equal(await exists(path.join(hubPaths().skills, "alias")), false);
  await assert.rejects(() => setSkillTargets("alias", ["grok"]));
  assert.equal(await fs.readFile(vendor, "utf8"), "---\nname: vendor\n---\n\nVENDOR_ORIGINAL");
});

test("R8 saving global memory keeps the last selected project snippet", async () => {
  await setBind("grok", "memory", "hub");
  await writeProjectMemory("alpha", "ALPHA_ONLY");
  const workspace = path.join(home, "alpha-workspace");
  await fs.mkdir(workspace);
  await selectMemoryProject("grok", "alpha", workspace);
  const dest = workspaceMemoryPath("grok", workspace);
  assert.match(await fs.readFile(dest, "utf8"), /ALPHA_ONLY/);
  await syncMemoryInjects();
  assert.match(await fs.readFile(dest, "utf8"), /ALPHA_ONLY/);
});
