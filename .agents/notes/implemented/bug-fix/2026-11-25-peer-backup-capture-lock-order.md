# Agent Note: Lock peer-backup policies before scheduled capture rows

Status: implemented

English | [中文](2026-11-25-peer-backup-capture-lock-order.zh.md)

## Problem

Manual capture admission and the scheduled capture claimant both insert `harness.peer_backup_work` for the same policy. Manual admission first locks the policy row `FOR UPDATE`, checks for pending work, and then inserts the child row. The scheduler previously inserted the child before PostgreSQL's foreign-key trigger revisited the parent policy. When the two operations overlapped, the manual transaction held the parent lock and waited on the scheduler's uncommitted child in the partial unique index, while the scheduler's foreign-key trigger waited on the manual transaction's parent lock. PostgreSQL correctly reported a deadlock; the administrator-facing capture request surfaced as a transient 503.

## Decision

The scheduled claimant now locks due `peer_backup_policies` rows in stable policy-id order with `FOR UPDATE` as part of the `INSERT ... SELECT` that creates due capture work. Both manual and scheduled admission therefore acquire the parent policy before inserting child work. `ON CONFLICT DO NOTHING` remains the idempotence mechanism for a capture already queued or running after that serialization.

## Alternatives considered

- **Handle only the unique violation in manual enqueue** — conflict handling is still useful idempotence, but it does not remove the parent/child lock inversion that PostgreSQL can only resolve by killing one transaction.
- **Serialize capture creation with an advisory lock** — the policy row already represents the exact resource and is locked by administrator mutation; a second lock namespace would add ordering rules without protecting ordinary policy updates.
- **Remove the partial unique index and deduplicate later** — duplicates would reach independent restic work before cleanup, weakening the invariant that one policy has at most one pending capture.

## Consequences

A manual capture submitted while the scheduler creates due work either returns the existing operation or wins the parent lock first; neither path deadlocks. Scheduler admission briefly holds parent policy rows, so edits and manual capture requests serialize with it. The test barrier uses PostgreSQL advisory locks only to place the overlap deterministically; production locking remains row-local.

## Verification

`gateway/tests/peer-backup-postgres.spec.ts` places manual admission after its parent lock and before its child insert with an advisory-lock barrier, starts the scheduler claimant, proves both sides overlap in lock waits, and then releases the barrier. The test deadlocked before the fix and passes after it. The same file's real restic rotate flow passes locally.
