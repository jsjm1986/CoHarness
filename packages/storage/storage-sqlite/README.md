# @deepseek-ai/dsh-storage-sqlite

English | [中文](README.zh.md)

SQLite backend for the [storage hub](../storage/README.md): registers as backend `sqlite`, serving the `kv` facet over one `node:sqlite` database file (or `:memory:`). Design and trade-offs: [domain KV storage Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.md).

## Summary

`dsh-storage-sqlite` is a storage backend that hosts every routed unit in one SQLite database file, storing each record as one JSON document per row, registered as backend `sqlite`. A single record update touches exactly one row, which is what makes this the right medium for high-frequency, point-sized writes. Choose it when a domain's data changes often or the deployment prefers one queryable database; choose the JSON backend when the data should be readable as plain files. The backend is host-side only: it contributes no prompt, tool, or schema, so the model and the agent loop never see it.

## Storage model

Document-per-row: each unit table becomes a physical `"u_<unit>_<table>" (key TEXT PRIMARY KEY, value TEXT)` STRICT table whose `value` is the record's JSON text, so one key updates one row (the reason to route a high-churn domain here instead of the JSON backend). Unit identity lives in two metadata tables — `units` stamps each unit's format version at first open and rejects a differing descriptor with `version-mismatch`; `unit_globals` holds each unit's global singleton row. The physical layout version lives in `PRAGMA user_version`; any other stamped value rejects (unreleased format, no migrations). Unit and table names are validated against the hub's `UNIT_NAME_RE` before they reach DDL, so no external input is ever interpolated into SQL identifiers.

Every write primitive is a single prepared statement — SQLite's per-statement atomicity satisfies the KV contract without explicit transactions, and write ordering stays the caller's responsibility (the domain layer's write chain). Missing directories and database files are created owner-only (`0o700`/`0o600`), matching the session-persistence SQLite backend.

## Configuration (schemastery)

```ts
interface Config {
  path: string   // SQLite database file path, or ':memory:' for an in-process DB
  journalMode?: 'wal' | 'delete' | 'truncate' | 'persist'   // journal_mode pragma; default 'wal'
}
```

## Model Experience

### Stored domain records

#### What the model sees

Nothing. This backend contributes no prompt, tool, or schema; it persists non-session domain data behind `ctx.storage` for host-side consumers only.

#### Token effect

Zero live-request tokens.

#### KV Cache effect

None — the backend never touches live request prefixes.

## Known Limitations and Deferred Work

- **`DatabaseSync` is synchronous** — each write blocks the event loop for its (single-statement) duration; acceptable at domain-data scale.
- **No busy-wait or retry policy** — another connection holding a write transaction rejects the operation immediately; there is no multi-process write protection.
- **Only the current `STORAGE_SQLITE_SCHEMA_VERSION` opens** — any other stamped version is rejected rather than migrated (pre-release stance).
- **`openDatabase` duplicates the session-persistence SQLite open sequence** — extraction into a shared media layer is deferred to the planned session-backend migration (see the Agent Note's reuse audit).

## Invariants

**Runtime invariant:** No companion is published. All records live in the single database file the backend opens; there is no shadow state.
