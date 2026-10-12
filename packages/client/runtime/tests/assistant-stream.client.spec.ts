/**
 * ClientAssistantStream fold: baseline adoption, dense-index continuity, staged
 * durable settlements, committed/abandoned end release, and rebaseline requests.
 * Session-level mux plumbing is covered in session.client.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { SessionAssistantStreamBaseline, SessionAssistantStreamFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ClientAssistantStream } from '../src/client/sessions/assistant-stream.ts'
import { ev } from './event-script.client.ts'

const ATTEMPT = LlmAttemptId('att-1')

const start = (attemptId: string, startedAfterSeq: number, turn = 1, step = 0): SessionAssistantStreamFrame =>
  ({ type: 'start', attemptId: LlmAttemptId(attemptId), revision: 1, startedAfterSeq, turn, step })

const chunk = (attemptId: string, index: number, text: string): SessionAssistantStreamFrame =>
  ({
    type: 'chunk', attemptId: LlmAttemptId(attemptId), revision: 1, index,
    time: 1_700_100_000_000 + index,
    chunk: { type: 'text-delta', index: 0, text },
  })

const endCommitted = (
  attemptId: string,
  index: number,
  seq: number,
  eventType: 'assistant/message' | 'assistant/attempt' = 'assistant/message',
): SessionAssistantStreamFrame =>
  ({ type: 'end', attemptId: LlmAttemptId(attemptId), revision: 1, index, outcome: { kind: 'committed', eventType, seq } })

const endAbandoned = (attemptId: string, index: number): SessionAssistantStreamFrame =>
  ({ type: 'end', attemptId: LlmAttemptId(attemptId), revision: 1, index, outcome: { kind: 'abandoned' } })

const chunkRecord = (text: string, index = 0): AssistantStreamRecord =>
  ({ type: 'chunk', time: 1_700_100_000_000 + index, chunk: { type: 'text-delta', index: 0, text } })

const baseline = (over: Partial<NonNullable<SessionAssistantStreamBaseline['activeAttempt']>> = {}): SessionAssistantStreamBaseline => ({
  revision: 1,
  activeAttempt: {
    attemptId: ATTEMPT,
    startedAfterSeq: 5,
    turn: 1,
    step: 0,
    nextIndex: 2,
    stream: [chunkRecord('你', 0), chunkRecord('好', 1)],
    ...over,
  },
})

describe('ClientAssistantStream', () => {
  it('rebuilds the durable window and expands the baseline attempt into ordered transients', () => {
    const fold = new ClientAssistantStream()
    const durable = [ev.turnStart(0, 0), ev.user(1, '问'), ev.stepStart(2, 0), ev.assistant(3, 0, '答'), ev.stepEnd(4, 0), ev.turnEnd(5, 0)]
    const visible = fold.replace(durable, baseline())
    expect(visible).toHaveLength(8)
    const tail = visible.slice(6)
    expect(tail.map(entry => entry.event.type)).toEqual(['assistant/live-chunk', 'assistant/live-chunk'])
    const [first, second] = tail.map(entry => entry.event.seq)
    expect(first).toBeCloseTo(5.5)
    expect(second).toBeCloseTo(5.6667, 3)
    expect(tail[0]!.event).toMatchObject({ data: { attemptId: ATTEMPT, turn: 1, step: 0 } })
  })

  it('publishes live chunks as transients in arrival order', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    expect(fold.acceptFrame(start('att-1', 5))).toBeUndefined()
    const first = fold.acceptFrame(chunk('att-1', 0, '你'))
    const second = fold.acceptFrame(chunk('att-1', 1, '好'))
    expect(first?.type).toBe('transient')
    expect(second?.type).toBe('transient')
    if (first?.type === 'transient' && second?.type === 'transient') {
      expect(second.entry.event.seq).toBeGreaterThan(first.entry.event.seq)
    }
  })

  it('publishes a committed message at stream end and retires its chunks at its Step end', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5, 1, 1))
    fold.acceptFrame(chunk('att-1', 0, '你'))
    fold.acceptFrame(chunk('att-1', 1, '好'))
    const message = ev.assistant(6, 1, '你好', 1)
    expect(fold.acceptDurable(message)).toBeUndefined()
    expect(fold.acceptFrame(endCommitted('att-1', 2, 6))).toEqual({ type: 'publish', entry: { event: message } })
    for (const [turn, step] of [[2, 1], [1, 2]] as const) {
      expect(fold.acceptDurable(ev.stepEnd(7, turn, step))).toEqual({ type: 'publish', entry: { event: ev.stepEnd(7, turn, step) } })
    }
    const closed = ev.stepEnd(8, 1, 1)
    expect(fold.acceptDurable(closed)).toEqual({ type: 'publish', entry: { event: closed }, retireAttemptId: ATTEMPT })
    const followUp = ev.user(9, '续')
    expect(fold.acceptDurable(followUp)).toEqual({ type: 'publish', entry: { event: followUp } })
    expect(fold.acceptFrame(start('att-2', 8))).toBeUndefined()
  })

  it('clears retained chunks on window install and refuses a new attempt before Step completion', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5, 1, 1))
    const staged = ev.assistant(6, 1, '半', 1)
    fold.acceptDurable(staged)
    expect(fold.acceptFrame(endCommitted('att-1', 0, 6))).toEqual({ type: 'publish', entry: { event: staged } })
    expect(fold.acceptFrame(start('att-2', 6))).toEqual({ type: 'rebaseline' })
    const installed = [ev.turnEnd(5, 0), ev.assistant(6, 1, '整', 1)]
    expect(fold.replace(installed)).toEqual(installed.map(event => ({ event })))
    const closed = ev.stepEnd(7, 1, 1)
    expect(fold.acceptDurable(closed)).toEqual({ type: 'publish', entry: { event: closed } })
    expect(fold.acceptFrame(start('att-2', 7))).toBeUndefined()
  })

  it('retires interrupted messages and attempts at stream end', () => {
    const message = ev.assistant(6, 1, '断', 1)
    if (message.type !== 'assistant/message') throw new Error('expected assistant message')
    const interrupted = { ...message, data: { ...message.data, interrupted: true as const } }
    for (const durable of [ev.attempt(6, 1, 1), interrupted]) {
      const fold = new ClientAssistantStream()
      fold.replace([ev.turnEnd(5, 0)])
      fold.acceptFrame(start('att-1', 5, 1, 1))
      fold.acceptFrame(chunk('att-1', 0, '半'))
      expect(fold.acceptDurable(durable)).toBeUndefined()
      const released = fold.acceptFrame(endCommitted('att-1', 1, 6,
        durable.type === 'assistant/message' ? 'assistant/message' : 'assistant/attempt'))
      expect(released?.type).toBe('settlement')
      if (released?.type === 'settlement') expect(released.attemptId).toBe(ATTEMPT)
    }
  })

  it('abandons the attempt when the end carries no settlement', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5))
    fold.acceptFrame(chunk('att-1', 0, '作废'))
    expect(fold.acceptFrame(endAbandoned('att-1', 1))).toEqual({ type: 'abandonment', attemptId: ATTEMPT })
  })

  it('requests a rebaseline when a chunk index skips', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5))
    fold.acceptFrame(chunk('att-1', 0, '连'))
    expect(fold.acceptFrame(chunk('att-1', 3, '断'))).toEqual({ type: 'rebaseline' })
  })

  it('requests a rebaseline when the committed settlement was never staged', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5))
    fold.acceptFrame(chunk('att-1', 0, '你'))
    expect(fold.acceptFrame(endCommitted('att-1', 1, 9))).toEqual({ type: 'rebaseline' })
  })

  it('requests a rebaseline when the staged event type disagrees with the outcome', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5))
    fold.acceptFrame(chunk('att-1', 0, '你'))
    fold.acceptDurable(ev.attempt(6, 1))
    expect(fold.acceptFrame(endCommitted('att-1', 1, 6, 'assistant/message'))).toEqual({ type: 'rebaseline' })
  })

  it('requests a rebaseline when a start arrives while another attempt is open', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5))
    expect(fold.acceptFrame(start('att-2', 5))).toEqual({ type: 'rebaseline' })
  })

  it('publishes a settlement outright when no attempt is live', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    const message = ev.assistant(6, 1, '直接')
    expect(fold.acceptDurable(message)).toEqual({ type: 'publish', entry: { event: message } })
  })

  it('publishes a replace-surface message instead of staging it', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5))
    const replacing = {
      seq: 6, time: 1_700_000_000_006, type: 'assistant/message',
      surfaceOp: { op: 'replace', startSeq: 4, endSeq: 5 },
      data: { turn: 1, step: 0, stream: [], message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'f', model: 'm' } } },
    } as unknown as SessionEvent
    expect(fold.acceptDurable(replacing)?.type).toBe('publish')
  })

  it('ignores frames naming an unknown attempt', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    expect(fold.acceptFrame(chunk('att-x', 0, '影'))).toBeUndefined()
    expect(fold.acceptFrame(endCommitted('att-x', 1, 6))).toBeUndefined()
  })

  it('resets staged state on the next window install', () => {
    const fold = new ClientAssistantStream()
    fold.replace([ev.turnEnd(5, 0)])
    fold.acceptFrame(start('att-1', 5))
    fold.acceptFrame(chunk('att-1', 0, '半'))
    fold.acceptDurable(ev.assistant(6, 1, '半'))
    fold.replace([ev.turnEnd(5, 0), ev.assistant(6, 1, '整')])
    expect(fold.acceptFrame(endCommitted('att-1', 1, 6))).toBeUndefined()
  })
})
