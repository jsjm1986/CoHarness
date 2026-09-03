import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  SessionPersistence,
  SessionPersistencePageTooLargeError,
  SessionPersistenceReadCursor,
  SessionPersistenceRevision,
  decodeSessionPersistenceCursor,
  encodeSessionPersistenceCursor,
  normalizeSessionPersistencePageRequest,
  selectSessionPersistencePage,
  cursorSessionId,
  type SessionPersistenceSnapshot,
} from '../src/index.ts'

interface Entry {
  meta: SessionHeader
  events: SessionEvent[]
  generation: number
}

/** Small deterministic backend used to exercise the provider-neutral page fallback. */
class PagePersistence extends SessionPersistence {
  override readonly supportsRawArtifacts = false
  readonly entries = new Map<string, Entry>()
  afterReadFrom?: () => void

  locate(_meta: SessionHeader): undefined {
    return undefined
  }

  async create(meta: SessionHeader): Promise<void> {
    this.entries.set(String(meta.id), { meta: structuredClone(meta), events: [], generation: 0 })
  }

  async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const entry = this.entries.get(String(id))
    if (entry === undefined) throw new Error(`missing ${String(id)}`)
    entry.events.push(...structuredClone(events) as SessionEvent[])
    entry.generation += 1
  }

  async load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const entry = this.entries.get(String(id))
    if (entry === undefined) throw new Error(`missing ${String(id)}`)
    return { meta: structuredClone(entry.meta), events: structuredClone(entry.events) }
  }

  async inspect(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.load(id)
  }

  async readFrom(
    id: SessionId,
    fromSeq: number,
    signal?: AbortSignal,
  ): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    signal?.throwIfAborted()
    const entry = this.entries.get(String(id))
    if (entry === undefined) throw new Error(`missing ${String(id)}`)
    const result = {
      meta: structuredClone(entry.meta),
      events: structuredClone(entry.events.filter(event => event.seq >= fromSeq)),
    }
    this.afterReadFrom?.()
    signal?.throwIfAborted()
    return result
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return [...this.entries.values()].map(entry => structuredClone(entry.meta))
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    return [...this.entries.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(String(entry.generation)),
    }))
  }

  bump(id: SessionId): void {
    const entry = this.entries.get(String(id))
    if (entry === undefined) throw new Error(`missing ${String(id)}`)
    entry.generation += 1
  }
}

function event(seq: number, data: unknown = { seq }): SessionEvent {
  return { type: 'turn/start', seq, time: seq, data } as SessionEvent
}

async function fixture(events = Array.from({ length: 5 }, (_, seq) => event(seq))): Promise<{
  persistence: PagePersistence
  id: SessionId
  dispose: () => Promise<void>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const persistence = new PagePersistence(ctx)
  const id = SessionId('page-session')
  await persistence.create({ id, version: 0, createdAt: 1 })
  await persistence.append(id, events)
  return {
    persistence,
    id,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

describe('session persistence page protocol', () => {
  it('rejects malformed cursors and invalid request combinations', async () => {
    expect(() => SessionPersistenceReadCursor('')).toThrow()
    expect(() => decodeSessionPersistenceCursor(SessionPersistenceReadCursor('!'))).toThrow(/cursor is invalid/)
    const malformed = (value: unknown) => SessionPersistenceReadCursor(
      Buffer.from(JSON.stringify(value), 'utf8').toString('base64url'),
    )
    expect(() => decodeSessionPersistenceCursor(malformed([]))).toThrow(/cursor is invalid/)
    expect(() => decodeSessionPersistenceCursor(malformed([1, 's', 'r', 'sideways', 0]))).toThrow(/cursor is invalid/)
    const valid = encodeSessionPersistenceCursor({
      version: 1, sessionId: 'page-session', revision: '1', direction: 'older', anchor: 2,
    })
    expect(cursorSessionId(valid)).toBe('page-session')
    const nonCanonical = SessionPersistenceReadCursor(
      Buffer.from('[1,"page-session","1","older",2 ]', 'utf8').toString('base64url'),
    )
    expect(() => decodeSessionPersistenceCursor(nonCanonical)).toThrow(/cursor is invalid/)
    const mismatch = encodeSessionPersistenceCursor({
      version: 1, sessionId: 'page-session', revision: '1', direction: 'newer', anchor: 2,
    })
    const invalidRequests = [
      { direction: 'invalid' },
      { cursor: valid, direction: 'newer' },
      { cursor: valid, beforeSeq: 1 },
      { direction: 'older', fromSeq: 1 },
      { direction: 'newer', beforeSeq: 1 },
      { maxBytes: 0 },
      { maxEvents: 11 },
      { maxGroups: 11 },
      { beforeSeq: -1 },
      { fromSeq: Number.MAX_SAFE_INTEGER + 1 },
    ] as const
    for (const request of invalidRequests) {
      expect(() => normalizeSessionPersistencePageRequest(request as never, {
        maxBytes: 10, maxEvents: 10, maxGroups: 10,
      })).toThrow()
    }
    expect(() => normalizeSessionPersistencePageRequest({ cursor: mismatch, direction: 'older' }, {
      maxBytes: 10, maxEvents: 10, maxGroups: 10,
    })).toThrow()
  })

  it('walks older and newer pages with cursor-only continuation', async () => {
    const { persistence, id, dispose } = await fixture()
    try {
      const newest = await persistence.readPage(id, { maxEvents: 2 })
      expect(newest.events.map(item => item.seq)).toEqual([3, 4])
      expect(newest.hasMore).toBe(true)
      const older = await persistence.readPage(id, { cursor: newest.nextCursor!, maxEvents: 2 })
      expect(older.events.map(item => item.seq)).toEqual([1, 2])
      const oldest = await persistence.readPage(id, { cursor: older.nextCursor!, maxEvents: 2 })
      expect(oldest.events.map(item => item.seq)).toEqual([0])
      expect(oldest.hasMore).toBe(false)

      const first = await persistence.readPage(id, { direction: 'newer', fromSeq: 0, maxEvents: 2 })
      expect(first.events.map(item => item.seq)).toEqual([0, 1])
      const next = await persistence.readPage(id, { cursor: first.nextCursor!, maxEvents: 2 })
      expect(next.events.map(item => item.seq)).toEqual([2, 3])
      const last = await persistence.readPage(id, { cursor: next.nextCursor!, maxEvents: 2 })
      expect(last.events.map(item => item.seq)).toEqual([4])
      expect(last.hasMore).toBe(false)
    } finally {
      await dispose()
    }
  })

  it('binds cursors to session, direction, and revision', async () => {
    const { persistence, id, dispose } = await fixture()
    try {
      const page = await persistence.readPage(id, { direction: 'newer', fromSeq: 0, maxEvents: 1 })
      const cursor = page.nextCursor!
      await expect(persistence.readPage(id, { cursor, direction: 'older' }))
        .rejects.toMatchObject({ code: 'protocol' })
      // A moved log is the retryable category, not a caller protocol fault.
      persistence.bump(id)
      await expect(persistence.readPage(id, { cursor })).rejects.toMatchObject({ code: 'dependency' })

      const other = SessionId('other-page-session')
      await persistence.create({ id: other, version: 0, createdAt: 1 })
      await persistence.append(other, [event(0)])
      await expect(persistence.readPage(other, { cursor })).rejects.toMatchObject({ code: 'protocol' })
    } finally {
      await dispose()
    }
  })

  it('rejects limits above the provider page budget and indivisible oversized events', async () => {
    const { persistence, id, dispose } = await fixture()
    try {
      await expect(persistence.readPage(id, { maxBytes: 512 * 1024 + 1 }))
        .rejects.toMatchObject({ code: 'protocol' })
      await expect(persistence.readPage(id, { maxEvents: 2_001 }))
        .rejects.toMatchObject({ code: 'protocol' })
      const oversized = event(0, { text: 'x'.repeat(100) })
      expect(() => selectSessionPersistencePage([oversized], 'newer', 10, 10, 10))
        .toThrow(SessionPersistencePageTooLargeError)
      expect(() => selectSessionPersistencePage([oversized], 'newer', 10, 10, 10))
        .toThrow(expect.objectContaining({ code: 'too-large', limit: 10 }))
    } finally {
      await dispose()
    }
  })

  it('honors group and byte boundaries and preserves cancellation', async () => {
    const chunks = Array.from({ length: 4 }, (_, seq) => ({
      type: 'assistant/chunk',
      seq,
      time: seq,
      data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: seq, text: 'x' } },
    })) as SessionEvent[]
    const chunkPage = selectSessionPersistencePage(
      chunks,
      'newer',
      Number.MAX_SAFE_INTEGER,
      10,
      1,
    )
    expect(chunkPage.events).toHaveLength(4)
    expect(chunkPage.hasMore).toBe(false)

    const selected = selectSessionPersistencePage(
      [event(0), event(1), event(2)],
      'newer',
      Number.MAX_SAFE_INTEGER,
      10,
      1,
    )
    expect(selected.events.map(item => item.seq)).toEqual([0])
    expect(selected.hasMore).toBe(true)

    const source = {
      ...event(1),
      sourceEventSeqs: [0],
    } as SessionEvent
    const sourceWithoutEarlierSeq = {
      ...event(2),
      sourceEventSeqs: [2],
    } as SessionEvent
    const message = {
      type: 'user/message',
      seq: 2,
      time: 2,
      data: { content: [{ type: 'text', text: 'message' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    } as SessionEvent
    expect(selectSessionPersistencePage([source, sourceWithoutEarlierSeq, message], 'newer', 10_000, 10, 10).events).toHaveLength(3)

    const normalized = normalizeSessionPersistencePageRequest(
      { direction: 'newer', fromSeq: 0 },
      { maxBytes: 100, maxEvents: 10, maxGroups: 10 },
    )
    expect(normalized.direction).toBe('newer')
    const cursor = encodeSessionPersistenceCursor({
      version: 1, sessionId: 'page-session', revision: '1', direction: 'newer', anchor: 2,
    })
    expect(decodeSessionPersistenceCursor(cursor)).toMatchObject({ direction: 'newer', anchor: 2 })
    expect(normalizeSessionPersistencePageRequest({ cursor }, {
      maxBytes: 100, maxEvents: 10, maxGroups: 10,
    }).direction).toBe('newer')

    const { persistence, id, dispose } = await fixture()
    try {
      const controller = new AbortController()
      const reason = new Error('page cancelled')
      controller.abort(reason)
      await expect(persistence.readPage(id, {}, controller.signal)).rejects.toBe(reason)
    } finally {
      await dispose()
    }
  })

  it('refuses a revision that changes during fallback acquisition', async () => {
    const { persistence, id, dispose } = await fixture()
    try {
      persistence.afterReadFrom = () => { persistence.bump(id) }
      await expect(persistence.readPage(id, { maxEvents: 2 }))
        .rejects.toMatchObject({ code: 'dependency' })
    } finally {
      await dispose()
    }
  })
})
