/** Browser history never crosses verified ownership or restores executable addresses. */
import { afterEach, expect, it, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { createScopedBrowserStore } from '../src/client/browser/persistence.ts'
import { BrowserNavigation } from '../src/client/browser/BrowserNavigation.ts'

const tab = 'tab1' as TabId
afterEach(() => { vi.unstubAllGlobals() })

function setup() {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  })
  let key: string | undefined = 'account:1/runtime:personal/session:one'
  const listeners = new Set<() => void>()
  const disposers: Array<() => void> = []
  const handle = createScopedBrowserStore({
    key: () => key, origin: () => 'https://app.test',
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onDispose: (dispose) => { disposers.push(dispose) },
  })
  return { values, handle, listeners,
    setKey(next: string | undefined) { key = next; for (const listener of listeners) listener() },
    dispose() { for (const dispose of disposers) dispose() },
  }
}

it('restores canonical history only for its verified owner and omits transient sandbox state', () => {
  const setupState = setup()
  const store = setupState.handle.create('one')
  const navigation = new BrowserNavigation()
  navigation.navigate({ kind: 'https', url: 'https://example.test/', title: 'example.test' })
  store.actions.replace(tab, navigation.snapshot)
  expect(setupState.values.size).toBe(1)
  expect([...setupState.values.values()][0]).not.toContain('sandbox')
  setupState.setKey(undefined)
  expect(store.getSnapshot().byTab).toEqual({})
  setupState.setKey('account:2/runtime:personal/session:one')
  expect(store.getSnapshot().byTab).toEqual({})
  setupState.setKey('account:1/runtime:personal/session:one')
  expect(BrowserNavigation.current(store.getSnapshot().byTab[tab])?.url).toBe('https://example.test/')
  expect(store.getSnapshot().byTab[tab]?.navigation.status).toBe('empty')
  setupState.dispose()
  expect(setupState.listeners.size).toBe(0)
})

it('rejects damaged storage, foreign-origin policy violations and invalid history pointers', () => {
  const setupState = setup()
  const key = 'dsh.sidebar-browser.scoped.v1.account:1/runtime:personal/session:one'
  for (const raw of ['{', JSON.stringify({ version: 2, tabs: {} }), ...['javascript:alert(1)', 'https://app.test/private', 'https://user:secret@example.test/'].map(url => JSON.stringify({ version: 1, tabs: { tab1: { entries: [url], index: 0 } } })), JSON.stringify({ version: 1, tabs: { tab1: { entries: ['https://example.test'], index: 2 } } })]) {
    setupState.values.set(key, raw)
    expect(setupState.handle.create('one').getSnapshot().byTab).toEqual({})
  }
  setupState.dispose()
})

it('keeps closed-tab removal and unavailable storage local to its owner', () => {
  const setupState = setup()
  const store = setupState.handle.create('one')
  store.actions.replace(tab, BrowserNavigation.empty())
  store.actions.forget(tab)
  expect(setupState.handle.create('one').getSnapshot().byTab).toEqual({})
  vi.stubGlobal('localStorage', { getItem() { throw new Error('denied') }, setItem() { throw new Error('quota') } })
  expect(() => { setupState.handle.create('one').actions.replace(tab, BrowserNavigation.empty()) }).not.toThrow()
  setupState.dispose()
})
