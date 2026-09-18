# Agent Hub 后端第二轮复查

日期：2026-09-16。结论：确认 8 项问题（5 项 P1、3 项 P2），其中既有修复后的新回归，也有旧问题未完整关闭。当前不能判定全部修复完成。

本轮运行 npm test：53/53 通过；npm run typecheck：通过。新增隔离验证执行 9 个场景，覆盖以下 8 项问题。全部在临时 HOME/Hub 中使用随机测试主密钥，无真实 Agent 启动、真实 Keychain 操作或真实凭据访问；没有修改业务代码。目录没有 .git，因此“新回归”依据上一轮已审阅实现与本轮新增逻辑判断，不是 git diff。

[复现脚本](/Users/william/agent-hub/docs/audit/recheck-round2.mts) · [复现日志](/Users/william/agent-hub/docs/audit/recheck-round2.log)。仓库根运行 `node --import tsx docs/audit/recheck-round2.mts`。脚本断言缺陷存在，修复后应失败，不能作为验收通过标准。

## 发现

### R1 [P1] 匿名获取 Cookie 后即可读取整库明文

归类：F11 未完整修复。要求：SPEC §6.6、§10（防本机其他用户）。

guard 只验证写请求和 reveal；普通 GET /api/snapshot 会把同一个管理 token 作为 Cookie 发给任何客户端。没有凭证的本机进程可先 GET，再带 Cookie 请求 /api/vault?reveal=1。Host/Origin 校验挡不住本机其他用户。

**复现：** 首次 reveal 返回 401 → 无凭证 snapshot 返回 Set-Cookie → 使用该 Cookie 再 reveal 返回 200 和合成密钥；不需要任何 Agent grant。

**修复方向：** 首次会话建立必须依赖用户私有的可信启动凭证或用户隔离 IPC，不能由匿名 HTTP GET 发放管理权限。所有敏感读取也应鉴权。增加覆盖完整两步请求的回归用例。

[代码定位](/Users/william/agent-hub/src/server.ts:116)。

### R2 [P1] 正常 Own→Hub 被误判冲突，源 skill 被搬走而绑定仍为 Own

归类：F13 修复引入的流程回归。要求：SPEC §7；PRD §8 Own 语义。关联 src/core/skills.ts:236。

adoptSkills 在 moveDir 前记录 mountedAll，迁移后仍以其中旧 realpath 比较新 hubReal，因此刚搬走的源目录也被列为 foreign。applyBind 新增的 conflicts 早返回留下 Own 配置，但迁移和其他 Agent 的 relink 已执行。即使无真实冲突也能触发；真实多项冲突同样缺乏预检和回滚。

**复现：** WorkBuddy=Own，仅创建 only-new/SKILL.md；applyBind(adopt) 返回该项 conflict，Own 未改变，但 only-new 已从 WorkBuddy 消失。另一用例还验证迁移项已被分发给 Grok。

**修复方向：** 先在无写入阶段制定完整迁移计划，排除所选源与目标自身；冲突未解决不改目录。执行、回挂、提交和恢复统一管理。至少测试单个新 skill、多项部分冲突以及中途失败。

[代码定位](/Users/william/agent-hub/src/core/bind.ts:45)。

### R3 [P1] 恢复 SOUL/子代理备份会覆盖主 Identity

归类：新增恢复功能的回归。要求：SPEC §6.1：备份恢复写回原路径。

identity、soul 和 subagent 的备份混在 backups/identity/<agent>；restoreIdentity 不记录或选择文件种类，目标永远是 ad.identityPath。WorkBuddy SOUL 的备份可覆盖 IDENTITY，Grok 子代理备份亦存在同一问题。未知 backupName 还会静默选最新备份。

**复现：** 仅保存 WorkBuddy SOUL.md 以创建备份，再恢复该备份：IDENTITY.md 变成 SOUL_ORIGINAL，而 SOUL.md 仍为 SOUL_CHANGED。

**修复方向：** 备份元数据保存原路径、kind、子代理名；按同一文件版本恢复，拒绝种类不匹配或不存在的备份；恢复前保护当前文件。

[代码定位](/Users/william/agent-hub/src/core/files.ts:136)。

### R7 [P1] targets 写入接口绕过厂商路径保护

归类：F05 未完整修复。要求：PRD §6/§8；SPEC §5、§6.2、§10。

writeHubSkill/writeAllowed 新增了真实路径检查，但 setSkillTargets 仍直接 readText/writeText。adopt 只检查 skill 目录本身，不检查目录内 SKILL.md 的软链；外层是真实用户目录、内层 SKILL.md 指向厂商文件时可以迁入 Hub，再通过改 targets 写穿厂商源。

**复现：** 创建用户 alias/SKILL.md 软链指向厂商 vendor/SKILL.md；adopt 后 setSkillTargets(alias,['grok']) 成功，厂商源出现 hub.targets。

**修复方向：** 所有正文和元数据写入复用同一个受检写入口；导入、提升、分发前验证内部软链，不能仅检查顶层目录。

[代码定位](/Users/william/agent-hub/src/core/skills.ts:343)。

### R6 [P1] Vault 读取失败后静默关闭脱敏，照常落盘

归类：F09 脱敏修复不完整。要求：SPEC §6.6 第5条、§10.2；PRD §12。

knownSecrets 捕获任意解密/权限/Keychain 错误后返回 []，调用方无法区分“无密钥”和“无法获取密钥”。rebuildIndex 仍把原始标题与摘要写入 SQLite，handoff 使用相同失败策略。少于 6 字符的秘密字段也被过滤掉；索引还在截断标题后才替换完整值，截断处可能留下密钥前缀。

**复现：** 使用合成密钥加密 Vault，在原生 session summary 写入同一值，再换成错误测试主密钥；rebuildIndex 成功，SQLite summary 包含完整明文。短字段与截断顺序为静态附加发现，不计独立复现场景。

**修复方向：** 获取脱敏材料失败时阻止派生敏感文本写入，或只保存不含内容的元数据并报告不可用状态。不要按长度跳过秘密字段；应在截断前处理原文。

[代码定位](/Users/william/agent-hub/src/core/secrets.ts:15)。

### R4 [P2] 显式全开 targets 被序列化为继承受限缺省

归类：缺省 targets 修复后暴露的语义回归。要求：SPEC §6.2 缺省与显式目标语义。

skillAllowedFor 现在正确使用 config default_targets，但 setHubTargets 仍把 ['*'] 或全部五个 Agent 简化为删除 hub 字段。缺省只给 Grok 时，明确全开会被重新解释为只给 Grok；CLI 逐个 enable 到第五个也会退回受限缺省。

**复现：** 设置 default_targets=['grok']，再 setSkillTargets(demo,['*'])；重新读取 targets=null，Cursor 状态为 excluded。

**修复方向：** 只有 targets=null 才删除覆盖项；显式 '*' 与显式全集必须保留。补不同缺省下的写入/解析往返及 CLI 累加启用测试。

[代码定位](/Users/william/agent-hub/src/core/frontmatter.ts:74)。

### R5 [P2] 首次 Vault 切到 Hub 投递的是空授权目录

归类：绑定提交顺序调整引入的回归。要求：SPEC §6.6、§7 Vault 切到 Hub。

applyBind 先 injectVaultCatalog 再 setBind，但 vaultCatalogFor 内部读取持久化绑定，旧值 off/own 时返回空数组。保存 hub 后没有再次投递，用户已授权条目也不会出现，直到再次同步或修改授权。

**复现：** 先授权 synthetic 给 Grok，再从 off 切 hub；vaultCatalogFor 返回 1 项，而生成文件没有 synthetic 条目。

**修复方向：** 投递阶段使用计划中的目标绑定与授权快照，不要读取尚未提交的旧状态；在有恢复保障的事务中完成投递与提交。

[代码定位](/Users/william/agent-hub/src/core/bind.ts:104)。

### R8 [P2] 保存全局记忆会清掉已投递项目，项目仍由最后一次编辑决定

归类：F06 工作区绑定仍未解决。要求：SPEC §6.4：global + 当前项目。

composeInject 只合成指定项目的修复有效，但 syncMemoryInjects 仍把一个 preferProject 写到所有 Hub Agent 的全局固定文件，没有保存 Agent/工作区的当前项目。保存 global 时参数为空，会覆盖掉项目段；改 beta 则让所有 Agent 改读 beta，与正在工作的 cwd 无关。

**复现：** syncMemoryInjects('alpha') 生成含 ALPHA_ONLY 的文件，随后 syncMemoryInjects()（保存全局记忆的调用方式）将其覆盖为仅 global。

**修复方向：** 以明确 cwd/repo-id 的工作区或会话作用域投递，保存全局记忆时保留各作用域项目选择；补两个工作区同时使用和全局更新的集成测试。

[代码定位](/Users/william/agent-hub/src/core/deliver.ts:73)。

## 上轮问题的复查状态

- F01：排除后删除 Hub 链、正文保存触发 relink 的普通路径已补上。
- F02：default_targets 已被使用；显式全开又受 R4 影响，不能整体关闭。
- F03：全局 adopt 不再主动迁移 Own；显式 Own→Hub 另有 R2。
- F04：有效外部软链不会再被 repair 静默替换。
- F05：顶层厂商链接和正文写入保护已补，但内部链接与 targets 接口仍存在 R7。
- F06：composeInject 已只取指定项目；工作区投递仍存在 R8。
- F07：五个适配器已声明 Ctx 路径并能生成投影；实际运行时是否消费这些文件，本轮未作真实集成验证。
- F08：备份能力已加入；恢复存在 R3。
- F09：正常长密钥的摘要脱敏已加入；失败路径存在 R6。
- F10：CLI argv 已携带交接路径/提示；HTTP /api/handoff 仍只生成产物，未执行 bridge。实际 CLI 参数兼容性未调用真实 Agent 验证，不能据数组断言判定闭环完成。
- F11：默认响应掩码、Origin/Content-Type 和 token 校验已加入；管理凭证匿名发放导致 R1。
- F12：enabled=[] 已保留，快照顺序按配置构造；新增任意 Agent 的配置能力仍受固定 AgentId 限制。
- F13：共享 applyBind、必选迁移模式、Memory 目标目录失败时不提交已补；事务性仍有 R2，Vault 顺序还引入 R5。

## 新增功能与剩余验收边界

静态可见新增了 root 指针配置、skills 路径覆盖、原生记忆导入、skill 删除、外部编辑器打开、Vault secretFields 参数、Identity 备份/恢复、嵌套厂商扫描和同步路径警告。对应入口存在不等于全部端到端验收完成。Keychain 现在区分无法访问和不存在，并在已有密文时拒绝新建替代密钥；本轮未对真实 Keychain 做故障注入。

特别注意现有测试的覆盖盲区：HTTP 测试验证匿名 reveal 被拒绝，却没有覆盖匿名获取 Cookie 后再 reveal；迁移测试验证缺少 mode 和目标目录错误，没有验证正常新 skill 的成功迁移；Identity 测试只检查备份存在，未验证 SOUL/子代理原路径恢复；targets 测试只测受限缺省，未测显式全开往返。

建议优先修 R1/R2/R3/R7/R6，然后补 R4/R5/R8 与真实运行时消费验收。复查结论以本报告为准；第一轮报告保留为历史记录。

