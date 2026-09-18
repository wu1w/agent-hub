import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { applyLayerBind, isHubGenerated } from "./deliver.ts";
import { composeInject, remember, slugRepo } from "./memory.ts";
import { setBind } from "./config.ts";
import { readText } from "./fsx.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-mem-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
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

test("remember appends to global and project files", async () => {
  await remember("喜欢等宽字体");
  await remember("世界规则锁对象", "world");
  const global = await readText(path.join(home, ".agent-hub", "memory", "global.md"));
  const project = await readText(path.join(home, ".agent-hub", "memory", "projects", "world.md"));
  assert.match(global ?? "", /喜欢等宽字体/);
  assert.match(project ?? "", /世界规则锁对象/);
  const composed = await composeInject("world");
  assert.match(composed, /喜欢等宽字体/);
  assert.match(composed, /项目 world/);
  await remember("BETA_ONLY", "beta");
  const alpha = await composeInject("world");
  assert.doesNotMatch(alpha, /BETA_ONLY/);
  const globalOnly = await composeInject();
  assert.doesNotMatch(globalOnly, /世界规则锁对象/);
});

test("memory hub inject writes marked file and own removes it", async () => {
  await remember("注入探针");
  await setBind("grok", "memory", "hub");
  await applyLayerBind("grok", "memory", "hub");
  const dest = path.join(home, ".grok", "memory", "hub-generated.md");
  const injected = await readText(dest);
  assert.equal(isHubGenerated(injected), true);
  assert.match(injected ?? "", /注入探针/);
  assert.match(injected ?? "", /hub-generated: agent-hub/);
  await setBind("grok", "memory", "own");
  await applyLayerBind("grok", "memory", "own");
  const afterOwn = await readText(dest);
  assert.equal(afterOwn, null);
});

test("slugRepo uses home-relative path", () => {
  assert.equal(slugRepo(path.join(home, "world"), home), "world");
});
