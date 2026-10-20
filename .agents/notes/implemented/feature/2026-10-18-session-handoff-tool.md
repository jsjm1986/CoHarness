# Agent Note: Session-handoff tool with bounded local projection and optional auxiliary-model capsule

Status: implemented

English | [中文](2026-10-18-session-handoff-tool.zh.md)

## Problem

`session_search` finds which session contains a topic and `session_event_read` pages one event window, but neither answers the dominant follow-up intent "continue where that session left off." ZCode solves it with a dedicated `handoff` strategy that reads a transcript's tail and optionally lets an auxiliary model distill a continue-here capsule; our recall toolset had no equivalent.

## Decision

[handoff.ts](../../../../packages/session-query/tool-session-query/src/handoff.ts) adds a sixth model-facing tool, `session_handoff`, on the same authorization and timeout rails as the existing five. The local projection reads the authorized session's current surface once, keeps direct user and assistant conversation plus compact checkpoints, drops tool calls, reasoning, injected context, and other surfaces, then serializes the newest-first tail under a `handoffChars` budget so the briefing always opens at the latest state.

When an `llm` service and a routing target both resolve and `handoffExtraction` is on, the serialized conversation under `handoffExtractChars` goes to one auxiliary `session-handoff` request whose prompt asks for goal, decisions, files, state, and next step. Every failure mode — extraction disabled, oversized surface, missing service, empty capsule, request failure — returns the bounded local tail instead, so the tool never depends on the auxiliary path. `handoffTimeoutMs` covers projection and extraction together; the target session id revalidates after the read like every other operation.

## Consequences

- One new model-facing tool in the standard preset: every model request grows by one schema and one call-card presentation path.
- Sessions with an `llm` service and a resolvable routing target pay one auxiliary `session-handoff` request per call; deployments without either still return the bounded local tail at zero model cost.
- The briefing is a projection of the authorized session's current surface, so it inherits that surface's exclusions — shadowed and log-only events never reach the model.

## Alternatives considered

**ZCode's chunked map-reduce extraction.** ZCode splits long transcripts into up to five excerpts, extracts per chunk, then runs a second synthesis pass. That exists to digest multi-megabyte transcripts without an index; our surface projection is already bounded by `handoffChars`, so a single extraction pass covers the realistic input. A chunked pass would add a second model call and merge-failure mode for input the budget already caps.

**A `handoff` strategy flag on `session_event_read`.** The brief needs surface projection and a different output format, not a different window over raw events; a separate tool keeps both schemas small and lets the presentation card describe intent.

## Verification

`tool-session-query` specs cover local-tail ordering and truncation, checkpoint retention, skipped event categories, auxiliary extraction with request-header routing, disabled extraction, empty and oversized surfaces, extraction failure fallback, target revalidation denial, caller self-target, unreadable-target denial, configuration validation, cancellation, and the tool call-card presentation. Package tests pass 124 tests with 100% coverage on the new source; `docs/tool-catalog` regenerates with the sixth tool and `verify-cordis-config` accepts the composition.
