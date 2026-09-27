// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, NavigationController, type ISessions, type SessionId, type SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationViewportController, createConversationViewportStore } from '../src/client/viewport.ts'

const id = (value: string) => value as SessionId

function harness() {
  const list = createSnapshotStore<SessionListState>({
    ids: [id('a'), id('b'), id('c'), id('d'), id('e')],
    byId: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(value => [id(value), {
      id: id(value), displayTitle: value, running: false, blank: false, updatedAt: 0,
    }])),
    archivedById: {},
    current: id('a'), phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const opened: SessionId[] = []
  const staged: SessionId[][] = []
  const navigation = new NavigationController()
  const sessions = {
    beginNavigation: () => navigation.begin(),
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
  it('pane focus, presentation, and layout changes supersede pending navigation', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setPersistenceScope('local')
    viewport.setEnabled(true)
    viewport.add(id('a'))
    try {
      const focus = h.sessions.beginNavigation()
      viewport.focus(id('a'))
      expect(focus.aborted).toBe(true)
      const mode = h.sessions.beginNavigation()
      viewport.setMode('single')
      expect(mode.aborted).toBe(true)
      const layout = h.sessions.beginNavigation()
      viewport.createWorkbench('Another layout')
      expect(layout.aborted).toBe(true)
    } finally { viewport.dispose() }
  })

  it('bounds panes, focuses duplicates, and stages only workbench panes', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setPersistenceScope('local')
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
    viewport.setPersistenceScope('local')
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
    viewport.setPersistenceScope('local')
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
    viewport.setPersistenceScope('local')
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
    viewport.setPersistenceScope('local')
    viewport.setEnabled(true)
    expect(h.staged).toEqual([])
    const ready = harness().list.getSnapshot()
    h.list.set(ready)
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('b'), id('c')])
    expect(h.list.getSnapshot().current).toBe(id('c'))
    expect(h.staged.at(-1)).toEqual([id('b'), id('c')])
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
    viewport.setPersistenceScope('local')
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
    viewport.setPersistenceScope('local')
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
    viewport.setPersistenceScope('local')
    expect(viewport.snapshot.getSnapshot().activePaneId).toBe(id('d'))
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([id('a'), id('b'), id('d')])
    viewport.dispose()
  })

  it('restores an added pane after a new viewport instance is created', () => {
    const first = harness()
    const original = new ConversationViewportController(first.sessions, createConversationViewportStore().create())
    original.setPersistenceScope('local')
    original.setEnabled(true)
    original.add(id('b'))
    original.dispose()
    const next = harness()
    const restored = new ConversationViewportController(next.sessions, createConversationViewportStore().create())
    restored.setPersistenceScope('local')
    expect(restored.currentWorkbench?.().paneIds).toEqual([id('b')])
    restored.dispose()
  })

  it('isolates named layouts by verified account and releases panes when proof is lost', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    viewport.setEnabled(true)
    viewport.setPersistenceScope('account:1')
    viewport.add(id('a'))
    viewport.add(id('b'))
    viewport.setPaneRatios([1, 3])
    viewport.renameWorkbench('default', 'Private project')
    viewport.setPersistenceScope('account:2')
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([])
    expect(viewport.listWorkbenches().map(row => row.name)).not.toContain('Private project')
    expect(h.staged.at(-1)).toEqual([])
    viewport.add(id('c'))
    viewport.setPersistenceScope(undefined)
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([])
    expect(h.staged.at(-1)).toEqual([])
    viewport.setPersistenceScope('account:1')
    expect(viewport.snapshot.getSnapshot()).toMatchObject({ paneIds: ['a', 'b'], activePaneId: 'b', paneRatios: [0.25, 0.75] })
    expect(viewport.currentWorkbench().name).toBe('Private project')
    viewport.dispose()
  })

  it('does not assign an unscoped legacy layout to a Gateway account', () => {
    localStorage.setItem('dsh.conversation.workbench.v1', JSON.stringify({ mode: 'workbench', paneIds: ['a'] }))
    localStorage.setItem('dsh.conversation.workbenches.v1', JSON.stringify({ activeId: 'private', workbenches: [{ id: 'private', name: 'Another account secret', paneIds: ['a'] }] }))
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([])
    viewport.setPersistenceScope('account:3')
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([])
    expect(viewport.listWorkbenches().map(row => row.name)).not.toContain('Another account secret')
    viewport.dispose()
  })

  it('does not cancel initial history loading when the first identity proof arrives', () => {
    const h = harness()
    const viewport = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
    const navigation = h.sessions.beginNavigation()
    viewport.setPersistenceScope('local')
    expect(navigation.aborted).toBe(false)
    viewport.setPersistenceScope(undefined)
    expect(navigation.aborted).toBe(true)
    viewport.dispose()
    viewport.setPersistenceScope('local')
    expect(viewport.snapshot.getSnapshot().paneIds).toEqual([])
  })

})

it('migrates only catalog-proven legacy identities and persists same-ID panes separately', async () => {
  const { clientSessionKey } = await import('@deepseek-ai/dsh-client-runtime/client')
  const h = harness()
  const personal = clientSessionKey({ kind: 'personal' }, id('same'))
  const project = clientSessionKey({ kind: 'project', projectId: 7 }, id('same'))
  const unique = clientSessionKey({ kind: 'project', projectId: 8 }, id('unique'))
  h.sessions.keyFor = (value, target = { kind: 'personal' }) => clientSessionKey(target, value)
  h.list.set({ ...h.list.getSnapshot(), ids: [personal, project, unique], current: personal,
    byId: Object.fromEntries([personal, project, unique]
      .map(key => [key, { id: key, displayTitle: key, running: false, blank: false, updatedAt: 1 }])),
  })
  localStorage.setItem('dsh.conversation.workbenches.v2.account%3A1', JSON.stringify({ version: 2, mode: 'workbench', activeId: 'default', workbenches: [
    { id: 'default', name: 'Existing', paneIds: ['same', 'unique'], activePaneId: 'same', paneRatios: [0.3, 0.7], updatedAt: 1 },
  ] }))
  const view = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
  try {
    view.setPersistenceScope('account:1')
    view.reconcileSessionKeys(value => value === id('unique') ? unique : undefined)
    expect(view.snapshot.getSnapshot()).toMatchObject({ paneIds: [unique], activePaneId: unique, paneRatios: [1] })
    view.markCatalogReady()
    expect(view.add(personal)).toEqual({ ok: true })
    expect(view.add(project)).toEqual({ ok: true })
    expect(view.snapshot.getSnapshot().paneIds).toEqual([unique, personal, project])
    const saved = JSON.parse(localStorage.getItem('dsh.conversation.workbenches.v3.account%3A1')!) as { version: number; workbenches: { paneIds: string[] }[] }
    expect(saved.version).toBe(3)
    expect(saved.workbenches[0]?.paneIds).toEqual([unique, personal, project])
    view.remove(project)
    expect(view.snapshot.getSnapshot().paneIds).toContain(personal)
  } finally { view.dispose() }
})

it('uses the saved v2 encoding for opaque IDs and never stages a lexical v3 lookalike before catalog verification', async () => {
  const { clientSessionKey } = await import('@deepseek-ai/dsh-client-runtime/client')
  const h = harness()
  const lookalike = clientSessionKey({ kind: 'project', projectId: 7 }, id('other'))
  const correct = clientSessionKey({ kind: 'personal' }, lookalike)
  h.sessions.keyFor = (value, target = { kind: 'personal' }) => clientSessionKey(target, value)
  h.list.set({ ...h.list.getSnapshot(), phase: 'pending', ids: [lookalike, correct], current: undefined,
    byId: Object.fromEntries([lookalike, correct].map(key => [key, {
      id: key, displayTitle: key, running: false, blank: false, updatedAt: 1,
    }])),
  })
  const storageKey = 'dsh.conversation.workbenches.v2.local'
  const saved = JSON.stringify({ version: 2, mode: 'workbench', activeId: 'default', workbenches: [
    { id: 'default', name: 'Opaque ID', paneIds: [lookalike], activePaneId: lookalike, paneRatios: [1], updatedAt: 1 },
  ] })
  localStorage.setItem(storageKey, saved)
  const view = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
  try {
    view.setPersistenceScope('local')
    view.setEnabled(true)
    expect(view.sessionKeyVersion()).toBe(2)
    expect(view.snapshot.getSnapshot().paneIds).toEqual([])
    expect(h.opened).toEqual([])
    expect(h.staged.flat()).not.toContain(lookalike)
    expect(localStorage.getItem('dsh.conversation.workbenches.v3.local')).toBeNull()
    expect(localStorage.getItem(storageKey)).toBe(saved)
    view.markCatalogReady()
    expect(view.currentWorkbench().paneIds).toEqual([lookalike])
    h.list.set({ ...h.list.getSnapshot(), phase: 'ready' })
    expect(view.sessionKeyVersion()).toBe(3)
    expect(view.snapshot.getSnapshot().paneIds).toEqual([correct])
    expect(h.staged.at(-1)).toEqual([correct])
    expect(h.opened).not.toContain(lookalike)
    expect(JSON.parse(localStorage.getItem('dsh.conversation.workbenches.v3.local')!)).toMatchObject({
      version: 3, workbenches: [{ paneIds: [correct] }],
    })
  } finally { view.dispose() }
})

it('preserves hidden layout identities when unused runtimes unload and verifies them again before re-entry', async () => {
  const { clientSessionKey } = await import('@deepseek-ai/dsh-client-runtime/client')
  const h = harness()
  const personal = clientSessionKey({ kind: 'personal' }, id('same'))
  const project = clientSessionKey({ kind: 'project', projectId: 7 }, id('same'))
  h.sessions.keyFor = (value, target = { kind: 'personal' }) => clientSessionKey(target, value)
  const byId = Object.fromEntries([personal, project].map(key => [key, {
    id: key, displayTitle: key, running: false, blank: false, updatedAt: 1,
  }]))
  h.list.set({ ...h.list.getSnapshot(), ids: [personal, project], byId, current: personal })
  const view = new ConversationViewportController(h.sessions, createConversationViewportStore().create())
  try {
    view.setPersistenceScope('account:1')
    view.setEnabled(true)
    view.add(personal)
    view.add(project)
    view.markCatalogReady()
    view.setMode('single')
    h.list.set({ ...h.list.getSnapshot(), ids: [personal], byId: { [personal]: byId[personal]! }, current: personal })
    expect(view.currentWorkbench().paneIds).toEqual([personal, project])
    expect(h.staged.at(-1)).toEqual([])
    view.setMode('workbench')
    expect(view.needsCatalogRestore()).toBe(true)
    expect(view.snapshot.getSnapshot().paneIds).toEqual([personal, project])
    h.opened.length = 0
    expect(() => { view.focus(project) }).not.toThrow()
    expect(h.opened).toEqual([])
    h.list.set({ ...h.list.getSnapshot(), ids: [personal, project], byId })
    view.reconcileSessionKeys(value => value)
    view.markCatalogReady()
    expect(h.staged.at(-1)).toEqual([personal, project])
    expect(h.opened.at(-1)).toBe(project)
  } finally { view.dispose() }
})
