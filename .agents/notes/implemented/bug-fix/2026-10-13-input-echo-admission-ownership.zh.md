# Agent Note：输入回显录取所有权——队列/持久去重、延迟失败判定、Assistant 保留

Status: implemented

[English](2026-10-13-input-echo-admission-ownership.md) | 中文

## 问题

客户端会话路径上四个相关缺陷，均已通过与上游源码比对确认：

1. 提交回显没有队列位置跟踪：当队列发布移除一条尚未被持久录取的回显时，它要么过早被判失败，要么永远滞留，且 `canceled` inbox splice 无法归因到被移除的身份。
2. 新的 follow 基线无法区分「该输入仍由 Host 持有」与「该回显从未到达」，因为队列观察没有与基线的 `asOfSeq` 水位对齐。
3. `beginSubmission` 接收调用方用快照算出的 `placement`，快照可能已过期：running 位在读取快照与提交之间变化时，回显会挂到错误的界面。
4. `ClientAssistantStream` 在流结束的那一刻就移除该尝试的瞬态行：成功的最终回答在流结束与 `step/end` 之间会短暂消失，而已完成的持久结算仍被暂存到流结束才发布。

## 决策

1. 移植上游 `820824edd74`：为每条回显跨 `session/queue` 帧、`queuedInbox` 投影与 `agent/inbox/spliced` 事件跟踪 `queueTarget`/`queueIndex`/`queueSeq` 回执；queued 位置的回显在被队列接受时退役；transcript/steering 回显等待持久录取且队列行被移除；`canceled` splice 立即使被移除回显失败；已离开队列且未录取的回显在移除观察之后记录的下一条 `request/context` 或 `turn/end` 边界处失败。
2. 同一提交：种子时 reconciliation 把所有在 `projections.asOfSeq` 及之前已被队列观察到的身份按已观察接受——即使其持久录取不在已加载窗口内；`ProjectionValueStore.seqOf` 暴露该比较所需的逐 key 水位。
3. 同一提交：`BeginSubmissionInput` 改为携带 `mode`，由 Session 依据自身实时 `running` 状态派生位置，与上游一致并消除过期快照竞态。
4. 移植上游 `08c0e8e71b6`：已录取的本地身份在队列发布移除其行之前一直抑制该行（ChatView 的 steering 行与 QueueDock 的 transcript 行均按 `rpcId` 匹配）；渲染侧去重只在持久节点持有其 `rpcId` 后隐藏回显，队列占位不隐藏。
5. 移植上游 `1b55f5bea3a`：成功的 `assistant/message` 结算在流结束时立即发布，其瞬态行保持到匹配的 `step/end`（step 发布携带 `retireAttemptId`）；被中断的 message 与失败的 attempt 仍在流结束时结算；已有保留结算等待其 step 边界时到达的新尝试请求 rebaseline。Assistant 节点把成功 message 锚定在其首个可见 seq，使随后的工具/准备行不再改变它的位置。
6. 当 Chat 以一条不拥有可见输入的 open Turn 控件结尾时，第一条 transcript 回显渲染于该控件之前，与上游的提升行为一致，避免打开控件越过回显。

## 已考虑的备选方案

**已录取回显无论队列状态如何都立即退役（上游规则）。** 在 CoHarness 下弃用：我们的队列以整体 `session/queue` 快照与 `queuedInbox` 投影到达，而非上游的 inbox seq 流；让已登记回显一直存活到行真正消失可保持 UI 抑制精确，杜绝陈旧行复现；销毁路径仍为卡住的行兜底。

**把队列缺席直接判为失败而不等 splice。** 弃用：移除在 splice 给出结果或持久边界越过它之前含义不明，缺席只能把回显挂入「已移除待确认」态。

**移植上游 Playwright e2e（`idle-submission-handoff.e2e.ts`）。** 延后：我们的 wire 面不同（`session/queue` 帧与 `queuedInbox` 投影，而非上游的 `session/control`/`session/follow` 流），门控需要重写而非照抄；单元测试已覆盖全部结算路径。

## 影响

同一身份的队列观察与持久观察经结算锁存去重，任一路径都不会重复或乱序退役回显。队列行消失但未获录取的提交恰好在拥有该移除的 splice 或下一持久边界处失败一次，不再闪烁或泄漏。重连基线把 Host 已确认的输入按已接受处理，而不再当草稿重现。成功的 Assistant 回答在模型结算时即刻发布，准备/工具行在其后完成。

## 验证

`client-runtime` 105 个定点测试覆盖离队回显边界、已取消与移动的 splice、队列持有期间的录取、steering 存续、基线接受与销毁；`ui-conversation` 测试覆盖 QueueDock 的 transcript 行抑制、入队期间的回显挂载与 ChatView 的 steering 行去重；受影响文件的 typecheck 与 lint 均通过。

## 相关

- [会话可靠性修复](2026-10-12-session-reliability-fixes.zh.md)——同一 alpha.2 对齐行动。
- 上游提交：`820824edd74`、`08c0e8e71b6`、`1b55f5bea3a`。
