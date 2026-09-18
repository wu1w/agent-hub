#!/usr/bin/env node
import { requireSecretMaterial } from "./core/secrets.ts";
import { transaction, withHubLock } from "./core/transaction.ts";
import { spawn } from "node:child_process";
import { AGENT_IDS, LAYERS, type AgentId, type ConflictKeep, type Layer } from "./core/types.ts";
import { applyBind } from "./core/bind.ts";
import { loadConfig, setAgentEnabled } from "./core/config.ts";
import { selectMemoryProject, syncMemoryReport, syncVaultCatalogs, type MemorySyncReport } from "./core/deliver.ts";
import { listIdentityBackups, restoreIdentity, type BackupKind } from "./core/files.ts";
import { scrubHandoffs, createHandoff, execResume, revealArgv } from "./core/handoff.ts";
import { importNativeMemory, remember } from "./core/memory.ts";
import { getSession, listSessionsForDisplay, rebuildIndex, visibleHubSessions } from "./core/sessions.ts";
import {
  adoptSkills,
  promoteProjectSkill,
  removeHubSkill,
  repairLinks,
  resolveSkillConflict,
  scanProjectSkills,
  setSkillTargets,
  skillRecords,
} from "./core/skills.ts";
import { buildSnapshot } from "./core/snapshot.ts";
import { catalogItems, loadVault, renderVaultGetMeta, setVaultGrants, vaultEnvForAgent, vaultEnvVars, vaultGet } from "./core/vault.ts";
import { startServer } from "./server.ts";
import { consumeLangFlag, t, translateError, getLang } from "./core/locale.ts";

function help(): string {
  return t("help");
}

function asAgent(value: string): AgentId {
  if (!AGENT_IDS.includes(value as AgentId)) throw new Error(`unknown agent: ${value}`);
  return value as AgentId;
}

function asLayer(value: string): Layer {
  if (!LAYERS.includes(value as Layer)) throw new Error(`unknown layer: ${value}`);
  return value as Layer;
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function restAfter(args: string[], name: string): string[] | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  return args.slice(i + (args[i + 1] === "--" ? 2 : 1));
}

async function cmdScan(): Promise<void> {
  const snap = await buildSnapshot();
  for (const agent of snap.agents) {
    const mark = agent.present ? "on " : "off";
    console.log(`${mark} ${agent.id.padEnd(10)} skills=${agent.bind.skills.padEnd(4)} mem=${agent.bind.memory.padEnd(4)} sess=${agent.bind.sessions.padEnd(5)} ${agent.skillDir}`);
  }
  for (const warning of snap.warnings) console.error(warning);
  console.log(`hub ${snap.hubRoot}  skills ${snap.skillsStatus === "unavailable" ? "unknown" : snap.skills.length}  unadopted ${snap.skillsStatus === "unavailable" ? "unknown" : snap.unadopted.length}  sessions ${snap.sessions.count}  vault ${snap.vault.status === "unavailable" ? t("scan.vaultFail") : snap.vault.count}  broken ${snap.skillsStatus === "unavailable" ? "unknown" : snap.broken.length}`);
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();
  const records = await skillRecords(config);
  if (records.length === 0) {
    console.log(t("status.empty"));
    return;
  }
  const agents = config.agents.enabled;
  console.log(["skill".padEnd(28), ...agents.map((id) => id.slice(0, 7).padEnd(8))].join(""));
  for (const rec of records) {
    const cells = agents.map((id) => (rec.links[id] ?? "—").padEnd(8));
    console.log([rec.name.slice(0, 28).padEnd(28), ...cells].join(""));
  }
}

async function cmdAdopt(args: string[]): Promise<void> {
  const mode = flag(args, "--mode") === "link-existing" ? "link-existing" : "adopt";
  const report = await adoptSkills(mode);
  console.log(`moved ${report.moved.length}  linked ${report.linked.length}  skipped ${report.skipped.length}  conflicts ${report.conflicts.length}`);
  for (const item of report.conflicts) {
    console.log(`conflict ${item.name}: ${item.paths.join(" | ")}`);
  }
  for (const item of report.skipped) {
    console.log(`skip ${item.name}: ${item.reason}`);
  }
}

async function cmdRestoreIdentity(args: string[]): Promise<void> {
  if (!args[0] || args[0].startsWith("--")) {
    throw new Error("usage: hub restore-identity <agent> [--list] [--backup <name>] [--kind identity|soul|subagent] [--subagent <name>]");
  }
  const agent = asAgent(args[0]);
  if (hasFlag(args, "--list")) {
    const listed = await listIdentityBackups(agent);
    if (listed.length === 0) {
      console.log(t("restore.none", { agent }));
      return;
    }
    for (const item of listed) {
      const extra = item.kind === "subagent" && item.subagent ? ` ${item.subagent}` : "";
      console.log(`${item.name}  ${item.kind}${extra}`);
    }
    return;
  }
  const result = await restoreIdentity(agent, flag(args, "--backup"), flag(args, "--kind") ? { kind: flag(args, "--kind") as BackupKind, subagent: flag(args, "--subagent") } : undefined);
  console.log(`${result.kind} -> ${result.path}`);
  console.log(`from ${result.from}`);
}

async function cmdBind(args: string[]): Promise<void> {
  const agent = asAgent(args[0] ?? "");
  const layer = asLayer(args[1] ?? "");
  const value = args[2];
  if (!value) throw new Error("usage: hub bind <agent> <layer> <value> [--mode …]");
  const result = await applyBind({ agent, layer, value, skillsMode: flag(args, "--mode") });
  console.log(`${agent}.${layer}=${result.config.bind[agent][layer]}`);
  if (result.extra) console.log(JSON.stringify(result.extra));
}

function parseFor(args: string[]): AgentId[] {
  const raw = flag(args, "--for");
  if (!raw) throw new Error("need --for a,b");
  return raw.split(",").map((item) => asAgent(item.trim()));
}

async function cmdEnable(args: string[], enable: boolean): Promise<void> {
  const name = args[0];
  if (!name) throw new Error("need skill name");
  const config = await loadConfig();
  const rec = (await skillRecords(config)).find((item) => item.name === name);
  if (!rec) throw new Error(`unknown hub skill: ${name}`);
  const defaults = config.layers.skills.default_targets;
  const source = rec.targets ?? defaults;
  const base = new Set(
    source.includes("*") ? config.agents.enabled : source.filter((item) => AGENT_IDS.includes(item as AgentId)),
  );
  const listed = parseFor(args);
  if (enable) for (const id of listed) base.add(id);
  else for (const id of listed) base.delete(id);
  await setSkillTargets(name, [...base] as AgentId[]);
  console.log(`${enable ? "enable" : "disable"} ${name}`);
}

async function cmdRemember(args: string[]): Promise<void> {
  const project = flag(args, "--project");
  const text = args.filter((item, i, arr) => item !== "--project" && arr[i - 1] !== "--project").join(" ").trim();
  if (!text) throw new Error("usage: hub remember \"<text>\" [--project <repo-id>]");
  const result = await withHubLock(async () => {
    const result = await remember(text, project);
    return { ...result, delivery: await syncMemoryReport(project) };
  });
  console.log(result.path);
  printMemoryDelivery(result.delivery);
}

function printMemoryDelivery(report: MemorySyncReport): void {
  if (report.written.length) console.log(report.written.join("\n"));
  if (report.failures.length) {
    console.error(t("memory.deliveryPartial", { count: report.failures.length }));
    for (const failure of report.failures) console.error([failure.agent, failure.cwd, translateError(failure.error, getLang())].filter(Boolean).join(" · "));
    process.exitCode = 1;
  }
}

async function cmdIndex(args: string[]): Promise<void> {
  const raw = flag(args, "--agent");
  const report = await rebuildIndex(raw ? asAgent(raw) : undefined);
  console.log(`indexed ${report.count} unique  wrote ${report.upserted}  pruned ${report.pruned}`);
  for (const [id, n] of Object.entries(report.byAgent)) {
    console.log(`  ${id} ${n}`);
  }
}

async function cmdSessions(args: string[]): Promise<void> {
  const raw = flag(args, "--agent");
  const limit = Number(flag(args, "--limit") ?? "30");
  const q = flag(args, "--q");
  const includeOwn = hasFlag(args, "--own");
  const config = await loadConfig();
  const rows = visibleHubSessions(
    await listSessionsForDisplay({
        allowedAgents: config.agents.enabled.filter((id) => includeOwn || config.bind[id].sessions === "index"),
      agent: raw ? asAgent(raw) : undefined,
      q,
      limit: Number.isFinite(limit) ? limit : 30,
    }),
    config,
    includeOwn,
  );
  for (const row of rows) {
    const when = new Date(row.mtime).toISOString().slice(0, 16);
    console.log(`${row.agent_id.padEnd(8)} ${when}  ${row.session_id}  ${row.title}`);
    if (row.cwd) console.log(`         ${row.cwd}`);
    if (row.summary && row.summary !== row.title) console.log(`         ${row.summary}`);
  }
  if (rows.length === 0) console.log(t("sessions.empty"));
}

async function cmdHandoff(args: string[]): Promise<void> {
  const from = asAgent(flag(args, "--from") ?? "");
  const to = asAgent(flag(args, "--to") ?? "");
  const sessionId = flag(args, "--session");
  if (!sessionId) throw new Error("usage: hub handoff --from <agent> --to <agent> --session <id> [--cwd <abs>] [--exec]");
  const result = await createHandoff({
    from,
    to,
    sessionId,
    cwd: flag(args, "--cwd"),
    forceOwn: hasFlag(args, "--own"),
  });
  console.log(result.record.path);
  console.log(result.resume.note);
  if (result.resume.argv.length) console.log(result.resume.argv.join(" "));
  if (result.resume.mcp) {
    console.log(`${result.resume.mcp.tool} ${JSON.stringify(result.resume.mcp.args)}`);
  }
  if (hasFlag(args, "--exec")) {
    const code = await execResume(result.resume);
    process.exitCode = code.code ?? 1;
  }
}

async function cmdProjectSkills(args: string[]): Promise<void> {
  const cwd = flag(args, "--cwd") ?? process.cwd();
  const rows = await scanProjectSkills(cwd);
  if (rows.length === 0) {
    console.log(t("project.empty", { cwd }));
    return;
  }
  for (const row of rows) {
    console.log(`${row.inHub ? "hub " : "    "} ${row.name.padEnd(28)} ${row.rel}`);
  }
}

async function cmdPromote(args: string[]): Promise<void> {
  const cwd = flag(args, "--cwd") ?? process.cwd();
  const name = args.find((item, i, arr) => item !== "--cwd" && arr[i - 1] !== "--cwd");
  if (!name) throw new Error("usage: hub promote --cwd <abs> <name>");
  const result = await promoteProjectSkill(cwd, name);
  console.log(`${result.copied ? "copied" : "already"} ${result.hubPath}`);
  console.log(`linked ${result.linked.length}`);
}

async function cmdSubagents(args: string[]): Promise<void> {
  const raw = flag(args, "--agent") ?? "grok";
  const snap = await buildSnapshot();
  const agent = snap.agents.find((item) => item.id === asAgent(raw));
  if (!agent) throw new Error(`unknown agent: ${raw}`);
  if (agent.subagents.length === 0) {
    console.log(t("sub.empty", { agent: agent.id }));
    return;
  }
  for (const sub of agent.subagents) {
    console.log(`${sub.name.padEnd(24)} ${sub.title}`);
    console.log(`                         ${sub.path}`);
  }
}

async function cmdRepair(): Promise<void> {
  const report = await repairLinks();
  console.log(`repaired ${report.repaired.length}  leftover ${report.leftover.length}`);
  for (const item of report.leftover) console.log(`broken ${item}`);
}

async function cmdConflict(args: string[]): Promise<void> {
  const name = args[0];
  const keepRaw = flag(args, "--keep");
  if (!name || (keepRaw !== "hub" && keepRaw !== "agent")) {
    throw new Error("usage: hub conflict <skill> --keep hub|agent [--from <path>]");
  }
  const keep: ConflictKeep = keepRaw;
  const result = await resolveSkillConflict(name, keep, flag(args, "--from"));
  console.log(result.resolved);
}

async function cmdVault(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === "list") {
    const items = catalogItems(await loadVault(), flag(args, "--q"));
    if (items.length === 0) {
      console.log(t("vault.empty"));
      return;
    }
    for (const item of items) {
      const who = item.agents.length ? item.agents.join(",") : t("vault.nobody");
      console.log(`${item.id.padEnd(20)} ${who.padEnd(24)} ${item.note}`);
    }
    return;
  }
  if (sub === "get") {
    const id = args[1];
    const agent = asAgent(flag(args, "--for") ?? "");
    if (!id) throw new Error("usage: hub vault get <id> --for <agent>");
    const got = await vaultGet(agent, id);
    const execArgs = restAfter(args, "--exec");
    if (execArgs) {
      if (execArgs.length === 0) {
        throw new Error("usage: hub vault get <id> --for <agent> --exec -- <cmd>");
      }
      const env = { ...process.env, ...vaultEnvVars(got) };
      await new Promise<void>((resolve, reject) => {
        const child = spawn(execArgs[0]!, execArgs.slice(1), { stdio: "inherit", env });
        child.on("error", reject);
        child.on("close", (code) => {
          process.exitCode = code ?? 1;
          resolve();
        });
      });
      return;
    }
    process.stdout.write(renderVaultGetMeta(got));
    return;
  }
  if (sub === "exec") {
    const agent = asAgent(flag(args, "--for") ?? "");
    const cmdArgs = restAfter(args, "--") ?? restAfter(args, "--exec");
    if (!cmdArgs?.length) throw new Error("usage: hub vault exec --for <agent> -- <cmd>");
    const env = { ...process.env, ...await vaultEnvForAgent(agent) };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmdArgs[0]!, cmdArgs.slice(1), { stdio: "inherit", env });
      child.on("error", reject);
      child.on("close", (code) => {
        process.exitCode = code ?? 1;
        resolve();
      });
    });
    return;
  }
  if (sub === "grant" || sub === "revoke") {
    const id = args[1];
    if (!id) throw new Error(`usage: hub vault ${sub} <id> --for a,b`);
    await transaction(async () => {
    const store = await loadVault();
    const entry = store.entries.find((item) => item.id === id);
    if (!entry) throw new Error(`unknown vault entry: ${id}`);
    const listed = parseFor(args);
    const set = new Set(entry.agents);
    if (sub === "grant") for (const idAgent of listed) set.add(idAgent);
    else for (const idAgent of listed) set.delete(idAgent);
    await setVaultGrants(id, [...set]);
    await syncVaultCatalogs();
    console.log(`${sub} ${id} -> ${[...set].join(",") || t("vault.nobody")}`);
    });
    return;
  }
  throw new Error(`unknown vault command: ${sub}`);
}

async function cmdReveal(args: string[]): Promise<void> {
  const from = asAgent(flag(args, "--from") ?? args[0] ?? "");
  const sessionId = flag(args, "--session") ?? args[1];
  if (!sessionId) throw new Error("usage: hub reveal --from <agent> --session <id>");
  await requireSecretMaterial();
  const row = getSession(from, sessionId);
  if (!row) throw new Error("session not in index");
  const argv = revealArgv(row.source_path);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", () => resolve());
  });
}

async function main(): Promise<void> {
  const [cmd, ...args] = consumeLangFlag(process.argv.slice(2));
  try {
    if (!cmd || cmd === "help" || cmd === "-h") {
      process.stdout.write(help());
      return;
    }
    if (cmd === "scan") await cmdScan();
    else if (cmd === "status") await cmdStatus();
    else if (cmd === "adopt") await cmdAdopt(args);
    else if (cmd === "bind") await cmdBind(args);
    else if (cmd === "sync-memory") printMemoryDelivery(await syncMemoryReport());
    else if (cmd === "memory-scope") console.log(await selectMemoryProject(asAgent(args[0] ?? ""), flag(args, "--project"), flag(args, "--cwd") ?? process.cwd(), args.includes("--global")));
    else if (cmd === "restore-identity") await cmdRestoreIdentity(args);
    else if (cmd === "rm-skill") {
      if (!args[0]) throw new Error("usage: hub rm-skill <name>");
      await removeHubSkill(args[0]);
      console.log(`removed ${args[0]}`);
    }
    else if (cmd === "enable") await cmdEnable(args, true);
    else if (cmd === "disable") await cmdEnable(args, false);
    else if (cmd === "remember") await cmdRemember(args);
    else if (cmd === "import-memory") {
      const result = await importNativeMemory(flag(args, "--agent") ? asAgent(flag(args, "--agent")!) : undefined);
      console.log(`imported ${result.imported.length}  skipped ${result.skipped.length}`);
      for (const id of result.imported) console.log(`  ${id}`);
    }
    else if (cmd === "scrub-handoffs") console.log(`scrubbed ${(await scrubHandoffs()).changed} handoffs`);
    else if (cmd === "index") await cmdIndex(args);
    else if (cmd === "sessions") await cmdSessions(args);
    else if (cmd === "handoff") await cmdHandoff(args);
    else if (cmd === "reveal") await cmdReveal(args);
    else if (cmd === "repair") await cmdRepair();
    else if (cmd === "conflict") await cmdConflict(args);
    else if (cmd === "vault") await cmdVault(args);
    else if (cmd === "project-skills") await cmdProjectSkills(args);
    else if (cmd === "promote") await cmdPromote(args);
    else if (cmd === "subagents") await cmdSubagents(args);
    else if (cmd === "catalog") {
      const sub = args[0];
      if (sub === "on" || sub === "off") {
        if (!args[1]) throw new Error("usage: hub catalog on|off <agent>");
        const config = await setAgentEnabled(asAgent(args[1]), sub === "on");
        console.log(`${args[1]} ${config.agents.enabled.includes(asAgent(args[1])) ? "on" : "off"}`);
      } else {
        const snap = await buildSnapshot();
        for (const row of snap.catalog) {
          console.log(`${row.enabled ? "on " : "off"} ${row.present ? "seen" : "miss"} ${row.id.padEnd(10)} ${row.label}`);
        }
      }
    }
    else if (cmd === "web") {
      const port = Number(flag(args, "--port") ?? "3950");
      await startServer(port);
    } else {
      throw new Error(`unknown command: ${cmd}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(translateError(message, getLang()));
    process.exitCode = 1;
  }
}

await main();
