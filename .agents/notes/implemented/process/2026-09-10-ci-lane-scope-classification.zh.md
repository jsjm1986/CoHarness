# Agent Note: CI 门禁范围分类

Status: implemented

[English](2026-09-10-ci-lane-scope-classification.md) | 中文

## 问题

当前 PR scope 只返回一个 `run_expensive` 结果，但仓库实际运行多类检查。这会让文档和 action-only 改动看起来像完整产品验证，也让聚合状态难以解释。现有分类器还必须对源码和依赖改动保持 fail-closed。

## 决策

PR scope 分类器除了原有的 `run_expensive` 和 `reason` 外，现在还返回变更源码路径、变更包配置路径、是否仅文档，以及 coverage 和 snapshot 模式。CI scope job 暴露这些值，成功的聚合结果也会打印这些信息。

分类器继续对未知路径采用 fail-closed，同时区分独立影响域。Session、Cordis、Typert、Gateway、LLM、子代理、sandbox、subprocess、terminal、vendor、native 和 client-connection 路径始终使用完整运行时库存。模型可见的 skill 和 preset 输入属于运行时输入，不属于无关文档。Gateway 和 Gateway admin UI 改动通过 `gateway_mode` 与 `admin_ui_mode` 选择独立 npm 检查。

消费者聚合将兼容性 smoke 设为只读源码模式，因为该聚合自己拥有编译检查所消费的唯一构建。合并后的浏览器 sweep 使用与 PR consumer lane 相同的有界 gate、snapshot 和 typecheck 设置。Release 工作流只在发布相关路径变更时运行，并取消已被新提交取代的 PR 打包；Sandbox 保留 native 路径、nightly 和手动运行。

## Alternatives considered

**立即用多个独立 job 条件替代 `run_expensive`。** 不采用：同时改变 job 图和分类器会让报告改动与验证策略改动难以区分。

**把所有依赖改动都视为非阻塞。** 不采用：依赖和 lockfile 改动可能改变包解析、构建产物和运行行为，因此继续运行完整 lane。

**只从最终聚合 job 推断失败类别。** 不采用：聚合结果无法说明本次范围是纯文档、包含源码还是包含依赖。

## Consequences

CI 现在记录了独立 lane 选择所需的 scope 元数据，并为共享运行时 seam 保留完整库存。聚合仍会因每个被选中的 required job 失败；只有分类器明确选择模式时才接受 skipped job。现有 workflow 结构测试继续保护 blocking job 集合和 fork/Dependabot 的 fail-closed 条件。

## 测试

`pnpm exec vitest run scripts/ci-pr-scope.spec.ts scripts/ci-workflow.spec.ts scripts/run-gates.spec.ts scripts/incremental-coverage.spec.ts` 通过，覆盖 action-only、文档-only、模型输入、共享运行时、Gateway 和源码/依赖 scope 分类，以及 gate 图和严格 coverage map 解析。
