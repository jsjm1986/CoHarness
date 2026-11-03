# Agent Note: Document incarnations and trash actions

Status: proposed

English | [中文](2026-10-25-document-incarnations-and-trash-actions.zh.md)

## Problem

A document path currently identifies its active file, retained trash and catalog row. Reusing a purged path can hide a new file, and reusing a trashed path can preserve the earlier uploader as owner. A delayed completion or catalog callback cannot distinguish the earlier file from its replacement. Equal bytes do not establish that an upload published the file currently at its target.

## Proposal

Keep `UserDocId` as the ordinary relative file address. Allocate a durable `UserDocIncarnationId` for each publication and a distinct `UserDocTrashId` for each trash action. In-place edits and API moves preserve the incarnation; a new upload creates another incarnation even when its name and bytes match an earlier document. Every mutation and catalog update carries the expected incarnation and a monotonic revision.

The local provider owns a dedicated SQLite identity database. Gateway compositions keep authoritative metadata and mutation locks in a server-owned directory outside model-writable project and personal roots. File-object links remain on the document filesystem. The database records active, trash, purged and missing incarnations, the original creator, consumed trash ids and a single prepared filesystem mutation. An independent monotonic mutation sequence prevents an abandoned operation from committing a later retry. Directory rename commits every authorized path together and rejects an inventory changed since authorization.

Catalog delivery is a durable, ordered journal committed in the same transaction as document metadata. Each entry links its mutation sequence and within-mutation ordinal to the preceding delivery position. This permits bounded pages within a large directory change and detects a missing delivery record despite gaps left by abandoned mutation reservations. Pages bound both items and the complete serialized UTF-8 response. Oversized records fail without being discarded. A receiver binds the root id to its authorized scope, commits its catalog changes and cursor together, then acknowledges the delivered prefix. A failed acknowledgement retries from the receiver's validated cursor; an acknowledgement never authorizes skipping an unknown or future position.

The operation's authenticated initiator is retained independently of the original document creator. A later browser poll, recovery worker or delivery caller cannot supply another actor for the earlier mutation. Unknown actors remain unknown. Ownership transfer changes the catalog owner without replacing the immutable original creator.

One provider-owned filesystem lock covers recovery and file mutations across instances. A prepared record precedes ordinary-file changes. A private object link pins every active or recoverable incarnation, preventing inode reuse from impersonating it. Missing and purged incarnations release that link. Temporary mutation anchors retain exact source objects until metadata commit and physical cleanup finish; content hashes remain integrity checks. A linked marker identifies a moved directory across restart, and the metadata commit covers its complete authorized inventory. Recovery joins the recorded operation before admitting another mutation. It must preserve an unrelated replacement and every ambiguous remaining copy.

Ordinary-file reconciliation resolves unique retained-object matches across the complete root before releasing missing identities. A former address occupied by a replacement does not invalidate the original object at its new address. Address exchanges commit their metadata and linked deliveries atomically without physical file work or a new persisted intent format. Additional and ambiguous hard links remain unattributed; an exact unchanged address retains its existing identity. Unknown or replaced point reads also request root reconciliation. A changed observed object refuses the scan without retiring its retained identity, and completed-upload retries resolve the original incarnation's current address.

Directory admission checks selected file sizes and modification times as well as retained object identity. The [folder decision](../../implemented/feature/2026-08-19-document-workspace-folders.md) owns private directory capture, exclusive rollback and cancellation evidence. A request reports an invalidated selection; recovery settles a proven cancellation without repeating that request failure. A metadata commit failure retains publication evidence.

Resumable publication uses the upload's durable identity and authenticated original actor. Replaying a completed or purged incarnation cannot create another publication. The runtime HTTP consumer, Gateway broker/catalog, transfer and administrator operations, browser row keys, drafts and lifecycle requests migrate together. Delayed callbacks cannot overwrite a newer incarnation or revision. Ownership transfers remain catalog decisions; the original creator does not overwrite a later owner.

Import legacy trash without changing its bytes. Preserve old catalog history and every committed Session generation. When historical uploader evidence cannot distinguish an active replacement from an earlier path owner, leave the new incarnation's creator unknown and require an explicit ownership decision. Never infer an uploader from size, time or digest. Inspect serialized document prompt admission before changing any required durable field.

Production uses a root Gateway and separate systemd runtime accounts. Completed files must be accessible to their runtime account, while authenticated upload actors and delivery records must stay outside that account's writable directories. Giving a shared runtime ownership of upload manifests would let its model forge another participant's actor binding. The managed runtime therefore needs a Gateway-backed document service together with protected control storage; changing Unix ownership alone cannot complete this migration. Protected publication and retained object links also require a location on the document filesystem outside the runtime's writable mounts.

The [metadata journal](../../../../packages/attachment/userdoc-local/src/identity.ts), [delivery journal](../../../../packages/attachment/userdoc-local/src/projection.ts), [file executor](../../../../packages/attachment/userdoc-local/src/mutation.ts) and [connection owner](../../../../packages/attachment/userdoc-local/src/identity-fs.ts) serve the managed Gateway backend. Explicit disjoint roots separate public files, private metadata and same-filesystem retained objects. Private schema version 4 binds directory objects and the database file with persistent filesystem UUIDs where supported; Gateway inventory records every root before writing. Verified deployment restore checks digests and original witnesses, rebuilds hard links and rebinds new objects while preserving logical identity and delivery positions. The [lifecycle decision](../../implemented/architecture/2026-08-27-document-index-pagination-and-trash-lifecycle.md) owns the current managed and standalone behavior.

The [Gateway provider](../../../../packages/attachment/userdoc-gateway/README.md) separates captured execution references from interactive assertions and streams file bytes outside bounded metadata. The production receiver authenticates runtime tokens, resolves current participants and grants exact mutation selections. Runtime notifications trigger protected reconciliation rather than trusting supplied document facts. Its pending-request owner joins accepted calls; handed-off reads remain consumer-owned.

The runtime dispatcher classifies operations before maintenance admission and retains admitted mutations through response completion. Read-driven observations, interrupted recovery and delivery acknowledgement also retain a writer; unchanged initialized reads remain available. Standalone release checks cover package links, non-empty runtime entries and ordinary Node imports of the document protocol and server exports.

Linux file evidence, anchor capture, publication and detachment retain opened parent directory descriptors and preserve recovery links on refusal. Real runtime-account verification covers published-file access and denial of metadata, actor manifests and retained objects. Native exclusive directory moves retain their parents, preserve late destination collisions and retry interrupted namespace synchronization. Named macOS and Linux Node 22/24 barriers verify source and target parent replacement. Acceptance still requires further retained-root ownership checks and the remaining platform matrix; the proposal remains active for these obligations.

## Alternatives considered

**Reserve old names forever.** This prevents ordinary file reuse and leaves path identity unchanged.

**Use a content hash or inode as the document id.** Identical uploads are distinct documents, while an atomic editor save can replace an inode without transferring ownership.

**Keep only device/inode numbers.** The filesystem can reuse an inode after unlink. An active or recoverable incarnation needs a live object link; each completed purge or missing transition releases it. Keeping links for purged or missing history would retain bytes without a recoverability promise. [Node filesystem timestamps](https://nodejs.org/api/fs.html#stat-time-values) cannot substitute for a live object: birth time can fall back to change time or zero.

**Change only the catalog unique index.** Local trash selection and stale filesystem requests would still address the wrong file.

**Serialize callbacks in one process.** A promise queue cannot recover a lost callback after restart or order a runtime against the Gateway broker. Acknowledged durable positions permit retry without allowing a stale callback to reactivate another incarnation.

## Acceptance criteria

- Real personal and two-member project flows can retain multiple trash entries and an active replacement at one path. New uploaders own their new incarnations; permanent purge retains history without hiding replacements.
- Old trash ids, old authorization snapshots, delayed upload completions and delayed catalog callbacks cannot move, delete, restore, purge or reassign a replacement.
- File edits, moves, directory rename and restore to another name retain the intended identity. Directory authorization covers the exact current contents, including concurrent arrivals.
- Prepared filesystem work and committed cleanup recover across process stops, cancelled work and I/O failures without overwriting an unrelated file. Owner shutdown joins accepted work before closing its database.
- Source and built application compositions, actual PostgreSQL migration/catalog tests and browser flows verify physical bytes, identity, ownership and audit history together. Supported Node versions and platform semantics remain covered.
- Every public consumer uses the migrated identity and wire version. Legacy data and immutable Session generations are preserved; ambiguous historical ownership is explicit.
- Metadata and delivery append roll back together on failure. A delayed or repeated acknowledgement cannot delete undelivered work. Actual receiving-catalog tests prove root binding, transactional cursor advancement, retries and original-actor audit attribution.
- Managed backup/restore preserves logical identity and original ownership through verified snapshot evidence while rebinding new kernel objects. A file-by-file copy of old device/inode records is not a valid restore. Scope removal also closes the identity owner and accounts for its protected metadata in data retention.

## Risks

The metadata database introduces another durable provider-owned medium. Its lifecycle, backup, schema migration and recovery must be verified with the file store. A private-directory collision, unreadable metadata or unprovable recovery must preserve data and fail visibly. Case-insensitive path aliases require canonical filesystem addresses. Existing module tests alone cannot prove assembled authorization or filesystem/catalog consistency.

The receiving catalog cannot treat writable document-root metadata as authenticated authority merely because it parses. Managed filesystem and shell policy, publication identity and server-side actor evidence require review before activation, including whether a shared-project model can forge creator, initiator or delivery records.
