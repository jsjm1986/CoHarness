# Agent Note: open-in-app 的菜单选择在启动兑现后持久化，悬浮标签点名应用

Status: implemented

[English](2026-10-18-open-in-app-pick-commit-hover-label.md) | 中文

## 问题

`OpenInAppAction` 在启动请求结算前就通过 `choose(id)` 持久化菜单选择，因此失败的打开会替换上一次记住的应用——下一次主按钮点击又会去启动刚刚失败的应用。分体按钮还把应用专属标签只放在 `aria-label` 上；悬浮 Tooltip 渲染的是通用 `open.tooltip` 文案，因此悬浮文本从不点名按钮将打开的应用。两处都偏离了上游 `OpenTargetButton` 的契约：上游在记住选择前先等待启动，并把所选应用的标签交给 tooltip。

## 决策

菜单选择在 `launch` promise 兑现时提交：`onSelect` 把 `choose` 作为启动辅助函数的成功回调传入，因此 `open-in-app/open` POST 被拒绝时持久化的 `dsh.open-in-app.choice` 保持不变，下一次主按钮点击仍启动先前记住的应用。飞行中合并语义不变——启动期间的菜单选择在请求任何持久化之前就被整体忽略——busy/error 视觉仍围绕同一个 promise。Tooltip 的 label 与 `aria-label` 使用同一个应用专属字符串（当前应用的 `open.title`，失败展示期间的 `open.error`），与上游 `primaryLabel` 的摆放一致。

## 文件

- `packages/client/ui-open-in-app/src/client/OpenInAppAction.tsx`——选择经启动成功回调持久化；Tooltip label 与 aria-label 共用应用专属文本。
- `packages/client/ui-open-in-app/tests/open-in-app-action.client.spec.tsx`——测试台的 selector 垫片改为与生产绑定一样经 `useSyncExternalStore` 订阅；新增用例钉住：失败的选择保留记住的应用、成功的选择被记住、悬浮文本点名应用。

## 考虑过的替代方案

**先即时持久化、失败时回滚。** 在拒绝后恢复先前的 id 会多一次写入，而且飞行途中仍会把按钮重绘成失败应用的名字；把写入延后到兑现时保持单一提交点且不重绘。

**保留通用 tooltip。** 按钮已经为 `aria-label` 算好了应用标签；悬浮时显示另一条通用字符串会让指针用户得到的信息比辅助技术播报的还少，且与上游不一致。

## 后果

失败的自定义选择不再顶替记住的应用，悬浮文案点名主点击将打开的具体应用。`open.tooltip` 词典条目在两种语言中保留——上游也保留该键——尽管分体按钮不再渲染它。

## 验证

`open-in-app-action.client.spec.tsx` 覆盖了被拒绝的选择保留并再次启动记住的应用、成功的选择持久化并驱动下一次主点击、所选应用名出现在悬浮 tooltip 中；既有 tooltip 用例改为断言应用专属标签。
