---
kind: upgrade-guide
description: "Session working directories supply the current execution directory, and tool presentation metadata also runs for nested PTC calls."
---

# Migrate working-directory configuration and tool presentation

English | [中文](guide.zh.md)

## Change

The `cwd` configuration key is removed from `@deepseek-ai/dsh-subagent-acp` and `@deepseek-ai/dsh-subagent-dsh-sdk`. A Session's current execution directory is supplied as required user context and is persisted separately from its original `Session.header.cwd`. The built-in `{{cwd}}` prompt variable is retained: it still resolves to the original project directory, while the effective directory arrives through the `working-directory:current` context.

New subagents use their start request's `cwd` when provided, otherwise they capture the parent's current directory. Existing processes keep their own directories. Changing the execution directory does not change the original project or grant additional write permissions.

Tool `output.presentationMeta` also runs for successful nested PTC calls. Authors whose projection assumes only native top-level calls are affected. A projection error fails that nested call with `ToolOutputError`; canonical program values and model content remain unchanged.

## Migration

1. Remove `config.cwd` from ACP and DSH-SDK subagent provider rows in your profile patches. To select a directory for one child, pass `cwd` in its [start request](../../../subsystems/subagent.md). To change the parent's execution directory, use `working_directory({ cd: "/absolute/project" })` before starting the child.
2. Run `working_directory({})` in the affected Session and confirm the reported directory. Start a child without an override and check its execution directory; use an explicit start `cwd` when the child must use another checkout. Read `Session.header.cwd` only for original project identity or permission roots, rather than current-directory operations. The [working-directory service](../../../../packages/session/working-directory/README.md) supplies the directory context.
3. Keep custom `output.presentationMeta` projections pure and return JSON-safe metadata from their arguments and canonical result. Exercise both a native call and a nested PTC call, and confirm the recorded metadata identifies the operation's actual target without changing its result.

Dynamic context providers are evaluated again at request admission, after pre-step listeners and route preparation. Return current state without relying on one evaluation per step. Transform registered context inside its provider; admission refresh replaces its cached text while preserving assembly-only context contributions and the accepted system prompt, tool schemas, and variables.
