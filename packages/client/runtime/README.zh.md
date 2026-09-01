# @deepseek-ai/dsh-client-runtime

[English](README.md) | 中文

客户端 cordis 启动与不依赖 React 的对象服务：SlotRegistry 包装 SlotCore 并提供 renderer 数据源；SessionRuntime 拥有 Session 对象、列表与 scope 状态，以及供已注册 conversation view target 共用的事件窗口与历史分页。WorkspaceRuntime 依赖 SessionRuntime，拥有 Workspace 对象、列表／操作、默认目标派生、历史优先的 Workspace 入口（`openWorkspace`），以及 New Session 空会话复用入口（`connectWorkspace`）。运行时把共享 Host 流分发给 Session 与 Workspace 所有者，并把每个通用 `host/remote-event` 帧交给 `ctx.remote.$dispatch`；各领域包通过 `ctx.remote.$on` 订阅自身 owner 事件，并自行决定使哪些缓存或会话行失效。客户端会话一律由 Host 创建（一次 `session.create` 同时产生 Session、agent（智能体）和 cwd）；客户端不持有任何实体化之前的会话状态——agent scope（host dsh-scope 的客户端镜像，以 agent/session 共用 id 为键）在会话行进入列表镜像时创建，并随 prune 销毁。约定：api-contracts v3 §4。每个 `Session` 持有一个通用的 `ProjectionValueStore`，由历史记录尾部的 `projections` 块播种，并经 `session/projection` 帧按 seq 高者胜更新；领域键（含 `todos`）经 `projections.faceOf`／`useProjection` 读取，不经 `ConversationSnapshot`。该 store 还会通过 `SessionSummary.projectionValues` 发布一份引用稳定的完整值映射，使全局列表消费方无需为每个会话创建订阅，即可复用同一组投影。

直接读取 JSON 的浏览器消费方共用 Host carrier 的流式 reader；它会在解析前拒绝声明长度或实际分块超过默认 16 MiB 的 body。该 helper 只负责传输上限，不替代端点自己的响应校验。

对于每条可到达本地根 Agent 或可继续子 Agent 的提示词，运行时都会采样浏览器当前的 `Intl.DateTimeFormat().resolvedOptions().timeZone`，并只把该值附加到这一次 Session 或 subagent 提示词 RPC。该值既不缓存，也不包含在 Session 创建或 fork 状态中，因此旅行与并发标签页都能保留消息本地的来源信息。浏览器若无法提供非空时区，会在本地拒绝该提示词，而不会悄然使用部署状态代替。

设置所有者共用本包定义的不依赖 React 的 `SettingsScopeSpec`、`SettingsScope` 与快照类型。ui-settings 拥有 `ctx.settingsScope.bind(spec)`、对应的 Host 传输、schema 校验与生命周期；详见[该包的约定](../ui-settings/README.zh.md)。

<a id="slot-declaration-injection"></a>

## Slot 声明注入

`ctx.slots.inject(name, callback)` 将完整的 `SlotMap` key 作为贡献项的依赖，适用于贡献方插件可独立于声明条目激活的情形。声明存在时，它会同步运行 `callback`，否则等待；声明折叠会 dispose（资源释放）回调 effect，重新声明则会再次运行回调。控制器归调用方的插件 fiber 所有，因此卸载贡献方会取消等待或移除其活跃注册项。直接调用 `slots.register()` 向未声明 slot 注册仍会抛出异常。

回调返回一个同步 disposer 或由多个 disposer 构成的 iterable。因此，generator 可以 yield 多个 `slots.register()` 调用，并将它们组成一项事务：setup 失败会回滚先前 yield 的 effect，teardown 则按逆序运行它们。声明生命周期使用专用的单调 declaration epoch（声明代次），因此，即使折叠与重新声明合并在同一次 renderer 通知中，回调仍会重启，而普通条目变更不会重启它。声明绑定的 teardown 与账本变更同步运行，在同一 tick 内的后续注册之前释放运行时资源。详见 [slot 声明注入决策](../../../.agents/notes/implemented/architecture/2026-08-05-slot-declaration-injection.zh.md)。

## Workspace 与 Session 列表

Workspace 和 Session 列表各自具有单调的 `pending` → `ready` 基线阶段，也有各自的刷新活动／错误状态。列表请求期间到达的增量插入或更新／移除／顺序帧与一元变更回显会在其响应之上回放。每次成功的 Workspace 基线都会重新建立 Host 持久 Workspace 顺序，因此重连会接纳该客户端离线期间提交的变更。`WorkspaceRuntime.insertBefore` 会立即安装乐观顺序；只有最新一元回声可以替换它，更新的 Host 顺序帧优先于旧回声，而最新请求被拒时会恢复最近一次由 Host 确认的顺序，不会恢复更早且尚未提交的拖拽。已移除的 Workspace id 会保留进程本地删除标记，避免延迟到达的 changed 帧将其复活。Workspace 新近程度只在两条基线都 ready 后派生，且绝不改变 Workspace 列表顺序。

`SessionSummary.pendingInteraction` 将阻塞 Session 的实时用户操作分类为 `approval`、`plan-review` 或 `question`。`SessionManager` 依据稳定的请求标识跟踪可应答请求的 requested/resolved mux 帧，即使 `Session` 对象尚未实例化也不例外；实例化前的缓冲会保留每个仍有效的请求，替换回放产生的重复项，并移除已解决的请求，因此打开 Session 时，列表状态始终有一个对应的可应答 `PendingWait`。审批与问题并发时，第一个 pending 问题具有更高的呈现优先级，以匹配 composer 路由；只有满足 plan-review composer 二元呈现约束的请求才会保留独立的 `plan-review` 状态。该状态的作用域限定在连接代次内：断连时清除，mux 打开时的回放只恢复仍处于 pending 的请求。

`WorkspaceRuntime.delete(workspaceId)` 在一元响应成功后从客户端投影中移除注册记录；对应的 `host/workspace-removed` 帧具有幂等性，并负责同步其他标签页。Session 状态与当前 Session selection 相互独立，因此 Workspace 消失后，其已纳入客户端投影的 Session 会立即投影到 Ungrouped 下。

`WorkspaceListState.archivedSessionIds` 镜像 Host 的注册表级全局归档集合（一个按 Host 顺序的 `readonly SessionId[]`，仅在成员变化时才替换；需要 O(1) 查询的消费方自建临时 Set）。带版本的 carrier 携带 `archiveRevision`：更新 revision 会替换集合；接受过版本快照后，旧的无版本或过期 carrier 会被忽略。这个可 reset 的规则让 Gateway Admin 能恢复会话，同时阻止旧响应重新隐藏或复活错误的行。`WorkspaceRuntime.archiveSession(sessionId)` 通过 wire 归档；投影层在当前 selection 落入集合时清空为 New Session 视图状态。各分组视图在所有位置隐藏集合成员，而会话行本身仍留在列表 store 中。

SlotRegistry 分别为 renderer 提供 `useSessions` 与 `useWorkspaces` 的裸 observable；ui-renderer 创建钩子。Workspace 业务状态不会进入 `SessionListState` 或条目 store。

`abbreviateHomePath` 是 Web Workspace 悬停卡片与 Tool 摘要使用的仅展示 POSIX 家目录缩写；Windows 盘符或 UNC 路径保持原样，缺失、空或文件系统根的 home 不改写路径。

`indexSubagentDescendants()` 从保留的列表镜像中派生每个 parent 的后代总数与运行中后代数。它只沿不间断的 `origin: 'subagent'` 祖先链追踪，因此普通 fork 会开启独立的归属子树；遇到环时，追踪会停止但不会抛出异常，缺失的 parent 则会保留为无害的键，直至其摘要到达。

`SessionListState.jobsBySession` 按 last-wins 镜像宿主的 `session/jobs` 帧，以会话为键，不需要 Session 实例。被清空的集合存为缺失的键，因此「缺失」与 `[]` 是同一种表示，消费方永远不必检测哨兵值。两处清理让它不至于比它所反映的真相活得更久：`session/subscribed` 丢弃该会话的镜像，因为新一代只为非空集合发送 baseline，被留下的列表会变成幽灵；`host/session-removed` 再丢一次，因为 owner 销毁是在 mux 流上移除记录的，而移除帧走 host 流，两者没有相对顺序。

`SessionRuntime.search(query, signal)` 是基于 `session.search` RPC 的无状态单次操作。它返回经过排序的会话／snippet 对，但不会将查询条件、加载状态或错误状态写入共享 Session 列表，因此每个 UI 所有者都自行负责防抖、取消、抑制陈旧响应和回退呈现。`searchResultLimit` 将 `SESSION_SEARCH_RESULT_LIMIT`——即响应 schema 自身强制执行的上限——作为注入的呈现数据重新公开，使客户端插件无需复制该值。它是协议常量而非逐连接状态，因此连接 handle 不携带它。

## New Session 与 blank 镜像

刚预留的草稿仍为空白时，列表行会携带仅客户端使用的 `workspaceId` 提示，因此 Host 刷新期间占位行仍留在目标 Workspace 下；首条可见内容或移除后提示会清掉，且不会发送到 wire。

`WorkspaceRuntime.connectWorkspace(workspaceId)` 解析 New Session 流程最终落入的会话：它从列表镜像收集该 Workspace 的既有空会话（`blank && cwd == workspace.path && sessionIds.includes(id)`——Host 自己的成员规则，绝不只按 cwd，避免劫持 cwd 匹配但未入账的空白会话），排除已归档行，再让 `SessionRuntime.createOrReuse()` 返回首个与插件创建选项兼容的候选项，或者创建新会话。新建分支携带稳定的 draft id 和预分配 Session id；收到可见消息前，这对身份会保存在受限浏览器存储中，因此刷新或并发的新会话操作会复用同一 reservation，但不会保存凭据。共享的 `startSession` 操作优先使用明确指定的 Workspace，其次使用当前 Session 所属 Workspace，再其次使用派生的最近活跃 Workspace；一个 Workspace 都没有时则清空选择，进入空白 New Session 页面。`SessionSummary.blank` 镜像 Host 的“没有可见内容”位：由 `session.list`／`host/session-added` 帧播种，只有收到非空对话事件才转为非 blank，因此已受理但最终为空的轮次仍可复用；列表重拉会在合并本地已观测证据后重新对齐。列表界面隐藏 blank 行；store 保留每一行。`SessionRuntime.create` 接受可选的、由调用方预先分配的 SessionId，失败时抛出 `SessionCreateError`（携带 `requestedSessionId`）。

`WorkspaceRuntime.openWorkspace(workspaceId)` 从现有列表快照中选择该 Workspace 最新的、当前用户可见、非空、未归档的根 Session，不额外请求列表；没有符合条件的历史 Session 时委托 `connectWorkspace`，因此调用方仍会得到正常复用或新建的空会话。启动流程与 Hero 工作区选择器使用历史优先入口，明确的新会话操作继续调用 `connectWorkspace`。

`sessions/prepare-create` 是创建根会话时使用的 Client waterfall。`SessionRuntime.create()` 与 `SessionRuntime.createOrReuse()` 会在复用空会话或分发 RPC 之前，让调用方提供的 `SessionCreateOptions` 经过该事件；监听器可以增加插件自有字段或拒绝整个操作。随后，`createOrReuse()` 会把完整准备后的选项与每个空白候选项交给 `sessions/confirm-blank-reuse`。确认监听器调用 `next()`，并在插件自有创建字段与既有根会话不匹配时返回 false；只有全部监听器都接受，候选项才会被复用。每个 waterfall 监听器都必须先调用 `next()`，再应用自己的贡献，让独立插件能够组合。fork 与 subagent 均不使用这两个事件。

`Session.composerPhase` 把任何可见的非命令 Chat Node 视为对话内容，因此客户端插件可以在不打开轮次的情况下投影持久用户输入，而仅包含通用命令行的窗口仍保持 Host blank 状态。列表隐藏和空白会话复用仍遵循 Host blank 位。缺少插件输入 Node 的历史窗口会恢复该空白状态，直到加载更早页面后该 Node 恢复。

## 待处理队列投影

`ConversationSnapshot.queue` 是 Host 提供的 `agent.inbox.nextTurn` 权威瞬态快照；待处理的 next-step steering（中途引导）不进入此投影。每行携带其 `MessageId`、所有内容块均为文本时的完整可编辑文本，以及扁平化预览；图片块会从预览中省略，因为对话 dock 会单独渲染其持久化缩略图。本地提交会记录预期的 transcript、queued 或 steering 位置，直到观察到携带匹配 `rpcId` 的 Host 状态。Host 根据持久 `agent/inbox/spliced` 变更派生完整 `session/queue` 快照，并在重连时发送基线；面向单条消息的 `agent/inbox/inserted`、`claimed` 与 `discarded` 通知不用于重建该投影。`Session.updateQueue()` 经 Host 侧 `Inbox.splice()` 发送编辑／移除操作，客户端不做乐观变更，因此下一份 Host 快照是唯一可见的提交结果，claim 竞态则可能呈现 `queue-item-not-found`。

## Conversation 组装

每个 `Session` 都把连续事件窗口交给 `ConversationNodeAssembler`。`open()` 与 `loadOlder()` 在该会话尚未补全时请求 `detail: 'conversation'`；`ensureHistoryDetail()` 拉取 `detail: 'full'` 并按 seq 合并。窗口的 `baseSeq` 与尾部包含 `omittedSpans`，因此 conversation 档空洞不是 mux 缺口（[两档会话历史传输](../../../.agents/notes/implemented/architecture/2026-08-18-conversation-history-tier.zh.md)）。处于舞台的会话从 `historyWindowMode: 'tail'` 开始；接受 prompt 或观察到 `running` 后在后台补齐更早页面，空闲且处于舞台的阅读器接近顶部时会自动请求一页更早历史。较早历史控件在自动分页失败或触及上限时保留为无障碍重试入口。离开舞台会释放浏览器窗口，下一次进入重新读取尾页。模型请求和实时事件流不等待补齐。普通会话在第一页完成后还会异步请求有界的 `session.historyIndex`；索引只包含轮次范围和简短预览，尚未驻留的标记会先读取所需的更早页面再跳转。插件注册业务 Definition，把单个事件映射为稳定的 `{kind, id}`，在唯一 start 事件处创建 State，折叠有关联的 update，再为已注册的视图目标构造最终节点。Assembler 负责 Context 索引、只读前序 Context 查询，以及引用稳定的 Turn/Step Location 索引。实时 append 只对每个 Definition 求值一次，并且只更新命中的 Context；加载更早分页时保留已有 Context 与节点身份，只匹配新 prepend 的事件，并重放前序依赖或 Location 事实发生变化的 Context。完整替换仅用于首次打开、舞台重进和重连；缺口修复会把恢复的尾页合并进现有窗口，不会丢弃已显示历史。

`IncrementalAssistantBlocks` 用追加的 chunk 片段维护助手输出。文本、推理和工具参数前缀只在消费方请求快照时拼接并清理，因此长流不会在每个 chunk 上复制完整前缀。

连接 generation 恢复后，`SessionManager` 会对驻留会话的历史重建执行 single-flight，同时最多允许四个并发，并优先当前选中的会话。断开连接会丢弃排队工作；进行中的读取由 Session generation 栅栏取消。scope dispose 还会在释放 Session 实例前取消未完成的初始 history 读取。

Definition 作者只根据当前事件完成匹配，为每条关联事件提供稳定业务 id，并保证 update 能按日志 `seq` 回放；renderer 只消费最终 Node data 与受限 Location value，不扫描 Session 或 Chat 集合。完整注册和分页路径见 [Conversation Node 实操手册](../../../docs/cookbook/adding-a-conversation-node.zh.md)。

`ui-conversation` 注册内建 Chat Definition 与 keyed Chat snapshot builder。append 来源的 user、assistant 和 Tool result 构成人类可见记录；仅供模型使用的 replacement 副本不进入 Chat，compaction 检查点除外，它会成为独立标记，并在更早分页补齐 summary 溯源后更新。持久 inbox splice Context 能把 next-step 用户消息判定为 steering，无须让 inbox 状态成为 Session 特例。上下文消息保留生产者 provenance 与 form。StatsLine 读取 `ConversationSnapshot.chat.legacy.nodes`；Session 则把该 legacy slice 镜像到顶层 `nodes`、`partial` 和 `runningCalls` 公共兼容字段，无须运行第二套业务 fold。`ui-trajectory` 在同一个 Session 窗口上注册独立 Definition 与 target builder；它保留现有的 stage-oriented view model，既不消费 Chat 兼容字段，也不运行另一套 history fold。

Chat builder 为每个 Session 保留一个 mutable keyed store。内容更新只通知受影响的 node key；结构变化才重建顺序和 Location 成员关系；prepend 只增加行，不替换既有 keyed value。每个 Assistant chunk 都会更新 Definition State，但最多每个 animation frame 请求一次物化；final message 与 Turn/Step 关闭会立即发布。参见 [Client Tool 展示所有权决策](../../../.agents/notes/implemented/architecture/2026-08-08-client-tool-presentation-ownership.zh.md)。

## Trajectory 请求数据

Trajectory Definition 组装出一条按时间顺序排列、以用途为判别字段的提供方请求流。助手请求始终携带数值型 `turn` 与 `step`；压缩请求携带 `step: 0`，其 `turn` 所有者可以是 `null`。这个 null 所有者表示手动压缩独立运行在两个轮次之间，并不表示它属于任一相邻轮次。由取消定稿的 `assistant/message` 会保留持久结果 seq 和提供方信息，但不会将请求标记为完成；`step/end` 会把该请求归类为错误。`session/end-seed` 边界会在边界时刻将未匹配的压缩请求以错误状态结束，错误固定为 `Compaction was interrupted before completion.`；后续 start 会投影为独立请求，而不会覆盖这项遗留的未匹配请求。

## Code Mode 子调用树

每个 `ToolCallBlock` 都通过 `subCalls` 按启动顺序递归拥有自己的子调用。Chat 的 Tool Definition 按 call id 关联 root call 与 result，把 Code Dispatch 的 start/settlement 记录折叠进该 root Context，并投影为一棵 keyed 递归树；child call 不会成为独立 Chat root。start 落在已加载窗口之外时，其 settlement 仍以 `callTime: null` 渲染。一次 child 更新只复制其祖先链，因此未变化的 sibling 保持对象身份。会引入环或超过固定 256 层深度上限的边会被消费，但不会修改树。Trajectory 的 Tool Definition 为自己的 target 独立组装同一种嵌套数据契约。

## Session 标题投影

`SessionManager` 独立于列表和 Session 实例到达情况，保留最近一次通过验证的 `session/title` 控制快照。seq 更高的事件会替换旧快照，标题时间戳计入列表新近程度；订阅基线会先丢弃 seq 超过其 `lastSeq` 的任何已保留标题，再接收可选的折叠标题。显式移除 Session 也会清除已保留标题。因此，面向客户端的 `SessionSummary.title` 只包含实际的持久化标题；`displayTitle` 始终存在，并依次回退到 cwd basename 和 Session id。冷态持久化会话会保持该回退值，直到打开或恢复会话，促使主机折叠并投影由日志支撑的标题。`ISession.rename` 用 unary 响应中的 `{title, seq}` 直接结算 `title` 投影格，遵循同一 seq 高者胜规则——列表行和所有 `useProjection('title')` 读者在推送帧到达前即更新；推送帧随后重放同一 seq 时为无操作。

## 模型重试投影

Host 所属的 LLM（大语言模型）retry invariant 会在持久追加边界验证按提供方路由的 `llm/retry` 与 `llm/retry-started` 记录，包括标识、顺序、计时器、整数、状态、提供方延迟和非空诊断字段约定。客户端的 Retry、Assistant 与 Turn Error Definition 把这些记录和 Assistant、Turn／Step 事件一起折叠：失败步骤的流式输出片段会被移除，并在 retry 事件的序列位置插入一条持久重试提示。该提示在匹配的 started 记录到达前为 `scheduled`；如果所属 Step 或 Turn 先关闭，则标记为 `cancelled`，started 记录到达后则标记为 `started`。normal mode 提示携带其有限上限；always mode 提示保持显式无界。没有重试的终态 `turn/end` 错误会从持久消息与可选错误码投影出一个 `turn-error` 节点；AUTH 投影会把可能回显凭据片段的提供方文案替换为 `API key is invalid`，Gateway 会话持久化和授权内部细节会改为安全的重试提示，不暴露解析器或存储细节。进入重试的失败只保留该次尝试的重试提示。窗口重建与历史回放使用同一组 Definition，因此刷新既不会让已丢弃的分片重新出现，也不会丢失终态失败反馈。可见但尚未定稿的输出会在终态错误旁冻结为中断的 Assistant 节点。

reason 为 `max-tokens` 的 `turn/end` 会在该轮位置投影出一个 `turn-max-tokens` 节点：一条 warning 样式的本地化提示，说明回答在单次请求的输出 token 上限处停止，已截断的输出保留在对话流中，并提示发送“继续”可在新一轮接着输出。事件本身不携带 token 数量，提示因此不显示任何数字。窗口重建与历史回放使用同一 Definition 重建该节点，刷新和恢复后结束原因保持一致。

## 会话 fork

`ISessions.fork({sessionId, atSeq?, increaseTitle?})` 只在子会话摘要已能在本地寻址后才完成；该摘要携带源会话的谱系和 cwd，且 `blank: false`，由调用方决定是否打开。`increaseTitle: true` 会在 client 端根据源会话的持久化标题重命名子会话：尾部 `(N)` 或 `（N）` 递增并保留括号样式，其余标题追加 ` (1)`；源会话没有持久化标题时跳过改名，改名失败时拒绝 promise 但保留已创建的子会话。该选项不会进入 Host fork 请求。即使响应为 `workspace-attach-failed`，其中仍会标识 Host 已发布的子会话，因此 `SessionManager` 会先将这一部分成功对账，再让 `SessionForkError` 到达调用方，避免重试创建重复的子会话。

## 会话模型选择

每个常驻 `Session` 都拥有一个 `modelSelection` 快照，其中包含当前模型选择、按提供方分组的目录、逐提供方失败记录，以及 `idle`／`loading`／`ready`／`selecting`／`error` 状态。历史记录会建立或刷新当前模型选择，打开选择器会刷新目录；选择失败会保留上一次模型选择和可用分组。目录与选择操作共用单调递增的代次，因此较旧响应无法覆盖较新的模型选择。重连重建会恢复 Host 报告的模型选择，同时不替换未变化的选择子结构。

## 模型体验

无，因为会话对象层会选择后续 Host 请求使用的提供方／模型路由，但不添加任何模型可见内容。

#### KV Cache 影响

更改模型选择可能改变提供方侧的缓存复用，或使其失效；该包本身不会改变提示词前缀。

## 已知限制与暂缓事项

- **`loader.unload` 是 stub**：它会抛出 not-implemented；客户端没有从 fiber dispose 到注册与样式移除的卸载链。
- **scope 拆卸由阶段驱动，目前只能有一个占用者**：已 staged 的会话精确跟随 `list.current`（staging 就是打开信号：事件窗口打开 ⟺ 会话位于 stage）；在 staged 状态下被移除的会话，其 scope 会冻结保留，直到 stage 转向其他会话，而非直到真实观察者数量降为零。解析（`binding()`／`scope()`）只是纯寻址，可安全用于渲染；渲染层经 `currentProvideInfo` observable 读取当前 bundle。并发 pane 落地时，staged 状态可以扩展为多 pane 列表。
- **插件 bundle 从该包导入值时必须使用 `/client` 子路径**：裸包名不在 loader externals 表中，会内联第二个模块实例；其私有 scope-tag Symbol 永远无法匹配。
