import type { Pool, PoolClient } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import {
  ConversationPageTooLargeError,
  ConversationRepository,
  encodePageCursor,
} from '../src/postgres/conversation-repository.ts'

const headerRow = {
  id: 'session-1',
  organization_id: 'organization-1',
  creator_user_id: 'user-1',
  project_id: null,
  parent_session_id: null,
  root_session_id: 'session-1',
  visibility: 'personal',
  session_format_version: 0,
  created_at_ms: '1000',
  cwd: null,
  seed_length: null,
  origin: null,
  delegation_depth: null,
  agent_preset: null,
  draft: false,
  title: null,
  version: '7',
  next_seq: '1',
  has_visible_content: true,
  visible_content_seq: '0',
  last_prompt_at_ms: '1000',
}

describe('ConversationRepository load', () => {
  it('reads the header revision and events in one repeatable-read transaction', async () => {
    const calls: string[] = []
    const event = { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } }
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        if (text.startsWith('SELECT id,organization_id')) return { rows: [headerRow], rowCount: 1 }
        if (text.startsWith('SELECT e.seq::text,e.event FROM')) return { rows: [{ seq: '0', event }], rowCount: 1 }
        return { rows: [], rowCount: null }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool

    await expect(new ConversationRepository(pool).load('session-1')).resolves.toMatchObject({
      header: { id: 'session-1', createdAt: 1000 },
      events: [event],
      revision: '7:1',
    })
    expect(calls).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      expect.stringMatching(/^SELECT id,organization_id/),
      'SELECT e.seq::text,e.event FROM harness.conversation_events e WHERE e.session_id=$1 AND e.seq >= $2 ORDER BY e.seq',
      'COMMIT',
    ])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('commits an empty repeatable-read snapshot without querying events', async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        return { rows: [], rowCount: text === 'BEGIN' || text === 'COMMIT' ? null : 0 }
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool

    await expect(new ConversationRepository(pool).load('missing')).resolves.toBeUndefined()
    expect(calls.filter(text => text.startsWith('SELECT e.seq::text,e.event FROM'))).toHaveLength(0)
    expect(calls.at(-1)).toBe('COMMIT')
    expect(client.release).toHaveBeenCalledOnce()
  })
})

describe('ConversationRepository bounded pages', () => {
  function pagePool(header: typeof headerRow, allEvents: Array<{ seq: number; event: unknown; payload_bytes: number }>) {
    const calls: Array<{ text: string; values: readonly unknown[] | undefined }> = []
    const client = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        calls.push({ text, values })
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
          || text.startsWith('SET TRANSACTION')) return { rows: [], rowCount: null }
        if (text.startsWith('SELECT id,organization_id')) return { rows: [header], rowCount: 1 }
        if (text.startsWith('SELECT e.seq::text,e.event,e.payload_bytes')) {
          const anchor = Number(values?.[1] ?? 0)
          const older = text.includes('seq < $2')
          const rows = allEvents
            .filter(row => older ? row.seq < anchor : row.seq >= anchor)
            .sort((left, right) => older ? right.seq - left.seq : left.seq - right.seq)
            .slice(0, Number(values?.[2] ?? 0))
            .map(row => ({ ...row, seq: String(row.seq) }))
          return { rows, rowCount: rows.length }
        }
        throw new Error(`unexpected query: ${text}`)
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    return { pool, calls, client }
  }

  it('uses a bounded keyset range and infers direction from a continuation cursor', async () => {
    const header = { ...headerRow, version: '7', next_seq: '5' }
    const rows = Array.from({ length: 5 }, (_, seq) => ({
      seq,
      event: { type: 'turn/start', seq, time: seq, data: { seq } },
      payload_bytes: 60,
    }))
    const fixture = pagePool(header, rows)
    const repository = new ConversationRepository(fixture.pool)

    const newer = await repository.readPage('session-1', { direction: 'newer', fromSeq: 0, maxEvents: 2 })
    expect(newer?.events.map(event => event.seq)).toEqual([0, 1])
    expect(fixture.calls.some(call => call.text.includes('ORDER BY e.seq ASC LIMIT $3'))).toBe(true)

    const tail = await repository.readPage('session-1', { maxEvents: 2 })
    expect(tail?.events.map(event => event.seq)).toEqual([3, 4])
    expect(tail?.hasMore).toBe(true)
    expect(tail?.nextCursor).toEqual(expect.any(String))
    const older = await repository.readPage('session-1', { cursor: tail?.nextCursor, maxEvents: 2 })
    expect(older?.events.map(event => event.seq)).toEqual([1, 2])
    const olderCalls = fixture.calls.filter(call => call.text.startsWith('SELECT e.seq::text,e.event,e.payload_bytes')
      && call.text.includes('WHERE e.session_id=$1 AND e.seq < $2'))
    expect(olderCalls.length).toBeGreaterThan(0)
    expect(fixture.calls.some(call => call.text.includes('ORDER BY e.seq DESC LIMIT $3'))).toBe(true)
  })

  it('keeps one model step in one page group instead of paging every stream chunk', async () => {
    const header = { ...headerRow, version: '7', next_seq: '5' }
    const rows = Array.from({ length: 5 }, (_, seq) => ({
      seq,
      event: {
        type: 'assistant/chunk',
        seq,
        time: seq,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: seq, text: 'x' } },
      },
      payload_bytes: 60,
    }))
    const fixture = pagePool(header, rows)
    const page = await new ConversationRepository(fixture.pool).readPage('session-1', {
      maxBytes: 10_000,
      maxEvents: 10,
      maxGroups: 1,
    })
    expect(page?.events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
    expect(page?.hasMore).toBe(false)
  })

  it('returns an empty page at either end without manufacturing a cursor', async () => {
    const header = { ...headerRow, version: '7', next_seq: '0' }
    const fixture = pagePool(header, [])
    const repository = new ConversationRepository(fixture.pool)
    await expect(repository.readPage('session-1', { direction: 'newer', fromSeq: 0 })).resolves.toMatchObject({
      events: [], startSeq: null, endSeq: null, hasMore: false,
    })
    await expect(repository.readPage('session-1', { beforeSeq: 0 })).resolves.toMatchObject({
      events: [], startSeq: null, endSeq: null, hasMore: false,
    })
  })

  it('rejects over-budget limits and an indivisible oversized event', async () => {
    const header = { ...headerRow, version: '7', next_seq: '1' }
    const fixture = pagePool(header, [{
      seq: 0,
      event: { type: 'turn/start', seq: 0, time: 0, data: { text: 'large' } },
      payload_bytes: 100,
    }])
    const repository = new ConversationRepository(fixture.pool)
    await expect(repository.readPage('session-1', { maxEvents: 2_001 }))
      .rejects.toMatchObject({ code: 'protocol' })
    await expect(repository.readPage('session-1', { maxBytes: 10 }))
      .rejects.toBeInstanceOf(ConversationPageTooLargeError)
    await expect(repository.readPage('session-1', { maxBytes: 10 }))
      .rejects.toMatchObject({ code: 'too-large', bytes: 100, limit: 10 })
  })

  it('invalidates a cursor when the source revision changes', async () => {
    const header = { ...headerRow, version: '7', next_seq: '2' }
    const rows = Array.from({ length: 2 }, (_, seq) => ({
      seq,
      event: { type: 'turn/start', seq, time: seq, data: { seq } },
      payload_bytes: 60,
    }))
    const fixture = pagePool(header, rows)
    const repository = new ConversationRepository(fixture.pool)
    const page = await repository.readPage('session-1', { maxEvents: 1 })
    // A foreign cursor is a caller fault; a moved log is the retryable category.
    const foreign = encodePageCursor({ version: 1, sessionId: 'session-2', revision: '7:2', direction: 'older', anchor: 1 })
    await expect(repository.readPage('session-1', { cursor: foreign })).rejects
      .toMatchObject({ code: 'protocol' })
    header.version = '8'
    await expect(repository.readPage('session-1', { cursor: page?.nextCursor })).rejects
      .toMatchObject({ code: 'dependency' })
  })

  it('fails closed when a bounded keyset query exposes a sequence gap', async () => {
    const header = { ...headerRow, version: '7', next_seq: '3' }
    const fixture = pagePool(header, [
      { seq: 0, event: { type: 'turn/start', seq: 0, time: 0, data: {} }, payload_bytes: 40 },
      { seq: 2, event: { type: 'turn/end', seq: 2, time: 2, data: {} }, payload_bytes: 40 },
    ])
    const repository = new ConversationRepository(fixture.pool)
    await expect(repository.readPage('session-1', { maxEvents: 2 })).rejects
      .toMatchObject({ code: 'protocol' })
  })
})

describe('ConversationRepository history index', () => {
  it('reads turn boundaries and bounded search previews without selecting event payloads', async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (text: string) => {
        calls.push(text)
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
          || text.startsWith('SET TRANSACTION')) return { rows: [], rowCount: null }
        if (text.startsWith('SELECT id,organization_id')) {
          return { rows: [{ ...headerRow, next_seq: '12', version: '9' }], rowCount: 1 }
        }
        if (text.startsWith('WITH raw AS')) {
          return {
            rows: [
              { start_seq: '0', end_seq: '5', turn: '1', ordinal: '0', total: '2' },
              { start_seq: '6', end_seq: '11', turn: '2', ordinal: '1', total: '2' },
            ],
            rowCount: 2,
          }
        }
        if (text.startsWith('SELECT event_seq::text,role')) {
          return {
            rows: [
              { event_seq: '1', role: 'user', content: '  first question  ', turn: '1' },
              { event_seq: '3', role: 'assistant', content: 'first answer', turn: '1' },
              { event_seq: '7', role: 'user', content: 'second question', turn: '2' },
              { event_seq: '9', role: 'assistant', content: 'second answer', turn: '2' },
            ],
            rowCount: 4,
          }
        }
        throw new Error(`unexpected query: ${text}`)
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool

    await expect(new ConversationRepository(pool).readHistoryIndex('session-1')).resolves.toEqual({
      revision: '9:12',
      asOfSeq: 11,
      totalTurns: 2,
      items: [
        { turn: 1, startSeq: 0, endSeq: 5, prompt: 'first question', response: 'first answer' },
        { turn: 2, startSeq: 6, endSeq: 11, prompt: 'second question', response: 'second answer' },
      ],
      truncated: false,
    })
    expect(calls.some(text => text.includes('SELECT e.seq::text,e.event FROM'))).toBe(false)
    expect(calls.some(text => text.startsWith('WITH raw AS'))).toBe(true)
    expect(calls.some(text => text.startsWith('SELECT event_seq::text,role'))).toBe(true)
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('samples deterministically when the requested marker budget is smaller than the turn count', async () => {
    const client = {
      query: vi.fn(async (text: string) => {
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK'
          || text.startsWith('SET TRANSACTION')) return { rows: [], rowCount: null }
        if (text.startsWith('SELECT id,organization_id')) {
          return { rows: [{ ...headerRow, next_seq: '30' }], rowCount: 1 }
        }
        if (text.startsWith('WITH raw AS')) {
          return {
            rows: [
              { start_seq: '0', end_seq: '9', turn: '1', ordinal: '0', total: '3' },
              { start_seq: '20', end_seq: '29', turn: '3', ordinal: '2', total: '3' },
            ],
            rowCount: 2,
          }
        }
        throw new Error(`unexpected query: ${text}`)
      }),
      release: vi.fn(),
    } as unknown as PoolClient
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool
    const result = await new ConversationRepository(pool).readHistoryIndex('session-1', 2)
    expect(result?.items.map(item => item.turn)).toEqual([1, 3])
    expect(result?.items[0]?.prompt).toBeUndefined()
    expect(result?.items[1]?.prompt).toBeUndefined()
    expect(result?.totalTurns).toBe(3)
    expect(result?.truncated).toBe(true)
  })
})
