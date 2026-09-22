# @deepseek-ai/dsh-session-persistence-jsonl

English | [中文](README.zh.md)

The JSONL durable session-persistence backend — a concrete `SessionPersistence` (the `dsh-session-persistence` seam). Each session has one append-only logical JSONL log, stored as `.jsonl.zstd` by default or raw `.jsonl` when compression is disabled.

## Summary

`dsh-session-persistence-jsonl` stores each session in a current append-only JSONL log and retains immutable historical format generations — checksummed Zstandard frames by default, raw newline-delimited lines when compression is disabled. It serves the current logical `SessionEvent` stream through persistence handles, so format migration, compression, historical decoding, and crash recovery remain storage-internal details. Choose it when consumers need a per-session file on disk; the logs are readable as plain lines when `compression: 'none'` is selected. A root directory is the one required configuration; durability, lazy materialization, [supported historical-format migration](../session-format-catalog/README.md), and torn-tail crash recovery come with the backend.

## On-disk layout

```
<root>/
  --<normalized-cwd>--/          # readable project directory (or _no-cwd/)
    <encoded-id>/                # session-owned directory
      session.v4.jsonl.zstd      # default: checksummed header frame + append frames
      session.v4.jsonl           # only with compression: 'none'
```

- The current artifact is `session.v4.jsonl.zstd` or `session.v4.jsonl`; older committed generations retain their versioned names. Its first logical line is a header tagged `{ type: 'session', version: 4, id, cwd?, createdAt, parentSession?, isSeeded, origin?, delegationDepth, agentPreset?, draft? }`. `isSeeded` is explicit; the inherited prefix length is carried by the inherited `session/end-seed` marker. `delegationDepth` is required on disk and is `0` for a top-level Session. The optional `draft` field accepts only a boolean and retains both explicit values through listing, inspection, and cold reads; omission stays absent. Unknown header fields remain invalid. `agentPreset` is durable because it determines the resumed tools and prompt. Each subsequent current-format line stores one settled Session event, including its nested Assistant stream data, with contiguous event sequences.
- A storage record is one `SessionEvent` JSON verbatim. Released v0/v1 artifacts may instead contain **packed chunk rows** (`text-chunks` / `reasoning-chunks` / `tool-call-chunks`; bare slash-less tags like the header's `session`): one line holding a run of ≥3 consecutive same-block `assistant/chunk` delta events, `seq0`/`time0` plus per-member `dt` gaps reconstructing every member's `seq`/`time` exactly. The lossless codec lives in `@deepseek-ai/dsh-session` (`packChunkRuns`/`decodeStorageRecord`); the current writer never packs — packed rows reach this backend only inside the historical generations its catalog decodes, which load identically to unpacked rows.
- Surface `sourceEventSeqs` arrays use lossless inclusive ranges for profitable consecutive runs; readers accept both range and legacy number-array forms.
- The project directory keeps the normalized cwd readable for navigation and is bounded for filesystem component limits. Separator replacement and truncation are intentionally lossy, so cwd strings that normalize alike share a project directory; session ids still select distinct session directories. On a case-insensitive filesystem, identity validation accepts an alternate path spelling only when filesystem canonicalization resolves both spellings to the same transcript. The configured root remains deployment-controlled: it may be project-local, shared, temporary, or centralized. The [project-session directory decision](../../../.agents/notes/implemented/architecture/2026-07-24-project-session-directories.md) records this tradeoff.
- Session ids are unvalidated branded strings, so they are injectively escaped to a single safe path segment before use (no traversal, no collision). The resulting directory is reserved for additional session-owned artifacts; discovery reads only the fixed transcript filename.

## Config

| Key | Type | Notes |
|---|---|---|
| `root` | `string` (required) | Root directory for all session files. **No default** — a `process.cwd()` default would scatter files as the process's cwd changes (bash calls, subprocesses). An existing root must be a readable directory; an absent root is created on first materialization. |
| `compression` | `'zstd' \| 'none'` | Defaults to `'zstd'`; `'none'` retains newline-delimited UTF-8 text. |

`locate(meta)` returns `{ kind: 'jsonl', path }` for the fixed transcript inside the resolved project/session directories. It performs no filesystem I/O: the target can be returned before the directory or file exists, and an existing file contains only the last flushed prefix.

## Physical encoding

The default artifact is a standard concatenation of independent [Zstandard frames](../../../.agents/notes/implemented/architecture/2026-07-19-zstandard-jsonl-session-logs.md): one checksummed frame containing only the header line, followed by one checksummed frame per durable append batch. The backend uses Node's built-in Zstandard API with its default compression level and exposes no level knob. Listing reads and validates only the header frame. `compression: 'none'` keeps the same logical lines in the original raw representation.

A root belongs to one encoding. Startup discovery and targeted lookup reject the opposite suffix with an error naming the incompatible artifact and instructing the caller to select the matching mode or a separate root. Flat `<project>/<id>.jsonl*` artifacts are also rejected instead of ignored. Format migration preserves the configured encoding; compression conversion, mixed-root fallback, and dual write remain unsupported.

## Durability and crash semantics

- **Bound storage identity.** Lookup requires one matching session directory across the readable project directories, then verifies that the header id equals the requested id and that the header's id/cwd derive the selected transcript path. Listing applies the same path check and rejects duplicate ids. Identity failures occur before repair or append.
- **Lazy materialization.** `create(meta)` writes nothing; browser drafts keep boundary and policy events in memory until a materializing event arrives, then the backend writes and `fsync`s the complete buffered prefix and first batch in a temporary file. A visible message promotes the header out of draft status; command-only artifacts remain hidden from ordinary lists. POSIX publishes it without overwrite via a hard link and `fsync`s the parent directory. Windows publishes it without overwrite via `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` and creates missing directories through the same write-through pattern. A created-but-never-appended session leaves nothing on disk and is absent from `list`.
- **Append-only.** Flushed events are never rewritten. Subsequent raw batches append lines; compressed batches append one frame. Both paths `fsync`, and a caught write or sync failure rolls the file back to its prior byte length.
- **Crash recovery — preserve valid tail work.** `load` validates every complete compressed frame and scans their decompressed JSONL. If the last frame is structurally incomplete, the reader keeps its complete decoded records, truncates from that frame's start, and re-encodes those records with the synthetic tool, step, and turn closers required by the shared [persistence contract](../../../.agents/notes/implemented/architecture/2026-06-14-session-persistence.md). Raw mode truncates from its first incomplete line. An existing compressed artifact with no complete header frame, a checksum/decompression failure in a complete frame, or a defect at or before the last committed `turn/end` is corruption and rejects.
- **Non-mutating inspection.** `inspect()` returns an immutable balanced logical view with its exact inherited cut and may synthesize recovery closers in memory, without truncating an incomplete tail or changing the lightweight revision. `readFrom(id, fromOffset)` accepts a `SessionLogOffset`, parses the whole artifact, skips forward, and returns the suffix beside the same cut; header-only listing exposes `isSeeded` without reading event bodies.
- **Contiguous-seq.** `append` rejects a batch whose first `seq` does not continue the stored log, and rejects non-JSON-serializable `event.data` naming the offending event type.
- **Lightweight revisions.** `revision(id, signal?)` resolves only the requested artifact and identifies it by device, inode, size, and nanosecond timestamps without parsing the log; `listSnapshots(signal?)` applies the same identity to every discovered artifact. The identity changes after append, repair, replacement, or store changes. A full-prefix read requires the same identity before and after reading the bytes, and `readStoredRevision()` also uses it to validate retained preparations. Snapshot listing forwards the exact signal through artifact discovery and checks cancellation around every `stat`; because filesystem `stat` is not interruptible, cancellation waits for the active call to settle, then rejects without starting another.

## Write path

The plugin copies frozen session events into one write handle per live session. Live-event write batching is the seam's internal scheduling policy, not configuration: a batching window inside each handle coalesces the live buffer into one durable append, and `session/flush` or disposal drains current and pending batches. A per-session cursor prevents resumed sessions from re-appending stored events, and live sessions are seeded when the plugin loads. The owning backend instance serializes operations for one session; disposal drains every retained handle before teardown. Every logical event remains present: batching only lets one compressed frame or raw fsync carry more records.

Plaintext body reads scan bounded byte windows and retain decoded events without a complete raw-file buffer. They check cancellation between reads and retry changed revisions. Successor publication rechecks the source revision after writing the temporary file; a changed or missing source refuses publication. Successors are encoded in bounded batches with cancellation checks between events and writes. Compressed reads and logical preparation still retain complete input or event arrays.

## Invariants

**Runtime invariant:** No companion is published. Each session is one append-only log whose lifecycle is covered by the shared coordinator specs; the backend adds only byte-level storage.

## Model Experience

### Resumed conversation history

#### What the model sees

JSONL storage contributes no live prompt or schema. Loading restores stored surface history and preserves prior request headers for reconstruction; the new loop composes its current envelope. Recovery balances an assistant request without a durable call with `TOOL_NOT_STARTED`; a durable call without a result becomes `TOOL_OUTCOME_UNKNOWN`, which tells the model to retry only read-only or idempotent work and to verify possible side effects or ask the user. Embedded Assistant streams and log-only attempts do not duplicate messages.

#### Token effect

Zero live-request tokens. A resumed agent pays for retained history and its current envelope, plus the quoted repair result for each interrupted call.

#### KV Cache effect

JSONL storage does not mutate live request prefixes. A resumed loop can reuse provider cache only when its reconstructed history, current envelope, and model route match; crash-repair results append.

## Known Limitations and Deferred Work

- **Only the configured encoding and catalogued generations load** — this backend migrates released v0/v1/v2/v3 artifacts to current v4 beside the preserved source; changing compression requires a separate root, and retained predecessors do not provide automatic fallback or downgrade support.
- **The flat-file storage layout does not load** — use a separate root or move pre-release artifacts into the project/session directory layout before loading.
- **Compressed files are not directly line-readable** — use the backend to load them, or select `compression: 'none'` before writing a fresh root when external line readers are required.
- **Nothing deletes session files** — logs accumulate under `root` until removed externally (the seam has no deletion API).
- **One live writer per session** — a write handle holds a kernel lease on `<root>/.locks/<id>.lock` for its whole life (non-blocking POSIX `flock`; a named kernel semaphore on Windows), so a second backend instance or process fails write-open with `SessionAlreadyOwnedError` until the owner releases or its process exits. A live but wedged holder keeps blocking until it exits — removing the lock file is the explicit POSIX forfeit — and advisory `flock` is unreliable on NFSv3, where exclusion degrades to in-process. Initial same-id publication remains collision-safe through the POSIX no-overwrite hard link or Windows write-through rename without replacement.
- **POSIX materialization requires hard-link support** — first append uses `link()` so same-id races fail instead of overwriting a committed log; Windows uses write-through rename without replacement.
