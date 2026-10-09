# Agent Note: Web“插件”页中经管理员授权的插件启停

Status: implemented

[English](2026-10-02-grant-gated-plugin-enablement.md) | 中文

## 问题

插件启停写操作此前只存在于 gateway 管理端 UI。Web 用户可以查看已安装的插件，却无法在自己的工作空间中启停任何一个；而产品需求比照搬管理端更窄：只有在管理员授予插件管理权限后用户才可启停，被拒的用户必须看到指向管理员的提示，而不是一个失效的开关。上游没有管理员授权概念——其插件界面是本地优先的——因此这条授权链是叠加在上游对齐后的管理器之上的 fork 特有工作。

## 决策

新的 `plugin_access_policies` 资源沿用现有 `ResourceAccess` 模式（该模式已用于 desktop、SSH 与 terminal 授权）：用户行授予个人空间管理权限，项目行约束项目目标上的操作，每次写入都携带乐观 `revision` 检查与强制重新授权的 `access_invalidation` 触发器。

- 迁移 [`048_plugin_access_qualification.sql`](../../../../gateway/deploy/postgres/migrations/048_plugin_access_qualification.sql) 按既有 access-policy 模板建表；[`gateway/src/plugin-access.ts`](../../../../gateway/src/plugin-access.ts) 将其接入 `ResourceAccess`，`admin-api` 在既有资源旁服务 `plugin`。
- [`gateway/src/execution-identity.ts`](../../../../gateway/src/execution-identity.ts) 的 `eligibleActors` 不再要求 `plugin-management` 必须是 admin：admin 保留无条件权限，非 admin actor 需要启用的用户策略，项目目标上另需启用的项目策略。[`gateway/src/runtime-api.ts`](../../../../gateway/src/runtime-api.ts) 在通过相同策略检查后对 `/internal/runtime/plugin-management/authorize` 放行普通 `user` principal；`plugin-admin` 用途断言仍限 admin，terminal 管理不受影响。
- [`packages/context/gateway-execution/src/plugin-management.ts`](../../../../packages/context/gateway-execution/src/plugin-management.ts) 不再在本地拒绝非 admin principal，而是把每个已认证 principal 转发给 gateway 端点，使变更共用同一个授权判定。非 204 应答映射为 `plugin-management/forbidden`。
- 侧边栏“插件”页（[`packages/client/ui-plugin-manager`](../../../../packages/client/ui-plugin-manager/README.zh.md)）通过 `pluginManager.access()` 探测授权——管理器自身的能力应答报告管理授权，而清单读取保持开放；缺少该 remote 的旧 Host 在拒绝时仍由读取本身返回拒绝，因此探测回退到 `listPlugins` 的应答。获授权的查看者在包卡片与 bundle 行上看到启停开关；被拒的查看者看到「插件启停需要管理员授权；如需启用或停用插件，请联系管理员开通权限。」；没有插件管理器的部署两者都不渲染。预设行、受保护行与不可寻址行一律不提供开关。
- 管理端新增授权编辑入口：用户详情页的「插件管理」资格卡与插件页的 `PluginPermissions` 区块，均基于共享的 `ResourcePermissions` 组件并带 revision 护栏的保存。

## 备选方案

**专用能力探测端点。** 在列表读取本身执行授权判定时，独立的「我能否管理插件」RPC 被否决，因为并行应答可能与真实授权漂移。读/写拆分消除了这一顾虑——`pluginManager.access()` 成为探测手段，而探测读取已无法再回答能力问题。

**给持证用户发放 admin 用途断言。** 用途断言是限定 HTTP 路径的 admin 凭据；携带断言的非 admin 会被直接拒绝。普通 principal 让用户的调用继续走既有的项目成员与策略检查，而不是放宽断言通道。

**移植用户侧 `ui-plugin-manager` 页面。** 上游的侧栏管理页与 fork 集中在管理端的功能重复；需求只涉及启停，因此由现有清单标签页承载授权门控的开关，而非新增第二个页面。（需求后来扩展为组合包管理，该页面已随附——见[用户侧插件页](2026-10-03-user-side-plugin-manager-page.zh.md)。）

## 影响

每个非 admin 插件变更现在都经过实时的数据库检查；撤销的授权通过失效触发器立即生效，不依赖缓存的 UI 状态。`plugin-access-policies` 管理 API 并入资源联合，其读写端点继承 admin 鉴权与 revision 护栏。插件管理授权的覆盖在 `gateway/tests/execution.spec.ts` 中以真实 PostgreSQL 运行（授予、项目授予、撤销），“插件”页的探测/拒绝/切换路径由 `components.client.spec.tsx` 与 `browser-plugin.client.spec.tsx` 固定。
