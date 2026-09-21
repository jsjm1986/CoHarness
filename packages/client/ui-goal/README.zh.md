# @deepseek-ai/dsh-client-ui-goal

[English](README.md) | 中文

Goal 界面插件（浏览器端部分）：`GoalBar` 条带是 `conversation.input.dock` composer 上下文堆栈中的第二张独立卡片（order 10，位于 Todo 之后、Queue 之前）。活值经 `useProjection('goal')` 到达——host 计算的全量值由历史尾页播种、由 `session/projection` 帧更新——因此本插件不持有领域 store、不设刷新链、不挂事件监听。slot 注入面只携带四个变更动词（edit / pause / resume / clear，经 `ctx.remote.goals` 调用——active 的 goal 提供暂停动作，paused 的提供恢复）；每个动词在调用时从会话当前投影值读取 CAS ref，并将 Remote 调用的拒绝错误内联呈现。由于 React 的 pending 渲染无法拦住同一帧内的点击，横条会同步为变更建立 single-flight 防护；清除成功后，会立即抑制该 goal id 对应的目标显示，直到权威的 null 投影追上。goal 的创建仍归 `/goal` host 命令；加载中、无 goal、已完成和已成功清除的 goal 一律不渲染。

该插件还会通过自有 Conversation Definition 投影每条持久 `/goal` `command/run`。它在通用命令结果 Node 之前构建一个 `command-input` Chat Node，并为该 Node 注册 keyed renderer；renderer 将其呈现为右对齐、使用 14px/22px 等宽字体的用户样式气泡，使用本地化分组名称 `Command input`／`命令输入`，且不含时间戳、复制或分支操作。可见的非命令 Node 会激活新 Chat；重新加载时会根据 run 重建该 Node，而仅包含 `command/done` 的历史窗口只保留通用结果行。该投影绝不会创建 `user/message` 或模型轮次。

`/client` 的导出接口包括插件本体（`apply`/`inject`）、`GoalBar`/`GoalDock` 组件与注入动词面类型。

## 概述

Web GUI 的 goal 界面同时显示持久 goal 状态及当前的进程本地激活状态，供用户编辑、暂停、恢复或清除 goal；被拒绝的变更所产生的错误会内联显示。它把持久的 `/goal` 运行显示为 `Command input` 气泡，让用户或模型发出的命令在重新加载后仍然可见。goal 创建仍不归本包。除 `minimal` 外，随附的 Web preset 都会向 agent（智能体）提供 `/goal`。

## 不变量

**运行时不变量：** 未发布配套入口。实时目标经由 `goal` session 投影到达，变更经由 `ctx.remote.goals` 进行；插件不拥有领域存储或刷新链。

## 模型体验

间接影响：条带路由 `goals/edit`、`goals/pause`、`goals/resume` 与 `goals/clear` 变更；宿主 GoalService 拥有这些变更排队的模型可见 goal 上下文消息。

#### KV Cache 影响

除非已排队的 goal 上下文获准，否则没有影响。获准的上下文会像其他消息一样扩展历史尾部；准入前被丢弃的插入项不会影响缓存。

## 已知限制与暂缓事项

- **只反映持久 phase**——投影省略进程本地 activation，因此条带无法区分 active-but-disarmed 与 armed 状态；resume 通过 RPC 重新置为 armed 状态。不存在 host 实时 activation 通道。
