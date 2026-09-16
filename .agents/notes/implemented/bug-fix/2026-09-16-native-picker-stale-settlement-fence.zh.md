# Agent Note：native 目录流程的 generation 围栏

状态：implemented

[English](2026-09-16-native-picker-stale-settlement-fence.md) | 中文

## 问题

`NativeDirectoryFlow` 在 `open` 上升沿只发起一次选择，但不保留请求身份：宿主选择器仍在屏幕上时 owner 先撤回 `open` 再重新打开，会发起第二次选择，而第一次选择的迟到结算仍经 `outcome.current` 解析——旧对话框的答案落到新请求的回调上。browse 对应组件有 `openGeneration` 围栏，native 流程没有。

## 决策

一个 `generation` ref 标记每次发起的选择。撤回 `open` 时递增 generation，被撤回请求的结算被丢弃；只有当前 generation 下发起的选择可以经 `outcome.current` 上报。`armed` 与 `alive` 守卫不变——重渲染与注入面重注册仍保留待结算请求，卸载仍丢弃它。

## 考虑过的替代方案

**`open` 撤回时取消进行中的选择。** 否决：协议上没有按请求的 abort，宿主对话框无法召回；结算围栏是唯一可以兜底的层。

**旧答案仍走旧回调上报。** 否决：`outcome.current` 已指向最新 props，不存在保留的旧回调通道，且被撤回的请求不应被后来的对话框答案解析。

## 后果

宿主选择器打开期间的 close/reopen 不再可能用旧对话框的路径解析新请求。被遗弃的选择器仍在宿主界面上完成，其答案不落到任何地方。

## 验证

`client-flow.client.spec.tsx` 覆盖该回归：跨越撤回→重开仍待结算的选择不上报任何回调，第二次选择正常解析当前请求。
