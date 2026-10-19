# Agent Note: Turn-trigger 开场行与锚定在 turn/end 的已完成 Turn 页脚

Status: implemented

[English](2026-10-18-turn-trigger-and-turn-end-anchored-tail.md) | 中文

## Problem

两个展示缺陷同根同源——Chat 投影没有尊重记录在案的 `turn/end` 边界。其一，开启一个 Turn 的非人类 `user/message`（被 next-turn Inbox 认领的 schedule、goal、agent、webhook 或 tool-job 通知）被投影为普通的 `context` 行，于是它随已完成 Turn 的过程证据一起折叠，该 Turn 存在的持久原因消失在折叠背后。其二，已完成 Turn 的页脚锚定在收尾 Assistant 旁边而非记录在案的 `turn/end` 事件，因此在该 Assistant 与边界之间落账的已认领 steering 或 context 行会渲染到页脚之后；branch 动作交给 Host 的也是收尾消息的 seq，而非边界的 seq。

## Decision

Inbox 分类拆为两个持久 Definition：`inbox-next-step` 保持原有语义，`inbox-next-turn` 追踪将消息认领进下一个 Turn 的认领记录。每次认领记录其 `claimSeq` 以及是否接纳了人类消息（`claimedHuman`），使 `user/message` 分类可以同时查询两组认领。当前 next-turn 认领中的非人类消息，或在 `turn/start` 之后开启 Step 1、其后没有 next-turn 认领、且认领中没有人类消息的空闲非人类 next-step steer，在其 context 状态上携带 `waking: true`，`buildViewNode` 将其映射为新的 `turn-trigger` 节点种类。该种类注册进 `TURN_PROCESS_INDEPENDENT` 并位于 group-tree 的 `input` 位置，因此在已完成 Turn 折叠后仍然可见；`turn-trigger.ts` 按来源选择本地化标签，`TurnTriggerNodeView` 将通知渲染在自己的折叠控件之后。

turn tail 在 `data.seq` 中保留记录在案的 `turn/end` 载荷 seq，并锚定在 `data.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup`，页脚因此排序在该边界真正关闭的所有转录行之后。`TurnTailNodeView` 检查该 Turn 的 location 索引中最后一个有意义节点——reasoning delta 和 tool call 不算有意义——仅当该节点是 assistant 回复时发布 `data-actions-reveal="always"`，否则动作行保持悬停显示。Branch 调用 `forkAt(data.seq)`，把记录在案的边界 seq 交给 Host。这不涉及任何 Session 事件、模型或持久事件变更；纯粹是投影与展示。它收窄了早前[已完成 turn-tail 资格决策](2026-08-02-message-fork-actions-require-completed-turn-tail.zh.md)中的锚定与展示机制，其基于边界的资格判定保持不变。

## Alternatives considered

**把开场消息渲染为带标签的普通 context 行。** 否决：普通 context 行会折叠进已完成 Turn 的过程窗口，恰在转录折叠时隐藏该 Turn 运行的原因。

**页脚继续锚定在收尾 Assistant。** 否决：只要在最终回答与 `turn/end` 之间出现已认领的 steering 或 context，页脚就会落在 Turn 中段，而且交给 fork 的是 Turn 内部的 seq，而非 Host 要复制的边界。

**已完成页脚一律常显动作。** 否决：steering、tool 或中断结尾并不是读者要继续的回复；仅悬停显示让操作条与该内容的角色相称。

## Consequences

schedule 或 tool-job 开场消息在展开与折叠视图下都呈现为独立的带标签行，已完成页脚始终位于其 Turn 的真实末尾，fork 按 Host 期望的边界截断。遗留兼容投影将 `turn-trigger` 视为 context 内容。分类矩阵（未认领、已取消、重排队、人类拥有、后续 step、Turn 前、非成员输入）与锚定/折叠/悬停行为由 Definition 级与 ChatView 规格共同锁定。该拆分细化了 [Conversation 节点组装决策](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)所确立的单一 inbox Definition。
