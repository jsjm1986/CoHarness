import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  NavigationController, SlotRegistry,
  type AddPaneResult, type SessionId, type SessionListState, type SessionSummary,
  type WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { WorkspaceBrowserInjected, WorkspacePickerInjected } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WorkspaceBrowser } from '../src/client/WorkspaceBrowser.tsx'
import { WorkspacePicker } from '../src/client/WorkspacePicker.tsx'
import { apply as nodeApply } from '../src/index.ts'
import { UNGROUPED_KEY } from '../src/client/tree.ts'
import { FLAT_SESSION_ORDER_KEY, createWorkspaceViewStore } from '../src/client/stores.ts'

// A snapshot must keep one identity between changes (uSES polls it).
const EMPTY_CATALOG: readonly never[] = []

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const create = vi.fn(async (input: { name: string } | { path: string }) => ({
    workspaceId: 'ws-new' as never,
    path: 'name' in input ? `/projects/${input.name}` : input.path,
    title: 'new', sessionIds: [], createdAt: '0', updatedAt: '0',
  }))
  const startSession = vi.fn()
  const rename = vi.fn(async () => ({}))
  const insertSessionBefore = vi.fn(async () => ({}))
  const navigation = new NavigationController()
  ctx.effect(() => () => { navigation.dispose() })
  const beginNavigation = () => navigation.begin()
  const open = vi.fn(() => { beginNavigation() })
  const clear = vi.fn()
  const search = vi.fn(async () => ({
    ok: true as const,
    value: { items: [{ sessionId: 'session' as never, snippet: 'match' }], hasMore: false },
  }))
  const renameSession = vi.fn(async (title: string) => ({ ok: true, value: { title, seq: 1 } }))
  const binding = vi.fn((_id: string) => ({ session: { rename: renameSession } }))
  const fork = vi.fn(async () => 'forked' as never)
  const workspaceList = {
    items: [] as WorkspaceView[],
    archivedSessionIds: [] as SessionId[],
    pinnedSessionIds: [] as SessionId[],
  }
  const pinSession = vi.fn(async (sessionId: SessionId) => {
    workspaceList.pinnedSessionIds = [sessionId, ...workspaceList.pinnedSessionIds]
  })
  const unpinSession = vi.fn(async (sessionId: SessionId) => {
    workspaceList.pinnedSessionIds = workspaceList.pinnedSessionIds.filter(id => id !== sessionId)
  })
  ctx.provide('workspaces', {
    create, startSession, rename, insertSessionBefore, pinSession, unpinSession,
    list: { getSnapshot: () => workspaceList },
  } as never)
  const sessionList: SessionListState = {
    ids: [], byId: {}, archivedById: {}, current: undefined,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, observedJobs: {}, currentAddress: undefined,
  }
  const retain = vi.fn(() => ({
    ready: Promise.resolve({ session: { getSnapshot: () => ({ openState: 'open', openError: null }) } }),
    release: vi.fn(),
  }))
  const using = vi.fn(async (
    id: string, _options: unknown,
    operation: (reference: { binding: ReturnType<typeof binding> }) => Promise<void>,
  ) => operation({ binding: binding(id) }))
  ctx.provide('sessions', {
    open, clear, beginNavigation, search, searchResultLimit: 20, binding, using, retain, fork,
    list: { getSnapshot: () => sessionList },
  } as never)
  const viewportState = { mode: 'single' as 'single' | 'workbench' }
  const replaceActive = vi.fn<(_id: SessionId) => AddPaneResult>(() => ({ ok: true }))
  ctx.provide('conversationViewport', { snapshot: { getSnapshot: () => ({ mode: viewportState.mode, paneIds: [], paneRatios: [] }), subscribe: () => () => {} }, replaceActive, setMode: vi.fn() } as never)
  ctx.provide('connection', {
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
  } as never)
  ctx.provide('shortcuts', {
    register: vi.fn(() => () => {}),
    catalog: { getSnapshot: () => EMPTY_CATALOG, subscribe: () => () => {} },
  } as never)
  const locale = new LocaleRuntime(ctx)
  // These specs assert the shipped Chinese copy. There is no jsdom `window`
  // in this lane, so browser-language detection never runs and the locale
  // comes from FALLBACK_LOCALE (en): state the asserted locale explicitly.
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, locale, create, startSession, rename,
    insertSessionBefore, open, clear, search, renameSession, binding, fork,
    viewportState, replaceActive, workspaceList, sessionList, pinSession, unpinSession,
  }
}

type HoleName = 'sidebar.workspaces' | 'conversation.hero.workspace' | 'conversation.empty.workspace'

/** Declare any subset of the holes with a single root registration ('root' is a single slot). */
function declare(slots: SlotRegistry, ...names: HoleName[]): () => void {
  const children = Object.fromEntries(names.map(name => [name, { kind: 'single', scope: 'root' }]))
  return slots.register({ name: 'root', children } as never, () => null)
}

const sid = (id: string) => id as SessionId
const summary = (id: string, updatedAt: number): SessionSummary => ({
  id: sid(id), displayTitle: id, running: false, blank: false, updatedAt,
})
const workspace = (id: string, sessionIds: readonly string[]): WorkspaceView => ({
  workspaceId: id as WorkspaceView['workspaceId'], path: `/projects/${id}`, title: id,
  sessionIds: sessionIds.map(sid), createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
})
type ViewInstance = ReturnType<ReturnType<typeof createWorkspaceViewStore>['create']>

describe('ui-workspace apply', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'sessions', 'workspaces', 'locale', 'connection', 'conversationViewport', 'shortcuts'])
  })

  it('registers browser and pickers for declarations arriving before or after apply', async () => {
    const before = await bench()
    declare(before.slots, 'sidebar.workspaces')
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.workspaces')[0]!.component).toBe(WorkspaceBrowser)
    // Copy rides the standard locale seat: the entry declares the namespace
    // and apply registered both dictionaries.
    expect(before.slots.entries('sidebar.workspaces')[0]!.locale).toBe('workspace')
    expect(before.locale.bind('workspace')('session.new')).toBe('新会话')

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    declare(after.slots, 'conversation.hero.workspace', 'conversation.empty.workspace')
    await Promise.resolve()
    expect(after.slots.entries('conversation.hero.workspace')[0]!.component).toBe(WorkspacePicker)
    // expect(after.slots.entries('conversation.empty.workspace')[0]!.component).toBe(WorkspacePicker)
  })

  it('keeps the current selection when the workbench refuses the prepared Session', async () => {
    const b = await bench()
    try {
      declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
      await b.ctx.plugin({ inject: [...inject], apply }).await()
      b.viewportState.mode = 'workbench'
      b.replaceActive.mockReturnValue({ ok: false, reason: 'unknown' })
      const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
      await expect(browser.open('refused' as SessionId)).rejects.toThrow()
      expect(b.open).not.toHaveBeenCalled()
      expect(b.clear).not.toHaveBeenCalled()
    } finally { await b.ctx.fiber.dispose() }
  })

  it('routes browser actions and picker creation to the services', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    // Both arms delegate to the runtime's shared New Session action.
    browser.startSession('ws' as never)
    expect(b.startSession).toHaveBeenCalledWith('ws')
    browser.startSession()
    expect(b.startSession).toHaveBeenLastCalledWith(undefined)
    await browser.open('session' as never)
    expect(b.open).toHaveBeenCalledWith('session')
    // Single-mode opens must not materialize a workbench pane.
    expect(b.replaceActive).not.toHaveBeenCalled()
    b.viewportState.mode = 'workbench'
    await browser.open('session-2' as never)
    expect(b.replaceActive).toHaveBeenCalledWith('session-2')
    b.viewportState.mode = 'single'
    const signal = new AbortController().signal
    await expect(browser.searchSessions('match', signal)).resolves.toEqual({
      items: [{ sessionId: 'session', snippet: 'match' }],
      hasMore: false,
    })
    expect(b.search).toHaveBeenCalledWith('match', signal)
    expect(browser.searchResultLimit).toBe(20)
    await browser.renameSession('session' as never, 'renamed session')
    expect(b.binding).toHaveBeenCalledWith('session')
    expect(b.renameSession).toHaveBeenCalledWith('renamed session')
    browser.forkSession('session' as never)
    await vi.waitFor(() => {
      expect(b.open).toHaveBeenCalledWith('forked')
    })
    expect(b.fork).toHaveBeenCalledWith({ sessionId: 'session', increaseTitle: true })
    await browser.renameWorkspace('ws' as never, 'renamed')
    expect(b.rename).toHaveBeenCalledWith('ws', 'renamed')
    await browser.insertSessionBefore('ws' as never, 's1' as never, 's2' as never)
    expect(b.insertSessionBefore).toHaveBeenCalledWith('ws', 's1', 's2')
    await browser.createWorkspace({ path: '/tmp/browser-project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/browser-project' })

    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    await picker.createWorkspace({ path: '/tmp/project' })
    expect(b.create).toHaveBeenCalledWith({ path: '/tmp/project' })
  })

  it('fronts a pinned session in its group and flat saved orders and reports write failures', async () => {
    const b = await bench()
    // Workspace alpha owns s1/s2 (s1 listed last); s3 is ungrouped.
    b.workspaceList.items = [workspace('alpha', ['s2', 's1'])]
    b.sessionList.ids = [sid('s1'), sid('s2'), sid('s3')]
    b.sessionList.byId = { [sid('s1')]: summary('s1', 10), [sid('s2')]: summary('s2', 20), [sid('s3')]: summary('s3', 30) }
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()

    const entry = b.slots.entries('sidebar.workspaces')[0]!
    const browser = (entry.inject as () => WorkspaceBrowserInjected)()
    const view = (entry.store as unknown as { create(): ViewInstance }).create()

    browser.pinSession(sid('s1'))
    expect(b.pinSession).toHaveBeenCalledWith('s1')
    await vi.waitFor(() => {
      // The pinned session leads its Workspace and the flat account; Ungrouped
      // reconciles unchanged.
      expect(view.getSnapshot().sessionOrderByAccount).toEqual({
        alpha: ['s1', 's2'],
        [UNGROUPED_KEY]: ['s3'],
        [FLAT_SESSION_ORDER_KEY]: ['s1', 's3', 's2'],
      })
    })

    // Unpinning is Host state only: saved positions stay.
    browser.unpinSession(sid('s1'))
    await vi.waitFor(() => { expect(b.unpinSession).toHaveBeenCalledWith('s1') })
    expect(view.getSnapshot().sessionOrderByAccount.alpha).toEqual(['s1', 's2'])
    expect(browser.hooks.workspaceShortcuts.getSnapshot().pinError).toBeNull()

    // Rejected writes surface on the pin-error channel and touch no order.
    b.pinSession.mockRejectedValueOnce(new Error('wire down'))
    browser.pinSession(sid('s2'))
    await vi.waitFor(() => {
      expect(browser.hooks.workspaceShortcuts.getSnapshot().pinError).toMatchObject({ kind: 'pin' })
    })
    browser.dismissPinError()
    expect(browser.hooks.workspaceShortcuts.getSnapshot().pinError).toBeNull()
    b.unpinSession.mockRejectedValueOnce(new Error('wire down'))
    browser.unpinSession(sid('s1'))
    await vi.waitFor(() => {
      expect(browser.hooks.workspaceShortcuts.getSnapshot().pinError).toMatchObject({ kind: 'unpin' })
    })
    expect(view.getSnapshot().sessionOrderByAccount.alpha).toEqual(['s1', 's2'])
  })

  it('a pin completing after its Workspace vanished reconciles only live accounts', async () => {
    const b = await bench()
    b.workspaceList.items = [workspace('alpha', ['s1', 's2'])]
    b.sessionList.ids = [sid('s1'), sid('s2'), sid('s3')]
    b.sessionList.byId = { [sid('s1')]: summary('s1', 10), [sid('s2')]: summary('s2', 20), [sid('s3')]: summary('s3', 30) }
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries('sidebar.workspaces')[0]!
    const browser = (entry.inject as () => WorkspaceBrowserInjected)()
    const view = (entry.store as unknown as { create(): ViewInstance }).create()
    view.actions.setSessionOrder('alpha', ['s2', 's1'])

    // The Workspace disappears while the pin is in flight; the write lands on
    // the memberships that are live at completion (s1 is now ungrouped).
    let resolvePin: () => void = () => {}
    b.pinSession.mockImplementationOnce(() => new Promise<void>((resolve) => { resolvePin = resolve }))
    browser.pinSession(sid('s1'))
    b.workspaceList.items = []
    b.workspaceList.pinnedSessionIds = [sid('s1')]
    resolvePin()
    await vi.waitFor(() => {
      expect(view.getSnapshot().sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]).toEqual(['s1', 's3', 's2'])
    })
    const orders = view.getSnapshot().sessionOrderByAccount
    expect(orders[UNGROUPED_KEY]).toEqual(['s1', 's2', 's3'])
    expect(orders.alpha).toBeUndefined()
  })

  it('declares the two directory-flow holes and reports their occupancy per surface', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Registration declared the child holes (declaration = render authorization).
    expect(b.slots.spec('sidebar.workspaces.directoryFlow')).toMatchObject({ kind: 'single' })
    expect(b.slots.spec('conversation.hero.workspace.directoryFlow')).toMatchObject({ kind: 'single' })

    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    const picker = (b.slots.entries('conversation.hero.workspace')[0]!.inject as () => WorkspacePickerInjected)()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    expect(browser.hooks.hostDescription.getSnapshot()).toBeUndefined()
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    // A flow occupant flips exactly its own surface, and the source notifies.
    const notified = vi.fn()
    const unsubscribe = browser.hooks.directoryFlow.subscribe(notified)
    const dispose = b.slots.register({ name: 'sidebar.workspaces.directoryFlow' } as never, () => null)
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(true)
    expect(picker.hooks.directoryFlow.getSnapshot()).toBe(false)
    await Promise.resolve()
    expect(notified).toHaveBeenCalled()
    dispose()
    expect(browser.hooks.directoryFlow.getSnapshot()).toBe(false)
    unsubscribe()
  })

  it('rejects the browser search callback on a runtime business error', async () => {
    const b = await bench()
    b.search.mockImplementationOnce(async () => ({
      ok: false,
      error: { code: 'internal', message: 'index unavailable', details: {} },
    }) as never)
    declare(b.slots, 'sidebar.workspaces')
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const browser = (b.slots.entries('sidebar.workspaces')[0]!.inject as () => WorkspaceBrowserInjected)()
    await expect(browser.searchSessions('needle', new AbortController().signal))
      .rejects.toThrow('index unavailable')
  })

  it('unregisters every entry on teardown', async () => {
    const b = await bench()
    declare(b.slots, 'sidebar.workspaces', 'conversation.hero.workspace', 'conversation.empty.workspace')
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.workspaces')).toHaveLength(0)
    expect(b.slots.entries('conversation.hero.workspace')).toHaveLength(0)
    // expect(b.slots.entries('conversation.empty.workspace')).toHaveLength(0)
  })
})

describe('ui-workspace node half', () => {
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
