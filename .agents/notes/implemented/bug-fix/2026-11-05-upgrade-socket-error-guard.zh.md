# Agent Note：吸收升级前 socket 的对端重置

状态：已实现

[English](2026-11-05-upgrade-socket-error-guard.md) | 中文

## 问题

Gateway 的 `upgrade` 监听者在整个异步 `finish()` 窗口持有原始 socket —— node-channel 与 node-service 的授权、会话查询、上下文解析都要等数据库或文件系统往返，之后才有 channel 或 proxy 收养这条流。该窗口内 socket 没有 `error` 监听者，对端重置到达未被监听的 `error` 事件会击垮进程。CI 在 `node-access-postgres.spec.ts` 中观测到一次游离 `ECONNRESET`：agent 在握手中途死亡所致。

## 决策

在 [server.ts](../../../../gateway/src/server.ts) 的 upgrade 入口挂一个吸收型 `error` 监听。既有 `close` 监听已用 `hadError` 记录失败升级，每条异步授权路径在收养前仍检查 `socket.destroyed`，死 socket 无法完成握手。被收养的 WebSocket 保留自己的 error 处理；该守卫是叠加的，不抑制它们。

## 备选方案

**只在 `node-channel.accept` 内挂守卫。** 浏览器 API 升级与 service-proxy 升级存在同样的无守卫窗口；守卫应挂在唯一的所有权点。

**socket 出错时拒绝升级。** socket 已经死了；所有消费者本就通过 `close` 与 `destroyed` 检查结算。

## 后果

握手中途重置的客户端无法再击垮 Gateway。失败升级仍可通过性能结算的 `hadError` 记录观测。

## 验证

`node-access-postgres.spec.ts` 终止一个存活 node agent，其 channel 握手与授权窗口竞争；此前 CI 调度下每套件产生一次未处理 `ECONNRESET`。1222 个 gateway 测试继续全部通过。
