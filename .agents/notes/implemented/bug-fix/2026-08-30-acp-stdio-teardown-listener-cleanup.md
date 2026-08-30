# Agent Note: Close ACP stdio transports during teardown

Status: implemented

English | [中文](2026-08-30-acp-stdio-teardown-listener-cleanup.zh.md)

## Problem

The ACP bridge owns an SDK connection over process stdio when no transport override is supplied. Disposing the Cordis plugin previously closed ACP sessions but left that SDK connection open, so its `Readable.toWeb(process.stdin)` and `Writable.toWeb(process.stdout)` adapters retained `end` listeners across repeated HMR or test instances.

## Decision

ACP teardown closes the SDK connection after owned sessions settle when the bridge created the process-stdio transport. The SDK cancellation path then releases its stdio reader and the bridge keeps its existing idempotent quiesce promise for session cleanup and error aggregation. A caller-provided transport remains caller-owned and is not closed by plugin disposal.

## Verification

ACP focused tests and the serial thread-safe suite cover repeated bridge creation and disposal. With `NODE_OPTIONS=--trace-warnings`, the process-stream listener warning no longer appears; the bridge still reports session-close failures through its existing logger path.

## Alternatives considered

**Raise the process stream listener limit.** Rejected because it hides retained transport ownership and allows unbounded HMR/test accumulation.

**Rely on Cordis disposal of the stream adapters.** Rejected because the adapters are owned by the SDK connection, not by an independent Cordis plugin effect.

**Close sessions first and let the connection close asynchronously.** Rejected because the process-stdio transport must be closed within the bridge's quiesce promise; otherwise repeated mounts retain listeners. The close follows session settlement so in-flight prompts can deliver their normal cancelled result.

## Consequences

Disposing ACP now closes both protocol transport and owned sessions. A peer that is still connected observes the standard ACP connection close, while normal session cleanup and aggregated diagnostics remain unchanged.
