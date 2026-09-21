# feedback/：记录的人类反馈

[English](README.md) | 中文

反馈家族公开两份刻意分离的契约：写入权威 Session 日志的不可变评价，以及挂在单条 assistant 消息上的可编辑本地伴随记录（sidecar）反馈。两者都不会进入模型对话。

| 包 | 职责 | ctx 键 |
|---|---|---|
| `command-feedback/` | 与触发方式无关的 `feedback/record` 事件，以及面向用户的 `/feedback` 生产方 | 无 |
| `message-feedback/` | 绑定生命周期的逐消息评分／备注伴随记录，以及 Host `messageFeedback.list/put/delete` Remote 契约 | `messageFeedback` |

command feedback 评价仅写入日志：它绝不会进入模型上下文或派生历史。挂载后，[`dsh-session-telemetry-otel`](../session/session-telemetry-otel) 会观察 `feedback/record`，以释放待处理的遥测前缀，或在遥测已禁用时警告反馈将留在本地；采集本身与该策略相互独立。

message feedback 不是 Session 事件或投影。它只保留在 storage-domain 伴随记录中，不触发任何遥测交接。服务随附 Host Remote 契约；客户端 Remote 聚合挂载与 UI 消费方由各自边界负责，并保持延后。

[feedback 子系统页](../../docs/subsystems/feedback.zh.md)负责消息反馈类型、服务契约与 Web 消费方。


## 概述

feedback 组收集用户对 harness 工作成果的意见：用户可以提交一条关于整个会话的自由文本评价，也可以对单条 assistant 消息评分或加备注。两类反馈都不会到达模型——它们是关于输出的信号，绝不是输入。用户通过 `/feedback` 命令记录会话评价；产品界面通过 `messageFeedback` 服务读取和修改逐消息评分。两个包相互独立：会话评价与逐消息评分互不影响。本页概述该包组；具体包级约定以各包 README 和[反馈子系统页](../../docs/subsystems/feedback.zh.md)为准。
