# Agent Note: Wide markdown tables break out to the transcript width

Status: implemented

English | [中文](2026-10-16-web-wide-table-breakout.zh.md)

## Problem

Four-or-more-column markdown tables keep their natural width and scroll inside their wrapper, but the wrapper itself capped at the 748px message column even when the transcript had hundreds of pixels of unused width on both sides. Deepsuite chat instead spans such tables across the whole transcript while keeping the table content's left edge aligned with the message column; this fork rendered the `md-table-wide` hook but had no breakout rule consuming it, so wide tables clipped at the column.

## Decision

The ChatView `.scroll` element is the transcript's anonymous inline-size query container, so `100cqw` inside an `md-table-wide` wrapper resolves to the transcript content width — the CSS stand-in for deepsuite chat's JS-measured `--dsl-virtual-list-width`. AssistantMarkdown computes `--dsh-table-spare` as half the surplus over `--dsh-chat-content-width`, clamps it to zero, widens the wrapper by `spare + lead`, and offsets the extension with a negative margin plus equal lead padding so the table still starts at the message column's left edge. Percentages resolve against the wrapper's containing block, so a table nested inside a list reaches the same transcript edges.

The painted `table` element — not the transparent full-width wrapper or its alignment padding — rises above the Conversation width handles, so only content that actually reaches a gutter claims it ([width-handle layering](../bug-fix/2026-10-16-transcript-width-handle-layering.md)). The scroll wrapper reveals its horizontal bar on hover or keyboard focus by toggling `overflow-x` itself (Chromium never repaints state-conditioned scrollbar styles); `scroll` rather than `auto` reserves the bar height even for a fitting table, keeping the row below stationary across hover and focus transitions.

## Alternatives considered

**Publish the transcript width through a ResizeObserver.** Deapsuite measures the virtual list in JavaScript; an imperative variable here would duplicate layout work the engine already performs for container queries and would publish one frame late under animation.

**Cap every table at the message column.** Preserves column purity but wastes the transcript's spare width on exactly the content that needs it — many-column tables either shrink to unreadable cells or scroll inside a fraction of the available space.

**Break out without lead alignment.** Extending the wrapper symmetrically without padding compensation would start the table content left of the message column's edge, breaking the vertical rhythm the reader's eye tracks.

## Consequences

`md-table-wide` is now a live breakout hook wherever AssistantMarkdown's `.body` hosts the transcript; other consumers of the same markdown renderer (workbench panes, job views) keep the plain in-column scroll because the breakout rule is scoped to Chat's stylesheet. Any `cqw` unit inside the transcript resolves against `.scroll`, including the renderer's 30cqw table-cell caps, which are therefore transcript-relative rather than viewport-relative. Below the message column the spare clamps to zero and the wrapper stays the column width, so compact and medium viewports see no sideways shift.

The `markdown-wide-table` browser scenario pins the fill/scroll/breakout relations, lead-padding alignment, keyboard scrolling, hover-revealed scrollbar, stationary fitting tables, the painted-content hit test, and page-zoom and high-DPI equivalence across a 1680/1100/640 viewport sweep; its layout wait reads the frame's viewport class because compact replaces the three-column track template. Unit specs already cover the renderer's column-count hook; the golden records relations and booleans, never pixels.
