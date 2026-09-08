import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { inboxProjectionDefinition as projection } from '../src/inbox-projection.ts'

const header = { version: 2, id: SessionId('inbox-projection'), createdAt: 1, isSeeded: false }
const message = createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
const splice = (start = 0, removedCount = 0): SessionEvent => ({
  type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
  data: { target: 'next-turn', start, removedCount, inserted: [message] },
})

describe('cold inbox projection', () => {
  it('ignores inherited inbox and unrelated events without allocating replacement state', () => {
    const state = projection.init(header, SessionLogOffset(1))
    expect(projection.apply(state, splice())).toBe(state)
    expect(projection.apply(state, { type: 'turn/start', seq: SessionSeq(1), time: 1, data: { turn: 1 } })).toBe(state)
  })

  it.each([[-1, 0], [1, 0], [0, 1], [0.5, 0], [0, -1], [0, 0.5]])('rejects an invalid persisted range %s/%s', (start, removedCount) => {
    expect(() => projection.apply(projection.init(header, SessionLogOffset(0)), splice(start, removedCount)))
      .toThrow('invalid persisted inbox splice range')
  })

  it('rejects duplicate identities but permits replacing an occurrence with the same identity', () => {
    const empty = projection.init(header, SessionLogOffset(0))
    const queued = projection.apply(empty, splice())
    expect(() => projection.apply(queued, splice(1))).toThrow('duplicate persisted inbox message identity')
    expect(projection.apply(queued, splice(0, 1)).items).toEqual(queued.items)
    expect(projection.wire.view(queued)).toBe(queued.items)
  })

  it('moves a claimed queue item into next-step steering through durable deletions and insertions', () => {
    let state = projection.apply(projection.init(header, SessionLogOffset(0)), splice())
    state = projection.apply(state, { type: 'agent/inbox/spliced', seq: SessionSeq(1), time: 2,
      data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } })
    state = projection.apply(state, { type: 'agent/inbox/spliced', seq: SessionSeq(2), time: 3,
      data: { target: 'next-step', start: 0, inserted: [message] } })
    expect(state.items).toEqual([{ id: message.id, message, placement: 'steering' }])
  })
})


it('retains RPC attribution and separates injected next-step context from human steering', () => {
  const attributed = { ...message, source: { kind: 'user' as const, rpcId: 'receipt' as import('../src/api/rpc.ts').RpcId } }
  const context = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'test' } })
  const state = projection.apply(projection.init(header, SessionLogOffset(0)), {
    type: 'agent/inbox/spliced', seq: SessionSeq(0), time: 1,
    data: { target: 'next-step', start: 0, inserted: [attributed, context] },
  })
  expect(state.items).toMatchObject([{ placement: 'steering', rpcId: 'receipt' }, { placement: 'context' }])
})
