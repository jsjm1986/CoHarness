# Agent Note: Inspector 清理保留未确认的资源完成

Status: implemented

[English](2026-10-29-inspector-resource-completion.md) | 中文

## Problem

Inspector Worker 可能已经物理退出，但资源记账器仍不可用。永久缓存这次失败的完成请求，会使所有者在恢复后仍无法归还占用容量。启动失败将清理交给调用方时，也有相同责任。

## Decision

[Worker 生命周期](../../../../packages/experimental/inspector/src/host/bridge/lifecycle.ts)仅在物理退出后释放容量。它共用未完成的记账请求，保留成功确认，并清除被拒绝的请求，让显式清理调用可以重试。[公开句柄](../../../../packages/experimental/inspector/src/host/bridge/controller.ts)遵守同一规则。关闭失败时保留取消监听器与调用方清理责任；`InspectorStartupCleanupError.cleanup()` 在完成成功前持续可用。

Host 在排队前捕获资源提供者，并在原生分配前核对同一原始 Cordis Service。所有者变化会以 `ResourceAdmissionError` 的 `unavailable` 原因拒绝。调用方持有的 `InspectorAdmission.assertOwnership` 为程序化启动提供相同检查。未使用的许可归还原所有者；完成失败会在任何 Worker 或 MessageChannel 创建之前，通过 `InspectorStartupCleanupError` 转交可重试清理。启动取消和清理失败一起保留，包括就绪后、发布前发生的取消。

## Alternatives considered

**请求关闭时就释放容量。** 存活或状态不确定的 Worker 仍然占用获准资源。

**缓存每一次关闭结果。** 幂等成功有用，但被拒绝的记账请求不代表完成。

**在后台无限重试。** 所有者必须观察清理失败并选择重试时机；隐藏的重试会超出该所有权的生命周期。

## Consequences

调用方保留被拒绝的句柄或转交的清理，在记账器恢复后重试。并行尝试合并，成功调用保持幂等，恢复后的确认不会分配替代 Worker。等待中的启动不能接管替代提供者，需要重新请求。公开的分配和关闭方法保留现有参数，归属回调可选。

## Verification

真实 Worker 覆盖端点关闭后的完成失败、转交的启动清理、提供者替换、未使用许可的完成失败和显式恢复。独立[资源示例](../../../../packages/experimental/inspector/tests/fixtures/resource-cleanup.mjs)使用本地 HTTP 记账器，观察容量直到恢复确认前持续占用。[Web 组合](../../../../packages/experimental/inspector/tests/fixtures/startup-owner.mjs)验证过期启动不创建 Worker 或发布就绪公告，并随后启动新请求。Host 插件、控制器和生命周期测试满足逐文件覆盖率门槛；构建产物入口分支由普通 Node 应用快照覆盖。Windows 环境分派用例只验证元数据；真实 Windows 启动仍需要平台验证。
