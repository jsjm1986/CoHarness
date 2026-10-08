# Agent Note: Purge admission waits for pending lifecycle settlement

Status: implemented

English | [中文](2026-10-08-purge-admission-waits-for-pending-lifecycle.zh.md)

## Problem

`ctx.agents.reserveRemoval` is a sampling check, not a promise that the Session stays claim-free. A spec that acquires the reservation once and then calls `HostSessionLifecycle.withReleased` races any legitimate use claim that lands in between; the Agent registry throws `Session "<id>" has a pending lifecycle operation` at admission. `Session "purge-root" has a pending lifecycle operation` in `session-purge-composition.spec.ts` was that race, surfaced by CI host load.

The pending claimer is `goal-round-driver`: a pause clears `state.attempt` inside `drive()`, so the aborted `turn/end` finds no owned attempt and falls to `disarm`, which emits `goal/changed` and re-enters `requestDrive` → `ctx.agents.withoutInitiator` → `reserveUse` for the post-abort checkpoint. The new claim is correct product behavior — the driver retains the Session through coalesced checkpoints — so the purge caller, not the driver, owns the wait.

## Decision

Wrap the final `withReleased` in `vi.waitFor` so admission itself is the success condition: the spec retries the designed refusal until the driver's pending claim settles, while asserting the paused goal state and durable checkpoint inside the same wait. A claim that never settles still fails the test at the wait deadline instead of passing on a lucky sample. The same pattern applies wherever a spec samples `reserveRemoval` before a one-shot removal call.

## Alternatives considered

- **Probe `reserveRemoval`, then call `withReleased` once.** The probe only proves claims were absent at sample time; a legitimate claim can land before the call, which is exactly the collision observed on CI.
- **Await a specific driver-quiet signal.** The driver's claim state is internal; nothing external publishes it, so the durable facts — paused goal, flushed persistence, admitted removal — are the observable settlement, and admission is the only atomic check-and-act.
- **Hold the turn's events back until the checkpoint completes.** Slowing the abort chain to make sampling reliable would change product scheduling for a test defect and still leaves other claim sources.

## Testing

`packages/host/apiproxy/tests/session-purge-composition.spec.ts` passes 6/6 locally, including `hands checkpoint ownership to a live Goal turn and allows purge after explicit pause`. The collision window cannot be forced open on an unloaded host; the mechanism is established from code paths (`reserveRemoval` admission, `drive` attempt clearing, `disarm` → `goal/changed` → `requestDrive` → `reserveUse`) and the CI signature. A permanently held claim fails the spec at the wait deadline rather than passing silently.

## Consequences

Purge callers keep their contract — `withReleased` still refuses while lifecycle operations pend — and the spec now treats that refusal as the retry signal it was designed to be. `remove` is invoked at most once per admission and the once-only assertion survives retries because only a fully released call reaches it. No production code changes; the driver's ownership of the Session through checkpoints is unchanged.
