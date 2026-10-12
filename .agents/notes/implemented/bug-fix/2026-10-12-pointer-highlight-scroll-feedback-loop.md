# Agent Note: Pointer hover must not drive keep-visible scrolling

Status: implemented

English | [中文](2026-10-12-pointer-highlight-scroll-feedback-loop.zh.md)

## Problem

Both model pickers scroll the highlighted row into view on every highlight change, including pointer hovers. A hovered row already sits under the cursor, yet scrolling it fully into view shifts the rows beneath the stationary pointer; the browser re-fires hover on whichever row slides under next, which writes a new highlight, which scrolls again. The correction feeds on itself: the scrollport parks or oscillates away from the top and sticky group headings keep `data-stuck` with no user scroll. On contended CI runners the loop outlived `default-model.e2e.ts`'s reset poll, which observed the `/model` popup pinned mid-list throughout the window.

## Decision

`PopupState` records `activeViaPointer` on the last `active` write, and `PopupSelectView` runs its scroll-into-view correction only for non-pointer highlights. `highlight()` — the pointer entry — sets the flag; `move()`, `setSearch()`, options load, and load failure reset it, so keyboard and programmatic highlights keep the keep-visible correction the effect exists for. `ModelSelect`'s hover path marks the same provenance through a ref and focuses hovered rows with `preventScroll`, so neither the effect nor the native focus scroll can move content under the pointer.

## Verification

`popup.client.spec.ts` asserts the flag sets on `highlight` and clears on `move`/`setSearch`; `popup-view.client.spec.tsx` asserts mouseenter moves `aria-selected` without calling `scrollIntoView` while ArrowDown still scrolls. An instrumented browser run recorded the pre-fix loop (hover → scrollIntoView → new row under the pointer → repeat, parking at scrollTop 6) and, post-fix, hover with no following scroll — `scrollTop` stays at the reset position and `default-model.e2e.ts` passes.

## Alternatives considered

**Coalesce hover events into one highlight per frame.** Rejected: the loop needs only one scroll per hover to feed the next hover, so throttling slows the cycle without breaking it.

**Move the test pointer off the list.** Rejected: the loop is a product defect — a user resting the cursor on the picker while a row highlight settles gets the same scroll chase — so the owner of the scroll decision fixes it, not the test.

**Keep provenance inside each view.** Rejected: `active` already flows through `PopupState`; recording provenance there binds every producer (load, search, move, highlight) instead of duplicating the convention per consumer.

## Consequences

- Pointer hovers move `aria-selected`/`data-highlighted` without touching scroll position; keyboard and programmatic highlights retain keep-visible scrolling.
- `PopupState` gains `activeViaPointer`; future `active` writers must declare pointer or programmatic provenance.
- The [grouped fuzzy picker note](../feature/2026-10-02-grouped-fuzzy-model-picker.md) keeps ownership of grouping and sticky-heading mechanics.
