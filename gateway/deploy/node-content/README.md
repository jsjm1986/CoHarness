# PostgreSQL storage for one project computer

English | [中文](README.zh.md)

The organization's PostgreSQL database owns accounts, access policies, Runtime assignments and model accounting. A dedicated content database can keep a project's Session bodies, private participants, answers, execution receipts, composer drafts and workspace catalog on its assigned computer. Provisioning prepares the volume. Existing projects continue to use their recorded storage.

Personal workspace listings and fallback conversation drafts share one file process per Gateway. It starts on the first local read or write. Keep the state directory on a locally mounted, account-protected volume. Its existing SQLite databases, journals and auxiliary files must be private, with no symbolic or hard links. On Windows, use a fixed NTFS or ReFS volume and grant access to the owning service account, SYSTEM or local administrators.

## Provision a volume

Create an empty PostgreSQL 17 database in the default tablespace on the project computer, including the main computer if it hosts projects. Give the Gateway's application role permission to connect. Use a separate provisioning role that can install `pg_trgm`, read the fixed PGDATA challenge and inspect the PostgreSQL system identifier. Keep the application role separate from the database owner in production.

Create the directory `harness-node-content-proofs` inside PGDATA. The Gateway account needs to create and remove challenge files there, read `global/pg_control`, and inspect the relation files and WAL directory. PostgreSQL needs to read the challenge files. Use a shared service group or private operating system ACLs for these accounts. Keep PGDATA, the database relations and WAL on local storage.

Configure `HGW_NODE_CONTENT_DATABASE_URL_FILE` with the absolute path to a private file containing the application database URL. Set `HGW_NODE_CONTENT_VOLUME_ID` to a stable UUID and `HGW_NODE_CONTENT_PGDATA` to the host-visible absolute data directory. For provisioning, set `HGW_NODE_CONTENT_MIGRATION_URL_FILE` to the private URL file for the database owner. The existing organization connection, organization slug and node name select the control record.

From the repository root, run the built Gateway command after applying the organization migrations.

```sh
node gateway/lib/node-content-provision-main.js
```

Success reports the node ID, volume ID and installed node schema version. The command creates a random file under PGDATA, checks the connected PostgreSQL process can read it, compares the database and cluster identities, and confirms the files are on a supported local filesystem. Each newly borrowed database connection repeats the challenge before first serving project content.

## Project placement and migration

Published projects require the recorded node, volume, Runtime and writer epoch. A missing database, mismatched identity or unsupported schema makes the affected project unavailable. Accounts and projects using a different store can continue working.

The publication check requires an installed storage adapter for every project content domain. Deployments missing an adapter keep creating projects with their existing storage layout. An existing project can be copied in the background while it remains writable. The migration checks persisted bytes and typed rows. Publication requires the original Runtime to have already stopped, a process-owned quiescence receipt for that generation and an unchanged source revision. A changed source needs a fresh snapshot.

A migrated project retains the status `retiring` while the original database still holds historical content. It can be marked physically isolated after source retirement under the organization’s retention policy. A verified volume or a successful staging copy does not satisfy this condition.

## Protect live project files on Linux

On a Linux project computer with a dedicated local Btrfs volume, the peer-backup worker can include live project files. Place the project workspace, Runtime storage and both private UserDoc roots within the configured source subvolume. Keep a separate Gateway-owned snapshot directory on the same filesystem, outside the source. Mount it with `user_subvol_rm_allowed` for an unprivileged Gateway and compile the kernel witness with `node gateway/scripts/build-btrfs-witness.mjs` on that computer. Protect the release directory against modification by Runtime accounts.

Set `HGW_PEER_PROJECT_SNAPSHOTS_FILE` to the canonical path of an owner-only JSON file containing `version: 1`, `organizationId`, `nodeId`, `provider: "btrfs"` and a `projects` array. Each entry contains the internal `projectId` UUID, absolute `subvolume` and absolute `snapshotDirectory`. The worker exports the approved project roots, checks the database and UserDoc watermarks, then releases its private filesystem snapshot. After a backup process dies, a subsequent capture on this source can reclaim its snapshot in the same PID namespace. It checks the process lifetime, source filesystem, parent subvolume and snapshot UUID before deleting. Nested filesystems, unregistered plugin files or missing snapshot capability prevent a complete recovery point. Check each policy’s coverage before retiring an earlier backup.

## Protect live project files on Windows

For a Windows project computer, use a dedicated fixed NTFS data volume. Set `provider` to `"vss"` in the same snapshot configuration. Each project entry contains `projectId`, the canonical project data subtree `source`, the original volume GUID `volume` and a Gateway-private `snapshotDirectory` outside that subtree. The volume GUID is available from `Get-Volume`. Include the workspace, Runtime storage and the two UserDoc private roots in the selected subtree. Set `commandTimeoutMs` to the local deadline for volume inspection and shadow creation.

The Gateway service account needs access to DiskShadow and the local volume shadow copy service. It verifies the original volume GUID, filesystem and boot/system roles, then holds a volatile, read-only view while copying. Approved paths are checked for reparse points, named streams and the configured entry limit. A rejected path or unavailable provider prevents a complete recovery point. On normal completion the Gateway releases the shadow and checks it has disappeared. If the backup process is killed, the next capture from the same staging directory checks the recorded owner process and volume before removing its abandoned shadow.

## Check a Mac project volume

Run `node gateway/scripts/check-apfs-project-volume.mjs` on the project Mac to list mounted, writable APFS volumes backed by local physical disks and reserved for application data. Once the volume is mounted, pass its canonical mount path, volume UUID and the project’s workspace, Runtime storage and private UserDoc directories to the same command. It checks the APFS roles, physical stores, snapshot catalog and each directory’s device. An empty list means there is no eligible mounted volume.

Configure the project policy’s scoped `snapshotExecutable` with an approved snapshot service on this Mac. Qualify a live capture and a restore from the designated receiving computer before counting the project files as protected. Without a consistent file snapshot, the built-in project export records a workspace and plugin file coverage gap.

## Verify the isolated database path

On a POSIX machine with Docker and the local `postgres:17.6-bookworm` image, run `node gateway/tests/run-node-content-postgres.mjs --legacy`. The fixture provisions an independent test cluster, drives Runtime HTTP and a loopback model, and cleans up the temporary cluster and data directory. It also runs the existing shared-store project activity, progress, namespace and execution tests.

With the Gateway, CLI and Web Host built, `node gateway/tests/run-node-content-postgres.mjs --operations` starts two Gateways, two Web Hosts, a Node Agent, a private governance database and an authenticated loopback model. It checks prepared conversations, rejection after browser disconnect, Runtime ownership and duplicate prompt admission. Set `HGW_TEST_PG_BINDIR` to a local PostgreSQL binary directory to use a separate native cluster. The harness removes the cluster after verification, including its immutable execution receipts.

## Organization-wide project names

Project names retain the organization database’s existing case and collation rules. The primary keeps keyed equality tags and opaque project, node and name-version IDs for physically placed projects. Their display names and paths are read on their owning computers.

On the designated primary, create an operating-system-private directory outside all workspaces. Use canonical absolute paths under that directory for the following command. The first argument is a public key identifier. The second is a new file that must not exist. The command reads the Gateway's existing organization connection and writes no key material to the terminal.

```sh
node gateway/lib/project-name-key-main.js k1 /private/organization-keys/project-names-v1
```

Set `HGW_PROJECT_NAME_KEY_FILE` to that file on the primary. With an authenticated administrator session, read `GET /admin/api/deployment/project-names`, then send `{ "keyId": "k1", "expectedRevision": null }` to its `/prepare` endpoint. Call `/reindex` on each project-owning Gateway starting with `{ "after": 0 }` and pass the returned cursor until it is null. Activate on the primary with `{ "revision": "<current revision>" }` at `/activate`. A disconnected owner or a missing project reservation prevents activation. Historic plaintext copies remain subject to their separate retirement inventory.

To rotate, create a second private generation by giving the same command a third argument pointing to its predecessor. Back up the keyring in the organization's independent recovery custody and check the recovery copy before switching the primary to the new file. Prepare with the current revision, reindex every owner, and activate. Existing keys enforce uniqueness during rotation. The fingerprints in the governance backup cannot regenerate the secret keys.

The primary database role must be able to suppress bind-value logging during name normalization. A database administrator can apply role-specific defaults for `log_parameter_max_length` and `log_parameter_max_length_on_error` of zero, and disable parameter logging for installed audit or auto-explain extensions. A request refuses to send a display name to the SQL normalizer if it cannot establish those settings.

## Move an existing project

Open Deployment in the Admin view of the computer that owns the project. Under **Project storage migration**, choose the project and check its status. **Prepare copy** verifies a consistent snapshot while members keep working. Check again after members finish their work. A newer source revision requires a fresh copy. Switch storage only after the Runtime has already stopped, the computer is reachable and the listed checks pass. The Gateway verifies the process generation again when it publishes. A retained historical copy keeps the migration in `retiring`.

For a terminal preflight, set `HGW_ADMIN_SESSION_COOKIE_FILE` to an absolute owner-private file containing only `hgw_session=<session>` for the intended Gateway. Send requests to the same HTTPS origin used for that session. The last two commands require a previously reviewed preflight from the same computer and project.

```sh
node gateway/lib/node-content-migration-cli.js preflight "$GATEWAY_ORIGIN" "$NODE_ID" "$PROJECT_NUMBER" > project-check.json
node gateway/lib/node-content-migration-cli.js prepare "$GATEWAY_ORIGIN" "$NODE_ID" "$PROJECT_NUMBER" project-check.json > prepared.json
node gateway/lib/node-content-migration-cli.js publish "$GATEWAY_ORIGIN" "$NODE_ID" "$PROJECT_NUMBER" prepared.json
```

## Review a project plugin

Managed file claims record observed paths. To admit a custom plugin into a physically placed project, review its full self-contained release, dependencies and all persistence paths. Install that release under the operator’s protected directory and link it into the Runtime profile as a declared package. A project package must be readable by the Runtime account. Keep the approval file and any optional verifier readable only by the Gateway operator. Configure `HGW_NODE_PLUGIN_PROOFS_FILE` on that Gateway with the canonical absolute path of the approval file.

Each entry in `{ "version": 1, "plugins": [...] }` contains `owner` (package name), `releaseDirectory`, `releaseSha256`, `configurations` (reviewed SHA-256 values), and `storage` (`runtime-storage`, `workspace`, or both). `nodePluginReleaseDigest` fingerprints the complete installed file tree. For `configurations`, hash the UTF-8 JSON array of matching profile and home patch layers in verification order. A plugin with no such overrides uses `SHA-256("[]")`. Dynamic expressions and storage paths outside the approved project roots require another provider. Changing the release or configuration requires a renewed review.

An optional `verifier` contains a canonical private `file` and its `sha256`. Its WebAssembly module can import only `proof.memory`, with no host functions and no internal memory or tables. Export `verify(offset, byteLength)` and return integer `1` to accept the UTF-8 JSON evidence. The evidence contains the release digest, applicable configuration, selected storage kinds and relative observed paths. The Gateway process checks the installed profile package, physical roots and hashes independently. It checks again before startup and before applying hot changes.

## Retire a historical source

Migration switches the active writer. Erasure of old media is a separate operation under the organization’s approved retention policy. In Admin, inspect the project’s retirement report. The report lists known live source relations and outstanding storage custodians. Open a review against the current Runtime, writer epoch and SHA-256 of the approved policy. This step checks all eleven migration domain receipts on the owning volume and records the original PostgreSQL cluster, snapshot and current official backup inventory. Projects copied before the original cluster identity was recorded need independent reconciliation.

The six custody domains cover retention policy, backups, WAL archives, replicas, original cluster media and other derived stores. One administrator or custody system can handle several domains with their respective credentials. Each custodian independently inventories its holdings, completes the approved disposition and signs its verification packet with Ed25519. The packet payload contains the exact review challenge except `openedAt`, plus `version`, `domain`, the domain’s verification `method`, `result` (`verified-clear`), `inventoryDigest`, `evidenceDigest`, `resourceCount` and `verifiedAt`. The signatures are over the original UTF-8 payload bytes. Keep the detailed inventories in the responsible custodian’s independent storage.

Provision a distinct PostgreSQL `LOGIN` per domain under `hgw_retire_policy`, `hgw_retire_backups`, `hgw_retire_wal`, `hgw_retire_replicas`, `hgw_retire_cluster_media` or `hgw_retire_other_projections`. Grant the login schema usage, read access to `project_source_retirement_reviews`, `project_content_placement`, `project_source_retirement_evidence` and insert access to `project_source_retirement_evidence`. Keep its private database URL outside the Gateway credential directory. From custodian-controlled infrastructure, set `HGW_SOURCE_CUSTODY_DATABASE_URL_FILE` to that private file. Provide the private pinned public-key declaration (`domain`, `publicKey`) and the signed envelope containing `version: 1`, base64 `payload`, and base64 `signature`.

```sh
node gateway/lib/node-content-retirement-main.js /private/custodian/trust.json /private/custodian/verified-inventory.json
```

Finalization rechecks the current placement, known payloads, ambiguous historic identities and official backup inventory. The active governance cluster must differ from the original plaintext cluster. The old cluster and its copies need independently verified erasure. Deleting rows, vacuuming, switching a volume, loss of network contact or a retained backup leave the project in `retiring`. The command imports evidence. Source disposal is performed independently by its custodians under the approved policy.
