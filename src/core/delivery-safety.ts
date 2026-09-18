import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readText, writeText } from "./fsx.ts";
import { HubError } from "./errors.ts";
const exec = promisify(execFile);

/** Local excludes are transactional; tracked instructions must never receive private memory. */
export async function protectMemoryTarget(file: string, _cwd?: string): Promise<void> {
  if (/(^|\/)(Documents|Desktop|Dropbox|OneDrive)(\/|$)|Library\/(Mobile Documents|CloudStorage)|iCloud/i.test(file)) {
    throw new HubError(`记忆投递路径可能被云盘同步：${file}。请使用非同步目录中的工作区。`, 409);
  }
  // Resolve the nearest existing parent of the actual target, including global dotfiles.
  let parent = path.dirname(path.resolve(file));
  while (!(await fs.stat(parent).catch(() => null))) {
    const next = path.dirname(parent);
    if (next === parent) throw new HubError("无法检查投递目标父目录", 409);
    parent = next;
  }
  const physicalFile = path.resolve(await fs.realpath(parent), path.relative(parent, file));
  let root: string;
  try { root = (await exec("git", ["-C", parent, "rev-parse", "--show-toplevel"])).stdout.trim(); }
  catch (error) {
    const e = error as { code?: number | string; stderr?: string };
    if (e.code === 128 && e.stderr?.includes("not a git repository")) return;
    throw new HubError("无法检查工作区 Git 状态；请安装 Git 并检查仓库访问权限后重试。", 409);
  }
  const rel = path.relative(await fs.realpath(root), physicalFile).split(path.sep).join("/");
  if (rel.startsWith("../") || path.isAbsolute(rel)) throw new HubError("投递目标不在当前 Git 工作区内", 409);
  const tracked = await exec("git", ["--literal-pathspecs", "-C", root, "ls-files", "--", rel]);
  if (tracked.stdout.trim()) {
    const quote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    throw new HubError(`拒绝向 Git 已跟踪文件注入私人记忆：${rel}。下一步：支持自定义规则文件的客户端可先配置专用未跟踪入口；支持全局原生加载的客户端可不登记此工作区、仅保留全局 Memory=Hub（Hyper 等工作区模式不能只依赖兼容副本）。如果确认此文件今后只供本地使用，可自行运行 git -C ${quote(root)} rm --cached -- ${quote(rel)}，再重新登记；该命令保留本地文件，但会暂存从版本库删除此文件的变更，请先确认团队影响。`, 409);
  }
  const exclude = (await exec("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).stdout.trim();
  const text = await readText(exclude) || "";
  const rule = "/" + rel.replace(/[\\*?\[\]#! ]/g, "\\$&");
  if (!text.split("\n").includes(rule)) await writeText(exclude, `${text}${text && !text.endsWith("\n") ? "\n" : ""}${rule}\n`);
}
