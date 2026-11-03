/** Activity tab type, keyed seats, scope gating, and fiber teardown over the real registries. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { clientSessionKey, createSnapshotStore, ProjectUiPolicyRuntime, type SessionId, type SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { SidebarRightTabRegistry } from '@deepseek-ai/dsh-client-ui-sidebar-right/src/client/tab-registry.ts'
import { ActivityBody, type ActivityInjected } from '../src/client/ActivityBody.tsx'
import { ActivityTitle } from '../src/client/ActivityTitle.tsx'
import { ACTIVITY_ID, ACTIVITY_KIND } from '../src/client/definition.tsx'
import { apply, inject } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { apply as hostApply } from '../src/index.ts'
import { requestUrl } from './fetch-input.ts'

interface Recorded {
  name: string
  key: string
  locale?: string
  store?: unknown
  inject?: unknown
  component: unknown
}

const contexts: Context[] = []
afterEach(async () => {
  try { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) }
  finally { vi.useRealTimers(); vi.restoreAllMocks() }
})

async function boot() {
  const ctx = new Context()
  contexts.push(ctx)
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
  const list = createSnapshotStore({ ids: [], byId: {}, archivedById: {}, current: undefined as string | undefined })
  const sessions = {
    list,
    runtimeIdentityFor: vi.fn((): SessionRuntimeTarget | undefined => undefined),
    keyFor: vi.fn((id: string, target?: SessionRuntimeTarget) =>
      target?.kind !== 'project' ? id : `project:${String(target.projectId)}:${id}`),
  }
  ctx.provide('sidebarRightTabs', tabs as never)
  ctx.provide('projectUiPolicy', policy as never)
  ctx.provide('sessions', sessions as never)
  const viewportProvider = ctx.plugin({ name: 'viewport-fixture', apply(ctx) {
    ctx.provide('conversationViewport', viewport as never)
  } })
  await viewportProvider.await()
  ctx.provide('slots', slots as never)
  ctx.provide('locale', locale as never)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, tabs, policy, registered, dictionaries, fiber, viewport, viewportProvider, sessions }
}

function body(fixture: Awaited<ReturnType<typeof boot>>, sessionId = 'session') {
  const actions = { loading: vi.fn(), refreshed: vi.fn(), appended: vi.fn(), failed: vi.fn(),
    progressLoaded: vi.fn(), progressFailed: vi.fn() }
  const face = (fixture.registered[0]?.inject as (id: string, actions: unknown) => ActivityInjected)(sessionId, actions)
  return { face, actions }
}

const readyJournal = { enabled: true, periods: [], status: { generating: false } }

describe('ui-project-activity apply', () => {
  it('keeps a restored qualified address without an optional pool key helper', async () => {
    const fixture = await boot()
    const owner: SessionRuntimeTarget = { kind: 'project', projectId: 9,
      runtimeId: '10000000-0000-4000-8000-000000000009' as NonNullable<SessionRuntimeTarget['runtimeId']> }
    fixture.policy.set('project', 'follow-user', { projectId: 11 })
    Reflect.deleteProperty(fixture.sessions, 'keyFor')
    const { face } = body(fixture, clientSessionKey(owner, 'journal' as SessionId))
    face.reveal('shared-session', null)
    expect(fixture.viewport.replaceActive).toHaveBeenCalledWith(clientSessionKey(owner, 'shared-session' as SessionId))
  })

  it('keeps unqualified standalone links and ignores queued clicks after viewport withdrawal', async () => {
    const fixture = await boot()
    const { face } = body(fixture)
    face.reveal('shared-session', 4)
    expect(fixture.viewport.reveal).toHaveBeenCalledWith('shared-session', 4)
    await fixture.viewportProvider.dispose()
    face.reveal('shared-session', 5)
    expect(fixture.viewport.reveal).toHaveBeenCalledTimes(1)
  })

  it('appends older pages and reports current read failures', async () => {
    const fixture = await boot()
    const { face, actions } = body(fixture)
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ items: [], nextBefore: 'next' }))
    face.loadMore('older')
    await vi.waitFor(() => { expect(actions.appended).toHaveBeenCalledWith([], 'next') })
    fetcher.mockRejectedValue(new Error('network failed'))
    face.refresh()
    await vi.waitFor(() => {
      expect(actions.failed).toHaveBeenCalledTimes(1)
      expect(actions.progressFailed).toHaveBeenCalledTimes(1)
    })
  })

  it('polls admitted generation until it settles and reports a refused generation', async () => {
    const { face, actions } = body(await boot())
    let polls = 0
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(
      requestUrl(input).includes('/generate') ? { started: true }
        : { ...readyJournal, status: { generating: ++polls === 1 } }))
    vi.useFakeTimers()
    face.generate()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(actions.progressLoaded).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
    fetcher.mockRejectedValue(new Error('generation refused'))
    face.generate()
    await vi.advanceTimersByTimeAsync(0)
    expect(actions.progressFailed).toHaveBeenCalledTimes(1)
  })

  it('retires the old poll when a refresh finds the journal settled', async () => {
    const { face, actions } = body(await boot())
    let generating = true
    const requests: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requests.push(requestUrl(input))
      return Response.json(requestUrl(input).includes('/activity') ? { items: [] }
        : { ...readyJournal, status: { generating } })
    })
    vi.useFakeTimers()
    face.refresh()
    await vi.advanceTimersByTimeAsync(0)
    generating = false
    face.refresh()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(actions.progressLoaded).toHaveBeenCalledTimes(2)
    expect(requests.filter(path => path.includes('/progress'))).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start an old poll when publication synchronously refreshes the panel', async () => {
    const { face, actions } = body(await boot())
    let reads = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => Response.json(
      requestUrl(input).includes('/activity') ? { items: [] }
        : { ...readyJournal, status: { generating: ++reads === 1 } }))
    actions.progressLoaded.mockImplementationOnce(() => { face.refresh() })
    vi.useFakeTimers()
    face.refresh()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(reads).toBe(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['activity', 'progress'] as const)('ignores a superseded %s response after its body finishes decoding', async (domain) => {
    const { face, actions } = body(await boot())
    const decoded = Promise.withResolvers<unknown>()
    const response = Response.json({})
    const decode = vi.spyOn(response, 'json').mockImplementation(() => decoded.promise)
    let delayed = true
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const selected = requestUrl(input).includes('/' + domain)
      if (selected && delayed) { delayed = false; return response }
      return Response.json(requestUrl(input).includes('/activity') ? { items: [], nextBefore: 'fresh' } : readyJournal)
    })
    face.refresh()
    await vi.waitFor(() => { expect(decode).toHaveBeenCalledTimes(1) })
    face.refresh()
    await vi.waitFor(() => { expect(domain === 'activity' ? actions.refreshed : actions.progressLoaded).toHaveBeenCalledTimes(1) })
    decoded.resolve(domain === 'activity' ? { items: [], nextBefore: 'stale' } : readyJournal)
    await decoded.promise
    await Promise.resolve()
    expect(domain === 'activity' ? actions.refreshed : actions.progressLoaded).toHaveBeenCalledTimes(1)
    expect(actions.failed).not.toHaveBeenCalled()
    expect(actions.progressFailed).not.toHaveBeenCalled()
  })

  it('suppresses abort failures from replaced feed and journal requests', async () => {
    const { face, actions } = body(await boot())
    const signals: AbortSignal[] = []
    let first = true
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, options) => {
      if (first) return await new Promise<Response>((_resolve, reject) => {
        const signal = options?.signal
        if (signal === undefined || signal === null) throw new Error('read must have an abort signal')
        signals.push(signal)
        signal.addEventListener('abort', () => { reject(new DOMException('Request aborted', 'AbortError')) }, { once: true })
      })
      return Response.json(requestUrl(input).includes('/activity') ? { items: [] } : readyJournal)
    })
    face.refresh()
    expect(signals).toHaveLength(2)
    first = false
    face.refresh()
    await vi.waitFor(() => { expect(actions.progressLoaded).toHaveBeenCalledTimes(1) })
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(actions.refreshed).toHaveBeenCalledTimes(1)
    expect(actions.failed).not.toHaveBeenCalled()
    expect(actions.progressFailed).not.toHaveBeenCalled()
  })

  it('bounds a generating journal poll without restarting its round budget', async () => {
    const { registered, policy } = await boot()
    policy.set('project', 'follow-user', { projectId: 9 })
    const actions = { loading: vi.fn(), refreshed: vi.fn(), appended: vi.fn(), failed: vi.fn(),
      progressLoaded: vi.fn(), progressFailed: vi.fn() }
    const face = (registered[0]?.inject as (sessionId: string, actions: unknown) => ActivityInjected)('project-session', actions)
    const requests: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requests.push(requestUrl(input))
      return Response.json(requestUrl(input).includes('/activity') ? { items: [] }
        : { enabled: true, periods: [], status: { generating: true } })
    })
    vi.useFakeTimers()
    face.refresh()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(requests.filter(path => path.includes('/progress'))).toHaveLength(49)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(requests.filter(path => path.includes('/progress'))).toHaveLength(49)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('offers activity for the selected project Runtime even when the page opened in personal scope', async () => {
    const { tabs, policy, sessions, fiber } = await boot()
    try {
      policy.set('personal')
      sessions.runtimeIdentityFor.mockReturnValue({ kind: 'project', projectId: 9 })
      sessions.list.update((state) => { state.current = 'project-session' })
      expect(tabs.get(ACTIVITY_KIND)).toBeDefined()
      sessions.runtimeIdentityFor.mockReturnValue({ kind: 'personal' })
      sessions.list.update((state) => { state.current = 'personal-session' })
      expect(tabs.get(ACTIVITY_KIND)).toBeUndefined()
    } finally {
      await fiber.dispose()
    }
  })

  it('keeps the journal and its links on the owning allocation after another project becomes active', async () => {
    const { registered, policy, sessions, fiber } = await boot()
    const target: SessionRuntimeTarget = { kind: 'project', projectId: 9,
      runtimeId: '10000000-0000-4000-8000-000000000009' as NonNullable<SessionRuntimeTarget['runtimeId']> }
    sessions.runtimeIdentityFor.mockReturnValue(target)
    policy.set('project', 'follow-user', { projectId: 9 })
    const actions = { loading: vi.fn(), refreshed: vi.fn(), appended: vi.fn(), failed: vi.fn(),
      progressLoaded: vi.fn(), progressFailed: vi.fn() }
    const face = (registered[0]?.inject as (sessionId: string, actions: unknown) => ActivityInjected)('project-session', actions)
    const requests: string[] = []
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      requests.push(requestUrl(input))
      return Response.json(requestUrl(input).includes('/activity') ? { items: [] }
        : { enabled: true, periods: [], status: { generating: false } })
    })
    try {
      policy.set('project', 'follow-user', { projectId: 11 })
      face.reveal('shared-session', 7)
      expect(sessions.keyFor).toHaveBeenCalledWith('shared-session', target)
      face.refresh()
      await vi.waitFor(() => { expect(requests).toHaveLength(2) })
      for (const request of requests) {
        const url = new URL(request, 'http://dsh.internal')
        expect(url.searchParams.get('dshRuntime')).toBe(target.runtimeId)
        expect(url.searchParams.get('dshTarget')).toBe('project:9')
      }
    } finally {
      fetcher.mockRestore()
      await fiber.dispose()
    }
  })

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
    policy.set('project', 'follow-user', { projectId: 9 })
    const face = (registered[0]?.inject as (sessionId: string, actions: unknown) => ActivityInjected)('session', actions)
    face.reveal('session-x', 12)
    expect(viewport.reveal).toHaveBeenCalledWith('project:9:session-x', 12)
    face.reveal('session-y', null)
    expect(viewport.replaceActive).toHaveBeenCalledWith('project:9:session-y')
    expect(viewport.reveal).toHaveBeenCalledTimes(1)
    policy.set('personal')
    face.reveal('session-z', 4)
    expect(viewport.reveal).toHaveBeenCalledWith('project:9:session-z', 4)
  })
})
