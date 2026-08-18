# Agent Note: Lossless history wire pagination

Status: implemented

English | [中文](2026-08-14-lossless-history-wire-pagination.zh.md)

## Problem

A public Web session's first `session.history` call with `maxMessages: 50` returned 28,187 expanded events (6.19 MB JSON, 98.8% `assistant/chunk`) and took 17.8–48.5 s on the Cloudflare path, while the same logical page decoded locally in 84 ms. The page stayed on “Loading history…” until that envelope arrived and Conversation assembled it. Token-level chunks dominate the browser history envelope; the logical event stream and rendered history must stay complete.

## Decision

`SessionsApi` and `SubagentsApi` continue to return expanded `{ events, hasMore, projections? }`. Only the Fetch carrier converts eligible chunk runs to physical `records`, measures the complete uncompressed `server-response` JSON in UTF-8 bytes (envelope, projections, views, and metadata included), and reduces an oversized success page at complete append-origin message-group boundaries. `AbstractApiClient` validates and expands `records` before business state sees the result.

The codec reuses `packChunkRuns()` / `decodeChunkRow()` from `@deepseek-ai/dsh-session/chunk-rows`. A packed row is a physical record, not a `SessionEventMap` member, and never enters `Session.events` or fires `session/event`. Unknown or extended chunk event fields pass through as ordinary events. A malformed packed record fails before runtime state changes.

Cuts use the minimum of each append-origin `user/message` or `assistant/message` sequence and its `sourceEventSeqs`. The encoder always returns at least one indivisible group or an event-only page. When a single group exceeds the target, that group is returned whole with `hasMore: true` so the client can still make progress. `hasMore` is true when the physical encoder omits any logical prefix.

`dsh-client-connection` owns `historyPageTargetBytes` (default 131,072). The value is a target, not a hard rejection limit. Persistence, `SESSION_FORMAT_VERSION`, and Conversation assembly stay unchanged.

### Verification

Focused codec, Fetch-carrier, schema, and Host-plugin tests pin reconstruction, exact-fit / one-byte-under cuts, oversized-group progress, malformed-record rejection, and unknown-event pass-through. The keyless assembled-Web scenario `apps/web/tests/lossless-history-wire.e2e.ts` seeds fewer than 50 append-origin messages, exercises the default 131,072-byte target through the production Host bridge, and records Chat goldens on the conversation-tier page plus after Trajectory `detail: 'full'` fill. Browser Chat no longer expands every historical packed chunk on first open; that download gear is [two-tier conversation history](2026-08-18-conversation-history-tier.md).

## Alternatives considered

**Change the direct API to packed records.** Rejected: every in-process and non-Fetch caller would learn a second history value, and Conversation would stop receiving expanded events.

**Change durable or session formats.** Rejected: the cost is already paid at storage by packed JSONL rows; a format bump would force a migration for a transport-only problem. The [session log version mechanism](2026-08-10-session-log-version-mechanism.md) stays unbumped.

**Cut inside a message or chunk run.** Rejected: Conversation and live increments share one fold that assumes message-grouped pages; a mid-run cut would split `sourceEventSeqs` and in-flight tails.

**Discard token chunks or persist assembled assistant messages only.** Rejected: high-fidelity replay, partial failed streams, and snapshots still depend on persisted chunks ([assembled-assistant-messages-only](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md)).

**Compress only after sending the expanded logical payload.** Rejected: the measured delay is UTF-8 JSON size on the public path; compressing a 6 MB expanded body still serializes and parses that body.

**Treat the byte target as a hard rejection limit.** Rejected: one indivisible group can exceed 131,072 bytes; rejecting it would strand the newest page.

## Consequences

Browser history pages stay near the configured target while the logical event stream, projections, tool views, and Conversation nodes remain identical after expansion. Direct APIs and live frames keep passthrough discipline. Operators can raise or lower the target from connection config without changing persistence. One oversized group still ships whole, so a single tool-heavy or long streaming message can exceed the target. The Host must encode and measure candidate suffixes per history request; that CPU cost is accepted in exchange for the public-path transfer reduction.

Related owners: [packed chunk rows](2026-07-26-packed-chunk-rows-by-default.md), [GUI layering and RPC protocol](2026-07-19-gui-layering-and-rpc-protocol.md), [human-transcript append-origin pagination](../bug-fix/2026-07-29-human-transcript-append-origin.md), [Conversation assembly](2026-08-09-client-conversation-node-assembly.md), [subagent history source](2026-08-06-subagent-list-identity-projection.md), and [two-tier conversation history](2026-08-18-conversation-history-tier.md).
