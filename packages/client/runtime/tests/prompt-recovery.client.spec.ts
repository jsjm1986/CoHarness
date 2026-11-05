/** Recovery is confined to one authorized tab and its immutable input. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { PreparedSessionApi } from '../src/client/prepare-runtime.ts'
import { PromptRecovery, promptInputProof } from '../src/client/prompt-recovery.ts'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'
import { FakeApiClient, fakeRemote } from './fake-api.client.ts'

afterEach(() => vi.unstubAllGlobals())
const connection = {
  interactions: 'none',
  metadataTiming: { requestTimeoutMs: 500, retryAfterMs: 500 },
} as ConnectionHandle
const target = {
  kind: 'personal',
  nodeId: '10000000-0000-4000-8000-000000000008',
  runtimeId: '10000000-0000-4000-8000-000000000009',
} as SessionRuntimeTarget
const sessionId = 'identical-on-two-computers' as SessionId
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function storage(data = new Map<string, string>()) {
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
  }
}
function fixture() {
  const store = storage(),
    committed = new Map<string, string>(),
    calls: { path: string; id: string; account: string | null }[] = []
  vi.stubGlobal('sessionStorage', store)
  vi.stubGlobal('location', new URL('https://harness.invalid'))
  let state: 'offline' | 'ready' | 'denied' | 'mismatch' | 'older' = 'offline'
  vi.stubGlobal('fetch', async (url: URL, opts: RequestInit) => {
    if (typeof opts.body !== 'string') throw new Error('Expected a JSON request body')
    const { rpcId, payload } = JSON.parse(opts.body) as {
      rpcId: string
      payload: { mode: string; content: unknown[]; clientTimeZone?: string; requestId: string }
    }
    const id = payload.requestId,
      path = url.pathname.split('.').at(-1)!,
      account = new Headers(opts.headers).get('x-dsh-expected-principal-id')
    calls.push({ id, path, account })
    if (state === 'denied') return new Response(null, { status: 403 })
    let value: unknown
    if (path === 'prompt') {
      committed.set(id, hash([id, hash([payload.mode, payload.clientTimeZone ?? null, payload.content])]))
      if (state === 'offline') throw new Error('Dropped prompt receipt')
      value = { accepted: true }
    } else {
      if (state === 'offline') throw new Error('Status cannot reach original computer')
      value = committed.has(id)
        ? {
          state: 'accepted',
          ...(state === 'older' ? {} : { inputProof: state === 'mismatch' ? '0'.repeat(64) : committed.get(id) }),
        }
        : { state: 'unknown' }
    }
    return Response.json(
      { type: 'server-response', rpcId, result: { ok: true, value } },
      { headers: { 'x-dsh-runtime-id': String(url.searchParams.get('dshRuntime')) } },
    )
  })
  return {
    store,
    committed,
    calls,
    mode: (v: typeof state) => {
      state = v
    },
    open: (account = 7, destination = target) =>
      new Session(sessionId, new FakeApiClient(), fakeRemote(), {
        admission: () => new PreparedSessionApi(connection, destination, account),
      }),
  }
}
function submit(session: Session, text: string) {
  const echo = session.beginSubmission({ mode: 'queue', text, images: [] })
  return session.prompt([{ type: 'text', text }], 'queue', undefined, echo.requestId)
}

it('claims an empty receipt lock for the visible authenticated Session before send and releases an unused claim on leaving', async () => {
  const f = fixture()
  const released: string[] = []
  const locks = vi.fn(async (key: string, _options: LockOptions, hold: (lock: object) => Promise<void>) => {
    await hold({ name: key })
    released.push(key)
  })
  vi.stubGlobal('navigator', { locks: { request: locks } })
  const session = f.open()
  try {
    await session.open()
    expect(locks).not.toHaveBeenCalled()
    session.enterStage()
    expect(locks).toHaveBeenCalledTimes(1)
    expect(f.calls).toEqual([])
    expect(f.store.data.size).toBe(0)
    session.leaveStage()
    await vi.waitFor(() => { expect(released).toHaveLength(1) })
    session.enterStage()
    await session.open()
    expect(locks).toHaveBeenCalledTimes(2)
    f.mode('ready')
    expect((await submit(session, 'one explicit message')).ok).toBe(true)
    expect(locks).toHaveBeenCalledTimes(2)
  } finally { session.dispose() }
})

it('leaves an unconfirmed receipt untouched when opening or leaving the conversation', async () => {
  const f = fixture()
  const original = f.open()
  vi.stubGlobal('navigator', {})
  expect((await submit(original, 'previous pending message')).ok).toBe(false)
  original.dispose()
  const persisted = [...f.store.data]
  const requests = f.calls.length
  const locks = vi.fn()
  vi.stubGlobal('navigator', { locks: { request: locks } })
  const replacement = f.open()
  try {
    replacement.enterStage()
    await replacement.open()
    replacement.leaveStage()
    expect(locks).not.toHaveBeenCalled()
    expect(f.calls).toHaveLength(requests)
    expect([...f.store.data]).toEqual(persisted)
  } finally { replacement.dispose() }
})

it('rechecks a receipt restored after the visible Session claimed an empty slot', async () => {
  const f = fixture()
  const words = 'recover the original submission'
  vi.stubGlobal('navigator', {})
  const original = f.open()
  expect((await submit(original, words)).ok).toBe(false)
  original.dispose()
  const saved = [...f.store.data]
  f.store.data.clear()
  vi.stubGlobal('navigator', {
    locks: { request: (_key: string, _options: LockOptions, hold: (lock: object) => Promise<void>) => hold({}) },
  })
  const current = f.open()
  try {
    current.enterStage()
    await current.open()
    for (const [key, value] of saved) f.store.setItem(key, value)
    f.mode('ready')
    expect((await submit(current, words)).ok).toBe(true)
    expect(f.calls.map(call => call.path)).toEqual(['prompt', 'status', 'status'])
    expect(f.committed.size).toBe(1)
  } finally { current.dispose() }
})

it('retains the exact draft through revocation, a different proof and a Host that does not prove the original input', async () => {
  const f = fixture(),
    first = f.open(),
    words = 'private reference'
  expect((await submit(first, words)).ok).toBe(false)
  first.dispose()
  const restarted = f.open(),
    [id] = f.committed.keys()
  try {
    for (const mode of ['denied', 'mismatch', 'older'] as const) {
      f.mode(mode)
      expect((await submit(restarted, words)).ok).toBe(false)
      expect(f.calls.at(-1)).toMatchObject({ id, path: 'status', account: '7' })
      expect(f.store.data.size).toBe(1)
    }
    f.mode('ready')
    expect((await submit(restarted, 'a new message')).ok).toBe(false)
    expect(f.committed.size).toBe(1)
    expect((await submit(restarted, 'a new message')).ok).toBe(true)
    expect(f.committed.size).toBe(2)
    expect(f.store.data.size).toBe(0)
  } finally {
    restarted.dispose()
  }
})

it.each([true, false])('keeps a copied tab independent with Web Locks unavailable (opener %s)', async (opener) => {
  const f = fixture(),
    words = 'the same words',
    opened = f.open()
  vi.stubGlobal('performance', { timeOrigin: 1, getEntriesByType: () => [{ type: 'navigate' }], now: () => 1 })
  vi.stubGlobal('navigator', {})
  expect((await submit(opened, words)).ok).toBe(false)
  const copy = storage(new Map(f.store.data))
  vi.stubGlobal('performance', { timeOrigin: 2, getEntriesByType: () => [{ type: 'navigate' }], now: () => 2 })
  vi.stubGlobal('window', { opener: opener ? {} : null })
  vi.stubGlobal('sessionStorage', copy)
  const duplicate = f.open()
  try {
    f.mode('ready')
    expect((await submit(duplicate, words)).ok).toBe(true)
    expect(f.committed.size).toBe(2)
    expect(f.store.data.size).toBe(1)
    expect(copy.data.size).toBe(0)
    vi.stubGlobal('sessionStorage', f.store)
    expect((await submit(opened, words)).ok).toBe(true)
    expect(f.committed.size).toBe(2)
  } finally {
    duplicate.dispose()
    opened.dispose()
  }
})

it('refuses a different computer for an existing receipt; other accounts cannot adopt it', async () => {
  const f = fixture(),
    first = f.open(),
    words = 'one private session'
  expect((await submit(first, words)).ok).toBe(false)
  first.dispose()
  f.mode('ready')
  const moved = f.open(7, { ...target, nodeId: '10000000-0000-4000-8000-000000000010' } as SessionRuntimeTarget),
    other = f.open(8)
  try {
    const n = f.calls.length
    expect((await submit(moved, words)).ok).toBe(false)
    expect(f.calls.length).toBe(n)
    expect((await submit(other, words)).ok).toBe(true)
    expect(f.committed.size).toBe(2)
    expect(f.store.data.size).toBe(1)
  } finally {
    moved.dispose()
    other.dispose()
  }
})

it('does not send if the tab cannot durably write and read its identity', async () => {
  const f = fixture(),
    s = f.open()
  f.mode('ready')
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {},
  })
  try {
    expect((await submit(s, 'keep this text')).ok).toBe(false)
    expect(f.calls).toEqual([])
  } finally {
    s.dispose()
  }
})

it('preserves two independent submissions of identical text when both begin before the first confirmation', async () => {
  const f = fixture(),
    s = f.open()
  f.mode('ready')
  try {
    const results = await Promise.all([submit(s, 'twice'), submit(s, 'twice')])
    expect(results.every(r => r.ok)).toBe(true)
    expect(f.committed.size).toBe(2)
  } finally {
    s.dispose()
  }
})

it('fingerprints the validated wire order without retaining bytes, filenames, document IDs or text', async () => {
  const f = fixture(),
    key = new PreparedSessionApi(connection, target, 7).recoveryKey(sessionId),
    journal = new PromptRecovery(key, connection.metadataTiming.requestTimeoutMs)
  const id = '00000000-0000-4000-8000-000000000010' as Parameters<typeof promptInputProof>[0]
  const image = {
    data: 'sensitive-bytes',
    name: 'private-file.png',
    type: 'image' as const,
    mediaType: 'image/png' as const,
  }
  const input = {
    mode: 'queue' as const,
    sessionId,
    content: [image, { type: 'text' as const, text: 'sensitive-body' }],
  }
  const proof = promptInputProof(id, input)
  const expected = hash([
    id,
    hash([
      'queue',
      null,
      [{ type: 'image', mediaType: 'image/png', data: image.data, name: image.name }, input.content[1]],
    ]),
  ])
  try {
    await journal.pending(target.nodeId)
    journal.save(id, proof, undefined, target.nodeId ?? null)
    expect(proof).toBe(expected)
    const persisted = JSON.stringify([...f.store.data])
    for (const secret of [image.data, image.name, 'sensitive-body']) expect(persisted).not.toContain(secret)
  } finally {
    journal.close()
  }
})

it('restores a normal same-tab navigation from its departure handoff without Web Locks', async () => {
  const f = fixture(),
    words = 'hand back my original operation',
    win = new EventTarget()
  vi.stubGlobal('window', win)
  vi.stubGlobal('navigator', {})
  vi.stubGlobal('performance', { timeOrigin: 1, getEntriesByType: () => [{ type: 'navigate' }], now: () => 1 })
  const before = f.open()
  expect((await submit(before, words)).ok).toBe(false)
  win.dispatchEvent(new Event('pagehide'))
  before.dispose()
  vi.stubGlobal('performance', { timeOrigin: 3, getEntriesByType: () => [{ type: 'navigate' }], now: () => 3 })
  const after = f.open()
  try {
    f.mode('ready')
    expect((await submit(after, words)).ok).toBe(true)
    expect(f.committed.size).toBe(1)
    expect(f.calls.at(-1)?.path).toBe('status')
  } finally {
    after.dispose()
  }
})

it('cancels a pending ownership handoff without touching the node or dropping the original receipt', async () => {
  const f = fixture()
  vi.stubGlobal('navigator', {})
  const before = f.open()
  expect((await submit(before, 'keep this draft')).ok).toBe(false)
  before.dispose()
  const original = [...f.store.data]
  const callsBeforeHandoff = f.calls.length
  const waiting = Promise.withResolvers<undefined>()
  vi.stubGlobal('navigator', {
    locks: {
      request(_name: string, options: LockOptions): Promise<void> {
        const signal = options.signal!
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('Receipt handoff cancelled')) }, { once: true })
          waiting.resolve(undefined)
        })
      },
    },
  })
  const after = f.open()
  const cancel = new AbortController()
  try {
    const attempt = after.prompt([{ type: 'text', text: 'keep this draft' }], 'queue', cancel.signal)
    await waiting.promise
    cancel.abort()
    expect((await attempt).ok).toBe(false)
    expect(f.calls).toHaveLength(callsBeforeHandoff)
    expect([...f.store.data]).toEqual(original)
  } finally {
    after.dispose()
  }
})

it.each([true, false])('preserves a former managed input after a mode change (recovery slot readable %s)', async (readable) => {
  const f = fixture(),
    old = f.open(),
    words = 'on the original computer'
  expect((await submit(old, words)).ok).toBe(false)
  old.dispose()
  if (!readable) vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('Browser storage is disabled') } })
  const api = new FakeApiClient(),
    ordinary = vi.spyOn(api.sessions, 'prompt')
  const changed = new Session(sessionId, api, fakeRemote(), {
    admission: onlyForRecovery => (onlyForRecovery ? new PreparedSessionApi(connection, target, 7) : undefined),
  })
  try {
    expect((await submit(changed, words)).ok).toBe(false)
    expect(ordinary).not.toHaveBeenCalled()
    expect(f.store.data.size).toBe(1)
  } finally {
    changed.dispose()
  }
})
