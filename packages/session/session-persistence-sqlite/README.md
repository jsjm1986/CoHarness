# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

An opt-in SQLite `SessionPersistence` provider. It stores eligible `assistant/chunk` runs in packed physical rows, selectively Zstandard-compresses large payloads, and delta-encodes provenance sequences while restoring the exact logical `SessionEvent[]`. No shipped composition selects it; deployments mount this package explicitly and provide its database path.

`locate(meta)` returns `undefined` because every session shares one database. The provider exposes no per-session raw artifact. `revision(id, signal?)` reads the indexed session row and does not scan other session metadata or event rows.

## Storage model

Schema 20 uses an integer internal session key plus the stable external `session_key`; the composite `events(session_id, seq)` primary-key index remains the physical lookup. CoHarness-only `session_extensions` stores the draft marker, and `event_extensions` stores logical `ignorable` markers, so neither meaning is overloaded onto the packed-row discriminator. Scalar rows store one logical event. Packed rows use `text-chunks`, `reasoning-chunks`, or `tool-call-chunks` as the physical `type`; `seq` and `time` identify the first represented event, and `data` holds the shared packed-chunk payload. Packed rows set `is_packed=1`; scalar rows set `is_packed=0`, with an optional `event_extensions` row for a logical ignorable event. These tags are storage records, not `SessionEventMap` members.

Schema 20 owns its codec locally rather than importing another persistence format's mutable implementation. Only exact, consecutive same-block text, reasoning, or tool-call delta forms pack. Unknown fields, surface metadata, sequence gaps, incompatible block/call identity, and unsafe timestamps remain scalar. A packed row represents at most 1,024 events and at most 1 MiB of uncompressed UTF-8 `data`; longer runs are partitioned without changing logical events. Reads reconstruct every original sequence number, timestamp, token boundary, argument fragment, and payload before returning data to the persistence coordinator.

Serialized `data` smaller than 4 KiB stays as SQLite `TEXT`. At or above that threshold, the writer uses Zstandard level 3 and stores a `BLOB` only when the frame is smaller than the original text; the reader decompresses it before UTF-8 validation and JSON parsing. `source_event_seqs` remains the complete ordered provenance array. Schema 20 prefixes a tagged varint payload and uses a compact consecutive-range encoding when it is shorter; sparse and descending values use the delta form. Large data cells use a fixed schema-owned zstd dictionary, so each row remains independently decodable.

Each append holds `BEGIN IMMEDIATE`, validates the bounded physical tail, packs only the new durable batch, inserts those records, and increments the session revision once. Normal appends never delete or replace an earlier event row. The default 200 ms write-behind window therefore compresses high-frequency streams while the physical write volume stays proportional to newly durable batches rather than repeatedly rewriting a growing packed value. A storage-level logical-tail check rejects a stale writer before mutation.

Full reads scan physical rows in first-logical-sequence order. A reverse pass finds the last valid `turn/end` without retaining decoded copies of every physical row; the forward pass decodes and validates one physical row at a time into the returned logical event array. `readFrom(id, fromSeq)` examines packed predecessors only within the maximum row span and anchors the suffix at the earliest one that may contain `fromSeq`; this includes an event range that starts inside a packed row, detects overlapping physical corruption, and does not parse unrelated earlier scalar rows. A malformed packed row is all-or-nothing: committed corruption rejects, while a torn final row is deleted from its physical base during mutating recovery. Repair re-reads the tail under the write lock and rejects a stale marker before deleting anything. Packed `data` that exceeds the schema byte limit rejects before JSON parsing.

## Schema compatibility

A pristine database initializes directly at schema 20. Older schemas, foreign application identities, non-pristine unversioned databases, and incompatible schema objects reject at open; the runtime never upgrades a file implicitly. Use the offline tools while the process is stopped:

```sh
pnpm run migrate:session-sqlite-v18-to-v20 -- --input old.db --output new.db
pnpm run migrate:session-sqlite-v20-to-v18 -- --input new.db --output old.db
pnpm run migrate:session-sqlite-v18-to-v20 -- --input old.db --verify-only
```

The input is read-only, the output must be a distinct new file, and each tool verifies logical event hashes before it returns. `--replace --keep-backup` is an explicit atomic replacement mode; keep the backup until a cold load and replay pass. Every runtime statement and fixed pragma lives in a packaged `.sql` resource; values use SQLite parameters and runtime code never assembles query text.

Session headers from format v0/v1 are a separate logical migration: the first body read updates only the metadata row to v2 in a write transaction and leaves all event rows untouched. Database schema upgrades remain offline and explicit.

## Configuration (schemastery)

```ts
interface Config {
  path: string
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'
  busyTimeoutMs?: number
  preparedSessionCacheSize?: number
  writeBatchMaxDelayMs?: number
  maxPendingEvents?: number
  maxPendingBytes?: number
}
```

`journalMode` defaults to `wal`, `busyTimeoutMs` defaults to `5,000`, `preparedSessionCacheSize` defaults to `5`, `writeBatchMaxDelayMs` defaults to `200`, `maxPendingEvents` defaults to `100,000`, and `maxPendingBytes` defaults to `64 MiB`. The timeout bounds each synchronous SQLite lock wait. Because SQLite may return `SQLITE_BUSY` immediately while changing journal mode, cold open yields between attempts and starts no further attempt after an open-relative retry cutoff. An in-progress synchronous SQLite call may finish after that cutoff. The provider disables trusted schemas and memory-mapped I/O on every connection, then reads both settings back. The selected journal mode is also read back and must match; in-memory databases explicitly accept SQLite's `memory` result. After selecting the journal, the provider pins `synchronous=FULL` and verifies it so SQLite build defaults cannot weaken committed-append durability. On POSIX, the database parent and file must be owned by the current user, the parent must not be group/world-writable, and the file must have no group/world permissions. Symbolic links and non-regular files reject. Windows also rejects symbolic links and non-regular files, but deployments remain responsible for restricting the directory and file ACLs to the harness user. Path and ownership failures reject plugin initialization. Node SQLite loads lazily on the first persistence operation; the import suppresses only Node 22's exact SQLite `ExperimentalWarning`. Store-identity and schema failures reject that operation before data is exposed or mutated.

## Model Experience

### Resumed conversation history

#### What the model sees

Nothing specific to SQLite. Resume restores the same logical events and derived messages as JSONL; physical packed tags never reach prompts, tools, replay, or live `session/event` delivery.

#### Token effect

Zero live-request tokens. Resume pays only for the retained logical history and current request envelope.

#### KV Cache effect

Physical packing does not mutate request prefixes. Provider cache reuse depends on the reconstructed history, current envelope, and model route exactly as with other persistence backends.

## Known Limitations and Deferred Work

- **Interim SQLite-specific design** — This efficiency-focused implementation is informed by [morlay/session-persistence-rdb](https://github.com/morlay/session-persistence-rdb). A unified relational-database design with multiple backends and configurable schemas is deferred; schema 20 is the current CoHarness format and later changes require another offline migration.
- **Packing follows durable batch boundaries** — compatible runs split by the write-behind window or an explicit flush remain separate physical records; this avoids rewriting prior rows at the cost of a timing-dependent packing ratio.
- **Synchronous compression** — Node's SQLite and Zstandard calls block the JavaScript thread; the 4 KiB threshold limits per-frame work for small records.
- **`DatabaseSync` blocks the event loop** — physical row reduction does not make SQLite operations asynchronous.
- **Busy waits block the event loop** — SQLite waits inside synchronous `DatabaseSync` calls; only a busy journal-mode transition yields between attempts, and the open-relative cutoff prevents another attempt rather than interrupting an active call.
- **External SQL readers must understand physical tags** — supported consumers read through this provider rather than treating every `events.type` as a logical event type.
- **No deletion or background historical compaction** — normal appends are insert-only.
