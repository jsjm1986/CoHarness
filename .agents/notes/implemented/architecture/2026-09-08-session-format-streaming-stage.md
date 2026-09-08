# Agent Note: Incremental Session format migration stage

Status: implemented

English | [中文](2026-09-08-session-format-streaming-stage.zh.md)

## Problem

CoHarness validates old Session artifacts through a whole-artifact migration API. That preserves correctness, but a provider that can read rows incrementally has no format-owned way to transform each event without building another complete artifact representation.

## Decision

The Session format chain now exposes an optional event-by-event migration stage. Each adjacent migration may create a stateful stage that emits validated target events synchronously; providers that do not provide a stage continue using the existing whole-artifact method. The public Session event and persistence contracts remain unchanged. Providers must add incremental raw-row reading before using the stage to reduce memory.

## Alternatives considered

**Keep only whole-artifact migration.** Rejected for providers that can read rows incrementally, because it creates avoidable peak memory and prevents bounded cancellation.

## Consequences

The streaming face is available without forcing every existing migration or provider to change at once. Current v0/v1/v2 migrations provide pass-through stages, while JSONL and Gateway provider integration remains a separate implementation step because their physical readers own decoding and publication.
