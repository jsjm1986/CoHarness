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
- [Verify recovery](#recovery)
- [Replace a project computer](#takeover)
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

| Built-in exporter | Included | Coverage gaps |
|---|---|---|
| Project | Rows from its published node volume in one repeatable-read transaction, including workspace, conversation, execution and journal records | Workspace, attachments and plugin files require a provider for the same revision. |
| Personal Runtime | Promoted directory, tab drafts, scoped PostgreSQL Session and plugin rows, and published account-document records | Native file snapshots are optional; independent domain watermarks, background delivery and unsupported plugin state remain explicit gaps. |
| Governance | Selected account, membership, project, allocation, topology and policy fields on the primary | Other governance state, audit data, service keys and external plugin data require separate protection. |

A partial point can recover the listed domains. Admin displays gap categories, the last receiver storage measurement and the latest drill. A failed drill or remaining coverage gap blocks formal recovery preflight. Existing maintenance backups retain their separate scope and restore guards.

For personal files, `HGW_PEER_PERSONAL_SNAPSHOTS_FILE` selects an owner-private JSON file with `version: 1`, `organizationId`, `nodeId`, `provider: "btrfs"|"vss"` and a `runtimes` array. Each entry specifies `runtimeId`, `source`, `snapshotDirectory`, approved `workspaces` as `{id,path}` records and, for VSS, the volume GUID `volume`. Keep declared Runtime storage and the account’s three UserDoc roots inside the selected native snapshot. Restore materializes only into a fresh isolated directory. File coverage does not certify scheduled delivery or a shared database checkpoint.

<a id="recovery"></a>

## Verify recovery

Select the point and an independent managed computer, then choose **Start isolated drill**. The worker checks free space, decrypts into a fresh private directory, verifies hashes, scope and logical order, records the outcome, and removes rehearsal plaintext. A completed drill needs a gap-free point. Revoke or rotate the policy to deny subsequent network access. An independent recovery password already in offline custody remains usable with an acquired ciphertext copy.

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

The command materializes authenticated ciphertext in isolation, verifies the restored content, removes its temporary repository and prints the retained plaintext path, coverage and elapsed time. Restrict access and remove this private rehearsal after inspection. Activation separately requires fresh proof that the original writer stopped, an exclusive replacement epoch and fresh desktop authorization. Loss of a lease or an unreachable old computer leaves publication blocked.

<a id="takeover"></a>

## Replace a project computer

Open a published project’s backup policy in Admin. Select a gap-free point and complete an independent drill on the designated receiving computer. If that computer has multiple registered data volumes, select the intended volume explicitly. **Prepare replacement** decrypts into a newly reserved workspace and Runtime home. The replacement rebuilds the local UserDoc storage identity and verifies the saved Session events and scheduled delivery receipts. The source continues serving while preparation runs.

Choose **Review source retirement** when the original Runtime has already stopped. Its supervising Gateway must prove the exact generation is quiescent, all outstanding file operations and journal deliveries are settled, and the protected files and SQL revision still match the selected point. A changed workspace requires a newer backup and drill. Active or disconnected writers, missing delivery receipts, unsupported plugin storage, and occupied target paths block the switch. Cancel a preparation before the source is fenced to keep using it.

A Gateway that has already retired the file writer for this project cannot approve itself as its replacement. Select a different eligible destination. Preserve the old Gateway’s durable retirement record.

Choose **Review switch** after the source is fenced. The primary moves the existing Runtime and project to the verified replacement volume in one transaction. The replacement checks its rebuilt files before opening its higher writer epoch. Desktop control requires fresh authorization. Check **Refresh takeover status** for completion. Starting the recovered Runtime uses its normal authorization and scheduling policy.

A paused or rotated policy requires a new drill of the same recovery point under the current policy revision. **Review takeover continuation** confirms that revision, the original point and the existing target. It does not reopen the fenced source. Ordinary quota and recovery-objective changes wait until takeover finishes or is cancelled. Cancelled candidates must finish cleanup before another preparation uses their destination.

Takeover retains computer and project permissions. Admin shows the number of members who still need access to the target computer. After activation, use **Protect the replacement** to create a policy for the same project on its new computer. Select a different receiver, provision fresh credentials and verify the first recovery point. The former policy does not protect the new source automatically.

<a id="providers"></a>

## Snapshot providers

On Linux, `HGW_PEER_PROJECT_SNAPSHOTS_FILE` selects an owner-private JSON file with `version: 1`, the organization and node UUIDs, `provider: "btrfs"`, and a `projects` array. Each record contains the assigned project UUID, its source `subvolume`, and a separate `snapshotDirectory` on the same Btrfs filesystem. Grant the Gateway read-only snapshot creation and release for these testable locations. Keep the workspace, declared Runtime storage, and the Gateway’s UserDoc metadata and retained-object directories within the source subvolume. Unclassified state or nested subvolumes prevent a complete checkpoint. Windows and macOS receivers can check encrypted checkpoints independently of the source snapshot provider. A Windows source uses a dedicated NTFS volume and the VSS provider. On a Mac source, check the dedicated APFS volume and configure a scoped snapshot service. See the [node storage setup](../../deploy/node-content/README.md).

A scoped `snapshotExecutable` in the private route can supply a consistent file and database version and an independent semantic verifier. Install the same approved provider outside restored data on the recovery computer. Its literal arguments are `capture|validate`, a private request-file path and the staging payload path. It receives scope coordinates, byte and row limits, required domains and, for validation, the sealed capture. Both actions run without browser credentials.

Capture returns the version, organization, source, scope, writer epoch, watermark, UTC snapshot time, covered count and explicit gaps. Validation returns `{"version":1,"checked":[…]}`. Each required domain must be verified or have a matching `domain:reason` gap. Preserve immutable Session generations, resolve attachment references to their bytes, and compare scheduled delivery receipts without executing the tasks. Keep the snapshot provider and escrow out of the protected file inventory. See the [provider implementation](../../src/peer-backup-snapshot-owner.ts) for field names.

## Dev Note

Organization migrations 109, 115, 119 and 120 retain policy fingerprints, recovery points, approvals, source writer fences and cleanup acknowledgements. Node migrations 012 and 016 retain retirement, replacement and staging ownership receipts. Governance inventory version 2 omits project names and includes recovery continuation receipts; version 1 remains an isolated partial inventory. See the [recovery decision](../../../.agents/notes/implemented/architecture/2026-11-05-project-recovery-reauthorization.md). The [receiver](../../src/peer-backup-repository.ts) owns the append-only ciphertext repository. The [rehearsal command](../../src/peer-backup-rehearse-main.ts) verifies a specified point without opening a source or organization connection.

The [two-computer rehearsal](../../tests/run-peer-backup-os-pair.py) removes its synthetic source and closes both transport forwards before restoring the receiving repository. The [online writer replacement fixture](../../tests/run-peer-backup-online.py) uses disposable databases, a private Windows test disk and a source that remains available to certify retirement. Its end-to-end timing includes admission, transfer, rehearsal, approval, activation and one scheduled delivery. The offline restic timer measures decryption and restoration to the private checkout.
