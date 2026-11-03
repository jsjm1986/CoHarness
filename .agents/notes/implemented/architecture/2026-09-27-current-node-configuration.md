# Agent Note: Current-node configuration with independent application

Status: implemented

English | [中文](2026-09-27-current-node-configuration.zh.md)

## Problem

A Web server cannot own the complete operation that changes its own listener or database configuration: applying those values may terminate the request carrying the result. Configuration edits also compete with backup and restore, and a restored queued operation must not silently execute against another data generation.

## Decision

The node owns one private, versioned configuration file. Administrator mutations bind organization, node and expected revision. Desired values, applied values and the running process's effective values remain distinct. Editable fields are a declared set; executable commands, credentials contents, identity and confinement do not enter it. Ordinary saves never restart a service.

Web reads, saves and apply registration retain the active organization and current active administrator account and membership inside their database transaction. The Gateway supplies the authenticated actor; browser actor fields grant no authority. Save and apply return the view captured under the configuration writer lock, so a successor cannot replace the accepted revision in the response. Bootstrap initialization explicitly has no account actor. A registered apply is an accepted instruction consumed under the independent worker's existing epoch, maintenance and data checks.

An independently supervised applier consumes an explicit request under the shared database deployment lease and a local configuration lock. The request pins the database write epoch. Node configuration mutations use the same lease as backup and restore, including first-file initialization; an existing file's startup identity check is read-only. Immutable macOS releases also share the release controller's activation lock.

Preflight requires maintenance, stopped runtime writers, compatible database identity and prepared data paths. Publication retains previous values before restarting the fixed host-owned service action. Health must identify the applied revision and release. Lost lease ownership stops publication instead of starting another rollback; a fresh owner resolves the durable applying record. Local recovery still checks data compatibility. Backup restoration preserves current control files and refuses incompatible stored-data locations before writing the database.

Once a Gateway heartbeat observes a closed maintenance gate, pressure sampling pauses before capturing another observation. Existing publications remain counted and joined; repeated read-only gate checks cannot keep the writer ledger occupied while the configuration applier waits for quiescence. Reopening the gate resumes sampling and fresh admission credits.

Each node projects its Runtime request and cleanup deadlines into the resource-accounting plugin's existing configuration. Defaults remain 5000 and 30000 milliseconds; cleanup must exceed a request. Slower database round trips require an explicit node setting and do not change resource permission, admission or uncertain-cleanup ownership.

The same node configuration projects the existing browser connection plugin’s readiness and stream-opening deadlines into every managed Runtime. Defaults remain 15000 and 3000 milliseconds; a slower computer uses explicit overrides without changing other computers or asking users to modify a protected core plugin.

Its bounded browser RPC deadline remains 30000 milliseconds by default and can be increased independently of the readiness guard. The served page and its pooled target connections inherit that RPC value; configuring only generation readiness cannot extend a query cancelled by the browser carrier.

Health requests name the expected computer through the node-target protocol and require the same identity in the response. A matching revision or release on another Gateway cannot acknowledge an apply. Readiness uses a process-monotonic deadline, limits each in-flight response to its remaining time and bounds actual response bytes. Native restart clients exclude Gateway credentials, use the configured command deadline and retain their lease-cancellation subscription until physical closure; closing a client does not prove that the service job itself stopped.

Configuration writes retain their administrator through the deployment lease's existing backend transaction. Write-epoch capture uses that same backend and needs no second pool checkout. A lost backend aborts the lease signal before file publication. Private-file reads open without waiting on a FIFO, reject nonregular entries and bound actual bytes even if the file grows after stat. Temporary cleanup requires successful exclusive acquisition and ends when rename publishes the file; foreign occupants survive both failed acquisition and reuse of the old staging pathname. Descriptor disposal retains independent read/write and close failures. The [atomic acquisition decision](../bug-fix/2026-10-26-atomic-file-acquisition.md) owns those cleanup rules.

## Alternatives considered

**Restart inside the serving request.** Its process lifetime cannot cover its own termination and verification. A separate supervised worker retains operation ownership while the Gateway restarts.

**Expose environment text or an arbitrary restart command.** That grants file and command authority beyond the declared settings and makes validation unreliable. The Web API accepts typed, non-secret settings; host bootstrap configuration owns service commands.

**Restore every file from an old backup verbatim.** Queued applies and connection settings can redirect the node or replay obsolete work. Immutable backups retain those values for inspection; current control files stay authoritative, and write epochs invalidate old requests.

## Consequences

macOS launchd and Linux systemd require a separately installed configuration service. External TLS and routing remain operator responsibilities. Prepared path changes are verified rather than inferred from folder names, and key relocation does not perform key rotation. Orphaned writer locks need explicit owner verification and local recovery. Maintenance does not close merely because a service restart succeeded.

The [maintenance decision](2026-09-25-gateway-deployment-maintenance.md) continues to own database and file restoration. The [node configuration reference](../../../../gateway/deploy/node-configuration/README.md) owns operations, settings and installation.
