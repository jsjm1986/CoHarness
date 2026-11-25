# Agent Note: Size lsp-stdio teardown budgets for degraded Windows helper delivery

Status: implemented

English | [中文](2026-11-24-windows-teardown-budget-headroom.zh.md)

## Problem

Since the hosted Windows image rolled from `20261103.298` to `20261111.635`, every `packages/lsp/lsp-stdio/tests/instance.spec.ts` case that reaches forced teardown burned its full 180 s timeout (14 of 24 tests on master). The spec spawns through raw `spawnSubprocess`, whose Windows teardown has exactly one delivery path: `taskkill /T /F` bounded by `spawnSync`'s timeout — which the product deliberately ties to the spawn's `graceMs` (`taskkillProcessTree(pid, spec.graceMs)`; the deadline fixture exists to prove that budget propagation). The spec's 100–200 ms escalation budgets starve the helper on a degraded host: `spawnSync` SIGKILLs taskkill before it delivers, the tree survives, and `forceTerminate`'s intentionally unbounded `waitForManagedRangeExit` polls liveness forever. The sibling `lifecycle.spec.ts` passed in ~16 s because the provider path terminates through `launchWindowsJob` job objects and never runs taskkill.

## Decision

Raise only the spec's budgets: `SHUTDOWN_TIMEOUT_MS`/`KILL_GRACE_MS` constants set to 2 s replace every 100–500 ms literal, and the `waitForProcessExit`/`waitForFile` poll ceilings move to 10 s. The constants document that these budgets are helper-delivery envelopes rather than tight escalation pacing: hung-server cases wait the 2 s shutdown budget before escalation, while a kill that lands early still clears the grace timer via range-exit observation. Product code is unchanged: `taskkillProcessTree`'s owner-budget binding is the contract the deadline fixture asserts, and `forceTerminate`'s unbounded wait is the documented quiescence postcondition.

## Alternatives considered

- **Floor the helper timeout inside `taskkillProcessTree`** — breaks the native-control deadline fixture's premise (the helper lifetime must track the owner budget to prove deadline propagation) and weakens the "failed tree kill remains visible" contract; the environment property belongs at the caller, not the helper.
- **Direct `child.kill` backstop after taskkill** — would settle the child even when the tree kill silently failed, hiding surviving descendants the disposer is meant to observe.
- **Windows exclusion via `windowsUnsupportedTests`** — would green the lane while leaving the fallback teardown path's real latency requirement undiscovered by any test.

## Consequences

The spec's forced-teardown cases grant taskkill a two-second envelope — an order of magnitude over the healthy-image budget — while keeping escalation ordering and quiescence assertions intact. If `windows-native` exposes a blocked helper delivery mechanism rather than slow delivery (for example, Node failing to publish `exit` for taskkilled children), `windowsUnsupportedTests` remains the documented exclusion fallback.
