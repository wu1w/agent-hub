import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { stringify } from "smol-toml";
import { adapter, adapterCommand, agentHome, agentInstallationEvidence, isAgentPresent, supportsHandoff, supportsSessions, supportsVault } from "./adapters.ts";
import { nativeMemoryTarget, memoryLoadingInfo } from "./autoload.ts";
import { applyBind } from "./bind.ts";
import { CURRENT_SCHEMA, defaultConfig, hubPaths, loadConfig, resolvedSkillDir, saveConfig, setBind } from "./config.ts";
import { selectMemoryProject, syncMemoryInjects } from "./deliver.ts";
import { readText, writeText } from "./fsx.ts";
import { identityNativeTarget, syncIdentityNative } from "./identity-native.ts";
import { writeGlobalMemory, writeProjectMemory } from "./memory.ts";
import { AGENT_IDS } from "./types.ts";
import { vaultEnvForAgent, vaultExecArgv } from "./vault.ts";

const keys = ["HOME", "AGENT_HUB_ROOT", "DSH_HOME", "PATH"];
const previous = { ...process.env };
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-deepseek-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, "hub");
  process.env.PATH = "/usr/bin:/bin";
  delete process.env.DSH_HOME;
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});
async function installed() {
  await fs.mkdir(path.join(agentHome("deepseek"), "profiles", "web"), { recursive: true });
}

test("DeepSeek detection requires a runtime marker or dsh executable; a projection is not installation evidence", async () => {
  assert.equal(agentHome("deepseek"), path.join(home, ".dsh"));
  assert.equal(adapterCommand("deepseek"), "dsh");
  await writeText(path.join(agentHome("deepseek"), "AGENTS.md"), "USER\n");
  assert.equal(isAgentPresent("deepseek"), false);
  await assert.rejects(applyBind({ agent: "deepseek", layer: "memory", value: "hub" }), /未检测到安装/);
  await installed();
  assert.equal(agentInstallationEvidence("deepseek").profileEvidence, true);
  assert.equal(isAgentPresent("deepseek"), true);
  await fs.rm(path.join(agentHome("deepseek"), "profiles"), { recursive: true });
  const bin = path.join(home, "bin");
  await writeText(path.join(bin, "dsh"), "#!/bin/sh\nexit 0\n");
  await fs.chmod(path.join(bin, "dsh"), 0o700);
  process.env.PATH = bin;
  assert.equal(agentInstallationEvidence("deepseek").executable, true);
  assert.equal(isAgentPresent("deepseek"), true);
});

test("DSH_HOME redirects native instructions, identity and skill paths", async () => {
  process.env.DSH_HOME = "~/custom-dsh";
  const root = path.join(home, "custom-dsh");
  assert.equal(agentHome("deepseek"), root);
  assert.equal((await nativeMemoryTarget("deepseek"))?.path, path.join(root, "AGENTS.md"));
  assert.equal(resolvedSkillDir("deepseek"), path.join(root, "skills"));
  assert.equal(identityNativeTarget("deepseek")?.path, path.join(root, "AGENTS.md"));
  await installed();
  assert.equal(isAgentPresent("deepseek"), true);
  process.env.DSH_HOME = " ";
  assert.equal(agentHome("deepseek"), path.join(home, ".dsh"));
  assert.equal(isAgentPresent("deepseek"), false);
});

test("existing schema 5 configs gain an Own binding without re-enabling disabled or absent agents", async () => {
  await installed();
  const base = defaultConfig();
  assert.equal(base.agents.enabled.includes("deepseek"), true);
  for (const enabled of [[], ["codex"], AGENT_IDS.filter(id => id !== "deepseek")]) {
    const config = { ...base, schema_version: 5, agents: { enabled }, bind: Object.fromEntries(Object.entries(base.bind).filter(([id]) => id !== "deepseek")) };
    await writeText(hubPaths().config, stringify(config));
    const loaded = await loadConfig();
    assert.equal(loaded.schema_version, CURRENT_SCHEMA);
    assert.deepEqual(loaded.agents.enabled, enabled);
    assert.deepEqual(loaded.bind.deepseek, { skills: "own", ctx: "own", memory: "own", sessions: "own", vault: "off" });
    await saveConfig(loaded);
    assert.deepEqual((await loadConfig()).agents.enabled, enabled);
  }
});

test("DeepSeek memory preserves user instructions, refreshes once and detaches only its block", async () => {
  await installed();
  await writeGlobalMemory("GLOBAL_I18N");
  const target = (await nativeMemoryTarget("deepseek"))!.path;
  await writeText(target, "USER RULE\n");
  await applyBind({ agent: "deepseek", layer: "memory", value: "hub" });
  await writeGlobalMemory("UPDATED_I18N");
  await syncMemoryInjects(undefined, { agent: "deepseek" });
  await syncMemoryInjects(undefined, { agent: "deepseek" });
  assert.equal((await readText(target))!.split("UPDATED_I18N").length, 2);
  assert.doesNotMatch((await readText(target))!, /GLOBAL_I18N/);
  assert.equal((await memoryLoadingInfo("deepseek")).mode, "global");
  await fs.appendFile(target, "LATER USER EDIT\n");
  await applyBind({ agent: "deepseek", layer: "memory", value: "own" });
  assert.equal(await readText(target), "USER RULE\nLATER USER EDIT\n");
  assert.equal(await readText(adapter("deepseek").memoryInjectPath(home)), null);
});

test("DeepSeek workspace memory stays scoped and preserves the independent CLAUDE.md candidate", async () => {
  await installed();
  await writeGlobalMemory("GLOBAL_I18N");
  const workspace = path.join(home, "project");
  await writeText(path.join(workspace, "CLAUDE.md"), "CLAUDE USER RULE\n");
  await writeProjectMemory("alpha", "PRIVATE_PROJECT");
  await applyBind({ agent: "deepseek", layer: "memory", value: "hub" });
  await selectMemoryProject("deepseek", "alpha", workspace);
  assert.match((await readText(path.join(workspace, "AGENTS.md")))!, /PRIVATE_PROJECT/);
  assert.doesNotMatch((await readText((await nativeMemoryTarget("deepseek"))!.path))!, /PRIVATE_PROJECT/);
  assert.equal(await readText(path.join(workspace, "CLAUDE.md")), "CLAUDE USER RULE\n");
  await applyBind({ agent: "deepseek", layer: "memory", value: "own" });
  assert.equal(await readText(path.join(workspace, "AGENTS.md")), null);
  assert.equal(await readText(path.join(workspace, "CLAUDE.md")), "CLAUDE USER RULE\n");
});

test("DeepSeek skills mount existing Hub bundles without moving native skills", async () => {
  await installed();
  const hubSkill = path.join(hubPaths().skills, "hub-example");
  const ownSkill = path.join(resolvedSkillDir("deepseek"), "own-example");
  await writeText(path.join(hubSkill, "SKILL.md"), "---\nname: hub-example\ndescription: Example Hub skill\n---\nHUB\n");
  await writeText(path.join(ownSkill, "SKILL.md"), "---\nname: own-example\ndescription: Own skill\n---\nOWN\n");
  await applyBind({ agent: "deepseek", layer: "skills", value: "hub", skillsMode: "link-existing" });
  const mounted = path.join(resolvedSkillDir("deepseek"), "hub-example");
  assert.equal(await fs.realpath(mounted), await fs.realpath(hubSkill));
  assert.equal((await fs.lstat(ownSkill)).isSymbolicLink(), false);
  assert.match((await readText(path.join(ownSkill, "SKILL.md")))!, /OWN/);
  await applyBind({ agent: "deepseek", layer: "skills", value: "own", skillsMode: "unlink" });
  assert.equal(await readText(path.join(mounted, "SKILL.md")), null);
  assert.match((await readText(path.join(ownSkill, "SKILL.md")))!, /OWN/);
});

test("DeepSeek identity and memory use separate additive blocks in the native global file", async () => {
  await installed();
  await writeGlobalMemory("GLOBAL_I18N");
  const target = (await nativeMemoryTarget("deepseek"))!.path;
  await writeText(target, "USER RULE\n");
  await syncIdentityNative("deepseek", "IDENTITY RULE");
  await applyBind({ agent: "deepseek", layer: "memory", value: "hub" });
  await syncIdentityNative("deepseek", "NEW IDENTITY RULE");
  assert.match((await readText(target))!, /GLOBAL_I18N/);
  assert.match((await readText(target))!, /NEW IDENTITY RULE/);
  await applyBind({ agent: "deepseek", layer: "memory", value: "own" });
  assert.match((await readText(target))!, /NEW IDENTITY RULE/);
  assert.match((await readText(target))!, /USER RULE/);
});

test("DeepSeek rejects unverified Ctx, session and vault capabilities", async () => {
  await installed();
  assert.equal(supportsSessions("deepseek"), false);
  assert.equal(supportsHandoff("deepseek"), false);
  assert.equal(supportsVault("deepseek"), false);
  await assert.rejects(applyBind({ agent: "deepseek", layer: "ctx", value: "hub" }), /不支持 Ctx=Hub/);
  await assert.rejects(applyBind({ agent: "deepseek", layer: "sessions", value: "index" }), /尚无会话扫描器/);
  await assert.rejects(applyBind({ agent: "deepseek", layer: "vault", value: "hub" }), /尚不支持 Vault/);
  await assert.rejects(setBind("deepseek", "vault", "own"), /尚不支持 Vault/);
  const config = await loadConfig();
  config.bind.deepseek.vault = "hub";
  await writeText(hubPaths().config, stringify(config));
  await assert.rejects(loadConfig(), /尚不支持 Vault/);
});

test("unsupported Vault agents cannot obtain an exec plan or run with an empty Vault environment", async () => {
  for (const agent of ["deepseek", "doubao"] as const) {
    assert.throws(() => vaultExecArgv(agent, [adapterCommand(agent)]), /尚不支持 Vault/);
    await assert.rejects(vaultEnvForAgent(agent), /尚不支持 Vault/);
  }
  assert.deepEqual(vaultExecArgv("grok", ["grok", "--help"]), ["hub", "vault", "exec", "--for", "grok", "--", "grok", "--help"]);
});
