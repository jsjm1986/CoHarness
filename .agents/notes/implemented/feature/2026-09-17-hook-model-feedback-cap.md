# Agent Note: Hook-authored model text is capped by config

Status: implemented

English | [中文](2026-09-17-hook-model-feedback-cap.zh.md)

## Problem

Both hook bridges placed hook-authored text into model context with no bound: a merged blocking `reason` (which on an exit-2 hook is the captured stderr), each `additionalContext` entry (which on the Codex bridge includes plain stdout), and the Stop-hook steering text. A hook emitting megabytes of stderr or context text flooded the next model request, while only the persisted `stderrSummary` event field was capped.

## Decision

Each bridge accepts a `modelFeedbackMaxChars` config field (default `DEFAULT_MODEL_FEEDBACK_MAX_CHARS` = 2,000, validated positive at load alongside the other numeric fields) and caps every piece of hook-authored text at the point it enters model context — merged reasons on deny/ask/block, each `additionalContext` entry, and the forced-continuation reason. The shared `capModelFeedback` helper truncates with an ellipsis, matching `summarizeStderr`; the durable `hook/result` record is unaffected and keeps its own `stderrSummaryMaxChars` bound.

## Alternatives considered

**Cap at decode in `hook-protocol`.** Rejected: the bound is deployment-varying plugin config, and the codec has no access to bridge config; capping at the consumption point keeps one knob per bridge.

**Reuse `stderrSummaryMaxChars` for model-bound text.** Rejected: the persisted summary and the model-visible feedback are different budgets with different tolerances; conflating them would silently couple two surfaces.

## Consequences

Hook text reaching a model request is bounded per piece; a hook can still express a truncated reason, and the full stderr remains observable through the process itself rather than the event or the model. Deployments needing a different bound set it in cordis.yml like every other numeric knob.

## Verification

Both bridges' coverage cases reject non-positive `modelFeedbackMaxChars` at load and assert a 600-byte blocking stderr reaches the tool result capped at the configured length with the ellipsis.
