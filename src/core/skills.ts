import { checkpoint, hubLockEpoch, transaction } from "./transaction.ts";
import fs from "node:fs/promises";
import path from "node:path";
import { HubError } from "./errors.ts";
import { ADAPTERS, adapter, homedir } from "./adapters.ts";
import { ensureHub, hubPaths, loadConfig, resolvedSkillDir } from "./config.ts";
import { parseHubTargets, repairLegacyHubWildcard, setHubTargets, skillAllowedFor } from "./frontmatter.ts";
import {
  assertAbsolutePath,
  assertSafeName,
  assertSafeWritePath,
  copyDir,
  exists,
  hasSkillMd,
  isDir,
  isSymlink,
  listSubdirs,
  moveDir,
  readText,
  readlinkOr,
  realpathOr,
  writeText,
} from "./fsx.ts";
import type {
  AdoptMode,
  AdoptReport,
  AgentId,
  ConflictKeep,
  DetachMode,
  HubConfig,
  LinkState,
  ProjectSkill,
  SkillRecord,
  VendorSkill,
} from "./types.ts";

export type MountedSkill = {
  agent: AgentId;
  name: string;
  path: string;
  symlink: boolean;
  realpath: string | null;
};

// Hub identities are paths relative to the authoritative skills directory.
export function assertSkillName(name: string): string {
  if (!name || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === ".." || /[\x00-\x1f]/.test(part))) throw new HubError("invalid skill name", 400);
  for (const part of name.split("/")) assertSafeName(part, "skill");
  return name;
}

async function skillEntries(dir: string, depth = 0): Promise<{ name: string; path: string }[]> {
  const dirs = await listSubdirs(dir);
  const out: { name: string; path: string }[] = [];
  for (const item of dirs) {
    if (await hasSkillMd(item)) out.push({ name: path.basename(item), path: item });
    else if (depth < 4) out.push(...(await skillEntries(item, depth + 1)));
  }
  return out;
}

export async function skillTreeBlocked(dir: string, _depth = 0, visited = new Set<string>()): Promise<boolean> {
  const real = await realpathOr(dir);
  if (!real) return true; // Broken links cannot be certified safe.
  if (await isBlockedSource(real)) return true;
  if (visited.has(real)) return false;
  visited.add(real);
  if (visited.size > 10000) throw new Error("skill tree exceeds safety scan limit");
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) return false;
  // Regular files cannot escape into a vendor or vault tree. Follow directories and symlinks only.
  for (const entry of await fs.readdir(real, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() && !entry.isDirectory()) continue;
    if (await skillTreeBlocked(path.join(real, entry.name), 0, visited)) return true;
  }
  return false;
}

async function assertMount(dir: string): Promise<void> {
  let probe = path.resolve(dir);
  while (!(await exists(probe))) probe = path.dirname(probe);
  const real = (await realpathOr(probe)) ?? probe;
  if (await isBlockedSource(real)) throw new Error(`protected skill mount: ${dir}`);
  if (!(await fs.stat(probe)).isDirectory()) throw new Error(`skill mount is not a directory: ${dir}`);
  const hub = (await realpathOr(hubPaths().skills)) ?? hubPaths().skills;
  const dest = path.resolve(real, path.relative(probe, dir));
  if (await isBlockedSource(dest)) throw new Error(`protected skill mount: ${dir}`);
  if (dest === hub || hub.startsWith(dest + path.sep) || dest.startsWith(hub + path.sep)) {
    throw new Error(`skill mount overlaps Hub: ${dir}`);
  }
}

let blockedMemo: { epoch: number; home: string; prefixes: string[] } | null = null;

async function blockedPrefixes(): Promise<string[]> {
  const epoch = hubLockEpoch();
  const home = homedir();
  if (epoch && blockedMemo?.epoch === epoch && blockedMemo.home === home) return blockedMemo.prefixes;
  const prefixes: string[] = [];
  const vault = hubPaths().vault;
  prefixes.push((await realpathOr(vault)) ?? path.resolve(vault));
  for (const ad of ADAPTERS) {
    for (const vendorDir of ad.vendorSkillDirs(home)) {
      prefixes.push((await realpathOr(vendorDir)) ?? path.resolve(vendorDir));
    }
  }
  if (epoch) blockedMemo = { epoch, home, prefixes };
  return prefixes;
}

export async function isBlockedSource(realpath: string): Promise<boolean> {
  const abs = path.resolve(realpath);
  for (const prefix of await blockedPrefixes()) {
    if (abs === prefix || abs.startsWith(prefix + path.sep)) return true;
  }
  return false;
}

async function mountedSkillName(file: string, fallback: string): Promise<string> {
  const real = await realpathOr(file);
  const hub = await realpathOr(hubPaths().skills);
  return real && hub && real.startsWith(hub + path.sep) ? assertSkillName(path.relative(hub, real)) : fallback;
}

export async function scanUserSkills(config: HubConfig, extra?: AgentId): Promise<MountedSkill[]> {
  const home = homedir();
  const out: MountedSkill[] = [];
  const ids = extra && !config.agents.enabled.includes(extra) ? [...config.agents.enabled, extra] : config.agents.enabled;
  for (const id of ids) {
    if (adapter(id).memoryOnly) continue;
    const dir = resolvedSkillDir(id, home, config);
    const vendors = adapter(id).vendorSkillDirs(home);
    for (const entry of await skillEntries(dir)) {
      if (vendors.some(vendor => entry.path === vendor || entry.path.startsWith(vendor + path.sep))) continue;
      out.push({
        agent: id,
        name: await mountedSkillName(entry.path, entry.name),
        path: entry.path,
        symlink: await isSymlink(entry.path),
        realpath: await realpathOr(entry.path),
      });
    }
  }
  return out;
}

export async function scanVendorSkills(config: HubConfig): Promise<VendorSkill[]> {
  const home = homedir();
  const out: VendorSkill[] = [];
  for (const id of config.agents.enabled) {
    const ad = adapter(id);
    for (const vendorDir of ad.vendorSkillDirs(home)) {
      for (const entry of await skillEntries(vendorDir)) {
        out.push({ agent: id, name: entry.name, path: entry.path, updatedAt: (await fs.stat(path.join(entry.path, "SKILL.md"))).mtime.toISOString() });
      }
    }
  }
  return out;
}

export async function listHubSkills(): Promise<{ name: string; path: string; targets: string[] | null }[]> {
  const p = hubPaths();
  const out = [];
  for (const entry of await skillEntries(p.skills)) {
    const md = await readText(path.join(entry.path, "SKILL.md"));
    out.push({
      name: assertSkillName(path.relative(p.skills, entry.path)),
      path: entry.path,
      targets: md ? parseHubTargets(md) : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function linkStateFor(
  config: HubConfig,
  skillName: string,
  hubPath: string,
  targets: string[] | null,
  agent: AgentId,
  mounted: MountedSkill[],
): Promise<LinkState> {
  if (adapter(agent).memoryOnly) return "excluded";
  if (config.bind[agent].skills !== "hub") {
    const hit = mounted.find((item) => item.agent === agent && (item.name === skillName || path.relative(resolvedSkillDir(agent, homedir(), config), item.path) === skillName));
    return hit ? "own" : "missing";
  }
  if (!skillAllowedFor(targets, agent, config.layers.skills.default_targets)) return "excluded";
  const dest = path.join(resolvedSkillDir(agent, homedir(), config), skillName);
  const hubReal = await realpathOr(hubPath);
  if (await isSymlink(dest)) {
    const destReal = await realpathOr(dest);
    if (!destReal) return "broken";
    if (hubReal && destReal === hubReal) return "linked";
    return "conflict";
  }
  if (await isDir(dest)) {
    const destReal = await realpathOr(dest);
    if (hubReal && destReal === hubReal) return "linked";
    return "conflict";
  }
  if (await exists(dest)) return "conflict";
  if ((await ownedMounts(resolvedSkillDir(agent, homedir(), config), hubPath)).length) return "linked";
  return "missing";
}

export async function skillRecords(config: HubConfig, preloaded?: MountedSkill[]): Promise<SkillRecord[]> {
  const mounted = preloaded ?? await scanUserSkills(config);
  const hubSkills = await listHubSkills();
  const records: SkillRecord[] = [];
  for (const skill of hubSkills) {
    const links = {} as SkillRecord["links"];
    for (const id of config.agents.enabled) {
      links[id] = await linkStateFor(config, skill.name, skill.path, skill.targets, id, mounted);
    }
    records.push({
      name: skill.name,
      hubPath: skill.path,
      updatedAt: (await fs.stat(path.join(skill.path, "SKILL.md"))).mtime.toISOString(),
      targets: skill.targets,
      links,
    });
  }
  return records;
}

async function uniqueRealDirs(entries: MountedSkill[]): Promise<string[]> {
  const reals = new Set<string>();
  for (const entry of entries) {
    if (!entry.symlink && entry.realpath) reals.add(entry.realpath);
  }
  return [...reals];
}

export type AdoptOpts = { only?: AgentId; includeOwn?: boolean; names?: string[]; deferRelink?: boolean };

type AdoptAction =
  | { name: string; kind: "skip"; reason: string }
  | { name: string; kind: "conflict"; paths: string[] }
  | { name: string; kind: "move"; from: string; to: string }
  | { name: string; kind: "copy"; from: string; to: string }
  | { name: string; kind: "keep"; to: string };

async function planAdoptSkills(
  mode: AdoptMode,
  options: AdoptOpts,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<AdoptAction[]> {
  const p = hubPaths();
  const mountedAll = await scanUserSkills(config, options.only);
  const mounted = mountedAll.filter((item) => {
    if (options.names && !options.names.includes(item.name)) return false;
    if (options.only && item.agent !== options.only) return false;
    const bind = config.bind[item.agent].skills;
    if (bind === "hub") return true;
    return Boolean(options.includeOwn && options.only === item.agent);
  });
  const grouped = new Map<string, MountedSkill[]>();
  for (const item of mounted) {
    const list = grouped.get(item.name) ?? [];
    list.push(item);
    grouped.set(item.name, list);
  }

  const actions: AdoptAction[] = [];
  for (const [name, entries] of grouped) {
    const hubDest = path.join(p.skills, name);
    const hubExists = await exists(hubDest);
    const hubReal = hubExists ? await realpathOr(hubDest) : null;

    if (hubReal && (await isBlockedSource(hubReal))) {
      actions.push({ name, kind: "skip", reason: "Hub 条目指向厂商或保险库，跳过" });
      continue;
    }

    let sourceReal: string | undefined;
    if (!hubExists && mode === "link-existing") {
      actions.push({ name, kind: "skip", reason: "Hub 中还没有这份 skill" });
      continue;
    }

    if (!hubExists && mode === "adopt") {
      const realDirs = await uniqueRealDirs(entries);
      if (realDirs.length > 1) {
        actions.push({ name, kind: "conflict", paths: realDirs });
        continue;
      }
      if (realDirs.length === 1) {
        if (await skillTreeBlocked(realDirs[0]!)) {
          actions.push({ name, kind: "skip", reason: "来源是厂商目录或保险库，不收编" });
          continue;
        }
        sourceReal = realDirs[0];
        const foreign = foreignCopies(mountedAll, name, sourceReal, hubReal);
        if (foreign.length > 0) {
          actions.push({ name, kind: "conflict", paths: foreign.map((item) => item.path) });
          continue;
        }
        actions.push({ name, kind: "move", from: sourceReal, to: hubDest });
        continue;
      }
      const targets = [...new Set(entries.map((item) => item.realpath).filter(Boolean))] as string[];
      if (targets.length !== 1) {
        actions.push({ name, kind: "conflict", paths: entries.map((item) => item.path) });
        continue;
      }
      const source = targets[0]!;
      if (await skillTreeBlocked(source)) {
        actions.push({ name, kind: "skip", reason: "来源是厂商目录或保险库，不收编" });
        continue;
      }
      sourceReal = source;
      const foreign = foreignCopies(mountedAll, name, sourceReal, hubReal);
      if (foreign.length > 0) {
        actions.push({ name, kind: "conflict", paths: foreign.map((item) => item.path) });
        continue;
      }
      actions.push({ name, kind: "copy", from: source, to: hubDest });
      continue;
    }

    const foreign = foreignCopies(mountedAll, name, sourceReal, hubReal);
    // Another agent's leftover copy must not block this agent from linking the Hub skill.
    const blocking = options.only ? foreign.filter((item) => item.agent === options.only) : foreign;
    if (blocking.length > 0) {
      actions.push({ name, kind: "conflict", paths: blocking.map((item) => item.path) });
      continue;
    }
    actions.push({ name, kind: "keep", to: hubDest });
  }
  return actions;
}

function foreignCopies(
  mountedAll: MountedSkill[],
  name: string,
  sourceReal: string | undefined,
  hubReal: string | null,
): MountedSkill[] {
  return mountedAll.filter((item) => {
    if (item.name !== name) return false;
    if (item.symlink || !item.realpath) return false;
    if (sourceReal && item.realpath === sourceReal) return false;
    if (hubReal && item.realpath === hubReal) return false;
    return true;
  });
}

export async function adoptSkills(mode: AdoptMode = "adopt", opts?: AdoptOpts | AgentId): Promise<AdoptReport> {
  return transaction(async () => {
    const options: AdoptOpts = typeof opts === "string" ? { only: opts, includeOwn: true } : (opts ?? {});
    await ensureHub();
    const config = await loadConfig();
    const actions = await planAdoptSkills(mode, options, config);
    const mountIds = options.only && !config.agents.enabled.includes(options.only) ? [...config.agents.enabled, options.only] : config.agents.enabled;
    for (const id of mountIds) {
      if (config.bind[id].skills === "hub" || options.only === id) await assertMount(resolvedSkillDir(id, homedir(), config));
    }
    const mountedBefore = await scanUserSkills(config, options.only);
    const report: AdoptReport = { moved: [], linked: [], skipped: [], conflicts: [] };
    for (const action of actions) {
      if (action.kind === "skip") report.skipped.push({ name: action.name, reason: action.reason });
      if (action.kind === "conflict") report.conflicts.push({ name: action.name, paths: action.paths });
    }

    for (const action of actions) {
      if (action.kind === "move") {
        await moveDir(action.from, action.to);
        report.moved.push(action.name);
      } else if (action.kind === "copy") {
        await copyDir(action.from, action.to);
        report.moved.push(action.name);
      }
    }
    // An explicit adoption owns the source mount, including a previously valid external symlink.
    for (const item of mountedBefore) {
      if (options.only && options.only !== item.agent) continue;
      if (config.bind[item.agent].skills !== "hub" && !(options.includeOwn && options.only === item.agent)) continue;
      if (!actions.some((a) => a.name === item.name && (a.kind === "move" || a.kind === "copy"))) continue;
      await checkpoint(item.path);
      if (await isSymlink(item.path)) await fs.unlink(item.path);
      const target = path.join(hubPaths().skills, item.name);
      const md = await readText(path.join(target, "SKILL.md"));
      if (skillAllowedFor(md ? parseHubTargets(md) : null, item.agent, config.layers.skills.default_targets)) {
        await ensureLink(item.path, target);
      }
    }
    if (!options.deferRelink) {
      const linked = await relinkHubSkills(config);
      report.linked.push(...linked);
    }
    return report;
  });
}

export async function relinkHubSkills(config?: HubConfig): Promise<string[]> {
  return transaction(async () => {
    const cfg = config ?? (await loadConfig());
    const home = homedir();
    const hubSkills = await listHubSkills();
    const blocked = new Set<string>();
    const hubReal = new Map<string, string | null>();
    for (const skill of hubSkills) {
      hubReal.set(skill.path, await realpathOr(skill.path));
      if (await skillTreeBlocked(skill.path)) blocked.add(skill.path);
    }
    const linked: string[] = [];
    for (const id of cfg.agents.enabled) {
      if (adapter(id).memoryOnly || cfg.bind[id].skills !== "hub") continue;
      const dir = resolvedSkillDir(id, home, cfg);
      await assertMount(dir);
      await fs.mkdir(dir, { recursive: true });
      const copies = new Map<string, { path: string; real: string | null }[]>();
      for (const entry of await skillEntries(dir)) {
        const list = copies.get(entry.name) ?? [];
        list.push({ path: entry.path, real: await realpathOr(entry.path) });
        copies.set(entry.name, list);
      }
      for (const skill of hubSkills) {
        if (blocked.has(skill.path)) {
          linked.push(`${id}:${skill.name}:skipped`);
          continue;
        }
        const dest = path.join(dir, skill.name);
        const allowed = skillAllowedFor(skill.targets, id, cfg.layers.skills.default_targets);
        if (!allowed) {
          for (const mount of await ownedMounts(dir, skill.path)) {
            await checkpoint(mount);
            await fs.unlink(mount);
            linked.push(`${id}:${skill.name}:unlinked`);
          }
          continue;
        }
        const real = hubReal.get(skill.path) ?? null;
        const others = (copies.get(skill.name) ?? []).filter((item) => path.resolve(item.path) !== path.resolve(dest) && !(real && item.real === real));
        if (others.length && !(await exists(dest))) {
          linked.push(`${id}:${skill.name}:kept-local`);
          continue;
        }
        if (await isSymlink(dest) || !(await exists(dest))) {
          const result = await ensureLink(dest, skill.path);
          if (result !== "skip" && result !== "ok") linked.push(`${id}:${skill.name}`);
        }
      }
    }
    return linked;
  });
}

async function ownedMounts(dir: string, hubPath: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(root: string): Promise<void> {
    if (await isBlockedSource((await realpathOr(root)) ?? root)) return;
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch((e) => {
      if (e.code === "ENOENT") return []; throw e;
    })) {
      const file = path.join(root, entry.name);
      if (entry.isSymbolicLink()) {
        if (await isHubOwnedLink(file, hubPath)) out.push(file);
      } else if (entry.isDirectory()) await walk(file);
    }
  }
  await walk(dir);
  return out;
}

async function isHubOwnedLink(linkPath: string, hubPath: string): Promise<boolean> {
  if (!(await isSymlink(linkPath))) return false;
  const current = await realpathOr(linkPath);
  const want = await realpathOr(hubPath);
  if (current && want && current === want) return true;
  if (current) return false;
  const raw = await readlinkOr(linkPath);
  if (!raw) return false;
  const resolved = path.resolve(path.dirname(linkPath), raw);
  return resolved === path.resolve(hubPath) || raw === path.resolve(hubPath);
}

async function ensureLink(
  linkPath: string,
  target: string,
): Promise<"created" | "ok" | "retargeted" | "skip"> {
  const absTarget = path.resolve(target);
  if (await isSymlink(linkPath)) {
    const current = await realpathOr(linkPath);
    const want = await realpathOr(absTarget);
    if (current && want && current === want) return "ok";
    if (current) return "skip";
    if (await isHubOwnedLink(linkPath, absTarget)) {
      await assertSafeWritePath(path.dirname(linkPath));
      await checkpoint(linkPath);
      await fs.unlink(linkPath);
      await fs.symlink(absTarget, linkPath);
      return "retargeted";
    }
    return "skip";
  }
  if (await exists(linkPath)) return "skip";
  await assertSafeWritePath(path.dirname(linkPath));
  await checkpoint(linkPath);
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(absTarget, linkPath);
  return "created";
}

export async function detachAgentSkills(agent: AgentId, mode: DetachMode): Promise<string[]> {
  return transaction(async () => {
    const home = homedir();
    const dir = resolvedSkillDir(agent, home);
    await assertMount(dir);
    const changed: string[] = [];
    const hubSkills = await listHubSkills();
    for (const skill of hubSkills) {
      for (const dest of await ownedMounts(dir, skill.path)) {
      if (!(await isSymlink(dest))) continue;
      const destReal = await realpathOr(dest);
      const hubReal = await realpathOr(skill.path);
      if (!destReal || !hubReal || destReal !== hubReal) continue;
      if (mode === "detach-copy") {
        const tmpDest = `${dest}.hub-detach-${Date.now()}`;
        await copyDir(skill.path, tmpDest);
        await checkpoint(dest);
        await fs.unlink(dest);
        await fs.rename(tmpDest, dest);
      } else {
        await checkpoint(dest);
        await fs.unlink(dest);
      }
      changed.push(skill.name);
      }
    }
    return changed;
  });
}

export async function setSkillTargets(name: string, targets: string[] | null): Promise<void> {
  return transaction(async () => {
    const md = await readHubSkill(name);
    await writeHubSkill(name, setHubTargets(md, targets));
  });
}

export async function readHubSkill(name: string): Promise<string> {
  assertSkillName(name);
  const p = hubPaths();
  const target = path.join(p.skills, name, "SKILL.md");
  const real = await realpathOr(target);
  const root = await realpathOr(p.skills);
  if (real && (!root || !real.startsWith(root + path.sep) || await isBlockedSource(real))) throw new Error("refusing to read outside Hub skills");
  const md = await readText(target);
  if (md == null) throw new Error(`Hub 中没有 skill: ${name}`);
  return md;
}

export async function writeHubSkill(name: string, content: string): Promise<void> {
  return transaction(async () => {
    assertSkillName(name);
    const p = hubPaths();
    const mdPath = path.join(p.skills, name, "SKILL.md");
    if (!(await exists(mdPath))) throw new Error(`Hub 中没有 skill: ${name}`);
    const real = (await realpathOr(mdPath)) ?? path.resolve(mdPath);
    if (await isBlockedSource(real) || (await skillTreeBlocked(path.dirname(mdPath)))) {
      throw new Error("refusing to write vendor or vault path");
    }
    const hubSkillsReal = (await realpathOr(p.skills)) ?? path.resolve(p.skills);
    if (real !== hubSkillsReal && !real.startsWith(hubSkillsReal + path.sep)) {
      throw new Error("refusing to write outside Hub skills");
    }
    await writeText(mdPath, content);
    await relinkHubSkills();
  });
}

export async function removeHubSkill(name: string): Promise<void> {
  return transaction(async () => {
    assertSkillName(name);
    const p = hubPaths();
    const dest = path.join(p.skills, name);
    await assertSafeWritePath(dest);
    if (!(await exists(dest))) throw new Error(`Hub 中没有 skill: ${name}`);
    const config = await loadConfig();
    const home = homedir();
    for (const id of config.agents.enabled) {
      const dir = resolvedSkillDir(id, home, config);
      await assertMount(dir);
      for (const link of await ownedMounts(dir, dest)) { await checkpoint(link); await fs.unlink(link); }
    }
    await checkpoint(dest);
    await fs.rm(dest, { recursive: true, force: true });
  });
}

export async function conflictRows(
  config?: HubConfig,
  preloadedRecords?: SkillRecord[],
  preloadedMounted?: MountedSkill[],
): Promise<{ name: string; agent: AgentId; path: string }[]> {
  const cfg = config ?? (await loadConfig());
  const mounted = preloadedMounted ?? await scanUserSkills(cfg);
  const records = preloadedRecords ?? await skillRecords(cfg, mounted);
  const out: { name: string; agent: AgentId; path: string }[] = [];
  for (const rec of records) {
    for (const id of cfg.agents.enabled) {
      if (rec.links[id] !== "conflict") continue;
      const hit = mounted.find((item) => item.agent === id && (item.name === rec.name || path.relative(resolvedSkillDir(id, homedir(), cfg), item.path) === rec.name));
      out.push({
        name: rec.name,
        agent: id,
        path: hit?.path ?? path.join(resolvedSkillDir(id, homedir(), cfg), rec.name),
      });
    }
  }
  const names = new Set(records.map((r) => r.name));
  for (const item of mounted) {
    if (names.has(item.name) || cfg.bind[item.agent].skills !== "hub") continue;
    const peers = mounted.filter((p) => p.name === item.name);
    if (new Set(peers.map((p) => p.realpath)).size > 1) out.push({ name: item.name, agent: item.agent, path: item.path });
  }
  return out;
}

export async function brokenRows(
  config?: HubConfig,
  preloadedRecords?: SkillRecord[],
): Promise<{ name: string; agent: AgentId; path: string }[]> {
  const cfg = config ?? (await loadConfig());
  const records = preloadedRecords ?? await skillRecords(cfg);
  const out: { name: string; agent: AgentId; path: string }[] = [];
  for (const rec of records) {
    for (const id of cfg.agents.enabled) {
      if (rec.links[id] !== "broken") continue;
      out.push({
        name: rec.name,
        agent: id,
        path: path.join(resolvedSkillDir(id, homedir(), cfg), rec.name),
      });
    }
  }
  return out;
}

export async function repairLinks(): Promise<{ repaired: string[]; leftover: string[] }> {
  return transaction(async () => {
    const repaired: string[] = [];
    for (const skill of await skillEntries(hubPaths().skills)) {
      if (await skillTreeBlocked(skill.path)) continue;
      const file = path.join(skill.path, "SKILL.md");
      const original = await readText(file);
      if (original === null) continue;
      const fixed = repairLegacyHubWildcard(original);
      if (fixed !== original) { await writeText(file, fixed); repaired.push(`${skill.name}:yaml-wildcard`); }
    }
    const config = await loadConfig();
    for (const agent of config.agents.enabled) {
      if (!adapter(agent).memoryOnly && config.bind[agent].skills === "own") {
        for (const name of await detachAgentSkills(agent, "detach-copy")) repaired.push(`${agent}:${name}:detached`);
      }
    }
    repaired.push(...await relinkHubSkills(config));
    const leftover = (await brokenRows()).map((row) => `${row.agent}:${row.name}`);
    return { repaired, leftover };
  });
}

export async function resolveSkillConflict(
  name: string,
  keep: ConflictKeep,
  fromPath?: string,
  agent?: AgentId,
): Promise<{ resolved: string }> {
  return transaction(async () => {
    assertSkillName(name);
    await ensureHub();
    const config = await loadConfig();
    const p = hubPaths();
    const hubDest = path.join(p.skills, name);
    if (agent && config.bind[agent].skills !== "hub") throw new Error("Skills=Own：请先通过绑定流程明确收编");
    if (keep !== "hub" && keep !== "agent") throw new Error("invalid conflict choice");
    if (keep === "hub" && !(await exists(hubDest))) throw new Error(`Hub 中没有 skill: ${name}`);
    const mounted = (await scanUserSkills(config)).filter((item) => item.name === name || path.relative(resolvedSkillDir(item.agent, homedir(), config), item.path) === name);
    const hubReal = await realpathOr(hubDest);
    const foreign = mounted.filter((item) => {
      if (agent && item.agent !== agent) return false;
      if (!agent && config.bind[item.agent].skills !== "hub") return false;
      return item.realpath && item.realpath !== hubReal;
    });
    for (const item of foreign) await assertMount(path.dirname(item.path));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const bakRoot = path.join(p.backups, "skills-conflict", name, stamp);

    if (keep === "hub") {
      for (const item of foreign) {
        await copyDir(item.path, path.join(bakRoot, item.agent));
        await checkpoint(item.path);
        await fs.rm(item.path, { recursive: true, force: true });
        // relink applies target exclusions and Own policy.
        if (config.bind[item.agent].skills === "hub") await relinkHubSkills(config);
      }
      await relinkHubSkills(config);
      return { resolved: `${name}: keep-hub` };
    }

    const source = fromPath
      ? foreign.find((item) => item.path === fromPath || item.realpath === fromPath)
      : foreign[0];
    if (!source?.realpath) throw new Error(`没有可采用的 Agent 副本: ${name}`);
    if (await skillTreeBlocked(source.realpath)) throw new Error("protected skill source");
    if (await exists(hubDest)) {
      await copyDir(hubDest, path.join(bakRoot, "hub"));
      await checkpoint(hubDest);
      await fs.rm(hubDest, { recursive: true, force: true });
    }
    if (source.symlink || config.bind[source.agent].skills !== "hub") await copyDir(source.realpath, hubDest);
    else await moveDir(source.path, hubDest);
    if (source.symlink && config.bind[source.agent].skills === "hub") {
      await checkpoint(source.path);
      await fs.unlink(source.path);
    }
    await relinkHubSkills(config);
    return { resolved: `${name}: keep-agent ${source.agent}` };
  });
}

export const PROJECT_SKILL_RELS = [".cursor/skills", ".agents/skills", ".codex/skills", ".grok/skills", ".claude/skills", ".hermes/skills", ".workbuddy/skills"];

export async function scanProjectSkills(cwd: string): Promise<ProjectSkill[]> {
  const root = assertAbsolutePath(cwd, "cwd");
  if (!(await isDir(root))) throw new Error(`cwd not a directory: ${cwd}`);
  const hubNames = new Set((await listHubSkills()).map((item) => item.name));
  const out: ProjectSkill[] = [];
  for (const rel of PROJECT_SKILL_RELS) {
    for (const entry of await skillEntries(path.join(root, rel))) {
      out.push({
        name: entry.name,
        path: entry.path,
        rel: path.relative(root, entry.path),
        inHub: hubNames.has(entry.name),
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function promoteProjectSkill(
  cwd: string,
  name: string,
): Promise<{ hubPath: string; copied: boolean; linked: string[] }> {
  return transaction(async () => {
    const safe = assertSafeName(name, "skill");
    const matches = (await scanProjectSkills(cwd)).filter((item) => item.name === safe);
    if (matches.length > 1) throw new Error(`项目 skill 同名冲突，请先明确来源：${matches.map(item => item.rel).join("、")}`);
    const found = matches[0];
    if (!found) throw new Error(`仓库里没有项目 skill: ${safe}`);
    await ensureHub();
    const dest = path.join(hubPaths().skills, safe);
    let copied = false;
    if (await exists(dest)) {
      const hubReal = await realpathOr(dest);
      const srcReal = await realpathOr(found.path);
      if (!hubReal || !srcReal || hubReal !== srcReal) {
        throw new Error(`Hub 已有同名 skill: ${safe}。不会覆盖仓库或 Hub。`);
      }
    } else {
      if (await skillTreeBlocked(found.path)) {
        throw new Error("来源是厂商目录或保险库，不能提升");
      }
      await copyDir(found.path, dest);
      copied = true;
    }
    const linked = await relinkHubSkills();
    return { hubPath: dest, copied, linked };
  });
}
