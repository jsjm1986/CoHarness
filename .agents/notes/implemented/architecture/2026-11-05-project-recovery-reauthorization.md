# Agent Note: Scoped backup coverage and recovery reauthorization

Status: implemented

English | [中文](2026-11-05-project-recovery-reauthorization.zh.md)

## Problem

A recovery point does not prove that every storage domain was captured. Runtime files, account documents, plugin state and scheduled deliveries can advance independently. A stopped source also cannot safely resume writing when a later policy change invalidates its recovery approval.

## Decision

Each exporter identifies its covered domains and keeps explicit gaps. Personal PostgreSQL records are limited to the selected organization, computer, account and Runtime; account documents retain their shared account-and-computer identity. Consistent native file snapshots include only approved roots. Unknown plugin state, independent watermarks and missing file snapshots prevent complete protection. Governance inventory version 2 retains opaque project coordinates; version 1 remains readable as a partial inventory. Neither version restores login, node credentials or writer authority.

Project recovery rechecks the active administrator, project owner, target computer grant, node admission and current policy before irreversible commits. Policy continuation records a separate immutable approval for the same point, destination and inspected policy revision. A current-revision independent drill is required. Source retirement receipts remain immutable. Ordinary quota and recovery-objective edits cannot change an unfinished recovery.

The target records exclusive directory ownership before installing staged data. Parent and inode witnesses permit retries to reuse only that operation’s installed roots. Cancellation withdraws its candidate and records cleanup before another attempt can use the destination. Nonempty withdrawn directories remain outside the active layout for operator inspection. A local OS-backed project lock serializes workers without retaining a governance database connection while they borrow another connection.

The target activates only the published higher writer epoch after verifying its files and delivery receipts. The same governance transaction records activation and pauses the former source’s policy. Protecting the new source requires a separate policy, receiver and credentials. Unavailable sources and expired leases provide no stopped-writer proof. [Maintenance restore](2026-09-25-gateway-deployment-maintenance.md) independently preserves present-day approvals and fences.

## Alternatives considered

**Call copied directories complete backups.** Mutable files do not establish a shared checkpoint with databases or external plugin effects. Missing evidence remains a coverage gap.

**Restore the old policy revision or reopen the source.** This could revive withdrawn credentials or create two writers. A new immutable approval authorizes continuation without reversing retirement.

**Delete any occupied staging path before retrying.** A path can contain another operation’s or an operator’s data. Cleanup requires the recorded physical ownership witness.

## Consequences

Personal and governance scopes support isolated recovery without claiming the project promotion procedure. A missing Mac snapshot service or unverified volume remains a deployment gap. Live tasks are not stopped to obtain a daily backup. Runtime identity and project membership survive replacement; members still require target computer access.

## Verification

Disposable PostgreSQL instances exercise owner revocation, policy rotation, stale confirmations, current-revision drills, maintenance restore protection and activation. Normal Admin HTTP requests drive both workers with governance pools of one connection. Filesystem tests interrupt distinct staging phases, retain foreign files and verify cancellation retry. Separate processes exercise worker lock release after process death. Native Mac-to-Windows encrypted recovery verifies bytes, Session order and delivery receipts after the source and transport are removed; it does not establish full production coverage or a complete promotion time.
