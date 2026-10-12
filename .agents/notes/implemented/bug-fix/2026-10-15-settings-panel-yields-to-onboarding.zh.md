# Agent Note:onboarding 步骤出现时设置面板关闭

状态：已实现

[English](2026-10-15-settings-panel-yields-to-onboarding.md) | 中文

## 问题

onboarding 步骤以遮罩占据整个视口，该遮罩只把 `#root` 标记为 inert。设置面板 portal 在 `#root` 旁边、处于该标记之外，因此面板打开期间步骤出现时，对话框仍可在 onboarding 遮罩之后聚焦与点击——屏幕上同时存在两个竞争的模态面。上游修复是 `7dfad907488` 的设置面（其 window-drag 各面针对桌面拖拽区域平台，本 fork 不携带；dockkit 浮窗拖拽声明撤退在本地早已存在）。

## 决策

`SettingsRoot` 观察解析出的 `onboardingStep`：面板打开期间有步骤出现时，面板经由与遮罩点击、Escape 相同的 `actions.close()` 路径关闭。观察者与上一已见步骤的 ref 比较，因此只有"无步骤→有步骤"的转换才解散面板；面板打开时本就可见的步骤不构成解散触发。

## 备选方案

**改为把面板 portal 到 `#root` 之下。** 步骤的 `inert` 标记届时会覆盖面板，但面板仍会渲染并对辅助技术宣告为打开的对话框——关闭才是诚实的形态。

**给 onboarding 遮罩更高的层叠声明。** 那只是遮住症状而非修正状态：面板 store 仍报告 `open`，触发器仍宣告展开的对话框，Escape 路由在两个模态层之间依旧含糊。

## 影响

面板不再与 onboarding 步骤同屏；由于解散走常规关闭动作，其 open 状态、触发器 `aria-expanded` 与 document 监听保持一致。onboarding 期间仍可重新打开——该 effect 只在出现沿触发——与上游一致。

## 验证

`settings-root.client.spec.tsx` 以活跃会话挂载（无步骤），打开面板后把会话置 blank 使步骤出现，对话框随之消失。既有遮罩/Escape 关闭路径用例保持通过，覆盖共享的 `actions.close()` 路径。

## 关联

- [2026-10-15 composer 栈 tooltip portal](2026-10-15-composer-stack-tooltip-portals.zh.md)——同一批客户端对齐中的相邻遮罩/portal 修复。
