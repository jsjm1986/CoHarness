# Agent Note: llm-replay binds per-child override sidecars into child script slots

Status: implemented

English | [中文](2026-11-15-llm-replay-child-override-slots.zh.md)

## Problem

`installLlmReplay` binds scripts positionally: slot 0 is the primary fixture (with `overrideFile` applied) and `session/created` announces subagent children into the later child slots. `subagent-interrupt-ui.e2e.ts` needs the inverse: the child holds turns open through scripted `hang` entries while the parent's single prompted turn replays a recorded call. Whole-script override existed only for the primary slot, so the child's `hang` script was parked on slot 0 where the unannounced parent claimed it first — the parent ate the hang, its turn never ended, and the child bound the parent's one-call fixture. Upstream passes the same test because its binding is purely call-order and the child happens to call first; the fork's announcement-based binding (required since named agents removed the session id from tool results) makes the inversion deterministic.

## Decision

`ReplayConfig.childOverrideFiles` is a parallel index to `childFiles`: `childOverrideFiles[i]` applies the same `ReplayOverrideDoc` semantics as `overrideFile` to child slot `i` — a bare `ReplayEntry[]` replaces that child's derived script, `{ patches }` swaps named call indexes over it. The shared `applyOverrideDoc` helper now serves both paths. The web scaffold passes it through as `replayChildOverrideFiles`. The test rewires honestly: `replayFixture` carries the parent's recorded turn (primary slot), `replayChildFixtures` carries a minimal child shell for ordering, and the six-entry script rides `replayChildOverrideFiles` into the child's announced slot — independent of which session calls the model first.

## Alternatives considered

- **Register the child into the next unclaimed slot at call time** — reproduces upstream call-order for this test, but abandons deterministic child binding whenever a child is created before the parent's first call; `{{session:N}}` materialization in later parent turns needs the child's slot fixed before that call.
- **Express `hang` inside a child JSONL** — `hang`/`throw` are override-only vocabulary by design; recorded streams cannot represent a deliberately held turn.

## Consequences

Nested-agent scenarios can now script child-side holds and injected failures without inverting slot order. The announcement-based binding is unchanged for every other scenario. The child's prompt text changed upstream (`Your final answer is delivered automatically…` replaces the parent-id `send_message` envelope); the affected e2e assertions and aria goldens were updated to the new envelope in the same change.
