---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-first-prompt-llm

[English](README.md) | 中文

可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结第一条符合条件的用户消息。它注册 `first-prompt` 节奏，只在全新非 fork 会话首次创建回退时自动运行，并将结果归因于该消息的确切 seq。自动失败会保留回退，之后只能通过 `ctx.sessionTitle.refresh()` 重试。

该插件拥有自身的系统指令、JSON 封装与输出解析，并要求自身的 `targetWords` 与 `targetCjkCharacters` 以及共享[执行控制项](../session-title-llm/README.zh.md#configuration)，均无默认值。同时省略 `provider` 与 `model` 时，会继承当前已记录主请求的确切路由；也可以同时设置二者，使标题生成使用独立路由。

## 概述

`dsh-session-title-first-prompt-llm` 作为可选的 `ctx.sessionTitle` 提供方，通过 `ctx.llm` 总结第一条符合条件的用户消息。它注册 `first-prompt` 节奏，只在全新非 fork 会话首次创建回退时自动运行，并把结果归因于该消息的确切 seq。自动失败会保留回退，之后只能通过 `ctx.sessionTitle.refresh()` 重试。该插件拥有自身的系统指令、JSON 封装与输出解析；它与 all-prompts 提供方仅共享 `dsh-session-title-llm` 的执行模块。自动行为与配置优先；实现是该执行器之上的一个小型提供方策略。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 首消息标题请求

#### 模型看到什么

标题模型会收到此提供方的标题指令，以及一个只包含第一条符合条件用户消息的 JSON 数组；它永远不会收到 `currentTitle`。后续提示词与继承的 fork 历史不会触发再次自动调用。

#### Token 影响

全新会话最多自动发出一次辅助请求，并受 `maxInputBytes` 与 `maxOutputTokens` 约束；显式刷新可能发出额外调用。它选择路由支持的最低推理强度；当路由没有可选强度时则不指定。主 agent 请求不会增加 token。

#### KV Cache 影响

不会使主请求的 KV Cache 失效。辅助请求使用已配置或已记录路由，其缓存行为由提供方决定。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 对于长期会话，第一条消息可能不再具有代表性；如果后续提示词应触发重新生成标题，请使用全消息提供方。
- fork 会保留继承的标题，绝不会自动运行此提供方，即使其预置的首消息来自父会话。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
