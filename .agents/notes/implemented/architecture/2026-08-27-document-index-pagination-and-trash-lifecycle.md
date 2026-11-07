# Agent Note: Document index pagination and recoverable trash

Status: implemented

English | [中文](2026-08-27-document-index-pagination-and-trash-lifecycle.zh.md)

## Problem

Large document workspaces made a complete runtime scan and browser-side filtering expensive. Deletion also had no durable recovery window: a file removed from a runtime could disappear before an administrator or user corrected the mistake, and the organization catalog could not distinguish recoverable removal from permanent cleanup.

## Decision

The user-document service exposes bounded directory and trash pages with validated filters, stable ordering, and opaque continuation cursors. The Host and Gateway forward page parameters and never expose runtime paths; the Web manager uses cursor pages when a provider advertises them and keeps a local fallback for older providers. Already fetched pages remain available while the manager stays mounted, and changing a filter starts a new cursor chain.

Transfer planning groups validated source document ids by their parent directory and reads bounded pages for each group. Cursors belong to one directory; the scan budget belongs to the whole plan. Matching uses complete document ids and returns the selection's original order. The request's destination directory does not select source metadata. Recursive unpaged listings cannot substitute for these directory pages without making planning work grow with unrelated folders.

Deletion retains the selected regular file in provider-owned trash. Standalone storage uses a versioned path manifest; managed Gateway storage uses an independent publication id, revision and trash-action id in private SQLite metadata. Restore selects an available target without overwriting another file; purge is explicit or follows retention expiry. Every mutation requires current scope authority, and managed mutations also carry the exact catalog-approved selection.

A retained entry proves removal only of its own publication. Managed scopes may retain several trash actions and a replacement at one address; restore and purge select the exact action, and stale active selections refuse a replacement. The path-only standalone provider instead returns `DOCUMENT_TRASH_CONFLICT` when an active replacement shares a retained path. Browser row identity and lifecycle requests preserve these distinctions.

The standalone manifest is one complete recovery record. Unknown versions, malformed records, duplicate document ids or hidden-file paths, and invalid paths refuse reads and mutations before any document is moved or deleted. A missing manifest is empty only when its directory contains no hidden document files. Refusal preserves metadata and bytes for restoration from a complete backup.

Restore selects an available name, then publishes through an exclusive hard link. A writer occupying that name after selection causes `DOCUMENT_RESTORE_CONFLICT` without replacing its file or consuming the trash entry. Failures after linking attempt to restore the hidden link before deleting the visible copy; rollback refuses an unrelated hidden inode and retains both causes if it cannot complete. Remaining copies require recovery after such a combined failure.

Local retention scans identify candidates only. Each deletion rereads the manifest under its writer lock and requires the same document id, hidden file and an expired current deadline. Restoration, replacement or renewal during the wait skips the entry without increasing the count. The lock is released between candidates.

The PostgreSQL catalog mirrors the lifecycle with `active`, `trash`, `purged`, and `missing` states, retention timestamps, actor fields, and append-only `restored`/`purged` history. Existing `deleted` rows migrate to `trash` with the default 30-day deadline. Protected legacy-trash import retires matching path-only trash rows as missing while retaining their history and the imported action. Ownership transfer applies only to active project documents; the inspection index distinguishes missing files from permanently purged history. Administrator APIs provide cursor listing and single or batch trash, restore, and purge actions; runtime bytes are changed before the catalog transition when the Gateway broker is available.

Runtime-list reconciliation, identity-journal projection and batch removal lock existing affected catalog rows in UUID order before updates can acquire the organization's access-revision row. This prevents a multi-row mutation from retaining that revision while waiting for a lifecycle writer's document. Replacement and batch removal change only active rows from their locked initial catalog snapshot; a registration committed while that snapshot waits remains available for the next reconciliation. Permanent purge remains authoritative after a row wait.

Catalog writes test their required source state in the updating statement and append history only for changed rows. Stale revisions cannot reactivate terminal history or hide a newer active publication. Copy recording locks its exact target incarnation and updates lineage without replacing its current owner, path or lifecycle; an ambiguous path-only target is refused. Source download headers bind the opened incarnation independently of later source path reuse.

Member synchronization, trash and purge transactions recheck current organization, account, membership and project write authority after catalog and history statements settle. A revocation committed during their row waits refuses the transaction and rolls back metadata, history and operation records. Administrator lifecycle actions similarly recheck active administrator membership after selecting the locked document and before commit. Ownership transfer requires an eligible current administrator or project owner and an active recipient with current project membership, checked after the document wait and again before commit. Steward project authority follows the [administrator-plus-qualification rule](../feature/2026-10-10-steward-admin-layered-admission.md); archived projects are absent from member-facing metadata rows, totals and metrics. The independent administrator inspection index retains organization-wide audit records.

Migration 018 qualifies document-catalog user foreign keys with `organization_id`, including ownership, operation actors, and history actors, so imported UUIDs cannot cross organization ownership or audit records. It also adds active modified-time and trigram indexes used by the SQL-level overview filters and pages.

The Gateway keeps authoritative identity and delivery journals outside runtime-writable roots. A mutation retains its original initiator independently of the immutable creator and current catalog owner. Protected journal prefixes and PostgreSQL receiver cursors support retry after interruption; runtime metadata notifications cannot supply ownership or lifecycle facts. Read-driven observations, recovery and acknowledgement require maintenance admission, while unchanged initialized reads remain available. Standalone advisory catalog callbacks still lack a durable receipt.

Gateway deployment inventory retains public, metadata and private object roots before data writes. Backup verification proves committed file versions against original kernel witnesses and digests. Restore rebuilds hard links and rebinds new kernel objects while preserving logical ids, creator and delivery positions; copying old inode numbers cannot authorize restoration. Identified project files without creator evidence retain unknown ownership until an explicit assignment.

Persistent macOS bindings pair descriptor-derived filesystem UUIDs with original directory inodes. Device numbers remain live-process witnesses and may change after remount. Schema 4 normalizes a proven volume's device numbers in records, pending operations and delivery data under one metadata transaction; inodes, logical identities, actors and cursor positions remain fixed. Domain marker version 2 independently binds metadata roots and the database file. Legacy evidence acquires UUIDs only while its original kernel witnesses still agree. Offline recovery requires an independently verified pre-remount backup and matching original directory/database/file inodes, retained versions and digests. It preserves later purged history and partial uploads instead of rolling the database back. Known UUIDs cannot change through mount recovery; full verified restore may bind another volume.

Legacy startup verifies original storage bindings before schema migration. Full restore validates complete retained-file evidence before migration; rejected copied roots and incomplete backups retain their metadata bytes.

Directory rename uses native no-replace operations through a per-operation Koffi library owner. POSIX opens each parent relative to its retained predecessor and renames through those descriptors; Windows opens parents without delete sharing and uses a write-through move. The exclusive syscall preserves a destination created after validation, including an empty directory. Namespace synchronization precedes identity commit. Recovery retries that synchronization after an interrupted native move, and retains the journal after any completed rename instead of cancelling it as unused. Parent replacement refuses acknowledgement and preserves retained evidence; ambiguous copies are never overwritten by rollback. Identity and inventory conflicts cross HTTP as `DOCUMENT_TARGET_CONFLICT` rather than a service outage.

One-shot identity saves carry caller cancellation into publication after staging and check it after acquiring the root and preparing runtime file access. A cancelled pre-publication callback leaves no public file and removes its staging file. Buffered identity reads share the body consumer used by writes: a cancelled pending read rejects after source cancellation, with independent cleanup failure preserved alongside the cancellation cause.

## Alternatives considered

**Keep complete listings and page only in the browser.** Rejected for providers that support the page contract because the response size and metadata work grow with the workspace; it remains the compatibility fallback for older providers.

**Delete files immediately and retain catalog metadata only.** Rejected because metadata cannot restore bytes after an accidental removal. The provider trash owns the bytes until the deadline, while the catalog remains an audit projection.

**Let administrators mutate catalog state without contacting the runtime.** Rejected because the UI would report recovery while the file stayed deleted, or report purge while bytes remained readable. The Gateway broker performs the runtime operation first and the catalog records the result.

**Read state or expiry before an unconditional update.** A row wait can outlive a restore, purge, or renewed retention deadline. The update must evaluate current state and expiry; an earlier scan only identifies candidates.

**Authorize only before waiting for a document.** Committed account, membership, role or qualification changes can invalidate that decision. Fresh statements after pending catalog writes provide current admission without adding policy locks that could reverse the document/access-revision lock order. This protects the database transaction; an already completed filesystem action remains outside its rollback.

**Discard unrecognized manifest records and continue.** A later write would commit the incomplete recovery set and lose the discarded files' restoration metadata. Validation therefore refuses the entire manifest.

**Ignore device numbers whenever inodes match.** A copied filesystem can reuse those numbers. Persistent UUIDs prove future remounts; older bindings require independent backup evidence and explicit offline recovery. Raw path checks remain necessary throughout an active request.

**Rename onto a previously free restore target.** Another upload can occupy that target after the lookup. Exclusive publication enforces the no-replacement rule at the actual filesystem mutation.

## Consequences

Document list and search traffic is bounded by the requested page for current folders and all-scope metadata. Cursors are tied to one query chain and cannot be reused as a filesystem path. Providers without an index may still scan the selected directory to produce a page, but repeated in-flight reads are coalesced and recursive prompt listing remains a separate operation.

Trash consumes storage during its retention window and requires a maintenance sweep. A runtime or catalog outage can leave a pending reconciliation, so user-facing failures remain retryable and administrator actions report per-row results. Permanent purge removes the provider bytes and preserves catalog history without making the document readable again.

## Verification

Durable-input cases refuse damaged manifests across listing, trash, restore, purge, and retention cleanup while preserving metadata and both active and hidden bytes. A runnable Loader example refuses unknown metadata, restores its original manifest, and recovers the original file through the loaded service.

A deterministic publication barrier creates a concurrent upload after target selection. The loaded service refuses the collision, preserves both files and restores under a suffix on retry. Failure cases retain recoverability after hidden-file removal or manifest commit errors and preserve remaining copies and both causes when rollback fails.

Local retention barriers cover replacement, restoration and renewal during writer admission. The old build deletes newly trashed replacement bytes in the loaded-service replay. Current replay preserves those bytes, and ordinary expiry cases count each removal once while retaining future entries.

Local provider tests cover manifest persistence, restore collisions, idempotent purge, and restart recovery. Host and Gateway tests cover bounded pages, path-free metadata, inline preview responses, scope authorization, stream forwarding, and lifecycle error mapping. Client tests cover cursor navigation, filter reset, mounted-page reuse, trash recovery, and mobile controls. PostgreSQL migration and catalog integration tests cover state conversion, retention columns, indexes, and audit history when `HGW_TEST_DATABASE_URL` is configured.

The managed mount Loader transcript boots the real Gateway transport and provider, preserves document identity and actor-owned partial progress across remount and verified legacy recovery, and refuses copied roots and foreign upload resumption. Native volume reads match an independent macOS volume query and retain their descriptor across path replacement. SQLite cases cover prepared, retained and committed normalization, independent snapshot refusal, changed bytes, new versions and interrupted recovery. Cold-domain backup verification leaves immutable metadata unchanged; verified restore can bind a different volume. An isolated Ubuntu x64 build, native tests and installed-package verification exercise UUID absence under glibc; musl payloads compile and pass package checks without a musl execution claim. The Windows platform matrix remains separate.

Directory barriers create an empty destination after final inventory validation and replace source or target parents after their final stat. macOS and real Linux Node 22/24 replays preserve foreign bytes and the selected data. A Loader transcript verifies the standalone collision code and successful retry; a real HTTP request projects an invalidated inventory as a 409 conflict. A directory-sync interruption retains the moved journal, refuses an unsynced recovery commit and completes after synchronization succeeds. These observations do not establish the unexecuted Windows platform matrix or scope-removal lifetime behavior.

Real PostgreSQL row barriers cover a renewed retention deadline and concurrent delete, replacement, purge, and copy recording. The original implementation violates all five expected results. The admin HTTP handler projects the committed lifecycle and history into keyless expected outputs. Additional cases verify key-share compatibility, successful expiry cleanup, and repeated lifecycle calls without duplicate history. These cases verify catalog transactions; they do not establish atomicity across a filesystem operation and its later catalog callback.

The replacement barrier also registers a new document while reconciliation waits. Its HTTP lifecycle transcript retains the committed purge and the concurrent registration. An authenticated runtime HTTP batch removal similarly overlaps a single-document lifecycle transaction and a new registration. A heap-scan plan pins the conflicting document order; the unguarded batch returns 503 with a PostgreSQL deadlock. Both current writers commit and preserve the concurrent registration by acquiring catalog rows before invalidating updates and updating only the selected ids.

Real PostgreSQL barriers revoke account, membership, organization, write mode, administrator role, ownership-recipient eligibility and Steward qualification while document mutations wait. Refused transactions preserve catalog state and history. Authenticated HTTP transcripts cover a demoted administrator's queued trash action and member metadata across Steward grant, revocation, role downgrade and project archival. Qualified administrators without project member rows and eligible ownership transfers remain admitted.
