# Agent Note: The open-in-app pick persists after its launch and the hover label names the application

Status: implemented

English | [中文](2026-10-18-open-in-app-pick-commit-hover-label.zh.md)

## Problem

`OpenInAppAction` persisted a menu pick through `choose(id)` before the launch request settled, so a failed open replaced the last remembered application — the next primary click then launched an application that had just failed. The split button also kept its application-specific label on `aria-label` only; the hover Tooltip rendered the generic `open.tooltip` copy, so the hover text never named the application the button would open. Both diverged from the upstream `OpenTargetButton` contract, which awaits the launch before remembering a pick and hands the chosen application's label to the tooltip.

## Decision

The menu pick commits inside the launch promise's fulfillment: `onSelect` passes `choose` as the launch helper's success callback, so a rejected `open-in-app/open` POST leaves the persisted `dsh.open-in-app.choice` untouched and the next primary click launches the previously remembered application. In-flight coalescing is unchanged — a pick during a launch is ignored whole before any persistence can be requested — and the busy/error dress still wraps the same promise. The Tooltip's label is the same application-specific string as `aria-label` (`open.title` with the current application, `open.error` while a failure shows), matching the upstream `primaryLabel` placement.

## Files

- `packages/client/ui-open-in-app/src/client/OpenInAppAction.tsx` — the pick persists via the launch success callback; the Tooltip label shares the aria-label's application-specific text.
- `packages/client/ui-open-in-app/tests/open-in-app-action.client.spec.tsx` — the bench's selector shim now subscribes through `useSyncExternalStore` like the production binding, and new cases pin a failed pick leaving the remembered application, a successful pick being remembered, and the hover text naming the application.

## Alternatives considered

**Persist eagerly, then roll back on failure.** Restoring the previous id after a rejection adds a second write and still repaints the button to name the failed application mid-flight; withholding the write until fulfillment keeps one commit point and no repaint.

**Keep the generic tooltip.** The button already computes the application label for `aria-label`; showing a different generic string on hover told pointer users less than assistive technology announced, and diverged from upstream.

## Consequences

A failed custom pick no longer displaces the remembered application, and the hover copy names the exact application the primary click will open. The `open.tooltip` dictionary entry stays in both locales — upstream keeps the key — though the split button no longer renders it.

## Verification

`open-in-app-action.client.spec.tsx` covers a rejected pick preserving and re-launching the remembered application, a successful pick persisting and driving the next primary click, and the picked application's name appearing in the hover tooltip; the pre-existing tooltip case now asserts the application-specific label.
