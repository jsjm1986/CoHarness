# Agent Note: Gateway 代理吸收库级 'error' 事件而不再崩溃

Status: implemented

[English](2026-10-12-gateway-proxy-error-listeners.md) | 中文

## Problem

`createProxyHandlers` 创建的 `http-proxy-3` 服务器只有逐请求错误回调，没有服务器级 `'error'` 监听器。该库安装的 `onError` 在自己是唯一监听器时会重新抛出错误，所以任何抵达 `server.emit('error')` 的故障都会变成未捕获异常并终结 Gateway 进程。其中一个 emit 点是无条件的：`ws` 入口把客户端 socket 上的每个 `'error'` 事件都转发给代理服务器，因此已升级 WebSocket 上一次寻常的 TCP 复位会以 `Error: read ECONNRESET` 的形式杀死整个进程——已在 steward 空间页面加载丢弃其 WebSocket 连接时实际观测到。被代理的响应流存在同样的监听器缺口：库在 pipe 它时也不挂 `'error'` 监听。

## Decision

Gateway 持有一个服务器级 `'error'` 监听器，记录有界诊断（错误码、方法、路径）并妥善结算事件携带的对象：仍可用的 `ServerResponse` 收到 `502 INSTANCE_UNREACHABLE`，已写头的响应被结束，WebSocket 双工被销毁。同时在既有 `proxyRes` 钩子里为每个 `proxyRes` 挂上 `'error'` 监听，使上游在响应体中途复位时客户端响应得以结束。逐请求回调仍是第一道结算层，并在写出前检查 `res.destroyed`，使迟到的错误无法在回调内部抛出。

## Alternatives considered

**把所有故障都路由进逐请求回调。** 否决：`ws` 的 socket 错误 emit 点不经过回调，某些故障只能在服务器级捕获。

**把错误转换成 `INSTANCE_STARTING` 让客户端重试。** 否决：socket 级故障不携带活性信号；准入路径在确实需要重启时已经会回答 `INSTANCE_STARTING`。

## Consequences

客户端或上游 socket 复位——无论 WebSocket 还是普通 HTTP、无论发生在响应头之前还是之后——只会留下一行日志并至多终结那一个请求；进程不再依赖"传输层恰好只发出会被转发到回调的事件"。

## Verification

`gateway/tests/proxy.spec.ts` 用 `resetAndDestroy()` 复位一条已准入 WebSocket 的客户端 socket，并在响应体中途杀死运行时；两条路径过去都以 `Error: read ECONNRESET` 未捕获异常的形式出现，现在只留下有界日志行，同时 Gateway 继续服务。

## Related

- [Gateway startup resilience](2026-08-18-gateway-startup-resilience.zh.md) — 同一进程生死面上的上一轮加固。
