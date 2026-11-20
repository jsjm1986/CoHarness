/** Ephemeral input from a document that has not yet mounted its conversation slots. */

/** Address one authenticated document's tab-local Session selection pointer.
 * @param principalId - Gateway account.
 * @param runtimeId - exact Runtime allocated in this document.
 * @param scope - personal or project selector.
 * @returns the browser storage key for opaque Session identity only.
 */
export function managedSelectionStorageKey(principalId: number, runtimeId: string, scope: StartupDraft['scope']): string {
  return `dsh.sessions.current.v3.${String(principalId)}.${encodeURIComponent(runtimeId)}.${scope.replace(':', '-')}`
}

/** Input can move only once to a composer that has independently confirmed this owner. */
export interface StartupDraft {
  readonly principalId: number
  readonly runtimeId: string
  readonly nodeId: string
  readonly scope: 'personal' | `project:${number}`
  /** Previously selected root Session in this document's tab, when one was known. */
  readonly savedSessionId: string | undefined
  /** @returns the unsent input still held by the browser startup surface. */
  read(): string
  /** @param listener - observer for edits and withdrawal.
   * @returns unsubscribe callback owned by the caller.
   */
  subscribe(listener: () => void): () => void
  /** @param adopt - receiver that has qualified the owning account, Runtime and Session.
   * @returns true when the receiver accepted the text and now owns it.
   */
  transfer(adopt: (value: string) => boolean): boolean
}
