/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) — writes stay inside the store's
 * declared action set, delivered as the registration's bound actions.
 */
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { DetailsOwnerProps } from './index.ts'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open details, optionally pinned to an explicit Session.
   * @param sessionId - fixed target; omission follows current selection.
   * @param target - exact Tool address and optional close action for the auxiliary tab.
   */
  openDetails(sessionId?: SessionId, target?: DetailsOwnerProps): void
  /** Bind the sole auxiliary-panel owner; unloading releases only this registration.
   * @param owner - tab actions, distinct from the frame's geometry reports.
   * @returns registration release.
   */
  bindRightbar(owner: RightbarActions): () => void
  /** Select the auxiliary panel's explicit Session without changing the conversation.
   * @param sessionId - owning Session.
   */
  focusRightbar(sessionId: SessionId): void
  /** Report the tab owner's visible presentation to the frame.
   * @param track - reserve a column.
   * @param fullscreen - cover the viewport.
   */
  openRightbar(track: boolean, fullscreen: boolean): void
  /** Release the tab owner's visible column. */
  closeRightbar(): void
  /** Close details, optionally only when pinned to a given Session.
   * @param sessionId - target to release; omission closes unconditionally.
   */
  closeDetails(sessionId?: SessionId): void
}

/** Commands implemented by the one mounted auxiliary-panel plugin. */
export interface RightbarActions {
  /** Open one explicit tool call in its Session. */
  openDetails(sessionId: SessionId | undefined, target: DetailsOwnerProps | undefined): void
  /** Collapse the specified or currently presented Session's panel. */
  close(sessionId?: SessionId): void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  #rightbar: RightbarActions | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open details, optionally pinned to an explicit Session.
   * @param sessionId - fixed target; omission follows current selection.
   * @param target - exact Tool address and optional close action for the auxiliary tab.
   */
  openDetails(sessionId?: SessionId, target?: DetailsOwnerProps): void {
    if (this.#rightbar === undefined) throw new Error('layout: auxiliary panel owner is unavailable')
    this.#rightbar.openDetails(sessionId, target)
  }

  /** Close details, optionally only when pinned to a given Session.
   * @param sessionId - target to release; omission closes unconditionally.
   */
  closeDetails(sessionId?: SessionId): void {
    if (this.#rightbar === undefined) throw new Error('layout: auxiliary panel owner is unavailable')
    this.#rightbar.close(sessionId)
  }

  /** Register the sole auxiliary-panel owner. */
  bindRightbar(owner: RightbarActions): () => void {
    if (this.#rightbar !== undefined) throw new Error('layout: auxiliary panel owner is already registered')
    this.#rightbar = owner
    return () => { if (this.#rightbar === owner) this.#rightbar = undefined }
  }

  /** Bind the frame to the Session that initiated a panel action. */
  focusRightbar(sessionId: SessionId): void { this.#require().focusRightbar(sessionId) }
  /** Report visible geometry from the tab owner. */
  openRightbar(track: boolean, fullscreen: boolean): void { this.#require().openRightbar(track, fullscreen) }
  /** Clear visible geometry without changing the tab owner's layout. */
  closeRightbar(): void { this.#require().closeRightbar() }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
