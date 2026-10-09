# Agent Note:“插件”设置只保留配置

Status: implemented

[English](2026-10-09-settings-plugins-configuration-only.md) | 中文

## 问题

同一批已安装插件曾出现在两处界面。侧边栏“插件”页拥有安装、移除与启停，而 Settings 的“插件”分区在配置卡片旁重复展示一个只读清单（`ui-settings-plugin-inventory`）——该分区的第二个标签页还承载了本页面的模块同步诊断，把一个生命周期信号摆成了配置项。用户可以在 Settings 里检查失效的安装，却只能到侧边栏修复，且两处清单的授权与状态行为存在漂移风险。

## 决策

删除 `ui-settings-plugin-inventory`。Settings 的 `plugins` 分区只保留 `configurable` 贡献（见[“插件”设置标签页](../architecture/2026-08-11-plugin-settings-tabs.zh.md)）：当 `settings.plugins.tab` 记录只剩一项时，分区直接渲染该内容，不再显示标签栏。分区新增管理链接，仅在 `ctx.pluginNavigation` 已提供时显示，调用参数变为可选的 `openBundle()`，从而打开面板列表视图。管理器在激活时提供 `pluginNavigation`，而非等到 `main` 条目挂载，因此调用方可以在面板首次渲染前选中它。

页面自有的模块同步诊断移到侧边栏“插件”页，与生命周期同处。管理器 face 把 `clientSync` hook 绑定到 `ctx.modules.entries.state`，把 `retryClient` 动作绑定到 `entries.retry()`；重试仍然只重跑本页面的模块图，不改动 Host 的启用状态。Host 的 `pluginInventory` Remote 保留——它为管理器的包列表与管理端传输提供数据——因此没有移除任何能力，只去掉了一份重复的展示。

## 备选方案

**在 Settings 内保留清单标签页。** 否决：对同一安装集做两份列表，会重复授权、状态与诊断界面；该分区是配置面，不是第二个管理器。

**把按预设分组的清单并入侧边栏页。** 面板已展示安装状态、行相位与每个 bundle 的详情；为同一批行再复制一套清单布局不会带来新信息。

**把模块同步横幅留在 Settings。** 横幅报告的是本页面 Loader 的状态——属于生命周期关注点，应与其他生命周期控件同处；Settings 从此完全不再读取模块系统。

## 影响

web-app bundle 少了一个客户端包及其 slot 贡献和测试夹具，基线与 golden 随之一并更新。组装了 `ui-plugin-manager` 时，Settings“插件”渲染配置卡片加管理链接；未组装时只渲染卡片——链接隐藏而非死链。live-client e2e 以终端卡片的暂存超时编辑作为页面自有状态，并在面板上的 `[data-client-sync-failure]` 下查找同步失败。
