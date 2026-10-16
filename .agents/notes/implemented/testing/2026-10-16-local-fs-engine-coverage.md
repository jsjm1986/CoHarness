# Agent Note: Local document engine coverage closes over shared-scan and lifecycle branches

Status: implemented

English | [中文](2026-10-16-local-fs-engine-coverage.zh.md)

## Problem

`packages/attachment/userdoc-local/src/local-fs.ts` sat at 84% statement and 47% branch coverage under the per-file 100% gate. The uncovered region was not scattered dead code: it was the cancellation contract of `SharedRead` (aborted-waiter arrival, last-departing waiter tripping the scan, non-Error reason wrapping, `cancel` before and after settle), the maintenance-sweep body (`attach` interval guard, purge failure swallow, task bookkeeping), disposal joining in-flight scans and a pending sweep, `ensureReady` retry after a failed first initialization, and the `completeUpload`/`cancelUpload` invalidation surface. The gaps went unnoticed because the introducing pull request never reached a completed coverage run.

## Decision

`tests/local-fs.spec.ts` exercises the engine directly rather than through the `LocalUserDocStore` service face, so cancellation and lifecycle state can be placed at deterministic points: deferred promises hold `listDocFiles`, `listDocDirectory`, `listTrash`, and `purgeDueDocuments` in flight via `vi.spyOn` on the source modules (the same technique `upload.spec.ts` uses for `withFileLock`), `vi.useFakeTimers()` advances the sweep interval synchronously while the sweep task itself stays real, and `dispose()`'s join of `trashSweepTask` and `activeReads` is the quiescent teardown point. The spec does not fake `node:fs` — `store-failures.spec.ts` owns that boundary.

Three unreachable branches that the coverage measurement correctly refused came out of the source rather than the spec: the `signal.aborted` re-check inside `SharedRead.wait`'s promise executor cannot observe a transition between the synchronous entry check and listener registration; `this.trashSweepTask === task` can only be true since the task field is written exactly once behind the `undefined` guard; and `this.ready === ready` can only be true since the field is reassigned only after the catch has already cleared it. All three are now unconditional statements.

## Alternatives considered

- **Sculpting the spec around the dead branches** — the three guarded statements have no reachable false arm in single-threaded execution, so any test claiming to cover them would have exercised only the true side and left the gate red; the honest fix is deletion.
- **Excluding the cancellation internals from the gate** — `SharedRead` is the piece of the package most likely to regress silently (a double-release or a leaked scan only surfaces under contention); it is exactly what the per-file threshold exists to pin.
- **Driving everything through the service face** — the `LocalUserDocStore` tests already produce the happy paths, but the service cannot place a waiter-abort before listener registration or keep a scan pending across a mutation; direct engine access is what makes the races deterministic instead of probabilistic.

## Consequences

Every cancellation and lifecycle branch in the engine now has a deterministic owner test. The gate caught real dead code and the removal slightly shrinks the file. What was given up: nothing user-visible — the deleted guards were inert, and no behavior changes.
