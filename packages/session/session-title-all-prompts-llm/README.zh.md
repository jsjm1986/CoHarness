---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-all-prompts-llm

[English](README.md) | 中文

可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结所有符合条件的用户消息。它注册 `all-prompts` 节奏，并在每条新用户提示词后启动新 revision，同时使用预置历史与子会话提示词。较新的 revision 会中止并取代旧工作；即使提供方忽略取消，也无法提交陈旧输出。

该插件拥有自身的系统指令、JSON 封装、当前标题锚点与输出解析，并要求自身的 `targetWords` 与 `targetCjkCharacters` 以及共享[执行控制项](../session-title-llm/README.zh.md#configuration)，均无默认值。同时省略 `provider` 与 `model` 时，会继承每个当前已记录主请求的确切路由；也可以同时设置二者，使标题生成使用独立路由。如果最终封装的聚合提示词超过 `maxInputBytes`，请求会失败而不是截断历史；自动使用时会发出警告并保留先前标题。

## 概述

`dsh-session-title-all-prompts-llm` 作为可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结所有符合条件的用户消息。它注册 `all-prompts` 节奏，并在每条新用户提示词后启动新修订，使用预置历史与子会话提示词。较新的修订会中止并取代旧工作，即使提供方忽略取消，也无法提交陈旧输出。该插件拥有自身的系统指令、JSON 封装、当前标题锚点与输出解析；它与 first-prompt 提供方仅共享 `dsh-session-title-llm` 的执行模块。本文优先介绍自动行为与配置；实现只是该执行器之上的一个小型提供方策略。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 全消息标题请求

#### 模型看到什么

标题模型会收到此提供方的标题指令，以及一个 JSON 数组，其中按日志顺序包含截至当前修订的所有符合条件用户消息和确切 seq。预置历史也包含在内。当 `request.currentTitle` 携带提供方生成的标题时，封装会将其锚定，使仍然贴切的既有标题可在重新生成中原样保留；回退与用户提供的标题从不被锚定。

#### Token 影响

每条符合条件的新提示词之后都可能发出一次辅助请求，每次请求受 `maxInputBytes` 与 `maxOutputTokens` 约束；显式刷新可能增加调用。它选择路由支持的最低推理强度；当路由没有可选强度时则不指定。主 agent（智能体）请求不会增加 token。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。每条提示词后，辅助输入都会增长或变化，因此提供方专用缓存复用会在第一个变化的 JSON token 处结束。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 输入溢出时保留先前标题；对于很长的会话，此提供方没有基于摘要继续生成摘要的机制或保留策略。
- 它平等对待所有符合条件的用户消息，不提供权重、过滤或手动标题优先级。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
