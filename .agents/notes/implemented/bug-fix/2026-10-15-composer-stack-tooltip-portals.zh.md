# Agent Note：Composer 栈上悬浮条 tooltip 以 portal 逃离层叠上下文

状态：已实现

[English](2026-10-15-composer-stack-tooltip-portals.md) | 中文

## 问题

goal 条与队列坞紧贴输入卡片上方，两者都建立层叠上下文（`isolation: isolate`），好让自己的磨砂面板留在自身内容之后。在该上下文内渲染的 `Tooltip` 气泡就地解析 z-index，而输入卡片在同一父级上下文中更晚绘制，于是胜出：goal 条的气泡只剩两像素细边，队列坞的气泡则完全不可见。上游修复为 `5082e05f713`；本地 `Tooltip` 早已具备 `portal` 契约，但两个 composer 栈消费方都没有传它。

## 决策

`QueueDock` 与 `GoalBar` 中的每个 `Tooltip` 现在都传 `portal`，气泡挂载到 `document.body` 下，其 z-index 得以高过整张卡片。契约表述位于 `ui-primitives` 的 Tooltip JSDoc，其中把祖先层叠上下文与裁剪容器并列举出。

## 备选方案

**在坞内提高气泡 z-index。** 层叠上下文无法从内部用 z-index 逃离；任何取值仍会输给更晚绘制的兄弟上下文。只有离开该上下文——即 portal——才能修正层级。

**全局 portal 所有 tooltip。** 未被压盖的锚定气泡留在锚点所在布局中仍有收益（同一滚动视口、同一变换空间）；该 prop 保持按需启用，由位于层叠上下文或裁剪容器附近的调用方有意传入。

## 影响

两条坞的十一个 tooltip 现挂载到 `document.body` 下；以 `[data-queue-dock]` 为范围的 ARIA 捕获不再包含它们，因此 `queue-actions` 的 golden 删去了 tooltip 行，而场景获得 elementFromPoint 命中测试，证明气泡绘制在最上层。改动仅涉呈现：props、事件与 locale 均未变动。

## 验证

`queue-dock.client.spec.tsx` 与 `goalbar.client.spec.tsx` 各自断言悬停动作的气泡渲染在 `document.body` 下。`queue-actions.e2e.ts` 与 `goal-bar.e2e.ts` 通过 `expectTooltipOnTop`（support.ts）断言气泡中心与底边均命中到气泡本身；队列 `editing`/`ui` golden 不再记录坞内 tooltip 条目。定点 spec 通过。

## 关联

- [2026-10-14 preset 切换拒绝 toast](2026-10-14-preset-switch-refusal-toast.zh.md)——相邻的 composer 反馈面，`Toast` 在设计上始终 portal 到 body。
