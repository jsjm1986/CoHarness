# @deepseek-ai/dsh-storage-json

English | [中文](README.zh.md)

JSON backend for the [storage hub](../storage/README.md): human-readable JSON under a configured root, registered as backend `json`. The domain spec selects the layout: `single` keeps one complete `<unit>.json` file per unit; `per-record` keeps one version-stamped document per record at `<unit>/<table>/<key>.json` plus a `global.json`. Design: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

## Summary

`dsh-storage-json` stores domain data as readable JSON under a configured root and registers as backend `json`. Its default `single` layout keeps one complete `<unit>.json` file per unit; its `per-record` layout keeps one version-stamped document per record. Both layouts publish each changed file atomically, while the domain layer orders calls. Choose it when operators need inspectable files and the selected layout fits the write volume; choose SQLite for larger or highly concurrent data. The backend is host-side only and contributes no prompt, tool, or schema.

## Model

- In the `single` layout the in-memory unit state is authoritative; every write primitive republishes the whole file via temp-write + fsync + atomic `rename()` replace. A unit file is always the complete current net state — legibility is this backend's reason to exist; scale is the SQLite backend's job. In `per-record` the directory tree is authoritative: each `put`/`delete` rewrites one document and `loadAll()` rereads the tree, so one write never touches sibling records.
- A missing `single` file or `per-record` directory opens as an empty unit and materializes on the first write. A foreign or unparsable `single` file rejects with `malformed-medium`; a stored version differing from the descriptor rejects with `version-mismatch` (no migration, pre-release stance). In `per-record`, a malformed, unreadable, or out-of-version-set document reads as an absent record instead — one bad document never bricks the unit — and `backupRecord` moves a record's document aside as `<key>.json.bak.<stamp>` for the domain's `backup-and-skip` policy.
- `per-record` reads accept documents stamped with the current version or a declared `compatibleVersions` entry; writes always stamp the current version. An empty per-record tree bootstraps once from a legacy whole-unit `<unit>.json` only when that file's unit name matches and its version is in the accepted set; any existing document in the tree suppresses the bootstrap.
- `per-record` record keys must match `[a-zA-Z0-9_-]+` (a key becomes a path segment); an unsafe key rejects before any file operation. `single` keys stay opaque.
- Write ordering across calls belongs to the caller (the domain layer's write chain); the rename commits each call's content atomically, and the post-commit directory fsync is best-effort — a failure there weakens crash durability without rejecting the write.

## Config

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `root` | string | required — no default (a cwd fallback would scatter files) | Directory holding unit files; created `0o700` on demand |

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- Windows durability relies on libuv's `rename()` (`MoveFileExW` with replacement) without an explicit write-through flag; the session-log backend's stricter Win32 write-through publish helper is planned to move down here when the append-log facet lands (see the Agent Note's migration section).
- No cross-process write locking: two processes writing the same root can interleave whole-file replacements (last write wins). Single-host-process deployments are the current consumer; the multi-process story is deferred per the Agent Note's out-of-scope table.

## Invariants

**Runtime invariant:** No companion is published. The backend maps each domain spec onto files under one root; layout and versioning are asserted by backend specs and no second store exists.
