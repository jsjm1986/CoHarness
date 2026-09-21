# @deepseek-ai/dsh-spill-local

English | [中文](README.zh.md)

The **local-filesystem** implementation of the [`@deepseek-ai/dsh-spill`](../spill) storage seam. Registers as `ctx.spillStore` and persists a tool's oversized text to a private, session-scoped file; its locator is the file path and its retrieval hint tells the model to use `read` or `grep` on that path.

## Summary

`dsh-spill-local` saves a caller's oversized text to a private, session-scoped file on the host filesystem and returns that file's path as the locator, with retrieval guidance telling the model to read or grep it. Mount it whenever a composition needs spill storage on the same machine the agent runs on. Files are private to the current user, names are unpredictable, and each session's files group under a stable directory, so a shared root cannot leak output or be redirected by a planted symlink. Configuration selects the root and the startup-cleanup retention period; previews and spill decisions live in other packages.

## Storage layout

Files land at `<root>/session-<hash>/​<random>-<safeName>`:

- **`root`** — the config `root` (resolved to absolute), or a lazily-created private (0700) per-process directory under the OS temp dir when omitted. A predictable, world-readable root would let other local users read spilled tool output or plant symlinks.
- **`session-<hash>`** — a short `sha256(sessionId)` prefix, so a session's spill files group together and a future cleanup can drop them per session.
- **`<random>-<safeName>`** — an unpredictable hex prefix (defeats symlink planting in a shared root) plus the caller's `suggestedName` sanitized to one safe path segment (traversal-proof; mirrors the JSONL persistence backend's `encodeSegment`). The write is exclusive + owner-only (`open(path, 'wx', 0o600)`): it fails on any pre-existing path, symlink or not, so a planted target cannot redirect it.

## Config

| Key | Default | Meaning |
|---|---|---|
| `root` | private 0700 temp dir | Root directory for spill files. Set to keep them under a known location. |
| `cleanupPeriodDays` | `30` | File age in days before the one-shot startup cleanup may delete it; `0` disables cleanup. |

`saveText` rejects on a real storage failure (permissions, ENOSPC); the spill policy treats a rejection as best-effort and keeps the inline result. See the seam README for the vocabulary and the [tool output spill Agent Note](../../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.md) for the design.

## Startup cleanup

One best-effort sweep starts after activation without delaying service availability. It scans the configured root and prior default `dsh-spill-*` roots under the OS temp directory, deletes regular files whose modification time is strictly older than the configured cutoff, prunes empty session directories, and removes only empty prior-default roots. A long-lived process does not sweep again until restart. Disposal waits for the sweep, and a concurrent write recreates a session directory if cleanup removes it.

The sweep resolves filesystem identities, never follows or deletes symlinks, and skips unrelated entries. On POSIX it admits only roots and session directories owned by the current user, not writable by group or others, and protected from replacement through their ancestor path; writable sticky temporary directories such as `/tmp` are permitted. Unsafe paths produce a warning and remain untouched. Filesystem and warning-sink failures are contained, so cleanup cannot fail activation or a concurrent spill write. The [startup cleanup Agent Note](../../../.agents/notes/implemented/feature/2026-09-14-spill-local-startup-cleanup.md) records the retention decision.

## Model Experience

Indirectly, through spill consumers, which render the saved file path and read/grep retrieval guidance to the model.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **No session-lifecycle deletion** — a spill file survives its session's end until the age-based startup sweep reclaims it, because persisted, resumed, and forked sessions may still reference a path; a process that never restarts never sweeps.
- **Locators require a co-located filesystem consumer** — a remote or virtual deployment needs another `SpillStore` backend whose locator and retrieval hint are meaningful there.
