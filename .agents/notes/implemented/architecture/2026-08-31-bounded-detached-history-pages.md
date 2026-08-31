# Agent Note: Bounded detached history pages

Status: implemented

English | [中文](2026-08-31-bounded-detached-history-pages.zh.md)

## Problem

A cold `session.history` request could materialize an entire detached event log before the Host applied its message and wire pagination. A large project conversation therefore consumed database, JSON, heap, and Gateway response budgets before the browser received its first page, and the true capacity failure was surfaced as an opaque internal error.

## Decision

`SessionPersistence` exposes `readHeader`, `readRevision`, and `readPage`. A page has explicit byte, event, and group limits, and its opaque cursor binds the session, source revision, and direction. An append or repair changes the revision and invalidates the cursor. Providers classify bounded-read failures as `too-large`, `aborted`, `timeout`, `dependency`, or `protocol`.

The PostgreSQL conversation repository implements `readHeader` and `readPage` with a read-only repeatable-read transaction and the `(session_id, seq)` keyset index. Queries cast bigint sequence values to text only in result columns and qualify the underlying bigint in `ORDER BY`, preserving numeric keyset order. The Gateway runtime exposes metadata and page endpoints, authenticates before buffering internal request bodies, applies response budgets, and preserves typed page failures. A compatibility repository without an indexed page method keeps the existing complete-read path.

The Host uses an indexed page for cold session and subagent history, follows revision-bound older cursors only until the requested message window is covered, keeps the normal detached window below 4 MiB, and fails closed after a 512 MiB aggregate or 1,024-page guard. It validates continuation metadata, byte accounting, and adjacent sequence ranges before presenting a page. The public RPC envelope remains `{ events, hasMore, projections?, omittedSpans? }`; cursor details stay inside the persistence and Gateway layers. Detached projection baselines use an identity-checked projection cache when available, while compatibility inspections may fold their complete event range. Request cancellation reaches page reads and response-body decoding and is mapped to the existing `cancelled` RPC result; other typed failures receive safe category-specific messages and retain diagnostics in the Host log.

When a preset roster is composed, an indexed cold read also walks only the forward blank prefix to recover logged `agent-preset/selected` facts, stopping at the first visible conversation event or a small prefix budget. This preserves presenter selection without reopening the complete event log; an unavailable prefix degrades to the header/global presenter.

The browser runtime limits reconnect history rebuilds to four concurrent sessions and schedules the visible session first. An idle staged reader requests one older page when it nears the head, while the visible control remains an accessible retry for a failed or bounded automatic read. Session scope disposal aborts an outstanding open or history operation and unregisters its subscriptions. The HTTP carrier uses the same request-body budget in its outer Node bridge and inner Fetch parser, and its response reader can stop on the caller signal. Gateway production releases now compile the Gateway source graph to `gateway/lib/index.js`; systemd and launchd execute that artifact with plain Node, while the `tsx` entry remains a development path.

Composer scope disposal now also cancels in-flight attachment encoding, and command-image serialization receives the submission attempt signal so abandoned large payloads do not continue base64 work.

Abort-aware waiters recheck signals after listener registration, cancel response readers and shared attachment/file work on the last abandoned waiter, and release their listeners on every settlement. Session and manager disposal also invalidates queued history fills before they can start.

Indexed header reads also serve ownership and cwd checks before a cold resume performs the full inspection needed to rebuild the recorded composition. Production packaging now creates the release-local Gateway package link required by compiled ESM imports, and the macOS controller retains a legacy source fallback solely for rollback.

Future bootstrap passwords are delivered through an owner-only one-time file and are never interpolated into Gateway logs. Existing deployments retain their credentials until an operator rotates them.

## Alternatives considered

**Keep full inspection and rely on Fetch chunk packing.** Rejected because packing reduces wire bytes after the Host has already loaded and serialized the complete log; it does not bound database reads or Host memory.

**Expose persistence cursors in the public browser history contract.** Rejected because the existing `beforeSeq` and `maxMessages` envelope is sufficient for browser pagination, while backend cursor formats and revision identities remain provider-owned.

**Drop historical assistant chunks from durable storage.** Rejected because Trajectory, interruption recovery, replay, and model history still require the lossless event log. The existing conversation-history tier remains a transport projection only.

## Consequences

Cold Gateway history now reads a bounded indexed range instead of crossing the 64 MiB runtime response ceiling for ordinary large sessions. A single event larger than the page budget fails closed with a stable safe message, and a changed source invalidates a continuation rather than mixing revisions. The Gateway-backed write-behind default is 48 MiB, reserving envelope headroom below the 64 MiB request limit. Providers that cannot seek still have a compatibility fallback, so deployments using sequential storage retain their previous read cost until they add an indexed implementation.

PostgreSQL query cancellation through the wire-level cancel protocol, segment compression tables, batched `COPY` appends, full observability dashboards, migration rehearsal, WebSocket principal renewal, Chat list virtualization, persistence-failure admission fencing, credential rotation, and production canary/rollback execution remain deployment work; this change does not alter production data or run migrations. The public RPC error schema still uses `internal` for typed history failures other than cancellation, so adding dedicated localized error codes remains a separate coordinated protocol change.

## Verification

Focused Host tests prove a large detached history uses `readPage` without calling `inspect`; persistence tests cover cursor direction/session/revision binding, byte/event/group limits, oversized indivisible events, and cancellation; Gateway tests cover indexed keyset pages, cursor invalidation, runtime page responses, early body authentication, and supervisor survivor re-attachment. Client tests cover incremental assistant accumulation, reconnect resync admission, scope disposal, response-body cancellation, and listener cleanup. `pnpm run typecheck`, Gateway artifact/typecheck, export-JSDoc, contract lint, and the affected Vitest suites pass on the source tree.
