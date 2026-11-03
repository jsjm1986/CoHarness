# Agent Note: File-preview cancellation listeners end with each read

Status: implemented

English | [中文](2026-11-03-media-reference-listeners.zh.md)

## Problem

The `/api/file` handler attaches one socket-close listener per bounded filesystem read. A keep-alive socket survives completed GET and HEAD requests, so `once()` alone retains those listeners until the connection closes. Repeated previews accumulate AbortControllers and exceed Node's listener warning limit.

## Decision

The [handler](../../../../packages/api/gateway/src/media-references.ts) keeps its exact cancellation callback and removes it in `finally` after resolution, metadata, content or failure settles. A socket close during the read still aborts the provider operation. Other owners' listeners remain intact.

## Alternatives considered

**Increase the listener limit.** This hides the warning while retaining completed operations.

**Use the request close event.** An incoming GET can finish before its provider read; that event cannot replace socket disconnection for the accepted read.

## Consequences

The authenticated read policy, byte limits, status codes and complete-file responses remain defined by the [file-display decision](../feature/2026-09-08-file-display-through-filesystem.md). Cancellation ownership ends when the handler settles, independently of HTTP keep-alive duration.

## Verification

Four focused cases check listener release after GET, HEAD, filesystem refusal and unexpected provider failure. The real Loader [example](../../../../packages/api/gateway/tests/fixtures/media-reference-lifetime.mjs) authenticates through Connection and verifies sixteen file previews on one native keep-alive socket. Completed requests retain no read-cancellation listeners.
