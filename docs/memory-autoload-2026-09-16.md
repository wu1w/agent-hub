# Memory 自动加载修复与验收

2026-09-16。本次从“生成副本”补齐到各运行时的原生加载入口。之前的投递副本继续保留兼容，界面单独显示原生入口及工作区要求，不将文件写入当作运行时验收。

## 适配范围

- Grok CLI：`~/.grok/rules/hub-memory.md`；项目使用 `.grok/rules/hub-memory.md`。本机 `grok inspect` 确认新入口被识别为 global rule。
- Cursor：在登记工作区的 `.cursor/rules/hub-generated-memory.mdc` 写入 `alwaysApply: true`。本机 Cursor Agents 的全局目录副本未自动消费，因此不再宣称只写 `~/.cursor/rules` 即生效。
- Codex：全局 `AGENTS.override.md` 非空时使用它，否则使用 `AGENTS.md`；项目同样遵循 override 优先级。支持 `CODEX_HOME`。
- grok-hyper：登记工作区的 `AGENTS.md`。不修改全局 persona `AGENT.md`。本机源代码默认 `agents_md_max_tokens=400`，超限会整份忽略，Hub 用 UTF-8 字节上界保守检查并拒绝超预算写入；可能比实际 tokenizer 更严格，可精简内容或在原生配置提高预算。原生 `agents_md` 加载必须开启。
- WorkBuddy：全局 `~/.workbuddy/MEMORY.md`，项目 `.workbuddy/memory/MEMORY.md`。分别限制整个文件为 4,000 / 8,000 字符，包含用户原文，超限拒绝同步。需要客户端开启本地记忆。支持原生配置目录环境变量。
- Hermes：全局 `~/.hermes/memories/MEMORY.md`（默认 2,200 字符保守预算）；项目使用现有优先上下文文件，默认 `AGENTS.md`。支持 `HERMES_HOME`，需使用同一 profile 且启用 memory。没有修改 `SOUL.md` 来塞入记忆。
- Claude Code：全局 `~/.claude/rules/hub-memory.md`，项目 `.claude/rules/hub-memory.md`。支持 `CLAUDE_CONFIG_DIR`。

Hermes、Claude Code 本轮没有在默认配置目录或 PATH 检测到，因此完成了代码适配与隔离文件系统测试，未宣称本机模型运行验收。它们初始各层为 Own / Vault Off，不安装客户端，不配置账号。新旧客户端的上下文上限、禁用规则开关、远程执行环境仍由对应客户端控制。部分客户端会兼容读取其他厂商的规则目录，这属于原生运行时行为，Hub 的绑定不能关闭这些兼容读取。

## 使用

1. Agents 页将对应 Agent 的 Memory 设为 Hub。
2. Cursor / grok-hyper 必须在 Memory → 设置工作区记忆中输入真实工作区路径；项目记忆 ID 填 `*` 表示只加载全局记忆，也可以选择某个项目记忆 ID。其他 Agent 可用同样入口叠加项目记忆。
3. 已有 Hub 绑定升级后点“重新同步加载入口”，或运行 `npm run hub -- sync-memory`。
4. 在同一工作区新开会话。已有对话中的缓存不会因磁盘更新自动刷新。

CLI 对应命令：`npm run hub -- memory-scope cursor --cwd /absolute/project --global`。使用 `--project <id>` 叠加项目记忆；两个选项都省略则解除该工作区。

## 数据保护和回归验证

原生共享文件使用具名管理区块；首次修改备份原文，重复同步不重复追加，Own 只移除本 Agent 的区块，保留期间的用户编辑。原文件不存在则在撤销且无额外内容时删除。符号链接、硬链接、损坏或无跟踪的区块标记拒绝写入。Codex override 变化会迁移区块并清理旧入口。工作区入口与全局路径重合时拒绝登记，防止项目内容进入全局。

Memory 保存和 remember 的源文档更新与所有投递现在处于同一事务；某个客户端超限或投递失败，源文件、其他投递与绑定均回滚。禁用的 Agent 会撤回其托管入口。

原有配置目录完整的五 Agent 列表会迁移为七个；schema_version=2 后保存的显式子集和空列表保持不变。新 Agent 默认不接管任何用户资产。

最终检查：TypeScript 类型检查、浏览器脚本语法检查通过；101/101 自动化测试通过，日志见 `docs/audit/autoload-tests-2026-09-16.log`。修复后的本机 3950 服务已重启，UI 实际确认七个适配器与“重新同步加载入口”成功状态。

## 实机证据

使用与上轮不同的合成代号 `HUB-CEDAR-9537`。盲测提示词不含代号，明确禁止工具、文件读取、历史会话检索与任何修改。临时 Hub 根目录隔离测试源文档和配置，投递到真实客户端入口。

- WorkBuddy 5.5.6 / Deepseek-V4.1-Flash，通过 Computer Use 新建「Hub 自动加载验收测试」：7 秒后直接返回代号，并说明来自自动注入的 Hub Memory，无工具调用。
- Cursor Agents，`~/grok-hyper` 新建「Hub automatic-loading test」：1 秒思考后直接返回代号，无文件读取操作。
- Codex CLI，`exec --ephemeral` 独立新会话：直接返回代号，日志无工具执行。
- Grok CLI，`grok inspect`：列出 `/Users/william/.grok/rules/hub-memory.md (global, ~53 tokens)`。此项证明原生加载器发现入口，不等同于模型盲测。
- grok-hyper：按本机原生加载器源码核对，覆盖工作区生成及预算失败测试，未运行模型盲测。

测试结束已撤回全部临时投递和测试工作区规则，保留只含合成内容的测试对话。真实 Hub 的原 Memory 绑定与全局内容未被测试更改。

## 入口依据

- [Cursor Rules](https://prod.cursor.com/docs/rules)：项目规则入口；同时核对本机 Cursor 加载器的工作区筛选。
- [Codex AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md)：全局及项目 override 优先规则。
- [Claude Code Memory](https://code.claude.com/docs/en/memory)：用户与项目 rules 入口。
- [Hermes 文件职责](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what)：原生记忆、项目上下文及会话快照。
- WorkBuddy 本机 5.5.6 的 `MemoryCollector.getUserLocalMemoryContent` / `getWorkingMemoryContent`：本地记忆路径及截断上限；云记忆目录不能充当本地自动加载入口。
- Grok CLI 本机 `docs/user-guide/12-project-rules.md`；grok-hyper 本机 `crates/hyper-loop/src/agent/setup.rs` 与 `config.rs`。
