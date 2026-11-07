// @vitest-environment jsdom
/** Chat-store actions, scoped persistence, and instance isolation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createChatStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { readPersistedDraft } from '../src/client/input/persisted-draft.ts'

const KEY = 'dsh.conversation.chat'
const disposals: Array<() => void> = []
type Persistence = NonNullable<Parameters<typeof createChatStore>[0]>

function persistentChat(key: Persistence['key'] = id => `${KEY}.${id}`, restoreDraft?: Persistence['restoreDraft']) {
  const listeners = new Set<() => void>()
  let dispose!: () => void
  const handle = createChatStore({
    key,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onDispose: (cleanup) => { dispose = cleanup; disposals.push(cleanup) },
    readDraft: readPersistedDraft,
    ...(restoreDraft === undefined ? {} : { restoreDraft }),
  })
  return {
    handle, dispose,
    observe: (listener: () => void) => { listeners.add(listener) },
    refresh: () => { for (const listener of [...listeners]) listener() },
  }
}

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
})

describe('createChatStore', () => {
  it('init shape: empty selection/draft/view', () => {
    const store = createChatStore().create()
    expect(store.store.getSnapshot()).toEqual({ selection: null, draft: '', view: null, inspect: null })
  })

  it('actions cover the declared write set', () => {
    const store = createChatStore().create()

    store.actions.select({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    expect(store.store.getSnapshot().selection).toEqual({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    store.actions.select(null)
    expect(store.store.getSnapshot().selection).toBeNull()

    store.actions.setDraft('hello')
    expect(store.store.getSnapshot().draft).toBe('hello')

    store.actions.setView('chat')
    expect(store.store.getSnapshot().view).toBe('chat')

    store.actions.setInspect({ callId: 'c1' })
    expect(store.store.getSnapshot().inspect).toEqual({ callId: 'c1' })
    store.actions.setInspect(null)
    expect(store.store.getSnapshot().inspect).toBeNull()
  })

  it('stops the draft writer when its input is disposed', () => {
    const mirror = vi.fn()
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: vi.fn(),
      commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
    })
    shell.bindMirror(mirror)
    shell.setDraft('unsent text')
    expect(mirror).toHaveBeenLastCalledWith('unsent text')
    shell.dispose()
    const writes = mirror.mock.calls.length
    shell.actions.setDraft('late edit from a released input')
    expect(mirror).toHaveBeenCalledTimes(writes)
  })

  it('persists per scope key and rehydrates a fresh instance', () => {
    const handle = persistentChat().handle
    const s1 = handle.create('sess-1')
    s1.actions.setDraft('draft for one')
    s1.actions.select({ turnSeq: 1 })

    // Scope-suffixed key: each session persists separately.
    expect(localStorage.getItem(`${KEY}.sess-1`)).not.toBeNull()
    expect(localStorage.getItem(`${KEY}.sess-2`)).toBeNull()

    // A rebuilt instance under the same scope key rehydrates the state.
    const again = persistentChat().handle.create('sess-1')
    expect(again.store.getSnapshot().draft).toBe('draft for one')
    expect(again.store.getSnapshot().selection).toEqual({ turnSeq: 1 })

    // A sibling scope starts clean.
    const other = persistentChat().handle.create('sess-2')
    expect(other.store.getSnapshot().draft).toBe('')
  })

  it('restores each tab’s own draft after another tab edits the same Session', () => {
    const a = new Map<string, string>()
    const b = new Map<string, string>()
    const useTab = (data: Map<string, string>) => {
      vi.stubGlobal('sessionStorage', {
        getItem: (key: string) => data.get(key) ?? null,
        setItem: (key: string, value: string) => { data.set(key, value) },
        removeItem: (key: string) => { data.delete(key) },
      })
    }
    useTab(a)
    const first = persistentChat()
    first.handle.create('same').actions.setDraft('tab A draft')
    expect(first.handle.canRestoreDraft('same' as never)).toBe(true)
    useTab(b)
    const second = persistentChat()
    second.handle.create('same').actions.setDraft('tab B draft')
    useTab(a)
    expect(persistentChat().handle.create('same').getSnapshot().draft).toBe('tab A draft')
    useTab(b)
    expect(persistentChat().handle.create('same').getSnapshot().draft).toBe('tab B draft')
    vi.unstubAllGlobals()
  })

  it('guards recovery after a tab write fails instead of trusting another tab’s durable value', () => {
    const fixture = persistentChat()
    const store = fixture.handle.create('same')
    store.actions.setDraft('saved')
    expect(fixture.handle.canRestoreDraft('same' as never)).toBe(true)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    store.actions.setDraft('memory only')
    expect(fixture.handle.canRestoreDraft('same' as never)).toBe(false)
    expect(store.getSnapshot().draft).toBe('memory only')
    expect(localStorage.getItem(`${KEY}.same`)).toContain('memory only')
  })

  it('retains the draft when browser policy prevents reading its recovery copy', () => {
    const fixture = persistentChat()
    const store = fixture.handle.create('same')
    store.actions.setDraft('private draft')
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw new Error('storage denied') })
    expect(fixture.handle.canRestoreDraft('same' as never)).toBe(false)
    expect(store.getSnapshot().draft).toBe('private draft')
    expect(fixture.handle.canRestoreDraft('same' as never)).toBe(true)
  })

  it('clearPersisted removes the scope entry (session-death cleanup hook)', () => {
    const store = persistentChat().handle.create('sess-9')
    store.actions.setDraft('doomed')
    expect(localStorage.getItem(`${KEY}.sess-9`)).not.toBeNull()
    store.clearPersisted()
    expect(localStorage.getItem(`${KEY}.sess-9`)).toBeNull()
    store.actions.setDraft('retired late edit')
    store.clearPersisted()
    expect(localStorage.getItem(`${KEY}.sess-9`)).toBeNull()
  })

  it('keeps state in memory until persistence has an explicit owner', () => {
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'unowned legacy draft' }))
    const read = vi.spyOn(Storage.prototype, 'getItem')
    const write = vi.spyOn(Storage.prototype, 'setItem')
    const transientHandle = createChatStore()
    const transient = transientHandle.create('shared')
    transient.actions.setDraft('memory only')
    expect(transientHandle.canRestoreDraft('shared' as never)).toBe(false)
    const unknownHandle = persistentChat(() => undefined).handle
    const unknown = unknownHandle.create('shared')
    unknown.actions.setDraft('also memory only')
    expect(unknownHandle.canRestoreDraft('shared' as never)).toBe(false)
    unknown.clearPersisted()
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })

  it('restores each account independently and suspends writes while ownership is unknown', () => {
    let owner: string | undefined = 'account:7'
    const fixture = persistentChat(id => owner === undefined ? undefined : `${owner}:${id}`)
    const store = fixture.handle.create('shared')
    store.actions.setDraft('Lin private draft')
    store.actions.setView('trajectory')
    store.actions.setInspect({ callId: 'c1' })
    owner = 'account:8'
    expect(fixture.handle.canRestoreDraft('shared' as never)).toBe(false)
    store.actions.setDraft('stale edit before identity notification')
    expect(localStorage.getItem('account:7:shared')).toContain('Lin private draft')
    expect(localStorage.getItem('account:8:shared')).toBeNull()
    fixture.refresh()
    expect(store.getSnapshot()).toEqual({ draft: '', selection: null, view: null, inspect: null })
    store.actions.setDraft('Zhou private draft')
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('Zhou private draft')
    owner = undefined
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('')
    store.actions.setDraft('unverified edit')
    owner = 'account:7'
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('Lin private draft')
    expect(store.getSnapshot().view).toBe('trajectory')
    expect(store.getSnapshot().inspect).toEqual({ callId: 'c1' })
    owner = 'account:8'
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('Zhou private draft')
  })

  it('restores a verified owner after initial proof arrives without adopting unowned text', () => {
    let key: string | undefined = undefined
    localStorage.setItem('verified-owner', JSON.stringify({ draft: 'verified saved draft', selection: { callId: 'c1' } }))
    const fixture = persistentChat(() => key)
    const store = fixture.handle.create('shared')
    store.actions.setDraft('unowned pending draft')
    key = 'verified-owner'
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('verified saved draft')
    expect(store.getSnapshot().selection).toEqual({ callId: 'c1' })
  })

  it('restores the live composer when ownership arrives after its mirror was bound', () => {
    let key: string | undefined
    const shell = new SessionInputShell({
      actx: {} as ClientContext, defaultSink: vi.fn(),
      commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
    })
    const fixture = persistentChat(() => key, (_id, draft) => { shell.setDraft(draft) })
    const store = fixture.handle.create('shared')
    const unmirror = shell.bindMirror(store.actions.setDraft, store.getSnapshot().draft)
    try {
      localStorage.setItem('verified-owner', JSON.stringify({ draft: 'verified saved draft', selection: null, view: null, inspect: null }))
      key = 'verified-owner'
      fixture.refresh()
      expect(shell.snapshot.draft).toBe('verified saved draft')
      shell.setDraft('edited after restoration')
      expect(store.getSnapshot().draft).toBe('edited after restoration')
      expect((JSON.parse(sessionStorage.getItem('verified-owner.tab.v1')!) as { draft?: unknown }).draft).toBe('edited after restoration')
      key = undefined
      fixture.refresh()
      expect(shell.snapshot.draft).toBe('')
      expect((JSON.parse(localStorage.getItem('verified-owner')!) as { draft?: unknown }).draft).toBe('edited after restoration')
    } finally {
      unmirror()
      shell.dispose()
    }
  })

  it('detaches retired store generations and plugin observers', () => {
    let owner = 'account:7'
    const fixture = persistentChat(id => `${owner}:${id}`)
    const old = fixture.handle.create('shared')
    old.actions.setDraft('kept')
    const current = fixture.handle.create('shared')
    old.actions.setDraft('retired')
    expect(current.getSnapshot().draft).toBe('kept')
    expect(localStorage.getItem('account:7:shared')).toContain('kept')
    fixture.dispose()
    fixture.dispose()
    owner = 'account:8'
    fixture.refresh()
    current.actions.setDraft('after unload')
    current.clearPersisted()
    expect(localStorage.getItem('account:8:shared')).toBeNull()
    expect(localStorage.getItem('account:7:shared')).toContain('kept')
  })

  it('keeps a keyless store ephemeral even when its factory supports persistence', () => {
    const fixture = persistentChat()
    fixture.handle.create().actions.setDraft('no Session')
    expect(localStorage.length).toBe(0)
  })

  it('ignores an identity notification captured before the plugin was disposed', () => {
    let owner = 'account:7'
    const fixture = persistentChat(id => `${owner}:${id}`)
    fixture.observe(fixture.dispose)
    const store = fixture.handle.create('shared')
    store.actions.setDraft('before unload')
    owner = 'account:8'
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('before unload')
    expect(localStorage.getItem('account:8:shared')).toBeNull()
  })

  it('refuses to erase another owner before an identity notification arrives', () => {
    let owner = 'account:7'
    const fixture = persistentChat(id => `${owner}:${id}`)
    const store = fixture.handle.create('shared')
    store.actions.setDraft('Lin draft')
    localStorage.setItem('account:8:shared', JSON.stringify({ draft: 'Zhou draft' }))
    owner = 'account:8'
    store.clearPersisted()
    expect(localStorage.getItem('account:8:shared')).toContain('Zhou draft')
    expect(localStorage.getItem('account:7:shared')).toContain('Lin draft')
  })

  it('refreshes erasure ownership while the Session remains absent from the catalog', () => {
    const state: { owner: string | undefined } = { owner: undefined }
    const fixture = persistentChat((id, intent) => intent === 'forget' && state.owner !== undefined ? `${state.owner}:${id}` : undefined)
    const store = fixture.handle.create('shared')
    localStorage.setItem('account:7:shared', JSON.stringify({ draft: 'Lin draft' }))
    state.owner = 'account:7'
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('')
    store.clearPersisted()
    expect(localStorage.getItem('account:7:shared')).toBeNull()
  })

  it.each(['{', 'null', '[]', '"invalid root"'])('ignores unreadable stored interaction state %s', (raw) => {
    localStorage.setItem(`${KEY}.shared`, raw)
    expect(persistentChat().handle.create('shared').getSnapshot().draft).toBe('')
  })

  it('keeps valid draft text while rejecting malformed stored selection and view metadata', () => {
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({
      draft: 'valid text', selection: { turnSeq: -1 }, view: [], inspect: { callId: '' },
    }))
    expect(persistentChat().handle.create('shared').getSnapshot())
      .toEqual({ draft: 'valid text', selection: null, view: null, inspect: null })
  })

  it('tolerates storage reads, writes, and removal denied by browser policy', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw new Error('denied') })
    const fixture = persistentChat()
    const store = fixture.handle.create('shared')
    expect(store.getSnapshot().draft).toBe('')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })
    expect(() => { store.actions.setDraft('usable memory') }).not.toThrow()
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('denied') })
    expect(() => { store.clearPersisted() }).not.toThrow()
  })

  it('keeps stores usable when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    const fixture = persistentChat()
    const store = fixture.handle.create('shared')
    store.actions.setDraft('memory')
    expect(store.getSnapshot().draft).toBe('memory')
    store.clearPersisted()
  })

  it('keeps stores usable when accessing browser storage itself is denied', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied') } })
    try {
      const store = persistentChat().handle.create('shared')
      store.actions.setDraft('memory')
      expect(store.getSnapshot().draft).toBe('memory')
      store.clearPersisted()
    } finally {
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })

  it('rehydrates structured references in their own Session and keeps text from malformed metadata', () => {
    const reference = (label: string, offset: number) => ({
      source: 'reference', ref: `ref-${label}`, label, offset, length: 2, clipboardText: `@${label}`,
    })
    const a = reference('A', 0)
    const b = reference('B', 3)
    localStorage.setItem(`${KEY}.restored`, JSON.stringify({
      draft: {
        text: '@A @B',
        references: [
          null, { ...a, occurrenceId: 999 }, a,
          { ...b, offset: 3.5 }, { ...b, label: 'wrong' }, b,
        ],
      },
    }))
    const store = persistentChat().handle.create('restored')
    const shell = new SessionInputShell({
      actx: {} as ClientContext,
      defaultSink: vi.fn(),
      commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: token => token },
    })
    const unmirror = shell.bindMirror(store.actions.setDraft, store.store.getSnapshot().draft)
    try {
      expect(shell.snapshot.draft).toBe('@A @B')
      expect(shell.snapshot.occurrences).toEqual([
        { ...a, occurrenceId: 1 }, { ...b, occurrenceId: 2 },
      ])
      expect(persistentChat().handle.create('restored').store.getSnapshot().draft)
        .toEqual({ text: '@A @B', references: [a, b] })
      expect(persistentChat().handle.create('other').store.getSnapshot().draft).toBe('')
    } finally {
      unmirror()
      shell.dispose()
    }
  })

  it.each([
    ['plain draft', 'plain draft'],
    ['  ', '  '],
    [null, ''],
    [[], ''],
    [{ text: 'keep this', references: null }, 'keep this'],
    [{ text: 'keep this', references: [{}], command: { token: '/other' } }, 'keep this'],
  ])('preserves readable text in stored draft %j', (value, expected) => {
    expect(readPersistedDraft(value)).toBe(expected)
  })

  it('retains only the matching command token, without restoring executable claim data', () => {
    expect(readPersistedDraft({
      text: '/scan project',
      references: [],
      command: { token: '/scan', submit: 'discarded callback metadata' },
    })).toEqual({ text: '/scan project', references: [], command: { token: '/scan' } })
  })

  it('every create() is an independent instance; the factory holds no singleton', () => {
    const handle = createChatStore()
    const a = handle.create()
    const b = handle.create()
    a.actions.setDraft('only in a')
    expect(b.store.getSnapshot().draft).toBe('')
    // The SlotRegistry owns handle-by-scope sharing; factories have no shared state.
    localStorage.clear()
    const c = createChatStore().create()
    expect(c.store.getSnapshot().draft).toBe('')
  })
})
