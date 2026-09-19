import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HubError } from "./errors.ts";
import { checkpoint } from "./transaction.ts";

export function assertSafeName(name: string, label = "name"): string {
  if (!name || name !== path.basename(name) || name === "." || name === "..") {
    throw new HubError(`invalid ${label}`, 400);
  }
  if (name.includes("\0")) throw new HubError(`invalid ${label}`, 400);
  return name;
}

export function assertAbsolutePath(target: string, label = "path"): string {
  if (!path.isAbsolute(target)) throw new Error(`${label} must be absolute`);
  return path.resolve(target);
}

/** Parse JSON from disk; corrupt or empty files degrade to `fallback` instead of taking down the hub. */
export function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw?.trim()) return fallback;
  try {
    const value = JSON.parse(raw) as unknown;
    return value == null ? fallback : (value as T);
  } catch {
    return fallback;
  }
}

/** Keep the newest timestamp-prefixed files; manifests like current.json stay. */
export const MAX_BACKUP_FILES = 20;

export async function pruneBackupDir(dir: string, keep = MAX_BACKUP_FILES): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const keepAlways = new Set(["current.json"]);
  const files = names
    .filter((name) => !keepAlways.has(name) && !name.endsWith(".meta.json") && !name.includes(".tmp-"))
    .sort();
  const drop = files.slice(0, Math.max(0, files.length - keep));
  for (const name of drop) {
    await fs.rm(path.join(dir, name), { recursive: true, force: true });
    await fs.rm(path.join(dir, `${name}.meta.json`), { force: true });
  }
}

/** Keep the newest files that share a filename prefix (e.g. vault.bin.broken-). */
export async function prunePrefixedFiles(dir: string, prefix: string, keep = MAX_BACKUP_FILES): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const files = names.filter((name) => name.startsWith(prefix)).sort();
  const drop = files.slice(0, Math.max(0, files.length - keep));
  for (const name of drop) {
    await fs.rm(path.join(dir, name), { force: true });
  }
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

export async function isDir(target: string): Promise<boolean> {
  try {
    const st = await fs.lstat(target);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function readlinkOr(target: string): Promise<string | null> {
  try {
    return await fs.readlink(target);
  } catch {
    return null;
  }
}

export async function isSymlink(target: string): Promise<boolean> {
  try {
    const st = await fs.lstat(target);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}

export async function realpathOr(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch {
    return null;
  }
}

export async function readText(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export async function assertSafeWritePath(target: string): Promise<void> {
  let current = path.resolve(target);
  for (;;) {
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${current}`);
      if (current === path.resolve(target) && stat.isFile() && stat.nlink > 1) {
        throw new Error(`refusing to write shared hard link: ${current}`);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
    // macOS /var and /tmp are system aliases; application paths below them were checked.
    if (current === "/var" || current === "/tmp") break;
  }
}

export async function writeText(target: string, content: string): Promise<void> {
  let mode = 0o600;
  try { mode = (await fs.stat(target)).mode & 0o777; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await writeBinary(target, Buffer.from(content), mode);
}

export async function writeBinary(target: string, data: Uint8Array, mode = 0o600): Promise<void> {
  await assertSafeWritePath(target);
  await checkpoint(target);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${randomUUID()}`;
  try {
    const file = await fs.open(temp, "wx", mode);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await fs.rename(temp, target);
    const directory = await fs.open(path.dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temp, { force: true }); }
}

export async function readBinary(target: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  }
}

export async function removeFile(target: string): Promise<void> {
  await assertSafeWritePath(target);
  await checkpoint(target);
  try {
    await fs.unlink(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function readHead(target: string, maxBytes = 256_000): Promise<string | null> {
  try {
    const fh = await fs.open(target, "r");
    try {
      const buf = Buffer.alloc(Math.min(maxBytes, 1_048_576));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export async function mtimeMs(target: string): Promise<number> {
  try {
    const st = await fs.stat(target);
    return Math.trunc(st.mtimeMs);
  } catch {
    return 0;
  }
}

export async function listSubdirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

export async function hasSkillMd(dir: string): Promise<boolean> {
  try {
    await fs.stat(path.join(dir, "SKILL.md"));
    return true;
  } catch {
    return false;
  }
}

export async function moveDir(src: string, dest: string): Promise<void> {
  await checkpoint(src); await checkpoint(dest);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

export async function copyDir(src: string, dest: string): Promise<void> {
  await checkpoint(dest);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true, verbatimSymlinks: true });
}

export async function ensureSymlink(
  linkPath: string,
  target: string,
): Promise<"created" | "ok" | "retargeted" | "skip"> {
  const absTarget = path.resolve(target);
  if (await isSymlink(linkPath)) {
    const current = await realpathOr(linkPath);
    const want = await realpathOr(absTarget);
    if (current && want && current === want) return "ok";
    if (current) return "skip";
    await fs.unlink(linkPath);
    await fs.symlink(absTarget, linkPath);
    return "retargeted";
  }
  if (await exists(linkPath)) {
    throw new Error(`refusing to replace non-symlink: ${linkPath}`);
  }
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  await fs.symlink(absTarget, linkPath);
  return "created";
}

// Inspect and read the same descriptor; never follow a final-component symlink.
export async function readRegularText(target: string): Promise<string | null> {
  let file;
  try {
    file = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile()) return null;
    return await file.readFile("utf8");
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  } finally { await file?.close(); }
}
