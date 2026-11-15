# Agent Note：供 overlay 组合使用的测试专用 headlessStartup stub

状态：已实现

[English](2026-11-16-headless-startup-test-stub.md) | 中文

## 问题

rc.3 让 `sandbox-policy` 声明 `inject: [headlessStartup]`，使其 `!!js` 配置表达式可以读取 `ctx.headlessStartup.additionalWritableRoots`。十七个测试 overlay 有意禁用了生产 `headless-startup` 行；服务缺失后 `sandbox-policy` 无法解析注入，全部依赖插件（`fs`、`workingDirectory`、shell、PTC、subagent 等 22+ 行）转 pending，在 headless、sdk 与 examples 组合中级联出几十个无关失败。

## 决策

- 保留生产 `inject` 不动——该依赖在出厂 profile 中是真实的。
- 新增测试专用 provider `packages/test-support/loader-smoke/tests/fixtures/headless-startup-stub.ts`，提供最小 `headlessStartup` 服务形态（不含 `cmdlineArgs`，可写根为空）。
- 每个受影响 overlay 保持生产行不动，仅追加一条挂载 stub 的条目。

## 后果

- 禁用 `headless-startup` 的 overlay 不再级联；今后出现同样组合的 overlay 也会因同一修法自愈。
- stub 仅是测试基础设施：它位于 `test-support/loader-smoke` fixtures 之下，从不发布、也不被任何产品 profile 挂载。

## 曾考虑的替代方案

- 削弱 `sandbox-policy` 的 `inject` 或在 overlay 中替换条目 `name`——否决：`name` 是行身份，且该依赖在生产中真实存在；削弱它会恰好掩盖 inject 所要声明的耦合。
- 让每个测试驱动各自提供 `headlessStartup`——否决：横跨三处根的 17 个 overlay 有同一需求；fixture 插件与驱动无关。

## 验证

- 此前级联失败的测试通过：`cordis-inspection`、`pi-ai-conversation-updates`、loader-composition、headless `keyless-smoke`、sdk `keyless-smoke`(20/20)、`ptc.e2e`。
- 全量快照套件：379/380 通过（1 个平台跳过）。
