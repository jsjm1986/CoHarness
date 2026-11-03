# Agent Note: Background subagent cleanup stays retryable

Status: implemented

English | [中文](2026-11-01-subagent-job-cleanup.zh.md)

## Problem

A child result can settle while its transport or native process still needs disposal. Reporting a failed Job after disposal rejects closes its termination controls and publishes a durable ending without confirming release. The subagent service's retained run keeps idle release busy, but does not give the Job another cleanup attempt.

## Decision

The one-shot background Consumer retains the published run until disposal succeeds. A failure publishes an unconfirmed-cleanup progress notice and leaves `JobHooks.done` pending. Another termination request retries the same run's cleanup. A request received during pending disposal remains one coalesced retry until the failed attempt reaches its retry wait. Requests before that retry starts coalesce; another failure retains occupation until a further explicit termination request. Confirmed release permits one failed Job outcome, retaining independent result failure detail and withholding the child answer.

The existing outcome mapper receives a disposal function that waits for this confirmation. Its public API, the subagent providers and Job protocol stay unchanged. The [background registration decision](../feature/2026-07-08-background-subagent-tasks.md) still owns scheduling, authority and result delivery; the [workflow cleanup decision](2026-11-01-workflow-cleanup-ownership.md) independently owns WorkflowPtc child retention and workflow records.

## Alternatives considered

**Settle failed immediately.** A failure record describes an outcome; it cannot confirm resource release or preserve a terminal Job's termination control.

**Reject the completion promise.** Registry containment also terminates the record, leaving the producer's cleanup obligation unfulfilled.

**Retry automatically or forget the retained run.** Automatic retries need a new policy. Forgetting the run discards the only holder capable of confirming release. Explicit termination keeps the existing control operation.

## Consequences

Persistent cleanup failure can hold owner and service teardown until another termination attempt succeeds. The Consumer has no cleanup-abandonment deadline. No event, wire field, Session generation or database schema changes.

## Verification

Provider-controlled cases cover completed and rejected results, synchronous disposal throws and unrenderable failures. The shipped SDK profile keeps an owned HTTP child response open through failed cleanup, withholds durable Job settlement, retries termination and observes physical closure before the single failed ending. Both SDKs pin the progress and terminal detail. The complete original Consumer settles early and fails those same assertions.

Barriers place task, owner and registry termination inside a pending failed disposal. Repeated requests coalesce, and another failure keeps the Job live until a new termination request. SDK cases close the owned native response after one pending termination request, preserving completed or rejected child-result diagnostics.
