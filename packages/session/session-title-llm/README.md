---
description: "Shared model-execution policy for session-title providers: route, bounds, cancellation, request logging, and stream assembly."
kind: "package-library"
---

# @deepseek-ai/dsh-session-title-llm

English | [中文](README.zh.md)

Shared execution policy for model-backed session-title providers. It resolves the auxiliary route, caps the provider-prepared input, output, and end-to-end duration, keeps caller cancellation effective throughout streaming, records the exact model-visible request, and assembles the stream into content blocks plus the terminal finish. Title wording, message framing, length targets, reasoning selection, and output interpretation belong to each provider.

This package is a library, not a Cordis plugin. A provider plugin registers directly on `ctx.sessionTitle` and, inside its `generate(request)`, passes `{ system, input, messageSeqs, selectReasoningEffort }` to `executeSessionTitleLlm()`, so route, bounds, cancellation, request logging, and stream assembly cannot drift between providers.

## Summary

`dsh-session-title-llm` executes one prepared auxiliary title request under consistent execution controls. Each provider supplies its own system instruction, user input, source-message attribution, reasoning selection, and output interpretation. Every request carries `currentTitle`, the latest accepted title snapshot the service captured for the call, including an accepted fallback; a provider decides whether and how to use it. Operational errors, aborts, and unsupported finish reasons reject; `stop`, `tool-calls`, and `max-tokens` return to the provider for its own acceptance decision.


## Table of Contents

- [Route and failure contract](#route-and-failure-contract)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="route-and-failure-contract"></a>
## Route and failure contract


`provider` and `model` overrides are optional but must be supplied together as non-empty strings. Without that pair, the function uses the exact provider/model route captured from the current session's logged `request/header`; an explicit refresh before any route exists therefore needs overrides. The function measures the final prepared user input against `maxInputBytes` before logging or dispatch instead of truncating it. Timeout and caller cancellation are rechecked while consuming the stream and after it completes, so a late successful result cannot be accepted even if an interceptor or adapter ignores abort. The title request uses `maxOutputTokens` independently of the conversation's cap. Its route must have a registered adapter so `ctx.llm.prepareCall()` can resolve the request before it is recorded.


After route and input validation, the function appends a log-only `session/title-llm-request` event directly through `Session` before model dispatch. It contains the title-provider id, exact source seqs, route, system prompt, message list, output-token cap, and the resolved reasoning effort when the provider's selector returned one. Persistence observes the record eagerly; the append does not need a title-specific marker, cast, settlement queue, or flush. The dispatched envelope is deep-frozen, carries `purpose: 'session-title'`, and deliberately lacks dsh-agent-loop's process-local request identity. Interceptors stay aligned with the record while loop-only reconstruction observers do not compare it with the conversation header. The DeepSeek adapter maps that purpose to thinking-disabled so the small output budget is reserved for visible title text; other adapters own their purpose-specific behavior. A later model failure leaves the request record intact; validation failures that never become dispatchable requests do not create one. The event stays outside derived model history.


<a id="configuration"></a>
## Configuration

Every execution field is required except the paired route override; there are no library defaults. Each provider adds its own title-length target settings, which that provider's README documents.


| Key | Contract |
|---|---|
| `maxInputBytes` | Positive UTF-8 byte ceiling for the prepared user input. |
| `maxOutputTokens` | Positive auxiliary generation token cap. |
| `timeoutMs` | Positive end-to-end deadline within the runtime timer limit. |
| `provider`, `model` | Optional explicit route; both or neither. |


<a id="model-experience"></a>
## Model Experience

### Auxiliary title request

#### What the model sees

The title model receives the provider-owned system instruction and one user message containing the provider-owned input. The executor records and dispatches those exact values without reconstruction; the framing, length targets, and output instruction belong to each provider, which the [first-prompt](../session-title-first-prompt-llm/README.md) and [all-prompts](../session-title-all-prompts-llm/README.md) READMEs document.


#### Token effect

The auxiliary request consumes tokens according to the provider-prepared input size and `maxOutputTokens`. It is separate from the main agent request and does not add title text or framing to agent history. The executor applies the provider's selected reasoning effort, or the route's normal default when the selector returns `undefined`; a model that still reasons spends part of `maxOutputTokens` on it. The main conversation retains its configured thinking mode.

#### KV Cache effect

No main-request invalidation. Auxiliary cache reuse is provider-specific: this executor dispatches the provider's exact system prompt and input, so reuse depends on how each provider frames successive revisions.

## Known Limitations and Deferred Work

- The executor returns assembled content blocks and the terminal finish and does not accept or reject them; each shipped provider's README owns its acceptance policy.
- It rejects prepared input over `maxInputBytes` rather than truncating it.
- The executor applies the effort the provider returns and never chooses one; when the selector returns `undefined`, the route's normal default applies.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
