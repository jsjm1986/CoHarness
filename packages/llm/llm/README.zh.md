---
description: "面向用户与维护者的提供方无关模型调用服务说明：流式发起请求、注册提供方适配器或解析模型元数据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm

[English](README.md) | 中文

## 概述

使用 `@deepseek-ai/dsh-llm` 可通过已配置的提供方适配器流式调用模型、发现模型，并解析模型能力与调用默认值。调用方必须确保所有模型可见输入都可以从会话日志重建。Loop 构建的请求以深度冻结状态到达，因此扩展与适配器不能改写。每个流只尝试调用提供方一次：提供方特定的转换由对应适配器完成，可选包 `@deepseek-ai/dsh-llm-retry` 负责重跑失败的请求。流始终以终止结果结束，因此调用方可以一致地处理成功、失败与取消。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

`listModels` 描述目录驱动界面提供的模型。核心解析与流式调用仍可接受未列出的 ID。GUI 的模型选择与提交要求模型出现在目录中；供 GUI 使用的适配器必须实现 `listModels`，公布其可用模型。基类实现返回空列表，因此不向 GUI 提供模型。

任何调用模型提供方的组合——agent loop（智能体循环）、会话标题生成器、压缩（compaction）摘要器——都会通过本服务流式发起请求。与至少一个提供方适配器一起挂载它。`streamCloseTimeoutMs` 限制适配器迭代器清理时长，默认为 1,000 ms；提供方协议配置由适配器插件负责。

### 何时选择

当插件或组合需要调用模型时选择本包：它是进入提供方适配器的唯一受支持路径，并在 loop、会话日志与每个消费方之间保持同一套词汇。当需要提供方特定的协议行为（那属于 `dsh-llm-deepseek` 或 `dsh-llm-pi-ai` 之类的适配器）或重试执行（那属于 `dsh-llm-retry`）时，不要选择它。

### 最小组合

挂载服务与至少一个适配器，然后在每个请求中按名称选择提供方：

```yaml
- name: '@deepseek-ai/dsh-llm'
- name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
```

流会返回 token 级分片，并始终以一个终止 `finish` 分片结束。`BlockAssembler` 把分片组装为内容块与消息；`AssistantStreamAccumulator` 在紧凑表示中保留其精确时间戳与 token 边界，loop 再把它嵌入一个持久 attempt settlement：

```text
for await (const chunk of ctx.llm.stream({
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
})) {
  // chunks: block-start, text-delta, ..., usage, finish
}
```

挂载成功后，`ctx.llm.listProviders()` 会按注册顺序报告已注册路由。

`GenerateOptions.messages` 接受持久 `Message` 值和仅供请求使用的 `RequestUserInput` 值。仅供请求使用的输入包含 user-role 内容，不含 `id` 或 `source`；Session 写入和 Agent 投递仍然要求持久消息。调用方必须在流结束前保持辅助输入不变。会记录完整请求的调用方（例如会话标题生成）必须使用持久消息。

### 你可以做什么

- **流式发起一次模型调用**——`ctx.llm.stream(options)` 为任何已注册提供方与模型产出原始分片（token 级增量）；消费方用 `BlockAssembler` 组装。
- **注册提供方适配器**——一个适配器拥有一个或多个提供方路由，其注册会捕获该路由的重试策略；重复注册同一路由会以 `DUPLICATE_ADAPTER` 失败。
- **通过配置暴露并激活提供方**——适配器声明可配置提供方路由与 settings namespace，配置界面因此可以激活休眠提供方并编辑连接信息，无需重启。`LlmConfigurableProvider.error` 报告供修复的配置诊断；未受影响的模型仍可提供服务。
- **发现与解析模型**——列出适配器公布的模型、询问端点它提供哪些模型（候选携带可选的 `inputModalities`；缺省表示未知），并解析某个精确模型的上下文窗口、输出默认值、推理（reasoning）强度、输入模态与系统提示词更新模式：当模型把任意位置最新的 `system` 消息读作有效系统提示词时，`LlmResolvedModelInfo.systemPromptUpdate` 为 `'in-history'`；只读取开头 system 消息时该字段缺失；`normalizeModelInfo` 以 `INVALID_MODEL_INFO` 拒绝任何其他值。
- **校验调用配置**——显式或配置的推理强度会在任何提供方 I/O 之前对照精确模型校验；请求省略输出上限时，会填入适配器配置的输出上限。
- **不展开即读取内嵌 Assistant 流**——`assistantStreamFirstTokenTime`（首 token）、`assistantStreamHasVisibleContent`（任一可见内容）与 `assistantStreamHasVisibleText`（任一可见文本）通过可提前退出的扫描直接从紧凑记录得出结果；`lastAssistantStreamChunk` 反向扫描到某一类型的最后一个原始 chunk，`assistantStreamChunks` 与 `joinAssistantStreamText` 扫描整个流，`assembleAssistantStream` 向 `BlockAssembler` 每个 run 喂一段拼接 delta，blocks／usage／replayState 与逐成员展开相同。`runFirstTokenTime` 与 `runFirstVisibleTime` 对单个打包 run 做提前退出扫描，`isTokenDelta`、`isVisibleChunk` 与 `chunkHasVisibleText` 定义单个 chunk 的 token 与可见性规则。`expandAssistantStream` 仍是持久边界读取记录的校验路径；它不被记忆化，因为保留的展开在事件生命周期内约花费紧凑流的十倍内存。

端点发现在配置的同源地址内跟随重定向，并保留协议及部署请求头。主机、协议或端口变化以及 URL 内凭据都会在下一次请求前被拒绝。同源重定向保留 Fetch 的跳转次数限制；被丢弃的响应会取消读取。请把 Provider 的 `baseURL` 配置为预期的最终地址，而不是依赖跨源重定向。参见[升级指南](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/model-discovery-redirects/guide.zh.md)。

### 失败与恢复

每个流都恰好以一个终止 `finish` 分片结束：失败为 `{ kind: 'error', failure }`，取消为 `{ kind: 'aborted', failure }`。失败携带稳定 code，如 `NO_ADAPTER`、`MISSING_CREDENTIAL`、`AUTH`、`RATE_LIMIT` 与 `CONTEXT_WINDOW_EXCEEDED`；消费方依据 code 路由，绝不解析消息文本。`QUOTA` 表示提供方中立的额度耗尽，`ACCOUNT_QUOTA` 专用于当前产品能够充值的第一方账号余额不足。点名未注册提供方的请求会以 `NO_ADAPTER` 失败，格式错误的凭据会以 `INVALID_CREDENTIAL` 失败，而不是表现为不透明的 fetch 错误。本服务从不自行重跑请求：重试是 `dsh-llm-retry` 在 agent 失败步骤扩展点上的职责。

本地 `ResourceAdmissionError` 的原因保留不同的终止 code：`unavailable` 对应 `RESOURCE_BUDGET_UNAVAILABLE`，`cancelled` 对应携带 `ABORTED` 的 aborted 结束，`expired` 对应 `RESOURCE_ADMISSION_EXPIRED`，`refused` 对应 `RESOURCE_ADMISSION_REFUSED`。这些类别不添加提供方 HTTP 状态，也不表示上游限流或自动重试。已校验的详细失败事实优先；任意 SDK 的 `reason` 字段不会获得资源错误 code。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释服务背后的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本服务基于一项职责分离原则：**逻辑约定是提供方无关的，适配器拥有协议。** 它一次性地定义规范消息、内容块与流式分片词汇，每个提供方适配器只把自己的协议格式翻译为该词汇。注册表是拓扑的拥有者——适配器路由、可配置提供方条目与发现 offer 都在这里注册，并随其 fiber 一起 dispose（资源释放）——而 agent loop 的请求始终是会话日志的纯函数：loop 构建的请求以深度冻结状态到达，因此监听器与适配器只能读取，绝不能改写。

主请求归属由派发请求的 `LlmRuntime` 持有。循环通过 `ctx.llm.markAgentLoopRequest(request)` 记录精确的冻结对象；`ctx.llm.isAgentLoopRequest(request)` 仅在该服务存活期间识别它。副本、其他服务的对象及服务撤回后保留的请求均不带此标记。通过已退役服务标记请求会抛出 `MODEL_REQUEST_ORIGIN_UNAVAILABLE`。全局 LLM waterfall 监听器通过发出事件的 `this: LlmRuntime` 接收者检查归属，包括隔离的提供方。此标记区分循环工作与辅助调用，不授予执行或计费权限。参见[归属决策](../../../.agents/notes/implemented/bug-fix/2026-11-02-scoped-model-request-origin.zh.md)。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `LlmRuntime` 服务：适配器注册表、可配置提供方目录、模型发现、调用准备与流式边界 |
| [`src/operations.ts`](src/operations.ts) | 原生操作参数、请求、结果与适配器工厂的类型 |
| [`src/operation-call.ts`](src/operation-call.ts) | 通过普通模型中间件执行一次性原生操作并报告用量 |
| [`src/model-policy.ts`](src/model-policy.ts) | 跨异步等待保留策略所有者并执行路由授权 |
| [`src/resource-owner.ts`](src/resource-owner.ts) | 跨预备、排队及凭据等待的模型准入归属 |
| [`src/types.ts`](src/types.ts) | `StreamChunk` 协议、内容块映射、结束原因与共享词汇 |
| [`src/message.ts`](src/message.ts) | 投递、历史与请求共享的不可变消息构造函数 |
| [`src/assembler.ts`](src/assembler.ts) | `BlockAssembler`：分片到块的增量组装 |
| [`src/assistant-stream.ts`](src/assistant-stream.ts) | 带时间信息的紧凑 Assistant 流累积、严格校验、精确展开与记录级读取器 |
| [`src/call-config.ts`](src/call-config.ts) | 调用配置校验、适配器默认值填入与请求冻结 |
| [`src/retry-policy.ts`](src/retry-policy.ts) | 提供方自有重试策略解析（normal 与 always 模式） |
| [`src/error.ts`](src/error.ts) | `HarnessError`/`LlmError` 分类体系与提供方无关失败 code |
| [`src/content.ts`](src/content.ts) | 共享文件与图片辅助函数：内容遍历、文件投影、图片卸载计数与已卸载图片投影 |
| [`src/api-key.ts`](src/api-key.ts) | 每个适配器共享的凭据格式校验 |
| [`src/adapter-failure.ts`](src/adapter-failure.ts) | 把失败归一化为终止 finish 分片 |
| [`src/discovery.ts`](src/discovery.ts) | 面向 OpenAI 兼容与 Anthropic Messages 端点的提供方中立 HTTP 模型发现 |
| [`src/text-thinking-guard.ts`](src/text-thinking-guard.ts) | 失败关闭防护：拦截普通文本块中序列化的带标签推理前缀 |
| [`src/never.ts`](src/never.ts) | 面向封闭联合类型的 `assertNever` 穷尽性断言 |

### 主流程

实际 adapter 派发先等待模型许可；回放或自行提供流的中间件不消耗许可。`llm/pre-dispatch` waterfall 在准入后、调用已绑定代次的 adapter 前，重新检查当前授权。`resourceOrigin` 选择执行、交互或基础设施归属，并在交给 adapter 前移除。取消合并调用者与许可信号。正常完成、拒绝或成功的终结迭代器返回确认清理；缺失、失败、超时或非终结清理保留不确定占用。

物理模型流在中间件开始前保留其资源提供者及受管要求。预备、准入和最终请求派发均要求同一提供者仍然有效；撤销、替换或新增必需要求后缺少提供者时，以 `RESOURCE_BUDGET_UNAVAILABLE` 失败，不发送请求。已经取得的许可归还原提供者。恢复准入后使用新的流重试。编排轮次不预留模型容量；其嵌套模型请求分别捕获当前提供者。

`LlmAdapter.callKind` 默认为 `model`。若适配器的轮次驱动另外受管的模型请求，注册时捕获其 `orchestration` 类型。外层调用使用 `llm/orchestration`，保留必需的策略所有者检查及预备代次，不消耗模型许可，也不进入模型路由授权或模型计量中间件。每个嵌套请求必须使用普通或委派模型操作，分别完成授权、准入及实际用量计量。原生操作工厂拒绝编排路由；可变中间件不能跨执行类型重定向调用。

`prepareOperation()` 预备由 `LlmOperationMap` 声明、由所捕获 `PreparedAdapterCall.operations` 工厂实现的原生模型操作。其冻结的 `request` 包含 Consumer 在 `run()` 前记录的精确无密钥输入。执行经过 `llm/stream`、模型准入和 `llm/pre-dispatch`；中间件从 `GenerateOptions.operation` 读取输入，对话消息为空。操作在终止结果前报告实际累计用量，包括后续失败之前已经获得的用量。中间件若没有执行出结果就结束，会拒绝调用，不会构造虚假的结果。配置不匹配、替换输入或重复执行以 `INVALID_PREPARED_CALL` 失败；捕获的代次缺少工厂时以 `MODEL_OPERATION_UNSUPPORTED` 失败。

`prepareDelegatedOperation()` 经过 `llm/delegated-stream` 使用相同的预备适配器、逐请求资源和授权。Consumer 在执行前记录并持久化其精确请求。`native-stream` 操作携带无密钥的协议／请求体和支持背压的事件写入函数；适配器负责端点选择、认证、有界解析与实际用量。对话重放不会消费这些请求。 原生操作在异步解析凭据后调用观察者的一次性 `dispatch()`，它在提供方 I/O 前重新检查实时授权。

普通适配器流和预备流会收到 `dispatchRequest` 回调。适配器在异步凭据、附件和请求扩展准备完成后调用它，提供方重试时再次调用。该回调保留模型策略，并在启动每个请求前重新检查授权。不携带此回调的直接适配器调用不使用运行时授权。

预备流的第二个参数可接收 `PreparedLlmCallGuard`。异步 `authorize(signal?)` 在准入后、每次提供方请求前检查 Consumer 的资格，并接收调用者与资源额度的合并取消信号；同步 `assertCurrent()` 在授权完成后、进入适配器与每次请求之前检查所保留的所有者，重试也执行检查。两个回调均不进入 `GenerateOptions` 或提供方输入。

模型流在运行中间件前捕获策略提供方，跨模型预备和资源准入保留它。撤下或替换所有者以 `MODEL_POLICY_UNAVAILABLE` 失败；受管运行时也拒绝缺失的策略提供方。在异步派发防护之后执行所保留策略的路由决定。 `llm/authorize` 在分派前串行执行全部授权所有者，即使 `llm/pre-dispatch` 的瀑布监听器停止委托。策略身份比较 Cordis 底层提供方，同时保留捕获的跟踪上下文。`llm/delegated-stream` 以父级执行身份计量外部子运行时流，不消费父会话的重放游标。

请求会对照其精确模型的能力校验，包括上下文窗口、输出默认值、推理强度、输入模态与 `systemPromptUpdate` 模式，并填入任何适配器配置的默认值。运行时保留已冻结输入的冻结状态；手动构建请求的调用方负责保证输入不可变。`prepareCall()` 把这些事实、分离的上下文与重试策略绑定到执行最终分发的精确适配器代次，因此 HMR（热模块替换）或动态设置无法把一个代次的图片能力与另一代次的端点混用。支持图片的适配器把持久引用投影为路由专用请求版本；`resolveImageAttachmentAccess()` 会单独把附件提供方的可选宿主对象映射进当前工具执行世界，而不改变请求图片或其 `variantId`。纯文本路由接收确定性的逐图片占位符，包括 tool-role 结果图片，而不会改写仅追加会话历史。持久 `FileBlock` 引用永远不会到达任何适配器：请求组装把每个引用（包括 tool-role 结果中的出现）替换为确定性句柄文本，指出文件与其只读保存路径，路径经由挂载的附件与文件系统提供方解析。`ctx.llm.fileRequestText(ref)` 向请求计量公开相同的同步投影。派生后带有 `offloaded: true` 的图片出现位置，经 `projectOffloadedImages()` 以占位文本到达每条路由。支持图片的路由在保留的出现位置按精确字节超过其 `LlmImageRequestBudget` 时，以 `IMAGE_OFFLOAD_REQUIRED` 失败并说明还需省略多少最老的出现位置（`requiredImageOffload()`），绝不发送未记录的投影；`dsh-compaction-image-offload` 用一条 `image/offload` 事件记录所选位置并重试。对视觉 token 收费的适配器声明按路由的 `imageRequestPricing`，`ctx.llm.imageRequestPricing(provider, model)` 为 token meter 同步解析它。分发经过 `llm/stream` waterfall（瀑布式事件），随后分片以 token 级增量返回，每个适配器结果都以唯一一个终止 `finish` 分片到达消费方。`llm/stream` waterfall 由一层提供方中立的失败关闭防护包裹：普通文本块里带标签或不完整的 `<thinking>`/`<analysis>`/`<think>` 前缀会被扣留，并在任何缓冲文本到达消费方之前以 `UNSAFE_MODEL_OUTPUT` 上报。

文件检测在每次请求时读取当前内容，包括 tool-role 结果内容，不缓存消息身份或冻结状态。[文件扫描决策](../../../.agents/notes/implemented/simplification/2026-09-07-file-content-scan.zh.md)记录了实测遍历成本。

### 不变式

- **模型可见 ⟺ 已记录**——调用方必须确保每个提供方请求中的模型可见输入都可以从会话日志重建；loop 构建的请求以深度冻结状态到达，不可改写。
- **回放状态只在同一适配器内流动**——仅当同一适配器实例同时拥有历史路由与目标路由时，assistant 回放状态才会随行；否则在分发前被丢弃。
- **已准备调用是一次性的**——已准备调用只能分发一次，且其调用配置字段必须与准备好的配置一致。
- **图片投影遵循捕获的路由**——只有支持图片的模型会把持久 `ImageBlock` 引用转换为路由专用请求版本；纯文本模型接收稳定占位符。
- **文件投影无条件进行**——没有任何提供方会收到文件字节；每条路由对每个 `FileBlock` 都得到一行确定性句柄文本，模型在需要时用文件工具读取保存的副本。
- **协议顺序**——`usage` 先于 `finish`，工具参数保持原始 JSON 字符串，终止 `finish` 之后不再有任何内容。
- **注册表变更具有原子性**——路由与目录注册会在任何变动前整体校验候选集合，因此被拒绝的变更会让此前状态继续服务。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享类型逐步进入具体适配器、重试执行器与计量服务。

- [LLM（大语言模型）流式子系统](../../../docs/subsystems/llm-streaming.zh.md)——消息与块类型、紧凑的 Assistant 流记录、`StreamChunk` 协议与适配器约定。
- [llm-deepseek 适配器](../llm-deepseek/README.zh.md)——DeepSeek Messages 直连实现。
- [llm-pi-ai 适配器](../llm-pi-ai/README.zh.md)——基于 pi-ai 的多提供方实现。
- [llm-retry](../llm-retry/README.zh.md)——重跑失败模型请求的重试执行器。
- [Token 计量](../token-meter/README.zh.md)——具备回放感知的请求与上下文压力测量。
- [孪生 LLM 适配器](../../../.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.zh.md)——为什么 DeepSeek 路由交付两个结构不同的适配器。
- [LLM 流终止失败](../../../.agents/notes/implemented/architecture/2026-07-29-terminal-llm-stream-failures.zh.md)——模型请求结果与插件失败之间的服务边界。

-----

## 模型体验

没有直接影响，因为 LLM 服务不添加内容；适配器决定何时添加本包导出的共享图片描述符与逐图片占位符。

#### KV Cache 影响

推理强度的具体化会保留已组装请求前缀。图片身份与请求预览文本是确定性的，可选执行世界路径则按请求解析；路径变化或一次省略决策可能从该图片起阻止复用。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明本服务在哪里停止、由其他包或未来工作接续。它们是当前包约束，不是任务积压。

- **本服务不提供重试执行、缓存或速率限制**——提供方注册会存储重试策略，但一次流仍是一次提供方尝试；`@deepseek-ai/dsh-llm-retry` 在持久 agent 步骤边界上执行该策略。
- **`GenerateOptions` 采样只包含 `temperature`／`maxTokens`／`stop`**——没有 `tool_choice`、`top_p` 或 penalty 字段；有产生方落地时词汇才会增长（见[已删除惰性旋钮](../../../.agents/notes/archived/simplification/2026-07-04-drop-inert-request-knobs.md)）。
- **变体通常要求实际产生方**——`prefill`、逐工具 `strict`、内容块 `cache` 提示和 `agent` 消息来源变体都没有产生方（见 [Agent Note](../../../.agents/notes/archived/simplification/2026-07-04-prune-producerless-vocabulary-variants.md)）。
- **`BlockAssembler` 只处理核心块类型**——插件添加块类型的流若从未由 `block-end` 关闭，`blocks()` 会抛出异常。
- **`GenerateOptions.sessionId` 是本地声明的品牌类型**——导入 dsh-session 的 `SessionId` 会产生依赖循环。
- **工具更新需要会话历史** — `GenerateOptions.tools` 包含当前有效定义。`toolHistory` 提供 `Session.toolHistory()` 派生的初始声明及已解析历史定义的添加记录。适配器分发时，`projectToolUpdates` 构造延迟声明，并在 `in-history` 模式保留已移除定义；`addition-only` 省略已移除定义和移除消息。不支持更新的路由接收有效工具，不携带 developer 消息或 `deferLoading`。缺少历史或请求前缀遗漏已记录更新时，回退为当前声明且不发送 developer 消息。 显式延迟加载的初始工具在首个保留的添加块出现前保持延迟状态；声明延迟加载工具不会使其激活。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是不具权威性的工作上下文：开放问题与尚未决定的探索方向。已交付的行为与既定理由以上文、包代码和相关 Agent Note 为准。

#### 开放事项

- `GenerateOptions.sessionId` 是本地声明的品牌类型，因为导入 dsh-session 的 `SessionId` 会造成依赖循环；未来拥有 id 的包可以消除该权宜之计。
- 推理强度标识符是由适配器定义的不透明字符串，只对照各适配器公布集合解析；跨适配器共享强度词汇尚未决定。
- `llm/adapters-updated` 事件按设计不携带载荷；消费方重新读取注册表，而不是在事件中接收新拓扑。

</details>

<a id="model-experience"></a>
