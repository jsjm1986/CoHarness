// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, type ISessions, type SessionId, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationViewportController, createConversationViewportStore } from '../src/client/viewport.ts'

const id = (value: string) => value as SessionId

function harness() {
  const list = createSnapshotStore<SessionListState>({
    ids: [id('a'), id('b'), id('c'), id('d'), id('e')],
    byId: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(value => [id(value), {
      id: id(value), displayTitle: value, running: false, blank: false, updatedAt: 0,
    }])),
    current: id('a'), phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const opened: SessionId[] = []
  const staged: SessionId[][] = []
  const sessions = {
    list,
    open: (sessionId: SessionId) => {
      opened.push(sessionId)
      list.set({ ...list.getSnapshot(), current: sessionId })
    },
    clear: vi.fn(),
    setAdditionalStaged: (ids: readonly SessionId[]) => { staged.push([...ids]) },
  } as unknown as ISessions
  return { list, sessions, opened, staged }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.restoreAllMocks() })

describe('ConversationViewportController', () => {
  it('bounds panes, focuses duplicates, and stages only workbench panes', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    expect(viewport.snapshot.getSnapshot().mode).toBe('single')
    viewport.setEnabled(true)
    expect(viewport.add(id('a'))).toEqual({ ok: true })
    expect(viewport.add(id('a'))).toEqual({ ok: false, reason: 'duplicate' })
    expect(viewport.add(id('b'))).toEqual({ ok: true })
    expect(viewport.add(id('c'))).toEqual({ ok: true })
    expect(viewport.add(id('d'))).toEqual({ ok: true })
    expect(viewport.add(id('e'))).toEqual({ ok: false, reason: 'limit' })
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('a'), id('b'), id('c'), id('d')])
    expect(h.staged.at(-1)).toEqual([id('a'), id('b'), id('c'), id('d')])
    viewport.setMode('single')
    expect(h.staged.at(-1)).toEqual([])
    viewport.dispose()
  })

  it('removes the active pane, selects its neighbor, and persists ratios', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setEnabled(true)
    viewport.add(id('a'))
    viewport.add(id('b'))
    viewport.setPaneRatios([2, 1])
    expect(viewport.snapshot.getSnapshot().paneRatios).toEqual([2 / 3, 1 / 3])
    viewport.remove(id('b'))
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('a')])
    expect(viewport.snapshot.getSnapshot().activePaneId).toBe(id('a'))
    expect(h.opened.at(-1)).toBe(id('a'))
    viewport.dispose()
  })

  it('drops stale persisted ids when the list baseline changes', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setEnabled(true)
    viewport.add(id('a'))
    viewport.add(id('b'))
    viewport.markCatalogReady()
    h.list.set({ ...h.list.getSnapshot(), ids: [id('a')], byId: { [id('a')]: h.list.getSnapshot().byId[id('a')]! } })
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('a')])
    viewport.dispose()
  })
  it('starts empty despite the current Session, and replaces only on a subsequent navigation', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setEnabled(true)
    h.list.set({ ...h.list.getSnapshot(), byId: { ...h.list.getSnapshot().byId } })
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([])
    h.sessions.open(id('b'))
    viewport.replaceActive(id('b'))
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('b')])
    viewport.add(id('c'))
    h.sessions.open(id('d'))
    viewport.replaceActive(id('d'))
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('b'), id('d')])
    h.sessions.open(id('b'))
    viewport.focus(id('b'))
    expect(viewport.snapshot.getSnapshot().activePaneId).toBe(id('b'))
    viewport.dispose()
  })

  it('restores validated layout after the first list baseline without losing it during reconnect', () => {
    localStorage.setItem('dsh.conversation.workbench.v1', JSON.stringify({ mode: 'workbench', paneIds: ['b', 'b', 'missing', 'c'], activePaneId: 'c', paneRatios: [1, -1, 'bad', 3] }))
    const h = harness()
    h.list.set({ ...h.list.getSnapshot(), phase: 'pending', ids: [], byId: {}, current: undefined })
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setEnabled(true)
    expect(h.staged).toEqual([])
    const ready = harness().list.getSnapshot()
    h.list.set(ready)
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('b'), id('missing'), id('c')])
    expect(h.list.getSnapshot().current).toBe(id('c'))
    expect(h.staged.at(-1)).toEqual([id('b'), id('missing'), id('c')])
    viewport.markCatalogReady()
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('b'), id('c')])
    h.list.set({ ...ready, phase: 'pending', current: undefined, byId: {}, ids: [] })
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('b'), id('c')])
    expect(h.staged.at(-1)).toEqual([id('b'), id('c')])
    viewport.dispose()
  })

  it('normalizes invalid persisted state, rejects unknown Sessions, and retains ratios with reordered panes', () => {
    localStorage.setItem('dsh.conversation.workbench.v1', 'null')
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setEnabled(true)
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([])
    expect(viewport.add(id('unknown'))).toEqual({ ok: false, reason: 'unknown' })
    expect(viewport.replaceActive(id('unknown'))).toEqual({ ok: false, reason: 'unknown' })
    viewport.add(id('a')); viewport.add(id('b')); viewport.add(id('c'))
    viewport.setPaneRatios([1, 2, 3])
    viewport.move(id('b'), 'previous')
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('b'), id('a'), id('c')])
    expect(viewport.snapshot.getSnapshot().paneRatios).toEqual([2 / 6, 1 / 6, 3 / 6])
    viewport.move(id('b'), 'previous')
    viewport.remove(id('unknown'))
    viewport.focus(id('unknown'))
    viewport.remove(id('c'))
    viewport.remove(id('a'))
    viewport.remove(id('b'))
    expect(viewport.snapshot.getSnapshot()).not.toHaveProperty('activePaneId')
    // oxlint-disable-next-line typescript/unbound-method -- the fixture's clear is a standalone spy.
    expect(h.sessions.clear).toHaveBeenCalledOnce()
    viewport.dispose()
    viewport.dispose()
    expect(viewport.add(id('a'))).toEqual({ ok: false, reason: 'unknown' })
  })

  it('creates, duplicates, switches, and deletes independent workbench layouts', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setEnabled(true)
    viewport.add(id('a'))
    const created = viewport.createWorkbench?.('Review')
    expect(created).toBeDefined()
    expect(viewport.currentWorkbench?.()).toMatchObject({ name: 'Review', paneIds: [] })
    viewport.add(id('b'))
    const copy = viewport.duplicateWorkbench?.(created, 'Review copy')
    expect(viewport.currentWorkbench?.()).toMatchObject({ id: copy, name: 'Review copy', paneIds: [id('b')] })
    viewport.switchWorkbench?.(created)
    expect(viewport.currentWorkbench?.()).toMatchObject({ id: created, paneIds: [id('b')] })
    viewport.deleteWorkbench?.(created)
    expect(viewport.currentWorkbench?.().id).not.toBe(created)
    viewport.dispose()
  })

  it('keeps the persisted active pane when the saved workbench restores its pane set', () => {
    localStorage.setItem('dsh.conversation.workbench.v1', JSON.stringify({ mode: 'workbench', paneIds: ['a', 'b', 'd'], activePaneId: 'd', paneRatios: [] }))
    localStorage.setItem('dsh.conversation.workbenches.v1', JSON.stringify({ activeId: 'default', workbenches: [{ id: 'default', name: '我的工作台', paneIds: ['a', 'b', 'd'], paneRatios: [], updatedAt: 1 }] }))
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    expect(viewport.snapshot.getSnapshot().activePaneId).toBe(id('d'))
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('a'), id('b'), id('d')])
    viewport.dispose()
  })

  it('restores an added pane after a new viewport instance is created', () => {
    const first = harness()
    const original = new ConversationViewportController(first.sessions, createConversationViewportStore().create())
    original.setEnabled(true)
    original.add(id('b'))
    original.dispose()
    const next = harness()
    const restored = new ConversationViewportController(next.sessions, createConversationViewportStore().create())
    expect(restored.currentWorkbench?.().paneIds).toEqual([id('b')])
    restored.dispose()
  })

})
