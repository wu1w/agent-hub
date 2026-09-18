# 后端复审与修复记录

日期：2026-09-16。基准：本轮开始时的现有代码，以及 `docs/PRD.md`、`docs/SPEC.md` 和前三轮审计。此次直接修改业务代码、CLI、HTTP、前端和回归测试。

## 结果

修复前重新执行第三轮复现脚本，15 个场景全部复现，归并为 13 项根因。本轮已针对这些根因落地修复，并修复实施过程中发现的相邻问题。不能将此解释为五种真实 Agent 的运行时集成均已验收。

### 持久化与迁移：T01–T04

- 新增 `src/core/transaction.ts`：CLI/HTTP 共用跨进程写锁；进程内嵌套调用复用事务。文件变更前记录原始文件/目录/链接，异常回滚；下一个写者会恢复未提交日志。活跃写者不会被抢锁；等待超时返回错误。
- 文本与 Vault 密文通过同目录临时文件、文件 fsync、rename 原子替换，避免读到半份配置或密文。绑定、授权、记忆追加的读改写整体持锁。
- Skills 收编先检查挂载路径，再执行迁移；移入、回挂、绑定提交处于同一事务。实际投递 I/O 错误不再吞掉。
- 显式收编个人软链后回挂 Hub，原外部源保留。普通 repair 不强行替换有效外部链接。
- 首次导入的同名冲突可见，可明确选中 Agent 副本建立 Hub；其他副本保留，继续提供冲突解决入口。没有 Hub 副本时，GUI 禁用“保留 Hub”。Own 副本不能通过冲突接口绕过绑定流程删除。
- Vault HTTP 全文保存及授权修改必须提交 `revision`。缺少版本返回 428；过期版本返回 409，保留编辑器草稿。CLI 的明确授权替换操作仍在写锁内完成。

### 文件边界与恢复：T05–T08

- 子代理备份统一补 `.md`；同时兼容已生成的无后缀备份。
- 无法判定来源的旧备份显示为 unknown，不再自动归为 Identity。GUI 要求选择类型；CLI 使用 `--kind identity|soul|subagent`，子代理另传 `--subagent`。
- 备份恢复目标由适配器、类型和子代理名称重新推导；不能直接信任元数据中的任意原路径。
- 普通文件写入拒绝符号链接路径与多重硬链接，避免 USER.md 投影写穿 Identity/SOUL。危险配置会明确失败，不会静默重定向。
- Skill 安全检查遍历真实路径图，包含目录软链、循环检测及扫描上限；超限失败。收编来源、现有 Hub 内容和挂载目标都检查 vendor/vault 禁区。
- Ctx/Memory/Vault 投影按本次接管周期记录原文件或“原先不存在”。失败时备份状态一起回滚；切回 Own 不会复活更早周期的文件。Vault 目录投影也可恢复原用户文件。

### Vault、会话和项目作用域：T09–T13

- 环境变量字段映射避免中文、ASCII 归一化碰撞；字段重排不改变字段变量名。CLI 元信息列出字段到变量的映射，不输出值。原有首个秘密快捷变量保留。
- 会话可见 Agent 条件进入 SQL WHERE，再排序与 LIMIT；统计也排除停用和 Own Agent。
- 编辑项目记忆不再修改所有 Agent 的项目选择。全局投影仅含 global；项目摘抄按 Agent + 工作区生成。
- Cursor 工作区输出到 `.cursor/rules/hub-generated-memory.mdc`。其余 Agent 输出到工作区 `.agent-hub/hub-generated-memory-<agent>.md`，Hub 交接条明确要求读取当前工作区对应文件；不改仓库 AGENTS.md。
- Vault API 返回 secret 字段元数据。前端按完整字段掩码自定义秘密和续行，失焦重新隐藏；掩码编辑会合并回草稿，不丢失刚输入但尚未保存的秘密值。
- 点击显示时只补全当前版本草稿的隐藏字段，不覆盖说明、新条目或其他本地修改；服务器版本变化则提示合并。支持键盘点击和窗口失焦。

### 其他已落地修复

- 空能力列表保留空值；Ctx=Hub 检查 `global_targets`。
- 会话口令初始化串行化并确保 0600；配置默认对象不再共享可变嵌套绑定。
- HTTP 校验完整同源（含端口），限制请求体 2 MB，JSON 语法错误返回 400。
- GUI 交接条生成后可点击“在终端启动目标 Agent”。服务端仅接受交接 ID 并重建命令，不接受任意 argv/shell；命令参数作 shell 引号处理。启动返回的是 Terminal 打开结果，不冒充 Agent 执行成功。
- CLI/GUI 绑定反馈使用实际提交状态，遇冲突不再报告切换成功。

## 验证

执行：

```sh
npm run typecheck
node --check web/app.js
node --check web/vault-draft.js
npm test
```

最终 **90/90 项测试通过**，TypeScript 与前端语法检查通过。测试日志：`docs/audit/full-fix-tests-2026-09-16.log`。

新增 `src/core/round3-fixes.test.ts`，并扩展 HTTP 测试。覆盖跨进程授权与配置并发、迁移途中模拟 ENOSPC、Vault 原子替换失败、SIGKILL 后恢复、首次冲突的完整处理、软链收编、旧备份映射、Identity 别名保护、目录软链穿透、分页、同一 Agent 两工作区隔离、Own 撤除、真实前端函数掩码/草稿、Shell 参数注入防护、HTTP revision 和跨端口 Origin 等。

原 R8 测试改为显式工作区选择，避免把旧“最后编辑项目全局生效”行为当成正确语义。前三轮缺陷复现脚本保留为历史证据；它们断言缺陷存在，不能作为修复后的通过标准。

另在独立临时 HOME 和随机测试实例中实测浏览器：登录 → 默认掩码 → 修改说明 → 显示时补全自定义/多行秘密并保留草稿 → Tab 失焦全部掩码 → 再编辑说明 → 保存。未捕获到浏览器 error/warn。测试页和服务已关闭。

所有验证使用临时 HOME、合成会话/密钥与测试主密钥，没有改真实 Agent 配置、真实 Vault 或 Keychain。修复前源文件备份在 `/tmp/agent-hub-before-fix`；工作区没有 Git 元数据，未创建提交。

## 新用法与兼容注意

工作区作用域：

```sh
hub memory-scope grok --cwd /absolute/repo-a --project alpha
hub memory-scope grok --cwd /absolute/repo-b --project beta
# 解除一个工作区的项目作用域
hub memory-scope grok --cwd /absolute/repo-a
```

GUI Memory 页提供“设置工作区记忆”。旧版 per-agent 项目选择没有 cwd，升级后不自动将其推广到所有工作区；需明确设置一次工作区。

旧备份：

```sh
hub restore-identity workbuddy --list
hub restore-identity workbuddy --backup <旧文件名> --kind soul
hub restore-identity grok --backup <旧文件名> --kind subagent --subagent helper
```

自定义 HTTP 客户端应先 GET `/api/vault` 获取 revision，再随 PUT `/api/vault` 或 POST `/api/vault/grant` 提交。遇 409 应先保留草稿、重读并合并，不能直接用旧授权数组覆盖。

## 仍需真实环境验收的边界

1. 五种 Agent 是否实际消费各自全局投影路径、具体 Grok/Codex CLI 参数是否被当前安装版本接受，尚未启动真实运行时验证。项目记忆通过 Cursor 项目规则或 Hub 交接提示接入；绕过 Hub 手工启动的其他运行时，不会自动获得项目文件引用。
2. 进程异常与模拟磁盘错误已测试，未模拟整机断电、文件系统损坏、真实磁盘耗尽或 Keychain 锁定。文件 fsync 和日志恢复不等同于任意存储故障的完整保证。
3. 适配器仍为五种内置实现；enabled 列表可以增删这些 Agent。任意新运行时的注册与消费契约仍需新增适配器实现，不能把自定义 skill_dir 当成新运行时支持。
