/** ui-memory apply: dictionaries, the right-Sidebar tab registration, and the Remote wiring. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'

interface Recorded {
  name: string
  id?: string
  key?: string
  order?: number
  locale?: string
  inject?: (sessionId?: string) => unknown
  component: unknown
}

async function boot(options: {
  scopes?: () => Promise<unknown>
  list?: () => Promise<unknown>
  cwd?: string
} = {}) {
  const ctx = new Context()
  const registered: Recorded[] = []
  const slots = {
    inject: vi.fn((_name: string, register: () => unknown) => register()),
    register: vi.fn((options: Omit<Recorded, 'component'>, component: unknown) => {
      const entry: Recorded = { ...options, component }
      registered.push(entry)
      return () => { registered.splice(registered.indexOf(entry), 1) }
    }),
  }
  const dictionaries = new Map<string, unknown>()
  const locale = {
    bind: vi.fn(() => (key: string) => key),
    register: vi.fn((ns: string, value: unknown) => {
      dictionaries.set(ns, value)
      return () => { dictionaries.delete(ns) }
    }),
  }
  const api = {
    scopes: vi.fn(options.scopes ?? (async () => ({ ok: true, value: { enabled: true, scopes: [] } }))),
    list: vi.fn(options.list ?? (async () => ({ ok: true, value: [] }))),
    save: vi.fn(async () => ({ ok: true, value: { ok: true, operation: 'create' } })),
    delete: vi.fn(async () => ({ ok: true, value: { ok: true, operation: 'delete' } })),
  }
  const on = vi.fn((_event: string, _listener: () => void) => () => {})
  const remote = { memory: api, $on: on }
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true }, write: { status: 'idle' } }),
    subscribe: vi.fn(() => () => {}),
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  }
  const settingsScope = { bind: vi.fn(() => scope) }
  const uiWorkspace = { openSession: vi.fn(), startSession: vi.fn() }
  const sessions = {
    keyFor: (id: string) => id,
    list: { getSnapshot: () => ({ byId: options.cwd === undefined ? {} : { s1: { cwd: options.cwd } } }) },
  }
  const tabTypes: unknown[] = []
  const sidebarRightTabs = {
    register: vi.fn((definition: unknown) => {
      tabTypes.push(definition)
      return () => { tabTypes.splice(tabTypes.indexOf(definition), 1) }
    }),
  }
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  ctx.provide('remote', remote as never)
  ctx.provide('remote.memory', api as never)
  ctx.provide('settingsScope', settingsScope as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('sidebarRightTabs', sidebarRightTabs as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, registered, dictionaries, api, on, settingsScope, uiWorkspace, fiber, tabTypes }
}

describe('ui-memory apply', () => {
  it('registers the bilingual memory dictionary', async () => {
    const { dictionaries } = await boot()
    expect(dictionaries.get('memory')).toEqual({ zh, en })
  })

  it('registers the right-Sidebar tab type, its body seat, and the plugins card', async () => {
    const { registered, tabTypes } = await boot()
    const type = tabTypes[0] as { id: string; kind: string; priority: string; guide: unknown[] }
    expect(type).toMatchObject({
      id: '@deepseek-ai/dsh-client-ui-memory',
      kind: 'memory',
      priority: 'builtin',
    })
    expect(type.guide).toHaveLength(1)
    const body = registered.find(entry => entry.name === 'sidebar.right.pane.tab')
    expect(body?.key).toBe('@deepseek-ai/dsh-client-ui-memory')
    expect(body?.locale).toBe('memory')
    const card = registered.find(entry => entry.name === 'plugins.item')
    expect(card?.id).toBe('memory')
    expect(card?.locale).toBe('memory')
    expect(registered.find(entry => entry.name === 'main')).toBeUndefined()
    expect(registered.find(entry => entry.name === 'sidebar.panellist')).toBeUndefined()
  })

  it('binds the card to the memory settings namespace', async () => {
    const { settingsScope } = await boot()
    expect(settingsScope.bind).toHaveBeenCalledWith({ namespace: 'memory' })
  })

  it('loads the catalog when the tab face is subscribed', async () => {
    const { registered, api } = await boot()
    const body = registered.find(entry => entry.name === 'sidebar.right.pane.tab')
    const face = body?.inject?.('s1') as {
      hooks: { memory: { subscribe: (l: () => void) => () => void; getSnapshot: () => { status: string } } }
    }
    const unsubscribe = face.hooks.memory.subscribe(() => {})
    await vi.waitFor(() => { expect(face.hooks.memory.getSnapshot().status).toBe('ready') })
    expect(api.scopes).toHaveBeenCalled()
    unsubscribe()
  })

  it('drops the dictionary when the fiber disposes (HMR safety)', async () => {
    const { dictionaries, fiber } = await boot()
    expect(dictionaries.has('memory')).toBe(true)
    await fiber.dispose()
    expect(dictionaries.has('memory')).toBe(false)
  })
})
