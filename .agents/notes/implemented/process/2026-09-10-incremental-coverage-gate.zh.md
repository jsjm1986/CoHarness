# Agent Note: 增量 coverage 门禁

Status: implemented

[English](2026-09-10-incremental-coverage-gate.md) | 中文

## 问题

仓库完整 coverage 门禁有意保持严格，但小范围源码改动和全仓库改动会运行同样庞大的插桩测试图。需要更快的 PR 路径，同时不能让未导入或覆盖不足的变更源码静默通过。

## 决策

`scripts/incremental-coverage.ts` 及其测试为增量 PR 门禁提供覆盖率校验。该工具通过与全量覆盖率相同的策略选择变化的运行时源码，规范化 Istanbul 数据键，拒绝缺失的应测文件，并要求行、语句、函数和分支覆盖率均为 100%。纯类型语法从源码派生，不视为运行时数据缺失。公开命令为 `test:coverage:incremental`。

本次不替换或放宽完整 coverage lane。CI 在 `ci-coverage-scoped` 聚合中接入该工具（见[增量 CI lane 分级](2026-09-10-incremental-ci-lane-gating.zh.md)）：先运行变更包的测试，再把 merge-base ref 与生成的 coverage map 传到这里，获得权威的变更文件判定。全量改动和 baseline 维护仍以完整 lane 为准。

## Alternatives considered

**只运行 Vitest 选定测试并依赖其阈值。** 不采用：没有测试导入的变更文件可能不进入 coverage map，从而绕过每文件阈值。

**降低 PR 全局阈值。** 不采用：这会允许变更源码回退，并隐藏而不是隔离 coverage 债务。

**删除完整 coverage lane。** 不采用：完整 lane 仍是全仓库回归信号，当范围很广或变更文件 map 不可信时必须运行。

## Consequences

小范围源码变更获得确定的逐文件覆盖率验证工具，完整覆盖率约定保持不变。CI 显式传入合并基线路径集和最终覆盖率数据；输入缺失时失败。

## Tests

`pnpm exec vitest run scripts/incremental-coverage.spec.ts` 通过，共六个测试，覆盖源码选择、路径标准化、map 缺失、coverage 不足和空输入。

[候选提交绑定的证据决策](2026-09-21-candidate-bound-gate-evidence.zh.md)扩展消费方选检和发布验收，同时保留本注记的覆盖率与版本规则。
