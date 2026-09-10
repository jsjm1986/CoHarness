# Agent Note: 增量 CI lane 分级

Status: implemented

[English](2026-09-10-incremental-ci-lane-gating.md) | 中文

## 问题

任何改动源码或依赖的 PR 都会运行完整的昂贵 lane 集合：全量 coverage、含 Playwright 浏览器快照的完整 consumer 清单、release 形态 Python runtime，以及两个 Windows 信号。单文件 package 改动与全仓库重写付出相同墙钟时间，日常改动在它们不可能影响的面上浪费几十分钟。

## 决策

PR scope 分类器现在为"纯 package 源码与测试文件"的改动选择 `scoped` lane。当每个变更路径都是 `packages/<group>/<pkg>/src/` 或 `packages/<group>/<pkg>/tests/` 下的 `.ts`/`.tsx`，且涉及的独立包数量不超过 `MAX_SCOPED_PACKAGES`（4）时，该 PR 合格。其他任何情况——依赖、锁文件、基础设施脚本、apps、文档或更大的包集合——保持现有 `full` lane。

gate runner 新增两个轻量聚合：

- `ci-coverage-scoped` 只对变更包的测试目录运行 Vitest coverage，然后用 `scripts/incremental-coverage.ts` 对生成的 map 强制执行权威的逐文件 100% 门禁。中间 Vitest 运行期间全局逐文件阈值被禁用（`DSH_COVERAGE_SCOPED_MODE=1`），因为选定测试会导入它们从不完整覆盖的未变更包；增量门禁只对恰好变更的文件拥有判定权。
- `ci-consumers-scoped` 是完整 consumer 清单减去 Playwright web-snapshot gate。keyless ACP/CLI 快照、lint、publint、built invariants、doc-typecheck、node-next-types 与 built-bin smoke 仍然全部运行；只有浏览器级快照被去掉。

工作流对 coverage 与 consumer job 沿用现有 `run_expensive` 选择器（两条 lane 都会运行它们），并把 `python-runtime`、`windows`、`windows-native` 以 `coverage_mode == 'full'` 为条件，使 scoped lane 跳过它们。`all-checks-passed` 在每条 expensive PR 上要求 coverage 与 consumers，只在 full PR 上要求 runtime/Windows job。scoped lane 跳过 Playwright 安装。

## Alternatives considered

**只运行变更包测试并完全跳过 coverage。** 不采用：没有任何选定测试导入的变更文件会逃过逐文件门禁；增量 coverage 门禁让该检查保持 fail-closed。

**把 scoped lane 设为观察性（非阻塞）。** 不采用：该 lane 仍验证真实变更面的行为；只有变更不可能影响的面被跳过。

**用新 job 扩展既有 job 图而不是条件 step。** 不采用：复用 coverage/consumer job 加 mode 条件 step 可保持必需 job 集合与 `all-checks-passed` 聚合不变。

## Consequences

日常纯包改动现在以聚焦测试所需时间完成 coverage 与 consumers，而不是完整 lane 的墙钟；同时每个变更源码文件仍面对同样的 100% lines/statements/functions/branches 门禁。依赖、锁文件与基础设施改动不受影响，保持完整 lane（fail-closed）。工作流结构测试（`ci-workflow.spec.ts`）固定新的 `coverage_mode == 'full'` 条件与扩展后的 push-reachable allowlist。

## Tests

`pnpm exec vitest run scripts/ci-pr-scope.spec.ts scripts/run-gates.spec.ts scripts/ci-workflow.spec.ts` 通过。scope spec 覆盖 scoped 分类、metadata/infra 回退 full 与包数量上限；run-gates spec 覆盖 scoped coverage/consumer 聚合及其必需输入（`DSH_SCOPED_PACKAGES`、`DSH_INCREMENTAL_BASE`）；workflow spec 固定 lane 条件与 push-reachability。