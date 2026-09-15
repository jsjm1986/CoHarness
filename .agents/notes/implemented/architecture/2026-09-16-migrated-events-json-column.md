# Agent Note: Preserved migration bodies stay on the json type

Status: implemented

English | [中文](2026-09-16-migrated-events-json-column.zh.md)

## Problem

`conversation_migrated_events` preserves a session's committed predecessor body before `ConversationRepository.migrate` rewrites it, mirroring the file backend's retained-generation rule. Its `event` column was created as `jsonb` while `conversation_events.event` had already been moved to `json` by migration `004`: event strings may contain `\u0000` escapes (instruction scope keys pair a directory and file name behind a NUL separator that paths cannot contain). `json` stores that escape verbatim and decodes it back to the real character on read; `jsonb` rejects it outright with `22P05 unsupported Unicode escape sequence`.

The receipt copy runs server-side — `INSERT ... SELECT` from the `json` column into the `jsonb` column — so every session whose stored events carry a `\u0000` escape failed its body migration inside the guarded transaction, retrying on each access and logging `request failed` each time.

## Decision

Migration `027_migrated_events_json.sql` changes the receipt column to `json` via `USING event::text::json`. Existing rows could never have held `\u0000` (jsonb never accepted them), so the text round-trip preserves them verbatim.

`ConversationRepository.serialized` stays a plain `JSON.stringify`: the `json` columns already accept the escape and decode it back to the real character, keeping scope keys byte-identical across persistence and replay. The earlier attempt that rewrote NUL to the literal six-character `\u0000` text was reverted — it stored a different value than the event carried, so `decodeScopeKey` could no longer find the separator when the body was replayed.

## Alternatives considered

**Escape during the receipt copy.** `replace(event::text, '\u0000', '\\u0000')::jsonb` lets the copy succeed but stores literal `\u0000` text in the receipt — the same corrupting transform, now only inside the backup a restore would read back.

**Keep the literal-text serialization.** The write succeeds but silently changes the stored value: replays decode the six-character text instead of the NUL separator, mis-scoping instruction reconciliation for every migrated session.

**Transform on both write and read.** A sentinel swapped in and out at the repository boundary collides with legitimate occurrences of the sentinel in arbitrary user text and still cannot represent the character inside jsonb.

## Consequences

Any future table receiving verbatim event payloads must use `json`, matching migration `004` and this receipt. jsonb-typed metadata columns (`audit_events.detail`, `conversation_interaction_responses.outcome`, provider `profile`s) share the same `\u0000` limitation; payloads written there must not carry raw event text.

The rollback-transaction proof ran the exact receipt `INSERT ... SELECT` against a v0 session holding `\u0000`-escape events and committed clean under `json`.
