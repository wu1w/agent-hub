# ZCode、Grok Bot、豆包与 Kimi Code 兼容

新增四个适配器，共 23 个。沿用上一批 Memory 优先策略，默认 Own，Skills、Identity、Ctx、Sessions、Vault 暂不接管。支持 Hub 绑定、撤销、源记忆更新同步和事务回滚；不修改认证配置。

## 自动加载

- ZCode：全局 `~/.zcode/AGENTS.md`、已登记工作区 `AGENTS.md`。保留用户原文，只维护 `agent-hub:zcode:memory` 区块。
- Kimi Code：全局 `~/.kimi-code/AGENTS.md`、已登记工作区 `AGENTS.md`；尊重 `KIMI_CODE_HOME`，不动通用 `~/.agents/AGENTS.md`。
- 共享项目入口沿用现有保护：拒绝写入受版本控制的文件、符号链接及不安全路径；不同 Agent 的托管区块分别撤销。测试覆盖原文保留、幂等、项目隔离及回滚。

依据：[ZCode 官方说明](https://zcode.z.ai/cn/docs/agents)、[Kimi Code 数据目录](https://moonshotai.github.io/kimi-code/en/configuration/data-locations.html)。本机已发现 ZCode 的 `.zcode/v2` 和 Kimi Code 配置；安装检测不代表已登录或模型实际消费记忆。

## 手动导入

Grok Bot 与豆包桌面版未确认有稳定的本地记忆自动加载入口。Grok Bot 官方说明见[产品介绍](https://x.ai/news/designing-grok-bot)，未提供可据此实现全局本地文件自动加载的契约。对本机客户端资源和配置目录的检查也不足以证明此能力。

因此两者使用明确的手动模式：

1. Agents 卡片提供“复制全局记忆”，复制的是 Hub 已保存内容。
2. Memory=Hub 时，在当前 Hub 根目录的 `memory/exports/grokbot.md` 或 `doubao.md` 维护副本，不往客户端配置里编造 AGENTS.md。
3. 用户在客户端支持的文件附件或指令界面自行导入。远程 Bot 不保证能读取本机路径；需使用客户端提供的上传方式。
4. 已导入的副本不会随 Hub 更新自动变化，需要重新导入。切回 Own 删除 Hub 管理的导出，不撤销已经上传的远程副本。
5. 若登记项目，项目导出位于该工作区 `.agent-hub/hub-generated-memory-<agent>.md`，不会混入全局导出。

两种模式在界面用中英翻译键区分；手动导出路径不会标成自动加载入口。本轮没有上传私人记忆，也没有进行真实模型对话验收。

## 配置升级

schema 4 只扩展完整的旧版默认清单；显式子集和空列表保留。已有绑定不变，新四项保持 Own。目录检测使用各客户端的配置或数据标记，单独生成身份文件不构成安装证据。

## 验收

- 175/175 自动化测试通过；类型检查与前端语法检查通过。复制按钮改动后，界面相关测试与 i18n 测试再次通过。
- 隔离 HOME / Hub 的浏览器验证：四张卡片、手动模式说明、Grok Bot 导出绑定、复制成功反馈、Kimi 原生绑定及 AGENTS.md 路径、中英文显示均确认。
- 本机 3950 服务已重启，HTTP 200；认证 Snapshot 返回 23 个适配器，四个新增客户端都检测到安装痕迹，且均保持 Memory=Own。
- 未进行真实模型读取验收。Grok Bot/豆包仅完成手动导出兼容，不宣称自动加载。
