---
description: "English | 中文"

kind: "package-library"
---

# @deepseek-ai/dsh-session-title-llm

[English](README.md) | 中文

模型支持的会话标题提供方的共享执行策略。它解析辅助路由，对提供方准备的输入、输出与端到端时长施加约束，使调用方取消在整个流式处理期间持续生效，记录模型可见的确切请求，并将流组装为内容块与最终结束原因。标题措辞、消息封装、长度目标、推理强度选择与输出解释都归各提供方所有。

此包是普通库，不是 Cordis 插件。提供方插件直接在 `ctx.sessionTitle` 上注册，并在其 `generate(request)` 内把 `{ system, input, messageSeqs, selectReasoningEffort }` 传给 `executeSessionTitleLlm()`，使各提供方之间的路由、边界、取消、请求记录与流组装行为不会漂移。

## 概述

`dsh-session-title-llm` 在一致的执行控制下执行一次已准备的辅助标题请求。每个提供方提供自己的系统指令、用户输入、来源消息归因、推理选择与输出解释。每个请求都携带 `currentTitle`，即服务为该调用捕获的最新已接纳标题快照（包括已接纳的回退标题）；提供方自行决定是否以及如何使用它。操作性错误、中止与不支持的结束原因会被拒绝；`stop`、`tool-calls` 与 `max-tokens` 则返回给提供方，由其自行决定接纳。


## 目录

- [路由与失败约定](#route-and-failure-contract)
- [配置](#configuration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="route-and-failure-contract"></a>
## 路由与失败约定


`provider` 和 `model` 覆盖项都是可选的，但必须同时作为非空字符串提供。如果没有这一对取值，该函数会使用当前会话已记录 `request/header` 中捕获的确切提供方／模型路由；因此，在任何路由出现前显式刷新时必须提供覆盖项。该函数在记录或分发前，依据 `maxInputBytes` 检查最终已准备用户输入的大小，而不是将其截断。消费流期间和流完成后都会重新检查超时与调用方取消，因此即使拦截器或适配器忽略 abort，也不能接受迟到的成功结果。标题请求独立于对话的上限使用 `maxOutputTokens`。其路由必须有已注册的适配器，`ctx.llm.prepareCall()` 才能在记录前解析请求。


路由与输入验证完成后，该函数会在模型分发前直接通过 `Session` 追加仅写入日志的 `session/title-llm-request` 事件。它包含标题提供方 id、确切来源 seq、路由、系统提示词、消息列表、输出 token 上限，以及提供方选择器返回时解析出的推理强度。持久化会立即观察到该记录；追加不需要标题专属标记、类型断言、结算队列或刷写。分发的请求封套会深度冻结，携带 `purpose: 'session-title'`，且有意不包含 dsh-agent-loop 的进程本地请求身份。拦截器会与记录保持一致，而循环专用重建观察者不会把它与对话请求头比较。DeepSeek 适配器会根据该用途禁用思考，使少量输出预算全部用于可见标题文本；其他适配器负责自身用途专用行为。后续模型失败会保留请求记录；从未成为可分发请求的验证失败不会创建记录。该事件始终位于派生模型历史之外。


<a id="configuration"></a>
## 配置

除成对的路由覆盖项外，每个执行字段都必填；库不提供默认值。每个提供方还会增加自己的标题长度目标设置，由该提供方的 README 说明。


| 键 | 约定 |
|---|---|
| `maxInputBytes` | 已准备用户输入的正整数 UTF-8 字节上限。 |
| `maxOutputTokens` | 辅助生成的正整数 token 上限。 |
| `timeoutMs` | 运行时定时器限制内的正数端到端时限。 |
| `provider`, `model` | 可选显式路由；二者同时提供或同时省略。 |


<a id="model-experience"></a>
## 模型体验

### 辅助标题请求

#### 模型看到什么

标题模型收到提供方所有的系统指令，以及一条包含提供方输入的用户消息。执行器原样记录并分发这些值而不重建；封装、长度目标与输出指令归各提供方所有，由 [first-prompt](../session-title-first-prompt-llm/README.zh.md) 与 [all-prompts](../session-title-all-prompts-llm/README.zh.md) 的 README 说明。


#### Token 影响

辅助请求根据提供方准备的输入大小与 `maxOutputTokens` 消耗 token。它与主 agent 请求相互独立，不会向 agent 历史增加标题文本或封装内容。执行器应用提供方选定的推理强度；当选择器返回 `undefined` 时使用路由的常规默认值，仍进行推理的模型会把部分 `maxOutputTokens` 花在推理上。主对话保留自身配置的思考模式。


#### KV Cache 影响

不会使主请求的 KV Cache 失效。辅助缓存复用由提供方决定：此执行器分发提供方的确切系统提示词与输入，因此复用取决于每个提供方如何封装连续修订。


<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- 执行器返回组装好的内容块与最终结束原因，不做接纳或拒绝；各已发布提供方的 README 负责其接纳策略。
- 它拒绝超过 `maxInputBytes` 的已准备输入，而不是将其截断。
- 执行器应用提供方返回的推理强度，自身从不选择；当选择器返回 `undefined` 时应用路由的常规默认值。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
