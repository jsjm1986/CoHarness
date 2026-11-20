---
description: "Provision encrypted backups between two managed computers and verify an isolated recovery."
---

# Encrypted computer backups

English | [中文](README.zh.md)

## Summary

In **Admin → Deployment**, choose one scope, its source computer and a different managed receiving computer. The source Gateway encrypts the export and submits it in the background. The receiving Gateway records a point after its repository checks complete. Personal and project Runtimes can continue serving users and background jobs.

## Contents

- [Provision computers](#provision)
- [Read protection status](#coverage)
- [Rotate a repository](#rotate)
- [Verify recovery](#recovery)
- [Replace a project computer](#takeover)
- [Rebuild organization governance](#governance-rebuild)
- [Snapshot providers](#providers)

<a id="provision"></a>

## Provision computers

Enable [multi-computer deployment](../deployment-topology/README.md) and enroll the destination. Install an operator-approved restic executable on capture and rehearsal computers. The tested native version is 0.18.1. It uses the [restic REST repository protocol](https://restic.readthedocs.io/en/stable/100_references.html#rest-backend) through the existing HTTPS Gateway or its enrolled relay.

Generate three independent random values per policy. Keep the append token and repository password on the source. Escrow the recovery token and a second copy of the password separately from both working computers. The receiver needs its own private ciphertext directory and no repository password. On POSIX, the following commands create owner-private files and print only the two fingerprints entered in Admin. On Windows, use owner-only ACLs for the same three files.

```sh
umask 077
openssl rand -hex 32 > append.token
openssl rand -hex 32 > recovery.token
openssl rand -hex 32 > repository.key
node -e "for (const f of process.argv.slice(1)) console.log(f, require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(f,'utf8').trim()).digest('hex'))" append.token recovery.token
```

Create the policy, choose its storage quota and copy its ID under **Deployment identity**. Place the following JSON in a private file on each participating Gateway and set its absolute path as `HGW_PEER_BACKUP_CONFIG_FILE`. Use separate ciphertext and staging directories outside Runtime homes, projects, Gateway state, deployment backups and secret storage. Replace the example paths, origin and policy ID.

```json
{
  "version": 1,
  "directory": "/srv/peer/encrypted",
  "stagingDirectory": "/srv/peer/staging",
  "resticExecutable": "/opt/restic/restic",
  "capacityBytes": 10737418240,
  "reserveBytes": 536870912,
  "maxExportBytes": 2147483648,
  "uploadKiBps": 2048,
  "downloadKiBps": 4096,
  "routes": [{
    "policyId": "11111111-1111-4111-8111-111111111111",
    "origin": "https://gateway.example",
    "appendTokenFile": "/secure/peer/append.token",
    "passwordFile": "/secure/peer/repository.key"
  }]
}
```

A receiver-only installation sets `routes` to `[]`. An independent rehearsal computer points to the same repository origin and policy ID, using `recoveryTokenFile` and `recoveryPasswordFile`. Apply configuration through the normal Gateway deployment procedure. The Admin status shows whether its local worker is configured. HTTP is limited to numerical loopback addresses for local tests.

<a id="coverage"></a>

## Read protection status

**Protected through** is the source snapshot time of the latest durably acknowledged recovery point. Important scopes use a 15-minute recovery point objective and ordinary scopes use one hour. Disconnection, quota exhaustion, missing binaries or an incomplete upload cannot advance the confirmed time. The next capture reuses completed encrypted packs. The receiver enforces policy quota, repository capacity, object count and a disk reserve. Allow scratch space for uploads, database journals and an uncompressed rehearsal.

`reserveBytes` also protects source staging and the volumes used by a live native snapshot. Built-in exporters check available space before each SQL batch, file chunk and payload manifest; concurrent jobs share write admission. Online and offline rehearsals retain this admission through additional personal validation and reconstruction copies. Insufficient or unreadable space stops the backup, releases its snapshot and removes its private staging files without stopping a Runtime. Personal SQLite projection needs up to three times `maxExportBytes` in scratch capacity; an external snapshot provider requires its full declared `maxExportBytes` before execution. These checks do not replace filesystem quotas: unrelated processes and native snapshot copy-on-write storage can consume space independently. Configure operating-system storage limits and keep unknown plugin coverage marked incomplete.

| Built-in exporter | Included | Coverage gaps |
|---|---|---|
| Project | Rows from its published node volume in one repeatable-read transaction, including workspace, conversation, execution and journal records | Workspace, attachments and plugin files require a provider for the same revision. |
| Personal Runtime (default exporter) | Promoted directory, tab drafts, scoped PostgreSQL Session and plugin rows, and published account-document records | Optional native file snapshots add file coverage. Independent domain watermarks and background delivery remain gaps; unknown plugin state and missing sources add their own gaps. |
| Governance | Reviewed management identities, quotas and usage, placement, name-HMAC material and recovery evidence | Rebuilding starts with credentials and permissions disabled. Node business data, model connections, plugin configuration and external credentials require separate recovery or configuration. Inventories 1–6 remain partial. |

A partial point can recover the listed domains. Admin shows coverage gaps, whether the latest point is within the recovery point objective, and the latest drill. A partial point can also be overdue. The receiving Gateway separately measures policy quota, shared repository usage, writable object count and free disk reserve, even when a policy has never completed a capture. Admin timestamps each measurement and marks it stale if the receiver stops reporting. An expired measurement no longer establishes available space. A failed drill or coverage gap blocks formal recovery preflight. Maintenance backups retain their own scope and restore guards.

For personal files, `HGW_PEER_PERSONAL_SNAPSHOTS_FILE` selects an owner-private JSON file with `version: 1`, `organizationId`, `nodeId`, `provider: "btrfs"|"vss"` and a `runtimes` array. Each entry specifies `runtimeId`, `source`, `snapshotDirectory`, approved `workspaces` as `{id,path}` records and, for VSS, the volume GUID `volume`. Keep declared Runtime storage and the account’s three UserDoc roots inside the selected native snapshot. Restore materializes only into a fresh isolated directory. File coverage does not certify scheduled delivery or a shared database checkpoint. The default personal exporter remains partial. An approved scoped `snapshotExecutable` can instead cover a personal Runtime if its separate validator proves every required domain; installing that executable alone does not prove a complete recovery point.

<a id="rotate"></a>

## Rotate a repository

1. In **Admin → Deployment**, choose **Rotate repository** on the active policy and copy the displayed new policy ID. Provision its append token and encryption key on the source. Provision the independent recovery credentials and escrow copy on the recovery side. Reserve space for a full new repository and SQLite journals while the original is still present. Use another admitted receiver when the current one lacks this headroom.
2. Submit the rotation. Captures move to the new policy in the same organization transaction that seals the original. The original recovery credential still reads its points, and existing approved recovery operations keep their policy revision. The original append credential is withdrawn. Any rehearsed point in the original repository remains available while provisioning or transfers are retried.
3. Capture and independently rehearse a complete point under the current replacement policy. The point must cover the same scope, be within its recovery point objective and protect at least as far as every original point. Admin then offers **Review repository retirement**. Approval names the old repository and the exact retained point. A repository in use by a rehearsal, unfinished recovery or outstanding retirement cannot be retired.
4. Approve permanent retirement only if the original history is no longer needed. The receiver withdraws access and reclaims that repository in restartable batches under the serving deployment's approval. Each batch requires the retained point's policy to remain enabled at its rehearsed revision. Reclaimed SQLite pages can support later captures within the same receiver capacity. The physical file can stay at its existing size, and the receiver still requires its configured free disk reserve. Offsite copies remain subject to their own retention.

The Admin row records whether retirement is pending, complete or awaiting renewed approval. A disconnected receiver resumes after it rejoins, while maintenance pauses reclaim. Disabling or revising the retained policy and rebuilding governance both require review of a fresh rehearsal before reclaim resumes. Historical approval and point metadata remain available for audit. Append and recovery credentials cannot retire a repository.

<a id="recovery"></a>

## Verify recovery

Select the point and an independent managed computer, then choose **Start isolated drill**. The worker checks free space, decrypts into a fresh private directory, verifies hashes, scope and logical order, records the outcome, and removes rehearsal plaintext. A completed drill needs a gap-free point. Pause the policy or rotate the recovery credential to deny subsequent network access with the previous credential. An independent recovery password already in offline custody remains usable with an acquired ciphertext copy.

When the primary and source are unavailable, use the receiving repository and escrowed password on an isolated recovery host. Start with an empty private recovery directory on a separate volume. Put the escrowed organization, source, target, policy and point UUIDs in an owner-private JSON file. Use the built Gateway entry from `gateway/`.

```json
{
  "version": 1, "kind": "project",
  "organizationId": "<organization UUID>", "sourceNodeId": "<source UUID>",
  "targetNodeId": "<receiver UUID>", "policyId": "<policy UUID>", "pointId": "<point UUID>",
  "repositoryDirectory": "/recover/encrypted", "recoveryDirectory": "/isolated/new-drill",
  "passwordFile": "/escrow/repository.key", "resticExecutable": "/opt/restic/restic",
  "maxBytes": 2147483648, "maxRows": 2000000, "reserveBytes": 536870912, "timeoutMs": 3600000
}
```

```sh
node lib/peer-backup-rehearse-main.js /escrow/selected-point.json
```

The command materializes authenticated ciphertext in isolation, verifies the restored content, removes its temporary repository and prints the retained plaintext path, coverage and elapsed time. Restrict access and remove this private rehearsal after inspection. Planned activation separately requires fresh proof that the original writer stopped, an exclusive replacement epoch and fresh desktop authorization. Loss of a lease or an unreachable old computer supplies no stop proof; disaster recovery requires the explicit physical isolation procedure below.

<a id="takeover"></a>

## Replace a project computer

The backup receiver and the replacement may be different managed computers. The original point and receiver remain unchanged. Both computers must advertise the installed recovery protocol and retain a current connection. The replacement also needs an assembled worker for the selected project or personal scope; a receiver can provide ciphertext storage alone. Select the replacement for the drill and takeover, then select its registered volume. An administrator-created standard project without a personal owner remains recoverable; recovery never grants its members computer access. Steward projects are outside this workflow.

For a different replacement, configure a dedicated `recoveryTokenFile` and the escrowed `recoveryPasswordFile` in that computer’s private policy route, pointing `origin` at the original receiver. In **Replacement backup read access**, approve only the token fingerprint and a local expiry within the configured backup `timeoutMs`. The approval binds the policy revision, point, replacement identity and connection generation. Reconnection, revocation, expiry or policy changes require a new approval and credential; perform an independent drill on that replacement. The repository password can decrypt other historical points that share its blobs: this approval restricts platform operations, not cryptographic access to a single point. Keep the private key and restored staging area under approved administrative control.

Open a published project’s backup policy in Admin. Select a gap-free point and complete an independent drill on the selected replacement computer. If that computer has multiple registered data volumes, select the intended volume explicitly. **Prepare replacement** decrypts into a newly reserved workspace and Runtime home. The replacement rebuilds the local UserDoc storage identity and verifies the saved Session events and scheduled delivery receipts. The source continues serving while preparation runs.

Choose **Review source retirement** when the original Runtime has already stopped. Its supervising Gateway must prove the exact generation is quiescent, all outstanding file operations and journal deliveries are settled, and the protected files and SQL revision still match the selected point. A changed workspace requires a newer backup and drill. Active or disconnected writers, missing delivery receipts, unsupported plugin storage, and occupied target paths block the switch. Cancel a preparation before the source is fenced to keep using it.

Schedule history follows the plugin's retention policy. Pruned receipts and explicitly deleted tasks do not remove their committed Session messages or block recovery by themselves. Every retained receipt must still identify a committed message; an active occurrence at or before a recorded delivery remains ambiguous and blocks promotion. Recovery checks do not execute schedules.

A Gateway that has already retired the file writer for this project cannot approve itself as its replacement. Select a different eligible destination. Preserve the old Gateway’s durable retirement record.

Choose **Review switch** after the source is fenced. The primary moves the existing Runtime and project to the verified replacement volume in one transaction. The replacement checks its rebuilt files before opening its higher writer epoch. Desktop control requires fresh authorization. Check **Refresh takeover status** for completion. Starting the recovered Runtime uses its normal authorization and scheduling policy.

A paused or rotated policy requires a new drill of the same recovery point under the current policy revision. **Review takeover continuation** confirms that revision, the original point and the existing target. It does not reopen the fenced source. Ordinary quota and recovery-objective changes wait until takeover finishes or is cancelled. Cancelled candidates must finish cleanup before another preparation uses their destination.

Takeover retains computer and project permissions. Admin shows the number of members who still need access to the target computer. After activation, use **Protect the replacement** to create a policy for the same project on its new computer. Select a different receiver, provision fresh credentials and verify the first recovery point. The former policy does not protect the new source automatically.

### Recover data after source loss

Choose **Disaster recovery** only after rehearsing a complete point on the replacement. The target must advertise the upgraded preparation protocol even when it is also the backup receiver; an older worker cannot accept a new disaster preparation. Preparation first verifies the restored files, supported platform and registered target volume without contacting the source. Only a verified candidate permits isolation confirmation. Power off or isolate the old computer in the cloud console or on site, then record the evidence reference and acknowledge the data gap after the point. Confirmation is bound to the inspected point, policy revision, computer, process generation and writer epoch. It revokes the entire source computer's credentials and leases; other projects on that computer need separate recovery approval. The current primary cannot isolate itself, and a quarantined identity cannot enroll again.

The replacement restores from encrypted backup without reading the source, pauses schedules in its private restored copy and verifies the resulting files and delivery evidence. Source stop and content proofs remain absent. **Review switch** publishes the higher writer epoch while retaining the hold on restored work. After target activation, **Check restored execution configuration** inspects the stopped Runtime without starting or stopping a process. Review the suspended components, then approve **New conversations only**. Restored conversations remain readable but cannot resume, accept messages or replay queued inbox work. New conversations use the reviewed base configuration and normal computer, project, model and plugin permissions.

Review eligible plugins and external connections individually with an evidence reference. Approval binds the installed artifact and configuration digests and requires another stopped-Runtime inspection; it does not restart running work. Uninspectable dynamic configuration remains disabled. Configuration changes require a fresh review before launch or reload. Keep the private `recovery-execution` files with node data: project backups encrypt them with their owner’s content, and maintenance backups verify their immutable digests. Missing or changed files block execution.

A further source failure can create a new disaster recovery and review at a higher writer epoch. Planned migration carries the original frozen Session set in the encrypted recovery point and requires a new execution review on the destination. Later ordinary conversations are not added to that set. Missing source review data blocks preparation before source retirement; plugin and connection approvals do not transfer. Routine upgrades retain the existing policy and do not use disaster recovery. After returning to single-computer mode, Deployment retains a local execution-review entry for published projects on that computer; it offers no remote target or new takeover. This activation procedure applies to collaborative projects. Governance reconstruction uses its separate offline procedure below.

### Replace a personal computer

A complete native personal recovery point uses format `native-personal-v3`. Its file view must include the Runtime home, approved workspaces, tab drafts, directory SQLite data and all account-document roots. The installed Session reader verifies every root and child JSONL directory. PostgreSQL-backed personal Sessions, independent file/SQLite snapshots, unknown plugin data and incompatible Session path platforms block formal activation. Earlier partial points remain available for isolated inspection.

In the personal backup policy, prepare the selected replacement and volume before confirming physical isolation. Target preparation restores and checks a private copy while leaving source tasks unchanged. The account must already have target-computer permission and available Runtime quota. An occupied target Runtime home or account document directory blocks replacement; the workflow does not overwrite or merge it. Other active personal Runtimes of that account on the target must first become safely stopped through normal management.

After source isolation, approve the switch and wait for target publication. The worker installs only its recorded directories, restores document identity and rebinds directory/draft coordinates while preserving each tab identity. The original account and Runtime IDs remain unchanged. Account documents move once; another Runtime from the same account and source may reuse only the identical document checkpoint on that target. Restore schedules remain inactive and every restored Session stays read-only. Inspect the stopped Runtime and approve new conversations through the same component-review workflow; no existing task is stopped for inspection. Single-computer mode retains this local personal review entry. Protect the replacement with a new backup policy; the old source policy is disabled at publication. A verified but unpublished personal candidate blocks ordinary maintenance backup because its unfinished physical installation is not a restorable file snapshot. Complete recovery, or cancel before isolation, before retrying that backup.

<a id="governance-rebuild"></a>

## Rebuild organization governance

A `governance-rebuild-v1` point contains a column-reviewed management package. Unknown schema additions prevent complete capture. The exporter excludes business bodies and local paths, preserves account/Runtime/project identities and quota usage, and includes unchanged project-name equality keys. Older governance inventories 1–7 support isolated inspection only; they cannot authorize reconstruction.

The current exporter requires migrations through 145. The replacement can import `governance-rebuild-v1` points from reviewed schemas 135 through 145 when their migration checksums match the installed prefix. Device registrations and delivery outcomes require fresh setup after reconstruction. Import keeps the database in `restoring` mode even when the source has never entered maintenance.

Physically isolate the lost primary and retain the confirmation reference. On the replacement, first decrypt and verify the point with the offline rehearsal command. Run `node gateway/lib/governance-rebuild-main.js /private/governance-rebuild.json` against a fresh PostgreSQL database. The owner-private configuration contains `version: 1`, `action: "import"`, `databaseUrlFile`, `packageDirectory` from the rehearsal, `bootstrapPasswordFile`, `operationId`, a new `targetNodeId`, `targetNodeName`, the original administrator’s `bootstrapUserId`, `isolationMethod`, `evidenceReference`, `acknowledgeDataLoss: true`, `maxBytes`, `maxRows` and `timeoutMs`. Provide `projectNameKeyFile` when the point contains registered equality keys. Paths are absolute; secret values never enter command arguments. The command applies the installed migrations, refuses a populated database and starts no service.

Import commits a closed review receipt before installing the key file. A failed file installation leaves that receipt closed. Correct the owner-private destination and repeat with `action: "install-name-keyring"` and the same point, operation and replacement identities; this action neither reimports rows nor changes passwords. Keep the verified plaintext area private until recovery and key installation are complete. Never generate replacement equality-key material.

Start the replacement’s restricted Admin entry at `/admin/governance-recovery`. The bootstrap administrator uses the new password. Review accounts and computers and acknowledge the explicitly unrestored domains before release. Restored accounts receive fresh passwords and ordinary member roles; release permits login, while previous computer, project, model and plugin grants remain disabled. The page retains original authorization records for reconfiguration in the existing Admin. Old browser sessions, node credentials and enrollment codes stay unusable; computers need fresh enrollment.

Each retained Runtime requires a separate local data binding and execution review. Existing directories, local index identity, Session generations and actual supervisor quiescence must agree. Unknown or busy supervisors block inspection without stopping them. After organization review is released, open `/admin/governance-recovery/local` at the owning computer to select nonstandard paths and review that computer’s execution. This page requires current administrator and local computer-use permissions and contains no organization account, remote-computer or release controls. Before binding, remove inherited `HGW_`, `DSH_`, libpq and `DATABASE_URL` keys from the old Runtime `.env`; provide needed settings through current node deployment or reviewed plugin configuration. Replacing their values in the old file is insufficient. Diagnostics show key names only. Binding never creates an empty replacement home or changes existing Session bytes. Runtime preparation, model and directory permissions, personal documents, personal snapshots and maintenance file collection verify the same private locations; unavailable binding evidence prevents access or certification instead of selecting default directories. If manual inspection fails, resubmit the selected directories; a background worker cannot replace that selection with standard paths. Reviewed new conversations use the exact bound home; all old root/child Sessions, pending work and scheduled work remain paused. Plugin and external-connection permissions require fresh artifact/configuration review. Node-private binding and execution receipts belong in that node’s encrypted backups, not the organization inventory.

A later planned project move carries the current governance-frozen Session set and requires a new destination component review. The destination must prove it read the transferred private policy before source retirement can be approved; older workers without this proof cannot advance the move. Project writer epochs and Runtime process generations remain separate identities.

A verified schema-135 reconstruction package can be imported into schema 136 after checking its original migration checksums and exact column inventory. Existing recovery operations retain their original receiver; unfinished disaster preparations without target proof require target verification. Ephemeral read approvals and protocol heartbeats are not restored, and no previous admission is reopened.

<a id="providers"></a>

## Snapshot providers

On Linux, `HGW_PEER_PROJECT_SNAPSHOTS_FILE` selects an owner-private JSON file with `version: 1`, the organization and node UUIDs, `provider: "btrfs"`, and a `projects` array. Each record contains the assigned project UUID, its source `subvolume`, and a separate `snapshotDirectory` on the same Btrfs filesystem. Grant the Gateway read-only snapshot creation and release for these testable locations. Keep the workspace, declared Runtime storage, and the Gateway’s UserDoc metadata and retained-object directories within the source subvolume. Unclassified state or nested subvolumes prevent a complete checkpoint. Windows and macOS receivers can check encrypted checkpoints independently of the source snapshot provider. A Windows source uses a dedicated NTFS volume and the VSS provider. On a Mac source, check the dedicated APFS volume and configure a scoped snapshot service. See the [node storage setup](../../deploy/node-content/README.md).

A scoped `snapshotExecutable` in the private route can supply a consistent file and database version and an independent semantic verifier. Install the same approved provider outside restored data on the recovery computer. Its literal arguments are `capture|validate`, a private request-file path and the staging payload path. It receives scope coordinates, byte and row limits, required domains and, for validation, the sealed capture. Both actions run without browser credentials.

For a personal Runtime, the required domains are `directory`, `drafts`, `sessions`, `files`, `document-references`, `plugins` and `background-delivery`. The provider must preserve the exact account, computer and Runtime, the tab identity of drafts and immutable Session generations. It must reconcile scheduled-delivery receipts with persisted Session messages, verify referenced file bytes and declare unknown plugin data as a gap. A shared filesystem snapshot must include all claimed file and SQLite domains; independent PostgreSQL snapshots need stable scoped watermarks or another proved coordination mechanism. Neither matching timestamps nor copied `storages` files establish that proof. Capture and validation must not stop active tasks or execute restored timers.

Capture returns the version, organization, source, scope, writer epoch, watermark, UTC snapshot time, covered count and explicit gaps. Validation returns `{"version":1,"checked":[…]}`. Each required domain must be verified or have a matching `domain:reason` gap. Preserve immutable Session generations, resolve attachment references to their bytes, and compare scheduled delivery receipts without executing the tasks. Keep the snapshot provider and escrow out of the protected file inventory. See the [provider implementation](../../src/peer-backup-snapshot-owner.ts) for field names.

Personal and project disaster recovery suspend restored `HGW_*`, `DSH_*`, libpq connection settings and `DATABASE_URL` in the target copy. Admin shows only affected setting names for explicit target-side configuration; the encrypted source point retains the original values. Business environment settings remain intact. Ordinary upgrades and planned migration preserve their current environment.

## Dev Note

Organization migrations 109, 115, 119, 120, 130–136 retain policy fingerprints, recovery points, approvals, source writer fences, cleanup acknowledgements, disaster isolation and execution reviews. Node migrations 012 and 016 retain retirement, replacement and staging ownership receipts. Governance inventory version 7 includes review hashes, approvals, planned transfer receipts, computer grants, quotas, placements, name-HMAC identifiers and non-content audit fields; versions 1–6 remain readable as partial inventories. Session identifiers and configuration bodies remain in node-private policy files, outside governance inventory. No inventory restores credentials. See the [recovery decision](../../../.agents/notes/implemented/architecture/2026-11-05-project-recovery-reauthorization.md). The [receiver](../../src/peer-backup-repository.ts) owns the append-only ciphertext repository. The [rehearsal command](../../src/peer-backup-rehearse-main.ts) verifies a specified point without opening a source or organization connection.

The [two-computer rehearsal](../../tests/run-peer-backup-os-pair.py) removes its synthetic source and closes both transport forwards before restoring the receiving repository. The [online writer replacement fixture](../../tests/run-peer-backup-online.py) uses disposable databases, a private Windows test disk and a source that remains available to certify retirement. Its end-to-end timing includes admission, transfer, rehearsal, approval, activation and one scheduled delivery. The offline restic timer measures decryption and restoration to the private checkout.

`node gateway/tests/run-node-content-postgres.mjs --disaster-ui` verifies the actual Admin recovery component through loopback HTTP and a disposable PostgreSQL database. It requires the Web test workspace's Playwright and Chromium; `HGW_TEST_PG_BINDIR` can select private PostgreSQL binaries. The registered recovery point is synthetic: this scenario verifies approval, stale-input rejection and execution isolation, not physical shutdown or data restoration. It replays desktop and mobile ARIA snapshots; use `DSH_SNAPSHOT=refresh` to update their expected output.
