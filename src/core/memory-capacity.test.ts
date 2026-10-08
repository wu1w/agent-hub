import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { hermesMemoryCapacity } from "./memory-capacity.ts";

const previous = process.env.HERMES_HOME;
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-memory-capacity-"));
  process.env.HERMES_HOME = root;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  if (previous === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = previous;
});

async function memory(content: string, config?: string) {
  await fs.mkdir(path.join(root, "memories"));
  await fs.writeFile(path.join(root, "memories/MEMORY.md"), content);
  if (config !== undefined) await fs.writeFile(path.join(root, "config.yaml"), config);
}

test("missing native memory is not created by capacity checks", async () => {
  assert.equal(await hermesMemoryCapacity(), null);
  assert.deepEqual(await fs.readdir(root), []);
});

test("near-cap warning measures characters and preserves native files", async () => {
  const body = "记".repeat(2175);
  await memory(body, "memory:\n  memory_char_limit: 2200\n");
  const file = path.join(root, "memories/MEMORY.md");
  const before = await fs.stat(file);
  const capacity = await hermesMemoryCapacity();
  assert.equal(capacity?.usedChars, 2175);
  assert.equal(capacity?.remainingChars, 25);
  assert.equal(capacity?.nearLimit, true);
  assert.equal(await fs.readFile(file, "utf8"), body);
  assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
});

test("native config can lower the effective budget but cannot hide Hub's delivery cap", async () => {
  await memory("a".repeat(1950), "memory:\n  memory_char_limit: 2000\n");
  assert.equal((await hermesMemoryCapacity())?.remainingChars, 50);
  await fs.writeFile(path.join(root, "config.yaml"), "memory:\n  memory_char_limit: 10000\n");
  const capacity = await hermesMemoryCapacity();
  assert.equal(capacity?.nativeLimit, 10000);
  assert.equal(capacity?.effectiveLimit, 2200);
  assert.equal(capacity?.nearLimit, false);
});

test("warning starts below ten percent remaining and includes overflow", async () => {
  await memory("a".repeat(1980));
  assert.equal((await hermesMemoryCapacity())?.nearLimit, false);
  await fs.writeFile(path.join(root, "memories/MEMORY.md"), "a".repeat(2250));
  const capacity = await hermesMemoryCapacity();
  assert.equal(capacity?.nearLimit, true);
  assert.equal(capacity?.remainingChars, -50);
});

test("invalid native configuration does not produce a misleading budget", async () => {
  await memory("memory", "memory: [\n");
  assert.equal(await hermesMemoryCapacity(), null);
  await fs.writeFile(path.join(root, "config.yaml"), "memory:\n  memory_char_limit: false\n");
  assert.equal(await hermesMemoryCapacity(), null);
});
