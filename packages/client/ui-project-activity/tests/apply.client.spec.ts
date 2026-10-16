/** Activity tab type, keyed seats, scope gating, and fiber teardown over the real registries. */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ProjectUiPolicyRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { ActivityBody, type ActivityInjected } from '../src/client/ActivityBody.tsx'
import { ActivityTitle } from '../src/client/ActivityTitle.tsx'
import { ACTIVITY_ID, ACTIVITY_KIND } from '../src/client/definition.tsx'
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
  const policy = new ProjectUiPolicyRuntime()
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
  const viewport = { replaceActive: vi.fn(), reveal: vi.fn() }
  const sessions = {
    list: { getSnapshot: () => ({ ids: [], byId: {}, archivedById: {} }) },
    keyFor: (id: string, target?: { kind: string; projectId?: number }) =>
      target?.projectId === undefined ? id : `project:${String(target.projectId)}:${id}`,
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('projectUiPolicy', policy as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('conversationViewport', viewport as never)
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, tabs, policy, registered, dictionaries, fiber, viewport }
}

describe('ui-project-activity apply', () => {
  it('keeps the Host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('mounts the keyed body and title seats while the type follows project scope', async () => {
    const { tabs, policy, registered, dictionaries } = await boot()
    expect(registered.map(entry => [entry.name, entry.key, entry.locale, entry.component])).toEqual([
      ['sidebar.right.pane.tab', ACTIVITY_ID, 'projectActivity', ActivityBody],
      ['sidebar.right.pane.tab.title', ACTIVITY_ID, 'projectActivity', ActivityTitle],
    ])
    expect(registered[0]?.store).toBeDefined()
    expect(dictionaries.get('projectActivity')).toEqual({ zh, en })

    expect(tabs.get(ACTIVITY_KIND)).toBeUndefined()
    policy.set('project', 'follow-user', { projectId: 9, projectName: 'Payments' })
    const definition = tabs.get(ACTIVITY_KIND)
    expect(definition).toMatchObject({ id: ACTIVITY_ID, kind: ACTIVITY_KIND, priority: 'builtin' })
    expect(definition?.guide?.map(entry => [entry.order, entry.title()])).toEqual([[35, 'guide.title']])
    policy.set('personal')
    expect(tabs.get(ACTIVITY_KIND)).toBeUndefined()
    policy.set('project', 'follow-user', { projectId: 9 })
    expect(tabs.get(ACTIVITY_KIND)).toBeDefined()
  })

  it('scopes the tab type back out on fiber teardown (HMR safety)', async () => {
    const { tabs, policy, fiber } = await boot()
    policy.set('project', 'follow-user', { projectId: 9 })
    expect(tabs.get(ACTIVITY_KIND)).toBeDefined()
    await fiber.dispose()
    expect(tabs.get(ACTIVITY_KIND)).toBeUndefined()
  })

  it('routes reveal through the viewport, translating the wire id to the project-scoped key', async () => {
    const { registered, viewport, policy } = await boot()
    const actions = {
      loading: vi.fn(), refreshed: vi.fn(), appended: vi.fn(), failed: vi.fn(),
      grouped: vi.fn(), filtered: vi.fn(),
    }
    const face = (registered[0]?.inject as (sessionId: string, actions: unknown) => ActivityInjected)('session', actions)
    policy.set('project', 'follow-user', { projectId: 9 })
    face.reveal('session-x', 12)
    expect(viewport.reveal).toHaveBeenCalledWith('project:9:session-x', 12)
    face.reveal('session-y', null)
    expect(viewport.replaceActive).toHaveBeenCalledWith('project:9:session-y')
    expect(viewport.reveal).toHaveBeenCalledTimes(1)
    policy.set('personal')
    face.reveal('session-z', 4)
    expect(viewport.reveal).toHaveBeenCalledWith('session-z', 4)
  })
})
