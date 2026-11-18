---
kind: upgrade-guide
description: "SDK run() routes slash-prefixed input to native commands instead of literal prompts."
---

# Route slash input through native commands in SDK run()

English | [中文](guide.zh.md)

## Change

`DeepSeekHarness.run()` and `Session.run()` in the TypeScript and Python SDKs now send input through `session/query`. Text whose first block begins with a registered command executes it natively and returns its command result; other text and content blocks keep the previous prompt behavior. Callers that passed command-looking strings such as `/compact` receive a command `RunResult` (its `finish_reason`/`finishReason` is `completed` or `error`) instead of a model turn.

The low-level `prompt()`/`session_prompt()` still submits literal text, including slash prefixes. New opt-in surfaces: `approvalRequests` exposes `approval/request` decisions to the client, and `onUserQuestion`/`on_user_question` answers `user-question/ask` batches. Wire peers gain `command/run`, `command/done`, and `session.query.completed`; a run completes at that notification, not at session idle.

## Migration

1. Audit `run()` calls that pass user-controlled or slash-prefixed strings. To keep a slash string literal, call the low-level prompt method or send it as an ordinary turn through another entry point.
2. To accept runtime approval decisions, pass `approvalRequests: true` at initialize and install `onRequest` (TypeScript) or read `next_request()`/`respond()` (Python). To answer runtime questions, install the user-question handler before `initialize`.
3. Update waiters that expect `session.status` idle after a command: settle on `session.query.completed` or the returned `RunResult`. Verify each affected call by running it once against the upgraded runtime and checking the result kind.
