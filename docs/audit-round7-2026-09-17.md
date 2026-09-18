# 第七轮修复与回归审计

日期：2026-09-17。针对用户新列出的 P2 / P3 问题逐项核验并修复。下列结果覆盖源码、隔离文件系统、HTTP 回环与前端事件测试；不代表所有原生客户端已经实机验收。

## 修复结果

1. **项目 Skill 扫描遗漏属实。** 增加 `.claude/skills`、`.hermes/skills`、`.workbuddy/skills`，项目列表 `rel` 保留真实嵌套路径。同叶名来源全部列出，提升时明确报冲突，避免静默选择第一份。
2. **嵌套 Hub Skill 路径错位属实。** Hub 唯一标识改为相对目录路径，如 `group/foo`；列表、读写、revision、目标设置、删除、挂载和收编识别保持一致。既有扁平名称兼容。同叶名的 `foo`、`group/foo`、`other/foo` 可同时存在。归属于 Hub 的嵌套别名按真实目标识别；Own 副本按挂载相对路径识别。拒绝 `..`、绝对路径和经软链中间目录写出权威目录/挂载目录。
3. **交接重放全部 Memory 的副作用属实。** 移除交接里的全局同步。交接仍刷新来源索引，但只引用目标 Agent 当前登记工作区已生成的 Memory 文件；文件缺失时省略引用。交接文稿明确说明 Memory 未重新同步；需要更新时使用现有 Memory 同步入口。无论交接写入成功或失败，都不重写原生 Memory 或投影文件。
4. **交接列表跟随软链属实。** 列表与 scrub 通过 `O_NOFOLLOW` 打开文件，在同一描述符上确认常规文件后读取；外链不进入列表，启动该 ID 返回 404。只接纳 Handoff 文稿。此处约束 Hub 的文件读取，不声称能约束之后原生客户端打开路径时的本机恶意并发替换。
5. **自定义秘密不能撤销、空值恢复旧密钥属实。** 仅掩码保留旧值；空值明确清空。提交的单条 `secretFields` 为该条目的自定义标记全集，空数组可取消全部自定义标记，未提交条目保留旧分类。密码/token/key/secret 等自动识别名称继续保持秘密属性。UI 增加“取消自定义秘密标记”，要求先显示并确认字段值，保存后生效。清空只影响当前 Vault，既有加密 `.previous` 备份仍按原备份策略保留上一版本。
6. **保存快捷键和跨页草稿条缺失属实。** 编辑器获得焦点时 Ctrl/Cmd+S 调用对应保存按钮；只操作当前可编辑、可见编辑器。Identity、SOUL、子代理草稿在全局提示条列出，切 Hub/Agents 不丢失，保存后更新。
7. **Vault HTTP 默认明文返回属实。** `POST /api/vault/get` 默认返回 `{id, metadata}`，使用 CLI 同一元数据渲染器；需要明文时调用方必须明确提交 `reveal: true`，仍保留原有会话、绑定和授权检查。旧接口消费者需要适配。
8. **Goose 配置来源问题属实。** 改读原生配置目录的 `config.yaml` 中 `CONTEXT_FILE_NAMES` 数组；不使用 Hub 进程的同名环境变量。无配置时使用 `.goosehints` / `AGENTS.md` 默认值，配置格式错误或路径越界则拒绝投递。依据 [Goose 上游配置读取实现](https://github.com/aaif-goose/goose/blob/main/crates/goose/src/hints/load_hints.rs)。独立 Goose 进程若带额外环境覆盖，Hub 无法推断，仍需新会话验证实际加载。
9. **setBind 写后静默校正属实。** setter 在写入前拒绝不支持的 Sessions=index 和 memoryOnly 的非 Memory 接管。`saveConfig` 校验能力，手工 TOML 中的不支持绑定在读取时报明确错误，不再静默变更；用户需修正对应配置项。
10. **父目录 fsync 缺失属实。** 二进制写入在文件 fsync、rename 后对父目录 fsync。测试断言调用顺序；这不等同于实机断电或所有文件系统持久性验收。

## 回归与整体复核

保留执行原 A01—A15、前几轮事务恢复/故障注入、Vault 授权与掩码、索引保护、Git/同步目录防护、HTTP 认证、CLI、原生投递与草稿时序测试。复查本轮调用链包括 Skill UI/HTTP/CLI 路径传播、收编和冲突处理、Memory/交接写入边界、Vault 分类保存与显示状态、配置读写和原子文件发布。

新增回归主要在 `src/core/round7-regressions.test.ts`，前端真实事件函数测试补入 `src/core/round6-regressions.test.ts`，HTTP 默认元数据与显式明文覆盖在 `src/server.test.ts`。旧断言仅随上述契约更新，没有跳过失败用例。

最终验证：`npm test` 163 项通过，0 失败、0 跳过；`npm run typecheck`、两份前端 JavaScript 语法检查通过；`npm audit --json` 为 0 条已知依赖漏洞。相较上一轮新增 12 项测试。测试统计、检查状态与源文件哈希见 `round7-verification.json`。

## 实机验证边界

共享原生入口上的 Own 不等于读隔离；Hub 无法阻止其他客户端读取同一 AGENTS.md。该限制没有通过本次代码修复消除，必须在目标客户端/工作区中验收。没有启动真实模型会话或完成真实浏览器点击验收，也没有重启正式服务或对个人 Hub 执行收编、清理或迁移。本轮未发现自动化覆盖范围内的新失败；不能承诺不存在其他问题。
