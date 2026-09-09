/** Framework-neutral contract for a multi-session conversation viewport. */
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot } from './store.ts'

/** Center-surface presentation mode. */
export type ConversationViewportMode = 'single' | 'workbench'

/** JSON view state projected by the active viewport provider. */
export interface ConversationViewportSnapshot {
  mode: ConversationViewportMode
  paneIds: readonly SessionId[]
  activePaneId?: SessionId
  paneRatios: readonly number[]
}

/** Result of adding one Session to a bounded pane set. */
export type AddPaneResult =
  | { ok: true }
  | { ok: false; reason: 'duplicate' | 'limit' | 'unknown' }

/** Cordis capability consumed by conversation surfaces and navigation plugins. */
export interface ConversationViewport {
  readonly snapshot: ObservableSnapshot<ConversationViewportSnapshot>
  /** Switch presentation while retaining the saved pane set.
   * @param mode - requested presentation mode.
   */
  setMode(mode: ConversationViewportMode): void
  /** Add a visible, unarchived root Session; duplicates focus the existing pane.
   * @param sessionId - Session from the current authenticated list.
   * @returns acceptance or the reason no pane was added.
   */
  add(sessionId: SessionId): AddPaneResult
  /** Release a pane's history window without stopping its task.
   * @param sessionId - pane to close; absent panes are ignored.
   */
  remove(sessionId: SessionId): void
  /** Focus a pinned Session and synchronize the current Session selection.
   * @param sessionId - existing pane to focus.
   */
  focus(sessionId: SessionId): void
  /** Replace the active pane, or focus the target if it is already pinned.
   * @param sessionId - visible, unarchived root Session.
   * @returns acceptance or an unknown-session result; duplicates only focus.
   */
  replaceActive(sessionId: SessionId): AddPaneResult
  /** Move one pane within the retained order, keeping its width preference.
   * @param sessionId - existing pane to move.
   * @param direction - adjacent position; moving past an end is a no-op.
   */
  move(sessionId: SessionId, direction: 'previous' | 'next'): void
  /** Normalize positive width weights; invalid weights receive equal defaults.
   * @param ratios - width weights in pane order.
   */
  setPaneRatios(ratios: readonly number[]): void
  /** Finish account-catalog hydration before pruning restored foreign panes. */
  markCatalogReady(): void
  /** List user-owned named workbench layouts. */
  listWorkbenches?(): readonly { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }[]
  /** Return the active named workbench. */
  currentWorkbench?(): { id: string; name: string; paneIds: readonly SessionId[]; updatedAt: number }
  /** Switch to a named workbench layout. @param id - workbench identifier. */
  switchWorkbench?(id: string): void
  /** Create a named workbench layout. @param name - display name. @returns identifier. */
  createWorkbench?(name: string): string
  /** Rename a workbench. @param id - workbench identifier. @param name - display name. */
  renameWorkbench?(id: string, name: string): void
  /** Duplicate a workbench layout and activate the copy. @param id - source workbench. @param name - new display name. */
  duplicateWorkbench?(id: string, name: string): string
  /** Delete a workbench layout without changing Sessions. @param id - workbench identifier. */
  deleteWorkbench?(id: string): void
}
