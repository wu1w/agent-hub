# Agent Hub 第三轮全面审计

审计日期：2026-09-16。范围：当前 PRD/SPEC、src 全部后端模块与测试、CLI/HTTP 入口，以及 Vault 编辑等必要的前后端调用链。目录无 Git 历史；“新发现”表示前两轮未报告，不等于确认是本轮提交引入。

## 结论

确认 **13 项问题：8 项 P1、5 项 P2**。其中 11 项后端/设计问题，2 项 Vault 前后端交互问题。上轮具体用例已有明显修复，但文件操作的事务性、并发更新、真实路径保护、旧数据兼容与工作区投递仍有缺口。

P1 是优先修复的资产安全/核心流程问题，P2 是功能正确性/完整性问题，与 PRD 的 P0–P3 分期不是同一含义。

## 验证

- 现有测试 **67/67 通过**，TypeScript 检查通过。
- 新增独立复现脚本 **15 个场景全部复现**，按根因归并为上述 13 项。并发失败的表现依赖调度：可能丢失更新，也可能密文认证失败。
- [复现脚本](/Users/william/agent-hub/docs/audit/recheck-round3.mts) · [复现日志](/Users/william/agent-hub/docs/audit/recheck-round3.log)。在仓库根执行 `node --import tsx docs/audit/recheck-round3.mts`。
- 脚本断言缺陷仍存在，修复后应失败；不能直接作为验收通过标准。
- 只使用临时 HOME/Hub 与合成数据、随机测试主密钥。未修改业务代码、未碰真实 Agent 配置/密钥、未启动真实 Agent、未操作真实 Keychain。
- 两项前端用例通过 VM 执行从当前 web/app.js 抽取的真实函数与最小状态桩，未做完整浏览器交互测试。

## 已确认问题

### T04 [P1] 并发保存会恢复已撤销授权，甚至损坏 Vault 密文

**范围与归类：** 并发与持久化；新发现。

**要求：** SPEC §6.6 按条目授权、§7 停止注入、§2 GUI/CLI 共用后端。

**实现偏差：** setVaultGrants 和 setBind 都是无锁的读取—修改—全量写回。多个请求/CLI 进程可以读到同一旧版本并互相覆盖；writeBinary 直接截断写同一个 vault.bin，也不是原子替换。

**复现证据：** 两个不同条目的撤销操作 Promise.all 均成功返回，重读后仍有一个条目保留授权；并发更新两个 Agent 的绑定也丢一项。另一次并发测试出现 AES-GCM authentication failed。最终脚本接受并区分“撤销丢失”与“密文损坏”两种失败，具体结果取决于调度。

**建议修复：** 对整个读改写事务串行化，覆盖跨进程；加入版本/CAS 检查，密文和配置采用同目录临时文件、刷盘、原子替换。仅改为 rename 无法解决丢失更新。

[代码定位](/Users/william/agent-hub/src/core/vault.ts:259)。

### T01 [P1] 预检通过后发生投递错误，仍留下被摘空的 Own 目录

**范围与归类：** Skills 迁移；R2/F13 未完整关闭。

**要求：** SPEC §7；PRD §8 Own 不写、§12 迁移。

**实现偏差：** 新的预检能阻止已知同名冲突，但 adopt 执行多个 move/copy 后才 relink；没有执行日志或回滚。一个其他 Agent 的挂载点不可写/是普通文件，足以让显式 Own→Hub 在提交前失败。

**复现证据：** WorkBuddy=Own 且有唯一 demo；把 Grok skills 挂载点设为普通文件。applyBind(adopt) 抛错，WorkBuddy 绑定仍为 Own，但 demo 已迁入 Hub，原目录消失。

**建议修复：** 迁移预检涵盖全部将操作的目标；分阶段复制、验证和替换，保留原目录到提交完成；失败恢复已应用操作，并使 CLI/API 返回可恢复状态。

[代码定位](/Users/william/agent-hub/src/core/skills.ts:317)。

### T02 [P1] 已有个人软链收编成功后，原 Agent 仍使用旧源

**范围与归类：** Skills 迁移；新发现。

**要求：** PRD §6 一份权威、§10 首次 adopt；SPEC §6.2、§7。

**实现偏差：** 纯软链来源被 copy 到 Hub；ensureLink 为避免覆盖外部有效链接而跳过旧链接。显式 adopt 已选定迁移却没有在迁移计划内回挂原链接。结果权威内容变成两份。

**复现证据：** WorkBuddy 的 demo 指向 .agents/skills/demo；执行 Own→Hub/adopt 后返回零冲突且绑定 Hub，但链接仍指向 .agents 原目录，status 为 conflict。其他 Agent 则能使用 Hub 拷贝。

**建议修复：** 把显式选定来源链接的旧目标记录进迁移计划，成功收编后受控替换并可回滚；未授权的外部链接继续保持冲突，不要让普通 repair 恢复强制覆盖。

[代码定位](/Users/william/agent-hub/src/core/skills.ts:275)。

### T03 [P1] 首次导入同名冲突没有可执行的解决路径

**范围与归类：** Skills 迁移；新发现。

**要求：** SPEC §7 同名冲突选择 keep-agent-then-adopt；PRD §11 首次导入。

**实现偏差：** Hub 尚无该 skill 时，Grok/Cursor 各有同名目录会被预检挡住。但 resolveSkillConflict 强制要求 hubDest 存在，连 keep-agent-then-adopt 都无法执行；conflictRows 又只遍历 Hub 已有项。

**复现证据：** 两个用户目录各放 demo、Hub 为空：adopt 报冲突，resolveSkillConflict('demo','agent',Grok路径) 报“Hub 中没有 skill”。

**建议修复：** 冲突对象应包含尚未导入的候选来源；允许明确选中 Agent 副本后首次建立 Hub 权威，并保护其他来源。CLI 和 GUI 都需提供此路径。

[代码定位](/Users/william/agent-hub/src/core/skills.ts:525)。

### T06 [P1] 旧版本 SOUL/子代理备份仍会被当作 Identity 恢复

**范围与归类：** 备份与恢复；R3 升级兼容未完整关闭。

**要求：** SPEC §6.1 备份恢复写回原路径。

**实现偏差：** 新备份有 kind 元数据，但旧版时间戳 .md 没有元数据。readBackupMeta 对无法识别的文件直接默认 kind=identity。前一版 SOUL 正是这种文件名，因此升级后仍存在错位恢复。

**复现证据：** 用上一版真实命名格式创建无 meta 的 SOUL 备份，恢复后主 IDENTITY.md 被 LEGACY_SOUL 覆盖。

**建议修复：** 把无法判定来源的旧备份标记为 unknown；要求明确选择原文件并预览，不要猜作 Identity。为历史备份提供迁移或人工映射。

[代码定位](/Users/william/agent-hub/src/core/files.ts:166)。

### T07 [P1] Ctx 投影遇到已有软链会写穿 Identity

**范围与归类：** Ctx/Identity 边界；新发现。

**要求：** SPEC §6.3 明确禁止覆盖 AGENT.md/IDENTITY.md/SOUL.md。

**实现偏差：** 投影目标只判断是否目录，没有检查是否软链或 realpath 是否等于 Identity/SOUL。writeText 会跟随 USER.md 的链接。Ctx 备份了内容，也不能阻止另一个层的源文件被改写。

**复现证据：** WorkBuddy USER.md 软链指向其 IDENTITY.md；切 Ctx=Hub 后 IDENTITY.md 包含 hub-generated，原人格正文被覆盖。

**建议修复：** 投影前验证真实路径与受保护文件身份；拒绝别名，或备份链接本身后以新的普通投影文件替换该链接。切回 Own 应恢复原链接而非覆盖其目标。

[代码定位](/Users/william/agent-hub/src/core/deliver.ts:133)。

### T08 [P1] 保护范围未覆盖目录软链内部及自定义挂载目标

**范围与归类：** 文件系统边界；R7/F05 边界未完整关闭。

**要求：** SPEC §6.2 厂商目录永不创建 Hub 链、§10.1 skill symlink 不得指向 vault。

**实现偏差：** skillTreeBlocked 对目录 symlink 只检查它直接解析到的路径，不遍历内部；深度超过 4 也直接允许。另一方面 relinkHubSkills 使用可配置 skill_dir 创建链接，却未拒绝 vendor/vault 等受保护目标。

**复现证据：** 用户 skill/assets→普通共享目录，共享目录/vault→Hub vault；检查返回 false，adopt 后 Cursor skill 内可解析到保险库目录。另把 grok.skill_dir 配成 bundled/skills，relink 会直接在厂商目录创建 Hub 链。未声称这些链自动解密密文。

**建议修复：** 真实路径图遍历需循环检测与统一禁区判断，超出预算拒绝而非允许；把源目录、内部链接和写入目标统一校验。投递现有 Hub 条目时也重新核查，不只在 adopt 时检查。

[代码定位](/Users/william/agent-hub/src/core/skills.ts:67)。

### T12 [P1] 失焦掩码漏掉自定义秘密字段和多行密钥

**范围与归类：** Vault 前后端交互；新发现；前后端契约。

**要求：** PRD §9、SPEC §6.6 任意字段可标密钥、§8.1 失焦再掩。

**实现偏差：** 后端支持 secretFields 自定义字段，并能解析多行字段；前端 maskNow 只按每行字段名的正则掩码，既不知道 secret 标记，也不处理续行。显示明文后失焦调用这一函数，不能恢复后端掩码语义。

**复现证据：** 从当前 app.js 抽取真实 maskNow 执行：账号: CUSTOM_SECRET 仍明文；密钥第一行被掩码，SECOND_LINE 留下。使用 VM 调用函数，未声称已做完整浏览器交互测试。

**建议修复：** API 返回字段标识和 secret 元数据，客户端按结构掩码整字段；保持服务端和客户端同一语义。补自定义字段、多行、默认隐藏时新输入以及失焦场景。

[代码定位](/Users/william/agent-hub/web/app.js:919)。

### T05 [P2] 常规子代理保存生成的备份不出现在恢复列表

**范围与归类：** 备份与恢复；新备份实现的回归。

**要求：** SPEC §6.1、PRD §8 Grok 子代理 Identity。

**实现偏差：** 前端 subagent.name 不含 .md；backupAgentFile 使用该值拼成 .subagent.helper，没有补扩展名。listIdentityBackups 只接受 endsWith('.md')，因此备份虽落盘却无法列出和恢复。

**复现证据：** writeAllowed('subagent',...,'grok','helper') 后磁盘存在 .subagent.helper，而 listIdentityBackups('grok') 为空。

**建议修复：** 备份文件统一用 .md 扩展名，子代理逻辑名只进元数据；兼容已生成的无后缀备份。测试应使用前端实际传参。

[代码定位](/Users/william/agent-hub/src/core/files.ts:176)。

### T09 [P2] 多个中文秘密字段映射到同一环境变量，值被覆盖

**范围与归类：** Vault 环境注入；新增 env 功能问题。

**要求：** SPEC §6.6 启动时注入声明的环境变量。

**实现偏差：** slugEnv 删除非 ASCII 字符，中文秘密字段全部回退成 KEY。entry 的快捷变量只保留第一个秘密；三个字段时中间值无法从任何 env 变量取回。ASCII 标点归一化同样可能冲突。

**复现证据：** 密钥、密码、私钥三个 secret 字段，仅产生 HUB_VAULT_DEMO 与 HUB_VAULT_DEMO_KEY 两项，PASSWORD_VALUE 完全丢失。私钥通过 secretFields 支持的自定义秘密字段表达。

**建议修复：** 允许明确声明 env 名；默认映射使用稳定且唯一的字段标识，冲突报错。返回不含值的映射说明供调用方确认，避免静默覆盖。

[代码定位](/Users/william/agent-hub/src/core/vault.ts:289)。

### T10 [P2] 先分页再过滤 Own，会把仍可见的会话藏掉

**范围与归类：** Sessions 查询；新发现。

**要求：** SPEC §6.5、§8.1 Sessions=index 出现在总目录。

**实现偏差：** listSessions 在 SQL 中先 LIMIT，visibleHubSessions 再按绑定过滤。如果最新 120 条来自 Own，GUI 即使有更旧的 index 会话也显示空列表；分页结果不完整。enabled 过滤也未加入该查询。

**复现证据：** 较新的 Grok=Own 与较旧 Hyper=index 各一条；limit=1 返回空，limit=10 才看到 Hyper。GUI limit=120 时按相同原理触发。

**建议修复：** 把 enabled/index/显式揭隐条件放进 SQL WHERE，在 ORDER BY/LIMIT 前执行；统计也使用相同可见性规则。

[代码定位](/Users/william/agent-hub/src/server.ts:263)。

### T11 [P2] 记住上次项目后，修改另一项目仍覆盖所有 Agent 的项目选择

**范围与归类：** Memory 工作区；R8/F06 工作区语义仍未关闭。

**要求：** SPEC §6.4 global + 当前项目；PRD §8 项目记忆。

**实现偏差：** 新 inject-state.json 能在全局更新时保留上次选择，但带 preferProject 的同步会重设每一个 Hub Agent 的项目。仍然没有 cwd/会话作用域，状态被最后编辑的项目统一覆盖。

**复现证据：** Grok 已注入 alpha，之后 Cursor 切 Hub 并同步 beta；Grok 投影也变为 beta，alpha 消失。

**建议修复：** 区分“编辑某项目内容”和“选择运行时当前项目”；由 Agent/工作区绑定确定投递目标，同时打开两个工作区时不能共享一个项目投影。

[代码定位](/Users/william/agent-hub/src/core/deliver.ts:107)。

### T13 [P2] 点击显示密钥会直接覆盖未保存的编辑草稿

**范围与归类：** Vault 前后端交互；显示接口改造后的回归。

**要求：** PRD §9、SPEC §8.3 脏状态与编辑可靠性。

**实现偏差：** toggleVaultReveal 从服务器重新拉完整 markdown 后直接替换 editor.value，没有检查 dirty 或合并正在编辑的掩码草稿。编辑说明、添加条目或修改新密钥后点击显示，会丢失本地修改。

**复现证据：** 从当前 app.js 抽取 toggleVaultReveal，在 dirty=true、编辑器为 UNSAVED_DRAFT 时调用，值变成服务器的 PERSISTED_TEXT，未请求确认。

**建议修复：** 以草稿作为唯一编辑状态；显示操作仅补充未修改的秘密字段，或在 dirty 时阻止重新加载并明确提示。补键鼠与失焦相关的交互回归测试。

[代码定位](/Users/william/agent-hub/web/app.js:941)。

## 第二轮问题的关闭情况

这里区分“原复现场景通过”和“整项设计已经满足要求”：

- **R1 匿名领取管理 Cookie：原场景已修。** 当前所有 API 都要求会话，login 必须提交启动口令，不再对匿名 GET 发管理 Cookie。现有 HTTP 测试已覆盖匿名受限。
- **R2 源目录误判冲突：原场景已修。** 新预检排除所选来源，并在存在冲突时不迁移。执行阶段异常仍是 T01，纯软链迁移和首次冲突处理分别为 T02/T03。
- **R3 SOUL 恢复错位：新格式原场景已修。** kind/originalPath 元数据和恢复前备份已加入；旧格式仍有 T06，子代理命名另有 T05。
- **R4 显式通配符：已修。** setHubTargets 保留显式 ['*']，不再错误回退至 config default_targets。
- **R5 首次 Vault 目录为空：已修。** 注入可使用 assumeHub 目标状态，新授权目录测试通过。
- **R6 Vault 不可解密时仍保存摘要：原场景已修。** loadSecretMaterial 表达不可用，索引标题/摘要留空，并报告 redaction=unavailable；短秘密字段不再按长度跳过。未将此算为本轮问题。
- **R7 内部 SKILL.md 直链厂商：原场景已修。** targets 和正文写入复用检查；间接目录链接和投递目标仍有 T08。
- **R8 全局更新清除项目：原场景已修。** state 保留上次选择；多 Agent/工作区仍存在 T11。

本轮还看到：默认 Hyper Ctx 已改 Own，与新增 SPEC 说明一致；CLI vault get 默认不输出秘密值，新增 --exec 子进程 env 注入；Sessions=own 的交接需要显式揭隐；非法备份名不再静默选最新。

## 未关闭的产品/集成验收点

以下为静态确认或未验证边界，不计入 13 项动态问题：

1. **GUI 交接执行仍未闭环。** server 的 /api/handoff 只调用 createHandoff，页面只展示路径和命令；没有实际调用 bridge。CLI --exec 已有命令路径，实际 Grok/Codex 参数兼容性和续写行为仍需要真实集成验收。代码：[server.ts](/Users/william/agent-hub/src/server.ts:275)。
2. **投影文件是否被实际消费尚未证明。** Ctx/Memory/Vault 已能生成文件，但测试主要检查文件内容；应分别验证五种运行时确实读取配置位置。不得用生成成功代替注入生效。
3. **配置的“全部停用”语义不完整。** agents.enabled=[] 已保留，但 layers.sessions.index=[] 仍被 mergeLayers 的 ids.length 条件恢复为缺省；此外 global_targets 被 SPEC 描述为可切 Hub 的能力约束，applyBind 未检查该集合。代码：[config.ts](/Users/william/agent-hub/src/core/config.ts:253)。
4. **适配器扩展仍固定五个 AgentId。** 自定义 skill_dir 已支持，不等于配置可注册新 Agent；PRD §5 的可增删范围应明确。
5. **可靠持久化不仅是异常返回。** 配置/Vault/记忆多个保存路径直接覆盖，除 T04 外，还需要故障注入验证进程终止、磁盘满和恢复；本轮未通过杀进程或操作真实磁盘验证这些条件。

## 设计层面的修复建议

第一优先级是共享后端的“变更事务”边界：配置、授权和目录变更不能分别各自成功。对并发更新建立版本/锁；对迁移建立可预检、可提交、可恢复的计划。随后把受保护真实路径校验集中到所有读写/投递入口，避免仅修一条 API。

备份、Vault 字段与项目选择需要稳定身份：备份用 kind + 原文件标识；环境变量用明确唯一映射；前端秘密掩码用结构化字段；Memory 用工作区/会话身份。不要依赖文件名猜测、中文字段去字符、最后一次编辑的项目或重新拉取全文来维持状态。

补回归时应覆盖用户的完整操作路径：首次导入冲突→选来源→回挂；真实软链 adopt；两个撤销并发；旧备份升级；子代理前端实际名称；Vault 草稿→显示→失焦→保存；不同工作区同时运行。现有 67 个测试均通过，说明不能再仅以原单一复现场景的通过作为整体完成证据。

