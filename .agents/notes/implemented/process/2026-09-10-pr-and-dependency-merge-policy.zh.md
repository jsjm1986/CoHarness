# Agent Note: PR、依赖与 stack 合并策略

状态：已实施

[English](2026-09-10-pr-and-dependency-merge-policy.md) | 中文

## 问题

CI lane 与 Dependabot PR 偏离了仓库既有的合并规范。大版本升级只因版本号本身被拦截，即使项目代码已干净适配；工具链升级却混进功能 PR。Stack 靠猜测 parent/child 依赖来合并，而不是核对 exact heads。结果是红灯 lane 反复、出现无法分类的 `all checks passed: fail` 判定。

## 决策

PR、依赖升级与 stack 遵循同一套显式策略：

- **PR 清单。** 每个 PR 携带 `.github/pull_request_template.md` 中的合并前清单：exact base/head SHA、focused tests 加 changed-source coverage、模型可见行为走 keyless snapshot/replay、baseline 与环境失败分类、snapshot 仅限显式 record 用密钥、stack 按 parent→child merge-forward、部署 PR 校验 release manifest/readiness/回滚/公网入口。
- **Dependabot 策略。** 版本升级以真实项目兼容性判定，而非升级幅度。patch/minor 在 blocking checks 通过且只剩已知 baseline 或环境 lane 时可合并。major 一律走独立迁移 PR，自带 typecheck、build、package、snapshot 与运行时验证；绝不只因 major 就被拒绝。工具链升级（`@types/node`、Vite 及同类）不混入功能 PR，单独开迁移 PR。
- **Stack / merge-forward。** Stack 按 parent→child 合并：先更新 parent，再沿链按 exact heads rebase/merge。只用官方 `gh stack` 能力或普通单 PR 合并；绝不手工猜测依赖关系。历史重写用 `--force-with-lease` 而非 raw `--force`；进行中的 merge-forward 在取更新 base 前先保存 checkpoint。
- **失败分类。** 任何合并前，每个失败 lane 都要归因到代码、生成物、模型 fixture 或平台环境之一；不能用“all checks passed”掩盖红色基线。

## 备选方案

**不加评审地拒绝任何 major PR。** 已拒绝：上游会发布破坏性更新，fork 必须跟进；版本号本身无法预测项目代码兼容性。

**靠分支名合并 stack。** 已拒绝：分支名不是可信的依赖图，只有 exact head/base SHA 校验才可靠。

## 影响

Dependabot 与工具链 PR 被引导到迁移评审，而不是因版本标签被关闭。Stack 合并通过重跑同一套已验证的 head/base 序列保持可复现。PR 模板给了评审者一个统一位置，确认改动表面确实被验证过、剩余红灯 lane 是已分类的 baseline 而非隐藏的代码失败。

## 测试

无行为代码改动；该策略由既有 CI lane 分类（`scripts/ci-pr-scope.ts`）、增量 coverage（`scripts/incremental-coverage.ts`）与 snapshot record preflight（`scripts/snapshot-preflight.ts`）门禁落地，这些门禁已由各自 spec 与 CI workflow 测试覆盖。
