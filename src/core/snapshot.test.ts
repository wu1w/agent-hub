import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { adapter } from "./adapters.ts";
import { ensureHub } from "./config.ts";
import { closeSessionIndex } from "./sessions.ts";
import { buildSnapshot } from "./snapshot.ts";
import { diskEpoch, noteDiskChange, stopHubWatch } from "./watch.ts";

const previous = { ...process.env };
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-snap-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "c3".repeat(32);
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await ensureHub();
  stopHubWatch();
});

afterEach(async () => {
  stopHubWatch();
  closeSessionIndex();
  await fs.rm(home, { recursive: true, force: true });
  for (const key of ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("snapshot diskEpoch matches the live counter", async () => {
  noteDiskChange();
  const snap = await buildSnapshot();
  assert.equal(snap.diskEpoch, diskEpoch());
  assert.equal(typeof snap.diskEpoch, "number");
});

test("snapshot lists grok subagents and cursor native identity path", async () => {
  const dir = adapter("grok").subagentDir!(home);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "reviewer.md"), "name: Reviewer\n\n# Heading\n", "utf8");
  const snap = await buildSnapshot();
  const grok = snap.agents.find((row) => row.id === "grok");
  assert.ok(grok?.subagents.some((sub) => sub.name === "reviewer" && sub.title === "Reviewer"));
  const cursor = snap.agents.find((row) => row.id === "cursor");
  assert.equal(cursor?.identityNative, false);
  assert.match(cursor?.identityNativePath ?? "", /hub-generated-identity\.mdc$/);
});
