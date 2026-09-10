# Agent Note: 增量 coverage 门禁

Status: implemented

[English](2026-09-10-incremental-coverage-gate.md) | 中文

## 问题

仓库完整 coverage 门禁有意保持严格，但小范围源码改动和全仓库改动会运行同样庞大的插桩测试图。需要更快的 PR 路径，同时不能让未导入或覆盖不足的变更源码静默通过。

## 决策

新增 `scripts/incremental-coverage.ts` 及其测试，作为增量 PR 门禁的第一块基础。工具会计算变更的 package 源码文件，统一 Istanbul coverage map 的绝对/相对路径，拒绝不在 coverage map 中的变更源码，并要求每个选中文件的 lines、statements、functions、branches 均为 100%。package script 为 `test:coverage:incremental`。

本次不替换或放宽完整 coverage lane。CI 在 `ci-coverage-scoped` 聚合中接入该工具（见[增量 CI lane 分级](2026-09-10-incremental-ci-lane-gating.zh.md)）：先运行变更包的测试，再把 merge-base ref 与生成的 coverage map 传到这里，获得权威的变更文件判定。全量改动和 baseline 维护仍以完整 lane 为准。

## Alternatives considered

**只运行 Vitest 选定测试并依赖其阈值。** 不采用：没有测试导入的变更文件可能不进入 coverage map，从而绕过每文件阈值。

**降低 PR 全局阈值。** 不采用：这会允许变更源码回退，并隐藏而不是隔离 coverage 债务。

**删除完整 coverage lane。** 不采用：完整 lane 仍是全仓库回归信号，当范围很广或变更文件 map 不可信时必须运行。

## Consequences

小范围源码改动拥有确定性的变更文件 coverage 校验工具，同时完整 coverage 约束保持不变。未来 CI 接入必须显式传入 merge-base 路径集和最终 coverage map，任一缺失都必须失败。

## Tests

`pnpm exec vitest run scripts/incremental-coverage.spec.ts` 通过，共六个测试，覆盖源码选择、路径标准化、map 缺失、coverage 不足和空输入。
