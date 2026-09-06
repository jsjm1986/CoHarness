# Agent Note: Session value and assistant-stream primitives

Status: implemented

English | [中文](2026-09-06-session-value-stream-primitives.zh.md)

## Problem

Session migration and replay need lossless JSON snapshots, immutable published values, and a compact representation of streamed assistant chunks. Keeping separate implementations in persistence and LLM packages would make format validation and replay behavior drift.

## Decision

`@deepseek-ai/dsh-util-values` owns the shared, stateless JSON validation, detached snapshot, structural equality, deep-freeze, and exhaustive-union helpers. `@deepseek-ai/dsh-llm/assistant-stream` owns the lossless timestamped assistant-stream accumulator and expander. The accumulator validates and snapshots each incoming chunk, compacts adjacent compatible deltas, and retains exact timing and chunk boundaries for replay.

These are additive primitives. The existing Session format and persistence coordinator remain authoritative until the SessionHandle and migration layers adopt them.

## Alternatives considered

**Copy validation into each persistence provider.** Rejected because JSON loss rules and snapshot ownership would diverge across JSONL, Gateway, and future providers.

**Store only reconstructed assistant text and tool arguments.** Rejected because replay and model-visible history require delta boundaries, timestamps, and non-text chunks.

**Adopt the upstream Session packages unchanged.** Rejected because their v2 types assume a persistence API that differs from CoHarness; the primitives can be shared without importing incompatible lifecycle semantics.

## Consequences

Session migration can use one runtime definition of lossless JSON and immutable records. Assistant attempt events can preserve compact stream data without retaining a second raw-chunk list. The primitives do not by themselves change on-disk format or make Session creation asynchronous; those changes remain separate, testable steps.

## Verification

The assistant-stream unit suite, package typecheck, host library build, and workspace dependency checks cover this addition.
