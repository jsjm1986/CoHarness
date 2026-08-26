# Agent Note: Session list hides empty turns and resists stale archive snapshots

Status: implemented

English | [中文](2026-08-25-session-list-empty-content-and-archive-ordering.zh.md)

## Problem

The sidebar can receive workspace archive snapshots through a list baseline, an archive RPC response, and a host stream frame without a shared transport order. A shorter late snapshot can therefore make an archived row visible again. A session can also contain only turn boundaries, command records, or an admitted turn that produces no message; treating `turn/start` as conversation content exposes an empty history row and makes it eligible for the wrong UI state.

## Decision

The Host `SessionSummary.blank` predicate is based on non-empty messages produced by the session surface. Empty turns, command-only records, and usage-only assistant messages remain blank. Attached summaries and the `sessionListMetadata` projection use the same predicate, and the projection state version is `3` so cached values from the previous predicate are not reused. Gateway-backed cold listings additionally read authoritative `blank`, `visibleContentSeq`, and `lastPromptAt` metadata; local backends retain the bounded probe fallback.

The Client converts a row when it observes a non-empty session event, not when a prompt is merely accepted or an agent becomes running. It retains per-session engagement evidence while reconciling later list baselines, so a stale `blank: true` row cannot hide a session whose message event already arrived. Running state remains independent from blankness.

The archive registry only appends ids in the current API. The Client merges complete archive snapshots from all carriers: a superset supplies its order, a subset is ignored, and divergent concurrent snapshots retain both ids. A future restore operation must add an explicit revision/reset protocol before the client can remove ids.

## Alternatives considered

**Use `turn/start` as the blankness boundary.** Rejected because an empty or rejected turn records `turn/start` and `turn/end` without a user or assistant message, producing the empty rows this fix targets.

**Convert on prompt acceptance or `running: true`.** Rejected because admission and liveness precede pre-step filtering and can settle without a visible message; the durable message event is the earliest shared evidence.

**Replace every archive snapshot verbatim.** Rejected because RPC responses and stream frames have no common ordering, so an older complete snapshot can remove a newer archived id from the client mirror.

**Trust every cached blank hint for cold sessions.** Rejected because a checkpoint can lag the durable log; unavailable or oversized artifacts continue to degrade toward visibility until an authoritative index exists.

## Consequences

Sessions with no non-empty conversation message stay out of grouping, flat, and search surfaces while remaining available for New Session reuse. An attached interrupted or tool-bearing conversation remains visible when its surface carries a non-empty message. New browser drafts do not create a durable row until materialization; old blank rows remain recoverable for administrator dry-run and trash maintenance. Large or location-less durable artifacts that cannot be verified may still be visible; this preserves conversation recovery over aggressive cleanup.

Archive membership cannot be removed by the current Client mirror. Adding restore requires a versioned snapshot/reset path and a corresponding update to the merge rule.

## Verification

Focused runtime and Host tests cover concurrent archive echoes, stale frames before refresh baselines, empty completed turns, cold turn-only artifacts, event-based Client engagement, stale list reconciliation, authoritative content watermarks, deferred draft materialization, and preset locking after a real message. The assembled Web cold-session scenario seeds both a no-turn log and a closed empty turn through the shipped compressed JSONL composition and asserts that neither appears in the sidebar.

## Related

- [Deferred session drafts and authoritative content watermarks](../architecture/2026-08-26-session-draft-lifecycle-and-content-watermarks.md) — owns deferred persistence, cross-tab draft reservations, and the Gateway maintenance lifecycle.
