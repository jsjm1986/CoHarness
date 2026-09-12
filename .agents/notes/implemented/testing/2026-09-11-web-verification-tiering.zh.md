# Agent Note: 按变更影响分层的 Web 浏览器验证

Status: implemented

[English](2026-09-11-web-verification-tiering.md) | 中文

## 问题

[必需的 Web 浏览器门禁](2026-07-30-web-browser-snapshot-ci-gate.zh.md)在任何一个浏览器渲染包变更时，都会在 PR consumer 聚合内运行完整的 `apps/web/tests` 库存；除此之外不运行任何浏览器工作。单个 UI 插件的改动也要支付完整库存，而且"不跑浏览器"与"全部约 94 个场景"之间不存在任何层级，无法向 CI 要求"受影响业务域加稳定启动检查"。

## 决策

`scripts/web-test-policy.json`（版本 1）把浏览器表面划分为八个业务组：shell、conversation、workbench、documents、settings、subagent、mobile、lifecycle。`scenarios` 的键是相对于 `apps/web/tests/` 的路径——递归发现的每个 `*.e2e.ts` 与 `*.snapshot.ts` 文件（`snapshots/` 除外）恰好映射到一个组；浏览器渲染包映射到一个组、多个组或 `all`，组列表内出现 `all` 会被拒绝，须改用裸字符串。映射与磁盘之间的双射由 `scripts/web-test-policy.spec.ts` 强制执行。

`scripts/ci-pr-scope.ts` 把 `snapshot_mode` 扩展为 `skip | scoped | focused | full`。`scoped` 保留无键 ACP/CLI 快照且不做浏览器工作；`focused` 追加变更浏览器包、场景文件与被引用 golden 各自所属的组，外加始终存在的 smoke 集（vite-entry、shipped-composition、scaffold-hermetic、cold-blank-session、built-boot）；`full` 追加完整库存。在 `apps/web/tests/` 下，场景文件路由到所属组，签入的 golden 路由到属主扫描归属于其目录的全部场景所在组，inert 文档不产生任何贡献；没有任何场景引用的 golden 目录与场景表之外的共享 fixture 回退到 `full`。完整触发条件是已证实的可达性：Web 应用源码、public 与 stress 树，client runtime/connection/modules/web（Loader）、`packages/api/`、extensions、Typert、apiproxy fetch 载体、依赖与锁文件编辑、Web lane 基础设施文件，以及分类器已证无关类别之外的任何路径。未映射的浏览器渲染包回退到 `full`，因此策略缺口永远不会静默跳过验证。

浏览器 lane 从 `node-24-consumers` 移入始终存在的专用 `web-verification` PR job，固定检查名 `web verification` 使分支保护可以要求它；所选层级与组写入 job 摘要。`skip`/`scoped` 记录选择原因并直接通过；`focused` 以两个 worker 重放所选组；`full` 重放完整库存。无键 consumer 聚合在 `scoped`、`focused`、`full` 三种模式下完全相同，master/nightly 的 web-snapshot-sweep 工作流在每次合并后仍然重放完整库存。

`scripts/run-web-snapshots.ts` 新增 `--focused` 配合 `--groups`（argv）或 `DSH_WEB_GROUPS`（env，CI 通道）：选择集为各组场景加 smoke 集，先运行串行属主，其余进入有界并发池。`pnpm run test:web:focused` 与 `test:web:full` 取代 `test:web:ci`，`check:ci:web:focused`/`check:ci:web:full` 聚合先运行完整的 `pnpm run build`（Web bundle 加 client 构建记录）再执行浏览器运行。CI 仍然只以 `DSH_SNAPSHOT=replay` 重放；record 与 refresh 仍是显式的本地工作流。

## 已考虑的替代方案

**在每个浏览器相关 PR 上保持完整库存。** 现状不需要策略文件和组词汇表，因此不会误路由任何变更。它落败是因为叶子插件编辑——最常见的 UI 变更——为一个业务域支付整个库存，而唯一的逃逸路径是完全跳过浏览器验证。

**仅从包目录推导聚焦组，不维护场景表。** 包到组的映射约占策略体积的一半，而且目录正是 diff 直接给出的信息。它落败是因为真正运行的是场景而非包：没有场景表，就无法机械地证明每个场景都能被某个选择集覆盖，共享 UI 包也无法路由到真正覆盖它们的场景集。

**让每个测试文件在源码中声明自己的组。** 把映射放在测试旁边省去了独立文档，被移动的文件也会带着组一起走。它落败是因为消费方是 CI scope 分类器，后者读取一个版本化的数据文件而不解析 TypeScript 源码；带外注释会静默腐化，而策略双射测试会大声失败。

## Testing

`scripts/web-test-policy.spec.ts` 固定策略文档：与 `apps/web/tests/` 下递归发现结果的场景双射、golden 目录归属（每个 golden 都有引用它的场景，且每个归属属主都在场景表内）、非空组、smoke 集在每次聚焦选择中的成员关系，以及加载器校验失败路径。`scripts/ci-pr-scope.spec.ts` 固定层级选择，包括场景与 golden 路由、完整触发条件与已证无关类别。`scripts/ci-workflow.spec.ts` 固定工作流形态：固定检查名、无键 consumer 步骤、按模式分支的 `web-verification` 步骤，以及聚合判定依赖。`scripts/run-gates.spec.ts` 固定 Web 聚合在浏览器门禁之前只运行一次完整构建。

## 后果

本文档部分取代[必需的浏览器 CI 门禁笔记](2026-07-30-web-browser-snapshot-ci-gate.zh.md)：其中仅重放规则、worker 隔离与串行属主理由仍然是权威；其在 consumer job 内运行完整浏览器套件的位置安排被分层 lane 取代。共享表面（`ui-primitives`、`ui-renderer`、`ui-layout`、`ui-slots`、`ui-theme`、`locale`）映射到 `all`，会选择整个库存——focused 是路由决策，不是规模折扣。slot 被多个组的场景触及的共享包（`ui-commands`、`ui-collaboration`、`ui-deliverables`、`ui-sidebar`、`ui-open-in-app`、`ui-trajectory`、`ui-workspace`）映射到每一个这样的组，而非 `all`。新增场景必须登记策略条目，否则双射测试失败；未映射的新浏览器渲染包升级为 `full`，而不是跳过验证。
