/** Browser type, Slot, locale, and HMR disposal through the real registries. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore, ProjectUiPolicyRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { BrowserBody } from '../src/client/view/BrowserBody.tsx'
import { BrowserTitle } from '../src/client/view/BrowserTitle.tsx'
import type { BrowserInjected } from '../src/client/browser/BrowserController.ts'
import { BROWSER_ID, BROWSER_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'

interface Recorded {
  name: string
  key: string
  locale?: string
  store?: unknown
  inject?: unknown
  component: unknown
}

async function boot() {
  const ctx = new Context()
  const tabs = new SidebarRightTabRegistry(ctx)
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => () => void) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((namespace: string, value: unknown) => {
      dictionaries.set(namespace, value)
      return () => { dictionaries.delete(namespace) }
    }),
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  const openSessionTab = vi.fn()
  const focusRightbar = vi.fn()
  ctx.provide('sidebarRight', { openSessionTab } as never)
  ctx.provide('layout', { focusRightbar } as never)
  ctx.provide('sessions', { list: createSnapshotStore({ byId: {} }) } as never)
  ctx.provide('connection', { hostDescription: createSnapshotStore(undefined) } as never)
  ctx.provide('projectUiPolicy', new ProjectUiPolicyRuntime())
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, tabs, registered, dictionaries, fiber, openSessionTab, focusRightbar }
}

describe('ui-sidebar-browser apply', () => {
  it('keeps the Host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('registers a multi-instance builtin and its body and title', async () => {
    const { tabs, registered, dictionaries } = await boot()
    const definition = tabs.get(BROWSER_KIND)
    expect(definition).toMatchObject({ id: BROWSER_ID, kind: BROWSER_KIND, multiple: true, priority: 'builtin' })
    expect(definition?.title('sidebar://browser')).toBe('type.label')
    expect(definition?.guide?.map(entry => [entry.order, entry.title(), entry.description?.()]))
      .toEqual([[30, 'guide.title', 'guide.description']])
    expect(dictionaries.get('sidebarBrowser')).toEqual({ zh, en })
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', BROWSER_ID, 'sidebarBrowser', BrowserBody],
      ['sidebar.right.pane.tab.title', BROWSER_ID, undefined, BrowserTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(registered[0]?.inject).toBeTypeOf('function')
    const injectFace = registered[0]?.inject as ((sessionId: string, actions: unknown) => unknown)
    const browser = injectFace('session', { replace: vi.fn(), forget: vi.fn() }) as BrowserInjected
    expect(browser.keyedHooks.browserFrame('missing')).toBeUndefined()
    expect(typeof browser.mount).toBe('function')
  })

  it('opens the session browser tab on web/browser-open and focuses the bar', async () => {
    const { ctx, openSessionTab, focusRightbar, fiber } = await boot()
    expect(ctx.bail('web/browser-open', { sessionId: 's1' as never, url: 'https://example.test/' })).toBe(true)
    expect(openSessionTab).toHaveBeenCalledWith('s1', 'browser', { params: { url: 'https://example.test/' } })
    expect(focusRightbar).toHaveBeenCalledWith('s1')
    await fiber.dispose()
  })

  it('scopes persisted history through the live owner key', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.test' } })
    const { registered, fiber } = await boot()
    const store = registered[0]?.store as { create(scopeKey?: string): { getSnapshot(): unknown } }
    // The scope key resolves against live ownership stores; no owned session
    // here means the key stays undefined and the restore reads nothing.
    const scoped = store.create('s1')
    expect(scoped.getSnapshot()).toEqual({ byTab: {} })
    await fiber.dispose()
    vi.unstubAllGlobals()
  })

  it('removes every registration when the plugin is disposed', async () => {
    const { tabs, registered, dictionaries, fiber } = await boot()
    await fiber.dispose()
    expect(tabs.get(BROWSER_KIND)).toBeUndefined()
    expect(registered).toEqual([])
    expect(dictionaries.size).toBe(0)
  })
})
