/**
 * Conversation-tier omit: attempts superseded by a same-step append message
 * become omittedSpans; attempts without that message stay; missing detail
 * equals full.
 */

import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { HistoryEntry } from '../src/api/sessions.ts'
import { appendOriginGroupStart, applyHistoryDetail, clipOmittedSpans } from '../src/fetch/history-detail.ts'

function messageId(seq: number): ReturnType<typeof MessageId> {
  return MessageId(`00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`)
}

function user(seq: number): HistoryEntry {
  return {
    event: {
      type: 'user/message',
      seq: SessionSeq(seq),
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

function assistant(seq: number, step = 1): HistoryEntry {
  return {
    event: {
      type: 'assistant/message',
      seq: SessionSeq(seq),
      time: 1000 + seq,
      data: {
        stream: [],
        turn: 1,
        step,
        message: {
          id: messageId(seq),
          role: 'assistant',
          content: [{ type: 'text', text: 'a' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
      },
      surfaceOp: 'append',
    },
  }
}

function attempt(seq: number, step = 1): HistoryEntry {
  return {
    event: {
      type: 'assistant/attempt',
      seq: SessionSeq(seq),
      time: 1000 + seq,
      data: {
        turn: 1,
        step,
        stream: [{ type: 'chunk', time: 1000 + seq, chunk: { type: 'text-delta', index: 0, text: 'x' } }],
      },
    } satisfies SessionEvent,
  }
}

function tool(seq: number): HistoryEntry {
  return {
    event: {
      type: 'tool/call',
      seq: SessionSeq(seq),
      time: 1000 + seq,
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' },
    } as SessionEvent,
  }
}

describe('applyHistoryDetail', () => {
  it('treats missing detail and full as a no-op', () => {
    const events = [user(1), attempt(2), attempt(3), assistant(4)]
    expect(applyHistoryDetail(events, undefined)).toEqual({ events })
    expect(applyHistoryDetail(events, 'full')).toEqual({ events })
    expect(applyHistoryDetail(events, undefined).omittedSpans).toBeUndefined()
  })

  it('omits superseded attempts as one span and keeps the message', () => {
    const events = [user(1), attempt(2), attempt(3), attempt(4), assistant(5)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.seq)).toEqual([1, 5])
    expect(result.omittedSpans).toEqual([{ startSeq: 2, endSeq: 4 }])
  })

  it('keeps failed-step attempts that have no append-origin assistant/message', () => {
    const events = [user(1), assistant(2), user(3), attempt(4, 2), attempt(5, 2)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events).toEqual(events)
    expect(result.omittedSpans).toBeUndefined()
  })

  it('keeps the in-flight tail attempt without a completing message', () => {
    const events = [user(1), attempt(2), attempt(3), tool(4)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events).toEqual(events)
    expect(result.omittedSpans).toBeUndefined()
  })

  it('keeps attempts from other steps and splits spans around non-attempt events', () => {
    const summary: HistoryEntry = {
      event: {
        type: 'compaction/summary',
        seq: 5,
        time: 1005,
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
      attempt(2),
      attempt(3),
      assistant(4),
      summary,
      attempt(6, 2),
      attempt(7, 2),
      assistant(8, 2),
      tool(9),
    ]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.type)).toEqual([
      'user/message',
      'assistant/message',
      'compaction/summary',
      'assistant/message',
      'tool/call',
    ])
    expect(result.omittedSpans).toEqual([
      { startSeq: 2, endSeq: 3 },
      { startSeq: 6, endSeq: 7 },
    ])
  })

  it('passes unknown non-attempt types through', () => {
    const future: HistoryEntry = {
      event: { type: 'future/event', seq: 2, time: 1002, data: { future: true } } as unknown as SessionEvent,
    }
    const events = [user(1), future, attempt(3), assistant(4)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.seq)).toEqual([1, 2, 4])
    expect(result.omittedSpans).toEqual([{ startSeq: 3, endSeq: 3 }])
  })

  it('omits unknown assistant/attempt payloads under a completed message', () => {
    const weird: HistoryEntry = {
      event: {
        type: 'assistant/attempt',
        seq: 2,
        time: 1002,
        data: { turn: 1, step: 1, stream: [{ type: 'novel-record', payload: true }] },
      } as unknown as SessionEvent,
    }
    const events = [user(1), weird, assistant(3)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events.map(entry => entry.event.seq)).toEqual([1, 3])
    expect(result.omittedSpans).toEqual([{ startSeq: 2, endSeq: 2 }])
  })

  it('keeps an attempt when its completing message sits on another page', () => {
    const events = [user(1), attempt(2), tool(3)]
    const result = applyHistoryDetail(events, 'conversation')
    expect(result.events).toEqual(events)
    expect(result.omittedSpans).toBeUndefined()
  })
})

describe('appendOriginGroupStart', () => {
  it('ignores citations that do not precede the message', () => {
    const message = assistant(4)
    message.event.sourceEventSeqs = [SessionSeq(2), SessionSeq(9)]
    const entries = [user(1), attempt(2), attempt(3), message]
    expect(appendOriginGroupStart(entries, 3)).toBe(2)
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
