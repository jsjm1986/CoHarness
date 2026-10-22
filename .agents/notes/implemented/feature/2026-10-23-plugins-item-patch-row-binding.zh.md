# Agent Note: Plugins-page feature cards bind their patch row

Status: implemented

[English](2026-10-23-plugins-item-patch-row-binding.md) | 中文

## Problem

`plugins.item` 条目过去以它编辑的 Host 面 settings 命名空间作为键，并且只在 Host 服务该命名空间期间注册。一个通过 profile patch 被关掉的功能会随命名空间一起失去卡片，产品内没有任何途径把它开回来；卡片也无法携带行的实时状态，因为它的键是 settings 命名空间，而不是它配置的那个运行中的 profile 条目。shell 功能还有第二个缺陷：它的 Host 行随平台变化（`bash-sandbox` 对 `pwsh-sandbox`)，任何单一命名空间键都命名不了当前活着的行。

## Decision

**`plugins.item` 条目的 `id` 命名其功能运行所在的 cordis patch 行。**Plugins 页把每个 id 解析到 Host 的 running-profile 条目：有 `patchId` 的直接命中；patch 无法寻址的条目经其 bundle 行携带的实时 `entryId` 命中。绑定条目的卡片携带行的实时状态和开关——当 Host 拒绝寻址该行时以 `readOnlyReason` 文案锁定、行键忙时锁定、无管理授权时锁定——并在行关闭时继续列在页面上，使开关能把它开回来；条目自己的页面重复这个开关以及关闭或只读原因。共享 `label` 的条目合并为一张卡片，绑定到组内活着的成员——这是 id 随平台变化之行的惯用法；shell 功能以同一标签发出 `bash-sandbox` 与 `pwsh-sandbox` 两张注册。没有任何 patch 行或被服务命名空间认领的 `id` 不渲染卡片，因此未组合的插件依然不留痕迹。`slot-contract.ts` 中的槽位契约拥有这条绑定规则。

`PluginManagerState.plugins` 发布与 `packages` 同一次清单读取得到的 running-profile 条目，因此绑定解析无需第二次往返。`ui-settings-plugins` 以 patch 行 id(`bash-sandbox`、`pwsh-sandbox`、`agent-loop`、`subagent`、`subagent-model-selection-settings`、`web-search-deepseek`）无条件注册它的六张卡片，不再以 `settingsScope.whileServed` 为门；voice-input bundle 以同样方式绑定其 `speech-to-text` 行。卡片所在分组随语义改名——内置功能而非插件设置——实验性列表改名可选插件。

本决定部分取代 [Plugins 页上的插件配置](../architecture/2026-09-16-plugin-configuration-on-the-plugins-page.zh.md)中的"按已服务命名空间注册"规则，以及[单一入口 note](../simplification/2026-10-09-plugins-page-single-entry.zh.md)中"卡片以命名空间为键"的集合；两篇 note 保持有效并已就地更新事实。`settingsScope.whileServed` 仍保留在服务上，供仍需要按已服务命名空间为门的调用方使用。

## Alternatives considered

**保留命名空间键与已服务过滤。**被过滤的卡片无法表达"关闭时仍列出"，命名空间键也给不了卡片一个可切换的行；本次新增的开关能力在该契约下不可能实现。

**以 `entryId` 为键。**Loader 条目 id 命名的是模块实例，而不是 Host 插件管理 API 接受的稳定 patch 行，开关因此无法寻址该行；`entryId` 仅作为 patch 无法寻址之行的回退路径保留。

**shell 拆成两张卡片，一个平台行一张。**两个行在同一平台从不共存，成对注册必然渲染一张死卡片；按共享标签合并保住单一开关，且不引入新的分组概念。

## Consequences

- 用户可以在 Plugins 页开关内置功能——shell 沙箱、agent 循环、子智能体、模型选择、网页搜索，以及 speech-to-text bundle；被关掉的功能保留卡片与开关。
- id 不命名任何行的条目退化为普通配置卡片，只在 Host 服务同名 settings 命名空间期间显示；社区插件保留这条路径。
- `ui-plugin-manager` 从 remotes 客户端契约新增 `PluginInfo` 导入；页面通过既有 `setRowEnabled` 动作与行键忙通道切换行。
- 内置分组卡片的 `data-plugin-item` id 现在命名 patch 行，因此凡行随平台变化之处它也随平台变化（`bash-sandbox` 对 `pwsh-sandbox`)；标签保持稳定。

## Testing

`components.client.spec.tsx` 覆盖绑定卡片的开关与 `setRowEnabled` 调用、关闭功能保持列出且其页面显示关闭状态、同标签合并偏好活着的成员及全关回退、以及忙、只读与拒绝锁定态及其原因文案。`apply.client.spec.ts` 固定六次无条件注册及其 patch 行 id。`plugin-config` web lane 通过真实链路驱动相同页面，并携带开关与改名分组重录其 golden。
