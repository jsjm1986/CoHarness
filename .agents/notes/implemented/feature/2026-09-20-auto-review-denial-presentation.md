# Agent Note: Present Auto-review denials through the generic Tool row

Status: implemented

English | [中文](2026-09-20-auto-review-denial-presentation.zh.md)

## Problem

Upstream `dsh-v0.1.6-alpha.2` teaches the Tool row to recognize the durable `AutoReviewDeniedError` / `AUTO_REVIEW_DENIED` identity and render a denied call as a localized rejection instead of an ordinary failure. The local `tool/ptc-dispatch` wire event already carries `error: { name, code, reason? }`, but the client projection dropped `error` entirely, so a denied call surfaced as a generic error whose keyed toolview could hide the denial behind a domain card.

## Decision

Port the upstream behavior onto the local renderer. `ToolCallTree` widens the settled node's `error` passthrough so `reason` reaches the browser; `tool-call-model` derives a locale-neutral `AutoReviewDenial` only from the exact `name`/`code` pair and accepts `reason` solely as a string (the durable record is read defensively, not trusted by type); `auto-review-denial.ts` normalizes and localizes the presentation. A denied call bypasses keyed `tool.call.toolview` dispatch and renders through `GenericToolCard`, which substitutes the denial summary/output and suppresses the args body — the call never executed, so its input is not evidence of anything the agent did.

## Alternatives considered

**Add `reason` to the runtime error contract and trust the declared type.** Rejected: `ToolResultNode.error.reason` is typed optional, but a durable record can hold a non-string value, so the model normalizes at the read edge instead of widening every consumer's assumptions.

**Let keyed toolviews handle denials themselves.** Rejected: the denial is uniform across tools and predates execution; duplicating the check in every keyed card would scatter one rule and still miss tools without a keyed view.

## Consequences

Denied calls read as rejections in both locales (`tool.autoReviewRejected`/`tool.autoReviewNotExecuted`/`tool.autoReviewReasonFallback`). Ordinary calls keep keyed dispatch and unchanged output paths. A new Auto-review error identity requires no further UI work only while it reuses the `AUTO_REVIEW_DENIED` code.

## Testing

`pnpm exec vitest run packages/client/ui-tool/tests/tool-row.client.spec.tsx` — 41/41 green, including denial rendering, reason normalization (CR/LF and U+2028/U+2029 collapse), and the keyed-toolview bypass. `pnpm exec tsc -b packages/client/ui-tool packages/client/runtime` is clean.
