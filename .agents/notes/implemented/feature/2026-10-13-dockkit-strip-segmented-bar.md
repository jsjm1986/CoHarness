# Agent Note: Dock strip adopts the segmented-bar language and the panel clips its own corners

Status: implemented

English | [中文](2026-10-13-dockkit-strip-segmented-bar.zh.md)

## Problem

`b8b1715df87` (the inset-card redesign) restyled the frame and conversation surfaces but never reached `ui-dockkit` or `ui-sidebar-right`, so the right sidebar kept the older editor-tab language — bare chips, hairline slot separators, a flat `markdown-tag` active fill — while the conversation header and left sidebar moved to segmented bars with a raised sliding pill. The strip also drew no rule under itself, and the inset card's corners were dead geometry: each docked `.tabHost` paints an opaque square `bg-base` fill over `.panel`'s `radius-window` corners, and the panel must stay unclipped so `position: fixed` floating panes and the slide-off translation escape.

## Decision

`.stripTabs` becomes the segmented track (`interactive-bg-hover` fill, `radius-card`, 3px padding) around 24px chips in the bar's own type (`radius-control`, 500 weight, -0.01em). The selected chip — and a pane's lone unclosable label, which still names the content in view — wear the raised pill (`bg-raised`, `elevation-control`, `border-l3` stroke) instead of the tag fill. Slots shrink to 4px gaps that host only the drag caret; the hairline separators and the flush-era column-0 left border are gone. `.tabHostHeader` draws the single header rule (`border-bottom: 0.5px border-l3`) under docked strips and float headers alike. The strip's block insets join `inline-start` as published variables — `--dsh-dockkit-strip-block` (the band's total, default 38) and `--dsh-dockkit-strip-block-start` (the content's top inset, default 8) — so a host whose neighbour owns a taller header can grow the band without forking the sheet. The right sidebar publishes the conversation header's 52px (space-3 + the 32px titleRow + space-2) with the content top inset at space-3, which lands the hairlines under both headers on one line and the chip's track on the header's own top inset.

Inside the chip, the close shrinks to an 18px circle (12px glyph, 3px inset) and embedder leading glyphs settle at 14px — the icon, label, and close share one optical weight inside 24px. The split control's hand-drawn stroked square is replaced by the icon set's new `IconSplitPanesOutline16` (Lucide `Columns2`), so its stroke weight and corner radii match the strip chrome. The tab menu's items move to `radius-md`.

The corner clip moves to `.panelBody` (`overflow: clip; border-radius: inherit`, push presentation only): overflow never traps fixed descendants, so floats still escape, while docked hosts clip to the card's corners. Fullscreen keeps square corners. Guide capsules use `radius-full` instead of a hardcoded 24px.

## Alternatives considered

**Keep the editor-tab chrome and patch only the clipped corners.** Rejected: the disjoint look was the reported defect, and it leaves the docked strip in a visual language nothing else in the shell speaks.

**Clip `.panel` itself instead of `.panelBody`.** Rejected: overflow clipping traps `position: fixed` floating panes and the panel's slide-off translation inside the card, so the clip must sit one level below the pane host.

**Hardcode the right sidebar's 52px band height.** Rejected: any host whose neighbour owns a different header height would fork the sheet again; published inset variables keep the dockkit default unchanged for workbench panes and float headers.

## Verification

`strip-styles.client.spec.ts` asserts the contract lexically against the stylesheet on disk: the track, the 38px/30px metrics, the segment typography, the raised pill (and that `markdown-tag` is gone from `.tabActive`), the caret-only slot, and the header rule. Focused suites pass (530 tests across ui-dockkit and ui-sidebar-right), and a Chromium render of the compiled sheet confirmed the track, pill, hairline, and clipped corners.

## Consequences

- Every dockkit consumer — right sidebar, workbench panes, floating window headers — renders in the segmented-bar language; the style change is intentionally surface-wide.
- The close-slide animation now clips at the card's right edge instead of bleeding 8px past it.
- `.tabActive:hover` keeps the raised fill (a selected segment does not dim on hover); `.tab.floatTitle` and `.tabQuiet` keep their hover exemptions.
