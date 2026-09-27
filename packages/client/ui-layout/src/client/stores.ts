/**
 * The root entry's transient layout store: panel geometry as plain widths in
 * px (0 = closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Layout store state: column widths and auxiliary presentation reports, plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick semantics, and
 * `narrowExpanded` is the manual override that opens the auto-collapsed
 * sidebar without rewriting the width preference: the medium mode renders it
 * expanded over the squeezed center, the compact mode as the overlay drawer
 * (AppFrame owns that rendering split).
 */
type LayoutState = {
  sidebar: number
  details: number
  narrow: boolean
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
  focusRightbar: (draft: LayoutState, sessionId: SessionId) => void
  openRightbar: (draft: LayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: LayoutState) => void
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
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
      sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false,
      rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false,
    }),
    actions: {
      focusRightbar: (d, sessionId: SessionId) => { d.detailsSessionId = sessionId },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        if (d.details === 0) d.details = DETAILS_DEFAULT
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
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout. The narrow
      // surfaces are exclusive — re-expanding the sidebar while the details
      // overlay is open swaps surfaces instead of pinning the conversation
      // into a strip between them.
      toggleSidebar: (d) => {
        if (d.narrow) {
          d.narrowExpanded = !d.narrowExpanded
        } else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      // Explicit narrow dismissal (scrim tap, compact session navigation):
      // drops only the override, never the wide width preference.
      collapseNarrow: (d) => { d.narrowExpanded = false },

    },
  })
  return handle
}
