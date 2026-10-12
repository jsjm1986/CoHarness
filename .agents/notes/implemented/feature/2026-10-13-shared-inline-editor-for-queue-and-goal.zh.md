# Agent Note: 共享 InlineEditor 在队列与 goal 编辑中保留换行

Status: implemented

[English](2026-10-13-shared-inline-editor-for-queue-and-goal.md) | 中文

## 问题

QueueDock 的行编辑器与 GoalBar 的目标编辑器都是单行 `<input>`。HTML 会从 input 值中剥掉换行，因此保存含换行的排队消息或 goal 时会静默丢失换行；粘贴多行草稿在重新编辑前就已塌陷。上游来源：`66e101821c334723a38b98dadf289b5f771915a7`（`refactor(client): share the queued-message and goal inline editor`），两个 alpha 发布均含。

## 决策

`ui-primitives` 导出 `InlineEditor`：一个自动聚焦的 `<textarea>`，随文本增高至六条 CSS 行高，之后滚动。`ResizeObserver` 在元素宽度变化时重新适配高度，因为重换行会改变 `scrollHeight` 而不改变值。键盘契约：普通 Enter 保存，Shift+Enter 换行，输入法组合中的 Enter（含旧式 `keyCode === 229` 信号）不生效，Escape 取消。调用方提供本地化的 `label` 作为无障碍名称，以及可选的摆放 `className`。

QueueDock 的编辑分支与 GoalBar 的编辑分支都改用 `InlineEditor`，替代各自的本地 `<input>` 处理；各消费方的编辑器样式一并移除，两个表面共享该原子的几何与焦点环。`Input` 仍是单行原子；其文件头注明多行行内编辑使用 `InlineEditor`。

## 考虑的替代方案

**每个消费方各留一个 textarea。** 已否决：两个编辑器早已各自重复了同样的自适配与输入法处理，继续复制 refit 逻辑只会再次漂移。

**修复 `<input>` 以保留换行。** 已否决：单行控件无法显示它要保留的值；可编辑多行文本的语义元素是 `<textarea>`。

## 影响

编辑含内嵌换行的排队消息或 goal 时，换行在草稿与保存中均保留。两个编辑器同时获得宽度感知 refit 与一致的输入法保护；未来的行内编辑表面经由共享原子继承该行为。只读 queue 预览与 goal 显示的消费方无变化。

## 验证

`packages/client/ui-primitives/tests/inline-editor.client.spec.tsx` 覆盖自动聚焦、`rows=1`、保留换行的 `onChange`、普通 Enter 保存（含 `preventDefault`）、Shift+Enter、`isComposing`/`keyCode 229` 抑制、Escape 取消、scrollHeight 加边框的尺寸计算，以及 `ResizeObserver` 的重适配与销毁。`packages/client/ui-conversation/tests/queue-dock.client.spec.tsx` 与 `packages/client/ui-goal/tests/goalbar.client.spec.tsx` 经由共享编辑器覆盖保存/取消流程。

## 相关

- [Web 输入机与 slash 管道](../architecture/2026-07-25-web-input-machine-and-slash-pipeline.zh.md) — 拥有队列编辑器旁侧的 composer 键盘仲裁。
