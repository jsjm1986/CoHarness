import { Context } from '@deepseek-ai/cordis'
import type { CollaborationSessionCreation } from '@deepseek-ai/dsh-collaboration'
import type {
  GatewayRequestPrincipal,
  GatewayRuntime,
  GatewayRuntimeRequestInit,
  GatewaySessionCreationAuthorization,
} from '@deepseek-ai/dsh-gateway-runtime'
import SessionStore, { SessionDraftId, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import {
  decodeSessionPersistenceCursor,
  encodeSessionPersistenceCursor,
  SessionPersistenceReadCursor,
  SessionPersistenceReadError,
} from '@deepseek-ai/dsh-session-persistence'
import {
  appendLog,
  oneTurnLog,
  runPersistenceContract,
} from '../../session-persistence/tests/contract.ts'
import {
  runCoordinatorContract,
  type CoordinatorFixture,
} from '../../session-persistence/tests/coordinator-contract.ts'
import GatewaySessionPersistence from '../src/index.ts'

interface StoredSession {
  header: unknown
  events: unknown[]
  revision: number
}

interface RecordedAppend {
  body: Record<string, unknown>
  principal: GatewayRequestPrincipal | boolean | undefined
}

interface RecordedCreation extends RecordedAppend {}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function bodyRecord(init: GatewayRuntimeRequestInit): Record<string, unknown> {
  if (typeof init.body !== 'string') throw new Error('test transport requires a JSON string body')
  const value: unknown = JSON.parse(init.body)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('test transport requires a JSON object body')
  }
  return value as Record<string, unknown>
}

/** In-memory implementation of the Gateway runtime HTTP resources used by the backend contract. */
class GatewayTransport {
  readonly identity = { kind: 'project' as const, id: 41, generation: 7 }
  readonly organization = 'acme'
  readonly appends: RecordedAppend[] = []
  readonly creations: RecordedCreation[] = []
  principal: GatewayRequestPrincipal | undefined

  private readonly sessions = new Map<string, StoredSession>()
  private readonly batches = new Map<string, string>()
  private readonly authorizations = new Map<string, { header: unknown; visibility: unknown }>()
  private readonly reservations = new Map<string, string>()
  private readonly pending = new Map<SessionId, Promise<GatewaySessionCreationAuthorization>>()

  seed(id: string, events: unknown[]): void {
    this.sessions.set(id, {
      header: { id, version: 0, createdAt: 1_786_698_000_000 },
      events: structuredClone(events),
      revision: 1,
    })
  }

  current(): GatewayRequestPrincipal | undefined {
    return this.principal
  }

  requireCurrent(): GatewayRequestPrincipal {
    if (this.principal === undefined) throw new Error('test principal is unavailable')
    return this.principal
  }

  registerSessionCreation(
    sessionId: SessionId,
    authorization: Promise<GatewaySessionCreationAuthorization>,
  ): () => void {
    this.pending.set(sessionId, authorization)
    return () => {
      if (this.pending.get(sessionId) === authorization) this.pending.delete(sessionId)
    }
  }

  sessionCreation(sessionId: SessionId): Promise<GatewaySessionCreationAuthorization> | undefined {
    return this.pending.get(sessionId)
  }

  async request(path: string, init: GatewayRuntimeRequestInit = {}): Promise<Response> {
    const url = new URL(path, 'http://gateway.test')
    const sessionId = url.searchParams.get('sessionId') ?? ''

    if (url.pathname === '/internal/runtime/session/load') {
      const stored = this.sessions.get(sessionId)
      return stored === undefined ? json(404, { error: 'conversation-not-found' }) : json(200, {
        header: structuredClone(stored.header),
        events: structuredClone(stored.events),
        revision: `revision-${String(stored.revision)}`,
      })
    }

    if (url.pathname === '/internal/runtime/session/revision') {
      const stored = this.sessions.get(sessionId)
      return json(200, { revision: stored === undefined ? null : `revision-${String(stored.revision)}` })
    }

    if (url.pathname === '/internal/runtime/session/meta') {
      const stored = this.sessions.get(sessionId)
      return stored === undefined ? json(404, { error: 'conversation-not-found' }) : json(200, {
        header: structuredClone(stored.header),
        revision: `revision-${String(stored.revision)}`,
      })
    }

    if (url.pathname === '/internal/runtime/session/page') {
      const stored = this.sessions.get(sessionId)
      if (stored === undefined) return json(404, { error: 'conversation-not-found' })
      const cursorText = url.searchParams.get('cursor')
      const cursor = cursorText === null
        ? undefined
        : decodeSessionPersistenceCursor(SessionPersistenceReadCursor(cursorText))
      const directionParam = url.searchParams.get('direction')
      const direction: 'older' | 'newer' = directionParam === 'newer'
        ? 'newer'
        : cursor?.direction ?? 'older'

      const anchor = cursor?.anchor
        ?? (direction === 'older'
          ? Number(url.searchParams.get('beforeSeq') ?? stored.events.length)
          : Number(url.searchParams.get('fromSeq') ?? 0))
      const maxEvents = Number(url.searchParams.get('maxEvents') ?? 2_000)
      const maxBytes = Number(url.searchParams.get('maxBytes') ?? 512 * 1024)
      const candidates = stored.events.filter((candidate) => {
        const seq = (candidate as { seq?: unknown }).seq
        return typeof seq === 'number' && (direction === 'older' ? seq < anchor : seq >= anchor)
      })
      const ordered = direction === 'older' ? [...candidates].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq) : candidates
      const selected = direction === 'older' ? ordered.slice(-maxEvents) : ordered.slice(0, maxEvents)
      const bytes = Buffer.byteLength(JSON.stringify(selected), 'utf8')
      if (bytes > maxBytes) return json(413, {
        error: 'conversation-too-large', code: 'too-large', message: 'conversation page exceeds the byte limit',
      })
      const first = selected[0] as { seq?: number } | undefined
      const last = selected.at(-1) as { seq?: number } | undefined
      const hasMore = candidates.length > selected.length
      const nextAnchor = direction === 'older' ? (first?.seq ?? anchor) : (last?.seq === undefined ? anchor : last.seq + 1)
      const nextCursor = hasMore
        ? encodeSessionPersistenceCursor({
          version: 1,
          sessionId,
          revision: `revision-${String(stored.revision)}`,
          direction,
          anchor: nextAnchor,
        })
        : undefined
      return json(200, {
        header: structuredClone(stored.header),
        events: structuredClone(selected),
        revision: `revision-${String(stored.revision)}`,
        startSeq: first?.seq ?? null,
        endSeq: last?.seq ?? null,
        hasMore,
        ...(nextCursor === undefined ? {} : { nextCursor }),
        uncompressedBytes: selected.reduce<number>((sum, item) => sum + Buffer.byteLength(JSON.stringify(item), 'utf8'), 0),
      })
    }

    if (url.pathname === '/internal/runtime/session/read-from') {
      const stored = this.sessions.get(sessionId)
      if (stored === undefined) return json(404, { error: 'conversation-not-found' })
      const fromSeq = Number(url.searchParams.get('fromSeq'))
      return json(200, {
        header: structuredClone(stored.header),
        events: structuredClone(stored.events.slice(fromSeq)),
      })
    }

    if (url.pathname === '/internal/runtime/session/list') {
      return json(200, {
        items: [...this.sessions.values()].map(stored => ({
          header: structuredClone(stored.header),
          revision: `revision-${String(stored.revision)}`,
        })),
      })
    }

    if (url.pathname === '/internal/runtime/session/create') {
      const body = bodyRecord(init)
      this.creations.push({ body: structuredClone(body), principal: init.principal })
      if (init.principal === undefined || init.principal === false) {
        return json(403, { error: 'forbidden' })
      }
      const header = body.header as { id?: unknown } | undefined
      const authorization = `creation-${String(header?.id)}` as GatewaySessionCreationAuthorization
      this.authorizations.set(authorization, {
        header: structuredClone(body.header),
        visibility: body.visibility,
      })
      return json(200, { authorization })
    }

    if (url.pathname === '/internal/runtime/session/draft/reserve') {
      const body = bodyRecord(init)
      const key = String(body.draftId)
      const sessionId = this.reservations.get(key) ?? String(body.sessionId)
      this.reservations.set(key, sessionId)
      return json(200, { draftId: key, sessionId, leaseExpiresAt: Date.now() + 3_600_000 })
    }
    if (url.pathname === '/internal/runtime/session/draft/heartbeat') return json(200, { renewed: true })
    if (url.pathname === '/internal/runtime/session/draft/release') {
      const body = bodyRecord(init)
      this.reservations.delete(String(body.draftId))
      return json(200, { released: true })
    }

    if (url.pathname === '/internal/runtime/session/append') {
      const body = bodyRecord(init)
      this.appends.push({ body: structuredClone(body), principal: init.principal })
      const id = String(body.sessionId)
      const batchId = String(body.batchId)
      const events = structuredClone(body.events) as unknown[]
      const batch = JSON.stringify({ id, events })
      const prior = this.batches.get(batchId)
      if (prior !== undefined) {
        if (prior !== batch) throw new Error('batch id reused with different content')
        return json(200, { result: 'duplicate' })
      }
      let stored = this.sessions.get(id)
      if (stored === undefined) {
        const creation = typeof body.creationAuthorization === 'string'
          ? this.authorizations.get(body.creationAuthorization)
          : undefined
        const header = creation?.header ?? body.header
        if (header === undefined) return json(404, { error: 'conversation-not-found' })
        stored = { header: structuredClone(header), events: [], revision: 0 }
        this.sessions.set(id, stored)
      }
      const first = events[0] as { seq?: unknown } | undefined
      if (typeof first?.seq !== 'number' || first.seq !== stored.events.length) {
        throw new Error('non-contiguous append in test transport')
      }
      stored.events.push(...events)
      stored.revision += 1
      this.batches.set(batchId, batch)
      return json(200, { result: 'inserted' })
    }

    if (url.pathname === '/internal/runtime/session/repair') {
      const body = bodyRecord(init)
      const id = String(body.sessionId)
      const batchId = String(body.batchId)
      const closers = structuredClone(body.closers) as unknown[]
      const stored = this.sessions.get(id)
      if (stored === undefined) return json(404, { error: 'conversation-not-found' })
      const batch = JSON.stringify({ id, closers })
      const prior = this.batches.get(batchId)
      if (prior !== undefined) {
        if (prior !== batch) throw new Error('repair id reused with different content')
        return json(200, { repaired: true })
      }
      stored.events.push(...closers)
      stored.revision += 1
      this.batches.set(batchId, batch)
      return json(200, { repaired: true })
    }

    return json(404, { error: 'not-found' })
  }
}

async function mountBackend(ctx: Context, transport: GatewayTransport) {
  if (ctx.get('gatewayRuntime') === undefined) {
    ctx.provide('gatewayRuntime', transport as unknown as GatewayRuntime)
  }
  return ctx.plugin(GatewaySessionPersistence, { writeBatchMaxDelayMs: 1 })
}

runPersistenceContract('gateway-http', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await mountBackend(ctx, new GatewayTransport())
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
})

runCoordinatorContract('gateway-http', async (): Promise<CoordinatorFixture> => {
  const transport = new GatewayTransport()
  return {
    mount: ctx => mountBackend(ctx, transport),
    cleanup: async () => {},
  }
})

const PRINCIPAL: GatewayRequestPrincipal = {
  assertion: 'principal-assertion',
  claims: {
    version: 1,
    issuer: 'harness-gateway',
    audience: 'dsh-runtime',
    organization: 'acme',
    user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' },
    scope: { kind: 'project', projectId: 41, projectName: 'Compiler', mode: 'rw' },
    runtime: { kind: 'project', id: 41, generation: 7 },
    issuedAt: 1,
    expiresAt: 2,
    nonce: 'nonce',
  },
}

describe('GatewaySessionPersistence collaboration creation', () => {
  it('uses a persistent creation authorization after the request principal expires', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transport = new GatewayTransport()
    transport.principal = PRINCIPAL
    let creation: CollaborationSessionCreation | undefined = { visibility: 'private' }
    ctx.provide('collaboration', { currentCreation: () => creation } as never)
    const fiber = await mountBackend(ctx, transport)

    const session = ctx.sessions.create(SessionId('private-root'), { meta: { cwd: '/work' } })
    await expect(transport.sessionCreation(session.id)).resolves.toBe('creation-private-root')
    creation = undefined
    transport.principal = undefined
    appendLog(session, oneTurnLog())
    await ctx.sessions.flush(session)

    expect(transport.creations).toHaveLength(1)
    expect(transport.creations[0]?.principal).toBe(PRINCIPAL)
    expect(transport.creations[0]?.body).toMatchObject({
      visibility: 'private',
      header: { id: 'private-root', cwd: '/work' },
    })
    expect(transport.appends).toHaveLength(1)
    expect(transport.appends[0]?.principal).toBeUndefined()
    expect(transport.appends[0]?.body).toMatchObject({
      sessionId: 'private-root',
      creationAuthorization: 'creation-private-root',
    })
    expect(transport.appends[0]?.body).not.toHaveProperty('header')
    expect(transport.sessionCreation(session.id)).toBeUndefined()
    await fiber.dispose()
  })

  it('reserves and releases a canonical browser draft identity', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transport = new GatewayTransport()
    transport.principal = PRINCIPAL
    const fiber = await mountBackend(ctx, transport)
    const request = {
      draftId: SessionDraftId('draft-1'),
      sessionId: SessionId('session-draft-1'),
      cwd: '/work',
      visibility: 'private' as const,
    }
    await expect(ctx.sessionPersistence.reserveDraft(request)).resolves.toMatchObject({
      sessionId: SessionId('session-draft-1'),
    })
    await expect(ctx.sessionPersistence.heartbeatDraft(request)).resolves.toBeUndefined()
    await expect(ctx.sessionPersistence.releaseDraft(request)).resolves.toBeUndefined()
    await fiber.dispose()
  })
})

describe('GatewaySessionPersistence response validation', () => {
  it.each([
    ['missing data', { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append' }],
    ['missing surface operation', { type: 'user/message', seq: 0, time: 1, data: {} }],
    ['malformed replacement', {
      type: 'assistant/message',
      seq: 0,
      time: 1,
      data: {},
      surfaceOp: { op: 'replace', start: 0, end: 0, extra: true },
    }],
    ['surface metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: {},
      surfaceOp: 'append',
    }],
    ['source metadata on a log event', {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: {},
      sourceEventSeqs: [0],
    }],
    ['an extra envelope field', {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: {},
      surfaceOp: 'append',
      extra: true,
    }],
  ])('rejects %s', async (_label, invalidEvent) => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transport = new GatewayTransport()
    transport.seed('invalid-event', [invalidEvent])
    const fiber = await mountBackend(ctx, transport)

    await expect((ctx.sessionPersistence as GatewaySessionPersistence).loadStored(
      SessionId('invalid-event'),
    )).rejects.toThrow('Gateway returned an invalid session event list')

    await fiber.dispose()
  })
})

describe('GatewaySessionPersistence bounded page transport', () => {
  it('reads metadata and follows revision-bound cursor pages without loading the full log', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transport = new GatewayTransport()
    transport.seed('paged', oneTurnLog())
    const fiber = await mountBackend(ctx, transport)
    try {
      const id = SessionId('paged')
      await expect(ctx.sessionPersistence.readHeader(id)).resolves.toMatchObject({ id })
      const first = await ctx.sessionPersistence.readPage(id, { maxEvents: 2 })
      expect(first.events.map(item => item.seq)).toEqual([4, 5])
      expect(first.hasMore).toBe(true)
      if (first.nextCursor === undefined) throw new Error('first page did not return a cursor')
      const second = await ctx.sessionPersistence.readPage(id, { cursor: first.nextCursor, maxEvents: 2 })
      expect(second.events.map(item => item.seq)).toEqual([2, 3])
    } finally {
      await fiber.dispose()
    }
  })

  it('maps a bounded page HTTP error to a stable persistence error', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transport = new GatewayTransport()
    transport.seed('large-page', [
      {
        type: 'turn/start', seq: 0, time: 1, data: { text: 'x'.repeat(100) },
      },
    ])
    const fiber = await mountBackend(ctx, transport)
    try {
      await expect(ctx.sessionPersistence.readPage(SessionId('large-page'), { maxBytes: 10 }))
        .rejects.toMatchObject({ code: 'too-large' })
      await expect(ctx.sessionPersistence.readPage(SessionId('large-page'), { maxBytes: 10 }))
        .rejects.toBeInstanceOf(SessionPersistenceReadError)
    } finally {
      await fiber.dispose()
    }
  })

  it('classifies transport timeouts and malformed Gateway JSON', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const transport = new GatewayTransport()
    const request = vi.spyOn(transport, 'request')
    const fiber = await mountBackend(ctx, transport)
    try {
      const timeout = Object.assign(new Error('upstream timeout'), { code: 'ETIMEDOUT' })
      request.mockRejectedValueOnce(timeout)
      await expect(ctx.sessionPersistence.readPage(SessionId('timeout'), { maxEvents: 1 }))
        .rejects.toMatchObject({ code: 'timeout' })

      request.mockResolvedValueOnce(new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      await expect(ctx.sessionPersistence.readPage(SessionId('malformed'), { maxEvents: 1 }))
        .rejects.toMatchObject({ code: 'protocol' })
    } finally {
      request.mockRestore()
      await fiber.dispose()
    }
  })
})
