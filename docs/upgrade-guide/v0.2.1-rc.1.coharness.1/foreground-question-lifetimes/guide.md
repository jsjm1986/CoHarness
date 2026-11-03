---
kind: upgrade-guide
description: "Foreground answerers receive service-owned cancellation and cannot complete a withdrawn question."
---

# Keep foreground answers within their active question

English | [中文](guide.zh.md)

## Change

`UserQuestionService.ask()` supplies answerers with a signal combining caller cancellation, service withdrawal and disposal of the exact calling Agent. Its signal can differ from the caller's original object. Cancellation settles without waiting for an ignoring answerer, and late answers are refused. Retained references to a withdrawn service reject new questions with `ASK_ABORTED`; a disposed or replaced Agent cannot accept its old answer.

Foreground questions and timed waits prevent idle retirement until they settle. Plan review also rechecks cancellation and its exact live Agent before selecting an exit. Method signatures, question and answer fields, Session formats and settings remain unchanged.

## Migration

1. Rebuild matching `@deepseek-ai/dsh-user-questions` and `@deepseek-ai/dsh-plan-mode` artifacts.
2. Update custom `user-questions/request` answerers to observe the signal they receive. Compare its cancellation state rather than its identity with the caller's signal, and release the answerer's owned UI or transport work on abort.
3. Verify cancelling or withdrawing a pending question closes it even when a late approval arrives. Verify a live approval still leaves plan mode and that independent Agents' questions remain isolated. See the [question service](../../../../packages/interaction/user-questions/README.md).
