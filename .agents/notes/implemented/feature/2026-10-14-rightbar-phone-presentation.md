# Agent Note: The rightbar's phone presentation is a pushed screen, not a shrunken dock

Status: implemented

English | [中文](2026-10-14-rightbar-phone-presentation.zh.md)

## Problem

Under 768px the right sidebar already auto-fullscreens (`AppFrame`), but it kept desktop chrome: 28px controls, a fullscreen-mode button that could only act as a second close while rewriting the recorded desktop mode, capsule guide entries floating mid-pane, and no swipe dismissal — the only exit was one small icon. The first attempt to drop the width-blocked split control used a stylesheet `display:none`; the strip's flex fill then absorbed the freed footprint, the next room measurement flipped the split verdict, the control re-rendered and re-occupied it — an infinite update loop (React #185) that unmounted the whole `rightbar.session` slot. The crash first looked like a test-selector problem because retained hidden session views leave stale expand buttons in the DOM.

## Decision

Treat the phone panel as a pushed screen, per the grammar in [the compact-density note](../architecture/2026-10-13-compact-density-refinement.md). `PanelChrome` swaps the docking glyph for a plain close glyph and omits the mode button under `autoFullscreen` — on that presentation the button can only stand in as a duplicate close that also poisons the desktop mode record. `SidebarPanel` attaches `useLeadingEdgeDismiss`: native touch listeners (React binds touch passive) gate on a rightward drag starting inside the leading 20px with vertical drift cancelling before any transform is written; the dragged nodes are the dockkit hosts that own the steady-state transform, and release closes past ~30% width or 0.35px/ms velocity, else animates back and clears every inline value. The guide's entries take the flat-list grammar — top-anchored full-width rows split by hairlines carried on the `.entryCell` wrapper so slot-provided entries (the terminal's own row) inherit the separator — and the strip's chips, controls, and tab-menu items move to compact geometry.

## Verification

`swipe-check.e2e.ts` drives real touch events through the whole sequence: drawer edge-swipe, sheet snaps, modal dismiss, a deep-content right-sidebar drag that must not close, and the leading-edge drag that must. `seat.client.spec.tsx` mounts at 390px and asserts the blocked split control is absent through the kit's `hideSplitWhenBlocked` render path; `compact-styles.client.spec.ts` asserts the stylesheet never hides it; `guide-styles.client.spec.ts` pins the flat-row contract. The measure-loop crash reproduced under the drawer→sheet→modal sequence and cleared once visibility moved to the kit path.

## Alternatives considered

**Hide the blocked split control in the stylesheet.** Rejected: that is exactly the loop above. `geometry.ts` already warns that `splitControlWidth` feeds the room verdict; `hideSplitWhenBlocked` exists so the measure pass keeps the footprint constant while the render path drops the node.

**Implement the dismiss gesture at the shell layer beside the drawer edge-swipe.** Rejected: the gesture's lifecycle is the panel's (`autoFullscreen && expanded`), its targets are the dockkit hosts inside the panel, and a shell-level listener would need to rediscover both. Panel-local keeps the edge zone, the transform owner, and the close action in one component.

**Keep the mode button as the exit affordance.** Rejected: two stacked close-lookalikes are worse chrome than one honest close, and `toggleFullscreen` persists a mode the desktop layout reads next ([docking note](2026-09-04-right-sidebar-docking-infrastructure.md)) — hiding it leaves the desktop record untouched.

## Consequences

- Phone strip controls are 36px, chips 32px, and long-press menu items reach the shared touch target; the strip band total is unchanged because the taller row comes out of its bottom padding.
- `SlotErrorBoundary` now appends `componentStack` to its crash log; slot render failures are diagnosable without recompiling React.
- Any future control whose visibility is decided by dockkit's room measurement must be hidden through the kit (`hideSplitWhenBlocked` or a peer flag), never through stylesheet rules — the measurement feeds on the layout the rule would change.
