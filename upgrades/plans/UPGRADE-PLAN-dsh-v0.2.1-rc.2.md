# CoHarness → dsh-v0.2.1-rc.2 升级计划

## 状态、目标与证据

- 基线：`06614fcfd3300b2f628f58319f65c143c62feb63`（master，含 PR #312 载荷修复）；目标 `dsh-v0.2.1-rc.2`（`687f282e8625c6b8d11ff58211a90524be2e4317`）。
- 窗口规模：2,112 提交 / 1,622 非合并 / 848 触碰携带包 / 395 个 area / 9,323 累计变更路径。
- 已落台账：[提交清单](../alignment/UPSTREAM-COMMIT-INVENTORY-dsh-v0.2.1-rc.2.json)、[对齐矩阵](../alignment/UPSTREAM-ALIGNMENT-MATRIX-dsh-v0.2.1-rc.2.json)、[上游审计](../alignment/UPSTREAM-AUDIT-dsh-v0.2.1-rc.2.md)、[清单](../manifests/UPGRADE-MANIFEST-dsh-v0.2.1-rc.2.json)；`verify-upgrade-records` 已通过（21 份记录）。
- 中间审查承接：alpha.2 逐提交审计与 alpha.4 发布说明台账已覆盖窗口前半段的移植判定，本窗口内已逐条落地的移植不重复审查，但目标基线仍按 rc.2 全量对账。

## 审计方法与交叉验证

机制面已源码级核定（详见审计）：loader/patch 语义零漂移、vendor 已同步至 rc.2 等值、检查器仅缺 `engines.dsh` 分支、三个自有插件挂载点全部存活。剩余工作为包级对账：tracked 冲突 53 包逐文件核、adapted 行按矩阵 commitScope 逐条判定、13 个降级包与 41 个新增包逐个处置。

## 已锁定的实施决策

1. `session/tool-working-directory`、`session/working-directory` 为 upstreamShadowed 的 fork-owned 行，status=reject，永不与上游同键包文件级归并（清单决策 `shadow-*`）。
2. `plugin-compatibility.ts` 吸收 `engines.dsh` 分支；vendor cordis 升 4.0.5（纯版本 bump，无 src 差）。
3. 插件市场四包与 remote-access 等新能力的携带与否属业主决策，在所属相位登记。
4. 13 个 experimental 降级包逐包决定跟随降级或原位携带；`invariants`/`session-title-all-prompts-llm` 的上游别名摘除在 P1 编译面处理。
5. CI 演进（parallelism.ts、coverage 分区改造、`check:ci:unit`、pnpm 11.28.5、action pin bump）属门禁面，在 P1 与其所属相位按 replay 笔记吸收。

## 范围和变更纪律

- 只吸收上游演进与已批准的适配，不顺手重构 fork-owned 面。
- 每行处置（port/reject/defer）登记回矩阵 `reviewState` 与清单 decisions；`verify-upgrade-records` 与 `verify-upstream-sovereignty` 必须保持绿。
- snapshot/e2e/生产验收沿用既有台账口径，登记到矩阵与本计划执行记录。

## 阶段、依赖与放行条件

| 相位 | 内容 | 放行条件 |
| --- | --- | --- |
| P0 | 台账：清单、矩阵、审计、manifest、replay 复审 | 本计划 + 双门绿（已完成） |
| P1 | 编译地基：CI 基础设施改动（parallelism/coverage 分区/runner/action pin）、vendor 版本 bump、`engines.dsh` 检查器、pnpm 版本、tsconfig/vitest 别名演进 | `pnpm run build`、`pnpm run typecheck`、变更门禁 spec 全绿 |
| P2 | tracked 冲突 53 包逐文件对账；adapted 行逐条判定 | 每行 reviewState 登记；相关包测试绿 |
| P3–P8 | 按依赖推进 llm→session→composition→client→apps→experimental；含降级包处置与新包携带决策 | 各相位登记验证命令与结果 |
| P9 | 收口：全门禁、快照重录、生产部署验收 | `verify-upgrade-records`/sovereignty/全套 run-gates 绿 + 生产 healthz |

## 风险单列

- 上游同键包扩散：除已遮蔽两包外，新增包再撞 fork-owned 名时需同样走 upstreamShadowed 流程。
- CI 演进与本地门禁脚本交互（parallelism/coverage 改造影响 run-gates.spec 断言面），P1 需重跑受影响 spec。
- hooks/webhook 降级若不跟随，需保持原位包持续通过主权门；若跟随，bundle/文档双侧同步改名。

## P0 执行记录

- 2026-10-19：清单 1,622 commit / 矩阵 395 行 / 30 gate replay（23 条变更逐条复核登记）/ 审计与 manifest 落地 / `verify-upgrade-records` 通过（21 份记录）。

## P1 执行记录

已完成（提交在 `upgrade/dsh-v0.2.1-rc.2`）：

- `a6d2a03`：`engines.dsh` 兼容性检查（上游 `plugin-compatibility.ts` 直取）+ `peers`→`requirements` 改名传遍 plugin-manager 类型/操作/失败映射、web 与 gateway admin-ui 渲染及双语文案、api-catalog 重生成。
- `1ff3fb8`：cordis publish 版本 4.0.4→4.0.5（rc.2 窗口内 vendor 唯一变更，src 零差）。
- `334feeb`：`scripts/parallelism.ts` 直取（LOCAL_PARALLELISM_CAP=12 / TEST=48，CI 用全核）+ run-oxlint 归并（cpus 参数、本地预算绑定、调用方 `--threads` 透传；保留我方 CI=1 拼写与 fix/unused-disable 道）+ `actions/cache`→v6.1.0 批量 pin + benchmark timeout 15→20m。
- `81484f4`：`release/publish.ts`、`publish-npm-baseline.ts` 直取（dist-tag 校验 + 通道核验）；根 devDeps 加 `semver@^7.8.5`/`@types/semver@^7.8.0`，pnpm→11.28.5、smol-toml→^1.9.0；pyproject 吸收 Pillow==12.3.0 + core-metadata 2.4（ruff 保留——我方 ci.yml 仍跑 quality 组；license 保 Apache-2.0 不回退 MIT）。
- `651c4da`：timeout 注入路径切换为上游语义——`coverageTestTimeoutOptions`/`parseCoverageTestTimeout` 进 config 内联 project（CLI 不转发 hookTimeout/poll），`coverageTestTimeoutArgs` 及其三个调用点（run-gates 双道、run-coverage-partitions）移除；vitest 根道挂 `localWorkerBudget`（本地 maxWorkers≤48，CI 保 Vitest 默认）。我方 `coverage-policy.ts`/`coverage-scoped.ts`/`test-invariants.ts` 抽象层保留——上游内联重构不覆盖。

P1 剩余：

- `coverage-partitions.ts` 剩余：`vitest list` 改 JSON 清单（我方 parseListOutput 仍解析文本行）、`.coverage-times.json` 时长史 reporter——我方已有自有 `COVERAGE_TIMINGS_FILE`/`coverageTimingCacheKey`/`readFileDurations` 实现，需对账是否等价或上游新增独有逻辑。
- `vitest.config.ts` 剩余：`resolvePwshPath` 探测接入（上游用其实现 pwshCoverageExclusions）；`test-invariants.ts` 上游已删但我方有 +14 行自有不变量——保留决策；`sourcePlaneAliases`→`claudeCodeTestingAliases` 改名跟随与否。
- `run-gates.ts`/`.spec`：加 `ci-unit` 模式、`ConcurrencyDefault` 导出（带诊断来源）、parallelism default 接入 `defaultConcurrency`、sharedHygieneGates；我方 +191 行 CoHarness 车道逐条保留。
- `ci.yml`：`.coverage-times.json` restore/save 缓存步骤（先核对——我方时长史系统已存在，ci.yml 可能已有等价缓存）；`sandbox.yml`：check:ci:unit 道（依赖 run-gates ci-unit）。
- `package.json` scripts / `tsconfig.base.json`：上游 ±200 行别名面改动多数挂在未携带包上，随各包携带相位吸收。
- `gen-third-party-notices.ts`：inspector devtools 披露 import 依赖 P8 的 inspector 携带决策；examples//yao-pkg/ruff 条目上游删除均不适用于我方现状。
