# Agent Note: Deferred session drafts and authoritative content watermarks

Status: implemented

English | [中文](2026-08-26-session-draft-lifecycle-and-content-watermarks.zh.md)

## Problem

Creating a browser session before the first prompt writes policy, turn, and rejected-input events for a conversation that may never contain visible content. Separate tabs can also mint different identities for the same unsent draft, while cold lists have no cheap authoritative way to distinguish a blank durable log from a stale projection hint.

## Decision

`SessionHeader.draft` marks a browser-created root whose physical persistence is deferred. `PersistenceCoordinator` buffers non-materializing events in memory and atomically writes the buffered prefix with the first non-empty surface message. Command, goal, and plan state events materialize a hidden command-only record; disposing an unmaterialized draft drops the buffer. A visible message promotes the stored header out of draft status. The shared `hasConversationContent` predicate is the only blankness rule used by attached summaries, projections, and persistence metadata.

Gateway runtimes reserve a scope-qualified `(draftId, sessionId)` pair before Agent creation. PostgreSQL returns one canonical Session id for retries, renews a one-hour lease, and releases it after materialization or successful disposal. The reservation contains no prompt text, attachment bytes, or credentials. Local JSONL and SQLite providers use the same deferred coordinator and persist the promoted draft marker; SQLite rejects older schemas under the pre-release no-migration policy.

Gateway session rows maintain `has_visible_content`, `visible_content_seq`, and `last_prompt_at` in the same transaction as event appends. `listSnapshots()` exposes these facts to cold consumers, which do not parse a large log merely to decide whether a row is blank. Existing blank roots are eligible for an administrator-only dry-run and recoverable empty-draft trash flow with the existing retention window.

## Alternatives considered

**Persist every new Session and hide it in the Client.** Rejected because the database, archive index, and workspace membership would still accumulate abandoned roots and competing tabs would remain independent.

**Use the first accepted prompt or `running` state as materialization.** Rejected because pre-step policy can reject or rewrite an input into an empty turn; a non-empty durable surface event is the shared evidence available to every consumer.

**Use projection-cache blank hints as the cold authority.** Rejected because checkpoints can lag or be absent. Gateway-maintained watermarks are updated with the append transaction; local providers retain a bounded probe fallback.

**Delete old blank rows during the first cleanup scan.** Rejected because an operator needs a reviewable dry-run and a reversible recovery window. Empty drafts use the archive lifecycle with a maintenance-only record kind.

## Consequences

Abandoned browser drafts leave no durable session artifact, and one draft identity can survive a reload without storing credentials. Command-only state remains recoverable but does not enter ordinary conversation lists. A real message makes the session visible without a second attach or identity migration. Cold listing cost is proportional to session metadata rather than log bytes when the Gateway index is available.

The `SessionHeader` and SQLite metadata formats change while the repository is pre-release; older SQLite stores are refused rather than migrated. Local JSONL cannot update an already-written header, so promotion happens at first materialization and pre-existing artifacts retain the conservative probe behavior. Empty-draft maintenance is administrator-only and keeps rows in trash until the configured purge window expires.

## Verification

Focused tests cover the shared classifier, seed-only draft buffering, first-message atomic materialization, command-only hiding, stale list reconciliation, Workspace draft reuse, SQLite schema ownership, and Gateway content metadata parsing. Gateway and admin maintenance paths validate scope ownership, lease expiry, dry-run selection, trash, restore, and purge without exposing prompt data.

## Related

- [Session list hides empty turns and resists stale archive snapshots](../bug-fix/2026-08-25-session-list-empty-content-and-archive-ordering.md) — owns the shared visible-content predicate and Client list reconciliation.
- [Record last activity in the session index](../../proposed/architecture/2026-07-29-durable-last-activity-index.md) — remains partly proposed for JSONL ordering; Gateway watermarks implement its authoritative-index portion.
