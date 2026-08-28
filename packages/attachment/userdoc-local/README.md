# @deepseek-ai/dsh-userdoc-local

English | [中文](README.zh.md)

Local `userDocs` backend that stores documents as ordinary files below one configured root, `<home>/documents` by default. The default deployment migrates the sibling `<home>/uploads` tree on the first storage operation: an absent `documents` root is replaced directly, while an existing root is merged without overwriting and collisions receive the same ` (2)` suffix used by uploads. A custom root is not paired with a legacy root unless `legacyUploadRoot` is configured.

Writes are two steps. `resolveTarget` validates the destination directory, sanitizes the untrusted client name — both separator styles stripped by hand, control characters removed, byte-truncated to 255, dot-only names refused — then picks the first free leaf, suffixing ` (2)` before the extension and failing with `DOCUMENT_NAME_EXHAUSTED` past a thousand collisions. `save` streams to a sibling `.part` file opened `O_CREAT | O_EXCL`, counts bytes as they arrive, fsyncs, and publishes through an exclusive hard link so an occupied target is never replaced. The default configuration has no per-document byte limit; an explicit `maxFileBytes` still enforces a finite deployment policy. Every failure path removes the partial file.

Reads take the store-scoped `docId` — the root-relative path with forward slashes — never a caller's copy of `UserDocRef.path`. Each read re-derives the path and proves both lexical and real-path containment, so traversal and a directory symlink outside the root are rejected. `list` recursively returns every regular document; `listDirectory` returns immediate folders and files; `listDirectoryPage` and `listTrashPage` provide bounded filtered pages; `listDirectories` enumerates move destinations. Folder create and rename accept one sanitized leaf, deletion requires an empty non-root folder, and `move` never replaces an existing destination. `openRead` streams downloads, and `remove` treats an already-absent file as success. `trash`, `restore`, and `purge` move documents through a private manifest and hidden file, with `trashRetentionDays` (30 days by default) controlling automatic expiry; restore recreates a missing original directory and uses the normal non-overwriting target policy.

Identical in-flight listings share one filesystem scan; a caller's abort only cancels that caller, and the underlying scan stops when its last waiter leaves.

`mediaType` is derived from the stored file extension. Text, Markdown, CSV, JSON, YAML, XML, common source files, images, PDF, and Office extensions receive presentation types; an unrecognized extension records `application/octet-stream`. It is presentation metadata: nothing here parses content or refuses an unknown format.

## Resumable uploads

The local provider implements the `resumable-v1` upload session used by the Web client. It accepts one request-sized chunk at a time, verifies each chunk with SHA-256, persists a private manifest and partial file below `.upload-sessions/v1/`, and publishes the final file only after a complete SHA-256 verification. A session survives a runtime restart and remains resumable for the configured 24-hour default retention; expired session records and their temporary bytes are removed automatically. The default chunk size is 8 MiB, safely below the public Cloudflare request-body limit, and all upload safety values are configurable through the provider config.

`uploadManifestMaxBytes` bounds every manifest read (256 KiB by default). `uploadMaxConcurrent` bounds both expired-session cleanup and finalization workers; queued finalizations are cancelled when the store stops or an upload is cancelled. `uploadCleanupIntervalMs` is capped at Node's maximum timer delay (`2,147,483,647` ms), so an invalid interval cannot be clamped into a busy one-millisecond loop.

## Model Experience

Indirectly, through the host prompt-assembly consumer that turns a stored reference into inlined text or a path the agent reads with its ordinary tools.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No business storage quota** — the default has no per-document or per-user byte quota. The provider still protects the host with a configurable minimum free-space reserve, concurrent-session limit, and cleanup of abandoned upload sessions.
- **Completed-document retention is explicit** — active documents live until deleted; trashed documents are recoverable only for `trashRetentionDays`, after which the provider purges them. Session records, including completed-state metadata, are temporary and are cleaned after the configured upload retention.
- **`list` walks the tree on every call** — there is no index, so a root holding many thousands of files pays a full scan per listing.
- **Folder deletion is empty-only** — removing a tree requires moving or deleting its contents first; no recursive delete operation is exposed.
