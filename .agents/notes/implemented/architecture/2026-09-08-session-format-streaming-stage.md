# Agent Note: Incremental Session format migration stage

Status: implemented

English | [中文](2026-09-08-session-format-streaming-stage.zh.md)

## Problem

CoHarness validates old Session artifacts through a whole-artifact migration API. That preserves correctness, but a provider that can read rows incrementally has no format-owned way to transform each event without building another complete artifact representation.

## Decision

The Session format chain exposes an optional event-by-event migration stage. Each adjacent migration may create a stateful stage that validates and emits target events synchronously; providers that do not provide a stage continue using the existing whole-artifact method. The public Session event and persistence contracts remain unchanged. Providers must add incremental raw-row reading before using the stage to reduce memory.

## Alternatives considered

**Keep only whole-artifact migration.** Rejected for providers that can read rows incrementally, because it creates avoidable peak memory and prevents bounded cancellation.

## Consequences

The streaming face is available without forcing every existing migration or provider to change at once. Current v0/v1/v2 migrations provide pass-through stages, while JSONL and Gateway provider integration remains a separate implementation step because their physical readers own decoding and publication.

Whole-artifact execution retains each adjacent target validator; streaming execution relies on the stage to validate its output. Stages flush in source-to-target order so downstream stages receive upstream trailing events before they finish. JSONL plaintext readers scan byte windows, and immutable successor publication rechecks the source revision after the temporary file is written. Successor encoding uses configurable batches, and the coordinator adopts exclusively owned backend events without a redundant snapshot copy. Compressed reads and preparation still materialize complete arrays.
