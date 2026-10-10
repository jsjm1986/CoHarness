# Agent Note:「插件」页是唯一的插件入口

Status: implemented

[English](2026-10-09-plugins-page-single-entry.md) | 中文

## 问题

插件曾出现在两扇同名的门后。侧边栏「插件」页拥有安装、移除与启停，而 Settings 弹窗的「插件」分区持有五张宿主平面配置卡片——在本改动之前它还承载一个重复安装底座的只读清单标签页（`ui-settings-plugin-inventory`），并把本页面的模块同步诊断放在其中。用户必须自己学会哪扇门装、哪扇门配；而设置分区重复了管理器页已有的聚合机制：`plugins.item` slot、`ItemCard`/`ItemDetail` 对和命名空间过滤本来就是为这类官方卡片设计的，却一直无人注册。

## 决策

侧边栏「插件」页是唯一的用户侧插件面。删除 `ui-settings-plugin-inventory`，Settings 的 `plugins` 分区随之整体移除：`settings.plugins.tab` 与 `settings.plugin.item` slot、分区与标签页框架、以及 `PluginsSettingsSection`/`ConfigurablePluginsTab` 组件。

`ui-settings-plugins` 把它的五张卡片各自注册为一个以 settings 命名空间为键的 `plugins.item` 条目（`shell`、`agent-loop`、`subagent`、`subagent-model-selection`、`web-search-deepseek`）。卡片去掉了折叠外壳（`PluginCard`），改用 `PluginForm`——只含主体的框架，保留同样的只读提示带与保存底栏；管理器页在卡片上渲染 `view: 'summary'`、在条目自己的页面上渲染 `view: 'page'`。「插件配置」分组原本就把条目过滤为 Host `settings.describe` 所服务的 id，因此未组装的插件不留空壳。

`ctx.pluginNavigation` 新增 `openItem(itemId)`，选中面板并落到 `{ kind: 'item', id }`，供插件深链到自己的页面——实验性语音输入即以 `speech-to-text` 这样注册，未组装管理器时回退到 `requestSettingsSection()`。

页面自有的模块同步诊断移到侧边栏「插件」页，与生命周期同处。管理器 face 把 `clientSync` hook 绑定到 `ctx.modules.entries.state`，把 `retryClient` 动作绑定到 `entries.retry()`；重试仍然只重跑本页面的模块图，不改动 Host 的启用状态。Host 的 `pluginInventory` Remote 保留——它为管理器的包列表与管理端传输提供数据——因此没有移除任何能力，只去掉了重复的展示。

## 备选方案

**在 Settings 中保留仅配置的「插件」分区。** 否决：两扇同名的门仍要求用户学会分工，而该分区重复了管理器页已有的 slot 框架、挂载与过滤。

**把按预设分组的清单并入侧边栏页。** 面板已展示安装状态、行相位与每个 bundle 的详情；为同一批行再复制一套清单布局不会带来新信息。

**把模块同步横幅留在 Settings。** 横幅报告的是本页面 Loader 的状态——属于生命周期关注点，应与其他生命周期控件同处；Settings 从此完全不再读取模块系统。

## 影响

web-app bundle 少了一个客户端包及其 slot 贡献与测试夹具，基线与 golden 随之一并更新。Settings 不再提供「插件」导航行。本次取代的功能自有标签页机制记录在[已归档的标签页 note](../../archived/architecture/2026-08-11-plugin-settings-tabs.md) 中。live-client e2e 以终端条目的暂存超时编辑作为页面自有状态，并在面板上的 `[data-client-sync-failure]` 下查找同步失败。
