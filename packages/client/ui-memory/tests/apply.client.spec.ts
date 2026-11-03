/** ui-memory apply: dictionaries, the right-Sidebar tab registration, and the Remote wiring. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import type { MemoryRevision } from '@deepseek-ai/dsh-memory/client'
import type { MemoryInjected } from '../src/client/memory-source.ts'
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
  runtime?: SessionRuntimeTarget
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
  const createApi = () => ({
    scopes: vi.fn(options.scopes ?? (async () => ({ ok: true, value: { enabled: true, scopes: [] } }))),
    list: vi.fn(options.list ?? (async () => ({ ok: true, value: [] }))),
    save: vi.fn(async () => ({ ok: true, value: { ok: true, operation: 'create' } })),
    delete: vi.fn(async () => ({ ok: true, value: { ok: true, operation: 'delete' } })),
  })
  const api = createApi(), targetApi = createApi()
  const on = vi.fn((_event: string, _listener: () => void) => () => {})
  const targetOn = vi.fn((_event: string, _listener: () => void) => () => {})
  const forTarget = vi.fn((target?: SessionRuntimeTarget) => target === undefined
    ? { memory: api, $on: on } : { memory: targetApi, $on: targetOn })
  const remote = { memory: api, $on: on, $forTarget: forTarget }
  const scope = {
    getSnapshot: () => ({ status: 'ready', writable: true, value: { enabled: true }, write: { status: 'idle' } }),
    subscribe: vi.fn(() => () => {}),
    set: vi.fn(async () => {}),
    unset: vi.fn(async () => {}),
  }
  const settingsScope = { bind: vi.fn(() => scope) }
  const uiWorkspace = { openSession: vi.fn(), startSession: vi.fn() }
  const sessions = {
    keyFor: vi.fn((id: string, runtime?: SessionRuntimeTarget) => runtime?.runtimeId === undefined ? id : `${runtime.runtimeId}/${id}`),
    runtimeTargetFor: () => options.runtime,
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
  const transport = { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } }
  ctx.provide('connection', { ...transport, forTarget: () => transport } as never)
  ctx.provide('settingsScope', settingsScope as never)
  ctx.provide('uiWorkspace', uiWorkspace as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('sidebarRightTabs', sidebarRightTabs as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, registered, dictionaries, api, on, settingsScope, uiWorkspace, fiber, tabTypes, targetApi, targetOn, forTarget, sessions }
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

  it('keeps memory reads, writes, events and source links on the conversation Runtime', async () => {
    const runtime: SessionRuntimeTarget = { kind: 'personal', runtimeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as NonNullable<SessionRuntimeTarget['runtimeId']> }
    const b = await boot({ runtime, scopes: async () => ({ ok: true,
      value: { enabled: true, scopes: [{ scope: { kind: 'personal' }, entries: 0, writable: true }] } }) })
    const body = b.registered.find(entry => entry.name === 'sidebar.right.pane.tab')
    const face = body?.inject?.('s1') as MemoryInjected
    const stop = face.hooks.memory.subscribe(() => {})
    try {
      await vi.waitFor(() => { expect(b.targetApi.list).toHaveBeenCalledWith({ scope: { kind: 'personal' } }) })
      await face.save({ scope: { kind: 'personal' }, key: 'same-key', kind: 'background', summary: 'Secondary', content: 'Owned fixture' })
      await face.remove({ scope: { kind: 'personal' }, key: 'same-key', expectedRevision: 'fixture-revision' as MemoryRevision })
      face.openSource('same-session' as Parameters<MemoryInjected['openSource']>[0])
      expect(b.forTarget).toHaveBeenCalledExactlyOnceWith(runtime)
      expect(b.targetOn).toHaveBeenCalledWith('memory/changed', expect.any(Function))
      expect(b.targetApi.save).toHaveBeenCalledTimes(1)
      expect(b.targetApi.delete).toHaveBeenCalledTimes(1)
      expect(b.api.scopes).not.toHaveBeenCalled()
      expect(b.api.list).not.toHaveBeenCalled()
      expect(b.api.save).not.toHaveBeenCalled()
      expect(b.api.delete).not.toHaveBeenCalled()
      expect(b.sessions.keyFor).toHaveBeenCalledWith('same-session', runtime)
      expect(b.uiWorkspace.openSession).toHaveBeenCalledWith(`${runtime.runtimeId}/same-session`)
    } finally { stop(); await b.ctx.fiber.dispose() }
  })

  it('drops the dictionary when the fiber disposes (HMR safety)', async () => {
    const { dictionaries, fiber } = await boot()
    expect(dictionaries.has('memory')).toBe(true)
    await fiber.dispose()
    expect(dictionaries.has('memory')).toBe(false)
  })
})
