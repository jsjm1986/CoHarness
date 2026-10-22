---
description: "在 Web 输入框上方查看、编辑、暂停、恢复和清除会话目标。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-goal

[English](README.md) | 中文

## 概述

在 Web 输入框上方查看会话目标，并编辑、暂停、恢复或清除它。目标栏区分正在运行的活动目标与需要重新激活的目标，并内联显示被拒绝的变更。重新加载后，已记录的目标命令仍然可见。通过 Host 的 `/goal` 命令创建目标。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本插件与会话输入框和 Host 目标服务配合使用。标准 Web 组合提供其浏览器依赖；本包没有配置字段。

目标栏位于 Todo 之后、Queue 之前。加载中、无目标、已完成及已成功清除的目标均不渲染。已激活的活动目标提供暂停操作；未激活的活动目标与已暂停目标提供恢复操作。活动目标的激活状态未知时，暂停仍可用，因为 Host 可以凭当前目标修订暂停任一激活状态下的目标。

编辑使用可增长文本框：Enter 保存，Shift+Enter 换行，Escape 取消。同一时刻只执行一个变更。被拒绝的变更内联显示；清除成功后立即隐藏该目标，等待持久投影更新。

已记录的 `/goal` 命令显示为右对齐的 `命令输入` 气泡，不含时间戳、复制或分支操作。命令 token 使用引用样式，目标正文保留普通文本样式。重放这些条目不会再次提交用户消息，也不会启动模型轮次。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Session 投影提供持久目标状态。私有可观察源通过 Remote 读取和事件提供进程内激活状态，仅在目标栏被观察时订阅。挂载、投影变化、连接重置和运行状态变化都会触发读取；更新的事件或目标修订会使较早的读取失效。连接重置或恢复观察时会清除缓存的激活状态，直到收到当前读取结果或事件。

变更回调在调用时读取当前 CAS ref。同步变更保护覆盖 React 渲染 pending 状态之前的点击。目标命令的 Conversation Definition 根据持久运行记录重建面向用户的命令条目；仅包含完成数据的历史窗口保留通用结果行。

| 源码 | 职责 |
|---|---|
| [index.ts](src/client/index.ts) | Slot 贡献、Remote 回调和框架绑定的激活状态源。 |
| [activation-source.ts](src/client/activation-source.ts) | 读取排序、事件更新和订阅生命周期。 |
| [GoalBar.tsx](src/client/GoalBar.tsx) | 目标操作与内联编辑。 |
| [goal-command-input.ts](src/client/goal-command-input.ts) | 持久命令的展示。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [会话界面](../ui-conversation/README.zh.md)——输入框与命令条目。
- [目标服务](../../goal/goal/README.zh.md)——阶段、激活状态和修订校验。
- [目标参考](../../../docs/subsystems/goal.zh.md)——共享类型与 Remote 操作。

-----

<a id="model-experience"></a>
## 模型体验

间接影响：条带路由 `goals/edit`、`goals/pause`、`goals/resume` 与 `goals/clear` 变更；宿主 GoalService 拥有这些变更排队的模型可见 goal 上下文消息。

#### KV Cache 影响

除非已排队的 goal 上下文获准，否则没有影响。获准的上下文会像其他消息一样扩展历史尾部；准入前被丢弃的插入项不会影响缓存。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

激活状态的确认依赖存活的 Host。

- 首次或重置后的读取失败时，激活状态保持未知。暂停仍可用；恢复要求目标已暂停，或已确认其处于未激活状态。后续事件或成功读取会提供当前激活状态。
- 同一连接与目标修订内的普通刷新若读取失败，会保留最后已知的激活状态。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
