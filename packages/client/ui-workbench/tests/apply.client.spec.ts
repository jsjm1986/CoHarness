// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry, NavigationController, clientSessionKey, createSnapshotStore, workspaceResourceAddress, WorkspaceResourceRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationViewport, ConversationViewportSnapshot, SessionId, SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { ConversationViewportController, createConversationViewportStore } from '@deepseek-ai/dsh-client-ui-conversation/src/client/viewport.ts'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/apply.ts'
import type { WorkbenchCatalog, WorkbenchConversation } from '../src/client/catalog.ts'
import { createWorkspacePreviewReaders } from '../src/client/preview-readers.ts'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { Config, apply as nodeApply } from '../src/index.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

const A = 'a' as SessionId
const item: WorkbenchConversation = { sessionId: A, runtime: { kind: 'personal' }, visibility: 'personal', creatorUserId: 1, creatorDisplayName: 'A', updatedAt: 1, blank: false, canWrite: true }
const catalog: WorkbenchCatalog = { personalComplete: true, personal: { id: 1, name: 'Me' }, activeRuntime: { kind: 'personal' }, projects: [], items: [item] }

async function harness(services: { connection?: unknown; workspaceResources?: unknown; viewport?: ConversationViewport } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const slots = ctx.get('slots') as SlotRegistry
  const snapshot = createSnapshotStore<ConversationViewportSnapshot>({ mode: 'workbench', paneIds: [], paneRatios: [] })
  const viewport = {
    snapshot,
    add: vi.fn(() => ({ ok: true })),
    replaceActive: vi.fn(() => ({ ok: true })),
    focus: vi.fn(), move: vi.fn(), setMode: vi.fn(), markCatalogReady: vi.fn(),
    remove: vi.fn(), setPaneRatios: vi.fn(),
    listWorkbenches: vi.fn(() => []),
    currentWorkbench: vi.fn(() => ({ id: 'w1', name: 'Sessions', paneIds: [], updatedAt: 1 })),
    createWorkbench: vi.fn(() => 'w2'),
    renameWorkbench: vi.fn(),
    duplicateWorkbench: vi.fn(() => 'w3'),
    deleteWorkbench: vi.fn(),
    switchWorkbench: vi.fn(),
  }
  const navigation = new NavigationController()
  ctx.effect(() => () => { navigation.dispose() })
  const sessions = {
    usingRuntime: <T>(_target: SessionRuntimeTarget, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>) =>
      operation(signal),
    beginNavigation: () => navigation.begin(),
    retain: vi.fn(() => ({
      ready: Promise.resolve({ session: { getSnapshot: () => ({ openState: 'open', openError: null }) } }),
      release: vi.fn(),
    })),
    ensureSession: vi.fn(async () => true), createSession: vi.fn(async () => A), setBaseRuntimeTarget: vi.fn(),
    runtimeTargetFor: vi.fn((_id: SessionId) => undefined as { kind: 'project'; projectId: number } | undefined),
    list: { getSnapshot: () => ({ current: A as SessionId | undefined }) },
  }
  const sidebarRight = { openSessionResource: vi.fn() }
  const layout = { focusRightbar: vi.fn() }
  const tabTypes: { canOpen(address: string): boolean; title(address: string): string }[] = []
  ctx.provide('sidebarRight', sidebarRight as never)
  ctx.provide('sidebarRightTabs', { register: (spec: never) => { tabTypes.push(spec); return () => {} } } as never)
  ctx.provide('layout', layout as never)
  ctx.provide('conversationViewport', (services.viewport ?? viewport) as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', {} as never)
  if (services.connection !== undefined) ctx.provide('connection', services.connection as never)
  ctx.provide('workspaceResources', (services.workspaceResources ?? new WorkspaceResourceRegistry()) as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  slots.register({ name: 'root', children: {
    'conversation.workbench.toolbar': { kind: 'single', scope: 'root' },
    'conversation.workbench.empty': { kind: 'single', scope: 'root' },
    'conversation.workbench.pane.header': { kind: 'list', scope: 'session' },
    'sidebar.workspaces.workbench': { kind: 'single', scope: 'root' },
    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session' },
  } } as never, () => null)
  const fiber = await ctx.plugin({ inject, apply }).await()
  const actions = (slots.entries('conversation.workbench.toolbar')[0]!.inject as unknown as () => {
    chooseSession(item: WorkbenchConversation, replace: boolean): Promise<unknown>
    createSession(target: WorkbenchConversation['runtime'], replace: boolean): Promise<unknown>
    hydrateCatalog(catalog: WorkbenchCatalog, ids: SessionId[]): Promise<void>
    catalogUnavailable(): void
    focusSession(id: SessionId): void
    setMode(mode: 'single' | 'workbench'): void
    listWorkbenches(): readonly unknown[]
    currentWorkbench(): unknown
    createWorkbench(name: string): string
    renameWorkbench(id: string, name: string): void
    duplicateWorkbench(id: string, name: string): string
    deleteWorkbench(id: string): void
    switchWorkbench(id: string): void
    openWorkspaceResource(request: unknown): void
    listWorkspaceDirectory(owner: unknown, path: string, signal: AbortSignal): Promise<unknown>
    readPreview(request: unknown, signal: AbortSignal): Promise<unknown>
    readBytesPreview(request: unknown, signal: AbortSignal): Promise<unknown>
    filesAvailable(): boolean
    openFiles(): void
  })()
  return {
    ctx, slots, fiber, sessions, viewport, snapshot, sidebarRight, layout, tabTypes,
    actions: { ...actions, ...createWorkspacePreviewReaders(services.connection as ConnectionHandle | undefined) },
  }
}

describe('workbench navigation lifecycle', () => {
  it('rejects missing viewport configuration at application', () => {
    expect(() => { apply(new Context()) }).toThrow('requires the conversation viewport')
  })

  it('checks capacity before remote creation and dispatches add, replace, focus and pane controls', async () => {
    const h = await harness()
    try {
      await expect(h.actions.chooseSession(item, false)).resolves.toEqual({ ok: true })
      expect(h.viewport.add).toHaveBeenCalledWith(A)
      await h.actions.chooseSession(item, true)
      expect(h.viewport.replaceActive).toHaveBeenCalledWith(A)
      h.actions.focusSession(A)
      h.actions.setMode('single')
      expect(h.viewport.focus).toHaveBeenCalledWith(A)
      expect(h.viewport.setMode).toHaveBeenCalledWith('single')
      h.snapshot.set({ mode: 'workbench', paneIds: ['b', 'c', 'd', 'e'] as SessionId[], paneRatios: [1, 1, 1, 1] })
      await expect(h.actions.chooseSession(item, false)).resolves.toEqual({ ok: false, reason: 'limit' })
      await expect(h.actions.createSession({ kind: 'personal' }, false)).resolves.toEqual({ ok: false, reason: 'limit' })
      expect(h.sessions.createSession).not.toHaveBeenCalled()
      await expect(h.actions.createSession({ kind: 'project', projectId: 1 }, true)).resolves.toEqual({ ok: true })
      const pane = (h.slots.entries('conversation.workbench.pane.header')[0]!.inject as unknown as (id: SessionId) => { replacePane(): void; movePane(direction: 'next'): void })(A)
      pane.replacePane()
      pane.movePane('next')
      expect(h.viewport.move).toHaveBeenCalledWith(A, 'next')
    } finally { await h.ctx.fiber.dispose() }
  })

  it.each(['choose', 'create'] as const)('a late %s cannot replace a newer navigation', async (operation) => {
    const h = await harness()
    const loading = Promise.withResolvers<boolean>()
    const creating = Promise.withResolvers<SessionId>()
    try {
      h.sessions.ensureSession.mockReturnValue(loading.promise)
      h.sessions.createSession.mockReturnValue(creating.promise)
      const pending = operation === 'choose'
        ? h.actions.chooseSession(item, true)
        : h.actions.createSession(item.runtime, true)
      h.sessions.beginNavigation()
      loading.resolve(true)
      creating.resolve(A)
      await expect(pending).resolves.toEqual({ ok: false, reason: 'unknown' })
      expect(h.viewport.replaceActive).not.toHaveBeenCalled()
      expect(h.viewport.add).not.toHaveBeenCalled()
    } finally { await h.ctx.fiber.dispose() }
  })

  it('reports unavailable sessions and hydrates only catalogued pane targets', async () => {
    const h = await harness()
    try {
      h.sessions.ensureSession.mockResolvedValue(false)
      await expect(h.actions.chooseSession(item, false)).resolves.toEqual({ ok: false, reason: 'unknown' })
      h.sessions.ensureSession.mockResolvedValue(true)
      await expect(h.actions.createSession({ kind: 'personal' }, false)).resolves.toEqual({ ok: true })
      await h.actions.hydrateCatalog(catalog, [A, 'missing' as SessionId])
      expect(h.sessions.setBaseRuntimeTarget).toHaveBeenCalledWith(catalog.activeRuntime)
      expect(h.viewport.markCatalogReady).toHaveBeenCalledOnce()
      h.actions.catalogUnavailable()
      expect(h.viewport.markCatalogReady).toHaveBeenCalledOnce()
    } finally { await h.ctx.fiber.dispose() }
  })

  it('resolves an encoded-looking legacy ID by its declared v2 version and does not reapply stale catalogs to live panes', async () => {
    const h = await harness()
    const raw = clientSessionKey({ kind: 'project', projectId: 7 }, A)
    const correct = clientSessionKey({ kind: 'personal' }, raw)
    const reconcile = vi.fn<(resolve: (id: SessionId, version: 2 | 3) => SessionId | undefined) => void>()
      .mockImplementation((resolve) => { expect(resolve(raw, 2)).toBe(correct) })
    const pending = vi.fn(() => true)
    Object.assign(h.viewport, {
      sessionKeyVersion: () => 2,
      needsCatalogRestore: pending,
      currentWorkbench: () => ({ id: 'w1', name: 'Saved', paneIds: [raw], updatedAt: 1 }),
      reconcileSessionKeys: reconcile,
    })
    Object.assign(h.sessions, { keyFor: (id: SessionId, target: SessionRuntimeTarget) => clientSessionKey(target, id) })
    const entries: WorkbenchCatalog = { ...catalog, items: [
      { ...item, sessionId: raw },
      { ...item, runtime: { kind: 'project', projectId: 7 } },
    ] }
    try {
      await h.actions.hydrateCatalog(entries, [])
      expect(h.sessions.ensureSession).toHaveBeenCalledExactlyOnceWith({ kind: 'personal' }, raw, expect.any(AbortSignal))
      expect(reconcile).toHaveBeenCalledOnce()
      pending.mockReturnValue(false)
      await h.actions.hydrateCatalog({ ...catalog, items: [] }, [correct])
      expect(reconcile).toHaveBeenCalledOnce()
      expect(h.sessions.ensureSession).toHaveBeenCalledOnce()
    } finally { await h.ctx.fiber.dispose() }
  })

  it.each(['manual', 'offline', 'revoked', 'missing'] as const)('restores %s outcomes without confusing unavailable runtimes with removed Sessions', async (failure) => {
    localStorage.clear()
    const runtime = await SlotTestRuntime.create()
    const raw = 'same' as SessionId
    const personal = clientSessionKey({ kind: 'personal' }, raw)
    const project = clientSessionKey({ kind: 'project', projectId: 7 }, raw)
    const keyFor = (id: SessionId, target: SessionRuntimeTarget = { kind: 'personal' }) => clientSessionKey(target, id)
    Object.assign(runtime.sessions, { keyFor })
    await runtime.sessions.add({ id: personal })
    const view = new ConversationViewportController(runtime.sessions, createConversationViewportStore().create())
    localStorage.setItem('dsh.conversation.workbenches.v3.account%3A1', JSON.stringify({
      version: 3, mode: 'workbench', activeId: 'saved', workbenches: [{
        id: 'saved', name: 'Saved', paneIds: [personal, project], activePaneId: project, paneRatios: [0.5, 0.5], updatedAt: 1,
      }],
    }))
    view.setPersistenceScope('account:1')
    view.setEnabled(true)
    const h = await harness({ viewport: view })
    Object.assign(h.sessions, { keyFor })
    h.sessions.ensureSession.mockImplementation(async (target?: SessionRuntimeTarget) => {
      if (target?.kind === 'personal') return true
      if (failure === 'missing') return false
      throw Object.assign(new Error(failure), { status: failure === 'revoked' ? 403 : failure === 'manual' ? 409 : 503 })
    })
    const directory: WorkbenchCatalog = { ...catalog, items: [
      { ...item, sessionId: raw }, { ...item, sessionId: raw, runtime: { kind: 'project', projectId: 7 } },
    ] }
    try {
      await h.actions.hydrateCatalog(directory, [])
      const retain = failure === 'manual' || failure === 'offline'
      expect(view.snapshot.getSnapshot().paneIds).toEqual(retain ? [personal, project] : [personal])
      expect(runtime.sessions.binding(project)).toBeUndefined()
      expect(h.sessions.createSession).not.toHaveBeenCalled()
      if (retain) {
        view.markCatalogReady()
        expect(view.currentWorkbench().paneIds).toEqual([personal, project])
        await runtime.sessions.add({ id: project })
        h.sessions.ensureSession.mockResolvedValue(true)
        await h.actions.hydrateCatalog(directory, [])
        expect(view.snapshot.getSnapshot().paneIds).toEqual([personal, project])
        expect(runtime.sessions.binding(project)).toBeDefined()
      }
      view.setPersistenceScope(undefined)
      expect(view.snapshot.getSnapshot().paneIds).toEqual([])
    } finally { view.dispose(); await h.ctx.fiber.dispose(); await runtime.dispose(); localStorage.clear() }
  })

  it('preserves unverified personal metadata during partial and failed catalogs without retaining missing project membership', async () => {
    localStorage.clear()
    const runtime = await SlotTestRuntime.create()
    const raw = 'same' as SessionId
    const personal = clientSessionKey({ kind: 'personal' }, raw)
    const project = clientSessionKey({ kind: 'project', projectId: 7 }, raw)
    const removed = clientSessionKey({ kind: 'project', projectId: 8 }, raw)
    const keyFor = (id: SessionId, target: SessionRuntimeTarget = { kind: 'personal' }) => clientSessionKey(target, id)
    Object.assign(runtime.sessions, { keyFor })
    await runtime.sessions.add({ id: project })
    localStorage.setItem('dsh.conversation.workbenches.v3.account%3A1', JSON.stringify({
      version: 3, mode: 'workbench', activeId: 'saved', workbenches: [{
        id: 'saved', name: 'Saved', paneIds: [personal, project, removed], activePaneId: personal, paneRatios: [1, 1, 1], updatedAt: 1,
      }],
    }))
    const view = new ConversationViewportController(runtime.sessions, createConversationViewportStore().create())
    view.setPersistenceScope('account:1')
    view.setEnabled(true)
    const h = await harness({ viewport: view })
    Object.assign(h.sessions, { keyFor })
    const directory: WorkbenchCatalog = { ...catalog, personalComplete: false, items: [
      { ...item, sessionId: raw, runtime: { kind: 'project', projectId: 7 } },
    ] }
    try {
      h.actions.catalogUnavailable()
      expect(view.currentWorkbench().paneIds).toEqual([personal, project, removed])
      expect(view.needsCatalogRestore()).toBe(true)
      await h.actions.hydrateCatalog(directory, [])
      expect(view.snapshot.getSnapshot().paneIds).toEqual([personal, project])
      expect(runtime.sessions.binding(personal)).toBeUndefined()
      expect(h.sessions.ensureSession).toHaveBeenCalledExactlyOnceWith({ kind: 'project', projectId: 7 }, raw, expect.any(AbortSignal))
      expect(h.sessions.createSession).not.toHaveBeenCalled()
      await runtime.sessions.add({ id: personal })
      await h.actions.hydrateCatalog({ ...directory, personalComplete: true, items: [...directory.items, { ...item, sessionId: raw }] }, [])
      expect(view.snapshot.getSnapshot().paneIds).toEqual([personal, project])
      expect(runtime.sessions.binding(personal)).toBeDefined()
      expect(view.needsCatalogRestore()).toBe(false)
    } finally { view.dispose(); await h.ctx.fiber.dispose(); await runtime.dispose(); localStorage.clear() }
  })

  it('keeps a v2 raw ID unresolved while an unavailable personal runtime could own the same ID', async () => {
    localStorage.clear()
    const runtime = await SlotTestRuntime.create()
    Object.assign(runtime.sessions, { keyFor: (id: SessionId, target: SessionRuntimeTarget) => clientSessionKey(target, id) })
    localStorage.setItem('dsh.conversation.workbenches.v2.account%3A1', JSON.stringify({
      version: 2, mode: 'workbench', activeId: 'saved', workbenches: [{
        id: 'saved', name: 'Saved', paneIds: [A], activePaneId: A, paneRatios: [1], updatedAt: 1,
      }],
    }))
    const view = new ConversationViewportController(runtime.sessions, createConversationViewportStore().create())
    view.setPersistenceScope('account:1')
    view.setEnabled(true)
    const h = await harness({ viewport: view })
    const directory: WorkbenchCatalog = { ...catalog, personalComplete: false, items: [{ ...item, runtime: { kind: 'project', projectId: 7 } }] }
    try {
      await h.actions.hydrateCatalog(directory, [])
      expect(view.sessionKeyVersion()).toBe(2)
      expect(view.currentWorkbench().paneIds).toEqual([A])
      expect(view.snapshot.getSnapshot().paneIds).toEqual([])
      expect(h.sessions.ensureSession).not.toHaveBeenCalled()
      expect(h.sessions.createSession).not.toHaveBeenCalled()
      const project = clientSessionKey({ kind: 'project', projectId: 7 }, A)
      await runtime.sessions.add({ id: project })
      expect(view.snapshot.getSnapshot().pendingIdentity).toBe(true)
      expect(view.add(project)).toEqual({ ok: false, reason: 'unknown' })
      expect(view.replaceActive(project)).toEqual({ ok: false, reason: 'unknown' })
      await expect(h.actions.chooseSession(directory.items[0]!, false)).resolves.toEqual({ ok: false, reason: 'unknown' })
      await expect(h.actions.createSession({ kind: 'project', projectId: 7 }, false)).resolves.toEqual({ ok: false, reason: 'unknown' })
      for (const edit of [
        () => view.createWorkbench('New'), () => view.duplicateWorkbench('saved', 'Copy'),
        () => { view.renameWorkbench('saved', 'Changed') }, () => { view.deleteWorkbench('saved') },
        () => { view.remove(project) }, () => { view.move(project, 'next') }, () => { view.setPaneRatios([1]) },
      ]) expect(edit).toThrow('identities are not verified')
      expect(view.currentWorkbench().paneIds).toEqual([A])
      expect(h.sessions.ensureSession).not.toHaveBeenCalled()
      expect(h.sessions.createSession).not.toHaveBeenCalled()
      view.setMode('single')
      expect(view.snapshot.getSnapshot().mode).toBe('single')
      view.setMode('workbench')
      await h.actions.hydrateCatalog({ ...directory, personalComplete: true, items: [item, ...directory.items] }, [])
      expect(view.sessionKeyVersion()).toBe(3)
      expect(view.currentWorkbench().paneIds).toEqual([])
      expect(h.sessions.ensureSession).not.toHaveBeenCalled()
      expect(view.snapshot.getSnapshot().pendingIdentity).toBeUndefined()
      expect(view.add(project)).toEqual({ ok: true })
      expect(view.currentWorkbench().paneIds).toEqual([project])
    } finally { view.dispose(); await h.ctx.fiber.dispose(); await runtime.dispose(); localStorage.clear() }
  })

  it.each([true, false, undefined])('only uses a local restoration baseline when the Host explicitly declares independent authority (%s)', async (authority) => {
    const h = await harness({ connection: { hostDescription: { getSnapshot: () => ({ executionAuthorityRequired: authority }) } } })
    try {
      h.actions.catalogUnavailable()
      expect(h.viewport.markCatalogReady).toHaveBeenCalledTimes(authority === false ? 1 : 0)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('handles optional runtime methods and does not duplicate a pinned pane', async () => {
    const h = await harness()
    try {
      h.snapshot.set({ mode: 'workbench', paneIds: [A, 'b', 'c', 'd'] as SessionId[], paneRatios: [1, 1, 1, 1] })
      await expect(h.actions.chooseSession(item, false)).resolves.toEqual({ ok: true })
      Object.assign(h.sessions, { ensureSession: undefined, createSession: undefined, setBaseRuntimeTarget: undefined })
      await expect(h.actions.chooseSession(item, true)).resolves.toEqual({ ok: false, reason: 'unknown' })
      await expect(h.actions.createSession({ kind: 'personal' }, true)).resolves.toEqual({ ok: false, reason: 'unknown' })
      await h.actions.hydrateCatalog(catalog, [A])
      expect(h.viewport.markCatalogReady).toHaveBeenCalledOnce()
      await h.fiber.dispose()
      await h.actions.hydrateCatalog(catalog, [A])
      expect(h.viewport.markCatalogReady).toHaveBeenCalledOnce()
    } finally { await h.ctx.fiber.dispose() }
  })

  it('does not navigate when a remote creation finishes after the plugin is disposed', async () => {
    const h = await harness()
    const pending = Promise.withResolvers<SessionId>()
    h.sessions.createSession.mockReturnValue(pending.promise)
    const creation = h.actions.createSession({ kind: 'personal' }, false)
    const pendingEnsure = Promise.withResolvers<boolean>()
    h.sessions.ensureSession.mockReturnValue(pendingEnsure.promise)
    const hydration = h.actions.hydrateCatalog(catalog, [A])
    const choice = h.actions.chooseSession(item, false)
    await h.fiber.dispose()
    pending.resolve(A)
    pendingEnsure.resolve(true)
    await hydration
    await expect(choice).resolves.toEqual({ ok: false, reason: 'unknown' })
    await expect(creation).resolves.toEqual({ ok: false, reason: 'unknown' })
    h.actions.catalogUnavailable()
    expect(h.viewport.add).not.toHaveBeenCalled()
    expect(h.viewport.markCatalogReady).not.toHaveBeenCalled()
    expect(h.slots.entries('conversation.workbench.toolbar')).toHaveLength(0)
    await h.ctx.fiber.dispose()
  })

  it('registers the sidebar panel with pane actions and a declared display hole', async () => {
    const h = await harness()
    try {
      const entry = h.slots.entries('sidebar.workspaces.workbench')[0]
      expect(entry).toBeDefined()
      const face = (entry!.inject as unknown as () => {
        focusPane(id: SessionId): void
        removePane(id: SessionId): void
        setPaneRatios(ratios: readonly number[]): void
        exitWorkbench(): void
      })()
      face.focusPane(A)
      face.removePane(A)
      face.setPaneRatios([1, 1])
      face.exitWorkbench()
      expect(h.viewport.focus).toHaveBeenCalledWith(A)
      expect(h.viewport.remove).toHaveBeenCalledWith(A)
      expect(h.viewport.setPaneRatios).toHaveBeenCalledWith([1, 1])
      expect(h.viewport.setMode).toHaveBeenCalledWith('single')
      // Registering into the panel's display hole succeeds only because the
      // panel's own registration declared it.
      const release = h.slots.register({ name: 'conversation.workbench.display' } as never, () => null)
      expect(h.slots.entries('conversation.workbench.display')).toHaveLength(1)
      release()
    } finally { await h.ctx.fiber.dispose() }
  })

  it('delegates workbench layout management to the viewport capability', async () => {
    const h = await harness()
    try {
      expect(h.actions.listWorkbenches()).toEqual([])
      expect(h.viewport.listWorkbenches).toHaveBeenCalledOnce()
      expect(h.actions.currentWorkbench()).toEqual({ id: 'w1', name: 'Sessions', paneIds: [], updatedAt: 1 })
      expect(h.viewport.currentWorkbench).toHaveBeenCalledOnce()
      expect(h.actions.createWorkbench('Studio')).toBe('w2')
      expect(h.viewport.createWorkbench).toHaveBeenCalledWith('Studio')
      h.actions.renameWorkbench('w1', 'Renamed')
      expect(h.viewport.renameWorkbench).toHaveBeenCalledWith('w1', 'Renamed')
      expect(h.actions.duplicateWorkbench('w1', 'Copy')).toBe('w3')
      expect(h.viewport.duplicateWorkbench).toHaveBeenCalledWith('w1', 'Copy')
      h.actions.deleteWorkbench('w2')
      expect(h.viewport.deleteWorkbench).toHaveBeenCalledWith('w2')
      h.actions.switchWorkbench('w1')
      expect(h.viewport.switchWorkbench).toHaveBeenCalledWith('w1')
    } finally { await h.ctx.fiber.dispose() }
  })

  it('defaults workbench layout reads when the viewport lacks the optional methods', async () => {
    const h = await harness()
    try {
      Object.assign(h.viewport, {
        listWorkbenches: undefined, currentWorkbench: undefined, createWorkbench: undefined,
        renameWorkbench: undefined, duplicateWorkbench: undefined, deleteWorkbench: undefined, switchWorkbench: undefined,
      })
      expect(h.actions.listWorkbenches()).toEqual([])
      expect(h.actions.currentWorkbench()).toBeUndefined()
      expect(h.actions.createWorkbench('Studio')).toBe('')
      h.actions.renameWorkbench('w1', 'Renamed')
      expect(h.actions.duplicateWorkbench('w1', 'Copy')).toBe('')
      h.actions.deleteWorkbench('w2')
      h.actions.switchWorkbench('w1')
    } finally { await h.ctx.fiber.dispose() }
  })
})

describe('workspace file serving', () => {
  const baseOwner = { sessionId: A, runtimeTarget: { kind: 'base' as const } }
  const projOwner = { sessionId: A, runtimeTarget: { kind: 'project' as const, projectId: 7 } }
  const openRequest = { runtimeTarget: { kind: 'base' as const }, sessionId: A, path: 'a.txt', address: workspaceResourceAddress(A, 'a.txt') }

  const connection = (files?: { ok?: boolean }) => ({
    isLoopback: false,
    api: {
      workspaceFiles: {
        list: vi.fn(async () => ({ result: files?.ok === false
          ? { ok: false, error: { code: 'denied', message: 'denied' } }
          : { ok: true, value: 'listing' } })),
        read: vi.fn(async () => ({ result: files?.ok === false
          ? { ok: false, error: { code: 'denied', message: 'denied' } }
          : { ok: true, value: 'text' } })),
        readBytes: vi.fn(async () => ({ result: files?.ok === false
          ? { ok: false, error: { code: 'denied', message: 'denied' } }
          : { ok: true, value: 'bytes' } })),
      },
    },
    forTarget: vi.fn(),
  })

  it('routes directory listing and previews through the owner runtime target', async () => {
    const conn = connection()
    const target = connection()
    conn.forTarget.mockReturnValue(target)
    const h = await harness({ connection: conn })
    try {
      const signal = new AbortController().signal
      await expect(h.actions.listWorkspaceDirectory(baseOwner, '.', signal)).resolves.toBe('listing')
      expect(conn.api.workspaceFiles.list).toHaveBeenCalledWith({ sessionId: A, path: '.' }, signal)
      await expect(h.actions.listWorkspaceDirectory(projOwner, 'd', signal)).resolves.toBe('listing')
      expect(conn.forTarget).toHaveBeenCalledWith(projOwner.runtimeTarget)
      expect(target.api.workspaceFiles.list).toHaveBeenCalledWith({ sessionId: A, path: 'd' }, signal)
      const resource = { resource: { ...openRequest, runtimeTarget: projOwner.runtimeTarget }, offset: 0, version: 'v1' }
      await expect(h.actions.readPreview(resource, signal)).resolves.toBe('text')
      expect(target.api.workspaceFiles.read).toHaveBeenCalledWith(
        { sessionId: A, path: 'a.txt', offset: 0, version: 'v1' }, signal)
      const bytes = { resource: openRequest, offset: 2, length: 5, version: 'v1' }
      await expect(h.actions.readBytesPreview(bytes, signal)).resolves.toBe('bytes')
      expect(conn.api.workspaceFiles.readBytes).toHaveBeenCalledWith(
        { sessionId: A, path: 'a.txt', offset: 2, length: 5, version: 'v1' }, signal)
      h.actions.openWorkspaceResource(openRequest)
    } finally { await h.ctx.fiber.dispose() }
  })

  it('rejects file requests without a usable runtime connection', async () => {
    const conn = connection({ ok: false })
    conn.forTarget.mockReturnValue(undefined)
    const h = await harness({ connection: conn })
    const bare = await harness()
    try {
      const signal = new AbortController().signal
      await expect(h.actions.listWorkspaceDirectory(projOwner, '.', signal)).rejects.toThrow('Workspace runtime is unavailable')
      await expect(h.actions.listWorkspaceDirectory(baseOwner, '.', signal)).rejects.toThrow('denied')
      await expect(h.actions.readPreview({ resource: openRequest, offset: 0, version: 'v' }, signal)).rejects.toThrow('denied')
      const projResource = { resource: { ...openRequest, runtimeTarget: projOwner.runtimeTarget }, offset: 0, version: 'v' }
      await expect(h.actions.readPreview(projResource, signal)).rejects.toThrow('Workspace runtime is unavailable')
      await expect(h.actions.readBytesPreview({ ...projResource, length: 1 }, signal)).rejects.toThrow('Workspace runtime is unavailable')
      await expect(h.actions.readBytesPreview({ resource: openRequest, offset: 0, length: 1, version: 'v' }, signal)).rejects.toThrow('denied')
      await expect(bare.actions.listWorkspaceDirectory(baseOwner, '.', signal)).rejects.toThrow('Workspace connection is unavailable')
      await expect(bare.actions.readPreview({ resource: openRequest, offset: 0, version: 'v' }, signal)).rejects.toThrow('Workspace file preview requires a connection')
      await expect(bare.actions.readBytesPreview({ resource: openRequest, offset: 0, length: 1, version: 'v' }, signal)).rejects.toThrow('Workspace connection requires a live runtime')
    } finally { await h.ctx.fiber.dispose(); await bare.ctx.fiber.dispose() }
  })

  it('opens previews for hosted resource-open requests and exposes pane file actions', async () => {
    const conn = connection()
    const resources = { hasProvider: vi.fn(() => true) }
    const h = await harness({ connection: conn, workspaceResources: resources })
    try {
      expect(h.ctx.bail('workspace/resource-open', openRequest)).toBe(true)
      expect(h.sidebarRight.openSessionResource).toHaveBeenCalledWith(A, openRequest.address, { kind: 'workspace-file' })
      expect(h.layout.focusRightbar).toHaveBeenCalledWith(A)
      expect(() =>{  h.actions.openWorkspaceResource({ ...openRequest, runtimeTarget: { kind: 'project', projectId: 9 } }) }).toThrow('runtime no longer owns')
      const pane = (h.slots.entries('conversation.workbench.pane.header')[0]!.inject as unknown as (id: SessionId) => {
        filesAvailable(): boolean
        openFiles(): void
      })(A)
      expect(pane.filesAvailable()).toBe(true)
      expect(resources.hasProvider).toHaveBeenCalledWith({ kind: 'base' })
      pane.openFiles()
      expect(h.actions.filesAvailable()).toBe(false)
      h.actions.openFiles()
      h.snapshot.set({ mode: 'workbench', paneIds: [A], activePaneId: A, paneRatios: [1] })
      expect(h.actions.filesAvailable()).toBe(true)
      h.actions.openFiles()
      h.snapshot.set({ mode: 'single', paneIds: [], paneRatios: [] })
      expect(h.actions.filesAvailable()).toBe(true)
      h.actions.openFiles()
    } finally { await h.ctx.fiber.dispose() }
  })

  it('refuses a resource open when the session runtime moved to another project and forwards a target line', async () => {
    const conn = connection()
    const h = await harness({ connection: conn })
    try {
      h.sessions.runtimeTargetFor.mockReturnValue({ kind: 'project', projectId: 7 })
      expect(() => { h.actions.openWorkspaceResource({ ...openRequest, runtimeTarget: { kind: 'project', projectId: 9 } }) })
        .toThrow('runtime no longer owns')
      h.actions.openWorkspaceResource({ ...openRequest, runtimeTarget: { kind: 'project', projectId: 7 }, line: 4 })
      expect(h.sidebarRight.openSessionResource).toHaveBeenCalledWith(A, openRequest.address, { kind: 'workspace-file', params: { line: 4 } })
    } finally { await h.ctx.fiber.dispose() }
  })

  it('declares the workspace-file tab type over the resource address grammar', async () => {
    const h = await harness({ connection: connection() })
    try {
      const tab = h.tabTypes[0]!
      expect(tab.canOpen(openRequest.address)).toBe(true)
      expect(tab.canOpen('https://example.com/a.txt')).toBe(false)
      expect(tab.title(openRequest.address)).toBe('a.txt')
      expect(tab.title('dsh-resource://elsewhere')).toBe('dsh-resource://elsewhere')
    } finally { await h.ctx.fiber.dispose() }
  })

  it('exposes the pane tab inject face with per-session runtime and html packing', async () => {
    const h = await harness({ connection: connection() })
    try {
      const entry = h.slots.entries('sidebar.right.pane.tab')[0]!
      const face = (entry.inject as unknown as (id: SessionId) => {
        runtimeTarget(): SessionRuntimeTarget
        renderHtml(
          data: Uint8Array,
          read: (request: unknown, signal: AbortSignal) => Promise<{ bytes: string; version: string }>,
          request: unknown, lifetime: AbortSignal, signal: AbortSignal,
        ): Promise<string>
      })(A)
      expect(face.runtimeTarget()).toEqual({ kind: 'base' })
      h.sessions.runtimeTargetFor.mockReturnValue({ kind: 'project', projectId: 7 })
      expect(face.runtimeTarget()).toEqual({ kind: 'project', projectId: 7 })
      Object.assign(h.sessions, { runtimeTargetFor: undefined })
      expect(face.runtimeTarget()).toEqual({ kind: 'base' })
      const read = vi.fn(async () => ({ bytes: btoa('\x01\x02\x03'), version: 'v1' }))
      const html = await face.renderHtml(
        new TextEncoder().encode('<p><img src="icon.png"></p>'), read,
        openRequest, new AbortController().signal, new AbortController().signal,
      )
      expect(read).toHaveBeenCalledOnce()
      expect(html).toContain('<!doctype html>')
    } finally { await h.ctx.fiber.dispose() }
  })

  it('ignores resource-open requests without provider or connection and hides unavailable pane files', async () => {
    const none = await harness()
    const conn = connection()
    conn.isLoopback = true
    const noProvider = { hasProvider: vi.fn(() => false) }
    const h = await harness({ connection: conn, workspaceResources: noProvider })
    try {
      expect(none.ctx.bail('workspace/resource-open', openRequest)).toBeUndefined()
      expect(h.ctx.bail('workspace/resource-open', openRequest)).toBeUndefined()
      const pane = (h.slots.entries('conversation.workbench.pane.header')[0]!.inject as unknown as (id: SessionId) => {
        filesAvailable(): boolean
        openFiles(): void
      })(A)
      // isLoopback hosts serve files natively, so the in-app action stays hidden.
      expect(pane.filesAvailable()).toBe(false)
    } finally { await none.ctx.fiber.dispose(); await h.ctx.fiber.dispose() }
  })
})

describe('ui-workbench node half', () => {
  it('embeds validated spreadsheet limits into browser index pages', async () => {
    const ctx = new Context()
    const table: IndexInjection[] = []
    ctx.on('webserver/index-inject', (rows) => { table.push(...rows) })
    const fiber = ctx.plugin({ apply: (scope) => { nodeApply(scope, Config({})) } })
    try {
      await fiber.await()
      ctx.emit('webserver/index-inject', table)
      expect(table).toEqual([{ kind: 'global', name: '__DSH_WORKBENCH_CONFIG__', value: Config({}) }])
    } finally { await fiber.dispose() }
  })
})
