import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, test } from "node:test";
import { ensureHub, hubPaths, loadConfig, saveConfig, setBind } from "./config.ts";
import { scanProjectSkills, promoteProjectSkill, listHubSkills, readHubSkill, writeHubSkill, removeHubSkill, relinkHubSkills, adoptSkills, detachAgentSkills, skillRecords } from "./skills.ts";
import { readAllowed, writeAllowed } from "./files.ts";
import { closeSessionIndex } from "./sessions.ts";
import { createHandoff, listHandoffs, launchHandoff } from "./handoff.ts";
import { loadVault, saveVaultFromMarkdown, vaultUiPayload } from "./vault.ts";
import { writeText, readRegularText } from "./fsx.ts";
import { popularMemoryTarget } from "./popular-memory.ts";

const previous = { ...process.env };
const keys = ["HOME", "AGENT_HUB_ROOT", "AGENT_HUB_VAULT_KEY", "CODEX_HOME", "GROK_HOME", "HERMES_HOME", "CLAUDE_CONFIG_DIR", "WORKBUDDY_CONFIG_DIR", "WORKBUDDY_DATA_FOLDER_NAME", "XDG_CONFIG_HOME", "CONTEXT_FILE_NAMES", "PATH"];
let home: string;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "hub-round7-"));
  for (const key of keys) delete process.env[key];
  process.env.HOME = home; process.env.AGENT_HUB_ROOT = path.join(home, ".agent-hub");
  process.env.AGENT_HUB_VAULT_KEY = "ab".repeat(32); process.env.PATH = "/usr/bin:/bin";
  await ensureHub();
});
afterEach(async () => {
  closeSessionIndex(); await fs.rm(home, { recursive: true, force: true });
  for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
});

test("R7 project scan and promote include Claude, Hermes and WorkBuddy; ambiguous leaves fail closed", async () => {
  const cwd = path.join(home, "repo");
  for (const agent of ["claude", "hermes", "workbuddy"]) {
    await writeText(path.join(cwd, `.${agent}/skills/group/${agent}/SKILL.md`), `# ${agent}`);
  }
  const rows = await scanProjectSkills(cwd);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(path.join(cwd, row.rel), row.path);
    await promoteProjectSkill(cwd, row.name);
    assert.equal(await readHubSkill(row.name), `# ${row.name}`);
  }
  await writeText(path.join(cwd, ".agents/skills/claude/SKILL.md"), "OTHER");
  assert.equal((await scanProjectSkills(cwd)).filter(r => r.name === "claude").length, 2);
  await assert.rejects(promoteProjectSkill(cwd, "claude"), /同名冲突/);
});

test("R7 nested Hub identities survive list/read/write/adopt/delete without basename collisions", async () => {
  for (const name of ["group/foo", "other/foo", "foo"]) await writeText(path.join(hubPaths().skills, name, "SKILL.md"), `# ${name}`);
  assert.deepEqual((await listHubSkills()).map(s => s.name).sort(), ["foo", "group/foo", "other/foo"]);
  await relinkHubSkills();
  const before = await readAllowed("skill", undefined, "group/foo");
  await writeAllowed("skill", "# CHANGED", undefined, "group/foo", before.revision);
  assert.equal(await readHubSkill("group/foo"), "# CHANGED");
  assert.equal(await readHubSkill("foo"), "# foo");
  assert.equal(await readHubSkill("other/foo"), "# other/foo");
  const report = await adoptSkills("adopt");
  assert.equal(report.conflicts.length, 0);
  assert.equal(report.moved.length, 0);
  assert.equal((await skillRecords(await loadConfig())).find(r => r.name === "group/foo")!.links.grok, "linked");
  await removeHubSkill("group/foo");
  await assert.rejects(fs.lstat(path.join(home, ".grok/skills/group/foo")), { code: "ENOENT" });
  assert.equal(await readHubSkill("other/foo"), "# other/foo");
  assert.equal(await readHubSkill("foo"), "# foo");
});

test("R7 aliases count as linked and nested traversal cannot write or delete outside Hub", async () => {
  const skill = path.join(hubPaths().skills, "foo");
  await writeText(path.join(skill, "SKILL.md"), "# SAFE");
  await fs.mkdir(path.join(home, ".grok/skills/nested"), { recursive: true });
  await fs.symlink(skill, path.join(home, ".grok/skills/nested/alias"));
  assert.equal((await skillRecords(await loadConfig()))[0]!.links.grok, "linked");
  const foreign = path.join(home, "external");
  await writeText(path.join(foreign, "child/SKILL.md"), "FOREIGN");
  await fs.symlink(foreign, path.join(hubPaths().skills, "escape"));
  await assert.rejects(writeHubSkill("escape/child", "BAD"));
  await assert.rejects(removeHubSkill("escape/child"));
  await assert.rejects(readHubSkill("escape/child"));
  assert.equal(await fs.readFile(path.join(foreign, "child/SKILL.md"), "utf8"), "FOREIGN");
});

test("R7 handoff success and write failure never replay Memory", async t => {
  await writeText(path.join(home, ".grok/sessions/g/sid/summary.json"), JSON.stringify({ info: { id: "sid", cwd: home }, generated_title: "TITLE" }));
  const config = await loadConfig(); config.bind.grok.memory = "hub"; config.bind.goose.memory = "hub"; await saveConfig(config);
  const native = path.join(home, ".grok/AGENTS.md");
  await writeText(native, "EXISTING MEMORY");
  await writeText(path.join(home, ".config/goose/config.yaml"), "CONTEXT_FILE_NAMES: invalid");
  const handoff = await createHandoff({ from: "grok", to: "grok", sessionId: "sid" });
  assert.match(handoff.markdown, /Handoff/);
  assert.equal(await fs.readFile(native, "utf8"), "EXISTING MEMORY");
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (String(to).startsWith(hubPaths().handoff + path.sep)) throw new Error("handoff write failure");
    return rename(from, to);
  });
  await assert.rejects(createHandoff({ from: "grok", to: "grok", sessionId: "sid" }), /handoff write failure/);
  assert.equal(await fs.readFile(native, "utf8"), "EXISTING MEMORY");
  assert.deepEqual((await fs.readdir(hubPaths().handoff)), [path.basename(handoff.record.path)]);
});

test("R7 handoff list and launch reject external md symlinks", async () => {
  const external = path.join(home, "external.md");
  await writeText(external, "# Handoff\n- from: grok\n- to: grok\n- source_session: sid\n- cwd: /tmp\n- created: now\n");
  const link = path.join(hubPaths().handoff, "linked.md");
  await fs.symlink(external, link);
  assert.equal(await readRegularText(link), null);
  assert.deepEqual(await listHandoffs(), []);
  await assert.rejects(launchHandoff("linked"), e => (e as { status: number }).status === 404);
});

test("R7 Vault masks preserve, blank clears, explicit custom classification removes", async () => {
  await saveVaultFromMarkdown("## sample\ncredential: CUSTOM\ntoken: SECRET", undefined, { sample: ["credential"] });
  let payload = await vaultUiPayload();
  await saveVaultFromMarkdown(payload.masked, undefined, payload.secretFields, payload.revision);
  assert.equal((await loadVault()).entries[0]!.fields[0]!.value, "CUSTOM");
  payload = await vaultUiPayload();
  await saveVaultFromMarkdown(payload.masked, undefined, { sample: [] }, payload.revision);
  let fields = (await loadVault()).entries[0]!.fields;
  assert.equal(fields[0]!.secret, false); assert.equal(fields[0]!.value, "CUSTOM");
  assert.equal(fields[1]!.secret, true);
  await saveVaultFromMarkdown("## sample\ncredential: \ntoken: ");
  fields = (await loadVault()).entries[0]!.fields;
  assert.deepEqual(fields.map(f => f.value), ["", ""]);
  assert.doesNotMatch((await vaultUiPayload(true)).markdown!, /CUSTOM|SECRET/);
});

test("R7 unsupported bindings reject before save and invalid manual config is explicit", async () => {
  const before = await fs.readFile(hubPaths().config, "utf8");
  for (const [agent, layer, value] of [["workbuddy", "sessions", "index"], ["goose", "skills", "hub"], ["goose", "vault", "hub"]] as const) await assert.rejects(setBind(agent, layer, value));
  assert.equal(await fs.readFile(hubPaths().config, "utf8"), before);
  await fs.writeFile(hubPaths().config, before.replace(/(\[bind.workbuddy\][\s\S]*?sessions = )"own"/, '$1"index"'));
  await assert.rejects(loadConfig(), /workbuddy.*Sessions=index/);
});

test("R7 Goose reads native config and ignores Hub context environment", async () => {
  process.env.CONTEXT_FILE_NAMES = '["WRONG.md"]';
  const file = path.join(home, ".config/goose/config.yaml");
  await writeText(file, 'CONTEXT_FILE_NAMES: ["NATIVE.md"]');
  assert.equal((await popularMemoryTarget("goose", home))!.path, path.join(home, "NATIVE.md"));
  await writeText(file, 'CONTEXT_FILE_NAMES: ["../escape"]');
  await assert.rejects(popularMemoryTarget("goose", home), /unsafe path/);
});


test("R7 binary publication fsyncs the containing directory after rename", async t => {
  const target = path.join(home, "durable.md");
  const events: string[] = [];
  const open = fs.open, rename = fs.rename;
  t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => { await rename(from, to); if (String(to) === target) events.push("rename"); });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === home) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { events.push("directory-sync"); await sync(); });
    }
    return handle;
  });
  await writeText(target, "DURABLE");
  assert.deepEqual(events, ["rename", "directory-sync"]);
});


test("R7 nested Own copies retain matrix identity; symlinked mount parents reject relink", async () => {
  await writeText(path.join(hubPaths().skills, "group/foo/SKILL.md"), "# SAFE");
  await relinkHubSkills();
  await detachAgentSkills("grok", "detach-copy");
  await setBind("grok", "skills", "own");
  assert.equal((await skillRecords(await loadConfig()))[0]!.links.grok, "own");
  await fs.rm(path.join(home, ".codex/skills/group"), { recursive: true, force: true });
  const outside = path.join(home, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(home, ".codex/skills/group"));
  await assert.rejects(relinkHubSkills(), /symlink/);
  assert.deepEqual(await fs.readdir(outside), []);
});
