# Agent Note: Token and cache disclosure follows compact retry settlements

Status: implemented

English | [中文](2026-09-13-token-cache-disclosure-replay.zh.md)

## Problem

CoHarness already persisted provider usage in streamed `assistant/chunk` events and exposed per-turn disclosure in the Web conversation. Session-format v2 also permits a compact `assistant/attempt` settlement to carry the stream. The projection and disclosure folds did not read usage or first-token timing from that settlement, and a retry in the same step could replace the prior sample instead of accumulating both billed attempts.

## Decision

The token-meter reads the last `usage` record from either streamed chunks or a compact Assistant settlement. `llm/retry-started` clears the single in-flight replacement slot, so the next sample is added as a new attempt while a duplicate final sample still replaces its own attempt. The projection state version is bumped to invalidate older checkpoints safely; totals and wire fields stay unchanged.

Session stats reads first-token timing from compact attempt records and from an embedded stream on assistant messages when no live chunk supplied it. Existing CoHarness `assistant/chunk` logs remain the fast path, and the adapter does not materialize a compact stream just to render a statistic.

The completed-turn node also matches `step/start` and `assistant/attempt`, so a compact settlement remains in the turn-local evidence used by the per-turn usage panel after replay.

## Consequences

Completed turns retain exact token, cache-read, cache-write, output, and cache-hit values. Failed attempts that report usage remain visible in the session total, and retry chains no longer undercount provider billing. Missing or contradictory provider fields still fail closed in per-turn disclosure. No provider data is fabricated when a route reports no cache bucket. Legacy or malformed assistant envelopes without a normalized route no longer throw while durable migration is being established; the exact usage value remains available and route attribution is omitted.

The change preserves the existing SessionEvent vocabulary, Gateway wire fields, ACL behavior, and UI composition. It only broadens the read paths and invalidates stale projection checkpoints through the normal `stateVersion` mechanism.

## Alternatives considered

**Keep reading only `assistant/chunk`.** This misses usage and first-token facts in compact settlements and leaves retry totals vulnerable to replacement.

**Replace the whole token projection with an unbounded attempt list.** The existing bounded totals and one-slot replacement rule preserve memory limits; clearing the slot at retry is sufficient to distinguish attempts without retaining their history.

## Verification

Focused projection, compact-stream, retry, session-stats, and Web UI tests pass. Typecheck for `dsh-token-meter` and `dsh-session-stats`, client typecheck, and production build remain required before publishing the release. Real-provider cache reporting is deployment-dependent and must be checked against a provider response; replay fixtures intentionally use deterministic usage values.
