import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { agentHome, adapter } from "./adapters.ts";
import { nativeMemoryTarget } from "./autoload.ts";
import { applyBind } from "./bind.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { selectMemoryProject, syncMemoryInjects } from "./deliver.ts";
import { readText } from "./fsx.ts";
import { writeGlobalMemory, writeProjectMemory } from "./memory.ts";
import { AGENT_IDS } from "./types.ts";

const previous = { ...process.env };
let home: string;
let workspace: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-autoload-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  for (const name of ["CODEX_HOME", "GROK_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "KIMI_CODE_HOME"]) delete process.env[name];
  for (const id of AGENT_IDS) await fs.mkdir(path.join(agentHome(id), id === "cursor" ? "projects" : "sessions"), { recursive: true });
  await fs.writeFile(path.join(agentHome("hermes"), "config.yaml"), "{}\n");
  await fs.writeFile(path.join(agentHome("claude"), "settings.json"), "{}\n");
  await fs.mkdir(path.join(agentHome("zcode"), "v2"), { recursive: true });
  workspace = path.join(home, "project");
  await fs.mkdir(workspace);
  await writeGlobalMemory("SYNTHETIC_GLOBAL_421");
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  for (const key of ["HOME", "AGENT_HUB_ROOT", "CODEX_HOME", "GROK_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "KIMI_CODE_HOME"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

test("five global native loaders receive memory; Own removes only managed content", async () => {
  for (const agent of ["grok", "codex", "workbuddy", "hermes", "claude"] as const) {
    const dest = (await nativeMemoryTarget(agent))!.path;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, "USER ORIGINAL\r\n");
    await applyBind({ agent, layer: "memory", value: "hub" });
    assert.match((await readText(dest))!, /SYNTHETIC_GLOBAL_421/);
    await fs.appendFile(dest, "USER EDIT DURING HUB\n");
    await syncMemoryInjects();
    assert.equal((await readText(dest))!.split("SYNTHETIC_GLOBAL_421").length, 2);
    await applyBind({ agent, layer: "memory", value: "own" });
    assert.equal(await readText(dest), "USER ORIGINAL\r\nUSER EDIT DURING HUB\n");
  }
});

test("all registered workspace loaders isolate project memory and detach cleanly", async () => {
  await writeProjectMemory("alpha", "ALPHA_PRIVATE");
  for (const agent of AGENT_IDS.filter(id => !adapter(id).manualMemory)) {
    await applyBind({ agent, layer: "memory", value: "hub" });
    await selectMemoryProject(agent, "alpha", workspace);
    const dest = (await nativeMemoryTarget(agent, workspace))!.path;
    assert.match((await readText(dest))!, /ALPHA_PRIVATE/);
    const global = await nativeMemoryTarget(agent);
    if (global) assert.doesNotMatch((await readText(global.path))!, /ALPHA_PRIVATE/);
    await selectMemoryProject(agent, undefined, workspace);
    assert.doesNotMatch((await readText(dest)) || "", /ALPHA_PRIVATE/);
    await applyBind({ agent, layer: "memory", value: "own" });
  }
});

test("Cursor and Hyper accept a global-only workspace and receive subsequent updates", async () => {
  for (const agent of ["cursor", "hyper"] as const) {
    await applyBind({ agent, layer: "memory", value: "hub" });
    await selectMemoryProject(agent, undefined, workspace, true);
  }
  await writeGlobalMemory("NEXT_GENERATION");
  await syncMemoryInjects();
  for (const agent of ["cursor", "hyper"] as const) {
    const dest = (await nativeMemoryTarget(agent, workspace))!.path;
    assert.match((await readText(dest))!, /NEXT_GENERATION/);
    await applyBind({ agent, layer: "memory", value: "own" });
    assert.equal(await readText(dest), null);
  }
});

test("native limits fail atomically and do not commit binding or replace user memory", async () => {
  const dest = (await nativeMemoryTarget("workbuddy"))!.path;
  await fs.writeFile(dest, "X".repeat(3950));
  await assert.rejects(applyBind({ agent: "workbuddy", layer: "memory", value: "hub" }), /4000/);
  assert.equal((await loadConfig()).bind.workbuddy.memory, "own");
  assert.equal(await readText(dest), "X".repeat(3950));
  assert.equal(await readText(path.join(agentHome("workbuddy"), "memory/hub-generated.md")), null);
});

test("Codex override activation migrates the block and leaves both original files intact", async () => {
  const base = path.join(agentHome("codex"), "AGENTS.md");
  const override = path.join(agentHome("codex"), "AGENTS.override.md");
  await fs.writeFile(base, "BASE");
  await applyBind({ agent: "codex", layer: "memory", value: "hub" });
  await fs.writeFile(override, "OVERRIDE");
  await syncMemoryInjects();
  assert.equal(await readText(base), "BASE");
  assert.match((await readText(override))!, /SYNTHETIC_GLOBAL/);
  await applyBind({ agent: "codex", layer: "memory", value: "own" });
  assert.equal(await readText(override), "OVERRIDE");
});

test("malformed markers, symlinks and home workspace overlap fail closed", async () => {
  const dest = (await nativeMemoryTarget("workbuddy"))!.path;
  const other = path.join(home, "other"); await fs.writeFile(other, "UNCHANGED");
  await fs.symlink(other, dest);
  await assert.rejects(applyBind({ agent: "workbuddy", layer: "memory", value: "hub" }), /symlink/);
  await fs.unlink(dest);
  await applyBind({ agent: "workbuddy", layer: "memory", value: "hub" });
  await fs.writeFile(dest, (await readText(dest))!.replace("memory:end", "broken:end"));
  await assert.rejects(syncMemoryInjects(), /标记损坏/);
  assert.equal(await readText(other), "UNCHANGED");
  await assert.rejects(selectMemoryProject("grok", "alpha", home), /overlaps/);
});

test("disabling an adapter retracts native blocks; custom profile roots are supported", async () => {
  process.env.HERMES_HOME = path.join(home, "hermes-profile");
  await fs.mkdir(agentHome("hermes"));
  await fs.writeFile(path.join(agentHome("hermes"), "config.yaml"), "{}\n");
  await applyBind({ agent: "hermes", layer: "memory", value: "hub" });
  const dest = (await nativeMemoryTarget("hermes"))!.path;
  assert.match((await readText(dest))!, /SYNTHETIC_GLOBAL/);
  const config = await loadConfig(); config.agents.enabled = ["grok"];
  await saveConfig(config); await syncMemoryInjects();
  assert.equal(await readText(dest), null);
});

test("Hermes memory keeps a section mark inside the Hub block as one entry", async () => {
  await writeGlobalMemory("before\n§\nafter");
  await applyBind({ agent: "hermes", layer: "memory", value: "hub" });
  const dest = (await nativeMemoryTarget("hermes"))!.path;
  const text = (await readText(dest))!;
  const block = text.split("<!-- agent-hub:hermes:memory:start -->\n")[1]?.split("\n<!-- agent-hub:hermes:memory:end -->")[0] ?? "";
  assert.match(block, /before\n§ \nafter/);
  assert.equal(block.includes("\n§\n"), false);
  await fs.writeFile(dest, `${text.trimEnd()}\n§\nlocal note\n`);
  await syncMemoryInjects(undefined, { agent: "hermes" });
  const next = (await readText(dest))!;
  assert.match(next, /\n§\nlocal note\n/);
  assert.match(next, /before\n§ \nafter/);
});

test("Hyper refuses a document its native loader may silently omit", async () => {
  const dest = path.join(workspace, "AGENTS.md");
  await fs.writeFile(dest, "既有人设与项目约定".repeat(80));
  await applyBind({ agent: "hyper", layer: "memory", value: "hub" });
  await assert.rejects(selectMemoryProject("hyper", undefined, workspace, true), /保守加载预算/);
  assert.equal(await readText(dest), "既有人设与项目约定".repeat(80));
});

test("versioned config preserves an explicit original-five adapter subset", async () => {
  const config = await loadConfig();
  config.agents.enabled = ["grok", "cursor", "codex", "hyper", "workbuddy"];
  await saveConfig(config);
  assert.deepEqual((await loadConfig()).agents.enabled, config.agents.enabled);
});
