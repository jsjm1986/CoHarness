---
description: "First-message LLM provider plugin for DeepSeek Harness session titles"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-first-prompt-llm

English | [中文](README.zh.md)

Optional `ctx.sessionTitle` provider that summarizes the first eligible human message through `ctx.llm`. It registers the `first-prompt` cadence, runs automatically only when a fresh non-fork session first creates its fallback, and attributes the result to that message's exact seq. An automatic failure retains the fallback and is retried only through `ctx.sessionTitle.refresh()`.

The plugin owns its system instruction, JSON framing, and output parsing, and requires its own `targetWords` and `targetCjkCharacters` plus the shared [execution controls](../session-title-llm/README.md#configuration), all with no defaults. Omit both `provider` and `model` to inherit the exact route from the current logged main request, or set both to route title generation independently.

## Summary

`dsh-session-title-first-prompt-llm` summarizes the first eligible human message through `ctx.llm` as an optional `ctx.sessionTitle` provider. It registers the `first-prompt` cadence, runs automatically only when a fresh non-fork session first creates its fallback, and attributes the result to that message's exact seq. An automatic failure retains the fallback and is retried only through `ctx.sessionTitle.refresh()`. The plugin owns its system instruction, JSON framing, and output parsing; it shares only the execution module from `dsh-session-title-llm` with the all-prompts provider. Automatic behavior and configuration come first; the implementation is a small provider strategy over that executor.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### First-message title request

#### What the model sees

The title model receives this provider's title instruction and a JSON array containing only the first eligible human message; it never receives a `currentTitle`. Later prompts and inherited fork history do not trigger another automatic call.

#### Token effect

At most one automatic auxiliary request is made for a fresh session, bounded by `maxInputBytes` and `maxOutputTokens`; explicit refreshes may make additional calls. It selects the route's least supported reasoning effort, or leaves effort unspecified when the route exposes none. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. The auxiliary request uses the configured or logged route and has provider-specific cache behavior.

## Known Limitations and Deferred Work

- The first message alone may cease to represent a long-running session; use the all-messages provider when later prompts should retitle it.
- A fork keeps its inherited title and never runs this provider automatically, even when its seeded first message came from the parent.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
