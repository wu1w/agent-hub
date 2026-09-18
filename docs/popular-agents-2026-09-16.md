# 热门 Agent 原生记忆适配（2026-09-16）

本轮在原有七项上新增十二项，共十九个适配器。新增项支持 Memory 的原生规则加载、工作区投递、Own 撤销与事务回滚；Identity、Skills、Ctx、Sessions、Vault 尚未实现，页面禁用相应绑定，接口拒绝不支持的绑定。默认 Own，不主动改动个人原生配置。

## 选择依据

按官方 GitHub 仓库的关注度及桌面开发工具覆盖选择 OpenCode、Gemini CLI、Cline、Kilo Code、Goose、Qwen Code、Pi、OpenClaw、Aider、GitHub Copilot CLI、Windsurf，以及历史兼容 Roo Code。2026-09-16 查询时，OpenClaw、OpenCode、Gemini CLI、Pi 超过十万 stars；Cline、Goose、Aider、Qwen Code、Kilo、Roo 超过两万，Copilot CLI 超过一万。Stars 仅为选择线索，不代表活跃用户数。Roo Code 仓库已归档，界面明确标注。Windsurf 为商业客户端，未以开源仓库 stars 比较。

## 原生入口与来源

- [OpenCode](https://opencode.ai/docs/rules/)：全局 `~/.config/opencode/AGENTS.md`，项目 `AGENTS.md`；若正回退到 `CLAUDE.md`，拒绝写入并提示先整理原生 AGENTS.md；不修改其他客户端文件，也不静默遮蔽其指令。
- [Gemini CLI](https://geminicli.com/docs/cli/gemini-md/)：`~/.gemini/GEMINI.md` 与项目文件，读取用户和项目 `context.fileName` 自定义名称。
- [Cline](https://docs.cline.bot/customization/cline-rules)：Hub 仅使用明确登记的本地项目 `.clinerules` 文件或目录，停用 Documents 下的全局投递；运行时规则开关仍由 Cline 控制。
- [Roo Code](https://roocodeinc.github.io/Roo-Code/features/custom-instructions/)：`~/.roo/rules/hub-memory.md`，项目 `.roo/rules/`；仅在原生规则目录无内容时保留 `.roorules` 回退。归档兼容项。
- [Kilo Code](https://kilo.ai/docs/customize/custom-rules)：全局 `~/.config/kilo/rules/hub-memory.md`、项目 `.kilo/rules/hub-memory.md`，同时在对应 `kilo.jsonc` 或既有 `kilo.json` 的 `instructions` 登记绝对路径。保留 JSONC 注释与原有条目；配置来源不明确或格式损坏时原子失败。
- [Windsurf](https://docs.devin.ai/desktop/cascade/memories)：全局 `~/.codeium/windsurf/memories/global_rules.md`；项目已有 `.devin` 时写 `.devin/rules/`，否则 `.windsurf/rules/`，指定 `trigger: always_on`。校验全局 6000、项目 12000 字符预算。
- [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions)：全局 `~/.copilot/copilot-instructions.md`，项目 `.github/copilot-instructions.md`。全局入口仅承诺 CLI，不代表所有 Copilot IDE 插件。
- [Goose](https://github.com/aaif-goose/goose/blob/main/documentation/docs/guides/context-engineering/using-goosehints.md)：`~/.config/goose/.goosehints` 与项目 `.goosehints`；尊重 `CONTEXT_FILE_NAMES`，拒绝路径穿越名称或禁用列表。
- [Qwen Code](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/)：`~/.qwen/QWEN.md` 与项目文件，尊重 `context.fileName`。
- [Pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)：`~/.pi/agent/AGENTS.md` 与工作区文件，尊重 `PI_CODING_AGENT_DIR`、`AGENTS.override.md`；若依赖 CLAUDE.md 回退则拒绝注入，提示先整理专用入口。客户端禁用 context files 时不会加载。
- [OpenClaw](https://docs.openclaw.ai/concepts/memory)：必须在 Memory 页登记实际 agent workspace，写入其 `MEMORY.md`；不把状态目录猜成工作区。采用默认 20000 字符单文件预算，实际 bootstrap 总预算、群聊与子代理策略由客户端决定。
- [Aider](https://aider.chat/docs/config/aider_conf.html)：生成专用 Markdown，在用户或工作区 `.aider.conf.yml` 的 `read` 中登记路径，支持原有字符串与列表。Own 仅撤销 Hub 添加的引用，保留用户已有引用及后续修改。项目配置或命令行覆盖全局 `read` 时，应登记该工作区。

支持 XDG_CONFIG_HOME 的适配器使用对应配置根目录。检测现有目录、PATH 可执行文件和常见编辑器扩展目录；这只表示发现安装线索，不表示登录或模型运行可用。

## 验证和边界

自动化验证隔离 HOME，覆盖十九项工作区投递、全局与项目隔离、Own 清理、JSONC/YAML 登记与恢复、用户同步期间修改、配置删除后重建、损坏配置回滚、自定义上下文文件、旧版配置迁移、不支持的绑定拒绝。日志见 `audit/popular-agent-tests-2026-09-16.log`。

本轮新增客户端未逐个进行模型对话验收，也未安装客户端或变更认证。文件成功投递不等于模型已经读取；启用后需新开会话，原生关闭规则、配置覆盖及客户端上下文预算仍可能影响加载。共享 `AGENTS.md`/`CLAUDE.md` 被多个客户端读取属于原生行为，Own 只撤销本适配器的块，不承担跨客户端隔离。

验收结果：107 项测试全部通过，TypeScript 与前端语法检查通过。已重启 3950 本机服务，通过 Computer Use 查看 Agents 页面，确认十九张卡片、十二项能力限制、Roo 归档提示与 OpenClaw 工作区说明。新增项保持 Own；Skills 目标选择同样禁用未适配项。

## 第四轮修复复测

最终源码通过 113/113 测试，日志为 `audit/round4-fixes-tests-2026-09-16.log`；TypeScript、app.js 与 vault-draft.js 语法检查通过。本轮覆盖跨客户端回退只读、Cline 工作区投递、同步目录拒绝、Git 已跟踪规则拒绝及事务回滚、本地 exclude、能力错误码、向导按选中技能收编、Codex .system 厂商保护和多行密钥草稿保留。Skills 表同时显示用户与厂商来源及修改时间。

Computer Use 已验证筛选至单卡及零匹配、隐藏再恢复保留未保存草稿、USER.md 追加、系统技能不可选、无待迁移项的向导完成，以及交接选择器不包含 Memory 专用项。个人技能未迁移、测试草稿未落盘、本机 Memory 仍全部 Own，3950 服务已更新。Grok 的 --cwd/--prompt-file/--resume 与 Codex 的 resume [SESSION_ID] [PROMPT] 已对照本机帮助核实；未启动真实模型会话，因此不将此称为端到端运行验收。

保护规则属于本轮有意收紧：依赖其他客户端 CLAUDE.md/.cursorrules 回退时需要先整理专用入口；Git 已跟踪入口不会被注入，Cline 全局模式需改为登记本地工作区。此时错误必须可操作且不提交部分绑定。当地 Git 排除会保留，避免关闭后用户文件被意外加入版本控制。

## 第五轮体验与状态修正

- 已跟踪文件的 409 提供具体后续选择：原生支持时配置专用未跟踪入口，或仅保留全局加载；明确 Hyper 等工作区模式不能依赖兼容副本。另提供正确引用路径的 `git rm --cached` 示例，并说明它会暂存版本库删除、仅保留本地文件，Hub 不自动执行。
- Snapshot 的 `warnings` 暴露同步目录提醒，页面独立持续展示，不被保存成功等短提示覆盖。
- Vault 汇总增加 `status` 和 `error`；读取失败返回 `count: null`，显示条目数未知，不再伪装成空库。正常空库仍为 ready/0；恢复后刷新可清除故障提示，CLI 同步显示失败状态。
- 保存 Skill 提醒已运行的 Agent 不保证热加载，应新开对话。
- Hermes/Claude 的身份文件、空配置目录不再作为安装证据，改用 PATH 可执行文件或原生配置/会话标记。这是安装线索，不代表模型已登录。
- Gemini/Qwen/Goose 的自定义入口跳过 CLAUDE.md 和 .cursorrules（不区分大小写）；仅配置这些名称时返回 409，混合列表选择专用文件，原生配置不被改写。

复测：117/117，日志 `audit/round5-fixes-tests-2026-09-16.log`，TypeScript 与前端语法通过。新增回归覆盖人设保存不制造安装状态、PATH/原生配置检测、自定义入口失败回滚、错误密钥/损坏密文与恢复、同步目录告警字段。隔离 Computer Use 验证同时显示两类警告、Skill 保存新会话提示、成功提示不覆盖持续告警、Vault 恢复后清除故障状态。使用合成数据及独立 3951 实例，没有改动个人保险库。
