/**
 * Viewport size classes: the shared width vocabulary between the frame's
 * layout decisions and feature CSS. AppFrame stamps the active class on the
 * frame root as `data-viewport`, so component CSS inside the frame selects on
 * `[data-viewport='compact'] &` without measuring anything itself. Floating
 * surfaces rendered outside the frame (portals) match the same thresholds
 * with media queries against these constants instead. Documented in
 * docs/web-styling.md#responsive-layout.
 */

/** Frame width classes, ordered narrow to wide. */
export type ViewportClass = 'compact' | 'medium' | 'expanded' | 'wide'

/** compact/medium boundary: phone-class layouts end below this width. */
export const VIEWPORT_MEDIUM_MIN = 768
/** medium/expanded boundary: the three-column desktop layout starts here (deepsuite LG). */
export const VIEWPORT_EXPANDED_MIN = 1024
/** expanded/wide boundary: wide-desktop layouts start here. */
export const VIEWPORT_WIDE_MIN = 1440

/** Phone height below which secondary chrome must use the short-screen density. */
export const VIEWPORT_SHORT_HEIGHT_MAX = 720

/**
 * Classify a frame width into its viewport class.
 * @param width - frame width in px.
 * @returns the class whose range contains the width.
 */
export function viewportClassOf(width: number): ViewportClass {
  if (width < VIEWPORT_MEDIUM_MIN) return 'compact'
  if (width < VIEWPORT_EXPANDED_MIN) return 'medium'
  if (width < VIEWPORT_WIDE_MIN) return 'expanded'
  return 'wide'
}

/**
 * Identify a compact viewport whose vertical space is short enough to need
 * reduced header and composer density.
 * @param width - frame width in px.
 * @param height - frame height in px.
 * @returns true for phone-width frames below the short-screen height.
 */
export function isShortCompactViewport(width: number, height: number): boolean {
  return width < VIEWPORT_MEDIUM_MIN && height < VIEWPORT_SHORT_HEIGHT_MAX
}
