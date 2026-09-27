# Agent Note: Continue ACP cleanup after an exit observation fails

Status: implemented

English | [中文](2026-09-22-acp-exit-observation-cleanup.zh.md)

## Problem

A subprocess provider can lose an exit observation while its managed processes remain alive. Treating that rejection as the end of ACP cleanup skips termination. A rejected command outcome is also insufficient: the command and its managed range have separate completion signals.

## Decision

The ACP provider keeps its [consumer-owned cleanup ladder](../architecture/2026-07-27-dispose-ladder-to-consumer.md). A failed cooperative exit observation still leads to termination and the provider's final exit wait. Cleanup preserves a single observation error and aggregates errors from both waits in their observation order. A successful final wait proves quiescence but does not erase an earlier observation failure.

Cleanup observes command rejection without using it as an early return. The original `done` promise remains available to the startup or result owner for failure classification. Platform containment and observation guarantees remain with the subprocess provider; ACP does not infer them from the direct command's outcome.

The [execution-lane budget decision](../testing/2026-09-07-subagent-teardown-test-budgets.md) continues to govern timeout selection. EOF and termination grace periods are unchanged.

## Alternatives considered

**Stop cleanup at the first observation failure.** This reports the error promptly but leaves termination unrequested while owned processes can continue running.

**Treat a rejected command outcome as a failed spawn with nothing to reap.** Providers may reject command observation after a process has started. Only the provider's range observation can establish quiescence.

**Discard the first error after successful termination.** This hides a provider observation failure and reports a healthy cleanup path that did not occur.

## Consequences

Cleanup can reject after it has successfully terminated the child. Callers retain the original failure facts without sacrificing the remaining cleanup attempts. The helper stays inside the ACP provider; it adds no subprocess API, retry policy, or timer.

Real-process regression tests cover an initial observation failure, independently failing waits, and a rejected command outcome with a live child. A controlled final-wait barrier prevents disposal from settling early, while real exit outcomes prove termination. Startup tests preserve cancellation and protocol errors alongside cleanup errors. Native platform runs remain responsible for each provider's containment guarantees. Model-visible diagnostics and successful transcripts are unchanged.
