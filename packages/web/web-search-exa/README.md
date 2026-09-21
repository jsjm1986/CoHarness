# @deepseek-ai/dsh-web-search-exa

English | [中文](README.zh.md)

An [Exa](https://exa.ai)-backed `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`). It calls Exa's `POST /search` endpoint with highlight contents and maps the flat `results[]` into the seam's normalized `WebSearchResult`.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-llm-deepseek`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Summary

With `dsh-web-search-exa`, the harness searches the web through Exa and gets vendor-native results with portable snippets and publication dates. Choose it when a deployment has an Exa API key and wants Exa's keyword or neural search. Exa returns no generated answer, so results carry no `content` — only citeable sources. A result with no non-blank highlight is dropped, so a call can return fewer sources than requested. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Config

| Key | Default | Meaning |
|---|---|---|
| `apiKey` | `$EXA_API_KEY` | Exa API key. Empty/absent makes the provider unavailable. |
| `baseURL` | `https://api.exa.ai` | Endpoint base; `/search` is appended. An unparseable value makes the provider unavailable. |
| `searchType` | `auto` | Retrieval mode sent as Exa's `type`: `auto` (Exa decides), `keyword`, or `neural`. |
| `numResults` | (unset) | Default result count when a request carries no `maxResults`. Unset sends no default. Must be a positive integer. |
| `highlightsPerResult` | `1` | Highlight sentences requested per result (Exa's `highlightsPerUrl`). Must be a positive integer. |
| `maxResponseBytes` | `16 MiB` | Positive safe-integer cap (up to 256 MiB) on each success or error response body; chunked responses are cancelled when they cross it. |

```yaml
- id: web-search-exa
  name: '@deepseek-ai/dsh-web-search-exa'
  config:
    apiKey: !!js process.env.EXA_API_KEY
```

## Mapping

Exa returns a flat `results[]` and no generated answer, so `content` is omitted. Each result maps to a `WebSearchSource`: `url` ← `url`, `title` ← `title`, `snippet` ← the first non-empty `highlights[]` entry (a result with no highlight has no portable snippet and is dropped), `publishedAt` ← `publishedDate`. A request's `maxResults` wins over the configured `numResults` default and is sent as Exa's `numResults` for a cost/latency optimization; the final bound is enforced by the seam. Provider failures (HTTP errors, network failure, unparseable or wrong-shape bodies) surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`.

## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, first highlights, and publication dates or its exact `Exa search aborted`, `Exa search request failed: <error>`, and `Exa returned an unprocessable response body: <error>` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **A result with no non-blank highlight is dropped entirely** — no portable snippet to map, so fewer sources than the requested count can return.
- **Only `searchType`/`numResults`/`highlightsPerResult` are exposed** — Exa's other controls (livecrawl, category, domain/date filters, full-text contents) wait on provider-neutral Service Definition fields ([seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md)).
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
