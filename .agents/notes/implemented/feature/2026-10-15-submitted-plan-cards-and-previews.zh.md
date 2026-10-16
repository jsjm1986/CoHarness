# Agent Note：已提交计划卡片与 Session 背书的侧边栏预览

状态：已实现

[English](2026-10-15-submitted-plan-cards-and-previews.md) | 中文

## 问题

`ui-plan` 此前只有 composer 徽章：`exit_plan_mode` 落定之后，会话中没有任何入口能回到已提交的计划，未提交的计划评审也无法再打开其按钮所概括的文档。用户批准、拒绝或关闭评审后，便再也看不到计划正文。上游以 turn 级 `turnDataSource`、`dsh-client-resources` 流式 provider 与 `remote.session.follow`/`page` 历史读取解决——本代码库没有这些抽象，因此该缺口需要语义移植而非机械移植。

## 决策

一个已提交计划是一个按退出工具调用键控的隐藏 `submitted-plan` Chat 节点——原生 `tool/call` id，或 `tool/ptc-dispatch-start`/`tool/ptc-dispatch` 对的 `subCallId`。`submittedPlanDefinition` Conversation 定义在两类事件族上都产出这些节点；隐藏节点不进入 `order` 或 `locations`，但 `chat.nodes.values()` 保留它们，因此 `conversation.chat.turnTail` 卡片直接按回合过滤节点存储——同一存储已保留事件，无需再为其持久化。

卡片经 `openSessionResource` 把 `dsh-resource://plan/<session>/<callId>`（直属子代理则是 `dsh-resource://plan/subagent/<parent>/<child>/<mode>/<callId>`）打开进可见 Session 的侧边栏。`plan` 侧栏标签类型认领这些地址以及瞬态 `dsh-resource://plan-review/<session>/<key>` 地址——后者把未提交评审的 Markdown 放在导航参数中而非持久存储：从未落日志的评审无法从历史恢复，其内容随标签旅行。`resourceSession` 从地址解析归属（subagent 地址取子 id），使子代理计划在父屏幕下打开仍通过侧栏归属校验。

持久文档经 `Session.readCallHistory` 加载：按地址指名的归属保留——subagent 地址路由到子会话——并经同一套 conversation 定义重组该调用的完整回合，从权威日志恢复 `submitted-plan` 节点。这以定向的服务端 `toolCallId` 查询加共享代次替代了上游的 `remote.session.follow` 分页。

`conversation.plan-review.actions` 新增 `PlanReviewOpen` 条目：Session 挂载后自动打开一次评审——在调用时点而非渲染时点读取 `sidebarRight.mounted`，使在提交与 effect 之间变化的座位不会搁置打开；打开器报告打开是否到达座位，评审只在到达后才记为已开，因此挂载 Session 变化时 effect 会重试，而已关闭的评审保持关闭。`sidebar.right.pane.tab` 及其标题座位经 `MarkdownText` 渲染恢复的文档与标题；plan-read 存储按地址发布 loading、ready 与本地化失败态，在 `connection/reset` 时重置，并按地址键控读取，过期发布不会错标标签。

## 备选方案

**给 conversation 引擎加 turn 级查询 API。** 引擎已物化隐藏节点，按 location 过滤 `nodes.values()` 覆盖同等读取而无需第二条存储路径——仅当节点扫描出现可测成本时才值得重提。

**把评审文档编码进资源地址。** 地址字符串持久于侧栏布局；未提交的 Markdown 不应存活过刷新，因此由参数携带，恢复的评审预览显示本地化过期态。

**标签类型不设 `resourceSession` 归属。** 上游未设置，但本地侧栏校验器要求每个资源解析到打开它的 Session；从地址读出归属保留该不变量，同时让子计划能在其父屏幕下打开。

## 影响

每个已提交计划在评审结果（批准、拒绝或关闭）之后仍留在已完成回合的产物区，重开聚焦既有标签，刷新浏览器后恢复。子代理计划落在可见父侧栏但读取子会话自身日志。无法到达座位的评审打开保持待决，而不会被记为已展示。

## 验证

`plan.client.spec.ts`——原生与 PTC 计划提取、地址往返、跨回合隐藏节点装配、按调用身份与丢弃的非计划调用。`plan-resource.client.spec.ts`——Session 与子代理保留、无效地址与不可用失败、读取失败、callId 不匹配及 `connection/reset` 后的发布抑制。`plan-preview.client.spec.tsx`——回合末尾卡片、评审自动与手动打开、座位重试与关闭语义、Markdown 渲染及本地化 loading/failed/expired 态。`browser-plugin.client.spec.ts`——注册、inject 面、subagent 地址归属、未知 Session 拒绝与拆解处置。47 个包测试、client typecheck、lint 与包依赖校验通过。

## 相关

- [Plan review 作为决定而非问题](2026-07-30-plan-review-presentation-intent.zh.md)——这些卡片与预览所路由出的 composer 评审面。
