import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { pruneBackupDir, prunePrefixedFiles, readRegularText, writeText } from "./fsx.ts";

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "hub-fsx-"));

before(async () => {
  await fs.mkdir(tmp, { recursive: true });
});

after(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

test("pruneBackupDir is a no-op for a missing directory", async () => {
  await pruneBackupDir(path.join(tmp, "missing-backups"), 2);
});

test("pruneBackupDir keeps current.json and the newest keep files", async () => {
  const dir = path.join(tmp, "backups");
  await writeText(path.join(dir, "current.json"), "{}");
  await writeText(path.join(dir, "01.md.meta.json"), "{}");
  for (let i = 1; i <= 5; i++) await writeText(path.join(dir, `${String(i).padStart(2, "0")}.md`), "x");
  await pruneBackupDir(dir, 2);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["04.md", "05.md", "current.json"]);
});

test("prunePrefixedFiles is a no-op for a missing directory and keep=0 drops matches", async () => {
  await prunePrefixedFiles(path.join(tmp, "missing-prefix"), "vault.bin.broken-");
  const dir = path.join(tmp, "prefix");
  await fs.mkdir(dir, { recursive: true });
  await writeText(path.join(dir, "keep.txt"), "ok");
  await writeText(path.join(dir, "vault.bin.broken-01"), "a");
  await writeText(path.join(dir, "vault.bin.broken-02"), "b");
  await prunePrefixedFiles(dir, "vault.bin.broken-", 0);
  assert.deepEqual((await fs.readdir(dir)).sort(), ["keep.txt"]);
});

test("readRegularText reads files and refuses directories, missing paths, and final symlinks", async () => {
  const file = path.join(tmp, "regular.txt");
  const dir = path.join(tmp, "subdir");
  const link = path.join(tmp, "alias.txt");
  await writeText(file, "hello");
  await fs.mkdir(dir, { recursive: true });
  await fs.symlink(file, link);
  assert.equal(await readRegularText(file), "hello");
  assert.equal(await readRegularText(dir), null);
  assert.equal(await readRegularText(path.join(tmp, "nope.txt")), null);
  assert.equal(await readRegularText(link), null);
});
