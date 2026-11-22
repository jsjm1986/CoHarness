# Agent Note: Deferred session drafts and authoritative content watermarks

Status: implemented

English | [中文](2026-08-26-session-draft-lifecycle-and-content-watermarks.zh.md)

## Problem

Creating a browser session before the first prompt writes policy, turn, and rejected-input events for a conversation that may never contain visible content. Separate tabs can also mint different identities for the same unsent draft, while cold lists have no cheap authoritative way to distinguish a blank durable log from a stale projection hint.

## Decision

`SessionHeader.draft` marks a browser-created root eligible for deferred persistence. `PersistenceCoordinator` buffers events in memory and atomically writes the prefix when a non-empty surface message, a receipt-bearing inbox insertion, or command, goal, or plan state first requires storage. The Host can confirm durable input while it is still queued. Disposing an unmaterialized draft drops the buffer. The shared `hasConversationContent` predicate governs blankness in attached summaries, projections, and persistence metadata.

Gateway runtimes reserve a scope-qualified `(draftId, sessionId)` pair before Agent creation. PostgreSQL returns one canonical Session id for retries, renews a one-hour lease, and releases it after materialization or successful disposal. The reservation contains no prompt text, attachment bytes, or credentials. Local JSONL and SQLite providers use the same deferred coordinator and persist the promoted draft marker; SQLite rejects older schemas under the pre-release no-migration policy. First reservation attempts acquire a transaction-scoped lock keyed by organization, Runtime, scope and draft id before reading the lease row. Overlapping callers reuse the winning Session id even when their proposed ids differ and no Session has materialized.

Gateway session rows maintain `has_visible_content`, `visible_content_seq`, and `last_prompt_at` in the same transaction as event appends. `listSnapshots()` exposes these facts to cold consumers, which do not parse a large log merely to decide whether a row is blank. Migration backfill classifies legacy event JSON containing escaped NUL conservatively without applying PostgreSQL JSON operators to that value. Existing blank roots are eligible for an administrator-only dry-run and recoverable empty-draft trash flow with the existing retention window.

JSONL preserves the optional boolean `draft` through both its physical-header reader and its format-catalog metadata adapter. A cold read receives the same lifecycle marker the writer accepted; dropping it is not a substitute for evaluating visible content. The [V5 successor](../bug-fix/2026-09-22-v5-draft-header-successor.md) acknowledges the physical-header correction and leaves committed generation bytes unchanged. Unknown header keys and non-boolean draft values remain invalid.

Runtime ownership and maintenance selection follow the [Session identity decision](2026-10-30-postgres-session-runtime-namespace.md).

## Alternatives considered

**Persist every new Session and hide it in the Client.** Rejected because the database, archive index, and workspace membership would still accumulate abandoned roots and competing tabs would remain independent.

**Count an accepted prompt or `running` state as visible content.** Pre-step policy can reject an input or rewrite it into an empty turn. A non-empty durable surface message is the shared evidence for visibility.

**Use projection-cache blank hints as the cold authority.** Rejected because checkpoints can lag or be absent. Gateway-maintained watermarks are updated with the append transaction; local providers retain a bounded probe fallback.

**Delete old blank rows during the first cleanup scan.** Rejected because an operator needs a reviewable dry-run and a reversible recovery window. Empty drafts use the archive lifecycle with a maintenance-only record kind.

## Consequences

Abandoned, unmaterialized browser drafts leave no durable session artifact. One draft identity can survive a reload without storing credentials. A Session holding only command state or a queued input remains recoverable and stays out of ordinary conversation lists. A visible message promotes the same Session identity. With the Gateway index, cold listing reads session metadata.

The `SessionHeader` and SQLite metadata formats change while the repository is pre-release; older SQLite stores are refused rather than migrated. Local JSONL keeps its original physical header. If a visible message arrives after first materialization, readers derive visibility from the committed body. Empty-draft maintenance is administrator-only and keeps rows in trash until the configured purge window expires.

## Verification

Focused tests cover the shared classifier, seed-only draft buffering, atomic receipt and first-message materialization, command-only hiding, stale list reconciliation, Workspace draft reuse, SQLite schema ownership, Gateway content metadata parsing, and migration backfill for legacy escaped-NUL events. The keyless project transcript verifies reading the committed receipt before visible content and replaying the append without another insertion. Gateway and admin maintenance paths validate scope ownership, lease expiry, dry-run selection, trash, restore, and purge without exposing prompt data.

## Related

- [Session list hides empty turns and resists stale archive snapshots](../bug-fix/2026-08-25-session-list-empty-content-and-archive-ordering.md) — owns the shared visible-content predicate and Client list reconciliation.
- [Record last activity in the session index](../../proposed/architecture/2026-07-29-durable-last-activity-index.md) — remains partly proposed for JSONL ordering; Gateway watermarks implement its authoritative-index portion.
