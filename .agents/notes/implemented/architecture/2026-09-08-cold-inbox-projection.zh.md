# Agent Note：无需 Agent 的 Inbox 投影

Status: implemented

[English](2026-09-08-cold-inbox-projection.md) | 中文

## 问题

无 Agent 的 Session 历史读取包含持久化 Inbox splice，却没有可供查询待处理队列的 live Agent。尾页可能不含较早的 splice，因此浏览器不能仅凭尾页重建待处理输入。

## 决定

ApiProxy 通过可释放的 Cordis effect 注册 `inbox` Session 投影。它忽略继承事件，折叠两个 Inbox 目标，拒绝非法 splice 范围和重复身份，并通过现有投影载体发布待处理行。Client Session 实例订阅各自的投影存储，在释放时取消订阅。实时队列修改及其准入限制仍由 Agent.inbox 负责；历史读取不会激活 Agent，也不授予修改权限。

## 考虑过的替代方案

为读取历史而恢复 live Agent 会给读取操作带来执行和生命周期副作用。用上游 controller 替换 ApiProxy 还会替换 CoHarness 的授权和多 runtime 路由，而实现该投影并不需要这样做。

## 后果

冷历史可以显示待处理输入，同时保留 Gateway 授权和每个 pane 的 runtime 归属。现有实时队列帧继续兼容没有该投影的客户端。移除任一交付路径前，需要测量重复载荷成本。[已领取 Inbox 生命周期](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md) 仍负责定义修改和领取行为。
