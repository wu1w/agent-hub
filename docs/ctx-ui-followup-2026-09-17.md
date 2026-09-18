# Ctx Hub 前端拦截补充

按用户指定的两处补丁，将已有 allowsCtxHub / ctxHubBlockReason 接入 renderAgents 与 onBind：无 USER.md 投影路径或未在实际 Ctx global_targets 中的 Agent，Hub 选项禁用并说明原因；提交前再次检查，恢复原选择并停止确认框/API 请求。切回 Own 保持可用。

未修改默认 allowlist、正式配置或后端合同。新增 src/core/ctx-ui.test.ts，执行真实 renderAgents/onBind 函数，覆盖两种拒绝原因、合法投影、退回 Own、选项禁用与配置名单保持不变。

本次仅修改前端脚本。现有正式服务直接读取 web/app.js，无需重启进程；已通过认证请求确认 3950 提供的脚本与本地修复逐字节相同，包含两处拦截，snapshot HTTP 200、warnings=0。已打开页面刷新后生效。

## 用户列出的 P3 待办

以下保留为后续复核/取舍，本轮未扩大修改范围：

- Web Vault 的 id/说明检索框。
- 项目 Skill 叶名与嵌套 Hub 相对路径的身份/提升规则。
- Agents 卡片提示项目 AGENTS.md 始终 in-repo。
- SPEC 注入文件命名与 bind 示例更新。
- memoryOnly 兼容旁路副本是否仍需保留。
- ADAPTERS 与 AGENT_IDS 集合一致性锁测试。

已知边界仍保持：Own 不是共享文件读隔离；目录投递不等于原生加载证明；当前 Vault 无法识别已删除的历史秘密；正式日志权限为 0600，但仍含启动口令。

最终验证：166 / 166 测试通过，0 失败、0 跳过；类型检查与两份前端脚本语法检查通过。日志：/tmp/hub-ctx-update-tests.log。
