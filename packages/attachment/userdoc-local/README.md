---
description: "Real-file user document storage below a per-user upload root"
kind: "package-reference"
---

# @deepseek-ai/dsh-userdoc-local

English | [中文](README.zh.md)

Local `userDocs` backend that stores documents as ordinary files below one configured root, `<home>/documents` by default. The default deployment migrates the sibling `<home>/uploads` tree on the first storage operation: an absent `documents` root is replaced directly, while an existing root is merged without overwriting and collisions receive the same ` (2)` suffix used by uploads. A custom root is not paired with a legacy root unless `legacyUploadRoot` is configured.

Migration uses the shared [writer lock](../../util/atomic-write/README.md) at the sibling `.<root name>-migration.lock`. Only a complete owner record whose process is proven absent can be reclaimed. Contention times out after two seconds with `DOCUMENT_MIGRATION_FAILED`; the engine permits a later initialization attempt. Incomplete records, including interrupted older PID records without a terminating newline, require operator verification before removal.

Writes are two steps. `resolveTarget` validates the destination directory, sanitizes the untrusted client name — both separator styles stripped by hand, control characters removed, byte-truncated to 255, dot-only names refused — then picks the first free leaf, suffixing ` (2)` before the extension and failing with `DOCUMENT_NAME_EXHAUSTED` past a thousand collisions. `save` streams to a sibling `.part` file opened `O_CREAT | O_EXCL`, counts bytes as they arrive, fsyncs, and publishes through an exclusive hard link so an occupied target is never replaced. The default configuration has no per-document byte limit; an explicit `maxFileBytes` still enforces a finite deployment policy. Cancellation also cancels a pending stream read and joins that cancellation before releasing the reader. Failed writes remove only their own partial file; an unsuccessful exclusive create preserves the occupying file. A cleanup failure retains its cause and may leave the owned partial for recovery. On Linux, ordinary saves retain parent descriptors from staging creation through publication or cleanup, so a replaced parent cannot redirect these file operations into its replacement directory.

Only provider staging leaves matching `.userdoc-<24 hexadecimal characters>.part` are hidden. Ordinary completed names such as `archive.part` remain listable and readable. An upload matching the staging namespace receives the normal ` (2)` suffix. Newly resolved file and folder names strip trailing ASCII periods and spaces, including after UTF-8 truncation, so their stored names remain usable on Windows.

Public file and directory selectors reserve root maintenance names across case and Windows suffix aliases. Directory object checks also refuse aliases with another spelling, including filesystem short names. Public reads and scans require a real document root and reject linked components. Internal resumable finalization alone uses its validated private partial path.

Reads take the store-scoped `docId` — the root-relative path with forward slashes — never a caller's copy of `UserDocRef.path`. Each read re-derives the path and proves both lexical and real-path containment, so traversal and a directory symlink outside the root are rejected. `list` recursively returns every regular document; `listDirectory` returns immediate folders and files; `listDirectoryPage` and `listTrashPage` provide bounded filtered pages; `listDirectories` enumerates move destinations. Folder create and rename accept one sanitized leaf, deletion requires an empty non-root folder, and `move` never replaces an existing destination. `openRead` streams downloads, and `remove` treats an already-absent file as success. `trash`, `restore`, and `purge` move documents through a private manifest and hidden file, with `trashRetentionDays` (30 days by default) controlling automatic expiry; restore recreates a missing original directory and uses the normal non-overwriting target policy.

The default standalone provider uses the path-based trash manifest and refuses a second trash operation at a reused path with `DOCUMENT_TRASH_CONFLICT`. The Gateway selects the identity engine through explicit private storage locations. That engine retains independent publication and trash-action ids, permits multiple retained versions at one address, and checks exact authorized revisions before mutation. Restore resolves an available name without consuming another retained version.

Identity-backed one-shot saves check caller cancellation after staging, root-lock waits and runtime file-permission preparation, before physical publication begins. Refusal removes their staged bytes. Buffered identity reads reject interruption after source cancellation finishes and retain independent read and cancellation failures together.

The trash manifest is validated as a whole before listing or mutation. Unknown versions, invalid or duplicate records, unsafe paths, and a missing manifest with remaining hidden files fail with `DOCUMENT_TRASH_NOT_FOUND`; no records are silently discarded or replaced. Preserve the hidden files and restore a complete manifest backup before retrying. An absent manifest is empty only when there are no hidden document files.

Restore publishes through an exclusive hard link. If another writer occupies the selected name before publication, restore fails with `DOCUMENT_RESTORE_CONFLICT` and retains the original trash entry. Retrying resolves a new free name. A failure after publication restores the hidden link before removing the visible copy; if rollback also fails, both causes are retained and remaining copies are preserved for recovery. Linux holds the private-source and public-target parents through publication and rollback. Recreating a missing destination directory also pins its parent; a detected replacement removes the newly created empty directory and preserves the trash entry.

File move rollback also restores the source before removing the destination. If restoration fails, `DOCUMENT_MOVE_FAILED` retains both causes and the destination copy remains available for recovery; a new file occupying the source stays intact.

Directory rename uses the operating system's exclusive move, so even an empty destination created after selection is preserved. Linux and macOS open each parent relative to its retained predecessor and rename relative to those descriptors; Windows excludes parent replacement through handles without delete sharing. Linux x64 and arm64 invoke the kernel's exclusive rename directly, including when musl exposes no `renameat2` wrapper. Detected parent changes refuse acknowledgement. Managed recovery retains its marker and journal after a completed native rename, retries directory synchronization before metadata commit, and preserves ambiguous copies. A platform or filesystem without an exclusive move refuses the operation without falling back to replacement.

Linux trash moves hold both parent descriptors through the move and rollback. A failed manifest commit restores the source through an exclusive hard link; an occupying replacement is preserved together with the hidden original, and the error retains both failure causes.

Retention cleanup rechecks each candidate's current hidden-file identity and deadline under the manifest writer lock. A restored, replaced or renewed entry is skipped; the count includes only committed removals. The writer lock is released between candidates.

On Linux, permanent purge and retention cleanup retain the manifest directory through lock acquisition, payload removal, metadata replacement and lock release. A directory replacement refuses acknowledgement without deleting or writing through the replacement. Restoring the original control directory permits a retry to reconcile a payload already removed by that purge.

Identical in-flight listings share one filesystem scan; a caller's abort only cancels that caller, and the underlying scan stops when its last waiter leaves.

The exported `LocalUserDocFs` engine carries the same filesystem operations without a Cordis `Context`, so a non-runtime host — the Gateway's local document broker — serves the identical behavior against an authorized scope root.

The engine accepts an optional `controlRoot` outside the public tree for upload manifests and private file data. It must be a disjoint real directory on the document filesystem with a provider-owned private parent. Gateway-managed identity mode additionally supplies a private `stateRoot` for SQLite metadata and mutation locks. The Gateway registers all three roots before writing and grants its runtime account access only to ordinary published files. Standalone mode keeps hidden control directories below its public root.

A host can supply `backgroundWrite` for initialization, read-driven identity changes, interrupted-operation recovery, delivery acknowledgement, upload finalization and cleanup. Admission retains its writer until durable completion. Refusal preserves the identity journal and resumable uploads. Unchanged initialized reads remain available during maintenance; observations requiring persistence fail until admission reopens. Explicit mutating requests also require their caller-owned writer span.

Engine disposal closes admission, cancels ordinary saves, chunk-body reads and scans, and waits for every accepted operation before stopping upload finalizers. Repeated disposal joins the same task. An `openRead` stream transfers to its caller, who must consume or cancel it; engine disposal does not close that independently owned download. Independent operation and file-close failures remain available together in the error cause.

`mediaType` is derived from the stored file extension. Text, Markdown, CSV, JSON, YAML, XML, common source files, images, PDF, and Office extensions receive presentation types; an unrecognized extension records `application/octet-stream`. It is presentation metadata: nothing here parses content or refuses an unknown format.

Managed directory rename first captures the selected directory in private same-filesystem storage, verifies its directory object and complete authorized file inventory, then records capture before exclusive destination publication. A substituted source is restored exclusively and refused. An occupied source prevents rollback; private bytes, the journal and both errors remain available. Recovery retries namespace synchronization and preserves uncertain copies. Settled markers moved by an ordinary editor are reclaimed only through their retained private anchors, including during reads and scans. An already opened writable file can still be edited during a rename; private capture does not revoke existing file descriptors.

Published-directory recovery verifies the recorded directory object and settles its admitted path changes; ordinary atomic saves, additions, deletions and child moves reconcile independently on observation. A replacement receives a new unattributed incarnation, while the original creator and rename initiator remain on their original records. Legacy intents without directory-object evidence keep complete-inventory verification.

External file moves reconcile against a complete root inventory before retiring missing identities. A unique retained-object match keeps its incarnation and creator despite reuse of its former name; address exchanges commit their metadata and delivery records together. Additional or ambiguous hard links do not acquire another address's creator. Point and directory reads reconcile the root when they encounter an unknown or replaced object. A changed observed object refuses that scan and preserves identity evidence for retry.

Private SQLite schema 4 migrates schemas 2 and 3 on writable open after their original storage bindings pass verification. Backup verification reads them without modifying their bytes; restore validates every retained version before migration. Directory capture retains its [recovery rules](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/document-directory-capture/guide.md). On macOS, retained descriptors supply persistent filesystem UUIDs for document, retained-object and metadata bindings. An unchanged UUID and directory inode permit normalization of remounted device numbers throughout records, pending mutations and delivery data, preserving logical ids, revisions, actors and cursor positions. In-process path checks continue to use current device/inode pairs; copied roots and changed UUIDs remain refused. Hosts without a persistent UUID retain strict device/inode checks.

Legacy bindings acquire UUIDs only while their original device/inode evidence still agrees. Offline `recoverDocumentIdentityMount` requires an independent pre-remount verified snapshot, original directory/database/file inodes and matching retained document versions and digests; it preserves later permanent-deletion history and incomplete uploads. Changed or uncovered current versions require a complete compatible restore. Keep every writer stopped and the scope unavailable through a failed recovery and its verified retry. See the [volume-identity upgrade guide](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/document-volume-identity/guide.md).

The identity engine retains Linux parent descriptors during evidence reads, capture, publication and detachment. Managed backup verification requires complete file digests and original kernel witnesses. Restore preserves logical ids, creator and delivery positions while rebuilding retained document and directory-marker hard links and rebinding directory and file objects; an ordinary file copy cannot authorize that rebind. Inconsistent evidence refuses restoration while deployment maintenance stays closed. See the [identity design](../../../.agents/notes/proposed/architecture/2026-10-25-document-incarnations-and-trash-actions.md).

## Summary

Use `dsh-userdoc-local` as the local `userDocs` backend that stores documents as ordinary files below one configured root. Uploads stream to a sibling `.part` file and publish atomically through an exclusive hard link, so an occupied target is never replaced; untrusted client names are sanitized and collisions receive a ` (2)` suffix. The default deployment migrates a legacy `uploads` tree on first use. An explicit `maxFileBytes` enforces a finite deployment policy.

## Table of Contents

- [Resumable uploads](#resumable-uploads)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="resumable-uploads"></a>
## Resumable uploads

The local provider implements the `resumable-v1` upload session used by the Web client. It accepts one request-sized chunk at a time, verifies each chunk with SHA-256, persists a private manifest and partial file below `.upload-sessions/v1/`, and publishes the final file only after a complete SHA-256 verification. A session survives a runtime restart and remains resumable for the configured 24-hour default retention; expired receiving sessions and terminal records are removed automatically. The default chunk size is 8 MiB, safely below the public Cloudflare request-body limit, and all upload safety values are configurable through the provider config.

Incomplete actor-bound sessions persist format version 2 manifests with a required owner; version 1 remains ownerless. Completed publications carrying `UserDocRef.identity` use format version 3 and retain that metadata on status reads and restart. Version 3 requires a complete reference and matching received-byte count; it preserves the original owner when present. The directory layout and public `resumable-v1` protocol are unchanged. Ownership is checked before expiry cleanup or finalizer cancellation. Fingerprint reuse requires the same actor, and admission reserves distinct names for active uploads while preserving one root-wide concurrency and disk-space budget. Cancelled, failed and expired sessions release their name reservations.

Authenticated compositions cannot adopt ownerless sessions. Their temporary files remain subject to normal retention; restart the upload with a new fingerprint or wait for the old reservation to expire when capacity is full. Older providers reject version 2 or 3 manifests. Upgrade and recovery rules are in the [document upload guide](../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/document-upload-actors/guide.md).

Accepted `verifying` work keeps its bytes, target-name reservation and concurrency slot until completion, failure or authenticated cancellation, independently of the receiving-session deadline or the process that runs cleanup. Status and fingerprint resume remain available, and startup resumes retained verification after a process stop. Cleanup removes only expired receiving or terminal sessions whose valid manifests prove expiry. Unknown, corrupt or oversized manifests fail the sweep without deleting their metadata or partial bytes; missing manifests leave their partial bytes in place. Recovery requires a compatible reader or restoration of the original manifest. All cleanup workers settle before admission is released, and independent failures are retained together.

Only regular files can be opened as documents. Directories, links and POSIX named pipes are refused. POSIX reads acquire nonblocking descriptors and recheck their type, so replacing a regular file with a pipe during opening cannot leave the operation waiting for a peer.

Both ordinary saves and resumable chunks retry partial filesystem writes until every byte is stored. A zero-progress or interrupted write fails without publishing a file or acknowledging the incomplete chunk; a resumable retry overwrites its unacknowledged prefix. Cancellation retains its original reason.

`uploadManifestMaxBytes` bounds every manifest read (256 KiB by default). `uploadMaxConcurrent` bounds both expired-session cleanup and finalization workers; queued finalizations are cancelled when the store stops or an upload is cancelled. `uploadCleanupIntervalMs` is capped at Node's maximum timer delay (`2,147,483,647` ms), so an invalid interval cannot be clamped into a busy one-millisecond loop.

The provider records the admission lock owner as a PID in `.admission.lock`. Startup recovers it only when the process probe proves the owner has exited. Concurrent recoverers use a separate recovery lock and re-read ownership before removing the orphan, preserving a replacement writer's lock. Live, malformed or indeterminate owners are not reclaimed. An interrupted recovery's coordination lock requires operator verification; ordinary upload contention retains its 30-second deadline.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the host prompt-assembly consumer, which owns every model-visible rendering decision for stored files.

#### KV Cache effect

No direct invalidation; the consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Managed launches with `DSH_MANAGED_DATA_MANIFEST` register the resolved document root and optional legacy upload root before data writes. An invalid inventory refuses initialization; [inventory and backup rules](../../util/managed-data/README.md) govern retained roots and deployment approval.
- **No business storage quota** — the default has no per-document or per-user byte quota. The provider still protects the host with a configurable minimum free-space reserve, concurrent-session limit, and cleanup of abandoned upload sessions.
- **Completed-document retention is explicit** — active documents live until deleted; trashed documents are recoverable only for `trashRetentionDays`, after which the provider purges them. Session records, including completed-state metadata, are temporary and are cleaned after the configured upload retention.
- **`list` walks the tree on every call** — there is no index, so a root holding many thousands of files pays a full scan per listing.
- **Folder deletion is empty-only** — removing a tree requires moving or deleting its contents first; no recursive delete operation is exposed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
