# Agent Note: Assistant messages embed their provider stream

Status: implemented

English | [中文](2026-09-18-assistant-message-embedded-stream.zh.md)

## Problem

`assistant/message` events cited their producing `assistant/chunk` seqs through `sourceEventSeqs`, so every consumer of a settled assistant message — token metering, history pagination, suffix windowing — resolved indirection through the log. The citation also made `assistant/message` eligible as a replace node even though a replacement that cites shadowed surface nodes has no valid assistant use, and it duplicated source references the message can carry directly.

## Decision

Adopt the upstream contract: an `assistant/message` embeds its provider stream in `data.stream` (`AssistantStreamRecord[]` produced by `AssistantStreamAccumulator`) and cannot carry `sourceEventSeqs`. `SurfaceIntent<T extends SurfaceEventType>` types the field as `never` for `assistant/message` and keeps it for `system/message`, `user/message`, and `tool/result`; `Session.append` and stored-log validation reject the field on `assistant/message`. `surfaceOp` is required on every surface event. `expandAssistantStream` reconstructs the timed chunk sequence for assertions and diagnostics.

Consumers changed shape rather than semantics:

- Token metering and usage projections read the embedded stream and usage records instead of resolving cited chunk events; legacy migrated events that lack `data.stream` keep the durable fallback.
- History detail and wire pagination derive an append-origin message group from the contiguous same-step `assistant/chunk` run directly preceding the message, with a `sourceEventSeqs` fallback retained only for logs persisted before this contract.
- Replacement intent moved to `user/message`: compaction summaries and other user-visible replacements cite shadowed nodes through `user/message`, `system/message`, or `tool/result` replace events.

`assistant/chunk` events were later removed from `SessionEventMap` by the [chunk-removal decision](2026-09-19-assistant-chunk-event-removal.md): `data.stream` is required at format v4, and persisted events written under the previous contract may still carry `sourceEventSeqs`; readers keep the fallback because stored generations are immutable.

## Alternatives considered

Keeping citations alongside the embedded stream duplicates the source references and preserves an invalid replace shape. Dropping `assistant/chunk` in the same change couples this contract migration to the larger settlement and format-split work. Stripping `sourceEventSeqs` on read would rewrite immutable stored generations.

## Consequences

`assistant/message` can no longer be a replace node, so replacement producers and fixtures use `user/message`. Tests and committed JSONL fixtures were migrated in place: fixtures that exercised the citation path now embed streams, and compat fixtures keep `sourceEventSeqs` behind `as unknown as SessionEvent` to cover the persisted-legacy fallback. The TypeScript and Python SDK projections are unchanged because `sourceEventSeqs` never appeared on the wire.
