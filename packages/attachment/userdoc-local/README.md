# @deepseek-ai/dsh-userdoc-local

English | [中文](README.zh.md)

Local `userDocs` backend that stores documents as ordinary files below one configured root, `<home>/documents` by default. The default deployment migrates the sibling `<home>/uploads` tree on the first storage operation: an absent `documents` root is replaced directly, while an existing root is merged without overwriting and collisions receive the same ` (2)` suffix used by uploads. A custom root is not paired with a legacy root unless `legacyUploadRoot` is configured.

Writes are two steps. `resolveTarget` validates the destination directory, sanitizes the untrusted client name — both separator styles stripped by hand, control characters removed, byte-truncated to 255, dot-only names refused — then picks the first free leaf, suffixing ` (2)` before the extension and failing with `DOCUMENT_NAME_EXHAUSTED` past a thousand collisions. `save` streams to a sibling `.part` file opened `O_CREAT | O_EXCL`, counts bytes as they arrive, fsyncs, and publishes through an exclusive hard link so an occupied target is never replaced. Every failure path removes the partial file.

Reads take the store-scoped `docId` — the root-relative path with forward slashes — never a caller's copy of `UserDocRef.path`. Each read re-derives the path and proves both lexical and real-path containment, so traversal and a directory symlink outside the root are rejected. `list` recursively returns every regular document; `listDirectory` returns immediate folders and files; `listDirectories` enumerates move destinations. Folder create and rename accept one sanitized leaf, deletion requires an empty non-root folder, and `move` never replaces an existing destination. `openRead` streams downloads, and `remove` treats an already-absent file as success.

`mediaType` is derived from the stored file extension, and an unrecognized extension records `application/octet-stream`. It is presentation metadata: nothing here parses content or refuses an unknown format.

## Model Experience

Indirectly, through the host prompt-assembly consumer that turns a stored reference into inlined text or a path the agent reads with its ordinary tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No per-user disk quota** — `maxFileBytes` bounds one upload and `maxMessageBytes` one message, but nothing bounds a root's total size, so a deployment that shares a disk between users needs a quota above this package.
- **Retention is manual** — stored documents live until a user deletes them; there is no expiry or garbage collection.
- **`list` walks the tree on every call** — there is no index, so a root holding many thousands of files pays a full scan per listing.
- **Folder deletion is empty-only** — removing a tree requires moving or deleting its contents first; no recursive delete operation is exposed.
