/**
 * Media-query subscription for JS-side branches that CSS cannot express:
 * floating surfaces rendered outside the shell frame (portals never see the
 * frame's `data-viewport` stamp) and pointer-capability decisions. Component
 * CSS inside the frame selects on `[data-viewport]` or container queries
 * instead of calling this (docs/web-styling.md#responsive-layout).
 */
import { useCallback, useSyncExternalStore } from 'react'

type MatchMedia = Window['matchMedia']

interface QueryEntry {
  readonly owner: Window
  readonly matchMedia: MatchMedia
  readonly list: MediaQueryList
  readonly subscribers: Set<() => void>
  readonly onChange: () => void
}

function addNativeListener(list: MediaQueryList, listener: () => void): void {
  const addEventListener = Reflect.get(list, 'addEventListener')
  if (typeof addEventListener === 'function') addEventListener.call(list, 'change', listener)
  else {
    const add = Reflect.get(list, 'addListener')
    if (typeof add === 'function') add.call(list, listener)
  }
}

function removeNativeListenerFromList(list: MediaQueryList, listener: () => void): void {
  const removeEventListener = Reflect.get(list, 'removeEventListener')
  if (typeof removeEventListener === 'function') removeEventListener.call(list, 'change', listener)
  else {
    const remove = Reflect.get(list, 'removeListener')
    if (typeof remove === 'function') remove.call(list, listener)
  }
}

/** One native listener per exact query while at least one hook is mounted. */
const queryEntries = new Map<string, QueryEntry>()

function currentMatchMedia(): MatchMedia | undefined {
  // The client bundle can be imported by the node-side test/compiler faces.
  // The DOM lib marks `window` as present, while those faces do not install it.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  const matchMedia = globalThis.window?.matchMedia
  return typeof matchMedia === 'function' ? matchMedia : undefined
}

function removeNativeListener(query: string, entry: QueryEntry): void {
  removeNativeListenerFromList(entry.list, entry.onChange)
  if (queryEntries.get(query) === entry) queryEntries.delete(query)
}

function createEntry(
  query: string,
  owner: Window,
  matchMedia: MatchMedia,
  subscribers: Set<() => void>,
): QueryEntry {
  const list = matchMedia.call(owner, query)
  const entry: QueryEntry = {
    owner,
    matchMedia,
    list,
    subscribers,
    onChange: () => {
      // Copying makes a subscriber free to unsubscribe during notification
      // without changing which listeners receive this browser event.
      for (const subscriber of [...subscribers]) subscriber()
    },
  }
  queryEntries.set(query, entry)
  if (subscribers.size > 0) addNativeListener(list, entry.onChange)
  return entry
}

function entryForSubscription(query: string, matchMedia: MatchMedia): QueryEntry {
  const owner = window
  const existing = queryEntries.get(query)
  if (existing !== undefined && existing.owner === owner && existing.matchMedia === matchMedia) {
    return existing
  }
  // A replaced test realm or browser shim must not strand mounted hooks on
  // the old MediaQueryList. Carry the subscriber set to the new list.
  const subscribers = existing?.subscribers ?? new Set<() => void>()
  if (existing !== undefined) removeNativeListener(query, existing)
  return createEntry(query, owner, matchMedia, subscribers)
}

function subscribeToQuery(query: string, onChange: () => void): () => void {
  const matchMedia = currentMatchMedia()
  if (matchMedia === undefined) return () => {}
  const entry = entryForSubscription(query, matchMedia)
  entry.subscribers.add(onChange)
  if (entry.subscribers.size === 1) addNativeListener(entry.list, entry.onChange)
  return () => {
    if (!entry.subscribers.delete(onChange) || entry.subscribers.size !== 0) return
    removeNativeListener(query, entry)
  }
}

function readQuery(query: string): boolean {
  const matchMedia = currentMatchMedia()
  if (matchMedia === undefined) return false
  const entry = queryEntries.get(query)
  if (entry !== undefined && entry.owner === window && entry.matchMedia === matchMedia) {
    return entry.list.matches
  }
  return matchMedia.call(window, query).matches
}

/**
 * Subscribe to a media query.
 * @param query - media query string, e.g. `'(pointer: coarse)'`.
 * @returns true while the query matches; false where matchMedia is
 * unavailable (jsdom and node e2e runs booting the client tree).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => subscribeToQuery(query, onChange), [query])
  return useSyncExternalStore(subscribe, () => readQuery(query))
}
