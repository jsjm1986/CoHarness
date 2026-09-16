# Agent Note: 升级记录门禁与提交清单

Status: implemented

[English](2026-09-13-upgrade-records-gate.md) | 中文

## 问题

`upgrades/` 下的升级工作由对齐矩阵、清单和计划记录，但此前没有任何机制检查这些记录是否完整。一个上游提交覆盖静默为空的矩阵行，读起来与"审查后无动作"的行完全一样——alpha.1→rc.2 的增量有数百个提交，未被记账的增量事后无法审计。

## 决策

`pnpm run verify-upgrade-records` 对每个 `upgrades/alignment/UPSTREAM-ALIGNMENT-MATRIX-*.json` 与 `upgrades/manifests/UPGRADE-MANIFEST-*.json` 设卡，在 `run-gates.ts` 中注册为 `upgrade-records` 叶子。声明 `schemaVersion: 2` 及以上的记录必须携带审查元数据（`reviewDate`、baseline/target 的 tag 与 commit），且每行必须通过三种形式之一认领覆盖：枚举 `upstreamCommits`、上游路径前缀 `commitScope`，或显式 `noUpstreamCommitReason`。`released` 审查状态额外要求 `evidence` 字段。更早的 schema 代次保持冻结形态，仅校验为可解析对象；每个清单仍要求 `upgrades/plans/` 下的同名计划文件。

`scripts/gen-upstream-commit-inventory.ts` 写出 `upgrades/alignment/UPSTREAM-COMMIT-INVENTORY-<tag>.json`：同步 baseline 与目标 tag 之间的每个非合并提交，按 sovereignty 清单分桶——`carried`（触及 tracked/adapted/replaced 包）、`newUpstream`（触及清单完全未收录的包）、`upstreamOnly`、`owned` 或 `none`。门禁将清单与同 tag 矩阵交叉核对：每个 `carried` 或 `newUpstream` 提交必须被某行的 `upstreamCommits` 认领或落入某行 `commitScope`，使任何触及已携带代码的上游变更都无法逃过记录决策。

## Alternatives considered

- 要求每行都枚举提交：不采用——领域级行覆盖数十个提交，`commitScope` 一次声明路径域，由清单交叉核对验证覆盖为真。
- 用 v2 schema 校验历史记录：不采用——历史记录是其代次的冻结证据，门禁严格性只适用于 v2 起。

## 后果

- 新升级目标无法再随记录静默跳过上游领域：要么每个触及已携带包的提交都被认领，要么门禁点名未认领提交而失败。
- `pending-*` 审查状态保持合法但显式，使诚实的进行中状态与已审查完成可区分。
- 重分类 sovereignty 或选择新目标 tag 后需重新生成清单；过期清单会让同 tag 矩阵配对检查失败。

## 验证

- `verify-upgrade-records.spec.ts` 覆盖行字段校验、三种覆盖形式、released-evidence 强制、历史 schema 放行，以及含 `newUpstream` 提交的清单覆盖。
- 对已入库记录运行门禁，报告每行均携带提交覆盖或显式原因。
