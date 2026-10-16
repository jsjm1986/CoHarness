# Agent Note: Composer-stack dock tooltips portal out of their stacking context

Status: implemented

English | [中文](2026-10-15-composer-stack-tooltip-portals.zh.md)

## Problem

The goal strip and the queue dock ride directly above the input card, and both create a stacking context (`isolation: isolate`) so their frosted panel stays behind their own content. A `Tooltip` bubble rendered inside that context resolves its z-index there, where the input card — painted later in the same parent context — wins: the goal strip's bubbles showed only a two-pixel sliver and the queue dock's stayed entirely hidden. The upstream fix is `5082e05f713`; the local `Tooltip` already carried the `portal` contract, but neither composer-stack consumer passed it.

## Decision

Every `Tooltip` in `QueueDock` and `GoalBar` now renders `portal`, so the bubble mounts under `document.body` where its z-index resolves above the whole card. The contract statement lives in `ui-primitives`' Tooltip JSDoc, which names ancestor stacking contexts beside clipping containers.

## Alternatives considered

**Raise the bubble's z-index inside the dock.** A stacking context cannot be escaped by z-index from inside; any value still loses to a later-painted sibling context. Only leaving the context — the portal — fixes the layering.

**Portal every tooltip globally.** Anchored bubbles that are not capped still benefit from staying near their anchor's layout (same scrollport, same transform space); the prop stays opt-in and callers near stacking contexts or clipping containers opt in deliberately.

## Consequences

The two docks' eleven tooltips now mount under `document.body`; ARIA captures scoped to `[data-queue-dock]` no longer contain them, so the `queue-actions` goldens dropped the tooltip lines while the scenarios gained an elementFromPoint hit test proving the bubble paints on top. The change is presentation-only: no props, events, or locales moved.

## Verification

`queue-dock.client.spec.tsx` and `goalbar.client.spec.tsx` each assert a hovered action's bubble renders under `document.body`. `queue-actions.e2e.ts` and `goal-bar.e2e.ts` assert via `expectTooltipOnTop` (support.ts) that both the bubble's center and bottom edge hit-test to the bubble itself; the queue `editing`/`ui` goldens no longer record dock-local tooltip entries. Focused specs pass.

## Related

- [2026-10-14 preset switch refusal toast](2026-10-14-preset-switch-refusal-toast.md) — the adjacent composer feedback surface, whose `Toast` always body-portals by design.
