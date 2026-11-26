# Agent Note: Verified peer backup repository retirement

Status: implemented

English | [中文](2026-11-20-peer-backup-repository-rotation.zh.md)

## Problem

Append-only repositories eventually reach an object, byte or disk limit. A storage report attached to a confirmed capture can become stale precisely when writes fail. An overdue point can still have coverage gaps.

## Decision

The receiver records timestamped storage pressure independently of successful captures. Governance computes the age of the last confirmed point independently of its coverage gaps.

Rotation creates a new policy and encrypted repository for the scope while sealing writes to the original. The original reader and policy revision remain valid for approved recovery. Retirement requires administrator approval of a same-scope, current, complete successor point already rehearsed on a computer other than its source. The chosen point must protect at least as far as the original's newest point. Governance serializes approval against open rehearsals and recoveries and pins the successor repository until retirement finishes.

The receiver alone reclaims the approved repository. It locks the retained policy at the rehearsed revision for each bounded batch. Disabling or revising it pauses reclaim and requires a newly rehearsed point and review. The SQLite tombstone and reclaimed rows commit together before governance records completion. A retry cannot restore removed authority or recreate that namespace. Ordinary Restic credentials have no reclaim method. Deployment restore preserves destination history. Governance rebuilding preserves seal and retirement history, and requires fresh review for unfinished reclaim.

## Alternatives considered

Restic pruning with append credentials would let a compromised source remove its own recovery history. Blindly evicting the oldest point could erase the last complete backup when later captures have gaps. Independent repository rotation reserves space for a known replacement before authorizing any deletion.

## Consequences

Rotation may need a second receiver if the current one lacks overlap space. Reclaim returns space to SQLite without claiming a smaller filesystem allocation. The [backup reference](../../../../gateway/docs/peer-backup/README.md#rotate) owns the operating steps. [Coverage and reauthorization](2026-11-05-project-recovery-reauthorization.md) still owns scope validation and recovery authority. [Source space admission](../bug-fix/2026-11-17-peer-backup-source-space.md) still owns scratch capacity.

## Verification

An isolated PostgreSQL and Restic Gateway assembly rehearses a successor, refuses premature retirement, and pauses reclaim when the retained policy is disabled or revised. It reclaims synthetic ciphertext after a fresh rehearsal and independently reopens the retained point offline after another capture.
