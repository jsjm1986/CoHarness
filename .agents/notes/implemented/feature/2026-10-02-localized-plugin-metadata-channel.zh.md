# Agent Note: Localized plugin metadata travels the Host projection, not package-locale dictionaries

Status: implemented

[English](2026-10-02-localized-plugin-metadata-channel.md) | 中文

## Problem

上游 dsh 通过各 client 包自己的 `plugins.item` 注册渲染插件管理器与插件清单的标题和描述，`label` 在 inject 时按 client 包的 locale 字典解析。admin 网关 UI 与 Web 设置的插件列表标签页都不加载这些贡献方 client 包，两个界面都拿不到那些字典：官方设置条目显示原始 namespace id（`dsh-agent-loop`），包卡片显示技术名，包 `meta` 读取失败时没有就地诊断。上游 rc.1/rc.2 还重建了安装管线——带镜像推荐的 registry 选择、丢失应答后仍生效的取消、unknown/unconfirmed 阶段、隐藏安装通知、GitHub 网络恢复界面——admin 管理页此前完全没有这些渲染。

## Decision

注册方在宿主侧契约上声明本地化元数据，每个远程界面按当前语言解析它。

- [`packages/settings/settings/src/index.ts`](../../../../packages/settings/settings/src/index.ts) 中 `SettingsRegisterOptions.label` 与 `SettingsSectionHooks.label` 接受 `LocalizedText` 显示标题。该字段走既有 descriptor：`SettingsDescriptor.label` 在 `describe({ redactSecrets: true })` 下保留，因为它是注册方元数据而非用户数据；[`packages/host/apiproxy/src/api/settings.ts`](../../../../packages/host/apiproxy/src/api/settings.ts) 的 `SettingsNamespaceView.label` 把它带过传输层，`settings.schema.ts` 做 zod 校验。admin 台账把它存为 `labelText`，与技术 `label` 兜底并列；`PluginManagerPage` 用 `resolveText` 按当前 UI 语言解析，未声明时回退到 namespace id。`agent-loop`、`bash-local`、`pwsh-local`、`subagent`、`web-search-deepseek` 声明了上游 client 字典携带的标题。
- [`packages/host/plugin-inventory/src/index.ts`](../../../../packages/host/plugin-inventory/src/index.ts) 的 `readPluginInventory` 照上游从包清单的本地化 `title`/`description` 填充 `PluginInfo.meta`（清单条目与预设行都覆盖）。两个消费方——admin 插件管理器与 Web 设置清单标签页——用 `resolveText` 解析 `meta.title`/`meta.description`；无 meta 时回退到完整 `pkg.name`/`row.moduleName`；meta 读取本身失败时在卡片旁渲染 `metadataError` 诊断。清单标签页还只为展示缩短字面名回退（npm scope 及 `cordis:`/`cordis-plugin-`/`dsh-`/`dsh-host-`/`dsh-client-` 前缀），完整标识保留在详情与搜索中。
- admin 插件管理器采用上游 rc.2 安装管线：gateway 上的 `registries()`/`pluginRegistryProbe.fastest`/`waitForInstall` 端点、延迟取消（spec 解析后 `sendCancellation`）、取消后的 spec 重检（`offerSpecAgain`）、载入时对被中断安装的对账、registry 选择器、GitHub 恢复、unconfirmed 与骨架屏 UI 状态——全部在 `gateway/admin-ui/src/plugins/` 内。[引导式插件安装](../architecture/2026-09-15-guided-plugin-installation.zh.md)的宿主契约未变：`cancelInstall` 仍只在清理完成后答复，admin store 的延迟发送是客户端排序，不是第二种取消语义。
- [`packages/client/locale/src/client/index.ts`](../../../../packages/client/locale/src/client/index.ts) 增加 `LocaleRuntime.resolveText`；`useAnchoredPosition` 增加上游的 `align` 选项；[`packages/client/ui-primitives/src/plugin-artwork.tsx`](../../../../packages/client/ui-primitives/src/plugin-artwork.tsx) 的 `PluginArtwork` 渲染 manifest `icon` 媒体并带生成兜底。

## Alternatives considered

**在 admin 界面上加载 client 包的 `plugins.item` 贡献。** admin 页运行在 client 插件运行时之外，需要第二套注入机制外加逐包 locale 加载；Host 本来就在为所有远程界面投影 settings namespace 与插件清单。

**在 admin 台账里翻译包名。** 曾存在一张只覆盖两个 bundle 的双语表（`BUILTIN_COPY`）。它永远覆盖不了用户安装的包，且上游在 `meta` 成为唯一显示通道时删掉了等价拷贝；本改动删除该表，未装 namespace 的行回退到 id。

**保留 `PackageView` 上的扁平 name/description 字段。** 上游已把未翻译的 manifest `description` 移出卡片界面，让 `meta` 成为唯一显示通道：无本地化 `meta` 的包显示完整名而无描述，而不是一条语言错配的简介。本改动跟随：卡片 `description` 字段移除，`noDescription` 文案删除。

## Consequences

每个 settings namespace 现在可以发布显示标题；没有标题的界面仍渲染技术 id。`meta` 通道只对 manifest 声明了本地化元数据的包填充，第三方包在补 `meta` 前保持纯名卡片。两个实验包的 admin 卡片现在显示「自动授权审查/智能体团队」（或英文），无需台账侧拷贝表。删除 `BUILTIN_COPY`/`noDescription`/`builtin*` locale 键共移除四个死键；zh 与 en 文案文件保持同步。

取消安装的行为有可观察变化：`starting` 阶段 `closeInstall` 直接关对话框，由 store 在 spec 解析后送达取消；被取消的安装提供重检入口而不是静默复位。两个行为都由移植的上游 spec（`manager-store.spec.ts`、`components.spec.tsx`）与新增的 `settings-store.spec.ts` label 用例钉住。
