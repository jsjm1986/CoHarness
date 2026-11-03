# Agent Note: Document private paths and staging names

Status: implemented

English | [中文](2026-10-26-document-private-paths-and-staging-names.zh.md)

## Problem

Hiding every `.part` leaf removes ordinary completed uploads from document listings. Exact maintenance-name checks also permit a case alias to reach private upload or trash data on a case-insensitive filesystem. Canonicalizing both a linked root and its child accepts the link's destination as the document root, permitting an ordinary read outside the configured real directory.

## Decision

The local provider reserves the writer's exact `.userdoc-<24 hexadecimal characters>.part` namespace. Other `.part` names remain ordinary documents. Target resolution treats a staging-name collision as occupied and chooses the normal numeric suffix; public document identifiers cannot select an internal staging leaf. New file and directory names strip trailing ASCII periods and spaces before and after byte truncation.

Root maintenance names are reserved across case and Win32 trailing-period/space aliases. Public directory validation additionally compares the selected first directory's device/inode with the actual maintenance directories, rejecting other filesystem spellings. Recursive and immediate listings apply the same exclusions. A document root must be a real directory, and public traversal rejects linked components. Internal finalization explicitly opens its validated private partial; the public read path exposes no such option. Upload startup, housekeeping, session locks and chunk writes validate the real root and private parents before filesystem effects. Private payload writes refuse linked leaves and compare the opened object with its selected source. Manifest readers refuse links and non-regular files, and lifecycle state must be a string rather than a coercible JSON value.

`LocalUserDocFs` accepts an optional `controlRoot` for upload and trash state. The configured directory must be real, disjoint from the public root and on the same filesystem; POSIX deployments require owner-only control and parent directories owned by the Gateway process account. Path containment checks allow sibling roots and reject either root nested below the other. Resumable publication authorizes the partial against the private root and the destination against the public root. Linux holds both parents until publication or rollback settles; a detected source or target parent change refuses completion while retaining the private partial. Ordinary saves acquire parent descriptors before staging creation and retain them through failure cleanup. Production Gateway composition still uses the default public-root layout.

Linux trash moves retain both parent descriptors and compare the moved file with the selected object before committing the manifest. Failed moves restore the source through an exclusive hard link before releasing the hidden copy. If another file occupies the source, both files remain and the error retains the operation and restoration failures.

Linux restore operations retain the private source and public destination parents until publication, hidden-link removal and rollback settle. Missing destination directories are created relative to pinned parents. A detected parent replacement removes the newly created empty directory and refuses restoration while preserving recoverable bytes.

Linux permanent purge and retention cleanup retain the manifest directory across locking, reads, payload removal, atomic metadata replacement and lock release. A detected replacement refuses acknowledgement; neither the outside payload nor outside metadata is changed. The retained lock path is released even after replacement, so restoring the original control directory permits an idempotent purge retry.

These checks retain the path-based lifecycle described by the [document lifecycle decision](2026-08-27-document-index-pagination-and-trash-lifecycle.md). Durable incarnations, independent trash actions and catalog ownership remain the [separate identity proposal](../../proposed/architecture/2026-10-25-document-incarnations-and-trash-actions.md).

## Alternatives considered

**Hide every `.part` filename.** The suffix is a valid user filename and does not establish provider ownership.

**Compare only normalized strings.** Windows can assign [short aliases to long filenames](https://learn.microsoft.com/windows/desktop/FileIO/naming-a-file); private-directory object checks do not depend on another spelling matching the long name.

**Rely on real-path containment alone.** A linked root changes the directory against which containment is checked. Root and component validation must precede public data reads.

## Consequences

Ordinary `.part` uploads remain available, while private data cannot be selected through the tested aliases or an already-linked document root. The Linux different-UID replay proves a configured private control root rejects reads, ignores a forged manifest placed in the public tree and publishes an authenticated upload from private storage. Engine tests retain that upload across restart, trash, restore and purge. Existing user-owned maintenance-name aliases and staging-pattern files require an explicit filesystem rename; data is not deleted by suffix. The [upgrade guide](../../../../docs/upgrade-guide/v0.2.1-rc.1.coharness.1/document-private-paths/guide.md) owns operator actions.

The real Loader scenarios pin upload visibility, staging-name suffixing, private file and directory refusals, malformed upload-state refusal, retained bytes and linked-root read/write refusals. Linux scenarios replace parents immediately before ordinary staging creation, trash movement, restore publication, missing-directory creation and permanent purge. Outside files remain untouched; upload and restore cases preserve owned data, and purge retries complete after the original control directory is restored. Native macOS negative controls return private or outside fixture bytes before the fix. A filesystem-metadata test models short-name identity; physical Windows alias behavior and non-Linux directory replacement remain outside that evidence. The host must protect the root and its ancestors from uncoordinated replacement during a request.
