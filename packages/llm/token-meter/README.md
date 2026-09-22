# @deepseek-ai/dsh-token-meter

English | [中文](README.zh.md)

Replay-aware token measurement through the singleton `ctx.tokenMeter` service. It advances one isolated fold per session from the durable log, so compaction and other pressure-sensitive plugins can share accounting without depending on `CompactionEngine`.

## Summary

Use `ctx.tokenMeter` to estimate a session's current request and context pressure or price one message. Measurements replay the durable session log under the current model route and execution environment without making model calls. When session projections are available, consumers can read `tokenUsage`, `contextPressure`, and `contextBreakdown`; text and routes without image pricing use an approximate fixed heuristic, declared visual-token pricing applies when available, and files are priced as current model-visible handle text when the LLM service is mounted. Provider-reported usage is reused only for an identical request envelope; the package adds no model-visible content and makes no loop decisions.

## Configuration

The estimator has no settings. It intentionally uses one fixed heuristic: four characters per token plus structural overhead for roles, blocks, and request-envelope fields. Any key is rejected; model capacity belongs to the adapter that owns an exact provider/model route and is available through `ctx.llm.resolveModelInfo().context`.

## Measurement contract

`ctx.tokenMeter` directly exposes two operations:

- `measure(session, requestHeader?)` returns request pressure and the current priced surface at one consumed-log revision.
- `estimateMessage(message)` prices one message with the fixed heuristic.

`measure()` synchronizes once and returns one detached, deeply immutable snapshot. `totalTokens` is request-and-response pressure, while `surfaceTokens` is the current surface total under request-time attachment pricing and equals the sum of `nodes[].tokens`. A `requestHeader` override changes pressure and route-owned image pricing; the node set still describes the current session. Every call clones the positional nodes, so measurement is O(surface).

File occurrences, including files nested in tool results, use `ctx.llm.fileRequestText()` on every measurement. The current surface and its usage anchor use the same execution-world path mapping; unavailable paths use the LLM service's explanatory handle. Without that service, file references retain their structural heuristic. `nodes[].heuristicTokens` always preserves the fixed reference price for the durable projection and compaction shadow-count consumers. The [file-pricing decision](../../../.agents/notes/implemented/bug-fix/2026-09-22-token-meter-file-request-pricing.md) explains why paths and their prices are not cached in the log.

The fold tracks full request-header snapshots, step boundaries, surface appends and replacements, successful assistant messages, provider usage, and the chunk seqs cited by each assistant message. Provider usage is reused only when the latest successful call's canonical request envelope matches the measured envelope and its total is no lower than that call's full heuristic anchor; a later success replaces the earlier anchor. Otherwise the complete current envelope and surface are estimated. Surface changes remain signed relative to a matching anchor, including negative deltas after shrinking replacements.

Usage accounting sums disjoint input, cache-read, cache-write, and output buckets; reasoning is not added again. Every successful call records an assistant anchor, including content-less calls. An explicit empty `sourceEventSeqs` list means a known empty provider stream, while an absent legacy list conservatively treats the durable assistant output as provider output.

## Session projections

When the composition provides `ctx.sessionProjections`, token-meter registers three units through an optional child fiber.

`tokenUsage` carries the complete durable log's `uncachedInputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. Usage chunks are counted even when a request later fails; an embedded `assistant/attempt` stream supplies the same usage when compact settlement is the only record, and a final assistant-message usage for the same attempt replaces that sample instead of double-counting it. `llm/retry-started` closes the replacement slot so a retried request in the same step is accumulated as a separate billed attempt. Reasoning remains an output subdivision. The single last-sample slot relies on a session-log ordering property: once a later step reports usage, a legal log never reports usage for an earlier attempt again.

`contextPressure` carries optional `pressureTokens` — the newest provider-reported prompt size, summing uncached input plus cache reads and writes — optional `projectedTokens`, and optional `contextWindow` from the newest `request/context` record. Both figures stay absent until a provider reports usage; capacity stays absent for a route whose adapter advertises none. Output is excluded, so `pressureTokens` holds still while a turn streams and steps forward when the next request reports its usage.

`projectedTokens` estimates the NEXT request's prompt: the sample plus the fixed-heuristic price of everything the surface gained or lost since it was taken, clamped at zero. Its bounded projection consumes durable append and shadow-price records through `surface-projection.ts`; it does not resolve request-time file paths or image pricing. Only the delta is estimated, so the figure stays anchored to the provider while reacting when content lands or compaction shadows a span. Compaction summarizes through a direct `ctx.llm.stream()` call and appends no usage of its own, so `pressureTokens` alone reports the pre-compaction prompt until a further turn completes. Occupancy displays read `projectedTokens`.

`contextBreakdown` carries fixed-heuristic `systemTokens`, `toolsTokens`, and `messageTokens` — the context's composition rather than its provider-billed size. The envelope figures reprice last-wins on every `request/header`; message prices follow durable surface appends and shadow counts. Attachment references keep their structural price, so these figures can differ from `measure().surfaceTokens`, which resolves current file handles and route-owned image prices. All three figures are estimates and need not sum to `projectedTokens`; CJK text and JSON schemas can underprice at four characters per token. Present them as an approximate composition, never as a total.

The browser-safe `deriveTurnTokenUsage()` fold aggregates only complete, durably recorded model attempts in one finished turn. It preserves exact totals and route attribution when every required field is present, and returns no disclosure value for incomplete or contradictory accounting.

All three units use the standard projection baseline, live frame, higher-seq-wins store, and JSON checkpoint paths. Unloading token-meter removes all three keys. A composition without the projection seam keeps the measurement service's existing behavior.

### Context occupancy is an approximation, by design

The occupancy fields are independent last-wins records and are **not** one atomic observation of a single request. Switching models pairs the fresh capacity with the previous route's sample until the next request reports usage, and `pressureTokens` describes the last request rather than the surface as it stands right now — `projectedTokens` carries that sample forward over the surface's movement, but its anchor is still the older request.

This is deliberate. An occupancy percentage is a user-facing reference figure, not a billing record or a gating input — nothing in the harness makes decisions from it, and compaction reads `measure()` instead. A UI computes occupancy by dividing measured pressure by the separately resolved capacity for the selected model.

The [Agent Note](../../../.agents/notes/implemented/architecture/2026-07-29-projected-token-usage-and-request-context.md) records the rejected atomic-pair comparison. Consumers that need an exact same-boundary figure should call `measure()` at their own request boundary rather than read this projection.

## Composition

```yaml
- name: '@deepseek-ai/dsh-token-meter'
- name: '@deepseek-ai/dsh-compaction-basic'
```

Both plugins have usable defaults. The meter remains independent of model routing and optional compaction. A deployment configures capacity on its LLM adapter and compaction policy on `dsh-compaction-basic`.

## Invariants

**Runtime invariant:** No companion is published. Each session's fold is a deterministic derivation of the durable log that can be refolded identically, so the meter publishes no observation independent of its source.

## Model Experience

Indirectly, through consumers such as `dsh-compaction-basic`; the service itself adds no prompt, message, schema, tool, or model call.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **The fixed heuristic is approximate** — content without reusable provider usage is priced by character count plus structural overhead, not an exact provider tokenizer or request serializer.
- **Every measurement clones the current surface** — coherent immutable snapshots make reads O(surface), including below-threshold pressure checks.
- **Provider usage is only reusable for an identical canonical envelope** — prompt, prefix, tools, provider, model, or call-config changes deliberately fall back to full heuristic estimation.
- **Missing legacy source seqs are handled conservatively** — assistant messages without `sourceEventSeqs` cannot distinguish provider output from listener rewrites, so the fold avoids claiming a known empty or exact chunk stream.
