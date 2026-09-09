# Agent Note：子代理最终输出向后扫描

Status: implemented

[English](2026-09-08-subagent-output-backward-scan.md) | 中文

## 问题

continuable 子代理结算时，即使后续非空 assistant message 已经决定最终输出，仍会折叠完整事件后缀。因此长子会话会重复构建不会影响结果的文本 delta。

## 决定

`finalAssistantOutput` 先从后向前寻找最后一条非空 assistant message，并立即返回。只有不存在非空 message 时，才保留现有的正向 fold，因为此时流式文本是回退输出。

## 考虑过的替代方案

**始终折叠完整后缀。** 不采用，因为常见的已结算 message 路径会重复工作并产生无用分配。

## 后果

结算保持相同的输出选择和回放行为，同时减少长 continuable 历史在已存在最终 message 时的额外分配。没有 assistant message 时，回退路径仍保持流式文本顺序。
