/**
 * Pure concession-chain column solver for the AppFrame's column modes
 * (medium feeds details = 0 — its details panel is an overlay; compact
 * bypasses the solver entirely). Chain order is fixed by contract: keep
 * center >= CENTER_MIN by shrinking details, then auto-closing it (derived
 * zero width — preferred width preferences are never rewritten, so widening
 * the window restores them). The sidebar never concedes: its rendered width
 * is always the drag preference (or the collapsed rail), and center absorbs
 * any remaining deficit as the last resort. Inputs are the layout store's
 * plain width preferences (0 = closed); a closed sidebar resolves to the
 * fixed SIDEBAR_COLLAPSED control rail while closed details resolve to zero
 * width. The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, which
 * decides the effective sidebar preference before solving; the solver itself
 * stays breakpoint-free. Details widths are proportional: the default and
 * drag ceiling are viewport ratios, so the panel tracks window size instead
 * of pinning a pixel range that starves wide screens.
 */

import { VIEWPORT_EXPANDED_MIN } from './viewport.ts'

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 400
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail — the
 * medium/expanded boundary of the shared viewport classes (viewport.ts); a
 * manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = VIEWPORT_EXPANDED_MIN
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling as a viewport ratio: the panel may fill most of
 * the window while a dragged width would still leave the handles and center
 * reachable. */
export const DETAILS_MAX_RATIO = 0.7
/** Details width before any user drag, as a viewport ratio. */
export const DETAILS_DEFAULT_RATIO = 0.45

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  // Details concedes everything beyond the center floor; the preference
  // clamps against the viewport ratio before the available-space squeeze.
  const available = viewport - s - CENTER_MIN
  const d = details === 0 || available < DETAILS_MIN
    ? 0
    : Math.min(
      available,
      clampWidth(details, DETAILS_MIN, Math.max(DETAILS_MIN, viewport * DETAILS_MAX_RATIO)),
    )
  return {
    sidebar: s,
    center: Math.max(0, viewport - s - d),
    details: d,
  }
}
