/** Browser navigation preferences store identities only; the authorized directory supplies labels. */

/** Visible preferences resolved against the Runtime identities this account can currently browse. */
export interface SpaceNavigationPreferences {
  favorites: string[]
  recent: string[]
}

/** The selector reserves eight recent destinations before the complete space list. */
const RECENT_SPACE_LIMIT = 8
const RUNTIME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Discover saved identities for an authorized metadata lookup; these values never authorize navigation.
 * @param accountId - current verified account.
 * @returns favorites and the latest eight visits, without saved names or active selection.
 */
export function savedSpaceRuntimeIds(accountId: number): string[] {
  const ids = new Set<string>()
  const recent: Array<{ id: string; time: number }> = []
  try {
    for (let index = 0; index < globalThis.localStorage.length; index++) {
      const storageKey = globalThis.localStorage.key(index)
      if (storageKey === null) continue
      for (const kind of ['favorite', 'recent'] as const) {
        const prefix = `dsh.spaces.${kind}.v1.account:${accountId}.runtime:`
        if (!storageKey.startsWith(prefix)) continue
        const id = storageKey.slice(prefix.length)
        if (!RUNTIME_ID.test(id)) continue
        const value = globalThis.localStorage.getItem(storageKey)
        if (kind === 'favorite' && value === '1') ids.add(id)
        else if (kind === 'recent' && value !== null && /^[0-9]{1,16}$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0) recent.push({ id, time: Number(value) })
      }
    }
  } catch { /* Storage denial omits optional shortcuts; the account directory remains usable. */ }
  recent.sort((left, right) => right.time - left.time || left.id.localeCompare(right.id))
  for (const item of recent.slice(0, RECENT_SPACE_LIMIT)) ids.add(item.id)
  return [...ids]
}

function key(accountId: number, runtimeId: string, kind: 'favorite' | 'recent'): string {
  return `dsh.spaces.${kind}.v1.account:${accountId}.runtime:${runtimeId}`
}

/**
 * Read preferences only for authorized, already-discovered Runtime identities.
 * @param accountId - verified account whose browser preferences are read.
 * @param runtimeIds - current directory and current environment identities.
 * @returns favorites and recents without restoring withdrawn names or navigation state.
 */
export function readSpaceNavigationPreferences(accountId: number, runtimeIds: readonly string[]): SpaceNavigationPreferences {
  const favorites: string[] = []
  const recent: Array<{ id: string; time: number }> = []
  try {
    for (const id of new Set(runtimeIds)) {
      if (globalThis.localStorage.getItem(key(accountId, id, 'favorite')) === '1') favorites.push(id)
      const value = globalThis.localStorage.getItem(key(accountId, id, 'recent'))
      if (value === null || !/^[0-9]{1,16}$/u.test(value)) continue
      const time = Number(value)
      if (Number.isSafeInteger(time) && time > 0) recent.push({ id, time })
    }
  } catch { /* Denied storage omits optional navigation preferences; space discovery stays available. */ }
  recent.sort((left, right) => right.time - left.time || left.id.localeCompare(right.id))
  return { favorites, recent: recent.slice(0, RECENT_SPACE_LIMIT).map(item => item.id) }
}

/**
 * Record entry into one environment without changing another tab's selection.
 * @param accountId - verified account.
 * @param runtimeId - environment actually entered by this tab.
 */
export function recordSpaceVisit(accountId: number, runtimeId: string): void {
  try { globalThis.localStorage.setItem(key(accountId, runtimeId, 'recent'), String(Date.now())) }
  catch { /* Optional history may be unavailable without preventing work. */ }
}

/**
 * Toggle one favorite atomically without replacing preferences for other Runtime identities.
 * @param accountId - verified account.
 * @param runtimeId - current environment whose favorite key is changed.
 * @returns false when browser storage prevents saving the requested preference.
 */
export function toggleSpaceFavorite(accountId: number, runtimeId: string): boolean {
  try {
    const storageKey = key(accountId, runtimeId, 'favorite')
    if (globalThis.localStorage.getItem(storageKey) === '1') globalThis.localStorage.removeItem(storageKey)
    else globalThis.localStorage.setItem(storageKey, '1')
    return true
  } catch { return false /* The selector retains its previous saved state and offers a retry. */ }
}
