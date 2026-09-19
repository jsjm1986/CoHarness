# Agent Note: Remove the `assistant/chunk` session event

Status: implemented

English | [中文](2026-09-19-assistant-chunk-event-removal.zh.md)

## Problem

The `assistant/chunk` event made every streamed delta a durable `SessionEvent`: token-sized rows dominated retained bytes, `sourceEventSeqs` citations linked each settled message to its chunk run, and every consumer — metering, pagination, projections, UI — resolved that indirection. The [embedded-stream decision](2026-09-18-assistant-message-embedded-stream.md) moved settlement provenance into `assistant/message.data.stream`; what remained was the chunk event itself and the physical row packing two backends built on it.

## Decision

Session format v4 removes `assistant/chunk` from `SessionEventMap`. A completed provider call persists one `assistant/message` carrying `message` plus the compact `stream: AssistantStreamRecord[]`; a failed, retried, cancelled, or stream-error attempt that reaches settlement without a surface message persists `assistant/attempt` with the same stream field. `expandAssistantStream` reconstructs timed chunks for consumers that need them.

Live output rides `agent/assistant-stream` frames (`start`/`chunk`/`end` carrying attempt identity, revision, dense index, and durable cursor), transported to host clients as `session/assistant-stream`; the host reconnect accumulator baselines each attempt against its durable cursor. The web client folds frames into transient `assistant/live-chunk` rows and settles them against durable `assistant/message`/`assistant/attempt` events, so the durable spine stays `SessionEvent`-only.

Released generations stay readable: the format catalog gains a v3→v4 stage that folds each contiguous same-step `assistant/chunk` run into the settlement event's embedded stream, synthesizing `assistant/attempt` for orphan runs with no message. Committed v0–v3 files are never rewritten; fixture gates keep prior-generation files byte-verbatim and canonicalize only current-generation or unversioned files. JSONL writes one logical event per line and decodes v3 packed storage rows only. SQLite schema 21 writes one event per row while packed physical rows remain decodable, and `scripts/session-sqlite-migration.ts` alone owns v18↔v20 packed-row encoding — core keeps no encoder so the retired vocabulary cannot leak back into runtime writes.

## Alternatives considered

**Keep `assistant/chunk` alongside embedded streams.** Duplicates one stream in two vocabularies, preserves the `sourceEventSeqs` indirection the embedded stream replaced, and keeps every consumer dual-path.

**Migrate stored generations in place.** Committed generations are immutable; rewriting them would move, overwrite, or delete released data and break the version contract readers rely on.

**Retain packed-row encoding in core.** The encoder exists only to emit a retired vocabulary; confining it to the offline v18↔v20 migration tool keeps runtime write paths single-shape while released databases remain upgradable.

## Consequences

`sourceEventSeqs` no longer appears on `assistant/message`; readers keep the legacy fallback for pre-v4 persisted events. Gateway media collection, conversation-safety scanning, token metering, history pagination, and projections read message content plus embedded streams. History-wire pagination keeps its own physical packed carrier — a transport detail independent of the session event vocabulary. The [packed JSONL layout](../../archived/architecture/2026-07-26-packed-chunk-rows-by-default.md) and [SQLite physical compression](../../archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md) decisions are retired write paths retained as decode-only compatibility.
