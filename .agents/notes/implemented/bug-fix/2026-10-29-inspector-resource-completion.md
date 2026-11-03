# Agent Note: Inspector cleanup retains unacknowledged resource completion

Status: implemented

English | [中文](2026-10-29-inspector-resource-completion.zh.md)

## Problem

An Inspector Worker can physically exit while its resource accountant is unavailable. Caching that failed completion permanently prevents the owner from returning occupied capacity after recovery. Failed startup has the same obligation when it transfers cleanup to the caller.

## Decision

The [Worker lifecycle](../../../../packages/experimental/inspector/src/host/bridge/lifecycle.ts) releases capacity only after physical exit. It shares pending completion, retains successful acknowledgement, and clears a rejected completion so an explicit cleanup call can retry. The [public handle](../../../../packages/experimental/inspector/src/host/bridge/controller.ts) follows the same rule. A failed close retains its cancellation listener and caller-owned cleanup; `InspectorStartupCleanupError.cleanup()` remains usable until completion succeeds.

The Host captures its resource provider before queueing and checks the same original Cordis Service before native allocation. A changed owner rejects with `ResourceAdmissionError` reason `unavailable`. Caller-owned `InspectorAdmission.assertOwnership` supports the same check for programmatic startup. An unused grant returns to its original owner; failed completion transfers retryable cleanup through `InspectorStartupCleanupError` before any Worker or MessageChannel exists. Startup cancellation and cleanup failures are retained together, including cancellation after readiness but before publication.

## Alternatives considered

**Release capacity when shutdown is requested.** A live or uncertain Worker still consumes the admitted resource.

**Cache every close result.** Idempotent success is useful, but a rejected accounting request does not establish completion.

**Retry indefinitely in the background.** The owner must observe failed cleanup and choose when to retry; hidden retries would outlive that ownership.

## Consequences

Callers retain a rejected handle or transferred cleanup and retry after the accountant recovers. Concurrent attempts coalesce, successful calls remain idempotent, and a recovered acknowledgement does not allocate a replacement Worker. A pending startup cannot adopt a replacement provider; it requires a fresh request. Public allocation and close methods keep their existing arguments, and the ownership callback is optional.

## Verification

Real Workers cover failed completion after endpoint closure, transferred startup cleanup, provider replacement, failed unused-grant completion and explicit recovery. The standalone [resource example](../../../../packages/experimental/inspector/tests/fixtures/resource-cleanup.mjs) uses a local HTTP accountant to observe occupied capacity until acknowledged recovery. The [Web composition](../../../../packages/experimental/inspector/tests/fixtures/startup-owner.mjs) verifies no stale Worker or readiness announcement, then starts a fresh request. Host plugin, controller and lifecycle tests meet the per-file coverage gate; the bundled-entry selector is covered by plain-Node application snapshots. The Windows environment dispatch case verifies metadata only; physical Windows startup remains platform validation.
