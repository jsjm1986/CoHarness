# Agent Note: Index projection restore tails without copying

Status: implemented

English | [中文](2026-08-30-index-projection-restore-tail.zh.md)

## Problem

Cold projection restore receives a contiguous event suffix and a checkpoint watermark. Building a second array for the events after that watermark adds an allocation and a full scan on every unit, even though the suffix index already identifies the first event to fold.

## Decision

`SessionProjectionRegistry.restore` derives `startIndex = checkpointSeq - baseSeq + 1` and iterates the supplied suffix in place. The checkpoint validity checks remain unchanged, so a missing, stale, or out-of-range row still triggers the same full-read fallback; only the transient tail copy is removed.

## Alternatives considered

**Keep slicing the suffix for readability.** Rejected because large cold sessions pay an avoidable allocation per projection unit.

**Trust event sequence values and skip with a conditional scan.** Rejected because the persistence contract already guarantees a contiguous suffix, so the index is cheaper and makes the required input assumption explicit.

**Change checkpoint validity or restore semantics together with the optimization.** Rejected because physical recovery behavior must remain independently reviewable and byte-compatible.

## Consequences

Cold restores retain the same state and error behavior while reducing temporary arrays and repeated comparisons. Callers must continue to provide the contiguous suffix beginning at `baseSeq`, as required by the restore contract.

## Testing

Existing projection restore and SQLite/cache round-trip suites cover empty, checkpointed, stale, and full-read paths; the optimization is a traversal-only change over those cases.
