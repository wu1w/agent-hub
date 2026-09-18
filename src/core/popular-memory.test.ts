import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, test } from "node:test";
import { agentHome } from "./adapters.ts";
import { nativeMemoryTarget } from "./autoload.ts";
import { applyBind } from "./bind.ts";
import { loadConfig, saveConfig } from "./config.ts";
import { syncMemoryInjects } from "./deliver.ts";
import { readText, writeText } from "./fsx.ts";
import { writeGlobalMemory } from "./memory.ts";
import { AGENT_IDS } from "./types.ts";
import { parseJsonConfig } from "./config-reference.ts";
import { parse } from "yaml";
const keys = ["HOME", "AGENT_HUB_ROOT", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR", "CONTEXT_FILE_NAMES", "OPENCLAW_STATE_DIR"];
const env = { ...process.env };
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-popular-"));
  for (const key of keys) delete process.env[key];
  process.env.HOME = home; process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  for (const id of AGENT_IDS) await fs.mkdir(path.join(agentHome(id), id === "cursor" ? "projects" : "sessions"), { recursive: true });
  await writeGlobalMemory("POPULAR_TEST_MEMORY");
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  for (const key of keys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
});
for (const agent of ["kilo", "aider"] as const) {
  test(`${agent}: native config registration preserves original bytes and concurrent edits`, async () => {
    const target = (await nativeMemoryTarget(agent))!;
    const ref = target.reference!;
    const original = agent === "kilo" ? '{\n // user comment\n "instructions": ["personal.md"],\n "theme": "dark",\n}\n' : '# user comment\nread: personal.md\nmodel: test\n';
    await writeText(ref.path, original);
    await applyBind({ agent, layer: "memory", value: "hub" });
    const content = (await readText(ref.path))!;
    const config = agent === "kilo" ? parseJsonConfig(content) : parse(content);
    assert.deepEqual(config[ref.key], ["personal.md", target.path]);
    assert.match(content, /user comment/);
    await applyBind({ agent, layer: "memory", value: "own" });
    assert.equal(await readText(ref.path), original);
    await applyBind({ agent, layer: "memory", value: "hub" });
    await fs.appendFile(ref.path, agent === "kilo" ? '\n// external edit\n' : '\n# external edit\n');
    await syncMemoryInjects();
    await applyBind({ agent, layer: "memory", value: "own" });
    assert.match((await readText(ref.path))!, /external edit/);
    assert.doesNotMatch((await readText(ref.path))!, /hub-native-memory|hub-memory/);
  });
  test(`${agent}: recreated config is removed and malformed config rolls back binding`, async () => {
    const target = (await nativeMemoryTarget(agent))!;
    const ref = target.reference!;
    await writeText(ref.path, agent === "kilo" ? '{"theme":"old"}' : 'model: old\n');
    await applyBind({ agent, layer: "memory", value: "hub" });
    await fs.unlink(ref.path);
    await syncMemoryInjects();
    await applyBind({ agent, layer: "memory", value: "own" });
    assert.equal(await readText(ref.path), null);
    await writeText(ref.path, agent === "kilo" ? '{ broken' : 'read: [broken');
    await assert.rejects(applyBind({ agent, layer: "memory", value: "hub" }));
    assert.equal((await loadConfig()).bind[agent].memory, "own");
    assert.equal(await readText(target.path), null);
  });
}
test("custom context filenames and existing legacy rules retain activation", async () => {
  for (const agent of ["gemini", "qwen"] as const) {
    await writeText(path.join(agentHome(agent), "settings.json"), '{"context":{"fileName":["CUSTOM.md"]}}');
    await applyBind({ agent, layer: "memory", value: "hub" });
    assert.match((await readText(path.join(agentHome(agent), "CUSTOM.md")))!, /POPULAR_TEST_MEMORY/);
  }
  const workspace = path.join(home, "project");
  await writeText(path.join(workspace, ".clinerules"), "personal");
  assert.equal((await nativeMemoryTarget("cline", workspace))!.path, path.join(workspace, ".clinerules"));
  await writeText(path.join(agentHome("pi"), "AGENTS.override.md"), "override");
  assert.equal((await nativeMemoryTarget("pi"))!.path, path.join(agentHome("pi"), "AGENTS.override.md"));
});
test("new adapters reject unsupported layer binding and schema2 defaults upgrade", async () => {
  await assert.rejects(applyBind({agent:"gemini",layer:"skills",value:"hub"}), /仅支持 Memory/);
  const config = await loadConfig();
  config.schema_version = 2;
  config.agents.enabled = ["grok","cursor","codex","hyper","workbuddy","hermes","claude"];
  await saveConfig(config);
  assert.deepEqual((await loadConfig()).agents.enabled, ["grok","cursor","codex","hyper","workbuddy","hermes","claude"]);
});
