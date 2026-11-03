---
kind: upgrade-guide
description: "Retired authorization services and sessions refuse new interactions and credential writes."
---

# Authorization owner lifetime

English | [中文](guide.zh.md)

## Change

`ctx.authorization` refuses new flows and attempts with `WITHDRAWN` once stopping begins. Retained Session callbacks ignore notices and refuse questions or new commits after cancellation or settlement. An interaction's prompt receives cancellation from both the attempt and the question, and a late answer cannot resume a retired flow.

Disposal waits for the original flow and commit work. Each attempt keeps its original credential provider. An already-admitted write still completes there and reports its own outcome, including while a replacement provider becomes available. Record formats and keys are unchanged.

## Migration

1. Reacquire authorization services from the active context after provider reload. Do not reuse an earlier `AuthorizationSession` for another attempt.
2. Honor the prompt's `signal` in interaction surfaces. Settle owned flow work when its Session signal aborts, and keep `session.commit` as the credential writer.
3. Verify normal login, cancellation while asking a question, service withdrawal before storage, and successful completion of a write already admitted to its original provider.
