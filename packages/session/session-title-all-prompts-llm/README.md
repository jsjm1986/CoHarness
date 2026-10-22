---
description: "All-user-messages LLM provider plugin for DeepSeek Harness session titles"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-title-all-prompts-llm

English | [中文](README.zh.md)

Optional `ctx.sessionTitle` provider that summarizes every eligible human message through `ctx.llm`. It registers the `all-prompts` cadence and starts a new revision after each new human prompt, using seeded history as well as child-session prompts. A newer revision aborts and supersedes older work; even a provider that ignores cancellation cannot commit stale output.

The plugin owns its system instruction, JSON framing, current-title anchor, and output parsing, and requires its own `targetWords` and `targetCjkCharacters` plus the shared [execution controls](../session-title-llm/README.md#configuration), all with no defaults. Omit both `provider` and `model` to inherit the exact route from each current logged main request, or set both to route title generation independently. If the final framed aggregate prompt exceeds `maxInputBytes`, the request fails instead of truncating history; automatic use warns and keeps the prior title.

## Summary

`dsh-session-title-all-prompts-llm` summarizes every eligible human message through `ctx.llm` as an optional `ctx.sessionTitle` provider. It registers the `all-prompts` cadence and starts a new revision after each new human prompt, using seeded history and child-session prompts. A newer revision aborts and supersedes older work, and even a provider that ignores cancellation cannot commit stale output. The plugin owns its system instruction, JSON framing, current-title anchor, and output parsing; it shares only the execution module from `dsh-session-title-llm` with the first-prompt provider. Automatic behavior and configuration come first; the implementation is a small provider strategy over that executor.

## Table of Contents

- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="model-experience"></a>
## Model Experience

### All-messages title request

#### What the model sees

The title model receives this provider's title instruction and a JSON array of all eligible human messages through the current revision, in log order with exact seqs. Seeded history is included. When `request.currentTitle` carries a provider-sourced title, the framing anchors it so an adequate existing title can survive regeneration verbatim; fallback and user-supplied titles are never anchored.

#### Token effect

One auxiliary request may follow every new eligible prompt, bounded per request by `maxInputBytes` and `maxOutputTokens`; explicit refreshes may add calls. It selects the route's least supported reasoning effort, or leaves effort unspecified when the route exposes none. The main agent request gains zero tokens.

#### KV Cache effect

No main-request invalidation. Auxiliary input grows or changes after each prompt, so provider-specific cache reuse ends at the first changed JSON token.

## Known Limitations and Deferred Work

- Input overflow retains the prior title; this provider has no summarization-of-summaries or retention policy for very long sessions.
- It treats all eligible human messages equally and offers no weighting, filtering, or manual-title precedence.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
