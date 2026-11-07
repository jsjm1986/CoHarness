# Agent Note: Cancel pending document stream reads before releasing upload resources

Status: implemented

English | [中文](2026-10-23-document-stream-cancellation.zh.md)

## Problem

The public document `save` operation accepts an AbortSignal, but checking only before `reader.read()` cannot withdraw a stalled producer. The operation and its `.part` file remain live until the producer sends another chunk or fails.

## Decision

[`saveDocFile`](../../../../packages/attachment/userdoc-local/src/store.ts) binds cancellation to the acquired reader. Abort cancels a pending read; the operation rechecks cancellation after that read and before publication, awaits reader cancellation, releases the lock, and removes the partial file on failure. The [uploaded-document feature](../feature/2026-08-14-user-uploaded-documents.md) retains ownership of document references and the current resumable protocol.

## Alternatives considered

- **Race the read and abandon its promise.** Rejected: it leaves the producer and locked reader outside cleanup.
- **Poll the signal between chunks only.** Rejected: a stalled producer supplies no next checkpoint.

## Consequences

Cancellation can finish without another producer chunk. Producer cancellation remains cooperative: an asynchronous `cancel()` cleanup is awaited to quiescence. This applies to the public streaming `save` API; it does not change the main resumable upload protocol, document ids, or model context.

## Verification

The [store regression](../../../../packages/attachment/userdoc-local/tests/store.spec.ts) uses a zero-buffer stream and an explicit read barrier. It aborts only after the read starts, observes the producer's cancel reason, requires the save failure, and verifies that the partial directory is empty. Existing pre-abort, chunk-boundary cancellation, conflict, and size-limit cases remain covered.
