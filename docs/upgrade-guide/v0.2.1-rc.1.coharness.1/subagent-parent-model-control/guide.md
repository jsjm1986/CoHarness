---
kind: upgrade-guide
description: "All delegated model control classifications include parent execution authority, including authority-only profiles."
---

# Retain execution authority across subagent backends

English | [中文](guide.zh.md)

## Change

Required or installed execution authority requires parent model control even without model-access policy or resource admission. ACP and opaque Claude Code paths refuse one-shot startup, member creation and resumed inference with `UNSUPPORTED_CAPABILITY` before native allocation. Codex selects its parent-controlled Responses route, preserving allowed requests and refusing denied dispatch. Previously authority-only parents could start independent external inference.

`requiresParentModelControl(ctx)` centralizes this classification for opaque refusal, SDK bootstrap and native Codex model selection. Providers check their registration and actual Agent contexts where applicable.

## Migration

1. Rebuild matching `dsh-subagent`, `dsh-subagent-codex` and `dsh-subagent-dsh-sdk` artifacts together; their consumers require the shared export.
2. Use an in-process backend, the SDK backend or a compatible registered Responses route for governed delegation. Keep execution authority installed.
3. Custom external backends use `requiresParentModelControl()` to select supported parent control, or `assertExternalModelExecution()` to refuse unsupported inference. See the [subagent policy reference](../../../../packages/subagent/subagent/README.md#delegated-policy).
