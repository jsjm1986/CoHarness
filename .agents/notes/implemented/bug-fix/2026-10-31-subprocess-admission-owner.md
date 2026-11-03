# Agent Note: Subprocess allocation retains its resource provider

Status: implemented

English | [中文](2026-10-31-subprocess-admission-owner.zh.md)

## Problem

A queued process or terminal permit can arrive after its resource provider is withdrawn or replaced. Cancellation alone does not detect a provider that stops serving new work without aborting an already granted lease. Allocation could then create a child under admission that the current Runtime no longer owns.

## Decision

The shared subprocess service captures its resource provider before waiting. After admission returns, a synchronous check immediately before invoking the process or terminal provider confirms the same underlying Cordis Service and current managed requirement. Fresh tracing proxies preserve that identity. A changed owner or missing required provider raises `ResourceAdmissionError` with reason `unavailable`, and the unused grant returns to its original provider. Caller cancellation keeps its existing error and cleanup behavior.

Independent allocation also rechecks whether resource admission appeared during the handoff. An old request cannot silently adopt new capacity. New requests resolve the current provider normally.

Asynchronous providers capture `captureAdmissionCheck(spec)` at entry and invoke it immediately before physical start dispatch. SSH checks after preparation and authenticated stream connection. After confirmed rollback, `rejectAfterCleanup(failure)` tells the shared service to return the permit and reject with the original failure; an unconfirmed rollback retains occupation. Resource-reporting failure preserves the original allocation failure alongside it. Failed ordinary SSH handles retire after confirmed range exit and stream closure, so rejected starts do not accumulate until provider unload.

The local provider also uses `rejectAfterCleanup` when ordinary argument/grace validation, terminal empty-program validation or either method's target environment validation rejects before launch. This includes null bytes in argv, cwd and environment keys or values; the original error class, code and message are preserved. No process exists at those points, so an uncertain report would retain unused capacity. Failures after physical allocation still require confirmed cleanup before capacity returns.

## Alternatives considered

**Reacquire through the replacement provider.** The old grant and its pending completion still belong to the original owner; moving the request would combine two allocations.

**Check only inside the admission helper.** Returning from that asynchronous helper creates another handoff before provider invocation. Withdrawal or cancellation during that interval still needs a final check.

## Consequences

Both allocation methods share the same ownership check without changing provider signatures, configuration or stored data. Existing process ranges remain responsible for confirmed cleanup and uncertain accounting. The [SDK transport ownership note](../architecture/2026-10-24-sdk-subagent-process-ownership.md) covers its separately owned private launch API, while the [model operation note](../architecture/2026-10-24-prepared-model-operations.md) covers model dispatch.

## Verification

Deterministic cases cover both allocation methods, withdrawal and replacement during queue waiting and grant handoff, newly managed independent requests and live traced Services. A Loader application uses real local Node processes and PTYs: stale admission creates no marker, while an unchanged provider launches normally. Immutable old compiled code creates the markers in all eight stale-owner cases. Cleanup cases retain Session attribution, terminal controls and uncertain occupation until a later confirmed close, including late allocation after caller cancellation. Local and SSH provider suites cover their public service consumers; these checks do not establish fresh physical Linux/Windows or production Gateway acceptance.

A second Loader application runs a real SSH helper and authenticated socket forwarding through a local carrier. Source and built flows refuse eight stale-owner starts before RPC dispatch, release original permits and preserve two normal process/PTY starts. Old compiled providers physically start every stale case. Unit cases preserve both failures when resource completion fails and retain unknown remote cleanup. The carrier does not validate OpenSSH encryption or a separate physical host.
