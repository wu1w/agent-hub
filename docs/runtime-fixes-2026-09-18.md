# 运行时审计问题修复与验收

日期：2026-09-18（UTC）。项目：`/Users/william/agent-hub`。

## 修复范围

| 编号 | 结果 | 主要位置 |
| --- | --- | --- |
| AH-01 | 会话正文及 raw 对当前 Vault 已知秘密脱敏；先脱敏再截断。核心函数本身在 Vault 不可用时拒绝读取，不依赖 HTTP 外层守卫。原始会话文件不改写。 | `src/core/sessions.ts` |
| AH-02 | Memory 只接受最新且未被新编辑打断的加载响应，文件身份、标题、revision、内容一并切换。加载期间禁止保存；新建后取消丢弃不会改变旧草稿保存目标。 | `web/app.js` |
| AH-03 | 409 保留草稿与原 revision；增加独立最新版本对照面板和显式合并保存。保存响应只清除本次已提交内容的 dirty 状态。追加期间的新草稿、新便笺保留。USER.md 同类慢保存/409 丢草稿问题一并处理。 | `web/app.js`、`web/index.html`、`web/app.css` |
| AH-04 | 单 Agent 绑定只同步本 Agent；工作区登记只处理本工作区；项目修改只刷新引用该项目的作用域。用户触发的全量投递逐目标事务化，失败目标回滚，成功目标不回滚，源记忆保持已保存并明确返回失败清单。 | `src/core/bind.ts`、`src/core/deliver.ts`、`src/server.ts`、`src/cli.ts` |
| AH-05 | 项目读写、创建、remember 与作用域投递统一使用完整项目 ID，不再只有编辑器路径偷偷剥离 `.md`。登记不存在项目返回 404；投递缺失项目不再静默退回全局。 | `src/core/files.ts`、`src/core/memory.ts`、`src/core/deliver.ts` |
| AH-06 | 子代理创建使用独立 POST，服务端事务内查重；重名返回 409，不覆盖、不生成覆盖备份。编辑 PUT 必须带 revision，缺失返回 428，过期返回 409。 | `src/core/files.ts`、`src/server.ts`、`web/app.js` |
| AH-07 | 完整合法的 JSONL 末行即使没有末尾换行也解析；半写入或有界截断的不完整末行仍忽略。 | `src/core/sessions.ts` |

新增界面提示、冲突面板、投递失败说明均有中文和英文翻译键，继续使用原有 i18n 方案。

## 接口与行为变化

### Memory 保存与投递分离

`PUT /api/file?kind=memory...`、`POST /api/remember` 的源记忆成功提交后返回 HTTP 200，并附带 `delivery.written` 与 `delivery.failures`。200 表示源操作成功，不再意味着每个客户端都已投递成功；前端会显示失败目标，而不是宣称全部同步。`POST /api/memory/sync` 同样返回 delivery 报告。

CLI `hub remember` 与 `hub sync-memory` 遇到部分失败会打印目标和原因并返回非零退出码。源记忆已经保存时，应修好目标后运行 `hub sync-memory`，不要重复提交同一条 remember。底层 `syncMemoryInjects()` 仍提供显式原子同步，原有故障回滚覆盖保留。

### 项目 ID 不是文件名别名

`name=demo` 对应 `projects/demo.md`；ID 本身为 `demo.md` 时，对应 `projects/demo.md.md`。两者是不同项目，不能互相覆盖或串投。这延续项目列表/核心 remember 原有的 ID 语义，修正了 `/api/file` 单独删除扩展名的不一致。原先把 `name=demo.md` 当作 `demo` 文件名别名的外部调用方需要改用 `name=demo`。没有自动重命名个人项目文件。

### 创建和编辑子代理分离

新建走 POST；PUT 编辑需要当前文件 revision。旧的无 revision PUT 消费者会收到 428，需先读取文件，或改用创建接口。

## 测试与兼容性

- 完整 `npm test`：194/194 通过，0 失败，0 跳过；包含 15 项新增回归。
- `npm run typecheck` 与全部 `web/*.js` 语法检查通过。
- 后端新增回归：`src/core/runtime-fixes-20260918.test.ts`，覆盖真实 HTTP、磁盘内容、失败目标回滚与恢复、脱敏及权限边界。
- 前端新增回归：`src/core/runtime-ui-fixes-20260918.test.ts`，加载真实 app.js 函数及事件回调，用 Node VM/DOM 替身控制异步顺序，保存经过隔离 HTTP 后端。
- 旧测试没有跳过。一个旧源记忆全量回滚测试随新明确契约调整为源已提交、失败目标保持原状、恢复后清空失败；工作区测试先通过 applyBind 完成初始全局投递，不再依赖登记工作区的全量同步副作用；旧前端抽取式测试补齐新状态变量。
- 路径越界、软链、原生入口重叠、Vault 不可用等既有防护测试保留执行。

## 本机运行状态

3950 服务已从 PID 70995 更新到 PID 2304。认证 Snapshot 返回 200；对新增子代理入口做无写入参数校验，确认新后端已加载。重启前后比较的 9 个配置/记忆/Vault 等文件路径内容不变，绑定配置不变，新写日志未包含会话口令。

当前 Snapshot：23 个适配器，Skills 状态 ready，0 个冲突，0 个断链，Vault 状态 ready。本次没有对个人 Hub 执行记忆同步、技能迁移或工作区登记。

## 验收边界

尝试了独立 profile、合成数据的无头 Edge 浏览器验证，但页面导航超时，未取得完整浏览器端到端验收结果；不把该尝试记作通过。界面行为结论基于上述真实事件回调与 HTTP/磁盘回归，而不是截图或模型真实消费验收。

Cursor 的 Memory=Hub 仍无工作区自动加载路径。这是保留的个人配置问题，未擅自指定工作区。没有启动真实 Agent 模型会话；当前已知秘密脱敏也不等于可以识别所有未知或已从 Vault 删除的历史凭据。

## 备份与证据

修复前源码备份：`/Users/william/.agentdock/tmp/hub-fix-20260918-knwoi5d6/original`。

差异补丁、完整测试日志、后端/前端定向日志、生产重启结果：`/Users/william/.agentdock/tmp/hub-fix-20260918-knwoi5d6`。机器可读结果与代码哈希见 `docs/runtime-fixes-2026-09-18-verification.json`。恢复备份前应先比对之后的用户改动，不能盲目覆盖。
