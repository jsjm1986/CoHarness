import { describe, expect, it } from 'vitest'
import type { Agent, AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  AssistantStreamRegistry,
  SessionAssistantStreamAccumulator,
  streamDurableCursor,
  wireStreamFrame,
} from '../src/assistant-stream.ts'

const attemptId = (id = 'a-1') => id as LlmAttemptId

const start = (revision = 1, id = attemptId()): AssistantStreamFrame => (
  { type: 'start', attemptId: id, revision, turn: 1, step: 1 }
)
const chunk = (revision: number, index: number, id = attemptId()): AssistantStreamFrame => (
  { type: 'chunk', attemptId: id, revision, index, time: index, chunk: { type: 'text-delta', index: 0, text: 'x' } }
)
const end = (revision: number, index: number, id = attemptId()): AssistantStreamFrame => (
  { type: 'end', attemptId: id, revision, index, outcome: { kind: 'abandoned' } }
)

describe('SessionAssistantStreamAccumulator', () => {
  it('folds start/chunk/end frames into a materialized baseline', () => {
    const acc = new SessionAssistantStreamAccumulator()
    acc.accept(start(), 3 as never)
    acc.accept(chunk(2, 0), 4 as never)
    const baseline = acc.snapshot()
    expect(baseline.revision).toBe(2)
    expect(baseline.activeAttempt).toMatchObject({ attemptId: 'a-1', startedAfterSeq: 3, turn: 1, step: 1, nextIndex: 1 })
    expect(acc.snapshot()).toBe(baseline)

    acc.accept(end(3, 1), 5 as never)
    expect(acc.snapshot().activeAttempt).toBeUndefined()
    expect(acc.snapshot().revision).toBe(3)
  })

  it('resets on a revision-1 restart and on a skipped revision', () => {
    const acc = new SessionAssistantStreamAccumulator()
    acc.accept(start(), 0 as never)
    acc.accept(chunk(2, 0), 0 as never)

    acc.accept(start(1, attemptId('b')), 0 as never)
    expect(acc.snapshot()).toMatchObject({ revision: 1, activeAttempt: { attemptId: 'b', nextIndex: 0 } })

    acc.accept(chunk(9, 0, attemptId('b')), 0 as never)
    const jumped = acc.snapshot()
    expect(jumped.revision).toBe(9)
    expect(jumped.activeAttempt).toBeUndefined()
  })

  it('abandons the open attempt on a foreign or out-of-order chunk', () => {
    const acc = new SessionAssistantStreamAccumulator()
    acc.accept(start(), 0 as never)
    acc.accept(chunk(2, 0, attemptId('other')), 0 as never)
    expect(acc.snapshot().activeAttempt).toBeUndefined()

    const skipped = new SessionAssistantStreamAccumulator()
    skipped.accept(start(), 0 as never)
    skipped.accept(chunk(2, 7), 0 as never)
    expect(skipped.snapshot().activeAttempt).toBeUndefined()

    const closed = new SessionAssistantStreamAccumulator()
    closed.accept(start(), 0 as never)
    closed.accept(end(2, 0), 0 as never)
    closed.accept(chunk(3, 0), 0 as never)
    expect(closed.snapshot().activeAttempt).toBeUndefined()
  })
})

describe('AssistantStreamRegistry', () => {
  const agent = (sessionId: string, seq: number) => (
    { session: { id: sessionId as SessionId, seq } } as unknown as Agent
  )

  it('tracks per-session ordinals and baselines across lifecycles', () => {
    const registry = new AssistantStreamRegistry()
    expect(registry.snapshot('missing' as SessionId)).toEqual({ baseline: { revision: 0 }, ordinal: 0 })

    const one = agent('s-1', 5)
    expect(registry.accept(one, start())).toBe(1)
    expect(registry.accept(one, chunk(2, 0))).toBe(2)
    expect(registry.accept(agent('s-2', 0), start())).toBe(1)

    const snap = registry.snapshot('s-1' as SessionId)
    expect(snap.ordinal).toBe(2)
    expect(snap.baseline).toMatchObject({ revision: 2, activeAttempt: { startedAfterSeq: 4 } })

    registry.forget('s-1' as SessionId)
    expect(registry.snapshot('s-1' as SessionId)).toEqual({ baseline: { revision: 0 }, ordinal: 0 })
  })
})

describe('stream frame wiring', () => {
  it('stamps the durable cursor on start frames and passes chunk/end through', () => {
    const started = wireStreamFrame(start(), 4 as never)
    expect(started).toMatchObject({ type: 'start', startedAfterSeq: 4 })
    expect(wireStreamFrame(end(2, 1), 4 as never)).toMatchObject({ type: 'end', outcome: { kind: 'abandoned' } })
    expect(wireStreamFrame(chunk(2, 0), 4 as never)).toMatchObject({ type: 'chunk', chunk: { type: 'text-delta' } })
  })

  it('reads the durable cursor as the last committed seq or -1 on an empty log', () => {
    expect(streamDurableCursor({ seq: 0 } as Session)).toBe(-1)
    expect(streamDurableCursor({ seq: 5 } as Session)).toBe(4)
  })
})
