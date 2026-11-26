# Agent Note: Preserve both published PostgreSQL migration histories

Status: implemented

English | [中文](2026-11-22-postgres-push-migration-lineage.zh.md)

## Problem

The push-only and combined releases share versions 1–129. The push-only ledger uses 130–131 for SQL shipped as 144–145 by the combined release. Both installations have durable checksums and may hold device registrations and receipts.

## Decision

Recognize only the shared checksummed prefix followed by one or both exact push entries. The coordinated applier holds the maintenance row while it retains each entry's checksum and application time under the combined version. The relabeling and the missing SQL through 145 commit together. Later migrations retain their own transactions.

## Alternatives considered

Keeping both sets of files at 130–131 makes the migration sequence ambiguous. Replaying push SQL or weakening checksum verification would risk existing registrations and remove the evidence needed for restore and rollback.

## Consequences

An activation or rollback check requires an applicable ledger and reads it without changing it. Operators use the [push ledger upgrade](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/push-migration-lineage/guide.md). The PostgreSQL preflight fixture covers both push prefixes, a busy deployment, checksum drift, a failed transaction and preservation of device registrations.
