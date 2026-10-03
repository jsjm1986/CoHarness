# Agent Note: The Web sidebar Plugins page brings grant-gated bundle management to users

Status: implemented

[English](2026-10-03-user-side-plugin-manager-page.md) | 中文

## 问题

Admin UI 独占全部组合包管理——安装、启用、停用、移除组合包以及行级开关——而 Web 用户侧只在设置**插件列表**页签里持有需授权的启用开关。上游 `dsh-v0.2.0-rc.2` 随附 `ui-plugin-manager`：侧栏**插件**入口的主面板覆盖与 fork Admin 页相同的面；该包在 client 车道移植时未随附，因此即使部署授予了插件管理权限，用户也没有组合包管理入口。此前的[授权门控启用](2026-10-02-grant-gated-plugin-enablement.zh.md)笔记基于更窄的需求否决了用户侧管理页；需求已扩展为同一授权链下的 admin/用户对齐。

## 决策

移植 `packages/client/ui-plugin-manager`，并按 fork 的 client 架构适配而非照抄：

- 上游的 `configForms` 服务由 `settingsScope` 替代：`describe()` 提供页面读取的命名空间投影，`bind({ namespace, source: 'host' })` 返回按命名空间缓存在控制器上的 mutation scope。slot 契约保持布尔形态——`ConfigPageForm.mutate` 在 `scope.mutate` 结算后报告 `write.status === 'idle'`。共享 scope 机制仍归 [user-preference-cluster-shared-settings-scope](2026-10-02-user-preference-cluster-shared-settings-scope.zh.md) 所有。
- 授权门笔记的管理员授权链收窄至变更：`pluginManager.*` 读取开放，`access()` 报告管理授权。页面为所有查看者加载完整清单，`manage: false` 进入只读模式——管理控件在双语 `managementDenied` 横幅下禁用——刷新控件保持可用，新授权在下一次读取时生效，无需重载页面。缺少 `access` remote 的旧 Host 回退为可写并依赖每个变更自身携带拒绝；读取也拒绝的旧 Host 仍使页面进入 `denied` 状态。
- 不移植 `product-analytics` 与 `sanitize-install-input.ts`：该分类器存在的唯一目的是把凭据和路径从埋点事件中剔除，而 fork 不运行埋点服务。Host 的 `inspect` 仍是 typed spec 的校验权威。
- 图标重映射到 fork 图标字体（`Icon*Outline18`/`20` 命名）；`dsh-plugin-manager/registry` 按上游做法加入 `tsdown.client.ts` 的 `INLINE_SAFE`。
- 浏览器插件在 `remote` 之外注入 `remote.pluginManager`、`remote.pluginInventory` 与 `remote.pluginRegistryProbe`；`remote-events.ts` 把 `plugin-manager/changed`、`plugin-manager/install-log`、`plugin-manager/install-state` 转发给订阅者。
- 注册遵循 slot 标准：`sidebar.panellist` 条目、声明七个 `plugins.*` 子 slot 的 `main` keyed 面板（`item`、`bundle.activation`、`bundle.config`、`row.config`、`detail.actions`、`detail.badge`、`detail.section`）、`shell.overlay` 刷新 toast，以及在面板挂载期间经 `ctx.reflect.provide` 提供的 `ctx.pluginNavigation`，使其他插件可打开组合包详情页。

## 备选方案

- **组合包管理保持 admin 独占。** 否决：需求已扩展为用户对齐，且 Host 对每个管理调用都已授权，页面不新增权限——只暴露授权已允许的能力。
- **为这一个消费者 vendor 上游 `configForms`。** 否决：它重复了 fork 设置面已有的 settings-scope 投影与原子 mutation 机制；适配器保持单一设置传输。
- **无授权时隐藏页面或清空列表。** 否决：读取按设计开放，看似已授权的空白页会误报授权事实；只读模式保持清单可见并将控件标记为不可用。

## 后果

获授权用户可从与 Admin 页相同的入口端到端管理组合包——带流式输出的安装、registry 选择与探测、启用、停用与卸载；未获授权用户在指向管理员的提示下保留完整清单的只读视图，以刷新作为重试路径。`plugins.item`、`plugins.bundle.config`、`plugins.row.config` 与 `plugins.detail.*` slot 随附时无树内条目；内置插件配置留在设置 → 插件，直到有包注册进页面。测试运行时新增 `stubMutationScope`/`StubMutationScope` 与 `RemoteError` 再导出供 spec 替身使用。本笔记取代[授权门控插件启用](2026-10-02-grant-gated-plugin-enablement.zh.md)中记录的用户侧页面否决项；该笔记的清单页签授权开关仍然随附且互补。
