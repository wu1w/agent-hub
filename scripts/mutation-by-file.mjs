#!/usr/bin/env node
/** Per-file Stryker pass. Combined instrumentation of all 8k mutants makes
 *  later files crash the tap hook (RuntimeError / missing stryker-output-*.json).
 *  Isolated --mutate <file> --force retests one production file at a time. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  "src/core/watch.ts",
  "src/core/types.ts",
  "src/core/ui-vm.ts",
  "src/core/secrets.ts",
  "src/core/identity-native.ts",
  "src/core/snapshot.ts",
  "src/core/locale.ts",
  "src/core/frontmatter.ts",
  "src/core/memory.ts",
  "src/core/transaction.ts",
  "src/core/fsx.ts",
  "src/core/files.ts",
  "src/core/handoff.ts",
  "src/core/popular-memory.ts",
  "src/core/vault.ts",
  "src/core/sessions.ts",
  "src/core/skills.ts",
];

for (const file of files) {
  console.log(`\n======== ${file} ========`);
  const result = spawnSync(
    "npx",
    ["stryker", "run", "--mutate", file, "--force", "--logLevel", "info"],
    { cwd: root, stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    console.error(`stryker failed on ${file} with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
console.log("ALL_FILES_DONE");
