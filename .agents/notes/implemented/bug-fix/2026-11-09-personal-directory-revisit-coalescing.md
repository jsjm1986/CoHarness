# Agent Note: Coalesce directory revisit and restore-retry events instead of dropping them

Status: implemented

English | [中文](2026-11-09-personal-directory-revisit-coalescing.zh.md)

## Problem

[personal-directory.ts](../../../../packages/client/runtime/src/client/personal-directory.ts) dropped two event classes while a flight was already running. `focus` (the `online`/`focus` handler) returned silently when `revisit` was occupied, and `restoreSelection(retry)` returned silently when `restoreWork` was occupied. Both drops lose the *event*, not just the duplicate work: the in-flight flight was issued against the world as it was when it started — an `online` arriving during a doomed restore open (one still racing an outage window) produced no post-recovery attempt at all, so the restored conversation's intent card stayed `unavailable` forever. The `personal-navigation-resume` scenario exercises exactly this: an offline remote, a retained intent draft, then `online` — the card must hide after the retried restore commits.

## Decision

Each drop point coalesces into one deferred pass. `focus` records `revisitQueued` when a revisit is in flight and runs once more after it settles; `restoreSelection` records `retryQueued` for `retry` arrivals during `restoreWork` and re-enters after that flight settles. Coalescing still bounds work to one extra pass per drain — unlike `refresh`, whose in-flight `work` is *shared* because an already-running request's result satisfies the caller, an event-triggered revisit must re-read after the event, since the in-flight result predates the state change the event announced. `attempt.signal.aborted` remains a permanent stop: a superseded navigation correctly kills the saved-selection attempt.

## Alternatives considered

**Run the event's pass concurrently.** Rejected: parallel revisits double catalog traffic and order badly against the in-flight request's own republish.

**Let `refresh`'s `work` dedup serve the event.** Rejected: sharing the stale in-flight result is exactly what the event exists to invalidate; the retry must read the post-event world.

## Consequences

An `online`/`focus` event can no longer be lost while a revisit is in flight, and a restore retry arriving during an open always runs once after it — the offline-recovery card commits on the first post-recovery pass instead of stranding. Multiple events still collapse to a single extra pass.

## Verification

`personal-directory.client.spec.ts` parks the first `ensureSession` open on a gate, fires a refresh retry mid-flight, and observes the queued second open committing the saved session. `personal-navigation-resume.e2e.ts` covers the full browser path: intent draft retained offline, `online`, card hides, input lands in the original conversation.
