# Agent Note: Retain foreground question ownership through answer application

Status: implemented

English | [中文](2026-11-02-foreground-question-ownership.zh.md)

## Problem

A foreground question can outlive cancellation, its service or its calling Agent while an external answerer waits. Accepting that late answer can apply an obsolete plan approval. A question outside an active model turn also needs to prevent idle retirement of its Agent.

## Decision

`UserQuestionService` owns each foreground question until logical settlement. Answerers receive a signal combining caller cancellation with service and exact-Agent withdrawal. Every answerer continuation and accepted answer checks current ownership. Service disposal cancels accepted questions and joins their logical settlement; it does not wait for an answerer that ignores cancellation. Pending foreground questions and timed waits veto idle retirement of their exact Agent.

A same-turn typed answerer rejection retains its category, including Client dismissal and timed-wait outcomes. Cancellation otherwise settles by the next Host event-loop turn, while the answerer's signal aborts immediately. Late fulfillment cannot replace the selected result. The [runtime-root guard](2026-08-01-ask-user-delegated-caller-guard.md) remains the admission rule.

Plan review checks its own execution signal and exact live Agent immediately before selecting an exit. An answer that was valid when the question service returned cannot authorize a later mutation after caller withdrawal.

## Alternatives considered

**Delegate cancellation to every answerer.** An ignoring or disconnected answerer can otherwise hold a question forever or return a stale approval.

**Check the caller only before asking.** Deletion, replacement and cancellation can occur while waiting or between answer settlement and its Consumer's state write.

**Abort the caller's signal.** Service or timed-wait withdrawal closes that question without cancelling unrelated work in the calling Turn.

**Let cancellation erase a simultaneous domain rejection.** Dismissing a plan review and timing out a claimed wait have distinct continuation semantics; both retain their typed outcomes.

## Consequences

The [question service](../../../../packages/interaction/user-questions/README.md) and [plan Consumer](../../../../packages/plan/plan-mode/README.md) retain their method signatures, Session events and durable formats. Signal object identity changes at the answerer waterfall; its cancellation behavior is the supported interface. Current UI answerers use that signal to close their owned pending request.

Real Agent tests cover cancellation, service withdrawal, replacement, idle retirement and independent questions. The [runnable Loader composition](../../../../examples/headless-agent/tests/fixtures/interaction/question-lifetime/cordis.yml) exercises actual model-to-plan-review turns with a live approval and a late approval after cancellation, using local providers.
