# Agent Note: document workspace folders and migration

Status: implemented

English | [中文](2026-08-19-document-workspace-folders.zh.md)

## Problem

The real-file user-document store originally placed new uploads in date-named directories below `<home>/uploads`. That layout made uploads available to file tools, but it did not provide a stable, user-named document workspace, ordinary folder management, or a project-local documents directory. Changing the default root also risked either abandoning existing uploads or preserving two visible roots indefinitely.

## Decision

The local provider uses `<runtime HOME>/documents` as its default root. A personal runtime therefore stores documents below the user's private home, while a project runtime stores them below `<project path>/documents` because the project path is that runtime's home and working directory. New personal users receive the directory during gateway provisioning; the provider creates it lazily for existing users, standalone runtimes, and projects.

This decision extends [user-uploaded documents as real files](2026-08-14-user-uploaded-documents.md). The filesystem remains the index: folders are ordinary directories, documents are ordinary files, and the model continues to use the same filesystem and shell tools rather than a document-specific retrieval tool.

### Storage and migration

`LocalUserDocStore` initializes on the first storage operation. For the default root, it serializes migration with one in-process promise and an owner-recorded filesystem lock. If `<home>/uploads` is absent, initialization creates `documents`. If `documents` is absent, migration renames the complete `uploads` tree directly. If both exist, migration recursively merges them without replacing any entry; collisions receive the same bounded ` (2)` suffix as uploads. Unsupported legacy entries, overlapping roots, and symbolic legacy roots fail with `DOCUMENT_MIGRATION_FAILED`.

Successful migration removes the legacy root and leaves no compatibility symlink. Absolute paths recorded before migration may therefore stop resolving, while their files remain under the corresponding relative location in `documents`. This is an accepted pre-release on-disk change rather than a permanent two-root compatibility promise.

### Operations and ownership

`UserDocId` and `UserDocDirectoryId` are branded, POSIX-style paths relative to one document root; the empty directory id names that root. Providers re-derive lexical paths and prove real-path containment before reading or mutating entries. Directory symlinks are never followed into a listing, upload, move, or read.

`UserDocStore` exposes immediate directory listing, recursive destination listing, folder create/rename, empty-folder deletion, and document move in addition to its existing document operations. Moves publish without replacing an occupied name, and folder deletion never recurses. Renaming a directory or moving a document changes its root-relative id and absolute path, so older references may become stale exactly as they do when ordinary files are reorganized outside the UI.

The Host owns the `/api/documents` routes and stable error mapping. The browser manager owns breadcrumbs, folder commands, current-folder upload, and single or batch move. The gateway only provisions a new personal user's `documents` directory; project and standalone roots remain provider-owned so account management does not write into an external or read-only project before the runtime uses document storage.

## Verification

Local-provider tests pin direct migration, collision-preserving merge, concurrent in-process reuse, overlap and symlink rejection, traversal and directory-symlink containment, empty-only deletion, and no-replace moves. Host tests cover every folder route and the new error-code statuses. Component and keyless Web tests cover folder navigation, current-folder upload, create/rename/delete, single and batch move, and compact row geometry.

## Alternatives considered

**Keep `<home>/uploads` as the permanent root or leave a compatibility symlink.** Rejected because the product exposes a document workspace, not an upload staging area. Two names for one tree complicate containment and operator cleanup, while preserving old absolute paths would turn a pre-release implementation detail into a durable compatibility promise.

**Represent folders in sidecar metadata while keeping a flat filesystem.** Rejected because the agent's ordinary tools would see a different organization from the browser and metadata could drift from files changed outside the UI. Real directories keep one source of truth.

**Allow overwrite moves or recursive folder deletion.** Rejected because both operations can destroy documents through one mistaken target selection. Conflict and non-empty errors require users to resolve the affected entries explicitly.

## Consequences

Personal and project document scopes have predictable real paths and persist independently across conversations. Existing default uploads move into the new root on first use without duplicate storage, and collisions preserve both entries.

The first storage operation may block on migration and fails loud if the legacy tree cannot be represented safely. Moves and renames intentionally invalidate older path-based references, and users must empty a folder before deleting it. These costs preserve ordinary filesystem semantics, no-overwrite mutations, and one visible document root.
