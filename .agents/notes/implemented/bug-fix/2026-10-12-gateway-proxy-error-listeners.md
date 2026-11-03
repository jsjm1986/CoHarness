# Agent Note: Gateway proxy absorbs library-level 'error' events instead of crashing

Status: implemented

English | [中文](2026-10-12-gateway-proxy-error-listeners.zh.md)

## Problem

`createProxyHandlers` created the `http-proxy-3` server with only per-request error callbacks and no server-level `'error'` listener. The library installs a single `onError` that rethrows the error when it is the only listener, so any failure reaching `server.emit('error')` became an uncaught exception that terminated the Gateway process. One emit site is unconditional: the `ws` entry point forwards every `'error'` event on the client-facing socket to the proxy server, so a routine TCP reset on an upgraded WebSocket surfaced as `Error: read ECONNRESET` and killed the whole process — observed live when a steward-scope page load dropped its WebSocket connections. The same listener gap existed on the proxied response stream, which the library pipes without an `'error'` listener.

## Decision

The Gateway owns a server-level `'error'` listener that logs a bounded diagnostic (error code, method, path) and settles whatever the event carries: a usable `ServerResponse` receives `502 INSTANCE_UNREACHABLE`, an incomplete response whose headers are sent is destroyed, and a WebSocket duplex is destroyed. An `'error'` listener is also attached to every `proxyRes` in the existing `proxyRes` hook and destroys the client response after an upstream reset mid-body. Per-request callbacks stay the first-line settlement and check `res.destroyed` before writing so a late error cannot throw inside the callback itself.

Incomplete bodies cannot end as successful HTTP messages. A clean end preserves the upstream success status and lets browsers or CDNs cache a truncated immutable plugin script. Destruction preserves the transport failure for downstream consumers.

Remote-computer forwarding retains each `ClientRequest` error listener through transport disposal. A failed HTTP request or WebSocket handshake can receive another abort from its duplex stream after the first failure has settled; that event must remain contained in the same request.

The node-local TCP connection keeps its writable half open after response EOF. Both pipelines finish before transport disposal, and a clean TCP close does not destroy pending WebSocket output. Otherwise a fast local response and a slow outbound connection can truncate a script or download after successful headers.

Idle control connections send WebSocket Ping frames at their authenticated lease’s heartbeat interval. Transport liveness is independent of PostgreSQL lease renewal and cannot retain execution authority after its lease expires. Closing the channel clears its Ping timer before reconnecting.

## Alternatives considered

**Route every failure through the per-request callback.** Rejected: the `ws` socket-error emit site does not consult the callback, so some failures can only be caught at the server level.

**Convert the error to `INSTANCE_STARTING` so clients retry.** Rejected: a socket-level failure carries no liveness signal; the existing admission path already answers `INSTANCE_STARTING` when a restart is actually warranted.

## Consequences

A client or upstream socket reset — WebSocket or plain HTTP, before or after headers — logs one line and ends at most that one request; the process no longer depends on every transport emitting only events the library happens to forward to a callback.

## Verification

`gateway/tests/proxy.spec.ts` resets the client socket of an admitted WebSocket with `resetAndDestroy()` and kills a runtime mid-response-body. Both produce the bounded log line while the Gateway keeps serving; consuming the incomplete HTTP body rejects.

`gateway/tests/node-service.spec.ts` fails actual forwarded scope-change and WebSocket requests, then delivers a late transport abort to their `ClientRequest` objects and checks that the Gateway still serves account metadata.

The same fixture holds an outbound response frame through the local TCP EOF and its close callbacks, then verifies the complete response after releasing the frame.

## Related

- [Gateway startup resilience](2026-08-18-gateway-startup-resilience.md) — the earlier hardening pass on the same process-critical surface.
