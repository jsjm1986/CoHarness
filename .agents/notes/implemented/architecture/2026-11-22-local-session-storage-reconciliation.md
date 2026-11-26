# Agent Note: Reuse verified local Session observations

Status: implemented

English | [中文](2026-11-22-local-session-storage-reconciliation.zh.md)

## Problem

Repeated searches over an unchanged active Session copy and hash its entire log. Refreshing the persistent index also serializes backend reads that can be independent. SQLite append validation spends time materializing schema objects in JavaScript, and routine projection writes allocate a second copy of a detached checkpoint. A checkpoint timer can retain the Agent identity of the first event that armed it even after the Agent's operation has ended.

## Decision

The [SQLite persistence provider](../../../../packages/session/session-persistence-sqlite/README.md#schema-compatibility) compares the database's actual ordered schema with a canonical representation inside each mutation transaction. Whitespace-equivalent definitions remain acceptable.

The [SQLite search provider](../../../../packages/session-query/session-query-sqlite/README.md#source-and-index-lifecycle) reuses the exact fingerprint only for the same append-only Session instance at the same event count. The header and accepted events remain immutable. Durable content is keyed by source revision. A limit bounds simultaneous durable inspections, and the search queue remains occupied until all started inspections settle. Index publication requires a stable source observation.

The [projection cache](../../../../packages/session/session-projection-cache/README.md#write-policy) validates the detached live checkpoint and waits for its Session log flush before publication. A cold checkpoint gets a separate snapshot when its values can be shared with the caller. The timer carries its explicit Session and clears the initiating Agent through the Agent registry when available.

## Alternatives considered

**Trust the SQLite schema cookie alone.** Schema versions and cookies would leave the write guard dependent on metadata assertions about the catalog. Reading the catalog inside the write transaction checks the DDL that the mutation depends on.

**Cache live search documents or use their event count as the cursor generation.** Document retention duplicates log content, and a replacement Session can have the same id and length as its predecessor. The existing content digest continues to establish exact equality for a newly observed Session object.

**Release a search when the first inspection fails.** A backend read can ignore cancellation. Waiting for its original promise keeps disposal, a source replacement, and the next search ordered with started I/O.

**Reuse cold projection rows directly.** Their sharing with the returned snapshot would allow caller-side mutation while a write is queued.

## Consequences

Repeated searches avoid copying and hashing unchanged active history. An append or replacement Session still takes a full fingerprint. A durable catch-up may use multiple read handles at once within the configured limit.

The write guard still reads the actual schema and keeps the existing SQLite format. Live projection writes avoid allocating one copy of checkpoint data. File I/O and the Session flush remain part of checkpoint latency.
