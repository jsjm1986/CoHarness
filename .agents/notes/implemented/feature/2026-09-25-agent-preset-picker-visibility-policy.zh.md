# Agent Note：Agent-preset 选择器可见性是一个 settings 字段，由宿主解析唯一选择策略

Status: implemented

[English](2026-09-25-agent-preset-picker-visibility-policy.md) | 中文

## 问题

上游 alpha.2 允许部署方完全隐藏 Agent 模式选择器：新会话 chip 消失，每个未指名的会话都按部署默认值组装，而已保存的个人默认值暂时失效。把它移植到本地的项目级 settings 架构，需要一条宿主、名册与三个客户端表层都能读到、且不靠 UI 省略来强制执行的唯一规则。

## 决策

**`modeSelectionEnabled` 是 `agent-presets` settings 命名空间的第二个字段，由宿主在每次读取时解析。**

- 命名空间注册 `default` 与 `modeSelectionEnabled`（schema base 为 `{ default: config.default, modeSelectionEnabled: true }`），并带 `owner: 'project'`、`projectWrite: 'manager'`、`projectWritePaths: [['default'], ['modeSelectionEnabled']]`——Gateway 项目作用域下只有项目管理者能改这两个字段；个人部署下二者都是普通的用户设置。
- `AgentPresets.selectionPolicy()` 是唯一读取点：字段缺席时 `enabled` 默认为 `true`，`defaultId` 仅在开启时取已保存的 `default`——否则取 `config.default`。`defaultId` 与远程名册（`remoteExportList`）都读它，因此即便文档正在热重载，`isDefault` 与 `modeSelectionEnabled` 也永远来自同一份 settings 快照。
- 标志从不改写已保存的 `default`：隐藏选择器只是搁置它，重新显示即恢复生效。没有 settings 访问权的客户端照样得到答案——名册同时报告标志与已解析的 `isDefault`。
- 执行点在宿主而非 UI 省略：`defaultId`（`mount()` 为未指名会话查询的对象）经同一策略解析，因此绕过所有选择器的直接调用在选择关闭时仍得到部署默认值。
- 客户端遵守同一边界而不重复推导：`AgentPresetSeatController` 在名册报告 `modeSelectionEnabled: false` 时隐藏 chip 并丢弃未消费的暂存值，用代际计数器守护重叠的名册读取，只有最新的答复可以发布。分区控制器写入标志、重读名册、确认宿主有效默认值——以一次新的 `agentPresets/list` 读取为准而非发布快照（`settings/document-updated` 触发的在途读可能带着写入前状态作答）——之后，才可选地经 chip 自身的 `agentPresets/select` 通道把它同步到写入时捕获的那个确切空白会话——运行中与历史会话永不被触碰。
- 管理分区把选择策略与名册事务分开：隐藏选择器会禁用默认值选择与「创造模式」入口（二者都会宣称一个宿主拒绝生效的效果），而查看、复制、位置与删除保持可用；写入进行中、或该命名空间拒绝本浏览器写入时（共享 settings describe 镜像给出的 `policyWritable`/`writableReason`），开关本身也禁用。

## 备选方案

**名册只带隐藏标志、`defaultId` 仍跟随已保存默认值。** 否决：已保存的个人选择会在一个不提供任何选择的界面上悄悄组装新会话——策略退化为 UI 执行，任何直接 mount 的调用方都能绕过。

**隐藏选择器时把部署默认值写进 `default`。** 否决：这会销毁已保存的偏好，重新开启时永远无法恢复；搁置该字段让开关无损。

**为同步路径做 `hasConversationContent` 式的客户端空白检查。** 已在[preset 远程边界 note](../architecture/2026-09-21-preset-remote-contract-boundaries.zh.md)中否决；同步走 `agentPresets/select`，由它持有 turn 边界空白规则。

## 结果

未指名会话的组装成为宿主对两个 settings 字段的解析函数，每个消费方——chip、General 行、分区，以及任何非环回客户端——都向名册的答案收敛。个人作用域部署得到与上游逐字一致的行为；项目部署把选择器可见性变成管理者的策略，普通成员则看到带原因说明的只读分区。[per-preset 常驻挂载 note](../architecture/2026-08-08-per-preset-standing-mounts.zh.md) 持有该策略所选择的组装模型。
