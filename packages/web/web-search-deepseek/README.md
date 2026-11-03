---
description: "The DeepSeek-backed search provider for ctx.web: how deployments mount native DeepSeek web search through the Anthropic-compatible Messages API, with per-search credential resolution."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-deepseek

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-deepseek`, the harness searches the web through DeepSeek's native search using the DeepSeek account sign-in or an existing `DEEPSEEK_API_KEY`. Choose it when a deployment wants DeepSeek native search and accepts that one search costs a full model turn in latency and tokens; the DeepSeek Search and Fetch APIs in [dsh-web-deepseek-api](../web-deepseek-api/README.md) retrieve without one. Results come from the structured search blocks DeepSeek returns, never from scraping text out of a reply. A missing credential fails the call with a structured error; a response without a search-result block fails loudly rather than degrading. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `deepseek-official` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: deepseek-official`.

### When to choose it

Choose this backend for native server-side web search on a DeepSeek-compatible Messages route. Each search performs a complete model turn and up to `maxUses` server-side searches. Governed deployments select a configured LLM provider; standalone web compositions may use the independent API-key endpoint.

### Minimal configuration

Load the web service and provider. With `provider` configured, or model authorization installed or required, search uses the selected LLM route; the default route is `deepseek-official`. Its adapter owns the endpoint and credentials. Without those conditions, the configuration below resolves its own key through `ctx.credentials` or the launch environment and reads `DEEPSEEK_SEARCH_BASE_URL` independently of conversation settings.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://gateway.internal/anthropic/v1
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | omitted | Governed LLM route. The route must implement native Messages search; unsupported protocols or native-login authentication fail explicitly |
| `apiKey` | omitted | Standalone API key; prefer `apiKeyEnv`. A non-empty literal wins over `apiKeyEnv`; governed searches use their LLM route credentials |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | Credential reference resolved for each search through `ctx.credentials`, or from the process environment when that service is absent. A search that needs an API key and finds none fails as `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | Standalone Messages base; `/messages` is appended. Falls back to `$DEEPSEEK_SEARCH_BASE_URL`. Governed searches use the selected LLM route endpoint |
| `model` | `deepseek-v4-flash` | Anthropic-format model name |
| `apiVersion` | `2023-06-01` | `anthropic-version` header value |
| `maxTokens` | `4096` | Positive-integer upper bound on generated tokens for the Messages request |
| `maxUses` | `5` | Positive-integer maximum `web_search` server-tool uses per request |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-deepseek) lists every accepted field. Each search captures options from the live Config references.

<a id="authentication"></a>
### Authentication

Governed search retains the prepared LLM route's endpoint, model, credential reference and headers. Credentials resolve only during admitted execution; independent `apiKey`, `apiKeyEnv` and `baseURL` values do not override that route. Direct DeepSeek API-key routes and explicitly configured pi-ai Messages routes implement this operation. Provider-native login and other wire protocols fail explicitly when they cannot authenticate this native request.

Standalone search resolves a non-empty literal API key first, then the credential reference. It sends that key as `x-api-key` and `Authorization: Bearer`. The transport class also accepts adapter-owned `resolveHeaders`, which exclusively supplies authentication without account or key fallback.

### What a search returns

`content` is always omitted: DeepSeek's provider prose is not trusted as an answer. `sources[]` comes from `web_search_result` items inside `web_search_tool_result` blocks — `url` and `title` directly, and `publishedAt` from `page_age` — with snippets joined from URL-keyed `cited_text` entries where an excerpt exists. Results are deduplicated by URL, and because DeepSeek exposes no result-count knob, the service enforces `maxResults` by truncating and flagging.

### Request logging

Governed searches use ordinary LLM middleware, exact-route authorization, execution attribution, model admission and actual usage reporting. The initiating Session is captured before any wait. Policy or execution revocation during admission prevents HTTP dispatch, and a missing required policy never restores standalone dispatch. Each request acquires one model permit and retains it through response processing and cancellation. Unloading aborts and joins accepted searches and cleanup.

Independent searches retain their resource provider across admission and credential waits, checking current ownership and model-policy requirements immediately before dispatch. Withdrawal, replacement or newly installed admission refuses stale HTTP with `WEB_PROVIDER_ERROR`; unused capacity returns to the original owner. A newly required model policy also stops independent dispatch. Restore authorization and make a fresh search rather than transferring the old grant. Requests refused before recording add no native input to the initiating Session.

For an initiating Session, `web/deepseek-search-llm-request` records the exact endpoint, API version and secret-free body. Governed search appends it before model middleware, allowing the checkpoint policy to make it durable before HTTP; a refused attempt retains its recorded input. Standalone search appends after authentication and admission, immediately before HTTP. Headers and credentials are excluded. Actual provider usage is reported before result mapping; absent usage remains absent.

### Failures and recovery

Failures throw `WebError`: missing standalone credentials use `WEB_PROVIDER_CREDENTIAL_MISSING`, cancellation uses `WEB_ABORTED`, and model policy, provider or transport failures use `WEB_PROVIDER_ERROR`. The original model failure remains the cause for programmatic inspection. Redirects are rejected before contacting their target. Post-dispatch failures name the exact endpoint and direct the user to its owning model route settings for governed search, or the independent Web search settings for standalone search. The model must not choose or change an endpoint. The `web_search` Consumer owns the error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is built on two commitments:

- **Structured blocks only.** DeepSeek runs the search server-side and returns structured `web_search_tool_result` blocks; the provider parses those blocks and never scrapes URLs out of model prose. In strict mode, a response with no such block throws `WEB_PROVIDER_ERROR` instead of degrading.
- **Conversation credentials, resolved per search.** The provider adds no secret: a search from a Session on the account route uses that account's token, and every other search reuses the `DEEPSEEK_API_KEY` reference. The auxiliary request endpoint stays independent through `$DEEPSEEK_SEARCH_BASE_URL`. A mounted credentials service is authoritative; without one the provider falls back to the launching process environment. Resolving per call means a key stored or rotated in the Web Models page, or an account sign-in, reaches the next search without a restart.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema and per-search option capture |
| [`src/admission.ts`](src/admission.ts) | Session capture, model admission and accepted-search cleanup |
| [`src/provider.ts`](src/provider.ts) | The `DeepSeekSearchProvider`: Messages request dispatch, block parsing, citation joining, credential resolution |
| [`src/usage.ts`](src/usage.ts) | Validate actual provider token counts without inventing missing usage |
| [`src/types.ts`](src/types.ts) | Anthropic wire types for the search response |

### Request flow

Governed search prepares and records a native operation on its selected LLM route. Standalone search resolves its independent options after admission. Both use the same Messages serializer and result mapper: `web_search_tool_result` supplies sources, citations supply snippets, and the web service applies deduplication and source bounds.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-deepseek) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary DeepSeek search request

#### What the model sees

A separate DeepSeek model receives exactly `Perform a web search for the query: <query>` as its user text and one native `web_search` server-tool definition, with thinking disabled. This request is not part of the conversation model's context.

#### Token effect

Separate provider input and output tokens are incurred for each search; disabled thinking adds no reasoning tokens, `maxTokens` caps generated output, and `maxUses` caps native search uses.

#### KV Cache effect

Independent of the conversation request cache. The auxiliary instruction and native tool definition can form a stable prefix, but each changed query or model route prevents reuse from its first difference.

### Conversation tool result, indirectly

#### What the model sees

Through `dsh-tool-web`, the conversation model sees deduplicated URLs, titles, dates, and citation snippets from structured search blocks; provider prose is not trusted as an answer. This provider's exact failures include the actionable missing-credential message, which also names DeepSeek Account sign-in, `DeepSeek search credential resolution failed: <error>`, and `DeepSeek search aborted`. An HTTP 401 to an account-authenticated search appends an instruction to guide the user to sign in to DeepSeek again. Other request, HTTP, native-search, and response-body failures append the resolved endpoint and the conditional configuration instruction described above. The consumer owns the error wrapper.

#### Token effect

Zero direct conversation tokens from registration. Result tokens scale with returned sources and snippets, then the service enforces the requested source bound.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the provider is expensive or incomplete. They are current package constraints.

- **One search costs a full Messages model turn** — latency plus generated tokens, with up to `maxUses` server-side searches; [dsh-web-deepseek-api](../web-deepseek-api/README.md) uses the dedicated Search API instead.
- **Dynamic credential availability resolves inside the operation** — the synchronous availability check can establish that a resolver exists but cannot query an asynchronous credential store, so a selected keyless provider fails the search with `WEB_PROVIDER_CREDENTIAL_MISSING`; the stable `web_search` schema stays registered.
- **Over-returned sources still cost tokens** — with no result-count knob on the wire, `maxResults` is enforced only post-hoc by service truncation.
- **Sources usually carry no `snippet`** — a source gains one only when a text-block citation (`cited_text`) matches its URL, and DeepSeek's Anthropic-compatible endpoint returns text blocks without `citations`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Dedicated retrieval endpoint

DeepSeek's Search and Fetch APIs, which avoid the full model turn, live in [dsh-web-deepseek-api](../web-deepseek-api/README.md) and are selected by the Web search settings switch; this provider stays the default until the Search API launch is announced.

</details>
