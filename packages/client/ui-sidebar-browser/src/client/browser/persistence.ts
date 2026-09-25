/** Validated Browser history scoped by the same verified owner as the right Sidebar. */
import { z } from 'zod'
import { BrowserNavigation, MAX_BROWSER_HISTORY } from './BrowserNavigation.ts'
import { parseBrowserAddress } from './url.ts'
import { createBrowserStore, type BrowserState, type BrowserStore } from './store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const history = z.object({ entries: z.array(z.string()).max(MAX_BROWSER_HISTORY), index: z.int() })
const record = z.object({ version: z.literal(1), tabs: z.record(z.string(), history) })
const namespace = 'dsh.sidebar-browser.scoped.v1.'

function read(key: string | undefined, origin: string): BrowserState {
  const state: BrowserState = { byTab: {} }
  if (key === undefined || typeof localStorage === 'undefined') return state
  try {
    const raw = localStorage.getItem(namespace + key)
    if (raw === null) return state
    const parsed = record.parse(JSON.parse(raw))
    for (const [id, saved] of Object.entries(parsed.tabs)) {
      if (saved.index < -1 || saved.index >= saved.entries.length || (saved.index === -1) !== (saved.entries.length === 0)) continue
      const entries = saved.entries.map(url => parseBrowserAddress(url, origin))
      if (entries.some(entry => !entry.ok)) continue
      const targets = entries.flatMap(entry => entry.ok ? [entry.target] : [])
      const target = targets[saved.index]
      state.byTab[id as TabId] = { ...BrowserNavigation.empty(), entries: targets, index: saved.index,
        request: target === undefined ? undefined : { target, revision: 0 } }
    }
  } catch (_invalidOrUnavailableStorage) { /* Untrusted or unavailable browser storage never supplies navigation targets. */ }
  return state
}

function write(key: string | undefined, state: BrowserState): void {
  if (key === undefined || typeof localStorage === 'undefined') return
  const tabs = Object.fromEntries(Object.entries(state.byTab).map(([id, value]) => [id, {
    entries: value.entries.map(entry => entry.url), index: value.index,
  }]))
  try { localStorage.setItem(namespace + key, JSON.stringify({ version: 1, tabs })) }
  catch (_storageUnavailable) { /* Live tab state remains usable when browser storage is unavailable. */ }
}

/** Private persistence inputs supplied by the verified product assembly. */
export interface BrowserPersistenceOptions {
  /** @param sessionId - scoped store identity. @returns verified ownership key, if available. */
  key(sessionId: string): string | undefined
  /** @param listener - identity invalidation callback. @returns subscription disposer. */
  subscribe(listener: () => void): () => void
  /** @returns current application origin, which restored addresses must not target. */
  origin(): string
  /** @param dispose - store subscriptions removed with the plugin. */
  onDispose(dispose: () => void): void
}

/**
 * Restore history only after current account, runtime, and Session ownership is known.
 * @param options - identity proof, invalidations, and plugin lifetime.
 * @returns a store handle shared by Browser body and title slots.
 */
export function createScopedBrowserStore(options: BrowserPersistenceOptions): BrowserStore {
  const handle = createBrowserStore()
  return { ...handle, create(scopeKey) {
    const instance = handle.create(scopeKey)
    if (scopeKey === undefined) return instance
    let key = options.key(scopeKey)
    let restoring = false
    const restore = (): void => {
      restoring = true
      try { instance.store.set(read(key, options.origin())) }
      finally { restoring = false }
    }
    restore()
    const stopStore = instance.subscribe(() => {
      if (!restoring && options.key(scopeKey) === key) write(key, instance.getSnapshot())
    })
    const stopIdentity = options.subscribe(() => {
      const next = options.key(scopeKey)
      if (next === key) return
      key = next
      restore()
    })
    options.onDispose(() => { stopIdentity(); stopStore() })
    return instance
  } }
}
