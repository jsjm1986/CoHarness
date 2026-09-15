import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry, createSnapshotStore, workspaceResourceAddress } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationViewportSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/apply.ts'
import type { WorkbenchCatalog, WorkbenchConversation } from '../src/client/catalog.ts'

const A = 'a' as SessionId
const item: WorkbenchConversation = { sessionId: A, runtime: { kind: 'personal' }, visibility: 'personal', creatorUserId: 1, creatorDisplayName: 'A', updatedAt: 1, blank: false, canWrite: true }
const catalog: WorkbenchCatalog = { personal: { id: 1, name: 'Me' }, activeRuntime: { kind: 'personal' }, projects: [], items: [item] }

async function harness(services: { connection?: unknown; workspaceResources?: unknown } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const slots = ctx.get('slots') as SlotRegistry
  const snapshot = createSnapshotStore<ConversationViewportSnapshot>({ mode: 'workbench', paneIds: [], paneRatios: [] })
  const viewport = {
    snapshot,
    add: vi.fn(() => ({ ok: true })),
    replaceActive: vi.fn(() => ({ ok: true })),
    focus: vi.fn(), move: vi.fn(), setMode: vi.fn(), markCatalogReady: vi.fn(),
    listWorkbenches: vi.fn(() => []),
    currentWorkbench: vi.fn(() => ({ id: 'w1', name: 'Sessions', paneIds: [], updatedAt: 1 })),
    createWorkbench: vi.fn(() => 'w2'),
    renameWorkbench: vi.fn(),
    duplicateWorkbench: vi.fn(() => 'w3'),
    deleteWorkbench: vi.fn(),
    switchWorkbench: vi.fn(),
  }
  const sessions = {
    ensureSession: vi.fn(async () => true), createSession: vi.fn(async () => A), setBaseRuntimeTarget: vi.fn(),
    runtimeTargetFor: vi.fn((_id: SessionId) => undefined as { kind: 'project'; projectId: number } | undefined),
  }
  ctx.provide('conversationViewport', viewport as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', {} as never)
  if (services.connection !== undefined) ctx.provide('connection', services.connection as never)
  if (services.workspaceResources !== undefined) ctx.provide('workspaceResources', services.workspaceResources as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  slots.register({ name: 'root', children: {
    'conversation.workbench.toolbar': { kind: 'single', scope: 'root' },
    'conversation.workbench.empty': { kind: 'single', scope: 'root' },
    'conversation.workbench.pane.header': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  const fiber = await ctx.plugin({ inject, apply }).await()
  const actions = (slots.entries('conversation.workbench.toolbar')[0]!.inject as unknown as () => {
    chooseSession(item: WorkbenchConversation, replace: boolean): Promise<unknown>
    createSession(target: WorkbenchConversation['runtime'], replace: boolean): Promise<unknown>
    hydrateCatalog(catalog: WorkbenchCatalog, ids: SessionId[]): Promise<void>
    markCatalogReady(): void
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
  })()
  return { ctx, slots, fiber, sessions, viewport, snapshot, actions }
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
      h.actions.markCatalogReady()
      expect(h.viewport.markCatalogReady).toHaveBeenCalledTimes(2)
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
    h.actions.markCatalogReady()
    expect(h.viewport.add).not.toHaveBeenCalled()
    expect(h.viewport.markCatalogReady).not.toHaveBeenCalled()
    expect(h.slots.entries('conversation.workbench.toolbar')).toHaveLength(0)
    await h.ctx.fiber.dispose()
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
      const pane = (h.slots.entries('conversation.workbench.pane.header')[0]!.inject as unknown as (id: SessionId) => {
        filesAvailable(): boolean
        openFiles(): void
      })(A)
      expect(pane.filesAvailable()).toBe(true)
      expect(resources.hasProvider).toHaveBeenCalledWith({ kind: 'base' })
      pane.openFiles()
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
