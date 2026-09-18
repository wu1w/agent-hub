# Agent Hub

本机多 Agent 的资产控制面。一份用户资产，按能力绑定到 23 个 Agent；扩展适配器以 Memory 为主。软件自己不跑模型。

源码与文档都在本仓库。运行时数据在 `~/.agent-hub/`。

- [产品需求 PRD](docs/PRD.md)
- [技术规格 SPEC](docs/SPEC.md)
- [2026-09-17 审计修复与升级说明](docs/audit-fixes-2026-09-17.md)
- [第六轮修复及整体审计结果](docs/audit-round6-2026-09-17.md)
- [第七轮修复与回归审计](docs/audit-round7-2026-09-17.md)
- [Computer Use 真实浏览器验收](docs/computer-use-acceptance-2026-09-17.md)

## 它是什么

日常同时开好几套 Agent 时，skill、人设、记忆、会话、密钥散落在各家目录里。Agent Hub 做三件事：

1. **Hub**：用户可改的内容只存一份（skill、用户/项目约定、记忆、加密保险库、会话索引）。
2. **Agents**：每个 Agent 的每一层用下拉选择听 Hub 还是听自己；人设永远是该 Agent 自己的文件。
3. **投递**：选 Hub 的层用软链、投影或按名注入接到对应运行时。选 Own 的层软件不写。

交互抄 [CC Switch](https://github.com/farion1231/cc-switch) 的「一个界面看到所有工具」，不抄它的供应商切换和本地 API 路由。存储思路参考炉子的「权威一份 + 适配器投递」，不做能力广场、邀请码和云端市场。

## 它不是什么

- 不是又一个 Agent / 聊天窗口
- 不是 炉子（luzi.ai）那种社区能力网络
- 不是 CC Switch 那种 Provider / 中转 / 用量面板
- 不是把各家 session jsonl 合成一份可写历史
- 不是把各个人设收成一份再分发

## 六层

| 层 | 权威在哪 | Agent 怎么绑 |
|---|---|---|
| Identity | 各 Agent 自己的人设文件 | 无下拉，软件内 MD 编辑 |
| Skills | `~/.agent-hub/skills/`（用户 skill） | Hub = 软链；Own = 不碰 |
| Ctx | Hub 的 `USER.md`；仓库 `AGENTS.md` | Hub = 投影用户短文件；项目约定始终在仓库 |
| Memory | `~/.agent-hub/memory/` | Hub = 只读注入；Own = 各家私有记忆 |
| Sessions | 各家原文不动；Hub 只建索引 | 仅本 Agent / 列入总目录 |
| Vault | 加密库 `~/.agent-hub/vault/` | 关 / Own / Hub（按名调用，不软链） |

厂商 skill（如 `~/.cursor/skills-cursor`、`~/.grok/bundled/skills`）不收编。

## 目标运行时

当前共 23 项。默认启用原五项（Grok CLI、Cursor、Codex、grok-hyper、WorkBuddy）以及本机已检测到的客户端；其余适配器在 Agents 页目录里手动启用。Hermes 与 Claude Code 已有会话扫描器，缺省仍是 Own。新增十六项仅支持 Memory，清单和原生入口见[热门 Agent 适配说明](docs/popular-agents-2026-09-16.md)。以下是最初五项的技能路径：

| id | 运行时 | 用户 skill 目录（示意） |
|---|---|---|
| `grok` | Grok CLI | `~/.grok/skills` |
| `cursor` | Cursor Agent | `~/.cursor/skills` |
| `codex` | Codex | `~/.codex/skills` |
| `hyper` | grok-hyper | `~/.grok-hyper` 技能目录 |
| `workbuddy` | WorkBuddy | `~/.workbuddy/skills` |

已有交接通道继续用，不重写：`cursor-grok-bridge`（Cursor → Grok）、Codex 的 Cursor session import。

## 数据目录

用户资产默认在 `~/.agent-hub/`，与本仓库源码分开。保险库密文不得进 git、不得进 skill 软链、不得进 iCloud 同步。

## 状态

P0–P3 已实现：skill 收编/软链、项目 skill 提升、Memory 注入、Session 索引与短摘要、交接条、Vault、Grok 子代理编辑。

```bash
cd ~/agent-hub
npm install
npm run hub -- scan
npm run hub -- status
npm run hub -- remember "一条长期记忆" --project world
npm run hub -- index
npm run hub -- vault
npm run hub -- vault get xai-api --for grok
npm run hub -- repair
npm run hub -- project-skills --cwd ~/world
npm run hub -- promote --cwd ~/world local-hook
npm run hub -- subagents
npm run hub -- catalog
npm run hub -- catalog on gemini
npm run hub -- vault exec --for grok -- grok
npm run web
# 打开 http://127.0.0.1:3950
```

`hub adopt` 会把各 Agent **用户** skill 目录迁入 `~/.agent-hub/skills` 并按绑定挂软链。厂商目录（如 `~/.cursor/skills-cursor`）不会动。先 `scan` / 在界面里看「尚未收编」再点收编。

CI：GitHub Actions（Node 22）跑 `npm run typecheck`、`npm run check:web`、`npm test`。

实现顺序见 [PRD 分期](docs/PRD.md#14-分期) 与 [SPEC](docs/SPEC.md)。

## 原生记忆自动加载（2026-09-16）

Memory 现支持 Grok CLI、Cursor、Codex、grok-hyper、WorkBuddy，以及新增的 Hermes / Claude Code。新适配器默认 Own；未安装的客户端不会创建伪配置目录。

全局 Memory=Hub 后，在新会话生效。Cursor 和 grok-hyper 使用工作区原生规则，需要先在 Memory 页登记工作区（项目 ID 填 `*` 仅加载全局记忆）。升级已有绑定后可点“重新同步加载入口”。

入口、限制、CLI 用法及真实运行验证见 [自动加载说明](docs/memory-autoload-2026-09-16.md)。

## 热门 Agent 扩展（2026-09-16）

现有 23 个适配器。新增 OpenCode、Gemini CLI、Cline、Roo Code（已归档）、Kilo Code、Windsurf、GitHub Copilot CLI、Goose、Qwen Code、Pi、OpenClaw、Aider、ZCode、Grok Bot、豆包、Kimi Code，当前开放 Memory 原生自动加载，其他层明确禁用（Grok Bot、豆包无原生入口，仅手工导入导出）。默认 Own。配置 schema 5 不再把旧清单静默扩成 23 项；新装缺省只开原五项和已检测到的客户端。详见[适配范围、原生文档与验证边界](docs/popular-agents-2026-09-16.md)。

### 第四轮边界修正

Memory 的唯一绑定权威是 bind.<agent>.memory；已移除无效的 layers.memory.targets，旧字段读取时忽略，下次保存清除。私人记忆不写入 Git 已跟踪文件；未跟踪投递文件及配置在 .git/info/exclude 登记本地排除，关闭后保留排除以避免后续误提交（git add -f 仍可强制添加）。拒绝疑似同步目录，Cline 仅使用登记工作区。跨客户端 CLAUDE.md/.cursorrules 回退不可写入，也不可静默遮蔽，需先整理自家入口。已支持 Agents 卡片过滤、从 USER.md 追加一次性人设草稿、Skills 来源/mtime 和可跳过的首次配置向导。过滤不改变绑定，草稿必须显式保存，向导保留 Own/厂商技能和 Vault 状态。

## 新增桌面 Agent（2026-09-17）

已加入 ZCode、Grok Bot、豆包和 Kimi Code。ZCode/Kimi Code 支持原生 AGENTS.md；Grok Bot/豆包提供明确标注的手动记忆导出。新增项默认 Own，支持范围及限制见[适配说明](docs/desktop-agents-2026-09-17.md)。

## 控制面补齐（2026-09-18）

- 缺省启用 = 原五项 + 已检测到的客户端；`hub catalog on|off` 只改启用名单，不改绑定。
- Cursor / Grok / Codex 保存人设时投影到运行时可加载路径；Cursor 全局 Memory 写入 `~/.cursor/rules/hub-generated.mdc`。
- Hermes / Claude 可 `Sessions=index`；交接给出可执行 argv。Vault=Hub 用 `hub vault exec --for <agent> -- <cmd>` 在子进程注入已授权环境变量，HTTP 只返回命令计划、不返回密钥。
- Web 轮询 `diskEpoch` 刷新状态，不会自动重挂软链。
