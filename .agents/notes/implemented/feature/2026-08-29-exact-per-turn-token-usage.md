# Agent Note: Show exact token usage for complete turns

Status: implemented

English | [中文](2026-08-29-exact-per-turn-token-usage.zh.md)

## Problem

Session-wide token totals cannot answer what one turn cost, especially when a failed provider request is retried. Reconstructing the number from visible messages would miss billed attempts and could present an estimate as exact usage.

## Decision

Adapters preserve an optional exact `TokenUsage.totalTokens`: DeepSeek derives it only from safe prompt/completion counters that agree with any wire total, and pi-ai forwards its exact total. The browser-safe token-meter fold accepts only a complete durable turn lifecycle, counts every started attempt once across retry boundaries, and returns no value when usage is missing, unsafe, or contradictory. Optional cache, reasoning, and route fields appear only when every attempt supplies them. The completed-turn footer renders a compact disclosure and an expandable exact breakdown; it does not alter the session log or model request.

## Alternatives considered

**Subtract adjacent session-wide projection totals.** Rejected because page windows, compaction, retry replacement, and unrelated later steps make the subtraction ambiguous.

**Estimate missing attempts.** Rejected because the UI labels provider accounting, not heuristic pressure; a partial estimate would look exact.

**Count only finalized assistant messages.** Rejected because errored attempts can report usage before a retry and still incur billing.

## Consequences

Completed turns with complete accounting expose exact totals, cache share, route attribution, and optional reasoning detail. A turn with incomplete evidence shows no disclosure rather than a misleading value. Session-wide projections and Gateway billing remain unchanged.

## Testing

Adapter tests cover exact totals and contradictory DeepSeek totals. Pure-fold tests cover final-sample replacement, retries, multiple steps, optional buckets, unsafe values, and incomplete lifecycles. Browser tests cover compact and exact formatting, expansion, omitted fields, honest cache percentages, and keyboard operation.
