# Agent Note: 不受限 Inspector 必须使用独立本地权限

Status: implemented

[English](2026-10-31-inspector-managed-debugging.md) | 中文

## Problem

Inspector 的 Host 求值可以读取私有 Session、凭据和未脱敏 fetch，Client 求值也可以在其他已连接浏览器中执行操作。浏览器身份认证允许共享项目用户访问，但不会授予这些权限。因此，即使 Worker 只监听 loopback，经过身份认证的 CDP 代理也会绕过逐请求执行限制。

## Decision

[Host 插件](../../../../packages/experimental/inspector/src/host/plugin.ts) 要求独立本地权限。所属 realm 或根运行时存在 execution-authority provider 或要求 provider 的标志时，启动会在分配资源前拒绝。服务隔离不能隐藏根策略，两种范围的撤销都会通知该插件。引入策略会取消排队中的启动；运行中的实例会同步阻止其 HTTP 和 CDP 传输，然后移除注册并关闭已有 socket 和 Worker。清理失败仍可重试。撤下策略不会重新激活该实例。

## Alternatives considered

**复用项目身份认证或 execute 权限。** 两者都不会授予访问 Host 内存、凭据或所有已连接 Client 的权限。调试器没有按权限限制的实现。

**隐藏面板或增加 token。** 这些措施不会限制已获准调试者的任意求值权限。

## Consequences

共享受管运行时不能启用这个不受限的调试插件。独立本地开发保留现有调试器。只有明确调试特权，并隔离数据与执行语义后，才能放宽此限制；仅有项目成员身份始终不够。

## Verification

真实 Loader/Web [示例](../../../../packages/experimental/inspector/tests/fixtures/managed-debugging.mjs) 验证已安装或必需的权限策略在启动前、排队准入期间，以及原生 Worker 就绪后出现的情况，也验证独立求值和 Worker 的实际退出。路由测试覆盖保留的回调，以及资源结算失败后的重试。
