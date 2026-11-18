# Agent 笔记：OAR 单次子智能体通道的吸收

Status: implemented

[English](2026-11-15-subagent-oar-absorption.md) | 中文

## 问题

上游 v0.2.2-rc.3 提供了基于 OAR 的单次外部子智能体通道：`experimental/subagent-oar` 注册由 `@botiverse/oar` 运行时注册表支撑的具名提供方，`experimental/tool-subagent-oar` 暴露为每次调用选择一个已配置提供方的 `subagent_oar` 工具。本分支的子智能体服务没有 `startActivation` 入口：它通过 `ctx.subagents.start` 发布单次运行，通过 `establishExternalCatalogChild` 记录外部子任务，并通过 `ctx.jobs` 后台作业通道交付最终结果。上游的激活语义——已提交的同级名称、激活管理器的结算与父智能体交付——因此需要刻意移植，而不是照搬。

## 决定

- 两个包均以 adapted 方式携带。`subagent-oar` 源码原样落地：它使用的本地 `out-of-process.ts` 辅助函数（`NO_START_CAPABILITIES`、`assertPositiveFinite`、`assertUsableCwd`、`settleRunResult`、`subprocessRunHandle`）与上游同源，因此只需在测试调用点补上本地 `ResolvedSubagentStartRequest` 要求的 `descriptor` 字段。
- 将 `tool-subagent-oar` 移植到本地通道：工具在自身范围内保留同级名称，将 `ctx.subagents.start` 作为发布边界等待（目录事实在 `start` 内部落地，与上游的名称提交顺序一致），然后把已发布的运行注册为调用方拥有的 `subagent` 作业。作业负责终止请求与最终记录；`dsh-tool-jobs` 送达结算通知，`job_output` 返回最终答复。结算中失败的清理通过 `ctx.subagents.retainFailedCleanup` 交回，由同一父智能体重试。
- 名称在工具内保留：本通道不向目录的 version-3 已提交名称字段（由[具名树寻址](2026-11-15-named-subagent-tree-addressing.zh.md)加入）写入名称，因此声明只覆盖此工具为该父智能体起过的名称，并已记录为限制。模型看到的 `agent-N` 默认序列不变。
- 从上游移植 `packages/subagent/subagent/tests/external-activation-helpers.ts`：`startActivation` 变为 `ctx.subagents.start`，返回类型变为 `SubagentRun`，`Agent` 桩移除上游专有的 `model` 字段和 `unsupportedModel` 导入。
- 将 `@earendil-works/pi-ai` 和 `pi-coding-agent` 固定到 `1.3.0`，并对 OAR 的传递 pi 依赖做作用域覆盖，使携带的 `pi-ai@1.3.0` 补丁（流式工具调用解析修复、Gemini 思维签名）真正生效；浮动的 `^1.3.0` 会解析到 1.5.2 并静默丢失补丁。`@botiverse/oar@0.67.0` 保持 devDependency——`tsdown.config.ts` 将其打包进 `lib/index.js`，使产物自带打过补丁的运行时，无需外部 OAR 可解析。
- 两个上游补丁都在 `pnpm-workspace.yaml` 中注册（`patchedDependencies`、`minimumReleaseAgeExclude`）。本分支的 `dsh-llm-pi-ai` 保持在打过补丁的 `1.1.0`；两个版本以不同补丁哈希共存。

## 后果

- 在实验性组合中，Codex 与 Claude Code 的单次委派可通过 `subagent_oar` 工具到达；OAR 的其他默认运行时也可被选择，但只有上游的覆盖。
- 父智能体可见的交付是作业通道：模型通过 `job_output` 读取答复；没有 `ctx.jobs` 的组合在调用时失败——工具 README 已记录该要求。
- 同级名称唯一性只在此工具为同一父智能体创建的子任务之间成立；其他委派路径记录的 version-3 已提交名称不会被检查。
- `experimental/subagent-oar` 将 pi 包固定在 1.3.0，而 `dsh-llm-pi-ai` 保持 `^1.1.0`；提升发布包的 pi 下限是单独的决定。

## 考虑过的替代方案

- 否决移植上游的 `startActivation` 管理器：运行租约加作业结算就是本地等价物，再叠一层激活层会为同一生命周期不变量制造第二个所有者，而服务已在其上强制这些不变量。
- 当时否认为父目录增加已提交名称字段：名称只是目录不消费的展示别名，为这条通道的范围做 schema 版本更迭得不偿失，工具内声明即可。[具名树寻址](2026-11-15-named-subagent-tree-addressing.zh.md)随后将该字段以 catalog version 3 落地于本地可继续通道；本通道保留工具内声明，因为尚未对已提交名称做去重。
- 否决接受未打补丁的 `pi-ai@1.5.2`：流式修复是否已并入上游未经证实，且 1.3.0 加补丁的组合才是上游针对 OAR 0.67.0 验证过的。

## 验证

- `npx tsc -b packages/experimental/subagent-oar packages/experimental/tool-subagent-oar` — 干净。
- `npx vitest run packages/experimental/subagent-oar packages/experimental/tool-subagent-oar` — 38 个单元测试通过（提供方 31、工具 7）。
- `npx vitest run --config vitest.e2e.config.ts packages/experimental/subagent-oar` — 5 通过（原生启动清理、环境擦除、Loader 组合），6 按设计跳过（`DSH_OAR_E2E` 与 `DSH_OAR_NATIVE_PERMISSIONS` 门槛，以及未构建 `lib/` 时的 packed-artifact）。
- `npx oxlint packages/experimental/subagent-oar packages/experimental/tool-subagent-oar` — 干净。
- `npx tsx scripts/verify-export-jsdoc.ts`、`verify-translation-pairing`、`verify-upstream-sovereignty`、`verify-agent-note-format` — 干净。
