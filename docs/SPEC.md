# Agent Hub 技术规格

状态：草稿。与 [PRD](PRD.md) 配套。未实现前以本文约束目录、绑定语义和安全边界。

## 1. 范围

Agent Hub 是本机控制面：权威存储 + 适配器投递 + 两页 UI + 可选 CLI。不包含模型推理、Provider 路由、云同步。

当前登记 23 个适配器，完整清单见第 4 节。七项原有适配器按能力开放；十六项新增适配器仅开放 Memory。会话扫描支持 grok/cursor/codex/hyper/hermes/claude；其他客户端不得设置 Sessions=index。新配置缺省只启用原五项和已检测到的客户端，schema 升级不再静默扩名单。

## 2. 关键决策

| 决策 | 选择 | 理由 |
|---|---|---|
| 权威目录 | `~/.agent-hub/`，与本仓库分离 | 源码和运行数据分开；可换机器只拷数据目录 |
| 用户 skill | 一份目录 + symlink 投递 | 已在盘龙 skill 上验证 |
| 厂商 skill | 不收编 | 官方更新会与 Hub 冲突 |
| Identity | 每 Agent 一份，不进 Hub | 运行时人格不可合并 |
| 项目约定 | 仓库 `AGENTS.md`，不拷进 Hub | 避免与 git 双源 |
| 记忆 | 按项目一份 markdown，只读注入 | 禁止按 Agent 分叉，禁止与 sqlite 双向同步 |
| 会话 | 索引 + 交接，不搬原文 | 各家 jsonl 格式不同 |
| 密钥 | 第六层加密库，按名授权调用 | 禁止当 SKILL.md 软链 |
| UI | 两页：Hub 内容 / Agents 绑定 | CC Switch 手感；下拉是层开关不是第二套编辑器 |
| 加密 | AES-256-GCM + macOS Keychain 主密钥 | 防误读、误提交；不防已被授权的 Agent |
| 实现形态 | GUI 与 CLI 共用同一后端 | 终端用户不被迫开窗 |

## 3. 仓库与运行时布局

```text
~/agent-hub/                 # 本仓库（文档与日后源码）
~/.agent-hub/                # 运行时权威数据（默认）
  config.toml
  skills/<name>/SKILL.md
  ctx/USER.md
  memory/global.md
  memory/projects/<repo-id>.md
  sessions/index.sqlite
  sessions/handoff/<id>.md
  vault/vault.bin            # 密文，禁止明文旁路
  backups/                   # Identity / 绑定切换时的 bak
```

`config.toml` 可覆盖 `root`，但默认必须是 `~/.agent-hub`。Vault 子目录加入该数据目录的忽略规则；本仓库 `.gitignore` 已排除密文样例。

## 4. 配置

```toml
# ~/.agent-hub/config.toml

[agents]
enabled = ["grok", "cursor", "codex", "hyper", "workbuddy"]

[layers.skills]
default_targets = ["*"]

[layers.ctx]
project_agents_md = "in-repo"
global_targets = ["hyper", "workbuddy", "grok"]

[layers.memory]
write = "hub-only"

[layers.sessions]
index = ["grok", "cursor", "codex", "hyper"]
store_transcripts = false

[layers.vault]
# 缺省全部关闭，避免覆盖 grok login
default = "off"
```

每 Agent 的层绑定存在 `config.toml` 的 `[bind.<id>]`：

```toml
[bind.grok]
skills = "hub"
ctx = "own"
memory = "own"
sessions = "index"
vault = "off"

[bind.cursor]
skills = "hub"
ctx = "own"
memory = "own"
sessions = "index"
vault = "off"

[bind.codex]
skills = "hub"
ctx = "own"
memory = "own"
sessions = "index"
vault = "off"

[bind.hyper]
skills = "hub"
ctx = "own"
memory = "own"
sessions = "index"
vault = "off"

[bind.workbuddy]
skills = "own"
ctx = "own"
memory = "own"
sessions = "own"
vault = "off"
```

合法值：

- `skills` / `ctx` / `memory`：`hub` | `own`
- `sessions`：`own` | `index`（禁止 `hub`）
- `vault`：`off` | `own` | `hub`

缺省与 PRD §11 一致：Skills 先 Hub；Identity / Ctx / Memory / Vault 先 Own 或关。Hyper 的 Ctx 也是 Own，第一次启动不投影 `USER.md`。`layers.ctx.global_targets` 只表示谁**可以**切到 Hub，不是缺省绑定。

## 5. 适配器登记

适配器按能力登记扫描、技能挂载点、人设路径和投影/注入；不支持的能力在 UI 和 API 同时关闭。下面列出最初五项路径；Hermes 使用 ~/.hermes/SOUL.md 与 ~/.hermes/skills，Claude 使用 ~/.claude/CLAUDE.md 与 ~/.claude/skills。十六项 Memory 专用适配器的原生路径见热门 Agent 附录。路径以本机 macOS 为准，适配器内可覆盖。

| id | Identity 文件 | 用户 skill 挂载点 | 不碰的目录 |
|---|---|---|---|
| grok | `~/.grok/IDENTITY.md`（旁路，若不存在则创建） | `~/.grok/skills` | `~/.grok/bundled/skills` |
| cursor | `~/.cursor/IDENTITY.md`（旁路；可另写一条 user rule 指向它） | `~/.cursor/skills` | `~/.cursor/skills-cursor` |
| codex | `~/.codex/IDENTITY.md`（旁路） | `~/.codex/skills` | marketplace / bundled plugins |
| hyper | `~/.grok-hyper/AGENT.md` | hyper 配置的 skills 目录 | — |
| workbuddy | `~/.workbuddy/IDENTITY.md`；口吻补充 `SOUL.md` | `~/.workbuddy/skills` | — |

补充：

- Grok `~/.grok/agents/*.md`：子代理人设，Agents 页 Grok 卡片内列表，不进 Hub。
- WorkBuddy `USER.md`：用户侧，可参与 Ctx=Hub 投影；不要和 Identity 捆成一个开关。
- Codex `rules/*.rules`：权限规则，不是 Identity。
- 仓库 `AGENTS.md`：项目 Ctx，所有适配器在该 cwd 直接读，Hub 不复制。

扫描还要能发现：厂商 skill 目录、原生会话路径、原生记忆文件（只读展示，默认不 adopt）。

## 6. 层：存储与投递

### 6.1 Identity（不进 Hub）

- 读写上表「Identity 文件」。
- Cursor / Grok / Codex 的权威文件仍是上表路径；保存时额外投影到运行时会加载的只读副本：`~/.cursor/rules/hub-generated-identity.mdc`（alwaysApply）、`~/.grok/rules/hub-identity.md`、`~/.codex/AGENTS.md` 中的 Hub 标记块。Hyper / WorkBuddy / Hermes / Claude 直接读写原生人设文件。
- Memory-only 适配器无人设编辑入口。
- UI 仅出现在 Agents 页卡片。
- 备份写到 `~/.agent-hub/backups/identity/<agent>/<timestamp>.md`，恢复写回原路径。
- 禁止 `~/.agent-hub/identity/`。
- 「从 USER.md 生成草稿」：把 Hub `ctx/USER.md` 追加到编辑器，用户保存后只写 Identity 文件，不建同步关系。
- Ctx=Hub **不得**覆盖 Identity 路径。

### 6.2 Skills

权威：`~/.agent-hub/skills/<name>/`，须含 `SKILL.md`。

Frontmatter 扩展（可选）：

```yaml
hub:
  targets: [grok, hyper]   # 缺省 = config default_targets
```

投递规则：当 `bind.<agent>.skills == hub` 且该 skill 的 `hub.targets` 包含该 agent（或为 `*`）时，在挂载点创建指向权威目录的 symlink。厂商目录永不创建 Hub 链。

`targets` 只在该 Agent Skills=Hub 时生效。Skills=Own 时忽略。

项目 skill（仓库内 `.cursor/skills`、`.agents/skills` 等）不扫描进个人 Hub，除非用户执行「提升」。

### 6.3 Ctx

权威：

- `~/.agent-hub/ctx/USER.md`
- 当前工作区 `AGENTS.md`（in-repo）

`bind.ctx=hub`：仅投影 `USER.md` 到适配器声明的用户短文件路径（例如 WorkBuddy `USER.md`）。不得写入 `AGENT.md` / `IDENTITY.md` / `SOUL.md`。

项目 `AGENTS.md` 无绑定开关。过长时不在 Hub 侧自动裁剪；Hyper 自己的长度限制仍由 Hyper 执行。

### 6.4 Memory

权威：`memory/global.md`、`memory/projects/<repo-id>.md`。`repo-id` 建议用仓库名或路径的稳定 slug。

`write = hub-only`：用户只通过 Hub 页或 `hub remember` 改这些文件。

`bind.memory=hub`：向该 Agent 写入标记文件（grok/codex/hyper/workbuddy 为 `memory/hub-generated.md`，cursor 为 `rules/hub-generated.mdc`；hermes/claude 及 Memory 专用适配器为 `<Agent 配置目录>/hub/memory.md`，cline 为 `~/.cache/agent-hub/cline/memory.md`；grokbot/doubao 无原生自动加载入口，生成 Hub 侧 `memory/exports/<id>.md` 供手工导入），内容为 global + 当前项目摘抄。下次同步覆盖。切换回 Own 时删除生成文件，不删 Agent 原有私有记忆。

一次性导入：从 WorkBuddy `memory/*.md` 等读入 Hub，之后断开。

### 6.5 Sessions

索引表（sqlite）字段至少：`agent_id`、`session_id`、`cwd`、`title`、`mtime`、`source_path`、`indexed_at`。禁止复制 jsonl 进 Hub。

`sessions=own`：索引刷新不再扫描该 Agent（扫描名单以 `bind.<agent>.sessions` 为唯一权威），已索引条目不删除，Hub 页默认隐藏；无「交接」入口（或需显式揭隐）。

`sessions=index`：出现在 Hub Sessions 目录，可交接。

交接产物：`sessions/handoff/<id>.md`，含目标 agent、cwd、建议 skill、上一场结论摘要、原 `session_id`。随后调用已有通道（`grok_resume`、Codex `--resume`），不把原轨迹改写成 Hub 格式。

### 6.6 Vault

用户编辑 Markdown；磁盘为 `vault/vault.bin`。

#### 文稿约定

```markdown
# Vault

## <entry-id>
说明: <可检索明文>
地址: <明文，除非标为密钥>
账号: <明文>
密钥: <密钥字段>
密码: <密钥字段>
```

- `##` 标题 = `entry_id`（`[a-z0-9-]+`）。
- 行首字段名匹配 `密钥|密码|token|key|secret`（大小写不敏感）→ 密钥字段。
- 其他字段默认明文；UI 可将任意行标成密钥。
- `说明` 永远明文。

内部存储建议结构化 JSON（条目、明文字段、密文字段、授权 agent 列表、updated_at），整体或按字段 AES-256-GCM。界面再拼回 Markdown。不要把未加密 MD 写到磁盘「再另存一份密文」双源。

#### 加密

- 算法：AES-256-GCM。
- 主密钥：macOS Keychain 服务名 `agent-hub`，账户 `vault-master`。
- 可选应用口令：口令派生（Argon2id）再包一层主密钥；第一期可只做 Keychain。
- 禁止 Base64 当加密。
- 无「导出明文 MD」；备份导出仍是密文包。
- 全文检索默认只搜 `entry_id` 与 `说明`。

#### Hub 调用

当 `bind.<agent>.vault == hub`：

1. 仅返回 `entry.agents` 包含该 agent 的条目。
2. 启动/同步时只投递「可用凭据名 + 说明」短列表，**不含值**。取值走本机 `hub vault exec --for <agent> -- <cmd>`（注入该 Agent 已授权全部条目的环境变量后执行）或 `hub vault get <id> --for <agent> --exec -- <cmd>`。`hub vault get` 默认只打印 id / 说明 / 字段名，禁止把解密值打到 stdout。HTTP `/api/vault/exec-plan` 只返回 argv，永不返回密钥。
3. 禁止把密钥注入已经在跑的 Agent 进程。
4. 禁止生成 `SECRETS.md` / 软链 vault 文稿到 skill 目录。
5. 禁止把解密值写入 Identity、SKILL、handoff、session 索引。

`vault=own`：不读保险库，不改原生 `auth.json`。

`vault=off`：同 own，且 UI 标明「Hub 不提供密钥」。

缺省授权列表为空：新建条目谁都不能取，直到在 Hub Vault 页勾选 Agent。

## 7. 绑定状态机

### Skills Own → Hub

必须弹出（CLI 则要 flag）：

1. `adopt`（推荐）：该 Agent 用户 skill 中 Hub 没有的目录迁入 Hub，再全部改 symlink。
2. `link-existing`：只挂 Hub 已有项；Agent 独有项留下，status 标「未收编」。
3. 取消。

同名冲突：停止，让用户选 `keep-hub` 或 `keep-agent-then-adopt`。禁止静默覆盖。

### Skills Hub → Own

1. `detach-copy`（默认）：symlink 换成独立拷贝。
2. `unlink`：删除 symlink，Agent 该层变空，内容留在 Hub。
3. 取消。

### Ctx / Memory 切到 Hub

先把将被覆盖的目标文件拷到 `backups/`。切回 Own：删 Hub 生成/投影文件，bak 还原（若用户在 Own 期间改了 bak 对应文件，以用户文件为准，不还原）。

### Sessions 切到 index

只登记路径。切回 own：索引隐藏，不删原文。

### Vault 切到 Hub

不迁移各家 auth.json。只开始按授权注入。切到 off/own：停止注入，不删保险库。

## 8. UI 规格

### 8.1 Hub 页

Tab 顺序：Skills、Ctx、Memory、Sessions、Vault。

Skills 表列：名称、来源（用户/厂商）、已挂 Agent、更新时间。厂商行不可编辑、不可删除、不可 adopt。

Vault 表/编辑器：Markdown 源码；密钥字段显示掩码；「显示」需点击；失焦再掩。每条 `##` 块旁一排 Agent 授权（亮=该 Agent 可 `vault.get`）。关闭预览默认。

Sessions 表列：来源 Agent、标题、cwd、mtime。动作：打开源路径、交接。无编辑原文。

### 8.2 Agents 页

卡片顺序与 `agents.enabled` 一致。每卡结构固定：

1. Identity 编辑器（必有路径展示）
2. 层绑定表：Skills / Ctx / Memory / Sessions / Vault
3. 每层当前解析路径一行小字

Identity 无下拉。Ctx 行对「项目 AGENTS.md」加只读说明：始终 in-repo。

不要在本页提供第二套 skill 正文编辑、第二套 Vault 密钥全文。Vault=Hub 时只列出已授权条目名。

### 8.3 Markdown 编辑器组件

用于：Identity、USER.md、AGENTS.md、Memory、Vault 文稿、SKILL.md。

- 纯文本 Markdown，等宽字体。
- 可选预览；Vault 实例 `previewEnabled=false`。
- 保存快捷键；脏状态提示。
- 「外部打开」：系统默认编辑器，回来 reload。
- 不在第一期做协同光标、插件市场、WYSIWYG。

## 9. CLI（与 GUI 同一后端）

```text
hub status
hub scan
hub adopt [--repair]
hub enable  <skill> --for a,b
hub disable <skill> --for a
hub bind    <agent> <layer> <value>
hub restore-identity <agent> [--list] [--backup <name>]
hub remember "<text>" [--project <repo-id>]
hub handoff --from <agent> --to <agent> --session <id> --cwd <abs>
```

`enable`/`disable` 只改该 skill 的 `hub.targets`，不改层总闸。层总闸用 `hub bind`。

## 10. 安全

1. 用户 skill symlink 不得指向 `vault/`。
2. 进程环境注入的密钥不写日志；适配器对已知密钥值做红acted。
3. `~/.agent-hub/vault/` 权限 `0700`，`vault.bin` `0600`。
4. 不把数据目录放到 iCloud Desktop/Documents 同步路径；若检测到，启动时警告。
5. Identity 备份同样不含 Vault 值。
6. Hub 模式不等于该 Agent 可枚举全部条目。

威胁模型：防本机其他用户/误操作/误 git 提交。不防已获 Vault=Hub 授权且能执行工具的 Agent 把密钥发出去。产品文案不得承诺「Agent 无法泄露」。

## 11. 与现有工具的边界

| 工具 | 关系 |
|---|---|
| cursor-grok-bridge | Session 交接执行器，Hub 调用不重写 |
| Codex `external_agent_session_imports` | Cursor→Codex 只读通道；Hub 只登记 |
| grok-hyper | 一等适配器；尊重 `AGENT.md` 人设边界 |
| `~/.skillhub` | 外部市场客户端，不当权威层 |
| CC Switch | 交互参考；不共用 `~/.cc-switch/skills`；不做 Provider |
| 炉子 / luzi.ai | 思路参考；不做社区与云端 |

## 12. 状态展示

`status` 对每个用户 skill × enabled Agent 输出：

- `linked`：symlink 指向 Hub
- `own`：该层为 Own，或未挂
- `vendor`：出现在厂商目录
- `broken`：symlink 断了
- `conflict`：同名且未 adopt
- `excluded`：Skills=Hub 但 `hub.targets` 不含该 Agent

Identity 只显示路径与是否存在，不参与上述枚举。

## 13. 实现备注（有意未锁）

以下留到写代码时选，不影响产品语义：

- GUI：Tauri、本地 Web（可挂在 hyper 控制台）或独立窗口均可；须能嵌 MD 编辑器。
- 语言：Rust 或 TypeScript 均可，适配器扫描与 symlink 必须在本机执行，不能只做纯浏览器。
- Session 索引可以用 sqlite 或等价本地库。
- Vault 内部 JSON schema 可在实现时定字段名，须满足「说明明文、密钥字段密文、按条目授权」。

## 14. 验收（文档阶段之后）

见 [PRD 成功标准](PRD.md#12-成功标准)。SPEC 额外要求：

- 切换 Skills Hub↔Own 走第 7 节选项，无静默覆盖。
- Vault 磁盘无明文密钥；Hub 页刷新后掩码仍在。
- Identity 保存不创建 `~/.agent-hub/identity`。
- 项目 `AGENTS.md` 不整份复制进 Hub；显式登记 Memory 工作区时允许只管理原生文件内的 Hub Memory 区块，其余用户正文保持不变。

## 15. 原生 Memory 自动加载补充（2026-09-16）

首次扩展增加 Hermes / Claude Code；当前已扩为 23 项，能力范围见第 1、5 节及热门 Agent 附录。生成副本不再作为自动加载成功证据；Memory=Hub 必须同步到原生入口或明确显示需登记工作区。具体路径、预算、撤销规则与运行验证级别以 [自动加载说明](memory-autoload-2026-09-16.md) 为准。

`POST /api/memory/scope` 支持 `globalOnly: true`，与 `project` 互斥；省略两者则解除工作区。`POST /api/memory/sync` 重放现有绑定与登记作用域。Memory 保存或追加与所有同步处于同一事务，原生预算超限不得提交半套状态。

## 热门 Agent 扩展（2026-09-16）

现有 23 个适配器。新增 OpenCode、Gemini CLI、Cline、Roo Code（已归档）、Kilo Code、Windsurf、GitHub Copilot CLI、Goose、Qwen Code、Pi、OpenClaw、Aider、ZCode、Grok Bot、豆包、Kimi Code，当前开放 Memory 原生自动加载，其他层明确禁用（Grok Bot、豆包无原生入口，仅手工导入导出）。默认 Own；新入口与配置登记使用同一事务，撤销保留用户内容。配置 schema 5 不再把完整旧清单静默扩成二十三项，显式子集和空列表保持不变。详见[适配范围、原生文档与验证边界](popular-agents-2026-09-16.md)。

### 第四轮边界修正

Memory 的唯一绑定权威是 bind.<agent>.memory；已移除无效的 layers.memory.targets，旧字段读取时忽略，下次保存清除。私人记忆不写入 Git 已跟踪文件；未跟踪投递文件及配置在 .git/info/exclude 登记本地排除，关闭后保留排除以避免后续误提交（git add -f 仍可强制添加）。拒绝疑似同步目录，Cline 仅使用登记工作区。跨客户端 CLAUDE.md/.cursorrules 回退不可写入，也不可静默遮蔽，需先整理自家入口。已支持 Agents 卡片过滤、从 USER.md 追加一次性人设草稿、Skills 来源/mtime 和可跳过的首次配置向导。过滤不改变绑定，草稿必须显式保存，向导保留 Own/厂商技能和 Vault 状态。

### 第五轮状态语义

Snapshot.warnings 为持续提示列表（含 §10.4 同步目录告警）。vault.status 为 ready/unavailable；正常空库 count=0，读取失败 count=null 并附通用可操作 error，不能将失败显示为空库。UI 的持续提示与操作结果横幅分离，刷新恢复状态。Hermes/Claude 的 Identity 文件不能单独作为安装证据。自定义上下文文件不得绕过 CLAUDE.md/.cursorrules 的跨客户端写入限制。Skill 保存提示应提醒新开对话。


## 2026-09-17 第六轮补充契约

- `PUT /api/vault` 与 `POST /api/vault/grant` 返回 Vault 专属载入数据（`revision`、`masked`、`entries`、`secretFields`、`path`），不返回全局 snapshot。Vault 更新与目录投递失败仍共同回滚；客户端独立刷新其他页面，刷新失败不能撤销提交或显示为保存失败。
- 全局 snapshot 的 Skills 扫描失败时返回 `skillsStatus: "unavailable"` 和明确告警。空数组此时表示不可用，不表示资产数量为零。
- 显示/隐藏秘密不提交或重置草稿。相同 revision 下保留本地秘密字段标记；冲突保留完整草稿。迟到的显示请求不得在窗口失焦后重新显示秘密。
- Vault 不可用时，索引重建、会话展示、交接列表/启动及源路径揭示返回 503；保留已有索引和交接字节，不写错误提示替换文稿。恢复后可重试。
- 普通索引不修改历史交接；`hub scrub-handoffs` 是独立、显式、事务化的维护命令，仅对交接目录内常规 `.md` 文件中的 `# Handoff ` 文稿处理当前已知秘密，不跟随软链。缺失秘密材料时不执行。

## 2026-09-17 第七轮补充契约

- Hub Skill 身份是相对 `skills/` 的安全目录路径，支持 `group/foo`；所有读写、删除和挂载使用同一身份。项目扫描包括 Claude/Hermes/WorkBuddy；同叶名来源不静默去重，提升时明确拒绝歧义。
- 建交接不隐式同步 Memory，只引用当前工作区已生成的目标 Memory；需要新内容时先使用 Memory 同步入口。列表、启动发现及清理不读取 `.md` 软链目标。
- Vault 仅掩码占位符保留旧值，空值表示清空。显式提交的条目级 `secretFields` 可撤销自定义标记；自动识别的秘密字段仍受保护。HTTP `/api/vault/get` 默认返回 `{id, metadata}`，明文需 `reveal: true`。
- Ctrl/Cmd+S 保存当前获得焦点且可见可编辑的编辑器。Agent 人设/口吻/子代理草稿有跨主页面持续未保存提示。
- 不支持的层绑定在配置读取和写入时明确报错；Goose 上下文文件从原生配置读取，不借用 Hub 的同名环境变量。原子文件替换在 rename 后 fsync 父目录。
- 完整行为、兼容变化和实机边界见 [第七轮审计](audit-round7-2026-09-17.md)。

## 2026-09-18 控制面补齐

- `schema_version = 5`。缺省 `agents.enabled` = 原五项 + `isAgentPresent` 检测到的客户端；升级不再把完整目录静默扩进启用名单。显式子集和空列表保持不变。`POST /api/catalog` 与 `hub catalog on|off` 只改启用，不改 bind。
- Snapshot 含 `catalog`（全部适配器启用状态）和 `diskEpoch`（目录监视器防抖后的代数）。Web 轮询 epoch 变化后刷新，不自动 `repair` 软链。
- Identity：Cursor/Grok/Codex 保存与恢复都会同步投影加载入口；Memory-only 适配器拒绝 identity 读写。
- Sessions：Hermes（`~/.hermes/sessions/*.jsonl`）与 Claude Code（`~/.claude/projects/**/*.jsonl`）可 `index`。交接 `resumePlan` 对 cursor/hyper/claude/hermes 给出可执行 argv。
- Vault：`hub vault exec --for <agent> -- <cmd>` 注入该 Agent 已授权全部条目；HTTP 只提供 exec-plan。
