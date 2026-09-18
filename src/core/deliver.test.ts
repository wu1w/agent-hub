import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { setBind } from "./config.ts";
import { applyLayerBind, HUB_MARK } from "./deliver.ts";
import { readText } from "./fsx.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-hub-del-"));
const home = path.join(tmp, "home");
const prevHome = process.env.HOME;
const prevRoot = process.env.AGENT_HUB_ROOT;

before(async () => {
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  await fs.mkdir(path.join(home, ".workbuddy", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".cursor", "projects"), { recursive: true });
  await fs.mkdir(path.join(home, ".codex", "sessions"), { recursive: true });
  await fs.mkdir(path.join(home, ".grok-hyper", "sessions"), { recursive: true });
  await fs.writeFile(path.join(home, ".workbuddy", "USER.md"), "# original user\n", "utf8");
});

after(async () => {
  process.env.HOME = prevHome;
  if (prevRoot) process.env.AGENT_HUB_ROOT = prevRoot;
  else delete process.env.AGENT_HUB_ROOT;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("hyper Ctx=Hub writes USER.md not AGENT.md", async () => {
  const dest = await (await import("./deliver.ts")).injectCtx("hyper");
  assert.ok(dest?.endsWith("USER.md"));
  const text = await readText(dest!);
  assert.match(text ?? "", /hub-generated: agent-hub/);
  const agent = await readText(path.join(home, ".grok-hyper", "AGENT.md"));
  assert.equal(agent, null);
});

test("ctx hub projects USER.md then own restores the backup", async () => {
  const dest = path.join(home, ".workbuddy", "USER.md");
  await setBind("workbuddy", "ctx", "hub");
  await applyLayerBind("workbuddy", "ctx", "hub");
  const injected = await readText(dest);
  assert.match(injected ?? "", /hub-generated: agent-hub/);
  assert.match(injected ?? "", /描述使用者/);
  await setBind("workbuddy", "ctx", "own");
  await applyLayerBind("workbuddy", "ctx", "own");
  const restored = await readText(dest);
  assert.match(restored ?? "", /original user/);
  assert.equal((restored ?? "").includes(HUB_MARK), false);
});
