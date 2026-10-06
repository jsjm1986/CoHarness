# Agent Note: Symmetric chat-width handles and ratio-sized details panel

Status: implemented

English | [中文](2026-10-02-symmetric-chat-handles-ratio-details.zh.md)

## Problem

Two conversation-surface behaviors diverged from upstream rc1. The transcript width control was a single centered grip on the content column's right edge — an earlier local design that avoided full-height side strips. The details panel (terminal, file preview, tool surfaces) used fixed pixel geometry: a 360px default inside a 300–520px range with a 640px center floor, so on a 1440px-class viewport the panel could never exceed about a third of the window, which cramped wide content such as diffs and terminals.

## Decision

Both surfaces now follow upstream's geometry while keeping the fork's persistence backend.

- **`ConversationRoot` owns two `WidthHandle` strips** (left and right) over the scroll region. Both write the one centered content axis: outward pointer travel on either side widens by twice the distance, so the pair behaves as one symmetric control. The gesture model is commit-on-release — `pointermove` rewrites only the `--dsh-chat-user-width` variable (rAF-throttled), and a press without travel never overwrites the stored preference with a column-clamped value. Pointer capture gates stray-pointer moves; `pointercancel`/`lostpointercapture` abandon the gesture uncommitted. The glow is a 3px gradient bar that rides the pointer's published Y, and fill mode (`chatFullWidth`) parks 12px strips inside the 16px side clearances so the affordance survives. Account-backed `chatContentWidth`/`chatFullWidth` persistence through `setDisplayWidth` is unchanged — only the commit point moved from move-time to release-time, and the drag ceiling is now `column width − 176px` edge budget instead of the raw settings range.

- **`ui-layout` details geometry is viewport-relative.** `CENTER_MIN` drops to 400px; the panel resolves at `max(300px, 45% of viewport)` while unset and clamps to 70% of the viewport, so a 1920px window opens the panel at 864px and permits 1344px. The store field became `details: number | null` — null means "never dragged", and the frame re-resolves the ratio per render so an untouched preference tracks window resizes. A dragged pixel preference survives close/open and viewport changes; the drag gesture starts from the concession-clamped rendered width, not the preference. The store also mirrors `viewportWidth` (fed by AppFrame's ResizeObserver) so `setDetails` clamps against the same ceiling the solver applies, and `narrowExpanded` replaces the boolean `narrow` for the manual sidebar override. The rightbar slot prop reports the would-be width (`normal.details`) even while closed, since the mounted-but-hidden occupant lays out against its opening width.

## Alternatives considered

**Adopt upstream's `localStorage` persistence for content width.** Rejected: the fork deliberately moved chat width into the account-transport `ui-conversation` settings section so preferences follow the account across ports and shared runtimes ([host-backed web preferences](../bug-fix/2026-08-06-host-backed-web-preferences.md)); reverting to browser storage would re-partition the preference per origin.

**Keep the fixed pixel range for the details panel.** Rejected: the 520px ceiling is the defect being fixed — wide viewports need proportionally more room, and a fixed cap cannot express that.

**Seed the ratio default into the store on first open.** Rejected mid-implementation: persisting `45%` of the first-opened viewport as pixels freezes a momentary window size into a permanent preference; leaving the field null until the first drag keeps the default tracking the live viewport, which is upstream's semantic exactly.

## Consequences

The transcript can be widened from either side, drag travel doubles the width change symmetrically, and an aborted or travel-less gesture cannot corrupt the stored preference. The details panel is materially wider on large windows (864px at 1920 vs the old 360px) and keeps a dragged choice across reload-free viewport churn.

A user who never drags sees the panel's width follow the window instead of a frozen number; that is intentional — the pixel preference only exists once explicitly chosen. The chat-width preference still bottoms out at the 560px settings floor even though handles visually clamp against the column edge budget first.

## Testing

`ui-layout` columns/store/AppFrame specs pin the ratio solve, concession chain, null-preference tracking, overlay widths, and would-be-width reporting (81 tests). `ui-conversation` skeleton specs cover both-side symmetric drags, capture-gated moves, commit-on-release, cancel restore, the 176px edge-budget ceiling, keyboard steps, fill-mode drag origin, and hero-phase absence.
