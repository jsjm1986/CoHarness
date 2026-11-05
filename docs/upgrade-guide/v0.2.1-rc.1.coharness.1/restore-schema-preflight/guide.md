---
kind: upgrade-guide
description: Coordinated restores reject different migration versions, names or checksums before opening the restoring window.
---
# Restore schema eligibility

English | [中文](guide.zh.md)

## Change

A verified backup from another schema could enter `restoring` before SQL replacement failed. Restore registration now returns409 `backup-schema-version-mismatch` when the recorded migration version differs from the destination. Before creating a protection backup or entering `restoring`, the independent applier also compares the actual archive's migration versions, names and SHA-256 checksums with the destination. This applies to registered backups and direct `--dump` inputs. A difference fails with `backup-schema-differs-from-destination` and retains maintenance mode.

The configured restore client must render the migration table as canonical text `COPY` data. Missing, incomplete or unsupported metadata, including an INSERT-formatted migration export, fails with `backup-schema-metadata-unreadable`. No archive SQL executes during inspection. Matching metadata does not waive the existing ownership and managed-file checks.

## Migration

1. Select a verified complete backup with the destination's exact migration set. The Admin restore request checks its recorded version; the applier checks the actual dump before proceeding.
2. Keep older-schema archives for isolated recovery. Do not edit migration records to make an incompatible archive appear eligible. See the [maintenance decision](../../../../.agents/notes/implemented/architecture/2026-09-25-gateway-deployment-maintenance.md).
3. Use the normal custom-format backup output from Gateway maintenance. Custom `HGW_PGRESTORE_COMMAND` wrappers must support offline data-only output for `harness.schema_migrations` through stdout.
4. Confirm that an incompatible attempt leaves the deployment in maintenance without a new protection backup. An already open `restoring` window keeps its recorded target and protection copy; this check does not clear it or authorize a different target.
