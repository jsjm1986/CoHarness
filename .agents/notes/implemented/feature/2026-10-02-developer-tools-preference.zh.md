# Agent Note: Developer-tools preference gates diagnostics surfaces through the shared settings scope

Status: implemented

[English](2026-10-02-developer-tools-preference.md) | 中文

## 问题

上游 `dsh-v0.2.0-rc.2` 向用户提供了 `developerTools` 偏好——关闭后收回诊断表面：轨迹视图、Agent 预设选择器、改动文件差异——以及同一设置行家族持有的若干同级偏好。上游把这些建在 `ctx.configForms` 上，而本 fork 没有这项服务：它会重复实现 `SettingsScope`/`SettingsScopeBinder` 已有的 schema 重建、有序写入与内存模式回退。fork 需要这份面向用户的能力，但不需要第二条偏好传输层。

## 决定

偏好搭载既有 scope 传输层。`ui-settings` 命名空间由 ui-settings 的宿主半注册，`enabled` 默认 true；[`SettingsScopeBinder`](../../../../packages/client/ui-settings/src/client/settings-scope.ts) 在启动时构造一个 [`DeveloperToolsPreference`](../../../../packages/client/ui-settings/src/client/developer-tools.ts)，以 `ctx.settingsScope.developerTools` 暴露——这是 binder 上第一个非 `bind` 成员。每个消费方共享该实例的 `enabled` observable 与 `setEnabled` 写入器，于是一次切换让所有门控按同一份已接受值重绘：trajectory 条目退出 `conversation.view` 列表，预设选择器不再渲染并丢弃陈旧台面组合的暂存选择，`DeliverablesInjected.showCodeDiff` 收回改动文件卡片。该行本身由 ui-settings-general 注册进 `settings.general.item`。Host 支持的 scope 在已接受值到达前保持禁用；被拒绝的写入在恢复读取后让写入器 reject，与该行报告失败的方式一致。

## 考虑过的替代方案

- **原样移植 `ctx.configForms`。** 否决：它会在一套平行 API 背后重复 binder 的 revision 围栏、有序写队列、镜像解码与 account/host 权限解析，此后每新增一项偏好都要在两个等价服务之间做选择。
- **每个消费方各自 bind 一个私有 scope。** 否决：每个 scope 的 disposer 归调用方 fiber 所有，行与门控将持有同一命名空间的多份镜像且失效订阅各自独立；共享成员只保留一套订阅与一份已接受值。
- **保持「始终开启」行为。** 否决：隐藏诊断表面是用户要求的上游对等能力，这些门控同时也是某些部署不想要的重表面的总开关。

## 后果

`ctx.settingsScope` 不再是纯粹的 `bind`/`describe` 面；消费方获得一个共享成员，`dsh-client-test-runtime` 中的 stub 通过 `stubDeveloperTools` 同步呈现它。内存模式 scope 让该偏好保持本地且默认启用，无回环的上下文不损失任何东西。上游的 `transcriptView`、`performanceUsage` 与 `linkOpening` 偏好尚无对应物，移植时沿用同一模式落地。
