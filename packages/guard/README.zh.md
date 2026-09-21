# guard/ — 循环卫生 guard 家族

[English](README.md) | 中文

行为 guard 插件监视 agent loop（智能体循环）中的无效模式，并强制执行单次调用预算。guard 是核心服务和扩展点的自包含消费方，而非可替换能力。

| 包 | 职责 | ctx key |
|---|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.zh.md) | 针对重复工具调用的建议性提醒 | 监听工具和 agent 事件 |
| [`timeout-policy/`](timeout-policy/README.zh.md) | 以部署策略形式设置单次工具调用截止时间 | 注册 `tools/execute` 监听器 |

提醒作为 `additionalContexts` 随 `tools/post-execute` 决策传递，并作为来源于插件的 `user/message` 事件追加记录（[工具](../../docs/subsystems/tools.zh.md)）；跨 `dsh-timeout`、能力终止与本策略层的超时拆分记录在[超时库 Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.zh.md)。


## 概述

`guard/` 组通过监视两种常见失败模式来保持 agent loop（智能体循环）高效。`repeat-tool-reminder` 会在模型重复完全相同的工具调用时提醒它改变方法或结束任务，让卡住的循环不再浪费时间和 token。`timeout-policy` 为声明了限时的工具调用设置时间上限，让挂起的调用向模型返回清晰的超时错误，而不是拖住整个会话。两者都在 `dsh` 基础组合包中默认启用；组合可以调优或移除它们。
