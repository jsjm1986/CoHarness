# Agent Note: Use a CoHarness SQLite schema 20 with explicit extensions

Status: implemented

English | [中文](2026-08-29-session-sqlite-schema20.zh.md)

## Problem

Upstream schema 19 changes the SQLite primary key and reuses the event flag for physical packing. CoHarness also needs durable draft state and logical ignorable events, and an in-place pragma change cannot preserve those semantics or provide a safe rollback.

## Decision

New Session SQLite files use schema 20. `sessions.id` is an integer storage key and `session_key` remains the external SessionId; events reference the integer key and carry a non-null `is_packed` discriminator. `session_extensions` stores draft state and `event_extensions` stores only logical `ignorable: true` markers. The runtime rejects schema 18 and never upgrades it on open. Explicit offline tools export logical events, rebuild the target schema with the schema-owned codec, compare SHA-256 logical-session hashes, fsync the result, and optionally replace the input only with `--replace --keep-backup`. The reverse tool writes a schema-18-compatible logical file for rollback and forensic recovery.

## Alternatives considered

**Change only `PRAGMA user_version`.** Rejected because table columns, key types, compression, and flag semantics would remain incompatible.

**Keep draft and ignorable columns in the upstream tables.** Rejected because physical packing and logical event admission would again share a field and future schema changes could silently reinterpret it.

**Perform an automatic online migration during `openDatabase()`.** Rejected because a running writer or a failed copy could leave the only session artifact partially converted.

## Consequences

The storage layout is not byte-compatible with upstream schema 19, but its public SessionId, event stream, revisions, draft behavior, and ACL-facing metadata remain stable. Operators must schedule an offline migration and retain the old file until a cold replay succeeds. Empty stores are migratable because the singleton store identity is copied independently of session rows.

## Testing

SQLite persistence tests cover schema ownership, integer-key joins, packed and logical extension rows, stale repair, draft recovery, and physical corruption. Migration commands validate both directions, reject same-path or existing outputs, preserve store identity and logical event hashes, and leave the input untouched on failure.
