# dsh-session

[English](README.md) | 中文

事件溯源的会话日志和内存存储。`Session` 是 agent（智能体）全部交互历史的仅追加真源，LLM（大语言模型）消息历史由它*派生*。原始日志之上维护一个 **surface** 层（产生消息事件的有序投影），以便高效派生和压缩（compaction）。

可选配套入口 `@deepseek-ai/dsh-session/invariant` 将此包的关系轨迹检查注册到 `ctx.invariants`：序号单调递增、轮次／步骤闭合，以及同一步骤内的工具调用／结果配对。加载或重新加载时，它会回放现有会话；存储校验、快照、冻结、被引用的源事件校验和 surface 准入仍始终由根会话包负责。

## 概述

`dsh-session` 在仅追加的会话日志中记录每个模型可见事实，并从该记录派生模型历史。消费方可以检查、回放、fork 和刷新会话，同时保留历史事件；压缩（compaction）会在活跃对话中隐藏被取代的条目，但不会删除它们。除非添加持久化后端，否则会话仅保留在内存中；持久性检查点会等待配置的后端。agent 需要可重建的会话记录时请选择本包；它本身不调用模型。

## 服务：`SessionStore`（ctx 键：`sessions`）

创建并持有事件溯源的 `Session` 实例。这里有意不实现持久化：插件订阅 `session/event`，在 `session/flush` 时刷新，并可镜像成对的 `session/created`／`session/disposed` 生命周期。

### 消息投影

`ctx.sessions.registerMessageProjection(definition)` 为插件事件注册由 fiber 持有的纯解释器。在其 `SessionEventMap` 声明上标记 `@messageProjection`；持久化目录生成器记录必需的解释器，并拒绝同时带有 surface 操作的声明。创建、恢复和 fork 共用这些定义。解释器先校验完整决策，再返回不可变消息副本；被拒绝的决策不追加事件。卸载已使用的定义后，后续派生和追加会失败，不会复用陈旧内容。脱离运行时的重建须向 `Session.create()` 或 `foldSurface()` 提供定义，并将折叠结果的 `projectedMessages` 传给 `deriveEventMessage()`。

投影事件保留原始持久消息与序号身份。`surface.contentGeneration` 在位置替换或内容变化时使派生消息缓存失效；`replaceGeneration` 仅统计位置替换。此机制不增加事件格式版本，也不改写已提交代次。由 provider 持有的图片事件仍是独立消费者。

### 公共 API

- `ctx.sessions.create(id?, { seed?, meta?, inheritedEventCount? }?)` 校验持久种子／头部数据并生成脱离副本，补齐版本和 id，在未提供 `createdAt` 时使用当前时间，发布会话并将其绑定到调用方 fiber。带种子的 header（`meta.isSeeded: true`）必须同时提供 `seed` 与精确的 `inheritedEventCount`，因为构造种子可能在继承前缀之后还包含子级自有的初始化事件；无种子的 header 拒绝非零切点。持久化重建会提供原始的 `createdAt`、谱系与 `delegationDepth`。
- `ctx.sessions.flush(session)` 通过会话捕获的作用域分发一个需等待完成的并行持久性检查点。每个监听器都会启动；调用会等待全部结算后才报告失败。未发布、已脱离和陈旧的对象会被拒绝。
- `ctx.sessions.fork(source, boundary?, childSessionId?): Session`：解析实时会话对象或 id，选取截至 `boundary` 事件序号（含该事件）的种子（默认为当前最后一个事件），要求所选前缀结束时没有开放轮次，再创建带谱系元数据的实时子会话。
- `ctx.sessions.get(id: SessionId): Session | undefined`
- `ctx.sessions.list(): Session[]`

#### 高级：有序清理生命周期原语

仅在清理必须与另一项资源排序时使用拆分生命周期：

- `prepare(id?, options?)` 校验并构造，但不发布。
- `enter(session)` 执行冲突检查，在不通知的情况下发布，并返回一个绑定到该条目的幂等脱离函数。允许并发准备相同 id，但只有一个条目能够成功进入；陈旧的脱离函数无法移除其替代项。
- `announce(session)` 发出唯一一次创建边，并拒绝重复或重入通知。该次分发期间请求的脱离操作会延后，之后再发出成对的释放边；未通知的条目不会发出任何生命周期边。

插件用 `@messageProjection` 声明修改内容的事件，并通过 `ctx.sessions.registerMessageProjection()` 注册纯处理器。Session 在接受事件前调用处理器，并缓存其不可变消息更新。缺少处理器时拒绝追加和恢复，卸载已经使用的处理器后也会拒绝读取缓存。独立构造函数和 `foldSurface(events, projections)` 必须显式接收处理器。重建函数将折叠结果的 `projectedMessages` 传给 `deriveEventMessage()`，实时实例方法自动应用相同的投影。[会话消息投影](../../../.agents/notes/implemented/architecture/2026-09-18-session-message-projections.zh.md)说明职责划分和离线装配。

追加、seed/restore 与事件 adoption/snapshot 会拒绝任何 `header.system` 及恰好为空的可选请求头字段（`tools: []`、`adapterDefaults: {}`），而不规范化输入。工具结果的 `data.error` 仅在 `message.content[0].isError === true` 时允许存在；失败标识仍是可选的。被拒绝的追加不会改变日志、派生状态或事件流。Adoption 校验事件局部元数据，但不校验所引用的历史或替换端点是否属于 surface。

`system/message` 承载渲染后的系统提示词：第一条是 surface 第 0 号节点，准入依据已准备调用的能力，不具备能力的路由将非空渲染文本归并到首个系统节点，延续中的 `in-history` 序列则在缓存历史之后追加；空系统节点不投影为消息，因此清除提示词必须为所有生效的系统节点记录空内容替换，而非仅替换最新节点；当第 0 号节点是 `system/message` 时，surface 折叠拒绝覆盖它的替换，除非替换事件本身是恰好覆盖该节点的 `system/message`，而后续系统节点不受保护，压缩范围可以遮蔽它们（决策：system prompt as surface node）。

`dsh-agent-loop` 使用这一拆分，以保证循环的最终刷新先于会话脱离；详见[所有权 Agent Note](../../../.agents/notes/implemented/architecture/2026-06-18-agent-lifecycle-and-ownership-contracts.zh.md)。

### 实时服务事件

会话存储会将已通知的创建与释放配对，在提交后发布追加通知并逐个监听器收容失败，同时提供受等待的持久性检查点。确切签名和作用域行为见 [session.md](../../../docs/subsystems/session.zh.md#cordis-surface) 的生成区块；载荷见[持久化目录](../../../docs/persistence-catalog.zh.md)。

### 类：`Session`

普通类（不是 Cordis 服务）。活跃会话通过 `ctx.sessions.create()` 创建，脱离态的回放或检查会话通过 `Session.create()` 创建；脱离态工厂不会发布生命周期事件，也不会将会话绑定到 fiber。

- `session.append(type, data, opts?)` 会为持久数据和 surface 元数据制作快照并冻结它们，构造事件的 `SessionSeq`，校验规范化载荷字段（`validateSessionEventData`：`request/header` 省略 `header.system` 与空的 `tools`/`adapterDefaults`，携带 `error` 的 `tool/result` 要求 `content[0].isError`）、标记形态、被引用的源事件序号、替换覆盖完整性，以及仅修改内容的单个 `tool/result` 重写，随后同步提交，再在彼此独立的失败收容下通知观察者。对已挂接会话的重入追加会被拒绝，运行时检查也覆盖扩宽后的联合类型和已加载日志。
- `session.deriveMessages()` 对每个新的 surface 条目只做一次增量投影，并返回一个新数组，其中包含这些条目存储的完整、带标识且冻结的消息。assistant 消息的模型来源会保留生成该消息的提供方和模型，以及适配器私有回放状态。surface 重写会重建投影；不存在原始日志回退。
- `session.deriveEventMessage(event)` 是重建和请求检查使用的规范逐事件投影。
- `session.surface` 暴露只读 `SessionSurface` 视图，由会话唯一的增量 surface 管理器所有；每次提交重写，`replaceGeneration` 都会变化。
- `session.seq` 读取当前日志长度（`SessionLogOffset`）而不物化数组。`session.eventAt(seq)` 按 `SessionSeq` 读取一条已接受、深冻结的事件，`session.snapshotEvents(fromSeq?, toSeqExclusive?)` 物化一段半开区间的冻结稳定快照（完整的当前快照会缓存到下一次追加）。`eventAt()`、`snapshotEvents()` 与 `ownEvents()` 已弃用：现有逻辑可以暂不迁移，但禁止新增生产调用；仓库测试文件可在限定范围的 lint 豁免下使用这三个读取方法。只需要长度的调用方使用 `seq`。
- `session.inheritedEventCount` 保留经校验的精确 fork 切点；已弃用的 `session.ownEvents()` 返回该切点及其后的事件，`session.isOwnSeq(seq)` 只接受已存在的子级自有位置。`session.header.isSeeded` 只报告是否存在 fork 历史，不暴露位置整数。
- `session.events` 是覆盖在缓存完整快照之上的 `@deprecated` 兼容 getter，为树外插件保留；树内代码通过 `snapshotEvents()`、`eventAt()` 或 `seq` 读取。
- 会话日志位置使用两种数字品牌类型。`SessionSeq` 标识一条已存在的事件或含端点的水位；`SessionLogOffset` 标识间隙、前缀长度或读取边界，可以等于事件总数。`SessionSeqCursor` 额外允许 `-1` 表示“尚无事件”，`OptionalSessionSeq` 则在缺失本身是数据时使用 `null`。构造函数校验非负安全整数，品牌在运行时消失，因此持久化 JSON 与线上值仍是普通数字。
- `session.id`：只读类型化身份。
- `session.header: SessionHeader`：脱离、深冻结的创建元数据（`version`、`id`、`createdAt`，以及可选的 `cwd`／`parentSession`／`isSeeded`／`origin`／`delegationDepth`／`agentPreset`／`draft`）。构造时会校验持久记录，并要求其中的 id 与 `session.id` 一致。

### 无损 JSON 工具

持久值需要一种已接受的表示，不能先检查再二次读取。`isJsonValue(value)` 是布尔判断函数；`snapshotJsonValue(value)` 在一趟迭代中校验并复制普通值，无效输入返回 `undefined`，getter 抛出的异常则向外传播。快照辅助函数接受除 `-0` 外的有限 JSON 数值（JSON 会将其改写为 `0`）、稠密普通数组、普通对象或 null 原型对象；它会在规范化前拒绝循环引用、不支持的标量和特殊原型，同时不施加调用栈深度限制。

会话事件导入将所有权与消息校验分开处理。`snapshotSessionEvent(event)` 会先克隆借用的事件，再校验并冻结其中带标识的消息。`adoptSessionEvent(event)` 原地执行相同的消息处理并返回原事件；调用方只有在移交独占的对象图，且该对象图没有与其他事件共享可变子对象时，才可以使用此函数。两条路径与 `append` 应用相同的规范化载荷与事件本地 surface 元数据校验；不检查历史关联。

### 分片行存储编解码器（`chunk-rows.ts`）

共享的[存储编解码器](src/chunk-rows.ts)在事件序列与紧凑行之间无损转换。它会逐字保留无法识别的事件，并拒绝形态错误的编码行；是否启用打包写入由持久化后端决定。

`encodeSeqRanges()` 与 `decodeSeqRanges()` 为 surface 来源事件数组提供另一组无损存储辅助函数。连续段可以表示为闭区间 `[start, end]`，解码器也接受历史的纯数字数组表示。

### Surface 类型

此包拥有有序 surface 投影、替换校验、回放，以及区分追加来源事件与替换事件的类型守卫。[surface 类型目录](../../../docs/subsystems/session.zh.md#surface-types)拥有精确形状与字段语义。面向人的 transcript（文本记录）必须投影追加来源事件，而不是 `session.surface`，因为已落地的替换会遮蔽读者已经看到的历史；面向模型的消费方继续读取 `session.surface`。

### 设计概念

该包建立在事件溯源之上：`Session` 是类型化 `SessionEvent` 的仅追加日志，其他一切——模型历史、transcript（文本记录）、遥测、标题、持久化——都从这条流派生。surface 是派生投影：一个增量管理器校验追加候选、根据已提交事件推进有序视图，通过 `replaceGeneration` 跟踪位置替换，通过 `contentGeneration` 跟踪位置替换和插件拥有的消息变更。模型可见即已记录：任何到达模型请求的内容都必须能从日志重建。每个完成结算的模型尝试都会提交一个事件：`assistant/message` 携带组装后的模型可见 message 及其紧凑带时间 stream，`assistant/attempt` 则保留失败、重试、取消或 stream error attempt，且不添加模型历史。如果进程在 settlement 前硬中断，则不会留下持久 attempt stream。

### 请求头重建（`request-header.ts`）

`request/header` 记录非历史请求封装的完整规范快照，其原因为 `initial`、`resume` 或 `change`。其可选 `adapterDefaults` 映射会标记由精确模型解析填入的生效 `reasoningEffort` 或 `maxTokens` 值，使下一次请求提议能够将它们与显式对话设置区分开。`foldRequestHeader()` 选择最新快照；旧版增量事件和已移除的 `fallback` 原因会被拒绝。详见[可重建请求 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-05-reconstructable-requests.zh.md)。

`user/message` 会直接存储完整的 `UserMessage`，其中包括收件箱路由或进入步骤前创建的标识。无论它是直接人类提示词、合成注入，还是已进入的 Goal Round，都会原样呈现其 `content`；带类型的 `source` 是区分三者的唯一通道，并携带各领域专有的持久事实。`assistant/message` 和 `tool/result` 也会存储完整的消息值。轮次执行仍由 `turn/start` 与 `turn/end` 包围；`agent.inject()` 会把输入排队，直到后续某次 pre-step 领取它，并在 enter 决策中返回它。

`tool/result` 持久保存一条带标识、user-role 的工具结果消息，以及可选内部失败标识和可选呈现元数据。工具成功时的规范 `value` 和便于人类阅读的规范失败消息只存在于执行本地；渲染后的错误内容是回放权威消息。

### 会话事件词汇（`types.ts`）

生成的[持久化日志事件目录](../../../docs/persistence-catalog.zh.md)逐成员列举仅追加日志的事件类型、载荷、surface 标记与声明位置。Token 记账读取每个步骤的 `assistant/chunk { type: 'usage' }` 记录；如果没有用量分片，则将 `assistant/message.usage` 作为已提交步骤的后备。失败的模型请求尝试没有 assistant 消息。每条 `assistant/message` 都会记录提供方、模型和可选回放状态。

`SessionEventMap` 可通过合并扩展：插件使用声明合并添加自身类型（压缩 seam 的 `compaction/*`、有界恢复的非 surface `llm/retry`、钩子桥接层的 `hook/*`）；合并成员会出现在同一目录中。插件拥有其合并事件的关系不变量，包括是否允许纯日志事件出现在轮次之间。需要持久性的生产方通过 `Session` 追加，再等待 `ctx.sessions.flush(session)`，无需虚构一个执行轮次。

此包还定义 `TurnEndReasonMap`，即用于轮次结束、可合并扩展且以 `kind` 为标签的和类型。`turn/start` 只携带轮次编号；随后已进入的 `user/message` 批次记录其输入，`llm/retry` 则记录请求恢复。

被中断的实时轮次以 `{ kind: 'aborted', reason: AgentCancelCause }` 结束，在持久 transcript 中保留类型化取消原因。持久化会将受支持旧格式中的粗粒度中止结果导入为 `{ kind: 'aborted', reason: { kind: 'legacy' } }`，因为该记录没有保留调用方。轮次失败携带 `{ kind: 'error', error }`；只有崩溃恢复会合成 `{ kind: 'interrupted' }`。

`deriveMessages()` 缓存深度冻结的派生消息，每次调用返回新数组。四种 surface 事件类型（`system/message`、`user/message`、`assistant/message`、`tool/result`）提供记录的消息身份和内容，空内容的系统节点不派生消息。插件拥有的投影修改派生内容，不修改记录的消息。替换和投影决策使缓存失效。嵌入式 Assistant stream 与 `assistant/attempt` 事件只保留回放和诊断数据。

每个 `SessionEvent` 都有三个可选顶层字段（结构元数据）：

- `sourceEventSeqs?: number[]`：被引用为来源的较早事件 seq（例如 `tool/result` 引用的 `tool/call`，或压缩替换条目引用的已遮蔽条目）。`assistant/message` 在 `data.stream` 中嵌入精确的紧凑提供方流，禁止携带此字段；其他 surface 事件若有此字段，则要求非空列表。
- `surfaceOp?: SurfaceOp`：事件进入 surface 的方式。非 surface 事件（边界、分片、用量、错误）不含该字段。
- `ignorable?: true`：标记读取器在不认识事件类型时可以安全跳过该事件；缺失表示必需，不认识的事件类型会使会话重建被拒绝（[机制](../../../.agents/notes/implemented/architecture/2026-08-10-session-log-version-mechanism.zh.md)）。

### 元数据类型（`types.ts`）

- `SessionHeader`：会话元数据，在发布为 `Session.header` 时写入一次；脱离和深冻结保证运行时不可变：`{ version, id, createdAt, isSeeded, cwd?, parentSession?, origin?, delegationDepth?, agentPreset?, draft? }`。`isSeeded` 只报告谱系而不带位置整数；精确的 `inheritedEventCount` 作为存储元数据伴随 header、并挂在在线 `Session` 上。持久化 loader 可返回相同数据类型的可变脱离副本。该类型与 `SessionId` 一同归此包所有，因为 `Session.header` 以它为类型；持久化后端只是重新导出而不拥有它，否则会形成包循环依赖。

### 扩展点

- 持久化插件：订阅 `session/event`（延后写入），并在 `session/flush`（受等待）及 fiber dispose（资源释放）时排空。持久后端读取日志并重新加载到实时会话；这类后端会把元数据约定（`SessionHeader`、`session.header`）与日志一同存储。
- 回放／fork：`create(id, { seed })` 校验并冻结连续的当前格式日志，再重建 surface；请求头必须包含提供方／模型，assistant 消息必须包含提供方／模型来源。持久化层在构造该当前格式 seed 前负责读取兼容性处理。`fork(source, boundary?, childSessionId?)` 选择已完成轮次前缀并记录谱系。
- 压缩：`dsh-compaction-basic` 为摘要检查点追加一个替换用 `user/message`，而 `dsh-compaction-tool-result-pruner` 追加仅修改内容的 `tool/result` 替换。工具配对边界策略及其缓存归 [`dsh-compaction` seam](../../compaction/compaction/README.zh.md) 所有；此包拥有有序 surface 成员关系、替换校验与 `replaceGeneration`。

## 模型体验

### 派生消息历史

#### 模型看到什么

模型会接收 `system/message`、`user/message`、`assistant/message` 与 `tool/result` surface 条目中的消息，并应用日志中的投影，系统提示词在先。消息标识、角色、来源及未修改的内容块保持不变，投影不生成标识。直接提示词与注入上下文仍是独立的 `user/message` 事件，各事件的来源保留其出处。嵌入式 stream、`assistant/attempt`、边界与其他仅日志事实不添加消息。

#### Token 影响

追加的 surface 条目会在后续步骤中重新发送。`replace` surface 操作会从未来输入中移除被遮蔽条目，但不删除其原始日志记录。

#### KV Cache 影响

追加的 surface 条目会保留可复用前缀。即使底层事件日志保持仅追加，`replace` 操作也会从首条被遮蔽消息起使缓存复用失效。

### 崩溃修复结果

#### 模型看到什么

如果恢复发现 assistant 工具请求没有持久 `tool/call`，其合成 `TOOL_NOT_STARTED` 结果内容为 `The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.`。如果持久 `tool/call` 没有结果，其 `TOOL_OUTCOME_UNKNOWN` 结果内容为 `The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly.`。

#### Token 影响

未受损会话的 token 增量为零。恢复时，每个修复后的调用都会添加保留的、针对具体风险的错误文本。

#### KV Cache 影响

保持仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已记录的请求头

#### 模型看到什么

会话会重建循环实际发送的工具 schema 与调用配置；系统提示词作为 surface 第 0 号节点、并在历史内更新之后作为最新的系统节点，属于 `deriveMessages()` 的一部分。请求头事件不向历史加入任何消息，也不持有提示词的副本。

#### Token 影响

日志记录不产生重复 token。各系统节点与 schema 仍会产生正常的逐请求开销。

#### KV Cache 影响

记录日志不会导致失效，精确重建会保持请求前缀一致。后续请求头若更改配置或 schema，可能从第一处差异开始使复用失效；替换 surface 第 0 号节点的提示词变更会从第一个 token 起使复用失效，而历史内追加则保持直到已缓存历史末尾的前缀可复用。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓事项

这些限制说明何时需要特别关心会话存储。它们是当前包约束，不是任务清单。

- **会话分支／树结构**（pi 风格条目树）：除非需要超越基于边界的 `fork()` 能力，否则暂缓。
- **`fork()` 仅在实时会话的稳定边界处切分**：所选前缀结束时不得有开放轮次，且源会话必须位于存储中；[fork API](../../../.agents/notes/implemented/feature/2026-06-30-session-store-fork-api.zh.md) 不支持对已持久化但未加载的会话进行 fork。
- **`SESSION_FORMAT_VERSION` 为 `3`**：当前读取器拒绝已退役的 `header.system`，并校验 `system/message` 载荷与受保护头节点的重写。持久化 provider 会通过相邻 format 软件包迁移受支持的 v0/v1/v2 历史 generation，然后再构造当前 `Session`；v2 请求头中的系统提示会提升为持久化的 `system/message` surface 节点，旧 generation 保持不可变。Assistant 结算事件可携带紧凑且无损的流，失败 attempt 单独记录。更新的版本会以说明方向的错误拒绝。不认识的事件类型同样被拒绝，除非信封带 `ignorable` 标记；版本机制由 [Session format 软件包](../../session/session-format/README.zh.md)负责。
- **`TurnEndReasonMap` 不含 ACP（Agent Client Protocol）命名的 `refusal`／`max_turn_requests` 变体**：受生产方约束；只有当适配器或循环首次产生这些变体时才加入。
