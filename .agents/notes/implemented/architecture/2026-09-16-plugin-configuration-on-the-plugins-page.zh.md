# Agent Note: 插件页上的插件配置

Status: implemented

[English](2026-09-16-plugin-configuration-on-the-plugins-page.md) | 中文

## 问题

插件的设置原本放在设置里、插件分区的配置标签页上：四张可折叠卡片，每个宿主平面命名空间一张，旁边是只读的清单标签页。侧栏的插件页能列出并启停组合包，却打不开插件的设置，于是同一个对象被两个界面各持一半；仓库之外安装的组合包更是完全没有地方放自己的表单。

## 决策

**插件页承载配置；设置不再列插件。** 页面在其 `main` 条目下声明三个子 slot。`plugins.item`（list）按 `label` 把官方插件列在「内置功能」分组里：id 命名 patch 行的条目绑定该行的实时状态与开关，并在行关闭时保持列出，见 [patch 行绑定](../feature/2026-10-23-plugins-item-patch-row-binding.zh.md)；没有任何行认领的 id 仍须命名一个 Host 所服务的 settings 命名空间。`plugins.bundle.config`（以组合包的包名为键）渲染在组合包页面的描述与行之间。`plugins.row.config`（以 `<包名>#<行 id>` 为键）给这一行一个配置控件，打开它自己的页面。该页面的标题与描述遵循[插件元信息决策](2026-09-18-localized-package-metadata.zh.md)；slot 键和技术身份不随展示文本改变。

页面通过 `view: 'page'` 渲染每个表单。官方插件卡片与详情还使用 `view: 'summary'`；行详情页只在插件没有展示描述时使用它。组合包配置仅渲染 `page`。页面负责画标题、图标与面包屑，把三份账本投影成一个可观察对象（`configLedgerSource`）绑在 store 旁边，自身从不点名任何可配置插件。侧栏导航与安装请求归属遵循[侧栏管理决策](2026-09-09-plugin-management-in-the-web-sidebar.zh.md)。

**归属由注册方在 slot 名与键里声明。** 不加 manifest 字段，不加注册元数据，也不从 settings 服务取 owner 信息：官方页面不带组合包注册，组合包的页面带自己的包名注册，行的页面带组合包与其 patch 声明的行 id 注册。没有浏览器半侧的社区组合包就没有配置页；页面不会从 settings schema 渲染通用表单。

**只有保存才写入。** 组合包注册的表单可以不提供放弃控件；离开页面时在卸载过程中丢弃暂存修改，自带条目的 `PluginForm` 底栏提供保存与放弃。保存经由客户端 settings scope，带 revision 栅栏。

**自带的宿主平面卡片无条件注册，以其 patch 行为键。** `ui-settings-plugins` 把自带的 `plugins.item` 条目注册为 id 命名各功能运行所在行的形式，见 [patch 行绑定](../feature/2026-10-23-plugins-item-patch-row-binding.zh.md)；绑定卡片在行关闭时保持列出，没有任何行或已服务命名空间认领的条目不留痕迹。`settings.plugins.tab` 与 `settings.plugin.item` slot 随设置分区一并退役。

**官方分组。** 安装随附的可选组合包开启这个分组，属于实验包的带 **Beta** 标签，没有官方标签；官方条目的内置功能分组排在其后。[实验能力的可选 bundle 决策](2026-09-21-experimental-capabilities-as-optional-bundles.zh.md)列出这些条目。

## 后果

- 组合包的浏览器半侧用一次 slot 注册加自己的词典就能提供表单；组合包的 patch 必须以键里的 id 声明这一行，注册只在承载组合包浏览器半侧的那一行开启期间存在：`dsh-client-modules` 把该半侧挂在说明符恰为包名的那一行上，因此键指向子路径行的行级页面随根行消失，而不随它自己的行。
- 这些页面使用现有表单和 settings 写入路径；`ui-settings-plugins` 拥有自带的条目注册，配置页位于插件页。
- 设置不再提供「插件」面；只读清单一并移除，`plugin-config` web lane 覆盖「内置功能」条目。

## 考虑过的替代方案

**slot 条目上的注册元数据。** 由 slot 声明的 `meta` 份额（描述、组合包、行）能让单个 `plugins.item` slot 覆盖所有情况，代价是 `ui-slots` 多一个概念；三个 slot 用现有 API 表达了同样的信息。

**从 settings schema 生成通用表单。** `describe()` 已经把每个命名空间的 schemastery schema 发给浏览器，没有浏览器半侧的社区命名空间本可获得一份默认表单。延期：官方页面是精选的，通用表单会在没有白名单的情况下暴露内部命名空间，而把命名空间归属到组合包还需要 descriptor 带 owner。

**把卡片留在设置里、从插件页链接过去。** 这会把一个插件的描述和配置分散到不同页面。

## 测试

`ui-plugin-manager` 单测覆盖账本投影、官方分组的卡片与页面、组合包的表单以及行的页面，包括描述优先于其摘要的规则；`ui-settings-plugins` 单测覆盖以 patch 行为键的无条件注册，以及表单只保存不放弃的行为。`plugin-config` web lane 通过真实链路编辑 shell 页面，并在开启社区夹具的组合包后打开其行的页面；`plugin-manager` lane 记录官方分组。
