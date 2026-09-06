# Agent Note：Session 迁移使用单一相邻 catalog

状态：已实现

[English](2026-09-06-session-format-catalog.md) | 中文

## 问题

Session provider 需要在读取事件体前对存储 header 分类，也需要一份确定性的 v0/v1 → v2 计划。如果 JSONL、Gateway 和 SQLite 各自复制版本判断，不同 provider 就可能出现一个接受而另一个拒绝同一代次的情况。

## 决策

`@deepseek-ai/dsh-session-format` 编译完整的相邻链，并提供只读 header 分类以及脱离原对象的完整 artifact 迁移。默认静态 catalog 声明 v0→v1 和 v1→v2。新代次在读取事件体前拒绝；旧代次必须经过每条声明的边。输入会被快照并冻结，catalog 不会写入存储。

当前 CoHarness 步骤保留现有事件词汇并推进代次标记。JSONL 已提供第一个 provider adapter：读取 v0/v1 body 时原子发布 `session.v2.*`，保留源 bytes，并在后续读取中优先最高代次。Gateway 和 SQLite 的物理发布、超出共享协调器的旧 payload 归一化以及 provider 备份仍由 adapter 负责，本纯包不会隐藏这些行为。

## 考虑过的替代方案

**让每个 provider 自己维护版本链。** 拒绝，因为独立链会导致拒绝和迁移行为分叉。

**在 header 列表时重写 artifact。** 拒绝，因为只读 header 操作必须保持无副作用，且在事件体验证前不能生成新代次。

**原样导入上游 Session 包。** 拒绝，因为上游发布版 header 和事件类型不是 CoHarness 的持久化约定；本包只保留可复用的规划机制，adapter 继续掌握本地语义。

## 结果

Provider 实现拥有统一的迁移规划器和稳定诊断类别。catalog 本身不写入存储；JSONL 负责自己的原子 successor（后继产物）发布，Gateway 和 SQLite 仍需要各自的发布与回滚实现。

## 验证

Catalog 测试覆盖只读 header 分类、新版本拒绝、相邻迁移、脱离原对象的输出、包级类型检查、依赖检查和 release 排序。
