import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import type { ArchivedSessionEntry, WorkspaceArchiveSnapshot } from '@deepseek-ai/dsh-workspace'
import { describe, expect, it, vi } from 'vitest'
import * as ArchiveGateway from '../src/index.ts'

interface ResponseState { status: number; body: string }
type GatewayRequest = (path: string, init?: RequestInit) => Promise<Response>

function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('test request body is not a string')
  return init.body
}

function response(): { value: ServerResponse; state: ResponseState } {
  const state: ResponseState = { status: 0, body: '' }
  return {
    state,
    value: {
      writeHead(status: number) { state.status = status; return this },
      end(body?: string) { state.body = body ?? ''; return this },
    } as unknown as ServerResponse,
  }
}

function event(type: SessionEvent['type'], seq: number, text: string): SessionEvent {
  return {
    type,
    seq,
    time: seq + 1,
    data: type === 'user/message'
      ? { content: [{ type: 'text', text }] }
      : { message: { content: [{ type: 'text', text }] } },
  } as SessionEvent
}

function archivedEntry(id: SessionId, createdAt: number, rootSessionId = id): ArchivedSessionEntry {
  return {
    sessionId: id,
    rootSessionId,
    header: { id, version: 0, createdAt, isSeeded: false, ...(rootSessionId === id ? {} : { parentSession: rootSessionId }) },
  }
}

function gatewayResponse(value: unknown = { commands: [] }): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function syncContext(options: {
  snapshot: WorkspaceArchiveSnapshot
  entries: readonly ArchivedSessionEntry[]
  readFrom?: (id: SessionId, fromSeq: number) => Promise<{ meta: SessionHeader; events: SessionEvent[] }>
  request: (path: string, init?: RequestInit) => Promise<Response>
  register?: ReturnType<typeof vi.fn>
}): Promise<Context> {
  const ctx = new Context()
  ctx.provide('connection', { http: { handlePrefix: options.register ?? vi.fn() } } as never)
  ctx.provide('gatewayRuntime', {
    requireCurrent: () => ({ claims: { user: { role: 'admin' }, purpose: 'archive-read' } }),
    request: options.request,
  } as never)
  ctx.provide('workspaceRegistry', {
    archiveSnapshot: () => options.snapshot,
    archivedEntries: async () => options.entries,
    archivedSessionIds: options.snapshot.archivedSessionIds,
  } as never)
  ctx.provide('sessionPersistence', {
    list: async () => options.entries.map(entry => entry.header),
    readFrom: options.readFrom ?? (async (id: SessionId) => {
      const entry = options.entries.find(candidate => candidate.sessionId === id)
      if (entry === undefined) throw new Error(`missing ${String(id)}`)
      return { meta: entry.header, events: [] }
    }),
  } as never)
  await ctx.plugin(ArchiveGateway).await()
  return ctx
}

describe('archive-gateway runtime reader', () => {
  it('reads a root and its child sessions through the loopback route', async () => {
    const root = SessionId('archive-root')
    const child = SessionId('archive-child')
    const headers: SessionHeader[] = [
      { id: root, version: 0, createdAt: 1, isSeeded: false },
      { id: child, version: 0, createdAt: 2, parentSession: root, isSeeded: false },
    ]
    const events = new Map<string, SessionEvent[]>([
      [root, [event('user/message', 0, 'hello')]],
      [child, [event('assistant/message', 0, 'world')]],
    ])
    const register = vi.fn()
    const list = vi.fn(async () => headers)
    const ctx = new Context()
    ctx.provide('connection', { http: { handlePrefix: register } } as never)
    ctx.provide('gatewayRuntime', {
      requireCurrent: () => ({ claims: { user: { role: 'admin' }, purpose: 'archive-read' } }),
    } as never)
    ctx.provide('workspaceRegistry', {
      archiveSnapshot: () => ({ revision: 1, archivedSessionIds: [root] }),
      archivedEntries: async () => [],
      archivedSessionIds: [],
    } as never)
    ctx.provide('sessionPersistence', {
      list,
      readFrom: async (id: SessionId) => {
        const meta = headers.find(header => header.id === id)
        if (meta === undefined) throw new Error(`missing ${String(id)}`)
        return { meta, events: events.get(id) ?? [] }
      },
    } as never)
    await ctx.plugin(ArchiveGateway).await()
    const handler = register.mock.calls[0]?.[1] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const output = response()
    await handler({ method: 'GET', url: '/api/internal/archive/read?sessionId=archive-root&limit=10' } as IncomingMessage, output.value)
    expect(output.state.status).toBe(200)
    expect(JSON.parse(output.state.body)).toMatchObject({
      descendants: [
        { sessionId: 'archive-child', parentSessionId: 'archive-root' },
        { sessionId: 'archive-root', parentSessionId: null },
      ],
      events: [
        { sessionId: 'archive-child', data: { message: { content: [{ text: 'world', type: 'text' }] } } },
        { sessionId: 'archive-root', data: { content: [{ text: 'hello', type: 'text' }] } },
      ],
      hasMore: false,
    })
    const second = response()
    await handler({ method: 'GET', url: '/api/internal/archive/read?sessionId=archive-root&limit=10' } as IncomingMessage, second.value)
    expect(second.state.status).toBe(200)
    expect(list).toHaveBeenCalledOnce()
    const emit = ctx.emit.bind(ctx) as unknown as (event: string, payload: unknown) => void
    emit('session/created', { id: SessionId('new-session') })
    const third = response()
    await handler({ method: 'GET', url: '/api/internal/archive/read?sessionId=archive-root&limit=10' } as IncomingMessage, third.value)
    expect(third.state.status).toBe(200)
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('rejects a route call without the archive capability', async () => {
    const register = vi.fn()
    const ctx = new Context()
    ctx.provide('connection', { http: { handlePrefix: register } } as never)
    ctx.provide('gatewayRuntime', {
      requireCurrent: () => ({ claims: { user: { role: 'user' }, purpose: 'archive-read' } }),
    } as never)
    ctx.provide('workspaceRegistry', { archiveSnapshot: () => ({ revision: 0, archivedSessionIds: [] }), archivedEntries: async () => [] } as never)
    ctx.provide('sessionPersistence', { list: async () => [], readFrom: async () => ({ meta: {}, events: [] }) } as never)
    await ctx.plugin(ArchiveGateway).await()
    const handler = register.mock.calls[0]?.[1] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const output = response()
    await handler({ method: 'GET', url: '/api/internal/archive/read?sessionId=missing' } as IncomingMessage, output.value)
    expect(output.state).toEqual({ status: 403, body: JSON.stringify({ error: 'forbidden' }) })
  })
})

describe('archive-gateway synchronization', () => {
  it('splits a runtime snapshot before the Gateway session limit', async () => {
    const ids = Array.from({ length: 1_001 }, (_, index) => SessionId(`archive-${String(index)}`))
    const entries = ids.map((id, index) => archivedEntry(id, index))
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const ctx = await syncContext({
      snapshot: { revision: 7, archivedSessionIds: ids },
      entries,
      request,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    const payloads = request.mock.calls.map(([, init]) => JSON.parse(requestBody(init)) as {
      revision: number
      archivedSessionIds: string[]
      sessions: unknown[]
    })
    expect(payloads.map(payload => payload.archivedSessionIds.length)).toEqual([1_000, 1])
    expect(payloads.map(payload => payload.sessions.length)).toEqual([1_000, 1])
    expect(payloads.every(payload => payload.revision === 7)).toBe(true)
    expect(payloads.flatMap(payload => payload.archivedSessionIds)).toEqual(ids)
    await ctx.fiber.dispose()
  })

  it('bounds the title cache while synchronizing a large archive catalog', async () => {
    const ids = Array.from({ length: 10_001 }, (_, index) => SessionId(`title-cache-${String(index)}`))
    const entries = ids.map((id, index) => archivedEntry(id, index))
    const headers = new Map(entries.map(entry => [entry.sessionId, entry.header]))
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const readFrom = vi.fn(async (id: SessionId) => ({
      meta: headers.get(id)!,
      events: [event('user/message', 0, `title-${String(id)}`)],
    }))
    const ctx = await syncContext({
      snapshot: { revision: 13, archivedSessionIds: ids },
      entries,
      readFrom,
      request,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(11) })
    expect(readFrom).toHaveBeenCalledTimes(ids.length)
    await ctx.fiber.dispose()
  })

  it('splits search rows and publishes the complete root message count', async () => {
    const id = SessionId('archive-large-search')
    const entries = [archivedEntry(id, 1)]
    const events = Array.from({ length: 5_001 }, (_, index) => event('user/message', index, `message-${String(index)}`))
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const ctx = await syncContext({
      snapshot: { revision: 8, archivedSessionIds: [id] },
      entries,
      readFrom: async () => ({ meta: entries[0]!.header, events }),
      request,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(3) })
    const payloads = request.mock.calls.map(([, init]) => JSON.parse(requestBody(init)) as {
      sessions: Array<{
        messageCount: number
        rootMessageCount?: number
      }>
      search?: unknown[]
    })
    expect(payloads.map(payload => payload.search?.length ?? 0)).toEqual([5_000, 1, 0])
    expect(payloads[2]?.sessions).toEqual([expect.objectContaining({
      messageCount: 5_001,
      rootMessageCount: 5_001,
    })])
    await ctx.fiber.dispose()
  })

  it('caps one multibyte search row without emitting broken UTF-8', async () => {
    const id = SessionId('archive-long-search-row')
    const entries = [archivedEntry(id, 1)]
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const ctx = await syncContext({
      snapshot: { revision: 9, archivedSessionIds: [id] },
      entries,
      readFrom: async () => ({ meta: entries[0]!.header, events: [event('user/message', 0, '界'.repeat(30_000))] }),
      request,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    const payload = JSON.parse(requestBody(request.mock.calls[0]?.[1])) as { search: Array<{ content: string }> }
    expect(Buffer.byteLength(payload.search[0]!.content, 'utf8')).toBeLessThanOrEqual(64 * 1024)
    expect(payload.search[0]!.content).not.toContain('\ufffd')
    await ctx.fiber.dispose()
  })

  it('uses the requested sequence floor after synchronization caches descendant titles', async () => {
    const root = SessionId('archive-reader-root')
    const child = SessionId('archive-reader-child')
    const entries = [archivedEntry(root, 1), archivedEntry(child, 2, root)]
    const logs = new Map<SessionId, SessionEvent[]>([
      [root, [event('user/message', 0, 'Root title'), event('assistant/message', 1, 'Root tail')]],
      [child, [event('user/message', 0, 'Child title'), event('assistant/message', 1, 'Child tail')]],
    ])
    const readFrom = vi.fn(async (id: SessionId, fromSeq: number) => ({
      meta: entries.find(entry => entry.sessionId === id)!.header,
      events: (logs.get(id) ?? []).filter(candidate => candidate.seq >= fromSeq),
    }))
    const register = vi.fn()
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const ctx = await syncContext({
      snapshot: { revision: 10, archivedSessionIds: [root, child] },
      entries,
      readFrom,
      request,
      register,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    const handler = register.mock.calls[0]?.[1] as (req: IncomingMessage, res: ServerResponse) => Promise<void>
    const output = response()
    await handler({
      method: 'GET',
      url: '/api/internal/archive/read?sessionId=archive-reader-root&fromSeq=1&limit=10',
    } as IncomingMessage, output.value)
    expect(output.state.status).toBe(200)
    expect(JSON.parse(output.state.body)).toMatchObject({
      descendants: [
        { sessionId: child, title: 'Child title' },
        { sessionId: root, title: 'Root title' },
      ],
      events: [
        { sessionId: child, seq: 1 },
        { sessionId: root, seq: 1 },
      ],
      hasMore: false,
    })
    expect(readFrom.mock.calls.filter(([id]) => id === root).map(([, floor]) => floor)).toEqual([0, 1])
    expect(readFrom.mock.calls.filter(([id]) => id === child).map(([, floor]) => floor)).toEqual([0, 1])
    await ctx.fiber.dispose()
  })

  it('reuses unchanged session projections and invalidates only the session that emitted an event', async () => {
    const root = SessionId('archive-cache-root')
    const sibling = SessionId('archive-cache-sibling')
    const entries = [archivedEntry(root, 1), archivedEntry(sibling, 2)]
    const readFrom = vi.fn(async (id: SessionId) => ({
      meta: entries.find(entry => entry.sessionId === id)!.header,
      events: [event('user/message', 0, String(id))],
    }))
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const ctx = await syncContext({
      snapshot: { revision: 11, archivedSessionIds: [root, sibling] },
      entries,
      readFrom,
      request,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    expect(readFrom).toHaveBeenCalledTimes(2)

    const emit = ctx.emit.bind(ctx) as unknown as (event: string, payload: unknown) => void
    emit('session/event', { id: root })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    expect(readFrom.mock.calls.filter(([id]) => id === root)).toHaveLength(2)
    expect(readFrom.mock.calls.filter(([id]) => id === sibling)).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('appends a contiguous live event to a cached projection without rereading the log', async () => {
    const root = SessionId('archive-cache-incremental')
    const entries = [archivedEntry(root, 1)]
    const readFrom = vi.fn(async () => ({
      meta: entries[0]!.header,
      events: [event('user/message', 0, 'initial')],
    }))
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const ctx = await syncContext({
      snapshot: { revision: 14, archivedSessionIds: [root] },
      entries,
      readFrom,
      request,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    const emit = ctx.emit.bind(ctx) as unknown as (eventName: string, session: unknown, event: SessionEvent) => void
    emit('session/event', { id: root }, event('assistant/message', 1, 'incremental'))
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    expect(readFrom).toHaveBeenCalledOnce()
    const payload = JSON.parse(requestBody(request.mock.calls[1]?.[1])) as {
      sessions: Array<{ messageCount: number }>
      search: Array<{ content: string }>
    }
    expect(payload.sessions[0]?.messageCount).toBe(2)
    expect(payload.search.map(row => row.content)).toEqual(['initial', 'incremental'])
    await ctx.fiber.dispose()
  })

  it('does not cache a projection whose read raced a session event', async () => {
    const root = SessionId('archive-cache-race')
    const entries = [archivedEntry(root, 1)]
    let releaseRead: (() => void) | undefined
    const firstRead = new Promise<void>((resolve) => { releaseRead = resolve })
    let reads = 0
    const readFrom = vi.fn(async () => {
      reads += 1
      if (reads === 1) await firstRead
      return { meta: entries[0]!.header, events: [event('user/message', reads - 1, `read-${String(reads)}`)] }
    })
    const request = vi.fn<GatewayRequest>(async () => gatewayResponse())
    const ctx = await syncContext({
      snapshot: { revision: 12, archivedSessionIds: [root] },
      entries,
      readFrom,
      request,
    })
    await vi.waitFor(() => { expect(readFrom).toHaveBeenCalledOnce() })
    const emit = ctx.emit.bind(ctx) as unknown as (event: string, payload: unknown) => void
    emit('session/event', { id: root })
    releaseRead?.()
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    expect(readFrom).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('coalesces triggers received while one synchronization is running', async () => {
    let release: ((response: Response) => void) | undefined
    const first = new Promise<Response>((resolve) => { release = resolve })
    let calls = 0
    const request = vi.fn<GatewayRequest>(async () => {
      calls += 1
      return calls === 1 ? await first : gatewayResponse()
    })
    const snapshot = { revision: 0, archivedSessionIds: [] } satisfies WorkspaceArchiveSnapshot
    const ctx = await syncContext({ snapshot, entries: [], request })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    for (let index = 0; index < 50; index++) ctx.emit('workspace/archive-changed', snapshot)
    release?.(gatewayResponse())
    await vi.waitFor(() => { expect(request).toHaveBeenCalledTimes(2) })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(request).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
  })

  it('aborts and joins an in-flight synchronization during disposal', async () => {
    let signal: AbortSignal | null | undefined
    const request = vi.fn<GatewayRequest>(async (_path: string, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      signal = init?.signal
      if (signal?.aborted) {
        reject(new DOMException('aborted', 'AbortError'))
        return
      }
      signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) }, { once: true })
    }))
    const ctx = await syncContext({
      snapshot: { revision: 0, archivedSessionIds: [] },
      entries: [],
      request,
    })
    await vi.waitFor(() => { expect(request).toHaveBeenCalledOnce() })
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
  })

  it('removes purged sessions from the durable archive set before the follow-up pass', async () => {
    const root = SessionId('archive-purge-root')
    const entry = archivedEntry(root, 1)
    let revision = 1
    let archived = true
    let stored = true
    const restoreSession = vi.fn(async () => {
      archived = false
      revision++
    })
    const remove = vi.fn(async () => { stored = false })
    let snapshotCalls = 0
    const request = vi.fn<GatewayRequest>(async (path: string) => {
      if (path.endsWith('/ack')) return gatewayResponse()
      snapshotCalls += 1
      return gatewayResponse(snapshotCalls === 1 ? {
        commands: [{ id: 'command-1', rootSessionId: root, action: 'purge' }],
      } : { commands: [] })
    })
    const ctx = new Context()
    ctx.provide('connection', { http: { handlePrefix: vi.fn() } } as never)
    ctx.provide('gatewayRuntime', {
      requireCurrent: () => ({ claims: { user: { role: 'admin' }, purpose: 'archive-read' } }),
      request,
    } as never)
    ctx.provide('workspaceRegistry', {
      archiveSnapshot: () => ({ revision, archivedSessionIds: archived ? [root] : [] }),
      archivedEntries: async () => archived ? [entry] : [],
      get archivedSessionIds() { return archived ? [root] : [] },
      restoreSession,
    } as never)
    ctx.provide('sessionPersistence', {
      list: async () => stored ? [entry.header] : [],
      readFrom: async () => ({ meta: entry.header, events: [] }),
      remove,
    } as never)
    await ctx.plugin(ArchiveGateway).await()
    await vi.waitFor(() => {
      expect(request.mock.calls.filter(([path]) => path.endsWith('/snapshot'))).toHaveLength(2)
    })
    expect(remove).toHaveBeenCalledWith(root)
    expect(restoreSession).toHaveBeenCalledWith(root)
    expect(request.mock.calls.filter(([path]) => path.endsWith('/ack'))).toHaveLength(1)
    const finalSnapshot = request.mock.calls.filter(([path]) => path.endsWith('/snapshot')).at(-1)
    expect(JSON.parse(requestBody(finalSnapshot?.[1]))).toMatchObject({ revision: 2, archivedSessionIds: [] })
    await ctx.fiber.dispose()
  })
})
