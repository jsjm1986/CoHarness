# Agent Note: Timed user questions ported onto the mux question transport

Status: implemented

[English](2026-10-02-timed-user-questions-mux-port.md) | 中文

## Problem

上游定时 `ask_user_question`（`#5178` 提交链）传入的是建立在另一套交互模型上的实现：经 `uiSession` 供给的插件注册 pending interaction、Remote waterfall 订阅与 Remote claim 流。本 fork 的提问传输是 mux `question/requested` 帧，由 `/api/respond` 应答，且其他界面（审批、排队输入、ACP）共用这条线。整体换掉传输会废弃一条可用路径；不引入则定时等待、迟到回答与只读答案回看都无法交付。

## Decision

保留 mux 传输，把卡片模型移植到其上。

- `Session.publishInteraction` 把插件持有的条目并入 Session pending 源，与 wire `PendingWait` 并列；该源是 composer 槽位与会话行读取的唯一 pending 面。
- `PendingQuestion` 保留上游卡片生命周期——waterfall 通道、倒计时截止点、hide/reveal、回看——其 waterfall 的 `resolve`/`reject`/`delegate` 桥接到 `wait.respond`，mux 帧仍是答案载体。
- 携带 `wait.timed` 的 wait 只开启一次 Remote `userQuestions.attachWait` claim 流；waterfall 仅在首帧带回落下截止点后挂接，倒计时不会闪出错误值。
- 存活卡片 retain 其 Session scope（`userQuestion` 引用来源）。scope 拆除会清掉会话级草稿存储，因此问题仍可答时取消选择会话不得释放它；卡片关闭时才释放。
- 重绑的 Session 以空的 published 源起步，因此卡片在每次 reconcile 时重新锚定到新的 Session 对象。反向同理：只有承载过该 wait 的 Session 对象能证明它的离去——重绑后缺席不等于已结清。
- closed turn 即使没有 assistant 证据也拥有 turn-process 行，只有回复的 turn 仍能折叠其遗留内容；被折叠的成员以 `hidden` 保持挂载而非脱离 DOM，因为迟到回复在隐藏期间仍会变化，展开时必须已绘制完整。
- 迟到回答落地为 `source` 为 `user-question-reply` 的 `user/message`；`question-reply` 节点定义把它投射为只读回放行，可重新打开记录的答案批次。

## Alternatives considered

**整体采用上游的插件发布 pending 模型。** 否决：它会废弃审批等传输共用的 mux `question/requested` 帧与 `/api/respond`，重写一条可用线路却换不来产品可见收益。

**保留纯 wire 卡片列表、只外挂计时器。** 否决：移植前卡片没有 continued 或迟到回答的概念；上游 `PendingQuestion` 生命周期已精确编码这些状态。

**用全局存储按 session id 存放问题草稿。** 否决：会话级草稿存储是声明过的抗重挂载状态归属；再起一份只会重复其生命周期规则。

## Consequences

- `SessionPendingEntry` 拓宽为含插件发布条目；消费方先按 `kind` 收窄再读 wire 字段。
- `SessionReferenceSourceMap` 新增 `userQuestion` 来源；retention 与其他持有者一样出现在 `retainInfo` 中。
- 已释放的 scope 不回放 pending wait，因此 wait 离去检测以对象为界而非以键为界——残留的 `WaitBinding` 会跨过重绑存活到卡片关闭。

## Testing

`browser-plugin.client.spec.ts` 以 mux `PendingWait` 端到端驱动本次移植——收养、定时 claim 锚定、重连回放、源离开，以及 retain/release 契约。`question-composer.e2e.ts` 录制迟到回答场景：回复行折叠挂载在其 turn 的 process 展开件内，展开后为只读答案回看。
