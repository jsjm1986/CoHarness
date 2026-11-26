---
description: "Durable SQLite Session persistence with compressed event payloads"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

An opt-in SQLite `SessionPersistence` provider. It stores one row per event, selectively applies Zstandard compression to large payloads, and compactly encodes source-event sequences while restoring the exact logical `SessionEvent[]`. Deployments mount it explicitly with a database path.

`locate(meta)` returns `undefined` because every session shares one database. The provider exposes no per-session raw artifact. `revision(id, signal?)` reads the indexed session row and does not scan other session metadata or event rows.

## Summary

Use `dsh-session-persistence-sqlite` when a deployment needs durable Session logs in one SQLite database. Appends preserve prior events and commit the new batch with its revision, so consumers can check a Session's revision without loading its history.

## Table of Contents

- [Storage model](#storage-model)
- [Schema compatibility](#schema-compatibility)
- [Configuration (schemastery)](#configuration-schemastery)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="storage-model"></a>
## Storage model

Schema 21 uses an integer internal session key plus the stable external `session_key`. The composite primary key `events(session_id, seq)` locates scalar event rows, each with `is_packed=0`. The decoder rejects packed rows. `session_extensions` stores the draft marker and `event_extensions` stores logical `ignorable` markers.

Serialized `data` smaller than 4 KiB stays as SQLite `TEXT`. At or above that threshold, the writer uses Zstandard level 3 with a fixed dictionary and stores a `BLOB` only when it is smaller than the original text. Each row decompresses independently. Tagged varints preserve the complete ordered `source_event_seqs` array using consecutive ranges or deltas.

An append uses `BEGIN IMMEDIATE` to validate the schema and bounded event tail, insert the new batch, and increment the Session revision. The tail check rejects a stale writer before mutation. The default 200 ms write-behind interval groups new events into a batch.

Reads scan events in sequence order. `readFrom(id, fromSeq)` starts at the requested sequence and avoids decoding the earlier prefix. Corruption in the committed prefix rejects the read. Mutating recovery can remove a torn final suffix after rechecking its start sequence under the write lock.

<a id="schema-compatibility"></a>
## Schema compatibility

SQLite Session storage rejects creation with a managed SSH target. Use the deployment’s JSONL or Gateway persistence for Sessions bound to managed SSH.

A pristine database initializes at schema 21. Opening rejects foreign application identities, non-pristine unversioned files, other SQLite schema versions, and incompatible schema objects. SQLite schema upgrades require an explicit offline conversion. The [schema 20 conversion tools](../../../.agents/notes/implemented/architecture/2026-08-29-session-sqlite-schema20.md) support their documented v18/v20 pair.

Every mutation checks the application identity, version, and actual ordered schema definitions within its write transaction. Whitespace-equivalent definitions remain compatible. Runtime statements and pragmas live in packaged `.sql` resources.

Logical Session format migration is separate from the database schema. The provider publishes migrated headers and events together in one transaction guarded by the inspected source revision.

<a id="configuration-schemastery"></a>
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

<a id="model-experience"></a>
## Model Experience

### Resumed conversation history

#### What the model sees

Resume restores the same logical `SessionEvent[]` and derived messages as JSONL.

#### Token effect

Zero live-request tokens. Resume pays only for the retained logical history and current request envelope.

#### KV Cache effect

Provider cache reuse depends on the reconstructed history, current envelope, and model route.

## Known Limitations and Deferred Work

- **SQLite-specific design** — this implementation draws on [morlay/session-persistence-rdb](https://github.com/morlay/session-persistence-rdb). Other relational backends and configurable schemas are out of scope.
- **Synchronous compression** — Node's SQLite and Zstandard calls block the JavaScript thread; the 4 KiB threshold limits per-frame work for small records.
- **Busy waits block the event loop** — SQLite waits inside synchronous `DatabaseSync` calls; only a busy journal-mode transition yields between attempts, and the open-relative cutoff prevents another attempt rather than interrupting an active call.
- **Insert-only appends** — the provider offers no background historical compaction.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
