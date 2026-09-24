import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ensureHub, hubPaths } from "./config.ts";
import { writeText } from "./fsx.ts";
import { closeSessionIndex } from "./sessions.ts";
import { diskEpoch, noteDiskChange, startHubWatch, stopHubWatch } from "./watch.ts";

async function waitFor(pred: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return pred();
}

const previous = { ...process.env };
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-watch-"));
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

test("noteDiskChange increments diskEpoch", () => {
  const before = diskEpoch();
  noteDiskChange();
  assert.equal(diskEpoch(), before + 1);
  noteDiskChange();
  assert.equal(diskEpoch(), before + 2);
});

test("startHubWatch is idempotent and stopHubWatch clears watchers", async () => {
  const stop = await startHubWatch();
  const again = await startHubWatch();
  assert.equal(typeof stop, "function");
  assert.equal(typeof again, "function");
  again();
  stop();
  const before = diskEpoch();
  noteDiskChange();
  assert.equal(diskEpoch(), before + 1);
});

test("startHubWatch still returns a stopper when a watch root is missing", async () => {
  await fs.rm(hubPaths().skills, { recursive: true, force: true });
  const stop = await startHubWatch();
  stop();
});

test("session writes notify without bumping diskEpoch; skill writes do not notify", async () => {
  let n = 0;
  const stop = await startHubWatch({ onSessionChange: () => { n += 1; } });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const base = n;
    const before = diskEpoch();
    await writeText(path.join(hubPaths().skills, "nested", "quiet", "SKILL.md"), "# quiet\n");
    assert.equal(await waitFor(() => diskEpoch() > before, 3000), true);
    assert.equal(n, base);
    await writeText(path.join(home, ".grok", "sessions", "touch.txt"), "x\n");
    assert.equal(await waitFor(() => n > base, 3000), true);
    assert.equal(diskEpoch(), before + 1);
  } finally {
    stop();
  }
});

test("recursive watch bumps diskEpoch after the debounce", async () => {
  const stop = await startHubWatch();
  try {
    const before = diskEpoch();
    await writeText(path.join(hubPaths().skills, "nested", "demo", "SKILL.md"), "# nested\n");
    assert.equal(await waitFor(() => diskEpoch() > before, 3000), true);
  } finally {
    stop();
  }
});
