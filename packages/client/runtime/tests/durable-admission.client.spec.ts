/** Native submit/status preserve exact destination and request identity across an ambiguous write. */
import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { Session } from '../src/client/sessions/session.ts'
import type { SessionRuntimeTarget } from '../src/client/contract/sessions.ts'
import { PreparedSessionApi, PromptTargetUnverified } from '../src/client/prepare-runtime.ts'
import { FakeApiClient, fakeRemote } from './fake-api.client.ts'

afterEach(() => { vi.unstubAllGlobals() })

it.each([
  { kind: 'personal', committed: false },
  { kind: 'personal', committed: true },
  { kind: 'project', committed: false },
  { kind: 'project', committed: true },
] as const)('resumes one $kind submission after lease turnover (already committed=$committed)', async ({ kind, committed }) => {
  vi.stubGlobal('location', new URL('https://harness.invalid/'))
  const slots = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => { slots.set(key, value) },
    removeItem: (key: string) => { slots.delete(key) },
  })
  const target = { kind, ...(kind === 'project' ? { projectId: 14 } : {}),
    nodeId: '10000000-0000-4000-8000-000000000008', runtimeId: '10000000-0000-4000-8000-000000000009' } as SessionRuntimeTarget
  const connection = { interactions: 'none', metadataTiming: { requestTimeoutMs: 1000, retryAfterMs: 1 } } as ConnectionHandle
  const api = new PreparedSessionApi(connection, target, 7)
  const calls: string[] = [], dispatched: object[] = []
  const blocked = Promise.withResolvers<undefined>()
  let accountVerified = true
  const session = new Session('original' as SessionId, new FakeApiClient(), fakeRemote(), { admission: () => {
    if (!accountVerified) {
      blocked.resolve(undefined)
      throw new PromptTargetUnverified()
    }
    return api
  } })
  const input = { text: 'retain this draft on the original computer', mode: 'queue' as const, images: [] }
  const echo = session.beginSubmission(input)
  const durable = new Map<string, string>()
  let statusCalls = 0
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    expect(url.searchParams.get('dshRuntime')).toBe(target.runtimeId)
    expect(url.searchParams.get('dshNode')).toBe(target.nodeId)
    expect(url.searchParams.get('dshTarget')).toBe(kind === 'project' ? 'project:14' : 'personal')
    expect(new Headers(init.headers).get('x-dsh-expected-principal-id')).toBe('7')
    if (typeof init.body !== 'string') throw new Error('Expected a JSON request body')
    const { rpcId, payload } = JSON.parse(init.body) as {
      rpcId: string
      payload: { requestId: string; sessionId: string; mode: string; clientTimeZone?: string; content: unknown[] }
    }
    expect(payload).toMatchObject({ sessionId: 'original', requestId: echo.requestId })
    const operation = url.pathname.endsWith('/session.status') ? 'status' : 'prompt'
    calls.push(operation)
    let value: unknown
    if (operation === 'prompt') {
      dispatched.push(payload)
      const first = dispatched.length === 1
      if (first && !committed) return Response.json({ error: 'node-access/lease-lost' }, { status: 409 })
      const digest = createHash('sha256').update(JSON.stringify([payload.mode, payload.clientTimeZone ?? null, payload.content])).digest('hex')
      durable.set(payload.requestId, createHash('sha256').update(JSON.stringify([payload.requestId, digest])).digest('hex'))
      if (first) throw new TypeError('The transport failed after durable acceptance')
      value = { accepted: true }
    } else {
      if (++statusCalls === 1) {
        accountVerified = false
        return Response.json({ error: { code: 'INSTANCE_STARTING' } }, { status: 503 })
      }
      value = committed ? { state: 'accepted', inputProof: durable.get(payload.requestId) } : { state: 'unknown' }
    }
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value } }, { headers: { 'x-dsh-runtime-id': target.runtimeId! } })
  })
  try {
    const pending = session.prompt([{ type: 'text', text: input.text }], 'queue', undefined, echo.requestId)
    await blocked.promise
    expect(session.getSnapshot().pendingSubmissions?.[0]?.text).toBe(input.text)
    expect(JSON.stringify([...slots])).not.toContain(input.text)
    accountVerified = true
    expect(await pending).toEqual({ ok: true, value: { accepted: true } })
    expect(calls).toEqual(committed ? ['prompt', 'status', 'status'] : ['prompt', 'status', 'status', 'prompt'])
    if (!committed) expect(dispatched[0]).toEqual(dispatched[1])
    expect([...durable.keys()]).toEqual([echo.requestId])
    expect(slots.size).toBe(0)
  } finally { session.dispose() }
})

it.each(['steering', 'revoked', 'ownership changed'] as const)('leaves the input unconfirmed when recovery is refused (%s)', async (reason) => {
  vi.stubGlobal('location', new URL('https://harness.invalid/'))
  const slots = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => { slots.set(key, value) },
    removeItem: (key: string) => { slots.delete(key) },
  })
  const target = { kind: 'personal', nodeId: '10000000-0000-4000-8000-000000000008',
    runtimeId: '10000000-0000-4000-8000-000000000009' } as SessionRuntimeTarget
  const connection = { interactions: 'none', metadataTiming: { requestTimeoutMs: 1000, retryAfterMs: 1 } } as ConnectionHandle
  const original = new PreparedSessionApi(connection, target, 7)
  let api = original
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    calls.push(url.pathname)
    if (url.pathname.endsWith('/session.prompt')) return new Response(null, { status: 503 })
    if (reason === 'revoked') return new Response(null, { status: 403 })
    if (reason === 'ownership changed') api = new PreparedSessionApi(connection, target, 8)
    if (typeof init.body !== 'string') throw new Error('Expected a JSON request body')
    const { rpcId } = JSON.parse(init.body) as { rpcId: string }
    return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { state: 'unknown' } } },
      { headers: { 'x-dsh-runtime-id': target.runtimeId! } })
  })
  const session = new Session('original' as SessionId, new FakeApiClient(), fakeRemote(), { admission: () => api })
  try {
    const mode = reason === 'steering' ? 'steer' : 'queue'
    const content = [{ type: 'text' as const, text: 'retain this input' }]
    expect((await session.prompt(content, mode)).ok).toBe(false)
    expect(slots.size).toBe(1)
    expect(calls).toEqual(['/api/admit/v1/session.prompt', '/api/admit/v1/session.status'])
  } finally { session.dispose() }
})

it('queries an uncertain submission and an explicit retry uses the same request ID after status becomes available', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid/'))
  const owner = '10000000-0000-4000-8000-000000000009' as const
  const connection = { interactions: 'none', metadataTiming: { requestTimeoutMs: 500, retryAfterMs: 500 } } as ConnectionHandle
  const api = new PreparedSessionApi(connection, { kind: 'personal', runtimeId: owner as NonNullable<SessionRuntimeTarget['runtimeId']> }, 7)
  const calls: Array<{ path: string; id: string }> = []
  const slots = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => slots.get(key) ?? null,
    setItem: (key: string, value: string) => { slots.set(key, value) },
    removeItem: (key: string) => { slots.delete(key) },
  })
  let attempts = 0, authorized = true
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    expect(url.searchParams.get('dshRuntime')).toBe(owner)
    expect(new Headers(init.headers).get('x-dsh-expected-principal-id')).toBe('7')
    const envelope = JSON.parse(typeof init.body === 'string' ? init.body : '') as { rpcId: string; payload: { requestId: string; sessionId: string } }
    expect(envelope.payload.sessionId).toBe('original')
    calls.push({ path: url.pathname, id: envelope.payload.requestId })
    if (!authorized) return new Response(null, { status: 403 })
    if (url.pathname.endsWith('/session.prompt') && ++attempts === 1) throw new Error('lost response')
    const value = url.pathname.endsWith('/session.status') ? { state: 'unknown' } : { accepted: true }
    return Response.json({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }, { headers: { 'x-dsh-runtime-id': owner } })
  })
  const session = new Session('original' as SessionId, new FakeApiClient(), fakeRemote(), { admission: () => api })
  const input = { text: 'exact original input', mode: 'queue' as const, images: [] }
  const content = [{ type: 'text' as const, text: input.text }]
  const first = session.beginSubmission(input)
  expect((await session.prompt(content, 'queue', undefined, first.requestId)).ok).toBe(false)
  authorized = false
  const denied = session.beginSubmission(input)
  expect(denied.requestId).toBe(first.requestId)
  expect((await session.prompt(content, 'queue', undefined, denied.requestId)).ok).toBe(false)
  expect(attempts).toBe(1)
  authorized = true
  const retry = session.beginSubmission(input)
  expect(retry.requestId).toBe(first.requestId)
  expect(await session.prompt(content, 'queue', undefined, retry.requestId)).toEqual({ ok: true, value: { accepted: true } })
  expect(calls.map(row => row.path)).toEqual(['/api/admit/v1/session.prompt', '/api/admit/v1/session.status',
    '/api/admit/v1/session.status', '/api/admit/v1/session.status', '/api/admit/v1/session.prompt'])
  expect(new Set(calls.map(row => row.id))).toEqual(new Set([first.requestId]))
  expect((await session.prompt(content, 'queue')).ok).toBe(true)
  expect(calls.at(-1)?.id).not.toBe(first.requestId)
})

it('reconciles an admitted wire input after the page is replaced before either response is available', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid/'))
  const data = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
    removeItem: (k: string) => {
      data.delete(k)
    },
  })
  const conn = {
    interactions: 'none',
    metadataTiming: { requestTimeoutMs: 1000, retryAfterMs: 1000 },
  } as ConnectionHandle
  const target = {
    kind: 'personal' as const,
    nodeId: '10000000-0000-4000-8000-000000000008',
    runtimeId: '10000000-0000-4000-8000-000000000009',
  } as SessionRuntimeTarget
  const create = () =>
    new Session('same-session' as SessionId, new FakeApiClient(), fakeRemote(), {
      admission: () => new PreparedSessionApi(conn, target, 7),
    })
  const reached = Promise.withResolvers<undefined>(),
    lost = Promise.withResolvers<undefined>(),
    commits = new Map<string, string>()
  let online = false
  const words = 'same privately drafted input'
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    if (typeof init.body !== 'string') throw new Error('Expected a JSON request body')
    const envelope = JSON.parse(init.body) as {
      rpcId: string
      payload: { requestId: string; mode: string; content: unknown[]; clientTimeZone?: string }
    }
    const id = envelope.payload.requestId
    if (url.pathname.endsWith('/session.prompt')) {
      const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
      commits.set(
        id,
        hash([id, hash([envelope.payload.mode, envelope.payload.clientTimeZone ?? null, envelope.payload.content])]),
      )
      if (!online) {
        reached.resolve(undefined)
        await lost.promise
        throw new Error('response lost')
      }
    } else if (!online) throw new Error('status offline')
    const value = url.pathname.endsWith('/session.status')
      ? { state: commits.has(id) ? 'accepted' : 'unknown', inputProof: commits.get(id) }
      : { accepted: true }
    return Response.json(
      { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } },
      { headers: { 'x-dsh-runtime-id': target.runtimeId! } },
    )
  })
  const send = (s: Session) => {
    const echo = s.beginSubmission({ text: words, mode: 'queue', images: [] })
    return s.prompt([{ type: 'text', text: words }], 'queue', undefined, echo.requestId)
  }
  const first = create(),
    pending = send(first)
  await reached.promise
  first.dispose()
  lost.resolve(undefined)
  await pending
  expect(JSON.stringify([...data])).not.toContain(words)
  online = true
  const second = create()
  try {
    expect((await send(second)).ok).toBe(true)
    expect(commits.size).toBe(1)
    expect((await send(second)).ok).toBe(true)
    expect(commits.size).toBe(2)
  } finally {
    second.dispose()
  }
})

it('reuses the persisted ID while the previous page’s original HTTP admission is still in flight', async () => {
  vi.stubGlobal('location', new URL('https://harness.invalid/'))
  const ledger = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => ledger.get(k) ?? null,
    setItem: (k: string, v: string) => ledger.set(k, v),
    removeItem: (k: string) => ledger.delete(k),
  })
  const target = { kind: 'personal', runtimeId: '10000000-0000-4000-8000-000000000009' } as SessionRuntimeTarget
  const connection = {
    interactions: 'none',
    metadataTiming: { requestTimeoutMs: 1000, retryAfterMs: 1000 },
  } as ConnectionHandle
  const start = () =>
    new Session('flight' as SessionId, new FakeApiClient(), fakeRemote(), {
      admission: () => new PreparedSessionApi(connection, target, 7),
    })
  const inFlight = Promise.withResolvers<undefined>(),
    finishOriginal = Promise.withResolvers<undefined>(),
    committed = new Set<string>(),
    calls: string[] = []
  vi.stubGlobal('fetch', async (url: URL, request: RequestInit) => {
    if (typeof request.body !== 'string') throw new Error('Expected a JSON request body')
    const envelope = JSON.parse(request.body) as { rpcId: string; payload: { requestId: string } }
    const id = envelope.payload.requestId
    let value: unknown
    if (url.pathname.endsWith('/session.status')) value = { state: 'unknown' }
    else {
      calls.push(id)
      if (calls.length === 1) {
        inFlight.resolve(undefined)
        await finishOriginal.promise
      }
      committed.add(id)
      value = { accepted: true }
    }
    return Response.json(
      { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } },
      { headers: { 'x-dsh-runtime-id': target.runtimeId! } },
    )
  })
  const send = (s: Session) => s.prompt([{ type: 'text', text: 'draft restored while in flight' }], 'queue')
  const earlier = start(),
    held = send(earlier)
  await inFlight.promise
  earlier.dispose()
  const later = start()
  try {
    expect(await send(later)).toEqual({ ok: true, value: { accepted: true } })
    finishOriginal.resolve(undefined)
    expect((await held).ok).toBe(false)
    expect(calls).toHaveLength(2)
    expect(committed.size).toBe(1)
    expect(new Set(calls).size).toBe(1)
  } finally {
    finishOriginal.resolve(undefined)
    later.dispose()
  }
})
