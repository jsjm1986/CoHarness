# Agent Note: Gateway proxy absorbs library-level 'error' events instead of crashing

Status: implemented

English | [中文](2026-10-12-gateway-proxy-error-listeners.zh.md)

## Problem

`createProxyHandlers` created the `http-proxy-3` server with only per-request error callbacks and no server-level `'error'` listener. The library installs a single `onError` that rethrows the error when it is the only listener, so any failure reaching `server.emit('error')` became an uncaught exception that terminated the Gateway process. One emit site is unconditional: the `ws` entry point forwards every `'error'` event on the client-facing socket to the proxy server, so a routine TCP reset on an upgraded WebSocket surfaced as `Error: read ECONNRESET` and killed the whole process — observed live when a steward-scope page load dropped its WebSocket connections. The same listener gap existed on the proxied response stream, which the library pipes without an `'error'` listener.

## Decision

The Gateway owns a server-level `'error'` listener that logs a bounded diagnostic (error code, method, path) and settles whatever the event carries: a usable `ServerResponse` receives `502 INSTANCE_UNREACHABLE`, an already-open response ends, and a WebSocket duplex is destroyed. A `'error'` listener is also attached to every `proxyRes` in the existing `proxyRes` hook, ending the client response after an upstream reset mid-body. Per-request callbacks stay the first-line settlement and now check `res.destroyed` before writing so a late error cannot throw inside the callback itself.

## Alternatives considered

**Route every failure through the per-request callback.** Rejected: the `ws` socket-error emit site does not consult the callback, so some failures can only be caught at the server level.

**Convert the error to `INSTANCE_STARTING` so clients retry.** Rejected: a socket-level failure carries no liveness signal; the existing admission path already answers `INSTANCE_STARTING` when a restart is actually warranted.

## Consequences

A client or upstream socket reset — WebSocket or plain HTTP, before or after headers — logs one line and ends at most that one request; the process no longer depends on every transport emitting only events the library happens to forward to a callback.

## Verification

`gateway/tests/proxy.spec.ts` resets the client socket of an admitted WebSocket with `resetAndDestroy()` and kills a runtime mid-response-body; both used to surface as `Error: read ECONNRESET` uncaught exceptions and now produce the bounded log line while the gateway keeps serving.

## Related

- [Gateway startup resilience](2026-08-18-gateway-startup-resilience.md) — the earlier hardening pass on the same process-critical surface.
