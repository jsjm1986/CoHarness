# Agent Note: Gateway deployment maintenance control plane

Status: implemented

English | [中文](2026-09-25-gateway-deployment-maintenance.zh.md)

## Problem

A shared-PostgreSQL deployment needs upgrades and restores that every Gateway node honors together. Startup migration applies schema changes but cannot stop writers, coordinate a backup, or prevent a process started before a restore from writing over it. The `deploy/postgres` shell scripts produce dumps without coordinating the serving cluster, so a concurrent writer can leave database and managed files inconsistent at the switch point.

## Decision

[Migration 041](../../../../gateway/deploy/postgres/migrations/041_maintenance_control.sql) adds a durable control plane per organization. `harness.cluster_control` holds the mode (`serving`/`maintenance`/`restoring`), the maintenance epoch, the monotonic write epoch, and the window reason. `harness.deployment_operations` is the operation ledger; `harness.backup_records` registers each dump with its managed-file manifest, verification state, and the write epoch it was taken under. `compute_nodes.maintenance_applied_epoch` records the epoch each node's write gate has observed.

The [maintenance service](../../../../gateway/src/postgres/maintenance-service.ts) drives transitions. Entering maintenance bumps the epoch every writer must acknowledge; the HTTP write gate in [server.ts](../../../../gateway/src/server.ts) answers mutating requests with 503 while the mode is not `serving`, and `stale-epoch` once the write epoch advances past a process's startup baseline. Writer quiescence requires every active or draining node to have a fresh heartbeat at the current epoch; a node that never heartbeated cannot be writing, and a stale heartbeat keeps it unquiesced until an operator declares it `offline`. A node that resumes heartbeating returns to `active` because an offline declaration was premature.

The standalone applier `pnpm pg:deploy` ([scripts/deploy-apply.ts](../../../../gateway/scripts/deploy-apply.ts)) runs the sanctioned sequence outside the serving process: status, maintenance enter/exit, migration apply under quiesce, backup (dump plus managed-file snapshot, verified and registered), restore, and rolling-restart planning. Administrators drive the same service through `/admin/api/deployment*` and the Admin Deployment page; pending admin restore requests are claimed by the applier rather than applied inline. Managed files travel as a manifest of path, size, and sha256; every digest is validated before any file is copied, and each file lands via same-directory rename.

A `pg_restore --clean` restore rewinds `cluster_control` itself, erasing the open `restoring` window. The applier calls `resumeRestoring` after the dump applies, and `completeRestore` advances the write epoch with `GREATEST(write_epoch + 1, now)` so the fence stays monotonic no matter what the dump rewound the row to.

## Alternatives considered

**Exclude the control-plane tables from dumps and restores.** `pg_restore` has no `--exclude-table`, and `--clean` drops constraints in dump order: live control tables left out of the dump keep foreign keys that block the restore's `DROP CONSTRAINT organizations_pkey`. Keeping the tables inside the dump and re-asserting the window afterward works for both new and pre-rule dumps.

**Let each writer poll maintenance and stop itself.** A sleeping or partitioned node then keeps writing past the window. The gate must reject writes at the server, and epoch acknowledgment makes a stale node's silence visible instead of assumed drained.

**Restore managed files best-effort alongside the dump.** A digest failure halfway through copying leaves the deployment half-restored. Validating the entire manifest before the first copy keeps the restore all-or-nothing per file set.

## Consequences

The write gate adds one control-row read per mutating request; reads and deployment-control routes stay open during maintenance. A restore parks the cluster in maintenance for operator verification rather than reopening automatically. Backups register only after the dump verifies, so a failed dump never produces a restorable record. The ledger rewinds with the database on restore; the fresh `restore` operation row still records that the switch happened. PostgreSQL tests cover window transitions, heartbeat recovery, pending-claim ordering, backup registration, and control-row rewind; the HTTP suite covers the write gate and admin routes.
