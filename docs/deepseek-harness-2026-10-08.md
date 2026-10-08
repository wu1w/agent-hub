# DeepSeek Harness 兼容

Hub 的 Agent ID 为 `deepseek`，命令名为 `dsh`。适配已核对本机 DeepSeek Harness 源码及已安装桌面应用 `app.asar` 内的实际加载器。

- Skills：链接到 `$DSH_HOME/skills`，默认 `~/.dsh/skills`。原生 `skill-filesystem` 支持符号链接目录；有效技能需要 `SKILL.md` 的 `name` 和 `description`。Hub 保留 `.system` 厂商目录。
- Memory：全局记忆写入 `$DSH_HOME/AGENTS.md` 中可撤销的 Hub 区块；登记工作区后写入该项目的 `AGENTS.md`。原有指令保留，项目记忆不会写入全局文件。
- Identity：Hub 编辑的独立人设源位于 `$DSH_HOME/hub/IDENTITY.md`，通过另一组区块标记投影到原生全局 `AGENTS.md`，不会替换记忆区块。
- Ctx 保持 Own；未确认原生 `USER.md` 加载器。Sessions 索引、会话交接和 Vault 尚未适配，相应入口不会宣称可用。

新配置会根据 `dsh` 可执行文件或 `.dsh` 中的真实运行数据发现安装。仅有 Hub 投影文件不算安装证据。已有 schema 5 配置会补全新 Agent 的 Own 绑定，保持用户已有 enabled 列表，包括显式停用的 Agent；用户绑定新 Agent 时再启用。

原生默认 `code`、`standard`、`cordis` 预设包含指令与技能加载器。全局指令首次请求时加载；运行中外部修改在下一次成功的原生 `read` / `write` / `edit`、恢复会话或重建被压缩上下文时更新。原生技能目录默认启用文件监听并跟随符号链接。Hub 文件更新不代表一个空闲中的旧会话已经重新消费内容。

默认预设对整段指令上下文使用 65,536 UTF-8 字节预算，单个来源文件上限为 1 MiB。预算不足时先省略较宽作用域的文件，因此大型项目指令可能挤掉全局记忆；自定义预设也可改变路径、候选文件或停用加载器。

核对来源：

- `deepseek-harness/packages/util/home-paths/src/index.ts`：`DSH_HOME` 与 `~/.dsh`。
- `deepseek-harness/packages/context/agent-instructions`：全局与项目指令、刷新和预算语义。
- `deepseek-harness/packages/skill/skill-filesystem`：技能发现、元数据和符号链接。
- `deepseek-harness/apps/cli/config/agent-presets/{code,standard,cordis}/agent.cordis.yml`：默认预设。
- `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/`：安装产物的实际 `dsh-agent-instructions`、`dsh-skill-filesystem`、`dsh-home-paths`。

验收：`src/core/deepseek.test.ts` 覆盖发现、DSH_HOME、schema 5 配置、原有内容保留、同步/退出、项目隔离、技能链接、Identity 与 Memory 共存，以及未支持能力的拒绝。另通过安装应用的实际原生加载器，在隔离目录读取 Hub 指令、发现符号链接技能并加载完整正文；没有调用模型。真实用户绑定和巡检结果记录在本次 Hub 检查报告中。
