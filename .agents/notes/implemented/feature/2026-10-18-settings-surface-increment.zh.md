# Agent Note：rc.2 上游设置面增量

状态：已实现

[English](2026-10-18-settings-surface-increment.md) | 中文

## 问题

上游 rc.2 将插件设置拆为标签壳加特性自有标签（`settings.plugins.tab` 槽位），并携带 `ui-settings-plugin-inventory`——一个只读的 Cordis Loader 清单标签。fork 的 `ui-settings-plugins` 此前只有按插件的配置卡；清单标签曾被裁决为 `reject`（与侧栏插件面板重复）。owner 的插件对齐指令推翻该裁决：上游设置功能全部落地，挂进 fork 自有设置架构。

## 决策

上游 `PluginsSettingsSection` 壳与 `settings.plugins.tab` 贡献槽移植进 fork 的 `ui-settings-plugins`，与既有表单卡（AgentLoop、Bash、SubagentLimits、SubagentModelSelection、WebSearch）并存，表单卡角色不变。`ui-settings-plugin-inventory` 逐字移植（包本体、双语 locales、测试），注册一个惰性 `'all'` 标签，读 `remote.pluginInventory.list` 与 `modules.entries.state` 以支持 client-sync 重试。`web-app` bundle 补丁将其与已在线路侧的 `dsh-host-plugin-inventory` 并排编入。

fork 维持自身设置模型：按插件配置卡仍是编辑面；清单标签为只读，不重复安装与启用动作。`desktop.update.*`（Desktop 排除面）与 `deepSeekAccount` 段继续排除。

## 已考虑的替代方案

- **维持 reject** 被 owner 指令否决；该标签是信息面而非重复管理面。
- **并入 `ui-plugin-manager`** 被否决：上游自身落点在设置标签，且 fork 的管理面已承载动作语义。

## 测试

`npx vitest run packages/client/ui-settings-plugins packages/client/ui-settings-plugin-inventory`——9 份文件、145 项测试通过。未携带：上游 `client/modules` release gate + `HostReleasePrompt` 链——它需要 Host 发布 release 身份，fork manifest 尚未承载；作为 `ui-settings-general` 矩阵行上的待定增量跟踪。

## 后果

设置的插件页现在带上了上游的 tab 外壳，上游插件 tab 可以不经改造挂进 fork。清单 tab 严格只读——启用状态仍由 fork 的管理面负责，避免对同一份 Loader 状态开第二条变更路径。
