/**
 * The root entry's transient layout store: panel open state as the contract
 * width or 0 (closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 */
import { defineStore, type EngineStoreHandle, type SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { DETAILS_DEFAULT, SIDEBAR_DEFAULT } from './columns.ts'

/**
 * Layout store state: panel open preferences (the contract default width, or
 * 0 = closed), plus the narrow-viewport pair — `narrow` mirrors AppFrame's
 * breakpoint reading (viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can
 * pick semantics, and `narrowExpanded` is the manual override that opens the
 * auto-collapsed sidebar without rewriting the preference: the medium mode
 * renders it expanded over the squeezed center, the compact mode as the
 * overlay drawer (AppFrame owns that rendering split).
 */
type LayoutState = { sidebar: number; details: number; narrow: boolean; narrowExpanded: boolean; detailsSessionId?: SessionId }

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  collapseNarrow: (draft: LayoutState) => void
  openDetails: (draft: LayoutState, sessionId?: SessionId) => void
  closeDetails: (draft: LayoutState, sessionId?: SessionId) => void
}

/**
 * Create the layout panel store handle. Panels are stepped — open means the
 * contract default width, closed means 0 — so reopening always restores the
 * default. Below the auto-collapse breakpoint (AppFrame feeds setNarrow) the
 * sidebar toggle flips the narrowExpanded override instead of the preference.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({ sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false }),
    actions: {
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout. The narrow
      // surfaces are exclusive — re-expanding the sidebar while the details
      // overlay is open swaps surfaces instead of pinning the conversation
      // into a strip between them.
      toggleSidebar: (d) => {
        if (d.narrow) {
          if (d.details !== 0) { d.details = 0; delete d.detailsSessionId }
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
      openDetails: (d, sessionId?: SessionId) => {
        if (d.details === 0) d.details = DETAILS_DEFAULT
        // The same exclusivity from the other side: the details overlay
        // replaces the squeeze-open sidebar / compact drawer rather than
        // sharing the narrow frame with it.
        d.narrowExpanded = false
        if (sessionId === undefined) delete d.detailsSessionId
        else d.detailsSessionId = sessionId
      },
      closeDetails: (d, sessionId?: SessionId) => {
        if (sessionId !== undefined && d.detailsSessionId !== sessionId) return
        d.details = 0
        delete d.detailsSessionId
      },
    },
  })
  return handle
}
