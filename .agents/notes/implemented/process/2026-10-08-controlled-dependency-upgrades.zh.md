# Agent Note: 受控的依赖升级

Status: implemented

[English](2026-10-08-controlled-dependency-upgrades.md) | 中文

## Problem

安装器更新影响使用 pnpm 的引导和打包路径。仅更新版本号的分类豁免可能省略这些路径，却仍得到绿色汇总。Vitest 的 mock 与 coverage 包共享测试运行器的版本化 API；根 Vitest 为 4.1.8 时，单独提出 `@vitest/spy` 5.0.0 升级（#261）会混用该家族。每日独立提案同样需要明确的仓库评审容量。

## Decision

[`scripts/verify-dependency-cohorts.ts`](../../../../scripts/verify-dependency-cohorts.ts) 读取 `pnpm-lock.yaml` 的 importer 表，任何直接声明的 `vitest` 或 `@vitest/*` 条目解析到与根 `devDependencies.vitest` 不同的版本即拒绝（忽略 peer 依赖后缀）。该校验在 `pnpm run constraints` 内执行，并作为独立的 `pnpm run verify-dependency-cohorts` 步骤运行于 `ci.yml` 的 `pr-scope` job 中——位于分类器运行时安装之后、scope 分类之前，因此家族漂移会在 lane 选择前失败。

仅含安装器更新的 diff 会选中其运行时和平台消费者。[`scripts/ci-pr-proofs.ts`](../../../../scripts/ci-pr-proofs.ts) 根据改动路径确定必需的验证，而不依赖候选计划的 `reason` 字段。对不受信任的执行者，绑定凭据的验证明确标记为 withheld。冻结基线保留历史 `action-only` 原因供比较；默认的 `shadow` 执行将其分类与当前候选分类合并。

[`.github/dependabot.yml`](../../../../.github/dependabot.yml) 定义每周版本更新计划、分生态 Pull Request 限额，以及 `vitest` 与 `bundled-pnpm` 更新分组。Vitest 家族、pnpm 和 `@vitejs/plugin-react` 的主版本升级需要经过评审的迁移；不相关的主版本仍可提出。`pnpm/action-setup` 仅暂留精确版本 `6.1.0`，等待 macOS Intel 引导验证（#254），并非否定整个 6.x 系列。6.0.10 同样会自更新 pnpm。

## Alternatives considered

- **停用 Dependabot 改手工升级。** 手工队列失去自动发现维护更新的能力，仍需要消费者验证。
- **新增独立的安装器验证 workflow。** 既有的 workflow-input proof 所属文件（`release.yml`、`release-vendor.yml`、`landlock-run.yml`、`sandbox.yml`）已覆盖安装器升级可能破坏的范围，新建 lane 只会重复。
- **把 `pnpm/action-setup` 6.1.0 永久定性为已证坏。** 当前证据只是待完成的 macOS Intel 验收，并非已确认的不兼容；暂留精确指向该版本，使 6.1.1+ 的提案按自身结果评判。

## Consequences

版本一致是前提，不是 API 兼容性的证明。每个选中的消费者都必须通过验证；因凭据而 withheld 的验证及不受支持的验证，仍明确记录为未执行。Vitest 家族升级必须一起更新所有直接声明的成员。

[按路径选择 PR CI](2026-09-06-path-gated-pr-ci.zh.md)和 [CI lane 范围分类](2026-09-10-ci-lane-scope-classification.zh.md)继续保留保守选检与独立通道报告的决策。本注记定义依赖分组、暂留与安装器验证要求。[打包 pnpm 的决策](2026-10-07-pnpm-is-a-bundled-runtime-component.zh.md)保留其独立的 JavaScript 分发要求。
