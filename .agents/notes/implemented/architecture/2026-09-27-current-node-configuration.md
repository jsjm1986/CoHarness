# Agent Note: Current-node configuration with independent application

Status: implemented

English | [中文](2026-09-27-current-node-configuration.zh.md)

## Problem

A Web server cannot own the complete operation that changes its own listener or database configuration: applying those values may terminate the request carrying the result. Configuration edits also compete with backup and restore, and a restored queued operation must not silently execute against another data generation.

## Decision

The node owns one private, versioned configuration file. Administrator mutations bind organization, node and expected revision. Desired values, applied values and the running process's effective values remain distinct. Editable fields are a declared set; executable commands, credentials contents, identity and confinement do not enter it. Ordinary saves never restart a service.

An independently supervised applier consumes an explicit request under the shared database deployment lease and a local configuration lock. The request pins the database write epoch. Node configuration mutations use the same lease as backup and restore, including first-file initialization; an existing file's startup identity check is read-only. Immutable macOS releases also share the release controller's activation lock.

Preflight requires maintenance, stopped runtime writers, compatible database identity and prepared data paths. Publication retains previous values before restarting the fixed host-owned service action. Health must identify the applied revision and release. Lost lease ownership stops publication instead of starting another rollback; a fresh owner resolves the durable applying record. Local recovery still checks data compatibility. Backup restoration preserves current control files and refuses incompatible stored-data locations before writing the database.

## Alternatives considered

**Restart inside the serving request.** Its process lifetime cannot cover its own termination and verification. A separate supervised worker retains operation ownership while the Gateway restarts.

**Expose environment text or an arbitrary restart command.** That grants file and command authority beyond the declared settings and makes validation unreliable. The Web API accepts typed, non-secret settings; host bootstrap configuration owns service commands.

**Restore every file from an old backup verbatim.** Queued applies and connection settings can redirect the node or replay obsolete work. Immutable backups retain those values for inspection; current control files stay authoritative, and write epochs invalidate old requests.

## Consequences

macOS launchd and Linux systemd require a separately installed configuration service. External TLS and routing remain operator responsibilities. Prepared path changes are verified rather than inferred from folder names, and key relocation does not perform key rotation. Orphaned writer locks need explicit owner verification and local recovery. Maintenance does not close merely because a service restart succeeded.

The [maintenance decision](2026-09-25-gateway-deployment-maintenance.md) continues to own database and file restoration. The [node configuration reference](../../../../gateway/deploy/node-configuration/README.md) owns operations, settings and installation.
