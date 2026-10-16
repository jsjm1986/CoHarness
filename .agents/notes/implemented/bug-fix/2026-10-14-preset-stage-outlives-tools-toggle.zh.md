# Agent Note: 代码工作视图偏好只在其关断转换时清空预设暂存

Status: implemented

[English](2026-10-14-preset-stage-outlives-tools-toggle.md) | 中文

## Problem

`AgentPresetSeatController` 在组合时检查「显示代码工作视图」偏好：`apply()` 与 `load()` 在偏好关闭时丢弃暂存选择。Creator 入口——设置区按钮与 Plugins 页添加菜单项——有意在该偏好关闭时仍可触达，因此偏好已关时，入口暂存 `cordis` 并启动会话——随后 chip 挂载时的 `load()`（或会话到达时的 `apply()`）静默丢弃了该暂存。新会话以部署默认值而非 Creator 模式运行，没有拒绝、没有错误、没有痕迹。上游契约的关键差别在于：偏好只在其关断**转换**时清空暂存，从不在 apply 时点检查，因此偏好已关期间产生的暂存仍会落地。

## Decision

seat 控制器不感知偏好：`apply()` 在当前空白会话存在时组合任何已暂存的选择，`load()` 仅在 roster 报告 `modeSelectionEnabled` 为 false 时丢弃暂存——隐藏的选择器无法承接暂存选择。`clearStage()` 是公开的「丢弃未应用选择」操作；`developerTools.enabled` 订阅在偏好关断时对每个 seat 调用它，随后执行 `apply()`，使 chip 按当前会话的组合或部署默认值重新推导所显示的选项，而非展示已失效的选择。

- 偏好已关闭期间产生的暂存仍会落地：`stage()` 后接 `apply()` 会组合流程产出的会话。两处 Creator 入口与设置驱动的空白会话同步在偏好关闭时保持可用。
- 运行中会话已生效的预设在所有路径下都不受影响：门控只清空未应用的暂存。

## Alternatives considered

**仅在 apply 时点对 `cordis` 放行。** 在控制器内对单个预设 id 特判掩盖了真正的规则——偏好约束的是暂存产生的**时机**而非其**命名**的预设——并且仍会丢弃偏好关闭期间由设置写入触发的空白会话同步。

**保留 apply 时点检查作为第二层。** `apply()` 中的持续拒绝会对偏好关闭期间产生的每个暂存复现静默丢弃故障；关断转换时的清理已经覆盖了该检查原本针对的「先选择、后关偏好」场景。

## Consequences

从设置区或 Plugins 页启动的 Creator 模式无论偏好开关都会组合它启动的会话，会话头部标签如实报告。偏好打开期间暂存的选择仍在其关断的那一刻被丢弃；隐藏选择的部署（`modeSelectionEnabled: false`）仍在 `load()` 中丢弃暂存。上游的 `requiresCodingTools` 逐项过滤与 `reconcileCodingTools` 默认值回退继续不移植——它们服务于上游「选择器常显、仅过滤 PTC/Minimal」的四表面设计，而本构建在单一偏好下整体隐藏 chip。

## Verification

`ui-agent-preset` 规格——新的 apply 套件用例在偏好关闭时驱动 `startCreatorDraft`，断言 `select:cordis` 落地到随后到达的空白会话；另一个用例断言打开期间暂存的选择在关断转换时被丢弃、且所显示选项被重新推导为部署默认值。`settings-store` 规格以「外部清场后重推显示」用例替换了 apply 时点拒绝用例。212 个测试通过。
