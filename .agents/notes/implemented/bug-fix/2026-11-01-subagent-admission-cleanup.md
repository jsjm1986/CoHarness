# Agent Note: Retry retained one-shot cleanup before another admission

Status: implemented

English | [中文](2026-11-01-subagent-admission-cleanup.zh.md)

## Problem

A foreground Consumer can report disposal failure after collecting a one-shot result, then lose its handle. Catalog publication can also fail before the caller receives a handle. Retaining parent occupation prevents premature idle release, but another delegation can allocate more children while the earlier cleanup remains unconfirmed. Asynchronous directory preparation and cleanup also allow a provider registration to disappear before dispatch. Service withdrawal can finish while directory preparation or provider startup is pending; a retained service reference can then allocate after its originating service is gone. Foreground result collection can also outlive the service drain and transfer failed cleanup to an already-finished owner.

## Decision

The subagent runtime retains one cleanup lease per published run under the exact parent Agent object. Every disposal path shares the lease's pending attempt and successful completion. Failure retains the lease and permits another attempt, including a synchronous provider throw. A foreground Consumer hands its failed cleanup back through `retainFailedCleanup(parent, run)` before reporting the failure. Catalog publication failure transfers automatically because no caller receives a handle.

Another start for that parent retries handed-back failed leases before provider admission. Transfers made while retry listeners are collected are rechecked against the runtime-owned leases before dispatch. All selected attempts settle; any continuing failure refuses the new start. Holder-owned runs keep their existing controls. Concurrent retries coalesce, and a recreated Agent with the same Session id has separate ownership. The original handle remains idempotent after an admission-triggered retry succeeds. Service disposal drains adopted cleanup, including transfers during awaited batches. Its runtime-scoped idle listener ends with the drain.

Adopted failures own recovery registrations and an idle veto in the original parent scope, surviving runtime removal until confirmed release. Replacement runtimes collect and join original recovery before allocation. Parent-scoped listeners locate those registrations across runtime replacement; they own reuse and disposal when cleanup is confirmed. Parent teardown retries retained cleanup before unregistering listeners and collects transfers during each awaited batch. `subagent/cleanup-retain` offers retry operations and non-rejecting release confirmation to an existing exact-parent recovery, including a draining one. One listener claims each offer; no run handle changes owners. A departing parent creates no effects. If no recovery accepts a late hand-back, its original adopted lease starts the coalescing retry. A failed retry retains runtime ownership and occupation.

The start captures an effect-scoped provider registration, checks caller cancellation after cleanup, and compares the registration immediately before dispatch. Re-registering the same provider object creates another registration and cannot authorize a waiting request from the previous one.

The delegation tool retains a Host operation before child-model preflight and captures the exact admitting runtime. Preflight and child dispatch share its cancellation signal. Foreground calls retain that operation through result collection, disposal and failure hand-back; a background call releases it after registering its original-owner Job or accepting the continuable child. Published background holders keep their independent controls. Its child signal includes that operation’s runtime cancellation. Service withdrawal joins the Consumer’s settlement before draining newly transferred cleanup, so a published foreground run cannot hand cleanup to an already-finished scope. Holder-owned background controls remain independent.

Runtime withdrawal closes admission and aborts each still-pending operation through its own controller. The scope joins their non-rejecting completion promises before draining transferred cleanup. A late provider publication is disposed without catalog or lifecycle publication. The successful catalog commit releases runtime cancellation before lifecycle publication; a synchronous observer can withdraw the service without cancelling the committed run. Its caller cancellation remains connected.

Admission rechecks the exact-parent recovery set after every awaited cleanup batch. A hand-back added during that wait joins the same admission before provider dispatch; continued failure refuses allocation. Holder-owned background work stays excluded.

## Alternatives considered

**Drop failed occupation.** This permits idle release while child resources remain live.

**Retry periodically.** A background retry schedule needs separate deployment policy. A fresh delegation provides an existing explicit recovery trigger without another timer.

**Create a cleanup Job after failure.** Job capacity or controller withdrawal can refuse that late handoff. The existing retained run needs no new admission or ownership transfer.

## Consequences

Persistent handed-back cleanup failure refuses further one-shot starts for the same exact parent. Other parents retain independent admission. Published result values, lifecycle events, credentials, Session generations and schema versions stay unchanged. Existing background [Job termination retries](2026-11-01-subagent-job-cleanup.md) remain with their original holders and are excluded from admission-triggered cleanup. Matching subagent service and foreground Consumer builds are required for explicit transfer.

## Verification

Published and failed-catalog cleanup retain occupation and refuse another allocation until release. Concurrent callers share cleanup; cancellation, provider removal, replacement and same-object re-registration refuse stale dispatch. Another parent or same-id Agent replacement cannot acquire the old cleanup. Both SDKs run the normal foreground Consumer with real open HTTP child transports and verify closure before new allocation, plus provider replacement during directory preparation. Service and enclosing-owner disposal retain the idle listener while cleanup is paused and drain transfers made during that pause. Both SDKs also verify native response closure before service replacement. Complete original source and built subagent packages fail these scenarios.

The SDK preflight fixture withdraws only Core while a child-model adapter holds a native HTTP metadata response. Runtime cancellation closes that response and finishes adapter cleanup before withdrawal completes; no child or Job is created. Package barriers cover foreground, one-shot background and continuable preflight, provider replacement, allowed default routes and published background control.
