# Agent Note: Trajectory request lifecycle is settled state, not stream presence

Status: implemented

English | [中文](2026-10-14-trajectory-request-lifecycle.zh.md)

## Problem

The trajectory assistant Definition derived request status and streaming output from the wrong witnesses. A request appeared only once the first visible chunk arrived, so an admitted-but-silent model request rendered nothing at all. A recorded `llm/retry` flipped the request to `error` immediately — an in-flight retry looked like a failed request — and a usage-only chunk (no assistant blocks) materialized an empty partial instead of keeping the waiting request. An interrupted assistant message kept status `complete`/`running` until its step boundary, and a request placeholder presented as a completed Assistant result, offering a phantom result link.

## Decision

The request record owns the lifecycle; stream blocks only fill it in. `buildViewNode` emits a `running` request as soon as `step/start` is loaded, before any output. Status derives from settlement witnesses: a materialized final message settles the request (`error` when the message is `interrupted`, `complete` otherwise), a closed step boundary with no final message settles `error`, and everything else — awaiting output, streaming, retrying — stays `running` with `completedAt: null`. Retry facts (`retry`, `maxRetries`, `retryDelayMs`, the last attempt's `error`) travel on the request as history; they never set the current status.

- `TrajectoryPartialAssistant` extends `PartialAssistant` with `timing` (`stepStartTime`/`firstTokenTime`), and `llm/retry` preserves the recorded `firstTokenTime` across attempts, so TTFT keeps measuring from the Step start through recovery.
- Partial output exists only when materialized blocks exist; a usage-only chunk leaves `partial: null` while the request stays `running` with its usage.
- Layout marks interrupted assistant cells `isError` and prefers partial timing over node timing for streaming metrics; `TrajectoryView` forwards partial timing into the timeline and numbers a settled-but-unrequested assistant node by its `interrupted` flag.
- The inspector distinguishes `details.lastAttemptError` (history, neutral styling) from `details.error` (current failure, error styling) and skips request-only placeholders when locating the Assistant result link.

## Alternatives considered

**Keep chunk presence as the request's birth.** Every fix (retry status, usage-only chunks, interrupted settlement) then re-derives the same lifecycle locally; the upstream contract — publish at `step/start`, settle only on message or boundary — states it once, in one place.

**Surface retry as a distinct status.** Retry is a detail of a still-running request, not a lifecycle state; the inspector shows the attempt counter and last failure while the status row stays Pending until the response settles.

## Consequences

A silent model request is visible from admission, a retrying request reads Pending with its attempt history instead of Failed, and interrupted output is inspectable as a failure whether or not its Step start is loaded. `errorCode` on the request — the provider code channel upstream added in `7520fe94e14` for localized AUTH copy — remains an adjacent gap; the audit tracks it separately.

## Verification

`conversation-definitions.client.spec.ts` — waiting request before output, retry stays `running` until settle, usage-only chunk keeps the waiting request, interrupted response settles `error` pre-boundary, partial carries timing. `layout.client.spec.tsx` — interrupted cells carry `isError`, streaming cells expose recorded start/TTFT metrics. `table.client.spec.tsx` — no result link on request placeholders; retry history vs current status in both locales. `views.client.spec.tsx` — settled status for an unloaded Step start. 160 `ui-trajectory` tests pass.

## Related

- [Trajectory assembly from registered Conversation Contexts](../architecture/2026-08-11-trajectory-conversation-context-assembly.md) — the Definition this lifecycle contract lives in.
- [Trajectory inspection ledger](../feature/2026-07-27-trajectory-inspection-ledger.md) — the view model the request and partial records feed.
