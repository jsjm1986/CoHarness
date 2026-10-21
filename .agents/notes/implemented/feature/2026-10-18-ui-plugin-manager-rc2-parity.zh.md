# Agent Note: rc.2 插件管理展示对齐

Status: implemented

[English](2026-10-18-ui-plugin-manager-rc2-parity.md) | 中文

## Problem

上游 `dsh-v0.2.1-rc.2` 把插件页重组为围绕可选组合包的策展分区，而 fork 缺少这些：主列表的**实验性插件**、收纳暂存组合包的**更多**页、安装 Host 提供目录目标的官方按需卡片、版本或来源漂移时的**更新**、文件缺失与可更新标签、详情页按语言展示的功能配图、接受贡献项的分体式**添加插件**菜单，以及贡献的 `plugins.tab` 页面标签页。整体搬运会替换 fork 的架构，因为上游页面建立在 `configForms` 之上，没有管理授权，且上报产品埋点。

## Decision

每个增量都以 fork 形态落在 fork 模型上：

- `PluginManagerPage` 采用上游的分组模型——内置插件配置（过滤到 Host 所服务 settings 命名空间的 `plugins.item` 条目）、实验性插件、已安装插件——以及 `EXTENSION_BUNDLES`/`MORE_BUNDLES` 排序：常驻组合包排在主列表，暂存组合包只在启用时进入主列表，更多页列出全部官方组合包并把 Codex 与 Claude Code 子智能体排在最后。fork 独有的 `schedule-bundle` 因带有 `locale/en.json`、`locale/zh.json` 与 `icon.svg` 而加入 `MORE_BUNDLES`；缺少这套元信息的包一律不列出。
- `manager-store` 保留 fork 以 `settingsScope` 支撑的 `configForm`、`manage`/`denied` 授权门、`clientSync` 状态与重试，以及 `scopePolicy` 说明行。`packageView()` 在更新的 Host 发布上游目录字段（`official`、`availability`、`installTarget`）时原样转发，否则由 `optional` 推导 `official`、由可选/已安装/缺失事实推导 `availability`，使按需安装、精确 `saveExact` 目标与先删后装的**更新**通道在 Host 报告目标处端到端生效。`saveExact` 通过结构化扩展挂在安装选项上，因为 fork 生成的安装 schema 尚未声明它。
- `slot-contract` 在本地重新声明 `BundleAvailability`，并让 `ConfigPageForm` 继续使用 `SettingsScopeSnapshot`/`SettingsMutationScope`；`plugins.tab`、`plugins.add.actions` 与 `PluginTabInstall` 与上游一致。
- 详情页按包名渲染 `BUNDLE_PREVIEWS` SVG——`src/client/assets/` 下徽章技能与语音输入组合包每种已发布语言各一张 640×300 素材——解码失败时回退到本地化的 `previewUnavailable`；包没有配图声明接口。
- 所有 `productAnalytics` 导入与上报调用被移除而非保留桩；`sanitize-install-input.ts` 连同其测试一并移植，尽管它在上游唯一的调用方是埋点尝试日志。
- fork 独有表面保留：`pluginNavigation` 的 `openItem`、管理员授权拒绝视图、模块同步失败面板、fork 图标命名，以及 `clientBundle(name, …)` 形式的 tsdown 配置。

## Alternatives considered

- 采用上游 `configForms` 被拒绝：fork 的设置架构通过 `settingsScope` 绑定可编辑命名空间，迁移页面会让每个 `plugins.item` 注册方使用的 `ConfigPageForm` 契约失去依托。
- 通过在服务端伪造 `official`/`installTarget` 半个落地官方目录被拒绝：捏造线上协议不携带的 Host 契约会交付一条无法测试的通道，因此客户端只在 Host 提供字段时消费它们，并在包 README 中记录这一限制。
- 通过可选 `ctx.get` 保留 `productAnalytics` 被拒绝：fork 完全排除该包，死埋点只会不断堆积。

## Consequences

对发布目录字段的 Host，页面在组织上与 rc.2 一致；在当前 fork 协议上则是降级但完整——策展排序、配图、菜单、标签页、文件缺失与可更新标签均可用。`subagent-codex` 与 `subagent-claude-code` 获得了上游的 `locale/` 元信息与 `icon.svg`，每个具名组合包都能解析出展示卡片。

## Verification

`npx vitest run packages/client/ui-plugin-manager`——6 个文件、254 个测试，含移植的目录安装/更新、更多列表钉住、配图语言与回退、添加菜单键盘操作与 `sanitize-install-input` 规格；`npx tsc --noEmit -p packages/client/ui-plugin-manager/tsconfig.client.json` 干净。增量证据见 `.rc2-work/logs/pm-showcase-port.log`。
