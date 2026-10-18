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
