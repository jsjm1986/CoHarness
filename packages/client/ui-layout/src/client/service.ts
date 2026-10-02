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
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { DetailsOwnerProps } from './index.ts'
import type { createLayoutStore } from './stores.ts'

/** Identity shared by a sidebar panel entry and its main-slot occupant. */
export type MainPanelId = Branded<'MainPanelId'>

/** Root-scoped navigation state exposed to panel-aware components. */
export interface PanelInfo {
  /** Selected global panel; null displays the current Conversation. */
  readonly activePanelId: MainPanelId | null
}

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
  /** The frame's measured width in CSS pixels, from the same root store; the `rightbar` owner reads it for the auto-fullscreen rule. */
  readonly viewportWidth: HostObservable<number>
  /** Selected central panel from the same root store used by `usePanelInfo`. */
  readonly panelInfo: HostObservable<PanelInfo>
  /**
   * Select a global central panel without changing the current Session.
   * @param panelId - registered main key, or null to show the Conversation.
   * @throws if the selected main key is not registered; preserves the current selection.
   */
  selectPanel(panelId: MainPanelId | null): void
  /**
   * Start an asynchronous navigation, superseding any earlier pending navigation.
   * @returns a signal aborted by the next navigation or layout disposal; check it before committing UI state.
   */
  beginNavigation(): AbortSignal
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
  #rightbar: RightbarActions | undefined
  #navigation = new AbortController()

  /**
   * @param panels - actions of the instance shared with the root entry.
   * @param viewportWidth - root store's measured frame width source.
   * @param hasMainPanel - checks the live main-slot registry for a panel id.
   * @param panelInfo - root store's shared central-panel selection source.
   */
  constructor(
    private readonly panels: PanelActions,
    readonly viewportWidth: HostObservable<number>,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
    readonly panelInfo: HostObservable<PanelInfo>,
  ) {}

  /** Select a global panel or return to the Conversation. */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.#navigation.abort()
    this.panels.selectPanel(panelId)
  }

  /** @returns the new pending navigation's cancellation signal. */
  beginNavigation(): AbortSignal {
    this.#navigation.abort()
    this.#navigation = new AbortController()
    return this.#navigation.signal
  }

  /** Invalidate pending navigations when the layout owner is unloaded. */
  dispose(): void {
    this.#navigation.abort()
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.panels.toggleSidebar()
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
  focusRightbar(sessionId: SessionId): void { this.panels.focusRightbar(sessionId) }
  /** Report visible geometry from the tab owner. */
  openRightbar(track: boolean, fullscreen: boolean): void { this.panels.openRightbar(track, fullscreen) }
  /** Clear visible geometry without changing the tab owner's layout. */
  closeRightbar(): void { this.panels.closeRightbar() }

}
