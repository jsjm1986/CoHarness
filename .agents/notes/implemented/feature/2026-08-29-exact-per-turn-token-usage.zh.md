# Agent Note: 为完整轮次展示精确 token 用量

Status: implemented

[English](2026-08-29-exact-per-turn-token-usage.md) | 中文

## 问题

Session 级 token 总量无法回答单个轮次的成本，尤其是在失败的提供方请求发生重试时。从可见消息重建会漏掉已计费的 attempt，也可能把估算值呈现为精确用量。

## 决策

适配器保留可选的精确 `TokenUsage.totalTokens`：DeepSeek 只在安全的 prompt／completion 计数与 wire 总量一致时推导，pi-ai 原样传递其精确总量。浏览器安全的 token-meter fold 只接受完整的持久轮次生命周期，在 retry 边界上对每个已开始 attempt 计数一次；用量缺失、不安全或矛盾时返回空值。只有每个 attempt 都提供时，才显示可选 cache、reasoning 和 route 字段。已完成轮次 footer 渲染紧凑 disclosure 和可展开的精确明细；它不会改变 session log 或模型请求。

## 备选方案

**相减相邻的 Session 级投影总量。** 不予采用：分页窗口、压缩、重试替换和无关的后续 step 会使相减含义不明确。

**估算缺失 attempt。** 不予采用：UI 标注的是提供方记账而不是启发式压力，部分估算会看起来像精确值。

**只统计已定稿 assistant 消息。** 不予采用：错误 attempt 可以在重试前报告用量，并且仍然产生计费。

## 影响

记账完整的已完成轮次会显示精确总量、cache 份额、路由归因和可选 reasoning 明细。证据不完整的轮次不显示 disclosure，避免误导。Session 级投影与 Gateway 计费保持不变。

## 测试

适配器测试覆盖精确总量与矛盾的 DeepSeek 总量。纯 fold 测试覆盖最终样本替换、重试、多 step、可选 bucket、不安全值和不完整生命周期。浏览器测试覆盖紧凑与精确格式化、展开、字段省略、不会把部分命中取整为 100 的 cache 百分比，以及键盘操作。
