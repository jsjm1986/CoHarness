/** URL, history, and observability state for one Browser tab. */
import type { BrowserAddressFailure, BrowserTarget } from '../browser/url.ts'

/** Maximum retained application-known navigation entries per tab. */
export const MAX_BROWSER_HISTORY = 100

/** One canonical address in the application-managed Web history. */
export type BrowserHistoryEntry = BrowserTarget

/** Whether the current carrier document still corresponds to an application-known URL. */
export type BrowserNavigationStatus =
  | { readonly status: 'empty' }
  | { readonly status: 'loading'; readonly revision: number }
  | { readonly status: 'known'; readonly revision: number }
  | { readonly status: 'unknown'; readonly revision: number }

/** Address-policy or loading failure shown below the toolbar. */
export type BrowserFailure =
  { readonly kind: 'address'; readonly reason: BrowserAddressFailure }

/** One Browser tab's serializable URL state. */
export interface BrowserTabState {
  readonly entries: readonly BrowserHistoryEntry[]
  readonly index: number
  /** Last application-directed load; carrier observations do not rewrite it. */
  readonly request: { readonly revision: number; readonly target: BrowserTarget } | undefined
  readonly navigation: BrowserNavigationStatus
  readonly failure: BrowserFailure | undefined
}

/** Create the empty, serializable navigation state.
 * @returns state before a controlled navigation target exists.
 */
export function emptyBrowserState(): BrowserTabState {
  return { entries: [], index: -1, request: undefined, navigation: { status: 'empty' }, failure: undefined }
}

/** Read the current application-known entry.
 * @param state - current immutable tab state.
 * @returns the selected entry, when present.
 */
export function currentBrowserEntry(state: BrowserTabState | undefined): BrowserHistoryEntry | undefined {
  return state === undefined || state.index < 0 ? undefined : state.entries[state.index]
}

/** Determine whether application-managed Back navigation is available.
 * @param state - current tab state.
 * @returns whether a known preceding entry exists.
 */
export function canBrowserGoBack(state: BrowserTabState): boolean {
  return state.navigation.status !== 'unknown' && state.index > 0
}

/** Determine whether application-managed Forward navigation is available.
 * @param state - current tab state.
 * @returns whether a known following entry exists.
 */
export function canBrowserGoForward(state: BrowserTabState): boolean {
  return state.navigation.status !== 'unknown' && state.index >= 0 && state.index < state.entries.length - 1
}
