# Agent Note: Preserve source disk space during online backups

Status: implemented

English | [中文](2026-11-17-peer-backup-source-space.zh.md)

## Problem

Ciphertext quotas protect a receiving computer but do not protect source-side SQL exports, snapshot copies or personal validation files. Concurrent backups can each observe the same free capacity, while an unrelated task can consume space after an initial check.

## Decision

The Gateway shares capacity admission across its backup writes and isolated restore writes. Each source operation checks the configured reserve at the actual SQL, file-chunk and manifest writer. Native snapshot acquisition registers the source and snapshot-control volumes for subsequent checks and releases those registrations with the snapshot. Capacity refusal uses a stable error, leaves the last confirmed recovery point unchanged, and unwinds only backup-owned files, workers and snapshots. Fresh ownership witnesses use the same admission owner. Restored points retain it through personal content validation and reconstruction, including offline rehearsals.

SQLite projection and administrator-installed providers have opaque write steps. They require their bounded working capacity before executing, rather than claiming per-byte interception of another process. Native SQLite projection additionally checks each append and copy batch. The [backup reference](../../../../gateway/docs/peer-backup/README.md) owns configuration and deployment limits. [Coverage and reauthorization](../architecture/2026-11-05-project-recovery-reauthorization.md) continues to own plugin gaps and execution authority.

## Alternatives considered

A single check before export cannot detect subsequent consumption or prevent two local backup jobs from using the same allowance. Cancelling user tasks to reclaim disk would change foreground execution for a background backup. A polling timer can miss a large write and does not own its allocation.

## Consequences

Backup writes incur local filesystem capacity reads; failure does not grant permissions, promote incomplete coverage or stop a Runtime. The admission queue covers one serving Gateway and is not an operating-system quota. External writers, native snapshot deltas and a misbehaving administrator-installed provider still require deployment-level storage limits. Deterministic barriers verify concurrent admission; actual file copies verify mid-export refusal and unchanged source bytes. Capacity failures release acquired snapshot views and private capture directories before reporting completion.
