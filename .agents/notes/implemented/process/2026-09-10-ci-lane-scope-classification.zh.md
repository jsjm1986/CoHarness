# Agent Note: CI 门禁范围分类

Status: implemented

[English](2026-09-10-ci-lane-scope-classification.md) | 中文

## 问题

当前 PR scope 只返回一个 `run_expensive` 结果，但仓库实际运行多类检查。这会让文档和 action-only 改动看起来像完整产品验证，也让聚合状态难以解释。现有分类器还必须对源码和依赖改动保持 fail-closed。

## 决策

PR scope 分类器除了原有的 `run_expensive` 和 `reason` 外，现在还返回变更源码路径、变更包配置路径、是否仅文档，以及 coverage 和 snapshot 模式。CI scope job 暴露这些值，成功的聚合结果也会打印这些信息。

本次新增字段只是解释性元数据：现有 blocking job 图和 `run_expensive` 决策保持不变。源码和依赖改动仍运行完整昂贵 lane；action-only 和文档改动继续使用现有跳过行为。本分类器不会把环境敏感 lane 改成非阻塞。

## Alternatives considered

**立即用多个独立 job 条件替代 `run_expensive`。** 不采用：同时改变 job 图和分类器会让报告改动与验证策略改动难以区分。

**把所有依赖改动都视为非阻塞。** 不采用：依赖和 lockfile 改动可能改变包解析、构建产物和运行行为，因此继续运行完整 lane。

**只从最终聚合 job 推断失败类别。** 不采用：聚合结果无法说明本次范围是纯文档、包含源码还是包含依赖。

## Consequences

CI 现在记录了后续实现增量 coverage 和 snapshot 选择所需的 scope 元数据，但本次不改变合并保护策略。现有 workflow 结构测试继续保护 blocking job 集合和 fork/Dependabot 的 fail-closed 条件。

## 测试

`pnpm exec vitest run scripts/ci-pr-scope.spec.ts scripts/ci-workflow.spec.ts scripts/run-gates.spec.ts` 通过，覆盖 action-only、文档-only、源码/依赖 scope 分类以及现有 gate 图。
