# Agent Note: Forge 面板与 remote-access 移植

Status: implemented

[English](2026-11-15-forge-panel-remote-access-port.md) | 中文

## Problem

[Forge 谱系吸收](../architecture/2026-11-15-forge-lane-absorption.zh.md)携带了 Host 各包，但 deferred 了浏览器面板：`experimental/client-ui-forge` 的 React 半边属于异代（上游 `*OutlineRegular` 图标、上游 client-store 与 session-controller API、上游独有的 locales 模块、`forgeWorktree` 投影键在本地无注册），面板 Host 半边还要读 `ctx.remoteAccess`——即[授权 seam 决策](2026-10-17-remote-access-concepts-at-authorize-seam.zh.md)曾拒绝用于 dispatch 的通用非 owner RBAC 包。两者缺一，谱系落地的变更请求工作流就没有 UI。

## Decision

- 在契约与 carrier 无关的部分移植 `api/remote-access`：`RemoteAccessService` 保留 `registerPolicy`、`invalidate`、`decide`、`allows`、`snapshotFor`、`follow`，以及 `webserver/index-inject` 上的 `REMOTE_ACCESS_SNAPSHOT_KEY` 注入；`/client` 挂载保留快照存储读取面，并经 `slots.provideRoot` 的 `keyedHooks` 发布 `useRemoteAccess`。dispatcher 不调用 `decide`：`typert-gateway/authorize` 发出的 `TypertGatewayAuthorizationRequest` 不携带 principal，`authorizeTypertRemote` 与协作 authority 仍是唯一的授权路径——此前决策中"不要第二套授权栈"的理由由此成立：`decide` 已交付但不被调用。
- 移植 `experimental/client-ui-forge` 的 Host 与 Client。controller 经 `sessionProjections.register()` 自行注册 `forgeWorktree` 投影——本地 disposer 惯例而非上游 `ProjectionHandle`——并经 `stateOf(session, 'forgeWorktree')` 读取；client 经 `ctx.slots.inject`/`register` 挂到本地 slot 名；Host 面经 `ctx.get` 读取 `remoteAccess`，使未挂载该服务的组合退化为不过滤的列表。
- 移植内的本地替换：`*OutlineRegular` 图标换成本地 `*16` 命名；上游 client-store/session-controller/session-list hooks 换成 client/runtime 的 store 与 session API；上游 `SettingsForm` primitive 换成按本地 settings-form 模式复制的包内私有 `settings-form/`；上游 CSS-anchor Menu 断言换成本地计算定位的 `Menu`；引用编号改为按类别（`comment`/`thread`）独立的计数器，仅在 `conversation/append-input` 接受后自增；`agent/pre-step` 辅助函数省略本地 dispatcher 注入的作用域 `agent` 字段；`Promise<SubprocessHandle>` 调用点采用本地 subprocess 契约。
- `experimental/forge-bundle` 继续不移植。任何已交付组合都不得挂载 experimental 面板——release bundle 不能依赖 experimental 包——也没有任何可选 preset 组合该谱系，上游 patch layer 在本地没有消费者；面板的覆盖由其包级套件承担。
- 只携带 `en` 与 `zh` locale 目录，与仓库每个包一致。

Client source 消费 `AsyncIterable`，并通过传给 opener 的信号取消。当前 Gateway 返回普通异步迭代器，清理时不调用其未提供的上游 `dispose` 方法。Source 测试使用没有该方法的 iterable；完整装配的浏览器场景在挂载 Forge 插件时切换离开会话。

## Alternatives considered

- 把 `decide` 接入 `typert-gateway/authorize` 被否：授权请求不携带 principal，每次调用都会按 owner 评估而放行——一个永远不会拒绝的监听器是没有决策的第二条决策路径。重新引入条件：出现铸造非 owner principal 的 carrier 时，由它指定调用点。
- 移植 `forge-bundle` 被否：`bundle/web-app` 不能依赖 experimental 包，也没有任何 preset 组合该谱系；没有消费者的 bundle 只会增加一个零覆盖的组合面。
- 为 `Menu` 增加上游 CSS-anchor 属性、为 `Tooltip` 增加 pointer 驱动打开被否：本地 primitives 有意持有不同契约，因此把复制来的测试改为断言本地行为，而不是为上游期望扩出 anchor API。
- 此前对 `api/remote-access` 的[整体拒绝](2026-10-17-remote-access-concepts-at-authorize-seam.zh.md)是收窄而非推翻：该包因其 policy 注册表、快照与列表过滤面而落地，其 dispatch 角色仍被拒绝。

## Consequences

- 面板成为可加载插件：组合后贡献右侧栏 tab 与标题、Session 头工具、hero options、输入 dock、shell overlay、session-row 徽标与悬停卡片，以及 worktree 设置；当前没有任何组合挂载它，产品面不变，直到某个可选组合落地。
- `remoteAccess` 可独立挂载，提供 policy、快照与 `allows` 过滤；其面向 Gateway 的 `decide` 由包级套件覆盖，并为日后引入非 owner principal 的 carrier 保留。
- `api/gateway` 的 client 获得 `RemoteSnapshotStream`（与上游逐字节一致），用于 baseline-and-delta follow 协议；`test-support/client-runtime` 获得静态 `access` 面，`useRemoteAccess` 成为 `GlobalStandardProps` 成员，测试运行时默认全部允许。
- `dsh-api-remote-access` 与 `dsh-experimental-client-ui-forge` 的 `/remote` src-plane 替身加入 `vitest.shared.ts` 的 `sourcePlaneAliases`；面板测试 bench 提供基于 controller 自身投影注册的 `stateOf` 读取器，而非第二个 handle。

## Verification

- `pnpm exec vitest run packages/api/remote-access/tests`——40 个测试通过（Host policy/decide/snapshot 矩阵与 client 挂载）。
- `pnpm exec vitest run packages/experimental/client-ui-forge/tests`——43 个规格文件、1038 个测试通过，覆盖 Host controller/review/states/git/worktree 套件与经测试运行时驱动的 React client 套件。
- `pnpm exec tsc -b packages/api/remote-access packages/experimental/client-ui-forge`——干净通过。
