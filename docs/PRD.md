# Agent Hub 产品需求

状态：P0–P3 已在本仓库实现（CLI + 本地页）。后续仍以本文 + [SPEC](SPEC.md) 为准。

## 1. 背景

操作者同时使用 Grok CLI、Cursor、Codex、grok-hyper、WorkBuddy。四类东西已经散开：

- 用户 skill 在 `~/.cursor/skills`、`~/.grok/skills`、`~/.agents/skills` 等多处拷贝；盘龙 skill 已用 symlink 证明「一份目录、多处挂载」可行。
- 人设各写各的：Hyper 的 `AGENT.md`、WorkBuddy 的 `IDENTITY.md` / `SOUL.md`。
- 记忆形态不同：markdown、sqlite、会话内。
- 会话原文各在各家（Grok 按 cwd 分目录、Cursor jsonl、Codex jsonl）；Codex 已能只读导入 Cursor 轨迹；Cursor 已能通过 `cursor-grok-bridge` 把活交给 Grok。

炉子（luzi.ai）验证了「权威包 + 本机适配器投递」；CC Switch 验证了「一个界面管所有 CLI、skill 软链、一排工具开关」。两者都不覆盖本机多套运行时，也不该做成云端社区或 API 供应商切换器。

## 2. 问题

1. 改一份 skill 要改好几份目录，或忘记改哪一份。
2. 换 Agent 接着干时，找不到上一场会话，只能靠记忆或桥接工具。
3. 人设、项目约定、长期记忆、密钥混在同一类「配置」里，一同步就互相覆盖。
4. 密钥若按 skill 方式软链，等于明文进所有挂载点。

## 3. 目标

1. 用户可编辑的 skill / 用户短文件 / 项目记忆 **只维护一份**，按层决定哪些 Agent 使用。
2. 每个 Agent 有独立 Identity，软件可编辑，**不进 Hub**。
3. 一个桌面（或 Web）界面两页：Hub 管内容，Agents 管绑定；绑定用手感接近 CC Switch 的下拉/开关，而不是先选 Agent 再填四套表单。
4. 短 markdown（人设、规则、Hub 文档、保险库文稿）可在软件内编辑。
5. 密钥单独成层：Markdown 输入 + 说明文字 + 落盘加密；Hub 模式按名字、按授权调用，不把整库注入提示词。
6. 软件不推理、不替代各 Agent 登录态（默认不覆盖 `~/.grok/auth.json` 等）。

## 4. 非目标

- 能力广场、邀请码、炉子天使、云端市场
- 为各 CLI 切换 API Provider、本地反向代理、用量账单（CC Switch 的主业）
- 把各家 session 合成一份可写对话库
- 把各个人设合并后「应用到全部」
- 收编厂商 skill（`~/.cursor/skills-cursor`、`~/.grok/bundled/skills`、Codex marketplace）
- 企业级 KMS、多用户、远程保险库同步（第一期）
- 在 Hub 里实现 Agent 运行时（聊天、工具循环）

## 5. 谁用

第一期只有本机使用者本人。默认路径、适配器列表、首次导入都按这台机器的现有目录设计，但配置里 Agent 列表可增删。

## 6. 产品原则

1. **内容与绑定分离。** 改正文在 Hub（或 Identity 编辑器）；改「听谁的」在 Agents 页。
2. **默认全开例外才配。** 用户 skill 默认对所有 enabled Agent 挂 Hub；细排除写在该 skill 上，且仅当该 Agent 的 Skills 层为 Hub 时生效。
3. **投递不是再存一份。** Skills 用 symlink；Memory/Ctx 用投影或生成文件；Vault 用环境变量/按名读取；Sessions 只索引。
4. **厂商资产不收编。** 官方更新与用户权威库隔离。
5. **层语义不同，交互可以长得像。** 同一套「层 × Agent」表，下拉选项按层解释，禁止用同一个「Hub」词表示「会话存在 Hub 里」。
6. **密钥不是文档。** 唯一加密层。禁止写进 Identity / SKILL.md / 软链目录。

## 7. 信息架构

顶栏两个入口：**Hub** | **Agents**。

### 7.1 Hub 页（内容）

Tab：Skills | Ctx | Memory | Sessions | Vault

- Skills：列表、导入已有、编辑 `SKILL.md`、删除/从 Hub 移除（不删厂商目录）。
- Ctx：编辑 `USER.md`；项目 `AGENTS.md` 显示为打开当前仓库文件，不复制进 Hub。
- Memory：`global.md` 与 `projects/<repo>.md`。
- Sessions：跨 Agent 只读目录；动作是「在原 Agent 恢复」和「交接给…」。
- Vault：带掩码的 Markdown 编辑器 + 每条记录的 Agent 授权。

Hub 页 **没有** Identity tab。

### 7.2 Agents 页（绑定 + 人设）

每个 Agent 一张卡片：

1. **Identity**：内嵌 MD 编辑器，无下拉，始终写该 Agent 原生（或旁路）人设文件。
2. 四层来源下拉：Skills、Ctx、Memory。
3. Sessions 下拉：仅本 Agent | 列入总目录（文案禁止写「Hub 存储」）。
4. Vault 下拉：关 | Own | Hub。
5. 每格下方一行实际路径（软链目标、投影文件、原生目录）。

顶栏 Agent 过滤器只过滤卡片，不是「当前正在用的运行时」。运行时仍由用户打开的窗口决定。

## 8. 六层产品定义

### Identity

这个运行时是谁。每 Agent 一份。软件可编辑、可本地备份回该路径。不可软链、不可「应用到全部」。允许一次性从 Hub `USER.md` 抄草稿，之后断开。

WorkBuddy 的 `IDENTITY.md` + `SOUL.md` 归 Identity；其 `USER.md` 才参与 Ctx。Grok CLI 的 `~/.grok/agents/*.md` 是具名子代理，挂在 Grok 卡片下，同样不进 Hub。

### Skills

用户 skill 权威在 Hub。Skills=Hub 时，向该 Agent 用户 skill 目录建 symlink。Skills=Own 时软件不写该目录。厂商 skill 行在 Hub 列表里只读展示为「厂商」，不可 adopt。

项目 skill 放仓库（`.agents/skills`、`.cursor/skills` 等），不进 Hub，除非用户显式「提升为个人 skill」。

### Ctx

- 用户是谁：Hub `ctx/USER.md`。
- 项目怎么干活：仓库根 `AGENTS.md`，无下拉，cwd 内所有 Agent 共享。
- Ctx=Hub：只投影用户短文件到该 Agent 愿意读取的位置，**不得覆盖 Identity 文件**。
- Ctx=Own：不投影。

### Memory

权威 markdown，按项目切，不按 Agent 切。Memory=Hub：只读注入（生成文件标 `hub-generated`，下次覆盖）。Memory=Own：不注入。禁止与 Codex sqlite / WorkBuddy 记忆文件双向同步。允许一次性导入进 Hub。

### Sessions

原文永远在各家目录。Hub 只维护索引（路径、agent、cwd、id、标题、mtime）。可选短摘要。交接生成 `handoff/*.md`，再调用已有 `grok_resume` / Codex resume，不搬 jsonl。

### Vault

全局一份加密保险库。用户用 Markdown 写名称、说明、地址、账号、密钥。说明可检索；密钥字段掩码与加密。Vault=Hub 的 Agent 只能取**已勾选授权给它的条目**，按名字调用。禁止整篇进 skill 目录或 system prompt。

## 9. Markdown 编辑

以下文件在软件内直接编辑：Identity、Hub `USER.md`、仓库 `AGENTS.md`（打开仓库文件）、Memory、短规则、Vault 文稿、可选 `SKILL.md`。

要求：

- 源码编辑，可折叠预览。
- Vault 默认关闭预览；密钥字段掩码，焦点离开后重新掩码。
- 可「用系统编辑器打开」后重载。
- 非 Vault 文件明文落盘。Vault 仅编辑器内是 Markdown，保存为密文库。

## 10. 关键用户故事

1. 把已有用户 skill 收编进 Hub 并按默认 Agent 回挂软链（首次 `adopt`）。
2. 改 `frontend-design` 正文一次，所有 Skills=Hub 的 Agent 下次读盘即生效。
3. 盘龙 skill 只给 Grok / Hyper：Skills 层为 Hub，该 skill 的 targets 不含 Cursor。
4. `delegate-to-grok-cli` 只给 Cursor。
5. 打开 Agents → Hyper，直接改 `AGENT.md`，不影响 Cursor。
6. 给当前仓库写一条记忆，只注入 Memory=Hub 的 Agent。
7. 从 Sessions 目录把一场 Cursor 对话交接给 Grok（写 handoff + `grok_resume`）。
8. 在 Vault 里用 MD 记录 xAI 地址和密钥并写说明，只授权 Grok/Hyper；Cursor 的 Vault 保持关。
9. 某 Agent Skills 从 Hub 改回 Own：默认把软链变成独立拷贝，避免目录被摘空。

## 11. 首次体验

1. 只读扫描当前启用的适配器（目前登记 23 项），按能力展示安装状态；Memory 专用项不进入技能收编。
2. 导入用户 skill（Skills=Hub 来源默认勾选；Own 来源保留原处，厂商条目不可勾选）。
3. 写入 `~/.agent-hub/`，按缺省绑定建链。
4. 打开 Hub → Skills 能看到列表；打开 Agents 能看到路径与下拉。
5. 不在首次体验里打开 Vault、不迁移记忆、不覆盖人设。

缺省绑定见 SPEC §4。原则：Skills 先 Hub；Identity / Ctx / Memory / Vault 先 Own 或关，避免第一次启动冲掉 WorkBuddy / Codex / Grok / Hyper 登录态。Hyper 的 Ctx 缺省也是 Own，不在首次启动投影 `USER.md`。

## 12. 成功标准

- 用户 skill 在 Hub 改一处，所有已挂 Agent 读到同一 inode（symlink）。
- `hub status`（或界面矩阵）能区分：已挂 Hub / Own / 厂商 / 断链。
- Identity 修改只触达该 Agent 文件。
- Vault 明文不出现在 `~/.agent-hub/skills`、git、session 索引、handoff 正文。
- Own→Hub、Hub→Own 有明确迁移选项，默认不静默覆盖同名 skill。
- 未实现聊天运行时也能完成 adopt、编辑、绑定、索引。

## 13. 风险

| 风险 | 缓解 |
|---|---|
| 已运行的 Agent 不热加载 skill | 状态栏提示「新开对话后生效」 |
| 同名 skill 收编冲突 | 停住让人选 Hub 为准或 Agent 为准 |
| Vault=Hub 后 Agent 把密钥打进日志 | 授权默认空；注入 env 而非文件；已知密钥打码 |
| 把 Identity 误做成 Hub | UI 无下拉；禁止 `~/.agent-hub/identity/` |
| 与 CC Switch 抢 skill 源目录 | 权威目录固定 `~/.agent-hub/skills`，不复用 `~/.cc-switch/skills` |
| 项目 `AGENTS.md` 被复制进 Hub 与 git 打架 | Ctx 项目文件只打开仓库路径 |

## 14. 分期

**P0 — 能用的 Hub 骨架**

- 数据目录、配置、扫描适配器
- Skills 收编 + symlink + status
- 两页 UI 骨架：Hub Skills 列表、Agents 卡片下拉
- 内嵌 MD 编辑器（Identity + SKILL.md + USER.md）

**P1 — 记忆、会话、交接**

- Memory 文件与只读注入
- Session 索引（Grok / Cursor / Codex / Hyper）
- 交接条 + 调用 cursor-grok-bridge / grok resume

**P2 — Vault 与加固**

- Markdown 保险库、Keychain 主密钥、条目授权、按名注入
- Hub↔Own 迁移对话框（拷贝 / 摘链 / 收编）
- 断链修复

**P3 — 体验**

- 项目 skill 提升为个人
- 子代理列表（Grok `agents/*.md`）
- 可选摘要进 session 索引
- CLI 与 GUI 同一后端

## 15. 文档关系

- 产品为什么做、做什么：本文
- 目录、绑定状态机、加密、适配器路径： [SPEC](SPEC.md)
- 仓库入口： [README](../README.md)

## 后续范围：原生记忆自动加载（2026-09-16）

用户要求在原五个运行时基础上兼容 Hermes、Claude Code。新增运行时默认 Own，不接管身份文件或账号。验收须区分文件投递、原生加载器发现以及真实新会话消费；不得只凭生成文件报告自动加载成功。Cursor / grok-hyper 的工作区规则需要明确登记，用户原有规则正文必须保留。详细结果见 [自动加载说明](memory-autoload-2026-09-16.md)。

## 热门 Agent 扩展（2026-09-16）

现有 23 个适配器。新增 OpenCode、Gemini CLI、Cline、Roo Code（已归档）、Kilo Code、Windsurf、GitHub Copilot CLI、Goose、Qwen Code、Pi、OpenClaw、Aider、ZCode、Grok Bot、豆包、Kimi Code，当前开放 Memory 原生自动加载，其他层明确禁用（Grok Bot、豆包无原生入口，仅手工导入导出）。默认 Own；新入口与配置登记使用同一事务，撤销保留用户内容。配置 schema 4 将旧版默认七项列表扩展为二十三项，保留显式裁剪列表。详见[适配范围、原生文档与验证边界](popular-agents-2026-09-16.md)。

### 第四轮边界修正

Memory 的唯一绑定权威是 bind.<agent>.memory；已移除无效的 layers.memory.targets，旧字段读取时忽略，下次保存清除。私人记忆不写入 Git 已跟踪文件；未跟踪投递文件及配置在 .git/info/exclude 登记本地排除，关闭后保留排除以避免后续误提交（git add -f 仍可强制添加）。拒绝疑似同步目录，Cline 仅使用登记工作区。跨客户端 CLAUDE.md/.cursorrules 回退不可写入，也不可静默遮蔽，需先整理自家入口。已支持 Agents 卡片过滤、从 USER.md 追加一次性人设草稿、Skills 来源/mtime 和可跳过的首次配置向导。过滤不改变绑定，草稿必须显式保存，向导保留 Own/厂商技能和 Vault 状态。
