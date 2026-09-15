# Agent Note: Unreadable session artifacts are isolated from enumeration

Status: implemented

English | [中文](2026-09-15-unreadable-artifact-enumeration-isolation.zh.md)

## Problem

A single damaged session artifact must not fail every other session's listing, yet the enumeration paths failed closed per item: `listSnapshots` read each draft's full body without tolerance, `listArtifacts` let an undecodable header frame abort the whole scan, and `archiveSyncBatches` let one unreadable archived session reject the entire sync payload. On a store holding one torn draft, `session.list` returned HTTP 500, the workbench catalog stayed empty, and no session could be opened.

`syncRuntimeSnapshot` had the same defect one layer up: `assertRuntimeSessionOwnership` rejected any reported id lacking a `conversation_sessions` row, so a runtime whose sessions live only in local storage could never sync. The archive channel contract explicitly expects records whose personal transcript is absent from PostgreSQL, so absence is a normal state, not evidence of foreign ownership.

## Decision

Enumeration isolates the unreadable item and reports it through `ctx.logger.warn`; identity, encoding-mismatch, and duplicate-id violations still throw, and a targeted read of the artifact keeps reporting the real error. An unreadable draft is omitted because drafts earn a row only by proving content; a durable session keeps its header row and fails on open instead.

The archive sync applies the same rule: an archived session whose log cannot be read contributes its bare id — the stored record persists — instead of failing the payload. `assertRuntimeSessionOwnership` enforces the caller's scope only over existing `conversation_sessions` rows and validates lineage roots only where a stored root exists.

## Alternatives considered

**Fail closed on every anomaly.** Rejected: per-item faults amplified into a surface-wide outage, and durable sessions lost their listings over damage they did not cause.

**Per-item tolerance in each consumer.** Rejected: the rule belongs in the enumeration operation itself; facades and callers cannot reliably reconstruct which item failed or why.

## Consequences

A torn or truncated artifact degrades to a warning plus omission instead of a 500, and the same holds for archive projections. A session id that exists under a different owner or scope, or a lineage root that contradicts stored rows, still rejects the snapshot. The corrupted artifact remains on disk for inspection; recovery is a separate explicit operation.

## Verification

`session-persistence-jsonl` specs cover a corrupt draft body, a short or malformed header frame, and an oversized header each leaving the rest of the list intact. `archive-gateway` covers an unreadable archived session contributing a bare id beside healthy payloads. `conversation-archive-service` covers a foreign-owned stored session rejecting the snapshot and a runtime-local id syncing without a stored row.
