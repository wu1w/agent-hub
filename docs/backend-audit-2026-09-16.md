# Agent Hub 后端 PRD / SPEC 符合性审计

日期：2026-09-16。范围：本仓库当前 src/、docs/PRD.md、docs/SPEC.md，以及必要的 web 调用路径。未修改业务实现，未访问真实运行数据、密钥或启动真实 Agent。

## 结论

不满足“P0–P3 已实现”的验收口径。确认 13 项行为偏差（9 项 P1、4 项 P2），另有 7 项静态确认的功能/配置缺口。P1 表示应优先修复的资产修改、敏感信息边界或核心流程问题；P2 表示功能、配置及恢复能力偏差。下面的优先级是修复优先级，不是 PRD 的分期。

主要设计根因：绑定配置与文件变更缺少统一状态转换服务；适配器只登记目标路径，未完整表达能力、当前工作区及投递执行；Vault 的磁盘加密没有贯穿管理接口鉴权和派生数据脱敏。

## 验证范围与证据

- npm test：31/31 通过；npm run typecheck：通过。
- 独立复现脚本完成 15 个断言场景，覆盖以下 13 项偏差。全部使用临时 HOME/Hub 及随机测试加密密钥；脚本结束清理临时数据。
- [复现脚本](/Users/william/agent-hub/docs/audit/reproduce.mts)，运行：在仓库根执行 `node --import tsx docs/audit/reproduce.mts`。
- [复现输出](/Users/william/agent-hub/docs/audit/reproduction.log)。合成密钥没有使用用户凭据。
- F10 验证的是计划与执行参数，不声称完成真实 bridge / CLI 集成测试。HTTP 的跨 Origin 请求由测试客户端构造，不声称完成浏览器端攻击验证。

## 已复现的问题

### F11 · P1 · Vault 管理接口无鉴权，条目授权可被绕过

**要求：** SPEC §6.6、§10：按条目授权、防本机其他用户；PRD §8 Vault（[条款](/Users/william/agent-hub/docs/SPEC.md:231)）。

**实现：** GET /api/vault 无需凭证就返回 vaultUiPayload()，同时包含完整明文 markdown 和 masked；POST 接口也不验证 Origin、Content-Type 或管理会话。绑定到 127.0.0.1 并不能隔离其他本机用户。vaultGet 的 agent 只是调用者提交的字符串，不能作为运行时身份。 [代码](/Users/william/agent-hub/src/server.ts:185)。

**证据：** 无任何授权的合成条目，经无凭证 GET 返回明文；带外站 Origin、text/plain 的 POST /api/bind 返回 200 并改变绑定。未进行真实浏览器攻击测试；跨站读响应仍受浏览器同源策略约束。

**修复与验收方向：** 管理端使用受保护的本机会话；校验 Host/Origin 和请求类型；Agent 读取使用受限能力凭证或用户隔离 IPC。默认管理查询只返回掩码，显式显示时再读取值。不要把 agent 参数当鉴权。

### F03 · P1 · 全局 adopt 会移走 Skills=Own 的内容，且不回挂

**要求：** PRD §8 Skills：Own 时不写该目录；§11 首次导入；SPEC §6.2（[条款](/Users/william/agent-hub/docs/SPEC.md:150)）。

**实现：** scanUserSkills 扫描所有 enabled Agent，adoptSkills 不按 skills 绑定筛选就 moveDir；后续 relink 却跳过 Own。默认 WorkBuddy=Own，因此全局首次收编能摘空它的独有 skill。resolveSkillConflict 的 keep-hub 分支同样未过滤 Own 就删除原目录并建链。 [代码](/Users/william/agent-hub/src/core/skills.ts:155)。

**证据：** 创建 WorkBuddy 独有 private/SKILL.md，保持缺省 Own，执行 adoptSkills() 后原目录消失，Hub 出现 private。

**修复与验收方向：** 以 Agent 绑定和明确的迁移选择限定写入范围；全局 adopt 不移动 Own 内容。冲突解决必须限定到用户选定的 Agent，并遵守绑定和 targets。

### F04 · P1 · 断链修复会静默覆盖有效的外部软链

**要求：** SPEC §7：同名冲突停住选择，禁止静默覆盖；PRD §12（[条款](/Users/william/agent-hub/docs/SPEC.md:249)）。

**实现：** repair=true 时 ensureLink 无条件 unlink 指向其他有效目录的链接。repairLinks、adoptSkills、setSkillTargets 及多个 API 都传 true；现有 foreign 检测还排除了软链副本。结果是有效的其他来源被自动替换为 Hub。 [代码](/Users/william/agent-hub/src/core/skills.ts:243)。

**证据：** 把 Cursor 的 defaults 指向仍有效的 external 目录，执行 repairLinks 后链接被改指向 Hub，没有冲突确认。外部源文件未删除，但运行时已静默改用另一份内容。

**修复与验收方向：** 只修复可证明属于 Hub 的断链；有效的外部目标必须报告 conflict。保存原目标并在明确选择 keep-hub 后才替换。

### F05 · P1 · 按入口目录识别来源，厂商资产可经软链被收编和修改

**要求：** PRD §6/§8：厂商资产不收编；SPEC §5、§6.2、§10.1（[条款](/Users/william/agent-hub/docs/SPEC.md:118)）。

**实现：** 用户挂载点的 symlink 被当用户 skill，adopt 的纯软链分支直接在 Hub 再建指向 realpath 的软链；未排除厂商、项目或 vault 路径。后续 writeHubSkill 和 writeAllowed 跟随软链写入。files.ts 的 allowlist 只做路径字符串检查，没有真实路径边界。 [代码](/Users/william/agent-hub/src/core/skills.ts:189)。

**证据：** 在 .grok/skills 建链接指向 .grok/bundled/skills/vendor-demo；adopt 后 writeHubSkill 能修改厂商 SKILL.md。vault 目标限制缺失为静态确认，未向真实保险库写入。

**修复与验收方向：** 对目录、文件及内部软链验证 realpath 和来源；拒绝厂商/vault，项目来源只能显式提升。收编时确定权威目录政策，并在编辑与投递阶段再次验证。

### F01 · P1 · skill 被排除后仍可读取，status 却显示 excluded

**要求：** PRD §6.2、§10 故事 3/4；SPEC §6.2、§12（[条款](/Users/william/agent-hub/docs/SPEC.md:150)）。

**实现：** relinkHubSkills 遇到不允许的 targets 只 continue，不删除原 Hub 链；linkStateFor 在检查实际链接前直接返回 excluded。修改规则后，状态显示与实际运行时访问不一致。直接编辑 SKILL.md 的 API 也不触发重投递。 [代码](/Users/william/agent-hub/src/core/skills.ts:228)。

**证据：** demo 先挂到所有 Hub Agent，再 setSkillTargets('demo',['grok'])；Cursor 链仍存在且可读，但 records 返回 excluded。

**修复与验收方向：** 将投递改为期望状态与实际状态的差异同步：新增允许链接，移除已确认属于 Hub 的排除链接；Own 目录不写。正文保存若变更 targets，也走同一同步流程。

### F06 · P1 · 项目记忆没有隔离，当前项目注入混入其他项目

**要求：** SPEC §6.4：global + 当前项目摘抄；PRD §8 Memory（[条款](/Users/william/agent-hub/docs/SPEC.md:178)）。

**实现：** composeInject(preferProject) 仅把优先项目放最前面，仍遍历所有项目到 24,000 字符；无参数也注入所有项目。投递路径又是每 Agent 一个全局文件，因此多个工作区无法各自获得正确的项目记忆。 [代码](/Users/william/agent-hub/src/core/memory.ts:108)。

**证据：** alpha 和 beta 各有独立记忆，composeInject('alpha') 的结果包含 BETA_ONLY。

**修复与验收方向：** 注入参数使用明确 cwd/repo-id，只合成 global 与选定项目；未选择项目时只注入 global。按工作区投影或在启动/会话作用域注入，测试同时打开两个项目。

### F09 · P1 · 已知 Vault 密钥会进入 session 索引和 handoff 明文

**要求：** PRD §12；SPEC §6.6 Hub 调用第 5 条、§10.2（[条款](/Users/william/agent-hub/docs/SPEC.md:231)）。

**实现：** session scanner 把原始标题/摘要截取后直接写 SQLite；createHandoff 又直接渲染这些字段，没有已知密钥值脱敏。CLI vault get 也直接把值输出到 stdout，目录文案指引 Agent 调用它，但未提供不会进入工具日志的启动环境注入通道。 [代码](/Users/william/agent-hub/src/core/sessions.ts:168)。

**证据：** 在合成 Vault 和 Grok summary 放入同一假密钥，rebuildIndex 后 summary 与 createHandoff 输出都包含完整假密钥。未读取或输出用户真实密钥。

**修复与验收方向：** 在索引、交接等派生数据的持久化边界统一脱敏；无法取得脱敏数据时明确降级而非静默复制。提供受控子进程 env 注入，避免把 CLI 明文输出作为默认 Agent 集成路径。

### F10 · P1 · 交接止步于写文件/打印计划，执行命令不携带交接内容

**要求：** PRD §10 故事 7、§14 P1；SPEC §6.5、§11（[条款](/Users/william/agent-hub/docs/SPEC.md:188)）。

**实现：** API /handoff 只 createHandoff。MCP grok_start/grok_resume 只是返回对象和文稿，没有实际调用；CLI --exec 仅 spawn argv。跨 Agent 的 Grok argv 只有 grok --cwd，Codex 只有 codex，不传 handoff 路径或 prompt，因此新运行时不会自动收到交接指令。 [代码](/Users/william/agent-hub/src/core/handoff.ts:36)。

**证据：** 检查 resumePlan(Cursor→Grok) 返回 ['grok','--cwd',cwd]，不含 handoffPath。未启动真实 Agent。前端也只展示返回的说明/命令。

**修复与验收方向：** 实现受支持的 bridge/CLI 执行适配器，把交接 prompt 交给目标运行时，并返回开始/失败状态；不支持的目标明确标为手动交接。分别验收同源恢复与跨源新开。

### F13 · P1 · 绑定切换先保存后执行，失败仍保留成功状态

**要求：** SPEC §7 绑定状态机，Own→Hub 必须显式选择；§2 GUI/CLI 共用后端（[条款](/Users/william/agent-hub/docs/SPEC.md:247)）。

**实现：** HTTP 和 CLI 各自编排 setBind→迁移→投递，先持久化绑定。失败没有回滚，冲突仍可留下 Hub 状态；Own→Hub 缺失 mode 时静默使用 adopt，CLI 未强制 flag。detach-copy 也先删链再拷贝。 [代码](/Users/william/agent-hub/src/server.ts:80)。

**证据：** POST WorkBuddy Own→Hub 不传 skillsMode 被接受。再让 memory 投递路径成为目录触发失败，API 返回 500，但 grok.memory 已保存成 hub。

**修复与验收方向：** 把迁移合并为共享的 plan/validate/apply/commit 服务；Own→Hub 强制明确选项，预检冲突；复制成功后再替换链接。记录执行状态并提供恢复，失败不能只留下已成功的绑定。

### F02 · P2 · config 的 skill 缺省 targets 被读取却从未用于投递

**要求：** SPEC §4、§6.2：无 hub.targets 时使用 config default_targets（[条款](/Users/william/agent-hub/docs/SPEC.md:150)）。

**实现：** linkStateFor 与 relinkHubSkills 都调用 targetsAllow(...,true)，忽略 cfg.layers.skills.default_targets。CLI enable 对 '*' 直接替换为指定列表，也与“增加启用目标”的直觉不符。 [代码](/Users/william/agent-hub/src/core/skills.ts:109)。

**证据：** 设 default_targets=['grok']，添加无 frontmatter 的 defaults skill，relink 后 Cursor 仍被挂载。

**修复与验收方向：** 统一 resolveEffectiveTargets(skill,config)，状态、挂载、enable/disable 共用；区分显式 '*'、空列表和缺省值。

### F07 · P2 · 四个 Agent 接受 Ctx=Hub，但投递是空操作

**要求：** SPEC §4 缺省 Hyper Ctx=Hub；§6.3 投影到可读取路径（[条款](/Users/william/agent-hub/docs/SPEC.md:167)）。

**实现：** 只有 WorkBuddy 适配器定义 userMdProjection；Grok、Cursor、Codex、Hyper 的 injectCtx 立即返回 null。默认 Hyper 已显示 hub，实际无文件投递；接口仍返回成功。 [代码](/Users/william/agent-hub/src/core/deliver.ts:87)。

**证据：** 缺省配置中 hyper.ctx='hub'，injectCtx('hyper') 返回 null，即使运行时目录存在。

**修复与验收方向：** 为支持的运行时实现并验证读取路径；不支持的适配器拒绝 Hub 绑定并清楚表达能力限制。不得借用 Identity 文件投递 Ctx。

### F08 · P2 · Identity 保存没有备份与恢复后端

**要求：** SPEC §6.1：backups/identity/<agent>/<timestamp>.md；PRD §8 Identity（[条款](/Users/william/agent-hub/docs/SPEC.md:141)）。

**实现：** identity/soul/subagent 的保存直接 writeText，未备份；全仓库没有 Identity 恢复接口。Ctx/Memory 的备份机制不能替代 Identity 备份。 [代码](/Users/william/agent-hub/src/core/files.ts:95)。

**证据：** 创建已有 grok/IDENTITY.md 后通过 writeAllowed 保存，新内容覆盖原文，backups/identity 不存在。

**修复与验收方向：** 覆盖前备份到约定的 Agent 目录，记录原路径及版本；提供恢复预览与恢复操作，并保证不建立跨 Agent 同步关系。

### F12 · P2 · 无法配置全部禁用，空 enabled 被恢复成全开

**要求：** PRD §5：配置 Agent 列表可增删；SPEC §4 agents.enabled（[条款](/Users/william/agent-hub/docs/SPEC.md:45)）。

**实现：** loadConfig 把 enabled=[] 与字段缺失混为一谈，填回全部五个；AgentId/ADAPTERS 硬编码五种，也没有配置级适配器扩展。agentSnapshots 按 ADAPTERS 顺序而非 enabled 顺序输出。 [代码](/Users/william/agent-hub/src/core/config.ts:131)。

**证据：** saveConfig({agents:{enabled:[]},...}) 后 loadConfig().agents.enabled.length=5。

**修复与验收方向：** 区分未设置与显式空集合，校验未知 ID；若承诺新增适配器则提供注册配置。快照按 enabled 的顺序构造，测试全部禁用后无投递。

## 静态确认的功能缺口（不计入 13 项复现问题）

- **配置能力缺项**（SPEC §3/§5）：root 只支持 AGENT_HUB_ROOT，config.toml 的 root 不读取；适配器路径硬编码，Hyper 未读取自身 skills 目录配置。 [代码](/Users/william/agent-hub/src/core/config.ts:36)。
- **原生记忆扫描/一次性导入缺项**（SPEC §5、§6.4）：Adapter 没有原生记忆发现字段；后端仅有 Hub 记忆读写，没有 WorkBuddy 等原生记忆的一次性导入入口。 [代码](/Users/william/agent-hub/src/core/adapters.ts:5)。
- **Skill 删除/移除缺项**（PRD §7.1）：后端导出与 HTTP/CLI 路由中未发现 Hub skill 删除/移除操作；detachAgentSkills 仅切换某个 Agent 绑定。 [代码](/Users/william/agent-hub/src/server.ts:51)。
- **Vault 自定义秘密字段缺项**（SPEC §6.6 文稿约定）：字段是否秘密由名称正则或历史 secret 标记决定；保存 API 只有 markdown/grants，没有任意行标记为秘密的操作。 [代码](/Users/william/agent-hub/src/core/vault.ts:37)。
- **短文件系统编辑器打开缺项**（PRD §9、SPEC §8.3）：只有 session reveal 的 open -R；没有 Identity/USER.md/Memory 等短文件的系统编辑器打开后端。 [代码](/Users/william/agent-hub/src/server.ts:158)。
- **启动存储边界检查缺项**（SPEC §3、§10.4）：ensureHub 未创建运行数据目录的 Vault 忽略规则，也未检测 iCloud Desktop/Documents 等同步路径并警告。源码仓库的 .gitignore 不能替代运行数据目录策略。 [代码](/Users/william/agent-hub/src/core/config.ts:71)。
- **嵌套厂商 skill 的发现不完整**（SPEC §5、§8.1）：scanVendorSkills 仅枚举登记目录的直接子目录并寻找 SKILL.md；对插件缓存等嵌套树不能发现全部厂商 skill。 [代码](/Users/william/agent-hub/src/core/skills.ts:69)。

## 需要进一步验证的风险

Keychain 错误处理另有需修复风险：keychainGet 将超时/拒绝访问等所有错误当作“条目不存在”，loadMasterKey 随后生成新主密钥，并用 security add-generic-password -U 写回。如果读取旧密钥失败而更新成功，旧 vault.bin 会无法解密。此项仅做静态代码确认，未对真实 Keychain 做故障注入。应区分不存在与不可访问；已有密文时禁止自动生成替代密钥。（src/core/vault.ts:143–175）

本次未验证各运行时是否真的读取 memoryInjectPath/vaultCatalogPath。写出 hub-generated 文件不能单独证明运行时已消费；应补每个适配器的实际读取集成验收。

## 已有实现与文档歧义

AES-256-GCM、缺省条目空授权、按 agent 参数检查绑定与 grants、密文权限设置已有实现；普通路径下 Ctx/Memory 切回 Own 的备份恢复测试通过。会话使用 SQLite 索引，没有搬运完整 jsonl。Identity 路径与 Ctx 路径在静态配置上分离。上述局部正确性不能消除前述边界缺陷。

PRD §11 表述 Ctx 首次应 Own/关，SPEC §4 却默认 Hyper Ctx=Hub、WorkBuddy Skills=Own；本报告采用 SPEC 的具体缺省值，不将此冲突算作代码错误。SPEC §13 允许等价本地索引库，因此索引选型本身不作为偏差。

## 建议修复顺序

1. 先补 Vault 管理端/Agent 端边界、派生文件脱敏，以及 Own/厂商/软链保护（F11/F09/F03/F04/F05）。
2. 建立 CLI 与 HTTP 共用的绑定迁移服务，预检、执行、提交与恢复统一；所有 skill 变更走同一差异同步（F13/F01/F02）。
3. 为适配器增加能力声明与工作区参数，完成 Ctx、Memory、handoff 的真实投递和消费验收（F06/F07/F10）。
4. 补 Identity 恢复、配置语义及缺失入口，再更新 P0–P3 的完成声明（F08/F12 与静态缺项）。

应将复现用例改写为“期望安全行为”的正式回归测试；当前复现脚本是断言缺陷仍存在，修复后应失败，不能直接用作验收通过标准。

