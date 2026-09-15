# Agent Note: Context breakdown 将有效系统提示与被取代节点分桶计价

Status: implemented

[English](2026-09-15-context-breakdown-system-chain.md) | 中文

## 问题

O(1) 的 `contextBreakdown` fold 用最后一条 `system/message` **事件**的估值作为 `systemTokens`，并把该事件的 surface delta 排除在 message 统计之外，丢掉了上游的两条性质。in-history 更新追加第二个 system 节点时，被取代 head 的估值从三项统计中整体消失——而它本应作为仍然对模型可见的价格留在 message 统计中；一条清空尾节点的 replace 也可能在更早的非空节点仍持有有效提示时把该统计打成 0。

## 决策

投影用一个小的有序列表（`systems: {seq, tokens}`）精确追踪存活的 system 节点，按每条 system 写入自身的价格以及 surface 溯源规则更新——`sourceEventSeqs` 覆盖所有被遮蔽节点，因此无论是提示维护还是压缩，任何 replace 都会让它遮蔽的条目退役。`systemTokens` 取最新的存活非空节点估值；message 统计为非 system surface fold 加上被取代条目的估值，与上游分类一致（有效提示入 system，其余存活可见价格入 message）。遮蔽被追踪节点的非 system replace 会将其估值结转入 message 累加器，使 fold 的保值契约在 claimed 与 unclaimed 两种 replace 下都跨桶一致。

## 备选方案

**用最后一条事件的估值推导 system 统计。** 这正是被移除的回归：它混淆了事件顺序与节点存活。

**像已退役的逐节点 fold 那样每次事件重估整个 surface。** 否决：基于 claim 的 O(1) fold 是有意的 checkpoint 设计；只有 system 部分需要精确追踪，而它按存活 system 节点数有界，不随 surface 规模增长。

## 影响

`contextBreakdown` 状态升到第 3 版（checkpoint 中 `systems` 替代 `systemTokens`；wire 视图不变），冷会话需从其日志重折一次。三个统计量现在在投影可接受的所有序列下都与上游的组成规则一致。

## 验证

`packages/llm/token-meter/tests/context-breakdown-projection.spec.ts` 端到端钉住一条 in-history 链——追加、清空尾节点的 replace、以及遮蔽存活尾节点的计量压缩——外加既有的单 head 与 checkpoint 形状用例。
