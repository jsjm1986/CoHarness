/**
 * Conversation-tier omit: completed chunk runs become omittedSpans; in-flight
 * and interrupted-without-message chunks stay; missing detail equals full.
 */

import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { HistoryEntry } from '../src/api/sessions.ts'
import { applyHistoryDetail, clipOmittedSpans } from '../src/fetch/history-detail.ts'

function messageId(seq: number): ReturnType<typeof MessageId> {
  return MessageId(`00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`)
}

function user(seq: number): HistoryEntry {
  return {
    event: {
      type: 'user/message',
      seq,
      time: 1000 + seq,
      data: {
        id: messageId(seq),
        role: 'user',
        content: [{ type: 'text', text: 'q' }],
        source: { kind: 'user' },
      },
      surfaceOp: 'append',
    },
  }
}

function assistant(seq: number, sourceEventSeqs: number[]): HistoryEntry {
  return {
    event: {
      type: 'assistant/message',
      seq,
      time: 1000 + seq,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: messageId(seq),
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      surfaceOp: 'append',
      sourceEventSeqs,
    },
  }
}

function chunk(seq: number, text = 'x'): HistoryEntry {
  return {
    event: {
      type: 'assistant/chunk',
      seq,
      time: 1000 + seq,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
    } satisfies SessionEvent,
  }
}

function tool(seq: number): HistoryEntry {
  return {
    event: {
      type: 'tool/call',
      seq,
      time: 1000 + seq,
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
    } as SessionEvent,
  }
}

describe('applyHistoryDetail', () => {
  it('treats missing detail and full as a no-op', () => {
    const events = [user(1), chunk(2), chunk(3), assistant(4, [2, 3])]
    expect(applyHistoryDetail(events, undefined)).toEqual({ events })
    expect(applyHistoryDetail(events, 'full')).toEqual({ events })
    expect(applyHistoryDetail(events, undefined).omittedSpans).toBeUndefined()
  })

  it('omits completed long-stream chunks as one span and keeps the message', () => {
    const events = [user(1), chunk(2), chunk(3), chunk(4), assistant(5, [2, 3, 4])]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.seq)).toEqual([1, 5])
    expect(result.omittedSpans).toEqual([{ startSeq: 2, endSeq: 4 }])
  })

  it('keeps in-flight chunks that have no append-origin assistant/message', () => {
    const events = [user(1), assistant(2, []), user(3), chunk(4), chunk(5)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events).toEqual(events)
    expect(result.omittedSpans).toBeUndefined()
  })

  it('keeps interrupted chunks when no assistant/message finalized the group', () => {
    const events = [user(1), chunk(2), chunk(3), tool(4)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events).toEqual(events)
    expect(result.omittedSpans).toBeUndefined()
  })

  it('keeps compaction, tool, and user events and splits spans around them', () => {
    const summary: HistoryEntry = {
      event: {
        type: 'compaction/summary',
        seq: 4,
        time: 1004,
        data: {
          compactionId: 'c1',
          summary: [{ type: 'text', text: 's' }],
          shadowedRange: { start: 1, end: 2 },
          shadowedSeqs: [1, 2],
          shadowedTokenCount: 1,
          provider: 'p',
          model: 'm',
        },
      } as SessionEvent,
    }
    const events = [
      user(1),
      chunk(2),
      chunk(3),
      summary,
      chunk(5),
      chunk(6),
      assistant(7, [2, 3, 5, 6]),
      tool(8),
    ]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.type)).toEqual([
      'user/message',
      'compaction/summary',
      'assistant/message',
      'tool/call',
    ])
    expect(result.omittedSpans).toEqual([
      { startSeq: 2, endSeq: 3 },
      { startSeq: 5, endSeq: 6 },
    ])
  })

  it('passes unknown non-chunk types through', () => {
    const future: HistoryEntry = {
      event: { type: 'future/event', seq: 3, time: 1003, data: { future: true } } as SessionEvent,
    }
    const events = [user(1), chunk(2), future, assistant(4, [2])]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.seq)).toEqual([1, 3, 4])
    expect(result.omittedSpans).toEqual([{ startSeq: 2, endSeq: 2 }])
  })

  it('omits unknown assistant/chunk payloads under a completed message', () => {
    const weird: HistoryEntry = {
      event: {
        type: 'assistant/chunk',
        seq: 2,
        time: 1002,
        data: { turn: 1, step: 1, chunk: { type: 'novel-delta', payload: true } },
      } as SessionEvent,
    }
    const events = [user(1), weird, assistant(3, [2])]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.seq)).toEqual([1, 3])
    expect(result.omittedSpans).toEqual([{ startSeq: 2, endSeq: 2 }])
  })
})

describe('clipOmittedSpans', () => {
  it('drops spans wholly before the suffix and clips a straddling span', () => {
    expect(clipOmittedSpans(
      [{ startSeq: 1, endSeq: 4 }, { startSeq: 8, endSeq: 12 }],
      10,
    )).toEqual([{ startSeq: 10, endSeq: 12 }])
    expect(clipOmittedSpans([{ startSeq: 1, endSeq: 4 }], 5)).toBeUndefined()
    expect(clipOmittedSpans(undefined, 1)).toBeUndefined()
    expect(clipOmittedSpans([], 1)).toBeUndefined()
  })
})
