# Agent Note: Index projection restore tails without copying

Status: implemented

[English](2026-08-30-index-projection-restore-tail.md) | 中文

## 问题

冷启动 projection restore 接收一段连续事件后缀和 checkpoint 水位。为了折叠水位之后的事件而创建第二个数组，会在每个 projection unit 上额外分配内存并完整扫描一次，尽管后缀索引已经能确定第一个要折叠的事件。

## 决策

`SessionProjectionRegistry.restore` 计算 `startIndex = checkpointSeq - baseSeq + 1`，直接遍历传入后缀。checkpoint 有效性检查保持不变，因此缺失、陈旧或越界行仍会触发相同的全量读取回退；只移除了临时后缀数组。

## 考虑过的替代方案

**保留 slice 以便可读。** 不采用：大型冷会话会为每个 projection unit 承担可避免的分配。

**信任事件 seq 并用条件扫描跳过前缀。** 不采用：持久化契约已经保证后缀连续，直接用索引更便宜，也明确表达了输入前提。

**同时改变 checkpoint 有效性或 restore 语义。** 不采用：物理恢复行为必须保持独立可审查且字节兼容。

## 影响

冷 restore 保持原有状态和错误行为，同时减少临时数组和重复比较。调用方仍必须按 restore 契约提供从 `baseSeq` 开始的连续后缀。

## 测试

已有 projection restore 与 SQLite/cache 往返套件覆盖空后缀、带 checkpoint、陈旧行和全量回读路径；本优化只改变这些场景上的遍历方式。
