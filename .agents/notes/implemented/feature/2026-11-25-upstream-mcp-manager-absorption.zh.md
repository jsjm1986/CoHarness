# Agent Note: 上游 mcp-manager 吸收

Status: implemented

[English](2026-11-25-upstream-mcp-manager-absorption.md) | 中文

## Problem

上游 rc.3 提供 `packages/mcp/mcp-manager` —— 一个 fleet 监督器，把 volatile 的 `servers` 配置映射与插件注册的 MCP 服务器调和到 mcp-client 的代际模型上，并通过 Typert Remote 暴露 `list`/`watch`/`restart`/`probe` 管理方法。本地树此前没有对应物：配置化的 MCP 服务器只能以手工接线的 `mcp-client` 行存在，没有实时增/改/启/停路径，没有聚合状态面，也没有客户端可达的管理命名空间。manager 还依赖 `packages/boot/config-editor`（原子化的 profile-patch 写入），该包此前因本地自有 settings 管道持有配置写入而被拒绝。

## Decision

以该包为新基座吸收，并把其上游特有的接缝转接到本地基础设施上。

`packages/mcp/mcp-manager` 保留上游生命周期：`Config.servers` 在组合加载、每次 `internal/config` waterfall 重解析、以及插件注册时校验；条目变更按服务器调和，重建只触及被改条目；移除或 `enabled: false` 卸载客户端并释放其工具命名空间；清理失败以 `failed/cleanup` 状态记录保留而非抛出；移除、替换或处置后的过期回调通过代际身份忽略；`probe` 通过一次性实例连接，绝不干扰在线实例。

本地适配（替代整段照抄上游代码）：

- **`internal/config` 签名** —— 本地 vendored Cordis 监听契约为 `(config, next)`，`this` 绑定到被解析的 Fiber，而非上游的 `(fiber, next)`。manager 监听器是普通函数，将 `this` 与持有 Fiber 比较；校验前仍先委派 `next()`。
- **`config-editor` 恢复** —— rc.5 包被重新采用，因为 manager 的 settings 写入路径正是当初延迟评估所等待的原子编辑原语。其解析流使用本地 `fiber.ctx.waterfall(fiber, 'internal/config', next, () => next)` 加 `resolveConfig(fiber.runtime, resolved)` —— vendored Cordis 不存在上游的 `fiber.resolveConfig(next)` —— 且 `js-yaml` 走命名空间导入，因为本地 v5 没有默认可调用导出。
- **测试中替换 `SettingsForms`** —— 上游的 settings 表单门面服务在本地没有对应物，因此 `tests/profile-fixture.ts` 携带一个基于 `ctx.configEditor` 的 `settingsAdapter`，提供带内容修订冲突检查的 `describe`/`update`/`replace`/`mutate`。本地 profile 组合在 `servers` 层级做浅合并，因此 `mutate` 的 unset 路径把 inherited 层折回 patch，使继承条目在用户覆盖被移除后重新出现。
- **凭据 fixture** —— 测试内 provider 实现本地 `CredentialProvider` 的 `*Owned` 抽象面（`resolveOwned`/`describeOwned`/`setOwned`/`unsetOwned`），而非上游的扁平 API。
- **Remote 面接线** —— `packages/api/remotes/src/client/index.ts` 挂载 `mcpManagerRemote` 并再导出 `McpManagedServerStatus`/`McpManagedServerView`；web-app patch 让 manager 在 `credentials` 之后启动。`/types` 与 `/remote` 子路径经 `tsconfig.base.json` paths 解析供源平面测试使用，经包导出供构建产物消费方使用。
- **本地化** —— 仅英文与中文，符合本地惯例；上游的 de/es/fr/ja/pt/ru 文件未携带。
- **上游设计笔记携带** —— `2026-08-31-mcp-manager-plugin`（en/zh）被导入，因为 manager README 引用它；它记录了本次移植继承的上游设计依据。

## Consequences

- `McpServerManager` 是 `TypertRemoteService`，贡献 `mcpManager` Remote 命名空间，含 `watch`（流式）、`restart`、`probe`；客户端在 `lib/typert.remote-client.js` 构建后经 api-remotes client 组装可达。
- web profile 运行单一 fleet：对 `servers` 的 Settings 可见编辑实时调和，任意插件可按名注册 MCP 服务器；与注册冲突的配置名被拒绝。
- `packages/boot/config-editor` 重回工作区（矩阵记录由 `reject` 改为 `adapt`），现在是原子化 profile-patch 编辑的正式路径。
- `tsconfig.host.json` 新增两个项目引用；`tsconfig.base.json` 新增 `dsh-mcp-client/types` 与 `dsh-mcp-manager/types` 子路径映射，Typert 分析器需要它们解析 manager Remote 面中的跨包类型引用。

## Alternatives considered

- **等到 settings UI 落地再引入** —— 否决：manager 是 host 基础设施；Settings 表单消费方可以后到，而插件与 profile 编辑现在已经可以调和，Remote 命名空间是唯一的客户端可达 fleet 视图。
- **不恢复 config-editor 仅移植 manager** —— 否决：settings 写入路径是该包被测过的持久化面；打桩会丢掉测试套件证明的"畸形编辑在持久化前失败"保证。
- **把上游 `(fiber, next)` 监听语义透明映射到本地 `(config, next)`** —— 否决：两种签名运行时无法区分；显式采用本地签名是唯一正确选择，也正是 config-editor 所用的形式。

## Verification

- `pnpm exec vitest run packages/mcp/mcp-manager/tests` —— `manager.spec.ts` 与 `composition.spec.ts` 共 66 个测试通过；组合 spec 通过真实 Loader profile 启动，并经 `configEditor` 演练 settings 驱动的调和。
- `pnpm exec tsc -b` 覆盖 `packages/boot/config-editor`、`packages/mcp/mcp-manager` 与 `packages/api/remotes` 两个 face —— 干净；workspace `tsdown --env.DSH_BUILD_FACE host` 为新包产出 `typert.host`/`typert.remote-client` 工件。
- `verify-translation-pairing` —— 录入新 README 与携带的设计笔记后 2186 对一致；`verify-agent-note-format` 干净；触及包上 `oxlint` 干净；`verify-cordis-config` 仅报告 executor-seam 批次遗留的 `llm-deepseek`/`tool-pwsh` 存量 fixture 声明违规。
