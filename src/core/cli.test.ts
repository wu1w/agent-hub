import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { runCli } from "../cli.ts";
import { ensureHub, setBind } from "./config.ts";
import { consumeLangFlag } from "./locale.ts";
import { closeSessionIndex } from "./sessions.ts";
import { saveVaultFromMarkdown } from "./vault.ts";

const previous = { ...process.env };
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-cli-"));
  process.env.HOME = home;
  process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "c3".repeat(32);
  await fs.mkdir(path.join(home, ".grok", "sessions"), { recursive: true });
  await ensureHub();
  consumeLangFlag(["--lang", "en"]);
});

afterEach(async () => {
  closeSessionIndex();
  await fs.rm(home, { recursive: true, force: true });
  process.exitCode = undefined;
  for (const key of ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY"]) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

async function hub(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const logs: string[] = [];
  const errs: string[] = [];
  const chunks: string[] = [];
  const log = console.log;
  const error = console.error;
  const write = process.stdout.write.bind(process.stdout);
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errs.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  const prev = process.exitCode;
  process.exitCode = undefined;
  try {
    await runCli(["--lang", "en", ...argv]);
    return {
      stdout: `${logs.join("\n")}\n${chunks.join("")}`,
      stderr: errs.join("\n"),
      code: process.exitCode ?? 0,
    };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
    process.exitCode = prev;
  }
}

test("CLI help, scan, status, catalog, and unknown command", async () => {
  const help = await hub(["--lang", "en", "help"]);
  assert.match(help.stdout, /Scan local adapters/);
  const scan = await hub(["scan"]);
  assert.match(scan.stdout, /hub /);
  const status = await hub(["status"]);
  assert.match(status.stdout, /Hub 里还没有用户 skill|no user skill|还没有用户 skill|run hub adopt/i);
  const catalog = await hub(["catalog"]);
  assert.match(catalog.stdout, /grok/);
  const listed = await hub(["catalog", "off"]);
  assert.equal(listed.code, 1);
  assert.match(listed.stderr, /usage: hub catalog/);
  const unknown = await hub(["not-a-command"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /unknown command/);
});

test("CLI vault list, grant, get, restore-previous", async () => {
  const empty = await hub(["vault"]);
  assert.match(empty.stdout, /empty|空/);
  await saveVaultFromMarkdown("## demo\n说明: first\n密钥: FIRST-SECRET-VALUE\n");
  await saveVaultFromMarkdown("## demo\n说明: second\n密钥: SECOND-SECRET-VALUE\n");
  await setBind("grok", "vault", "hub");
  const restored = await hub(["vault", "restore-previous"]);
  assert.equal(restored.code, 0);
  assert.match(restored.stdout, /Restored vault\.bin|已用上一份/);
  const listed = await hub(["vault", "list"]);
  assert.match(listed.stdout, /demo/);
  const granted = await hub(["vault", "grant", "demo", "--for", "grok"]);
  assert.match(granted.stdout, /grant demo/);
  const got = await hub(["vault", "get", "demo", "--for", "grok"]);
  assert.match(got.stdout, /HUB_VAULT_DEMO/);
  const revoked = await hub(["vault", "revoke", "demo", "--for", "grok"]);
  assert.match(revoked.stdout, /revoke demo/);
  const bad = await hub(["vault", "explode"]);
  assert.equal(bad.code, 1);
});

test("CLI remember, index, sessions, repair, adopt, bind, identity list", async () => {
  const remembered = await hub(["remember", "note from cli"]);
  assert.equal(remembered.code, 0);
  assert.match(remembered.stdout, /global\.md/);
  const indexed = await hub(["index"]);
  assert.match(indexed.stdout, /indexed /);
  const sessions = await hub(["sessions"]);
  assert.match(sessions.stdout, /empty|空/);
  const repaired = await hub(["repair"]);
  assert.match(repaired.stdout, /repaired /);
  const adopted = await hub(["adopt"]);
  assert.match(adopted.stdout, /moved /);
  const bound = await hub(["bind", "grok", "memory", "own"]);
  assert.match(bound.stdout, /grok.memory=own/);
  const identity = await hub(["restore-identity", "grok", "--list"]);
  assert.match(identity.stdout, /没有备份|no backup/i);
  const imported = await hub(["import-memory"]);
  assert.match(imported.stdout, /imported /);
  const scrubbed = await hub(["scrub-handoffs"]);
  assert.match(scrubbed.stdout, /scrubbed /);
  const synced = await hub(["sync-memory"]);
  assert.equal(typeof synced.stdout, "string");
  const projects = await hub(["project-skills", "--cwd", home]);
  assert.match(projects.stdout, /没有项目 skill|no project/i);
  const subs = await hub(["subagents", "--agent", "grok"]);
  assert.match(subs.stdout, /没有子代理|no subagent/i);
  const missingSkill = await hub(["rm-skill"]);
  assert.equal(missingSkill.code, 1);
  const conflict = await hub(["conflict"]);
  assert.equal(conflict.code, 1);
  const promote = await hub(["promote"]);
  assert.equal(promote.code, 1);
  const enable = await hub(["enable"]);
  assert.equal(enable.code, 1);
});
