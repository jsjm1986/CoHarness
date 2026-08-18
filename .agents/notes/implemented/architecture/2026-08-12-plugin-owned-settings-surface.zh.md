# Agent Note: 具有项目隔离的插件自有设置

Status: implemented

[English](2026-08-12-plugin-owned-settings-surface.md) | 中文

## Problem

插件可以注册 settings 命名空间，却无法在不修改 `packages/host/apiproxy` 的情况下把配置放到浏览器设置页。代理通过硬编码命名空间清单过滤读写，因此清单之外的有效注册只能得到 `settings-not-exposed`。

「插件」分区还把 `settings.plugin.item` 注册为无键列表。卡片携带不透明 id，而不是它所编辑的命名空间，因此分区无法推导哪些 Host 注册拥有浏览器界面、无法在渲染前抑制未组装插件的卡片，也无法依据可见卡片计算空态。

本仓库还服务共享项目运行时。Host 进程注册了某个命名空间，不代表项目参与者就应看到任意个人或第三方插件配置。因此，单用户行为不能原样应用于每一种 collaboration authority。

## Decision

**个人设置注册会暴露给个人配置客户端。** 在个人 scope 中，`settings.describe` 返回 `ctx.settings.describe({ redactSecrets: true })` 的全部 descriptor，`settings.update`、`replace` 与 `mutate` 可以寻址任意已注册命名空间。代理不再拥有 `WEB_SETTINGS_NAMESPACES`、提供方目录准入检查或 `settings-not-exposed` 错误。格式非法和未注册名称统一使用 settings 服务的 `settings-rejected` 响应。

**共享项目设置继续只读并经过过滤。** 在项目 scope 中，`settings.describe` 只返回已注册可配置提供方命名空间、产品设置以及共享运行时批准的显式非模型命名空间。任意第三方命名空间会被省略。`writable` 与 `hasDocument` 为 false，所有 settings 写入和文档打开操作都由 `authorizePersonalConfiguration()` 拒绝。这样既保留插件自有配置，也不会扩大项目成员可检查或修改的范围。

**settings 服务定义不携带浏览器元数据。** 客户端可见性与页面归属属于 Consumer。`SettingsRegisterOptions` 不新增页面名、标签或暴露标志。

**`settings.plugin.item` 以 settings 命名空间为键。** 浏览器插件用等于其编辑命名空间的 `key` 注册卡片。「插件」分区的可配置标签页声明 keyed slot 并拥有卡片列表；卡片拥有自己的外观、控件、文案、暂存与写入行为。

**标签页渲染两个注册表的交集。** controller 读取 `settings.describe`，保留当前 authority 可见的命名空间，并与当前 keyed 卡片注册取交集。它在 `settings/document-updated`、连接重置或卡片账本变化后刷新。被服务但没有卡片的命名空间属于其他页面或没有浏览器半侧，因此不渲染；命名空间未被服务的卡片不会被派发。

**标签页没有 schema 生成的 fallback。** keyed 卡片是否存在就是完整的渲染决定。浏览器不会从不归自己拥有的命名空间 schema 中发明控件、校验或呈现。

## 安全属性

所有配置方法继续受载体的回环与同源限制。secret 角色字段在序列化前仍会从 resolved、base 和 user 值中移除。项目过滤是额外的多用户保密规则，不替代传输准入或字段脱敏。

项目过滤刻意比个人注册暴露更窄。若部署希望项目成员使用某个第三方命名空间，必须把它作为经过审查的产品决策加入项目可见集合；仅注册不足以开放它。

## Alternatives considered

**在项目 scope 中暴露每个已注册命名空间。** 否决，因为项目参与者共享 Host 运行时，但不拥有每个插件的个人配置。即使响应只读，仍可能泄露端点、路径、功能标志或其他非 secret 字段。

**给 `settings.register()` 增加浏览器暴露元数据。** 否决，因为页面名、标签和渲染归属是客户端关注点；它还会把一个命名空间注册拆成可能独立演化的校验与呈现职责。

**在 settings 注册之外新增第二个暴露注册表。** 否决，因为两项注册可能脱节，使有效 settings 分节无法访问，并且任何拥有方都无法在本地检测缺少目录条目。

**依据序列化 schema 生成通用卡片。** 否决，因为 schema 不定义可用的布局、文案、凭据处理、暂存保存行为或全部语义校验规则。能交付浏览器半侧的插件可以提供正确控件。

**保留 list slot 并增加命名空间 option。** 否决，因为标签页仍然枚举卡片而不是可见命名空间，空态错误会保留，每张未被服务的卡片也仍需自行抑制。

## Consequences

外部插件无需修改本仓库即可出现在个人设置页：Host 半侧注册命名空间，浏览器半侧在同一键下注册卡片。[设置卡片 cookbook](../../../../docs/cookbook/adding-a-settings-card.md)定义了所需打包和验证路径。

项目成员继续只看到经过批准的只读设置子集。个人与项目 scope 的刻意差异由 `api-proxy-config.spec.ts` 覆盖；删除过滤或让项目设置可写会改变协作安全模型，需要新的决策。

卡片按注册顺序出现。同一处安装的卡片顺序稳定，但跨包注册顺序没有保证。协议没有命名空间注册事件，因此在标签页完成 Host 读取之后注册的命名空间，要等下一次 settings 文档更新或重连后才会出现。

服务任意个人命名空间提高了 fail-closed wire 脱敏的重要性。只能通过脱敏器无法检查的 schema 结构抵达的 secret 仍是已知缺口；代理最终必须拒绝无法证明可安全序列化的 descriptor。除两个半侧各自的单元覆盖外，仍需一项组装态 fixture 插件覆盖 Host 注册、客户端卡片注册、保存以及运行时使用生效值。
