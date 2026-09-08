import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry, createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationViewportSnapshot, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/apply.ts'
import type { WorkbenchCatalog, WorkbenchConversation } from '../src/client/catalog.ts'

const A = 'a' as SessionId
const item: WorkbenchConversation = { sessionId: A, runtime: { kind: 'personal' }, visibility: 'personal', creatorUserId: 1, creatorDisplayName: 'A', updatedAt: 1, blank: false, canWrite: true }
const catalog: WorkbenchCatalog = { personal: { id: 1, name: 'Me' }, activeRuntime: { kind: 'personal' }, projects: [], items: [item] }

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry)
  const slots = ctx.get('slots') as SlotRegistry
  const snapshot = createSnapshotStore<ConversationViewportSnapshot>({ mode: 'workbench', paneIds: [], paneRatios: [] })
  const viewport = {
    snapshot,
    add: vi.fn(() => ({ ok: true })),
    replaceActive: vi.fn(() => ({ ok: true })),
    focus: vi.fn(), move: vi.fn(), setMode: vi.fn(), markCatalogReady: vi.fn(),
  }
  const sessions = { ensureSession: vi.fn(async () => true), createSession: vi.fn(async () => A), setBaseRuntimeTarget: vi.fn() }
  ctx.provide('conversationViewport', viewport as never)
  ctx.provide('sessions', sessions as never)
  ctx.provide('workspaces', {} as never)
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
  })()
  return { ctx, slots, fiber, sessions, viewport, snapshot, actions }
}

describe('workbench navigation lifecycle', () => {
  it('rejects missing viewport configuration at application', () => {
    expect(() => apply(new Context() as never)).toThrow('requires the conversation viewport')
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
})
