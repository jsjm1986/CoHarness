/**
 * Physical history-record codec: packed chunk runs, complete-envelope UTF-8
 * byte targeting at append-origin message boundaries, and lossless expansion.
 */

import { describe, expect, it } from 'vitest'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { RpcId } from '../src/api/rpc.ts'
import type { Wire } from '../src/api/rpc.schema.ts'
import type { HistoryEntry, SessionProjectionsBlock } from '../src/api/sessions.ts'
import type { ToolEventView } from '../src/api/events.ts'
import type { ResponseValue } from '../src/api/rpc-map.ts'
import {
  DEFAULT_HISTORY_PAGE_TARGET_BYTES,
  encodeHistoryServerResponse,
  historyWireValueSchema,
} from '../src/fetch/history-wire.ts'

type HistoryValue = ResponseValue<'session.history'>

const RPC = RpcId('r1')

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function messageId(seq: number): ReturnType<typeof MessageId> {
  return MessageId(`00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`)
}

function userEntry(seq: number, time: number, text: string): HistoryEntry {
  return {
    event: {
      type: 'user/message',
      seq,
      time,
      data: {
        id: messageId(seq),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
  }
}

function assistantEntry(
  seq: number,
  time: number,
  text: string,
  sourceEventSeqs: number[],
  usage?: { inputTokens: number; outputTokens: number },
): HistoryEntry {
  return {
    event: {
      type: 'assistant/message',
      seq,
      time,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: messageId(seq),
          role: 'assistant',
          content: [{ type: 'text', text }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        ...usage === undefined ? {} : { usage },
      },
      surfaceOp: 'append',
      sourceEventSeqs,
    },
  }
}

function retryEntry(seq: number, time: number): HistoryEntry {
  return {
    event: {
      type: 'llm/retry',
      seq,
      time,
      data: {
        retryId: 'retry-1',
        turn: 1,
        step: 1,
        provider: 'p',
        mode: 'normal',
        policyKey: 'default',
        retry: 1,
        maxRetries: 3,
        delayMs: 10,
        failure: { message: 'timeout', code: 'timeout' },
      },
    } as SessionEvent,
  }
}

function summaryEntry(seq: number, time: number, text: string, shadowedSeqs: number[]): HistoryEntry {
  return {
    event: {
      type: 'compaction/summary',
      seq,
      time,
      data: {
        compactionId: 'compact-1',
        summary: [{ type: 'text', text }],
        shadowedRange: { start: shadowedSeqs[0] ?? seq, end: shadowedSeqs.at(-1) ?? seq },
        shadowedSeqs,
        shadowedTokenCount: 4,
        provider: 'p',
        model: 'm',
      },
    } as SessionEvent,
  }
}

function requireEvents(decoded: Wire<HistoryValue>): HistoryEntry[] {
  if (decoded.events === undefined) throw new Error('decoded history omitted events')
  return decoded.events as HistoryEntry[]
}

function textDeltaEntries(seq0: number, time0: number, texts: readonly string[]): HistoryEntry[] {
  return texts.map((text, k) => ({
    event: {
      type: 'assistant/chunk',
      seq: seq0 + k,
      time: time0 + 10 * k,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
    } satisfies SessionEvent,
  }))
}

function roundTrip(value: HistoryValue, targetBytes: number) {
  const encoded = encodeHistoryServerResponse(RPC, value, targetBytes)
  expect(encoded.type).toBe('server-response')
  expect(encoded.rpcId).toBe(RPC)
  expect(encoded.result.ok).toBe(true)
  if (!encoded.result.ok) throw new Error('unreachable')
  const wire = JSON.parse(JSON.stringify(encoded.result.value)) as unknown
  expect(wire).not.toHaveProperty('events')
  expect(wire).toHaveProperty('records')
  const decoded = historyWireValueSchema.parse(encoded.result.ok ? encoded.result.value : undefined)
  const decodedFromJson = historyWireValueSchema.parse(wire)
  expect(decodedFromJson).toStrictEqual(decoded)
  return { encoded, decoded, wire }
}

function conversation(): HistoryValue {
  const unicodeTexts = ['你', '好', '🙂', '世界'] as const
  const toolView: ToolEventView = { for: 'call', view: { card: 'terminal', title: 'ls' } }
  const projections: SessionProjectionsBlock = {
    asOfSeq: 20,
    values: { sessionListMetadata: { blank: false, lastPromptAt: 1000 } },
  }
  const events: HistoryEntry[] = [
    { event: { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } } },
    userEntry(1, 1010, 'first prompt'),
    ...textDeltaEntries(2, 1020, unicodeTexts),
    assistantEntry(6, 1060, '你好🙂世界', [2, 3, 4, 5], { inputTokens: 8, outputTokens: 4 }),
    {
      event: {
        type: 'tool/call',
        seq: 7,
        time: 1070,
        data: { turn: 1, step: 1, callId: CallId('c-term'), name: 'term', arguments: '{"cmd":"ls"}' },
      },
      view: toolView,
    },
    retryEntry(8, 1080),
    summaryEntry(9, 1090, 'summary', [1, 6]),
    {
      event: {
        type: 'user/message',
        seq: 10,
        time: 1100,
        data: {
          id: messageId(10),
          role: 'user',
          content: [{ type: 'text', text: '<context_checkpoint>summary</context_checkpoint>' }],
          source: { kind: 'plugin', plugin: 'compact' },
        },
        surfaceOp: { op: 'replace', start: 1, end: 6 },
        sourceEventSeqs: [1, 6, 9],
      },
    },
    userEntry(11, 1110, 'second prompt'),
    assistantEntry(12, 1120, 'second reply', []),
    userEntry(13, 1130, 'third prompt'),
    {
      event: {
        type: 'turn/end',
        seq: 14,
        time: 1140,
        data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      },
    },
    ...textDeltaEntries(15, 1150, ['in', '-', 'flight']),
  ]
  return { events, hasMore: false, projections }
}

describe('history wire codec', () => {
  it('exposes the 128 KiB default complete-response target', () => {
    expect(DEFAULT_HISTORY_PAGE_TARGET_BYTES).toBe(128 * 1024)
  })

  it('round-trips logical events, views, projections, usage, retry, compaction, and the in-flight tail', () => {
    const value = conversation()
    const { encoded, decoded, wire } = roundTrip(value, DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    expect(decoded.events).toStrictEqual(value.events)
    expect(decoded.projections).toStrictEqual(value.projections)
    expect(decoded.hasMore).toBe(false)
    expect(decoded.omittedSpans).toBeUndefined()
    const records = (wire as { records: Array<{ chunks?: unknown }> }).records
    expect(records.some(record => record.chunks !== undefined)).toBe(true)
    expect(utf8Bytes(encoded)).toBe(new TextEncoder().encode(JSON.stringify(encoded)).byteLength)
  })

  it('keeps the larger page at an exact UTF-8 byte fit and selects the next complete-message suffix one byte below', () => {
    const value: HistoryValue = {
      events: [
        userEntry(0, 1000, 'alpha'),
        assistantEntry(1, 1010, 'one', []),
        userEntry(2, 1020, 'beta'),
        assistantEntry(3, 1030, 'two', []),
        userEntry(4, 1040, 'gamma'),
        assistantEntry(5, 1050, 'three', []),
      ],
      hasMore: false,
    }
    const full = encodeHistoryServerResponse(RPC, value, DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    const fullBytes = utf8Bytes(full)
    const exact = encodeHistoryServerResponse(RPC, value, fullBytes)
    expect(utf8Bytes(exact)).toBe(fullBytes)
    const exactDecoded = requireEvents(historyWireValueSchema.parse(exact.result.ok ? exact.result.value : undefined))
    expect(exactDecoded).toStrictEqual(value.events)

    const reduced = encodeHistoryServerResponse(RPC, value, fullBytes - 1)
    const reducedDecoded = historyWireValueSchema.parse(reduced.result.ok ? reduced.result.value : undefined)
    const reducedEvents = requireEvents(reducedDecoded)
    expect(utf8Bytes(reduced)).toBeLessThanOrEqual(fullBytes - 1)
    expect(reducedEvents.length).toBeLessThan(value.events.length)
    expect(reducedEvents).toStrictEqual(
      value.events.filter(entry => entry.event.seq >= reducedEvents[0]!.event.seq),
    )
    expect(reducedDecoded.hasMore).toBe(true)
    expect(reducedDecoded.projections).toStrictEqual(value.projections)
    expect(reducedEvents.some(entry => entry.event.type === 'user/message' || entry.event.type === 'assistant/message')).toBe(true)
  })

  it('returns an oversized single append-origin group whole with hasMore true', () => {
    const texts = Array.from({ length: 8 }, (_, i) => `token-${i}-${'你'.repeat(20)}`)
    const value: HistoryValue = {
      events: [
        userEntry(0, 1000, 'older'),
        ...textDeltaEntries(1, 1010, texts),
        assistantEntry(9, 1100, texts.join(''), [1, 2, 3, 4, 5, 6, 7, 8]),
      ],
      hasMore: false,
    }
    const { decoded } = roundTrip(value, 1)
    expect(decoded.events).toStrictEqual(value.events.filter(entry => entry.event.seq >= 1))
    expect(decoded.hasMore).toBe(true)
  })

  it('leaves an event-only page whole', () => {
    const value: HistoryValue = {
      events: [
        { event: { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } } },
        retryEntry(1, 2),
        {
          event: {
            type: 'turn/end',
            seq: 2,
            time: 3,
            data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
          },
        },
      ],
      hasMore: false,
    }
    const { decoded, encoded } = roundTrip(value, 1)
    expect(decoded.events).toStrictEqual(value.events)
    expect(decoded.hasMore).toBe(false)
    expect(utf8Bytes(encoded)).toBeGreaterThan(1)
  })

  it('rejects a malformed packed record before expanding events', () => {
    expect(() => historyWireValueSchema.parse({
      records: [{ chunks: { type: 'text-chunks' } }],
      hasMore: false,
    })).toThrow(/malformed text-chunks storage row/)
    expect(() => historyWireValueSchema.parse({
      records: [null],
      hasMore: false,
    })).toThrow(/history wire record must be an object/)
  })

  it('prefers the larger complete-message suffix when several suffixes fit', () => {
    const value: HistoryValue = {
      events: [
        userEntry(0, 1000, 'alpha'),
        assistantEntry(1, 1010, 'one', []),
        userEntry(2, 1020, 'beta'),
        assistantEntry(3, 1030, 'two', []),
        userEntry(4, 1040, 'gamma'),
        assistantEntry(5, 1050, 'three', []),
      ],
      hasMore: false,
    }
    const twoGroup = encodeHistoryServerResponse(RPC, {
      events: value.events.filter(entry => entry.event.seq >= 2),
      hasMore: true,
    }, DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    const picked = encodeHistoryServerResponse(RPC, value, utf8Bytes(twoGroup))
    const events = requireEvents(historyWireValueSchema.parse(picked.result.ok ? picked.result.value : undefined))
    expect(events.map(entry => entry.event.seq)).toEqual([2, 3, 4, 5])
  })

  it('keeps a complete suffix when append group starts are non-monotonic', () => {
    const value: HistoryValue = {
      events: [
        { event: { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } } },
        summaryEntry(1, 1010, '你'.repeat(400), [1]),
        userEntry(2, 1020, 'first'),
        userEntry(5, 1050, 'second'),
        assistantEntry(6, 1060, 'cites seq 1', [1]),
      ],
      hasMore: false,
    }
    expect(value.events.filter(entry => entry.event.type === 'user/message' || entry.event.type === 'assistant/message')
      .map((entry) => {
        const sources = (entry.event as SessionEvent & { sourceEventSeqs?: number[] }).sourceEventSeqs
        return sources !== undefined && sources.length > 0 ? Math.min(entry.event.seq, ...sources) : entry.event.seq
      })).toStrictEqual([2, 5, 1])

    const severed = {
      events: value.events.filter(entry => entry.event.seq >= 5),
      hasMore: true,
    }
    const severedBytes = utf8Bytes(encodeHistoryServerResponse(RPC, severed, DEFAULT_HISTORY_PAGE_TARGET_BYTES))
    const { decoded } = roundTrip(value, severedBytes)
    const events = requireEvents(decoded)
    expect(events.some(entry => entry.event.seq === 1)).toBe(true)
    expect(events.some(entry => entry.event.seq === 6)).toBe(true)
    expect(events).toStrictEqual(value.events.filter(entry => entry.event.seq >= events[0]!.event.seq))
    expect(events[0]!.event.seq).toBe(1)
    expect(decoded.hasMore).toBe(true)
  })

  it('rejects mixed packed records that carry event or view beside chunks', () => {
    const packed = encodeHistoryServerResponse(RPC, {
      events: textDeltaEntries(0, 1000, ['a', 'b', 'c']),
      hasMore: false,
    }, DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    if (!packed.result.ok) throw new Error('unreachable')
    const records = (JSON.parse(JSON.stringify(packed.result.value)) as { records: Array<{ chunks?: unknown }> }).records
    const row = records.find(record => record.chunks !== undefined)
    expect(row?.chunks).toBeDefined()
    const view = { for: 'call' as const, view: { card: 'generic', title: 'x' } }
    expect(() => historyWireValueSchema.parse({
      records: [{ chunks: row!.chunks, event: userEntry(9, 1, 'extra').event }],
      hasMore: false,
    })).toThrow()
    expect(() => historyWireValueSchema.parse({
      records: [{ chunks: row!.chunks, view }],
      hasMore: false,
    })).toThrow()
  })

  it('passes unknown chunk fields through as ordinary events', () => {
    const extra: HistoryEntry = {
      event: {
        type: 'assistant/chunk',
        seq: 0,
        time: 1,
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'x', extra: true } },
      } as SessionEvent,
    }
    const value: HistoryValue = { events: [userEntry(1, 2, 'hi'), extra], hasMore: false }
    const { decoded, wire } = roundTrip(value, DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    expect(decoded.events).toStrictEqual(value.events)
    const records = (wire as { records: Array<{ chunks?: unknown; event?: SessionEvent }> }).records
    expect(records.some(record => record.chunks !== undefined)).toBe(false)
    expect(records.some(record => record.event?.data !== undefined
      && (record.event.data as { chunk?: { extra?: unknown } }).chunk?.extra === true)).toBe(true)
  })

  it('round-trips omittedSpans and clips them to a byte-target suffix', () => {
    const value: HistoryValue = {
      events: [
        userEntry(0, 1000, 'older'),
        assistantEntry(1, 1010, 'kept', []),
        userEntry(10, 1100, 'newer'),
        assistantEntry(11, 1110, 'tail', []),
      ],
      hasMore: false,
      omittedSpans: [
        { startSeq: 2, endSeq: 9 },
        { startSeq: 12, endSeq: 20 },
      ],
    }
    const { decoded } = roundTrip(value, DEFAULT_HISTORY_PAGE_TARGET_BYTES)
    expect(decoded.omittedSpans).toEqual(value.omittedSpans)
    expect(decoded.events).toStrictEqual(value.events)

    const reduced = encodeHistoryServerResponse(RPC, value, 1)
    const reducedDecoded = historyWireValueSchema.parse(reduced.result.ok ? reduced.result.value : undefined)
    expect(reducedDecoded.hasMore).toBe(true)
    const firstSeq = requireEvents(reducedDecoded)[0]!.event.seq
    expect(firstSeq).toBeGreaterThan(0)
    expect(reducedDecoded.omittedSpans).toEqual([{ startSeq: 12, endSeq: 20 }])
    expect(12).toBeGreaterThanOrEqual(firstSeq)
  })
})
