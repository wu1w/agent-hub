import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { after, before, test } from "node:test";
import { defaultConfig, hubRoot, loadConfig, setBind } from "./config.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-cfg-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  await fs.mkdir(home, { recursive: true });
});

after(async () => {
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("default Hyper ctx is own, matching PRD first-run Own", () => {
  assert.equal(defaultConfig().bind.hyper.ctx, "own");
  assert.equal(defaultConfig().bind.grok.ctx, "own");
});

test("hubRoot follows HOME when AGENT_HUB_ROOT is unset", () => {
  delete process.env.AGENT_HUB_ROOT;
  assert.equal(hubRoot(), path.join(home, ".agent-hub"));
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
});

test("setBind keeps custom layers.sessions.index", async () => {
  const cfg = defaultConfig();
  cfg.layers.sessions.index = ["grok"];
  const root = path.join(home, ".agent-hub");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "config.toml"), stringify(cfg), "utf8");
  await setBind("grok", "memory", "hub");
  const loaded = await loadConfig();
  assert.deepEqual(loaded.layers.sessions.index, ["grok"]);
  assert.equal(loaded.bind.grok.memory, "hub");
});

test("setBind rejects unknown agent", async () => {
  await assert.rejects(() => setBind("nope" as never, "skills", "hub"), /unknown agent/);
});

test("explicit empty enabled list stays empty", async () => {
  const cfg = await loadConfig();
  cfg.agents.enabled = [];
  const { saveConfig } = await import("./config.ts");
  await saveConfig(cfg);
  const loaded = await loadConfig();
  assert.deepEqual(loaded.agents.enabled, []);
});

test("config.toml root relocates hubRoot when AGENT_HUB_ROOT is unset", async () => {
  const prev = process.env.AGENT_HUB_ROOT;
  delete process.env.AGENT_HUB_ROOT;
  const other = path.join(home, "relocated-hub");
  await fs.mkdir(path.join(home, ".agent-hub"), { recursive: true });
  await fs.writeFile(path.join(home, ".agent-hub", "config.toml"), `root = "${other}"\n`, "utf8");
  try {
    assert.equal(hubRoot(), other);
  } finally {
    if (prev) process.env.AGENT_HUB_ROOT = prev;
    else delete process.env.AGENT_HUB_ROOT;
  }
});
