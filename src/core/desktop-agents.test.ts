import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { agentHome, adapter, isAgentPresent } from "./adapters.ts";
import { nativeMemoryTarget, memoryLoadingInfo } from "./autoload.ts";
import { applyBind } from "./bind.ts";
import { loadConfig, saveConfig, hubPaths } from "./config.ts";
import { syncMemoryInjects, selectMemoryProject, workspaceMemoryPath } from "./deliver.ts";
import { readText, writeText } from "./fsx.ts";
import { writeGlobalMemory, writeProjectMemory } from "./memory.ts";
import { AGENT_IDS } from "./types.ts";
const ids = ["zcode", "grokbot", "doubao", "kimi"] as const;
const keys = ["HOME", "AGENT_HUB_ROOT", "KIMI_CODE_HOME", "PATH"];
const previous = { ...process.env };
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-desktop-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, "hub");
  process.env.PATH = "/usr/bin:/bin";
  delete process.env.KIMI_CODE_HOME;
  await writeGlobalMemory("GLOBAL_I18N");
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});
async function installed() {
  await writeText(path.join(agentHome("zcode"), "v2/settings.json"), "{}");
  await writeText(path.join(agentHome("grokbot"), "settings.json"), "{}");
  await fs.mkdir(path.join(agentHome("doubao"), "chats"), { recursive: true });
  await writeText(path.join(agentHome("kimi"), "config.toml"), "");
}
test("new agents default Own and absent clients are not manufactured", async () => {
  for (const agent of ids) {
    assert.equal((await loadConfig()).bind[agent].memory, "own");
    assert.equal(isAgentPresent(agent), false);
    await assert.rejects(applyBind({ agent, layer: "memory", value: "hub" }), /未检测到安装/);
    assert.equal(await readText(adapter(agent).memoryInjectPath(home)), null);
    await assert.rejects(applyBind({ agent, layer: "skills", value: "hub" }), /仅支持 Memory/);
  }
});
test("schema 3 complete catalog is not silently expanded; subsets stay", async () => {
  const c = await loadConfig();
  c.schema_version = 3;
  c.agents.enabled = AGENT_IDS.filter(id => !ids.includes(id as typeof ids[number]));
  c.bind.codex.memory = "hub";
  await saveConfig(c);
  assert.deepEqual((await loadConfig()).agents.enabled, AGENT_IDS.filter(id => !ids.includes(id as typeof ids[number])));
  assert.equal((await loadConfig()).bind.codex.memory, "hub");
  for (const enabled of [["codex"] as const, []]) {
    c.agents.enabled = [...enabled]; await saveConfig(c);
    assert.deepEqual((await loadConfig()).agents.enabled, enabled);
  }
});
test("ZCode and Kimi preserve user instructions, sync idempotently and detach", async () => {
  process.env.KIMI_CODE_HOME = path.join(home, "custom-kimi");
  await installed();
  assert.equal(agentHome("kimi"), process.env.KIMI_CODE_HOME);
  for (const agent of ["zcode", "kimi"] as const) {
    const target = (await nativeMemoryTarget(agent))!.path;
    await writeText(target, "USER RULE\n");
    await applyBind({ agent, layer: "memory", value: "hub" });
    await syncMemoryInjects();
    assert.equal((await readText(target))!.split("GLOBAL_I18N").length, 2);
    await fs.appendFile(target, "LATER EDIT\n");
    await applyBind({ agent, layer: "memory", value: "own" });
    assert.equal(await readText(target), "USER RULE\nLATER EDIT\n");
  }
});
test("manual clients export under relocated Hub, without claiming native loading", async () => {
  await installed();
  const workspace = path.join(home, "project"); await fs.mkdir(workspace);
  await writeProjectMemory("alpha", "PRIVATE_PROJECT");
  for (const agent of ["grokbot", "doubao"] as const) {
    await applyBind({ agent, layer: "memory", value: "hub" });
    const file = adapter(agent).memoryInjectPath(home);
    assert.ok(file.startsWith(hubPaths().root + path.sep));
    assert.match((await readText(file))!, /GLOBAL_I18N/);
    assert.equal(await nativeMemoryTarget(agent), null);
    assert.equal(await nativeMemoryTarget(agent, workspace), null);
    assert.equal((await memoryLoadingInfo(agent)).mode, "manual");
    await selectMemoryProject(agent, "alpha", workspace);
    assert.match((await readText(workspaceMemoryPath(agent, workspace)))!, /PRIVATE_PROJECT/);
    assert.doesNotMatch((await readText(file))!, /PRIVATE_PROJECT/);
    await writeGlobalMemory("UPDATED_I18N");
    await syncMemoryInjects();
    assert.match((await readText(file))!, /UPDATED_I18N/);
    await applyBind({ agent, layer: "memory", value: "own" });
    assert.equal(await readText(file), null);
    assert.equal(await readText(workspaceMemoryPath(agent, workspace)), null);
    assert.equal(await readText(path.join(agentHome(agent), "AGENTS.md")), null);
    await writeGlobalMemory("GLOBAL_I18N");
  }
});
