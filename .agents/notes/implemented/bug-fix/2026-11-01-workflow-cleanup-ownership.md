# Agent Note: Failed workflow cleanup retains its owner

Status: implemented

English | [中文](2026-11-01-workflow-cleanup-ownership.zh.md)

## Problem

Tool-plugin withdrawal can remove record listeners and their idle-release veto while accepted runs remain live, losing later member endings.

A child disposal failure leaves physical cleanup unconfirmed. Removing its handle prevents retry. Completing a background job after that failure also withdraws the job’s idle-release veto, allowing its owning Agent to retire while child work may remain active.

## Decision

The workflow host removes a child only after successful disposal and tracks disposal promises with pending child work. Concurrent public disposal calls share one attempt; a rejected attempt retains unfinished children for retry. The script result remains independent of cleanup confirmation.

Foreground Workflow and Ralph Consumers enter the exact engine’s `withForeground()` before starting. Engine withdrawal cancels and joins complete collection and cleanup transfer while retaining the exact parent. The PTC provider extends admission into its original subagent runtime, so runtime withdrawal cannot finish before a late cleanup hand-back. Independent raw starts and background Jobs keep holder controls.

Foreground workflow and Ralph Consumers synchronously transfer rejected cleanup through `WorkflowRun.retainFailedCleanup()` before discarding their handles. The original subagent service retains each failed lease under its exact parent. Its confirmation stays pending across failed attempts and fulfills after release; the workflow then confirms its own disposal. Consumers observe that promise outside the failed call. A later admission or service disposal retries the retained work without replaying scripts or child prompts. The workflow recorder retains its exact Agent and Session, vetoing idle release until confirmed cleanup appends one durable ending.

Durable record subscriptions belong to the original parent Agent scope, independently of tool registration. Each record releases its exact subscription disposers after finish or abandonment. Background parent teardown retains the subscriptions until the Job writes its final record; the Job keeps cancellation and cleanup controls. A foreground parent scope ending abandons an unfinished record instead of accepting later writes through that retired owner.

Transient progress subscriptions also belong to the original parent scope. Each mirror filters its exact run and writes only its original Job, surviving tool replacement and parent teardown until the producer stops it. Stopping after cleanup failure prevents progress events from replacing the recovery notice. Stopping releases subscriptions and never takes cancellation away from the Job.

A background workflow keeps its job live after disposal fails. It publishes an unconfirmed-cleanup notice, retains its owner and waits for another termination request to retry. Confirmed cleanup permits one failed job outcome and one durable run ending; the partial script value is withheld. The job’s `done` promise continues to mean that resources have been released.

## Alternatives considered

**Warn and complete the job.** A warning neither confirms cleanup nor preserves the owner’s idle-release veto.

**Reject the job’s `done` promise.** Registry containment treats that rejection as a producer violation; it does not supply the producer’s missing cleanup guarantee.

**Retry on a timer or abandon cleanup at a deadline.** Workflow cleanup has no implicit abandonment deadline. Explicit termination retries keep the existing control operation and avoid an unbounded automatic retry loop.

## Consequences

Persistent background cleanup failure keeps the job and owner live, including during owner or service teardown. Recovery requires another termination attempt after the underlying cleanup can succeed. Wire fields, event types and Session generations stay unchanged. The [durable workflow record decision](../feature/2026-08-10-durable-workflow-runs-in-chat.md) still requires run-end after quiescence; this decision retains that authority.

## Verification

Controlled host cases reject failed cleanup and retry the retained child. Job cases keep idle release busy and defer durable endings. Real Node PTC and SDK scenarios retain an open HTTP child transport, retry its cleanup and observe physical closure before one terminal record. Complete original workflow packages lose cleanup ownership or settle the job early.
