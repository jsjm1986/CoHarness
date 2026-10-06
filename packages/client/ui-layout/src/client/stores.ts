/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed), plus the details panel's nullable drag preference — null
 * means "no user choice yet", so the frame resolves it against the live
 * viewport ratio rather than a frozen pixel default. Module level exports the
 * factory only — a module-level handle would pin the store's identity in the
 * module cache (a de-facto singleton surviving plugin reloads). register()
 * receives the factory (exclusive use: the framework instantiates per entry),
 * AppFrame derives its PropsStore share from the return type, and the service
 * face receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { MainPanelId } from './service.ts'
import {
  clampWidth, DETAILS_MAX_RATIO, DETAILS_MIN,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Layout store state: column widths and auxiliary presentation reports, plus the
 * narrow-viewport pair — `viewportWidth` mirrors AppFrame's measured frame width
 * so actions can resolve ratio clamps and pick narrow semantics
 * (viewportWidth < SIDEBAR_AUTO_COLLAPSE), and `narrowExpanded` is the manual
 * override that opens the auto-collapsed sidebar without rewriting the width
 * preference: the medium mode renders it expanded over the squeezed center,
 * the compact mode as the overlay drawer (AppFrame owns that rendering split).
 * `details` is the user's pixel preference or null while untouched.
 */
type LayoutState = {
  /** Selected global center panel; null renders the Conversation. */
  panelInfo: { activePanelId: MainPanelId | null }
  sidebar: number
  details: number | null
  viewportWidth: number
  narrowExpanded: boolean
  detailsSessionId?: SessionId
  rightbarShown: boolean
  rightbarTrack: boolean
  rightbarFullscreen: boolean
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  selectPanel: (draft: LayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: LayoutState, panelIds: readonly string[]) => void
  focusRightbar: (draft: LayoutState, sessionId: SessionId) => void
  openRightbar: (draft: LayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: LayoutState) => void
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setViewportWidth: (draft: LayoutState, width: number) => void
  collapseNarrow: (draft: LayoutState) => void
}

/**
 * Create the frame geometry store. Auxiliary visibility belongs to the tab owner;
 * its presentation reports reserve or release the column without losing drag width.
 * Below the auto-collapse breakpoint the sidebar toggle changes its narrow override.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      panelInfo: { activePanelId: null },
      sidebar: SIDEBAR_DEFAULT, details: null, viewportWidth: 0, narrowExpanded: false,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    }),
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) {
          d.panelInfo.activePanelId = null
        }
      },
      focusRightbar: (d, sessionId: SessionId) => { d.detailsSessionId = sessionId },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        // `details` stays null until the first drag: the frame resolves the
        // ratio default against the live viewport each render, so an
        // untouched preference keeps tracking viewport changes.
        d.rightbarShown = true
        d.rightbarTrack = track
        d.rightbarFullscreen = fullscreen
        d.narrowExpanded = false
      },
      closeRightbar: (d) => {
        d.rightbarShown = false
        d.rightbarTrack = false
        d.rightbarFullscreen = false
      },
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      // Drag clamps land in the store (not only the solver) so a gesture on a
      // narrow window cannot stash an unreachable-wide preference.
      setDetails: (d, px: number) => {
        d.details = clampWidth(px, DETAILS_MIN, Math.max(DETAILS_MIN, d.viewportWidth * DETAILS_MAX_RATIO))
      },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout. The narrow
      // surfaces are exclusive — re-expanding the sidebar while the details
      // overlay is open swaps surfaces instead of pinning the conversation
      // into a strip between them.
      toggleSidebar: (d) => {
        if (d.viewportWidth < SIDEBAR_AUTO_COLLAPSE) {
          d.narrowExpanded = !d.narrowExpanded
        } else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // The frame reports its measured width here once per resize so actions
      // (ratio clamps, narrow semantics) resolve against layout truth.
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setViewportWidth: (d, width: number) => {
        if (d.viewportWidth === width) return
        if ((d.viewportWidth < SIDEBAR_AUTO_COLLAPSE) !== (width < SIDEBAR_AUTO_COLLAPSE)) {
          d.narrowExpanded = false
        }
        d.viewportWidth = width
      },
      // Explicit narrow dismissal (scrim tap, compact session navigation):
      // drops only the override, never the wide width preference.
      collapseNarrow: (d) => { d.narrowExpanded = false },

    },
  })
  return handle
}
