import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ensureHub, hubPaths, loadConfig, saveConfig } from "./config.ts";
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

test("authoritative asset edits notify, including nested sources and atomic config replacement", async () => {
  let changes = 0;
  const stop = await startHubWatch({ onAssetChange: () => { changes += 1; } });
  const p = hubPaths();
  try {
    for (const [file, content] of [
      [p.memoryGlobal, "# updated global\n"],
      [path.join(p.memoryProjects, "example.md"), "# updated project\n"],
      [p.userMd, "# updated user\n"],
      [path.join(p.skills, "new", "nested", "SKILL.md"), "# new skill\n"],
      [path.join(p.memory, "inject-state.json"), '{"scopes":[]}'],
    ]) {
      const before = changes;
      await writeText(file!, content!);
      assert.equal(await waitFor(() => changes > before, 3000), true, file);
    }
    // Config saves replace the inode. Both the replacement and a later edit must notify.
    const currentConfig = await fs.readFile(p.config, "utf8");
    const beforeReplace = changes;
    const replacement = path.join(p.root, "replacement.toml");
    await fs.writeFile(replacement, currentConfig);
    await fs.rename(replacement, p.config);
    assert.equal(await waitFor(() => changes > beforeReplace, 3000), true);
    const beforeNextEdit = changes;
    await fs.appendFile(p.config, "\n# external edit\n");
    assert.equal(await waitFor(() => changes > beforeNextEdit, 3000), true);
  } finally {
    stop();
  }
});

test("Own targets and generated projections do not notify assets; session notifications stay independent", async () => {
  const config = await loadConfig();
  config.agents.enabled = ["grok"];
  config.bind.grok.skills = "own";
  await saveConfig(config);
  const ownSkills = path.join(home, ".grok", "skills");
  await fs.mkdir(ownSkills, { recursive: true });
  const p = hubPaths();
  await fs.mkdir(path.join(p.memory, "exports"), { recursive: true });
  let assets = 0, sessions = 0;
  const stop = await startHubWatch({
    onAssetChange: () => { assets += 1; },
    onSessionChange: () => { sessions += 1; },
  });
  try {
    const before = diskEpoch();
    await writeText(path.join(ownSkills, "local", "SKILL.md"), "# local\n");
    await writeText(path.join(p.memory, "autoload.json"), "{}\n");
    await writeText(path.join(p.memory, "exports", "doubao.md"), "# export\n");
    await writeText(path.join(p.sessions, "handoff", "example.md"), "# handoff\n");
    assert.equal(await waitFor(() => diskEpoch() > before, 3000), true);
    assert.equal(assets, 0);
    assert.equal(sessions, 0);
    await writeText(path.join(home, ".grok", "sessions", "new.json"), "{}\n");
    assert.equal(await waitFor(() => sessions > 0, 3000), true);
    assert.equal(assets, 0);
    stop();
    await fs.appendFile(p.memoryGlobal, "\n# after stop\n");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(assets, 0);
  } finally {
    stop();
  }
});
