# Agent Note: Python SDK subscriber failure and EOF shutdown ownership

Status: implemented

English | [中文](2026-10-23-python-sdk-reader-and-shutdown.zh.md)

## Problem

One Python reader thread dispatches RPC replies and all notification subscriptions. A subscription filter can fail while its bounded queue is full. Blocking while publishing that failure prevents unrelated replies and subscribers from progressing. Runtime shutdown also needs a distinction between accepting the shutdown request and completing cleanup after stdin EOF.

## Decision

A failed filter removes only its subscription and publishes the original exception through the existing nonblocking terminal-queue operation. When necessary that operation drops one queued item to make room for the exception. The shared reader continues dispatching; a failed observer cannot apply backpressure to unrelated RPCs.

`HarnessClient.close()` requests shutdown, closes stdin, and waits for natural process exit before escalating to termination and kill. The existing `shutdown_timeout_seconds` bounds the acknowledgement, EOF grace, and post-termination phases individually. A child that completes EOF cleanup exits without a signal; an unresponsive child is still reaped.

The [SDK client decision](../feature/2026-07-27-typescript-sdk-and-sdk-subagent-backend.md) retains ownership of SDK layering and the TypeScript disposal ladder. The [resume and settlement decision](../architecture/2026-10-17-sdk-resume-and-settlement-wait.md) retains the runtime's descendant-drain and durable Session rules. Neither is superseded by these Python transport lifetime rules.

## Alternatives considered

**Block until the failed subscriber drains its queue.** A subscriber may never read again. It cannot own the liveness of the runtime's only reply reader.

**Terminate immediately after shutdown acknowledgement.** Acknowledgement does not establish process exit or completion of EOF-triggered cleanup. A bounded grace phase preserves that cleanup without creating an unbounded close by default.

**Add another shutdown timeout setting.** The existing setting already bounds shutdown phases; a new knob adds configuration without a distinct deployment requirement.

## Consequences

A terminal filter exception can replace queued notification data in the failed subscription. Successful subscriptions retain wire order. Close may consume each configured phase budget before escalation; initialization-timeout fixtures declare their own short teardown budget.

Real subprocess regressions fill a one-item subscription queue, throw from its next filter invocation, and verify another subscription plus the prompt reply. The EOF regression waits for a cleanup marker and a zero natural exit status; it is an ordinary passing test rather than an expected failure.
