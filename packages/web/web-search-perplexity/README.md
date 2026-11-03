---
description: "Perplexity-backed search provider for the DeepSeek Harness web capability seam (ctx.web)"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-perplexity

English | [中文](README.zh.md)

A [Perplexity](https://perplexity.ai)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Perplexity's OpenAI-compatible `POST /chat/completions` endpoint and maps the generated answer plus citations into the seam's normalized `WebSearchResult`.

This implementation registers into `ctx.web` with `inject: ['web']`. Governed searches execute a prepared `perplexity-web-search` operation through the selected `ctx.llm` route; independent compositions retain the private chat-completions transport. The model-facing tool belongs to `dsh-tool-web`.

## Summary

With `dsh-web-search-perplexity`, the harness searches the web through Perplexity and gets a model-generated answer plus citeable sources in one call. Choose it when a deployment has a Perplexity API key and wants a generated answer. Perplexity has no result-count control, so the returned sources are truncated to the requested bound after the fact. When Perplexity omits structured result metadata, sources fall back to URL-only citations. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Config](#config)
- [Mapping](#mapping)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="config"></a>
## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | `perplexity` (governed) | Exact LLM route; configuring it or installing/requiring model policy selects governed execution. |
| `apiKey` | (unset) | Independent transport key; governed execution uses the LLM route credential. |
| `apiKeyEnv` | `PERPLEXITY_API_KEY` | Independent credential reference; uses the credentials service when mounted, otherwise the launch environment. |
| `baseURL` | `https://api.perplexity.ai` | Endpoint base; `/chat/completions` is appended. An unparseable value makes the provider unavailable. |
| `model` | `sonar` | Search model name. |
| `maxTokens` | `1024` | Upper bound on generated answer tokens (`max_tokens`). Must be a positive integer. |
| `maxResponseBytes` | `16 MiB` | Positive safe-integer cap (up to 256 MiB) on each success or error response body; chunked responses are cancelled when they cross it. |
| `searchRecency` | (unset) | Recency window sent as `search_recency_filter`: `day`, `week`, `month`, or `year`. Unset sends no filter. |

```yaml
- id: web-search-perplexity
  name: '@deepseek-ai/dsh-web-search-perplexity'
  config:
    apiKeyEnv: PERPLEXITY_API_KEY
```

Governed calls use the LLM route endpoint, model and credential, sharing model policy, resource admission, execution attribution and usage middleware. Explicitly configured pi-ai `openai-completions` routes implement the operation; other protocols and catalog routes relying only on native login refuse it explicitly. Independent endpoint and key settings do not override the governed route. Independent transport resolves credentials after its model permit is granted and joins cancellation during unload.

Independent requests retain their resource provider across admission and credential waits and recheck current ownership and model-policy requirements before HTTP. Withdrawal, replacement or newly installed admission refuses stale dispatch with `WEB_PROVIDER_ERROR` and returns unused capacity to the original owner. A newly required model policy also refuses independent dispatch. After restoring authorization, retry with a fresh search. Refusal before request recording adds no native input to the initiating Session.

<a id="mapping"></a>
## Mapping

`content` ← `choices[0].message.content` (the generated answer). `sources[]` prefers the structured `search_results[]` (`url`, `title`, `snippet`, `publishedAt` ← `date`), falling back to the URL-only `citations[]` array only when `search_results` is absent — those sources carry just a `url`, which is why `title`/`snippet`/`publishedAt` are optional on the seam. Provider failures surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. Perplexity has no result-count control, so `maxResults` is enforced by the seam (truncating `sources[]` and setting `truncated`).

<a id="model-experience"></a>
## Model Experience

### Auxiliary Perplexity request

#### What the model sees

A separate Perplexity model receives `<query>` verbatim as its sole user message through the chat-completions endpoint. This request is not part of the conversation model's context. The exact endpoint and JSON body are recorded as `web/perplexity-search-llm-request` before dispatch; governed execution appends it before model checkpoints.

#### Token effect

Separate provider tokens are incurred per search; `maxTokens` caps the generated answer. Governed execution reports actual input/output counters and credential source; absent usage stays absent.

#### KV Cache effect

Independent of the conversation request cache. An identical query under the same model route may reuse provider cache; a changed query or route establishes a different prefix.

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees the generated answer plus structured result metadata or URL-only citations. This provider's exact failures are `Perplexity search aborted`, `Perplexity search request failed: <error>`, and `Perplexity returned an unprocessable response body: <error>`; HTTP failures preserve the provider message. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Answer and source tokens are data-dependent, source count is service-bounded, and the retained result or error is resent until compaction.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Citation-fallback sources are URL-only** — when Perplexity omits structured `search_results[]`, sources carry no `title`/`snippet`/`publishedAt`, so the tool renders bare hostname labels.
- **Over-returned sources still cost tokens and latency** — with no result-count control on the wire, `maxResults` is enforced only post-hoc by seam truncation.
- **Only `model`/`maxTokens`/`searchRecency` are exposed** — Perplexity's other search controls (domain filters, `web_search_options` context size, images) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
