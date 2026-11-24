# Agent Note: Floor the Windows taskkill helper timeout and add a direct-child kill fallback

Status: implemented

English | [中文](2026-11-24-windows-taskkill-delivery-floor.zh.md)

## Problem

`taskkillProcessTree` bounded its synchronous `taskkill` helper by the owning spawn's `graceMs` — the same budget callers shrink to 100–200 ms so tests exercise fast escalation. On the `windows-2025-vs2026` hosted-runner image `20261111.635`, helper creation plus execution routinely outlasts that budget: `spawnSync` then SIGKILLs the helper before it can deliver `/T /F`, the target tree stays alive, and `fallbackOwner.waitForExit` — deliberately unbounded because quiescence is the teardown postcondition — polls `child.exitCode` forever. Every `lsp-stdio` instance spec that reached forced teardown burned its full 180 s test timeout (14 of 24 tests on master, identical fingerprint on this stack), while the sibling `lifecycle.spec.ts` passed in ~16 s because the provider path terminates through `launchWindowsJob` job objects and never runs taskkill. `signalTree` also had no second delivery: when the helper could not start or could not reach the tree, nothing else settled the spawned child.

## Decision

`taskkillProcessTree` now floors the helper timeout at `TASKKILL_MIN_TIMEOUT_MS` (10 s): `Math.max(Math.ceil(commandTimeoutMs), TASKKILL_MIN_TIMEOUT_MS)`. The owner budget still bounds the helper (a hung taskkill is still killed) but can no longer throttle helper startup below a survivable floor. `signalTree`'s Windows branch additionally issues `child.kill(sig)` after taskkill — Node maps every signal to `TerminateProcess` on Windows, so when the helper silently fails the spawned child still publishes the exit the liveness loop observes; an already-exited child is swallowed like the POSIX fallback.

## Alternatives considered

- **Bound `waitForExit` after escalation** — treating "still alive after SIGKILL" as torn down would weaken the quiescence postcondition `LspInstance.forceTerminate` documents, and would mask genuinely unkillable trees instead of reporting them.
- **Windows-only spec exclusion** (`windowsUnsupportedTests`) — would green the lane while leaving the production fallback path with the same latent hang for every Windows caller without job-object containment.
- **Match the deadline-spec budgets** — the helper timeout assertions (`timeout: 41`, `47`, `1`) were updated to the floored value; keeping budget-equality was the defect, not the contract.

## Consequences

Windows fallback teardown keeps its quiescence guarantee and gains a delivery floor plus a direct-child backstop; `createWindowsProcessInspector` tiers retain the owner-budget binding because their callers pass real budgets, not escalation tests. The three `taskkillProcessTree` deadline assertions now expect the 10 s floor; the inspector tier assertions are unchanged. The fix heals both the spec's raw `spawnSubprocess` path and any production spawn that falls back from job-object containment.
