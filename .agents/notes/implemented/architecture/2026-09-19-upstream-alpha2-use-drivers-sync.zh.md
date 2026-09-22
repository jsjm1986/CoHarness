# Agent Note：上游 alpha.2 use-driver、MCP 与不变式伴随同步

Status: implemented

[English](2026-09-19-upstream-alpha2-use-drivers-sync.md) | 中文

## 问题

DeepSeek Harness `dsh-v0.1.6-alpha.2` 引入了 browser-use/computer-use 驱动包族、auto-review 能力、MCP client 重写，以及一条包不变式政策——仅在包拥有运行时可观测关系时才发布 `./invariant`。CoHarness 需要驱动与 MCP 能力面，同时保留其有界拆卸（bounded-teardown）取消语义与本地包集合。

## 决策

九个驱动与评审包——`browser-use`、`browser-use-runtime`、`browser-use-chrome-devtools-mcp`、`browser-use-playwright-mcp`、`browser-use-stagehand-native`、`computer-use`、`computer-use-cua-driver-mcp`、`computer-use-cua-driver-native`、`auto-review`——连同 `mcp-client`/`mcp-resources`/`http-proxy` 同步按上游原文落地，并恢复上游 snapshot 夹具、e2e 支撑模块，以及覆盖 terminal-io 套件的私有 `benchmarks` 工作区。`agent-team` 与 `tool-agent-team` 依据 `PRIVATE_EXPERIMENTAL_PACKAGE_DIRECTORIES` 保持私有；其余实验包按上游政策默认公开。

仅一行测试刻意分叉。上游 auto-review spec 直接以 `iterator.next()` 驱动 `adapterStream`，因此忽略 abort 信号的夹具 adapter 仍会产出 decision，工具结果读作 `ABORTED_BEFORE_DISPATCH`。本地 `llm.stream`（`nextWithSignal`，有界拆卸契约）与取消竞速并先行拆除流，评审因此 fail-closed，所有结果读作 `AUTO_REVIEW_DENIED`——这与上游面对遵守信号的 adapter 时的生产行为一致。该 spec 断言本地结果并在断言处记录了分叉原因。

包不变式遵循上游 `omit-unneeded-invariant-companions` 政策：删除 213 个空伴随及其 `exports`、`files`、tsconfig references、tsdown 入口、peer 声明与伴随 spec，每个受影响 README 以双语记录包专属的 `**Runtime invariant:**` 原因行。真实安装器、`runtime-diagnostics/invariants`、`sdk-minimal`、`session-persistence`、`agent-spine-demo` 与 `webhook`（留待持久化阶段）保留伴随。tsconfig `references` 现在由各 tsconfig 文件集实际 import 的工作区包加上游引用集推导——此前被删伴随承载了 vendor 声明的传递链；`session-persistence` 对 `dsh-invariants` 这类纯 src 服务引用经 `paths` 解析，无需 project reference。

## 已考虑的替代方案

**保留上游 auto-review 取消行原文。** 否决：它把夹具 adapter 的信号盲视编码为契约；在本地有界拆卸流下，该断言要求一个 fail-closed 设计正确拒绝的结果。

**保留带解释的空伴随。** 否决：上游将理由迁入 README 原因行并删除了伴随、其构建入口与测试；保留 213 个无操作模块会重新引入该政策所消除的分叉。

**为 profile-resolution 的合成夹具名做声明。** 否决：`metadata-lib`、`#missing`、`./relative.cjs` 等 specifier 是刻意不可解析的测试输入，knip 将其记为豁免引用而非真实依赖。

## 后果

调用方取消下 auto-review 的结果词汇本地读作 `AUTO_REVIEW_DENIED`；未来移植上游 spec 行必须复核其断言位于竞速的哪一侧。不变式所有权改为按包显式声明，新增真实不变式需要伴随、reference、export 与 README 原因行移除四者同改。`knip` 是本地依赖卫生门禁：`dependencies` 仅作 cordis.yml 解析清单的 bundle 包携带 `@deepseek-ai/.+` 豁免，强制要求的 Cordis peer/dev 对全局豁免。`benchmarks` 是仅含 terminal-io 的子集；其余上游套件、消费 `coverage-canonical-locations.ts` 的 coverage-partition 重写，以及 `tsdown.client.ts` 对 `bundle-input-isolation.ts` 的消费方仍是待同步工作。

## 验证

九个移植包单测全绿（`auto-review` 25/25、`browser-use-stagehand-native` 72/72 含恢复的 snapshot 夹具），完整卫生链通过：`verify-package-invariants`（43 个伴随）、`verify-built-package-invariants`、`verify-client-packages`（52 包）、`verify-optional-dependency-imports`、`verify-package-dependencies`（289 包、729 边）、`check-workspace-constraints`、`rescope-vendor --check`、`verify-cordis-config`（166 文件）、`knip` 零命中。引用重建与 `tsconfig.base.json` 手写/生成区重复键清理后，`tsc -b` host 与 client 双面及 `pnpm run build` 全部完成。
