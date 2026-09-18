# Cursor / WorkBuddy 实机 UI 验证

日期：2026-09-16。通过 Computer Use 操作 Hub 浏览器界面和两个 Agent 桌面应用。测试当前源码启动的临时 Hub（3951）；原 3950 服务未替换。

## 方法

备份全局记忆和绑定，通过 Hub UI 写入临时非敏感代号 `HUB-ORCHID-6284`，将 Cursor、WorkBuddy 的 Memory 从 Own 切换为 Hub。分别在新任务中询问自动加载的验收代号，提示词不包含代号，明确要求不使用工具、不读文件、不猜测。随后给出精确投递路径，要求只读该文件，报告代号和来源。

## 观察

- Cursor，新任务「Hub acceptance code inquiry」：自动加载阶段回答 `NOT_AUTO_LOADED`。显式读取 `/Users/william/.cursor/rules/hub-generated.mdc` 后，界面显示读取该文件，正确返回 `HUB-ORCHID-6284` 和来源路径。
- WorkBuddy 5.5.6，Deepseek-V4.1-Flash，任务「Agent Hub Hub」：自动加载阶段回答 `NOT_AUTO_LOADED`，说明已有自动记忆不包含验收码。显式读取 `/Users/william/.workbuddy/memory/hub-generated.md` 后，正确返回同一代号和来源路径。初次输入不完整的请求被停止，不计入测试结果；实际盲测和对照请求均在界面确认提交。

## 结论与限制

两端文件投递及显式读取均通过；两端本次新任务中的自动加载验收均未通过。Hub 的“已同步注入”不能作为 Agent 已自动消费内容的证据。需进一步确认各客户端支持的自动加载入口、作用域及是否需要重启；本轮未重启客户端，不能据此断言所有模式均不支持这些路径。

本轮仅覆盖全局 Memory 的绑定、投递、读取和撤销，没有验证 Skills、Ctx、Vault、会话交接或工作区级记忆。

## 恢复

通过 Hub UI 将两端 Memory 恢复为原来的 Own，将 global.md 恢复原文。文件字节比较确认全局记忆与测试前备份完全一致；两端临时 hub-generated 投递文件已移除。测试对话保留供复核。未要求 Agent 修改项目文件。
