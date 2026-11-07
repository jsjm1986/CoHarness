# Agent Note: Curation execution identity

Status: implemented

English | [中文](2026-10-23-curation-execution-identity.zh.md)

## Problem

Memory curation coalesces completed turns into a per-session lane. A pending turn can belong to another project member. Starting it from the previous pass's asynchronous callback retains that pass's execution context, which can charge auxiliary requests and attribute writes to the wrong participant.

## Decision

Each turn captures its execution inheritance and issuing authority before queueing. Each pass restores that inheritance with `runCaptured` and checks provider identity before starting. A failed capture skips the background pass without interrupting the completed primary turn. Independent applications retain their absent-authority behavior.

## Alternatives considered

**Resolve participants when the pending pass starts.** The previous callback can still carry its own asynchronous execution context, while the Session may already reflect a later turn. Neither identifies the pending turn reliably.

**Retain only participant ids.** Execution authorization also relies on the immutable scope and its issuing provider; ids alone cannot restore that authority.

## Consequences

Queued extraction and consolidation run under their triggering turn rather than an adjacent member's execution. A replacement provider cannot lend its current authority to an older queued pass.

## Verification

A built-product reproduction using GatewayExecution and JSON storage observed auxiliary actors `[1, 1]` for triggers `[1, 2]`. Unit barriers cover queued turns, capture refusal, and provider replacement. The headless example snapshot runs real Agent turns, GatewayExecution, curation, and JSON memory over deterministic Gateway wire replies, checking auxiliary actors and durable writer attribution.
