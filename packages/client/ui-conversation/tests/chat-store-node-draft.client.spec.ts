// @vitest-environment jsdom
/** Chat-store NodeDraft integration: verified-owner persistence, failure surface, suspension, and legacy-copy migration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NodeDraftOwner } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createChatStore } from '../src/client/stores.ts'
import { readPersistedDraft } from '../src/client/input/persisted-draft.ts'

const fake = vi.hoisted(() => {
  class FakeNodeDraft {
    static instances: FakeNodeDraft[] = []
    static last(): FakeNodeDraft {
      const found = FakeNodeDraft.instances.at(-1)
      if (found === undefined) throw new Error('expected a node draft')
      return found
    }
    readonly written: string[] = []
    unavailable = false
    versionUnavailable = false
    unsynchronized = false
    restoredFromNode = false
    sourceReady = true
    canRestoreValue = true
    disposed = false
    retried = 0
    restoredCalls = 0
    constructor(
      readonly owner: NodeDraftOwner,
      readonly key: string,
      readonly restored: (text: string) => void,
      readonly saved: (text: string) => void,
      readonly changed: () => void,
    ) { FakeNodeDraft.instances.push(this) }
    async restore(): Promise<void> { this.restoredCalls += 1 }
    write(text: string): void { this.written.push(text) }
    async settle(): Promise<void> {}
    async retry(): Promise<void> { this.retried += 1 }
    canRestore(): boolean { return this.canRestoreValue }
    dispose(): void { this.disposed = true }
  }
  return { FakeNodeDraft }
})

vi.mock('@deepseek-ai/dsh-client-runtime/client', async (importOriginal) => {
  const original = await importOriginal<typeof import('@deepseek-ai/dsh-client-runtime/client')>()
  return { ...original, NodeDraft: fake.FakeNodeDraft }
})

const KEY = 'dsh.conversation.chat'
const SESSION = 'shared' as SessionId
const disposals: Array<() => void> = []
type Persistence = NonNullable<Parameters<typeof createChatStore>[0]>
type Owner = NodeDraftOwner | 'pending' | undefined

const ownerOf = (accountId: number, id: SessionId = SESSION): NodeDraftOwner => ({
  accountId, sessionId: id, requestTimeoutMs: 1000,
  target: { runtimeId: `runtime-${String(accountId)}` } as NodeDraftOwner['target'],
})

function persistentNodeChat(options: {
  key?: Persistence['key']
  owner?: () => Owner
  restoreDraft?: Persistence['restoreDraft']
}) {
  const listeners = new Set<() => void>()
  let dispose!: () => void
  const handle = createChatStore({
    key: options.key ?? (id => `${KEY}.${id}`),
    ...(options.owner === undefined ? {} : { nodeOwner: options.owner }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onDispose: (cleanup) => { dispose = cleanup; disposals.push(cleanup) },
    readDraft: readPersistedDraft,
    ...(options.restoreDraft === undefined ? {} : { restoreDraft: options.restoreDraft }),
  })
  return {
    handle, dispose,
    refresh: () => { for (const listener of [...listeners]) listener() },
  }
}

const serialized = (value: unknown): string => value === '' ? '' : JSON.stringify({ version: 1, draft: value })
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  fake.FakeNodeDraft.instances = []
})

describe('chat store NodeDraft ownership', () => {
  it('persists edits through the verified node owner and adopts its restored draft', async () => {
    const restoreDraft = vi.fn()
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'saved input' }))
    const fixture = persistentNodeChat({ owner: () => ownerOf(7), restoreDraft })
    const store = fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    expect(draft.owner).toEqual(ownerOf(7))
    expect(draft.key).toBe(`${KEY}.shared`)
    await flush()
    // The settle continuation mirrors the durable record's draft back to the node.
    expect(draft.written).toEqual([serialized('saved input')])
    store.actions.setDraft('typed')
    expect(draft.written.at(-1)).toBe(serialized('typed'))
    // The node's restored text lands in the composer and reaches the materialized input.
    draft.restored(serialized('from node'))
    expect(store.getSnapshot().draft).toBe('from node')
    expect(restoreDraft).toHaveBeenLastCalledWith(SESSION, 'from node')
    draft.restored('')
    expect(store.getSnapshot().draft).toBe('')
    expect(fixture.handle.canRestoreDraft(SESSION)).toBe(true)
    draft.canRestoreValue = false
    expect(fixture.handle.canRestoreDraft(SESSION)).toBe(false)
  })

  it('rejects unreadable node draft payloads', async () => {
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    await flush()
    for (const raw of ['null', '"text"', '{}', '{"version":2,"draft":0}', '{"version":1}']) {
      expect(() => { draft.restored(raw) }).toThrow('Unsupported saved draft')
    }
  })

  it('keeps composer input local while ownership verification is pending', async () => {
    const restoreDraft = vi.fn()
    const fixture = persistentNodeChat({ owner: () => 'pending', restoreDraft })
    const store = fixture.handle.create(SESSION)
    store.actions.setDraft('memory only')
    expect(fake.FakeNodeDraft.instances).toHaveLength(0)
    expect(fixture.handle.canRestoreDraft(SESSION)).toBe(false)
    await expect(fixture.handle.prepareInput(SESSION)).resolves.toBe(false)
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(false)
    // A refresh without a category change leaves the local input untouched.
    fixture.refresh()
    expect(restoreDraft).not.toHaveBeenCalled()
    expect(store.getSnapshot().draft).toBe('memory only')
  })

  it('clears the composer when verification revokes the owner to pending', () => {
    const restoreDraft = vi.fn()
    let owner: Owner = ownerOf(7)
    const fixture = persistentNodeChat({ owner: () => owner, restoreDraft })
    const store = fixture.handle.create(SESSION)
    store.actions.setDraft('typed input')
    owner = 'pending'
    fixture.refresh()
    expect(store.getSnapshot().draft).toBe('')
    expect(restoreDraft).toHaveBeenLastCalledWith(SESSION, '')
    expect(fake.FakeNodeDraft.last().disposed).toBe(true)
  })

  it('keeps an unverifiable key local even when an owner is resolved', () => {
    const fixture = persistentNodeChat({ key: () => undefined, owner: () => ownerOf(7) })
    fixture.handle.create(SESSION).actions.setDraft('no storage key')
    expect(fake.FakeNodeDraft.instances).toHaveLength(0)
  })

  it('prepares input, retries failures, and reports unsynchronized drafts', async () => {
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    await expect(fixture.handle.prepareInput(SESSION)).resolves.toBe(true)
    expect(draft.restoredCalls).toBe(1)
    draft.sourceReady = false
    await expect(fixture.handle.prepareInput(SESSION)).resolves.toBe(false)
    fixture.handle.retryDraft(SESSION)
    expect(draft.retried).toBe(1)
    fixture.handle.retryDraft('absent' as SessionId)
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(false)
    draft.unsynchronized = true
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(true)
    // prepareInput on a session with no writer resolves by owner kind.
    await expect(fixture.handle.prepareInput('other' as SessionId)).resolves.toBe(true)
    const pending = persistentNodeChat({ owner: () => 'pending' })
    await expect(pending.handle.prepareInput('other' as SessionId)).resolves.toBe(false)
    await expect(createChatStore().prepareInput('other' as SessionId)).resolves.toBe(true)
  })

  it('publishes node-draft failures and their pinned-version state', async () => {
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    fixture.handle.create('second')
    const first = fake.FakeNodeDraft.instances[0]!
    const second = fake.FakeNodeDraft.instances[1]!
    first.unavailable = true
    first.changed()
    expect(fixture.handle.draftFailures.getSnapshot()).toEqual([{ sessionId: SESSION, versionUnavailable: false }])
    second.unavailable = true
    second.versionUnavailable = true
    second.changed()
    expect(fixture.handle.draftFailures.getSnapshot()).toEqual([
      { sessionId: SESSION, versionUnavailable: false },
      { sessionId: 'second', versionUnavailable: true },
    ])
    // Same-length republish with a changed pinned flag still emits.
    first.versionUnavailable = true
    first.changed()
    expect(fixture.handle.draftFailures.getSnapshot()).toEqual([
      { sessionId: SESSION, versionUnavailable: true },
      { sessionId: 'second', versionUnavailable: true },
    ])
    // Same-length republish with a different session at an index also emits.
    fixture.handle.create('third')
    const third = fake.FakeNodeDraft.instances[2]!
    first.unavailable = false
    third.unavailable = true
    third.changed()
    expect(fixture.handle.draftFailures.getSnapshot()).toEqual([
      { sessionId: 'second', versionUnavailable: true },
      { sessionId: 'third', versionUnavailable: false },
    ])
    second.unavailable = false
    second.changed()
    expect(fixture.handle.draftFailures.getSnapshot()).toEqual([
      { sessionId: 'third', versionUnavailable: false },
    ])
    third.unavailable = false
    third.changed()
    expect(fixture.handle.draftFailures.getSnapshot()).toEqual([])
  })

  it('suspends unsynchronized input on owner change and replays it into the new owner', async () => {
    let owner: Owner = ownerOf(7)
    const fixture = persistentNodeChat({ owner: () => owner })
    const store = fixture.handle.create(SESSION)
    const first = fake.FakeNodeDraft.last()
    store.actions.setDraft('private input')
    first.unsynchronized = true
    owner = ownerOf(8)
    fixture.refresh()
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(true)
    const second = fake.FakeNodeDraft.last()
    expect(second).not.toBe(first)
    expect(first.disposed).toBe(true)
    await flush()
    // The suspended text seeds the replacement draft and the composer.
    expect(second.written).toContain(serialized('private input'))
    expect(store.getSnapshot().draft).toBe('private input')
    second.saved(serialized('private input'))
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(false)
  })

  it('migrates legacy browser copies once the node confirms the write', async () => {
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'old copy' }))
    sessionStorage.setItem(`${KEY}.shared.tab.v1`, JSON.stringify({ draft: 'old copy' }))
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    await flush()
    draft.saved(serialized('old copy'))
    expect(localStorage.getItem(`${KEY}.shared`)).toBeNull()
    expect(sessionStorage.getItem(`${KEY}.shared.tab.v1`)).toBeNull()
  })

  it('leaves changed, malformed, or mismatched legacy copies intact', async () => {
    sessionStorage.setItem(`${KEY}.shared.tab.v1`, 'not json')
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'old copy' }))
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    await flush()
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'edited elsewhere' }))
    draft.saved(serialized('old copy'))
    expect(localStorage.getItem(`${KEY}.shared`)).toContain('edited elsewhere')
    // A copy that vanished since the read is skipped.
    draft.saved(serialized('old copy'))
    // Storage that denies the copy read leaves it in place too.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => { throw new Error('denied') })
    draft.saved(serialized('old copy'))
  })

  it('settles without rewriting when the node already owned the source, or the draft was empty', async () => {
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const empty = fake.FakeNodeDraft.last()
    await flush()
    expect(empty.written).toEqual([])
    empty.restoredFromNode = true
    localStorage.setItem(`${KEY}.second`, JSON.stringify({ draft: 'held' }))
    fixture.handle.create('second')
    const held = fake.FakeNodeDraft.last()
    held.restoredFromNode = true
    await flush()
    expect(held.written).toEqual([])
  })

  it('abandons the settle continuation after disposal, replacement, or a key move', async () => {
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'held' }))
    fixture.handle.create(SESSION)
    const replaced = fake.FakeNodeDraft.last()
    // A second adoption (same scope key) replaces the draft before its settle lands.
    fixture.handle.create(SESSION)
    await flush()
    expect(replaced.written).toEqual([])
    // Disposal before the settle lands stops the mirror.
    localStorage.setItem(`${KEY}.third`, JSON.stringify({ draft: 'held' }))
    fixture.handle.create('third')
    const third = fake.FakeNodeDraft.last()
    fixture.dispose()
    await flush()
    expect(third.written).toEqual([])
    // A storage key that resolves differently on the next read is treated as moved.
    let moves = 0
    const moved = persistentNodeChat({ key: () => `${KEY}.moving.${++moves}`, owner: () => ownerOf(7) })
    moved.handle.create(SESSION)
    const moving = fake.FakeNodeDraft.last()
    await flush()
    expect(moving.written).toEqual([])
  })

  it('keeps dual-copy persistence local when no owner is resolved', () => {
    const fixture = persistentNodeChat({ owner: () => undefined })
    const store = fixture.handle.create(SESSION)
    expect(fake.FakeNodeDraft.instances).toHaveLength(0)
    // The navigation guard copy lands at create.
    expect(sessionStorage.getItem(`${KEY}.shared.tab.v1`)).not.toBeNull()
    store.actions.setDraft('local only')
    expect(sessionStorage.getItem(`${KEY}.shared.tab.v1`)).toContain('local only')
    expect(localStorage.getItem(`${KEY}.shared`)).toContain('local only')
  })

  it('falls back to the durable copy when tab storage is denied', () => {
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'durable' }))
    vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const fixture = persistentNodeChat({ owner: () => undefined })
    const store = fixture.handle.create(SESSION)
    expect(store.getSnapshot().draft).toBe('durable')
  })

  it('retains the in-memory draft when browser storage denies writes', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
    const fixture = persistentNodeChat({ owner: () => undefined })
    const store = fixture.handle.create(SESSION)
    store.actions.setDraft('unpersisted')
    expect(store.getSnapshot().draft).toBe('unpersisted')
    expect(localStorage.getItem(`${KEY}.shared`)).toBeNull()
  })

  it('keeps legacy copies that fail schema, diverge from our read, or outlive the key', async () => {
    // A tab copy that fails the saved-state schema reaches neither removal nor the diverged check.
    sessionStorage.setItem(`${KEY}.shared.tab.v1`, '"mystery"')
    // A durable copy whose draft serializes differently from the adopted one stays.
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'diverged' }))
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    await flush()
    draft.saved(serialized('confirmed'))
    expect(sessionStorage.getItem(`${KEY}.shared.tab.v1`)).toBe('"mystery"')
    expect(localStorage.getItem(`${KEY}.shared`)).toContain('diverged')
  })

  it('removes the empty durable copy once the node confirms the write', async () => {
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: '' }))
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    await flush()
    draft.saved(serialized('confirmed'))
    expect(localStorage.getItem(`${KEY}.shared`)).toBeNull()
  })

  it('keeps a matching durable copy while the confirmed write differs from our read', async () => {
    localStorage.setItem(`${KEY}.shared`, JSON.stringify({ draft: 'our read' }))
    const fixture = persistentNodeChat({ owner: () => ownerOf(7) })
    fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    await flush()
    draft.saved(serialized('newer write'))
    expect(localStorage.getItem(`${KEY}.shared`)).toContain('our read')
  })

  it('keeps suspended input when a confirmed write arrives after the key moved', async () => {
    let key: string | undefined = `${KEY}.shared`
    const fixture = persistentNodeChat({ key: () => key, owner: () => ownerOf(7) })
    const store = fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    store.actions.setDraft('held input')
    draft.unsynchronized = true
    key = undefined
    fixture.refresh()
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(true)
    // The replaced writer still reports its write; no current key exists to release the suspension.
    draft.saved(serialized('held input'))
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(true)
  })

  it('disposes node writers with the store and drops suspended input', async () => {
    let owner: Owner = ownerOf(7)
    const fixture = persistentNodeChat({ owner: () => owner })
    const store = fixture.handle.create(SESSION)
    const draft = fake.FakeNodeDraft.last()
    store.actions.setDraft('private input')
    draft.unsynchronized = true
    owner = ownerOf(8)
    fixture.refresh()
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(true)
    store.clearPersisted()
    expect(draft.disposed).toBe(true)
    expect(fixture.handle.hasUnsavedNodeDrafts()).toBe(false)
  })
})
