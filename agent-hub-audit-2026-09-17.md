# Agent Hub 当前版本审计

项目：`/Users/william/agent-hub`  
审计日期：2026-09-17；末次源文件完整性核对：2026-09-17T01:12:33Z。  
本机证据目录：`/tmp/agent-hub-audit-20260917-daacKl`。

## 结论与验证边界

当前仍存在资产丢失、秘密脱敏失败、挂载状态不一致、失败后部分提交和原生加载入口隔离不足。117 项现有测试通过不能覆盖这些操作序列。

本轮读取当前 PRD/SPEC、核心模块、HTTP/CLI、Web 脚本与测试；执行现有测试、类型检查、前端语法检查，并在独立 HOME/Hub 根目录中用合成记忆、合成 Vault、临时工作区与独立端口复现。前端补充验证执行原始 JavaScript 事件处理器，使用 Node VM 和 DOM/API 替身，不冒充真实浏览器 Computer Use 验收。没有发起真实模型会话，没有更改项目源文件、个人保险库或个人 Agent 配置。

- 现有测试：117/117，通过；0 失败，0 跳过。
- `npm run typecheck`、`node --check web/app.js`、`node --check web/vault-draft.js` 通过。
- 66 个基线文件 SHA-256 末次核对：0 变化。当前项目目录没有 `.git`，所以版本基线使用文件哈希而非 commit。
- 本轮检查时，3950 端口未发现监听者；未启动或重启正式 Hub。隔离测试服务已停止。
- P1 表示应优先修复的资产、隐私或核心流程缺陷；P2 表示明确的功能、状态或防御缺陷。优先级是本次审计建议，不是外部漏洞评分。

## A01 · P1 · 掩码状态重命名 Vault 条目会丢失原密钥

**位置**：`src/core/vault.ts:40-63,65-83`；`web/vault-draft.js:17-30`。

后端按条目 ID 找旧条目，再按字段名找旧密钥；只有匹配到旧对象才恢复掩码。用户仅修改 `## old-id` 为 `## new-id`，客户端仍提交 `密钥: ••••••••`，后端把占位符保存成真正的密钥值，原条目消失。字段改名也缺少稳定身份映射。

**实测**：`renamedId=new-id`、`storedValue=••••••••`、`originalPreserved=false`。这是数据丢失，不只是显示异常。

**建议**：条目/字段使用不可变内部 ID；重命名通过结构化操作完成；任何无法解析到旧值的掩码占位符必须拒绝保存。保留加密版本备份。未修复前不要在掩码文稿中直接重命名条目或密钥字段。

**证据**：`reproduction-results.json`，F04。

## A02 · P1 · 多行密钥进入会话索引和 handoff

**位置**：`src/core/sessions.ts:55-58,269-305,436-445`；`src/core/secrets.ts:30-41`；`src/core/handoff.ts:174-188`。

会话扫描器先把换行/连续空白折叠，再按 Vault 原始密钥做精确替换。多行密钥已经改变形态，匹配不到。Cursor 的扫描器另外直接在原始 JSONL 字符串上抓取 `<user_query>`，未先解码 JSON 转义。

**实测**：合成密钥 `AUDIT_ALPHA_6371\nAUDIT_BETA_9824` 被保存为 `AUDIT_ALPHA_6371 AUDIT_BETA_9824`；SQLite 摘要和交接条都含完整的折叠后内容。并非仅“可能泄漏”。

**建议**：先解码原始消息，再脱敏，再归一化和截断；索引、交接复用同一脱敏管线。覆盖多行、JSON 转义和截断边界；对已经生成的派生索引/交接制定清理和重建流程。本轮没有检查或宣称个人真实密钥已经泄漏。

**证据**：`reproduction-results.json`，F06。

## A03 · P1 · 全局 Memory 绕过 Git 已跟踪文件保护

**位置**：`src/core/delivery-safety.ts:10-25`；`src/core/deliver.ts:62-78`。

`protectMemoryTarget()` 在没有 cwd 时直接返回。全局原生入口因此只检查同步目录，不检查它是否位于 dotfiles 等 Git 仓库中。

**实测**：在临时 HOME 初始化 Git 并跟踪 `.codex/AGENTS.md`，打开全局 Codex Memory=Hub 后，该已跟踪文件含合成私人记忆，且没有 409。

**影响**：后续普通 Git 提交可能带走私人记忆；本轮仅验证写入，没有执行提交、推送。

**建议**：从实际目标文件的最近存在父目录发现 Git 仓库，全局和工作区入口采用相同保护。不能把“global”当作“不受版本控制”。

**证据**：`confirmation-0112-results.json`，`global_dotfile_git_bypass`。

## A04 · P1 · 嵌套 Skill 遗留软链绕过 targets 和 Own

**位置**：`src/core/skills.ts:343-355,361-398,431-474`。

收编 `skills/group/sample` 时会回挂原嵌套路径，同时创建平铺的 `skills/sample`。后续排除 targets、切换 Own 等逻辑主要操作平铺路径，遗漏嵌套别名。

**实测**：设置空 targets 后，矩阵状态为 `excluded`，但原嵌套路径仍为可用软链；切换 `Own/detach-copy` 后，嵌套路径的 realpath 仍等于 Hub Skill 的 realpath。

**建议**：以实际物理挂载路径维护完整清单；禁用、摘链、独立拷贝、删除和修复操作必须涵盖所有已确认属于 Hub 的别名，并处于同一事务。不要只用 basename 推断挂载点。

**证据**：`confirmation-0112-results.json`，`nested_skill_ownership`。比较已对 `/tmp` 与 `/private/tmp` 做 realpath 归一化。

## A05 · P1 · 修改 targets 后保存正文，悄悄重新挂载被排除的 Agent

**位置**：`web/app.js:235-245,298-318,815-823`。

targets 按钮直接改磁盘 SKILL.md，但没有同步已打开的编辑器。随后保存编辑器，会把旧 frontmatter 整篇写回，再触发重连。

**实测**：先只允许 Grok，Codex 链消失；再保存尚未更新的原编辑器内容，targets 变成 null（继承默认 `*`），Codex 链重新出现。

**建议**：targets 和正文共用一个草稿模型；保存时使用版本校验或结构化 patch，冲突必须显式合并；禁止两个独立写入口互相覆盖。仅补一个刷新按钮不足以解决未保存草稿并存的情况。

**证据**：`reproduction-results.json`，F02。

## A06 · P1 · Vault 返回保存失败，但新值已经提交

**位置**：`src/server.ts:339-357`。

HTTP 先执行 `saveVaultFromMarkdown()` 或 `setVaultGrants()`，再同步目录；两者不在同一事务中。后一步失败时向用户返回通用失败，实际 Vault 已改变。

**实测**：在隔离环境把目录投递目标变成目录，保存新合成密钥返回 HTTP 500，库内已经是新值；拿原 revision 重试返回 409。

**建议**：定义清晰提交协议。可采用原文与投递同事务，或明确返回“已保存、投递失败”并持久化可重试的投递任务和新 revision。不能用一个 500 同时表示“没保存”和“已保存但投递失败”。

**证据**：`reproduction-results.json`，F08。

## A07 · P1 · “新建项目记忆”可以覆盖 global.md

**位置**：`web/app.js:891-900`；`src/server.ts:198-206`；`src/core/files.ts` 的 memory 路径分派。

“新建项目”的按钮复用整篇 PUT 编辑接口，没有保留 ID 或存在性检查。填入 `global`，就以新项目模板覆盖全局记忆；重用已有项目名也没有独立的 create-only 语义。

**实测**：执行原始前端事件处理器，prompt 返回 `global`，全局原文消失。验证使用 Node VM 和 DOM/API 替身，最终落盘使用真实 core。

**建议**：提供 create-only 接口，禁止保留名称，已有 ID 返回 409；新增与编辑不要复用无条件覆盖语义。

**证据**：`confirmation-0112-results.json`，`frontend_handlers_vm.newProjectNamedGlobalOverwroteGlobal`。

## A08 · P2 · targets 通配符生成非法 YAML，解析器自身也不遵循 YAML

**位置**：`src/core/frontmatter.ts:21-37,57-79`；`web/app.js:267-275,285-292`。

写入结果是 `targets: [*]`，没有给 `*` 加引号。项目依赖的标准 YAML 解析器报 `Alias cannot be an empty string`，而 Hub 自己的正则却接受它。

另已复现：非 hub 命名空间的 `other.targets` 被误认为 Hub 配置；块列表的 `"grok"` 被保留为带引号字符串。

**建议**：使用已安装的 YAML AST/parser 读取和更新 `hub.targets`，校验目标列表并保留其他元数据；用同一个真实解析器验证最终产物。不能用同一套宽松正则给自己生成的错误文本做回归验收。

**证据**：`reproduction-results.json`，F01。未逐个启动客户端验证其具体报错形式，因此不宣称所有 Agent 都会同样失败。

## A09 · P2 · 未认证畸形 URL 能让 HTTP 进程退出

**位置**：`src/server.ts:441-470`，尤其 443 行。

`new URL(req.url, ...)` 位于异步错误捕获之外。无效请求目标抛出的同步异常越过了正常 HTTP 错误处理。

**实测**：向临时独立进程发送无效请求目标，进程以 exit code 1 退出，堆栈指向 `server.ts:443`，错误为 `ERR_INVALID_URL`。没有对正式服务进行崩溃测试。

**建议**：把 URL 解析纳入每次请求的 try/catch，返回 400，并回归验证下一条正常请求仍成功。这是本机服务拒绝服务问题，不是已证明的公网攻击或远程代码执行。

**证据**：`confirmation-0112-results.json`，`unauthenticated_request_crash`。

## A10 · P2 · 删除工作区后不能解绑，并阻断全局 Memory 保存

**位置**：`src/core/deliver.ts:116-137,267-288`；`src/core/delivery-safety.ts:14-20`。

解绑前也要求目录实际存在；重放已登记 scope 时，删除目录导致 Git 检查失败。全量同步的事务因此失败，连全局记忆编辑也被回滚。

**实测**：删除临时工作区后，解绑失败且 scope 保留；尝试保存新 global 时失败，global 回滚到旧值。

**建议**：注销使用稳定 scope ID/已登记路径，不要求目录存在；缺失工作区标记不可用并允许安全撤回；保存是否允许其他投递继续要定义清楚，不能要求用户先重建已删仓库才能移除登记。

**证据**：`reproduction-results.json` F09；`confirmation-0112-results.json` `deleted_workspace_blocks_save`。

## A11 · P2 · HTTP 409 后下拉框仍显示 Hub

**位置**：`web/app.js:421,670-735`。

`onBind()` 没有处理 API 失败，也不恢复 select 原值；调用它的事件监听器没有兜底。后端正确拒绝的操作，在控件上仍停留于用户刚选的 Hub。

**实测**：真实函数接收拒绝的 API Promise 后，`visualSelection=hub`，`actualBind=own`。

**建议**：统一 mutation 状态机：pending 禁用、成功使用服务端 snapshot、失败恢复旧值并显示错误。不能把 DOM 的选中值当作绑定事实。

**证据**：`confirmation-0112-results.json`，`frontend_handlers_vm.failedBind`。此处为函数级前端验证，不是浏览器点击验收。

## A12 · P2 · Skills 重连制造“已安装”的假象

**位置**：`src/core/skills.ts:361-373`；`src/core/adapters.ts:190-204`。

重连会为 Skills=Hub 的 Agent 创建用户目录，原四个适配器又以该目录存在作为安装线索。Hermes/Claude 的识别修复没有覆盖整个适配层。

**实测**：空临时 HOME 中，Grok/Cursor/Codex/Hyper 都从 present=false 变成 true，仅执行了重连；没有安装任何客户端。

**建议**：统一区分配置目录存在、可执行运行时存在、登录可用与实际加载验证。Hub 自己创建的投递目录不能成为安装证据。

**证据**：`reproduction-results.json`，F03。

## A13 · P2 · Keychain 写入失败时，错误包含新生成的主密钥

**位置**：`src/core/vault.ts:149-154,192-198`；`src/server.ts:470-472`；`src/cli.ts:411-413`。

`execFile` 的失败消息包含完整命令参数，当前把该错误拼入外层消息；其中包括 `security ... -w <64位hex>`。

**实测**：用假的 security 可执行文件模拟“查无条目、写入拒绝”，错误含新生成主密钥。审计输出已把 hex 替换为占位符。

**边界**：这是初始化/写 Keychain 失败路径中的新密钥材料泄漏；不是证明现有个人 Vault 主密钥已经暴露，也没有调用真实 Keychain。

**建议**：只公开固定错误码与经过允许列表处理的上下文，不输出含秘密 argv 的 Error.message；评估更合适的 Keychain 调用通道。

**证据**：`reproduction-results.json`，F05。

## A14 · 接线/隔离限制 · Memory=Own 不能保证读不到其他 Agent 的 Hub 区块

**位置**：`src/core/autoload.ts:28-47,81-115`；`src/core/popular-memory.ts` 的 OpenCode 入口分支。

在同一工作区中，Codex 与 OpenCode 可以都选中 `AGENTS.md`。按 Agent 命名的 HTML 管理标记只支持增删各自区块，不构成加载器的阅读隔离。

**实测**：只给 Codex 绑定项目 A、OpenCode 保持 Own，OpenCode 的原生目标仍是包含 A 的同一文件；再给 OpenCode 绑定项目 B，该文件同时含 A/B 两段记忆。不同目录的项目串扰不是本实验的结论。

官方加载说明确认两者都会把项目 AGENTS.md 纳入指令。项目已有自动加载说明提到原生兼容读取，因此这是仍需产品和架构处理的已知类型限制，而不应假装全部来自一次新回归。

**建议**：优先使用客户端专属入口/显式配置引用；进行跨适配器目标碰撞检查；共享入口无法隔离时明确显示“其他客户端也可能读取”，必要时拒绝相互矛盾的作用域。不得把 Own 宣传成权限隔离。

**证据**：`reproduction-results.json`，F07；官方资料见末尾。

## A15 · 接线问题 · 交接摘要通常是最初问题，不是最后结论

**位置**：`src/core/sessions.ts:247-267,269-310,313-363`；`src/core/handoff.ts:148-152,174-188`。

Cursor/Codex/Hyper 扫描主要使用文件头的首条用户输入。Codex 原生 session 里已存在 assistant 最终结论时，Hub 的 summary 仍是最初问题。已有索引记录还不会在每次 handoff 时按源 mtime 主动更新。

**实测**：合成会话包含 `FINAL_RESULT_FIXTURE` 的最终回复，但交接条不含它。源路径仍保留，因此目标可以额外回读；不能把“写出交接条”等同于自动接上最新进度。

**建议**：分开保存 title、last_user_request、latest_result、next_steps 与摘要更新时间；交接前检查源版本，摘要缺失/过时必须明确提示。读取原生摘要或有界尾部信息，不应冒称已经总结整场。

**证据**：`reproduction-results.json`，F06；索引刷新条件来自源码审查。

## 其他静态确认的 UI、契约及加固缺口

| 项目 | 源码位置 | 当前事实与建议 |
|---|---|---|
| 人设/SOUL/子代理草稿可能丢失 | `web/app.js:372-375,479-505,730-734` | Agent 卡片整体 replaceChildren；绑定成功、扫描、部分刷新等会重新载入磁盘文本。过滤器仅隐藏 DOM 的修复并没有解决一般刷新。使用独立草稿存储、dirty 状态、离开确认和版本校验。此项本轮为静态确认。 |
| AGENTS.md 编辑目标没有和载入内容绑定 | `web/app.js:787-793,1130-1139` | 保存使用当前 cwd 输入框，而不是载入时的 cwd；载入 A 后把输入框改成 B，可把 A 的编辑器内容写入 B。保存应绑定已载入文件标识，切路径需要重新载入/确认。此项未另做动态验证。 |
| Vault 自定义 secretFields 未接到保存 UI | `web/app.js:984-989,998-1004`；`src/core/vault.ts:246-255` | 后端支持但保存只传 markdown/revision；没有“任意字段标为秘密”的完整控件和提交闭环。 |
| CLI 子命令参数透传损坏 | `src/cli.ts:77-80,317-324` | restAfter 过滤掉所有 `--`，包括子命令自己的选项终止符。应只消费 Hub 那一个分隔符，余下 argv 原样传递。 |
| CLI 授权并发可能丢更新 | `src/cli.ts:336-347` | 读取旧 grants、计算新集合在写锁外；setVaultGrants 未传预期 revision。单次写锁不保护整个 read-modify-write。将增量操作下沉到锁内或加 revision。此项为静态并发风险，未做竞争调度复现。 |
| Cursor 的“启动目标 Agent”实际是 Finder | `src/core/handoff.ts:69-76`；`web/app.js:951-958` | Cursor resume plan 为 open -R，UI 仅检查 argv 非空便显示“在终端启动目标 Agent”。应区分手动交接/显示文件/CLI 启动/原生 resume，不能共用成功文案。 |
| Vault/Ctx/Identity 的旁路文件不等于原生接线 | `src/core/adapters.ts`；`src/core/deliver.ts:148-160,201-239` | Memory 有单独 native loader，Vault/Ctx 主要仍生成旁路文件。以 Codex 为例，目录路径 memory/hub-generated-vault.md 不是官方默认 AGENTS 指令发现入口；CLI 显式按名取值可用不等于原生 Agent 自动知道这个目录。需逐适配器补引用、入口与验证状态，不把不支持的能力标为已自动加载。未逐客户端做真实新会话验证。 |
| 索引文件权限可收紧 | `src/core/sessions.ts:22-28` | 本机 index.sqlite 观察为 0644，Hub/sessions 为 0755；HOME 为 0750，所以不能夸大为任意系统用户可读，但仍不如对敏感派生索引显式采用 0600/私有目录。 |

## 本轮不重复列为 open bug 的旧问题

当前代码已经具备 Vault unavailable/count=null、独立同步目录告警、Skill 保存新会话提示、Hermes/Claude 不仅凭人设识别安装、Goose/Gemini/Qwen 跳过 CLAUDE.md/.cursorrules 等第五轮修复。工作区入口拒绝已跟踪文件及 Hyper 的保守预算检查是有意保护，不应把预期 409 当作实现故障；A03 指出的是全局路径绕过保护，而不是要求放宽工作区保护。

## 建议修复顺序与验收原则

先修 A01/A02/A03/A07 的数据与秘密保护，再修 A04/A05 的真实挂载清单和编辑器状态，随后修 A06 的提交协议及 A08—A13。跨客户端原生入口和交接质量需要独立集成验收，不宜继续用“文件写出来”和“单测通过”替代。

把这次失败场景转成回归测试；每个修复同时断言返回值、磁盘实际内容、绑定配置和最终读取入口。原生验收至少区分“已配置”“已投递”“加载器已发现”“新会话实际消费”，并保留不支持/待验证状态。

## 可重放证据

本机目录：`/tmp/agent-hub-audit-20260917-daacKl`。

主要证据为 `tests.log`、`typecheck.log`、`baseline-sha256.json`、`source-integrity-final.json`、`reproduce.mts`、`reproduction-results.json`、`confirmation-0112.mts`、`confirmation-0112-results.json`。目录内还保留部分探索性测试结果；最终结论以本报告指定的证据文件为准。

两个确认脚本在项目环境中通过 `node --import tsx <脚本绝对路径>` 执行，内部重新设置合成 HOME/AGENT_HUB_ROOT；不要把测试夹具目录误当成个人数据。执行前应先阅读脚本确认环境隔离。本报告没有宣称覆盖所有动态竞争调度、所有操作系统、每种第三方客户端版本或真实账号模型会话。

## 原生加载依据

核对日期为本轮审计日期。源码发现以本机文件行号为准；下列资料仅支持原生加载约定，不替代本机复现。

- OpenAI 官方《Custom instructions with AGENTS.md》：全球/项目 AGENTS.override.md、AGENTS.md 与自定义 fallback 的发现规则。`https://learn.chatgpt.com/docs/agent-configuration/agents-md`
- OpenCode 官方《Rules》：项目 AGENTS.md 进入上下文，自定义 instructions 与 AGENTS.md 合并。`https://opencode.ai/docs/rules/`
