/**
 * Pure concession-chain column solver for the AppFrame's column modes
 * (medium feeds details = 0 — its details panel is an overlay; compact
 * bypasses the solver entirely). Panels are stepped — open means the fixed
 * contract width, closed means 0 — so the chain has two steps: keep
 * center >= CENTER_MIN by auto-closing details (derived zero width — the
 * open preference is never rewritten, so widening the window restores it),
 * then let center absorb any remaining deficit below CENTER_MIN. The
 * sidebar never concedes: its rendered width is always SIDEBAR_DEFAULT (or
 * the collapsed rail when closed). The SIDEBAR_AUTO_COLLAPSE breakpoint is
 * consumed by AppFrame, which decides the effective sidebar preference
 * before solving; the solver itself stays breakpoint-free.
 */

import { VIEWPORT_EXPANDED_MIN } from './viewport.ts'

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 400
/** Sidebar open width. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail — the
 * medium/expanded boundary of the shared viewport classes (viewport.ts); a
 * manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = VIEWPORT_EXPANDED_MIN
/** Details open width. */
export const DETAILS_DEFAULT = 360

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar open preference (0 = closed; any non-zero value opens at SIDEBAR_DEFAULT).
 * @param details - details open preference (0 = closed; any non-zero value opens at DETAILS_DEFAULT).
 * @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number): Columns {
  // The sidebar is fixed at its open width (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : SIDEBAR_DEFAULT
  const d = details === 0 ? 0 : DETAILS_DEFAULT

  // Step 1: everything fits at its fixed width.
  if (s + d + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d, details: d }

  // Step 2: auto-close details (derived — preferences untouched); center
  // absorbs any remaining deficit (may drop below CENTER_MIN).
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 }
}
