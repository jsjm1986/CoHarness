# Agent Note: SSH text streams allocate on consumption

Status: implemented

English | [中文](2026-11-03-ssh-text-stream-allocation.zh.md)

## Problem

Returning or throwing into an async generator that has never started does not enter its body or run its cleanup. Reserving a helper iterator before returning that generator leaves the reservation unowned when a caller discards the unread iterable. Repeated discarded reads can exhaust the connection's bounded text-stream capacity.

## Decision

The [SSH filesystem](../../../../packages/ssh/fs-ssh/src/index.ts) reserves its helper iterator inside the generator, on the first pull. Cancellation is checked before reservation. A caller that never starts iteration owns no remote handle; once started, completion or early termination retains the existing helper cleanup. File and admission errors are observed during iteration, matching the local streaming provider.

## Alternatives considered

**Keep eager reservation and rely on the generator's finally block.** The language does not execute that block when an unread generator receives return or throw.

**Raise the helper limit.** A larger bound delays exhaustion without releasing abandoned reservations.

## Consequences

Unused iterables consume no helper capacity and require no extra cancellation listener or wrapper state. Consumers must catch errors around iteration, not only around the promise returning the iterable. The helper protocol and its capacity bound remain unchanged. [Forwarding rollback](2026-10-31-ssh-stream-forwarding-cancellation.md) and [helper cleanup ownership](2026-10-31-ssh-helper-cleanup-ownership.md) govern separate transport and shutdown resources.

## Verification

Provider cases cover return, throw and cancellation before the first pull, along with ordinary completion and early stop. The [runnable Loader example](../../../../packages/ssh/fs-ssh/tests/stream-lifecycle.expected.e2e.ts) discards more unread iterators than the helper limit, then fills and releases the original capacity through the real helper. It also observes normal text, stale-version refusal and private-root removal on disposal.
