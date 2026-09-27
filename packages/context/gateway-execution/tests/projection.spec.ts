/** Durable projection caches retain execution restrictions without exposing them to the browser. */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { ExecutionInputId, ExecutionScopeId, ExecutionState } from '@deepseek-ai/dsh-execution-authority'
import { expect, it } from 'vitest'
import { EXECUTION_PROJECTION as projection } from '../src/projection.ts'

const A = '00000000-0000-4000-8000-000000000001' as ExecutionInputId
const accepted: ExecutionState = {
  revision: '2', inputs: [A], actors: [{ userId: 1 }], primaryActorUserId: 1, unverifiedHistory: false,
}

it('ignores inherited authority revisions and folds only the child-owned suffix', () => {
  const parent = Session.create(SessionId('parent'))
  const event = parent.append('gateway/execution', { kind: 'accepted', state: accepted })
  const initial = projection.init({ ...parent.header, id: SessionId('child'), isSeeded: true }, SessionLogOffset(1))
  expect(projection.apply(initial, event)).toBe(initial)
  const child = Session.create(SessionId('child'))
  child.append('gateway/execution', { kind: 'accepted', state: accepted })
  const inherited = child.append('gateway/execution', { kind: 'inherit', scope: {
    parentSessionId: parent.id, inputs: [A], primaryActorUserId: 1, unverifiedHistory: false,
  } })
  const next = projection.apply(initial, inherited)
  expect(next.state.revision).toBe('0')
  expect(next.inheritance).toMatchObject({ inputs: [A], parentSessionId: parent.id })
  expect(next.seeded).toBe(true)
  expect(next.unverified).toBe(false)
  expect(projection.wire).toBeUndefined()
})

it('preserves unknown history across later verified state and inheritance', () => {
  const session = Session.create(SessionId('unknown'))
  let current = projection.init(session.header, SessionLogOffset(0))
  const human = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'unverified restored instruction' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  current = projection.apply(current, human)
  expect(current.unverified).toBe(true)
  expect(projection.apply(current, human)).toBe(current)
  current = projection.apply(current, session.append('gateway/execution', { kind: 'accepted', state: accepted }))
  current = projection.apply(current, session.append('gateway/execution', { kind: 'inherit', scope: {
    parentSessionId: SessionId('parent'), inputs: [A], primaryActorUserId: 1, unverifiedHistory: false,
  } }))
  expect(current.unverified).toBe(true)
  expect(current.state).toEqual(accepted)
})

it('marks explicit unknown authority and leaves verified or plugin input unchanged', () => {
  const session = Session.create(SessionId('verified'))
  const initial = projection.init(session.header, SessionLogOffset(0))
  const verified = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'verified instruction' }], source: { kind: 'user', gatewayExecutionInput: A },
  }), { surfaceOp: 'append' })
  expect(projection.apply(initial, verified)).toBe(initial)
  const context = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'trusted context' }], source: { kind: 'plugin', plugin: 'context', form: 'instructions' },
  }), { surfaceOp: 'append' })
  expect(projection.apply(initial, context)).toBe(initial)
  const unknownState = session.append('gateway/execution', { kind: 'accepted', state: { ...accepted, unverifiedHistory: true } })
  expect(projection.apply(initial, unknownState).unverified).toBe(true)
  const unknownInheritance = session.append('gateway/execution', { kind: 'inherit', scope: {
    parentSessionId: SessionId('legacy'), inputs: [], unverifiedHistory: true,
  } })
  expect(projection.apply(initial, unknownInheritance).unverified).toBe(true)
})

it('validates persisted cache fields and reconstructs detached restrictions', () => {
  const session = Session.create(SessionId('cache'))
  const initial = projection.init(session.header, SessionLogOffset(0))
  expect(projection.stateSchema.parse(initial)).toEqual(initial)
  const withScope = { ...initial, inheritance: {
    parentSessionId: SessionId('parent'), inputs: [A], primaryActorUserId: 1, unverifiedHistory: false,
  } }
  expect(projection.stateSchema.parse(withScope).inheritance).toEqual(withScope.inheritance)
  expect(() => projection.stateSchema.parse({ ...initial, administrator: true })).toThrow()
  expect(() => projection.stateSchema.parse({ ...initial, inheritedEventCount: -1 })).toThrow()
  expect(() => projection.stateSchema.parse({ ...initial, state: { ...accepted, revision: '-1' } })).toThrow()
  expect(() => projection.stateSchema.parse({ ...initial, inheritance: { inputs: [] } })).toThrow()
  expect(projection.init(session.header, SessionLogOffset(0)).seeded).toBe(false)
})

it('rejects an unrecognized durable execution event instead of granting authority', () => {
  const session = Session.create(SessionId('unknown-execution-event'))
  const initial = projection.init(session.header, SessionLogOffset(0))
  const event = { type: 'gateway/execution', seq: 0, time: 0, data: { kind: 'unknown' } }
  expect(() => projection.apply(initial, event as never)).toThrow()
})

it('requires a reader admission marker before scoped state, inherited work, or automatic continuations', () => {
  const session = Session.create(SessionId('protocol'))
  const initial = projection.init(session.header, SessionLogOffset(0))
  const scopeId = '10000000-0000-4000-8000-000000000001' as ExecutionScopeId
  const scope = { parentSessionId: session.id, scopeId, inputs: [A], primaryActorUserId: 1, unverifiedHistory: false }
  const scoped = session.append('gateway/execution', { kind: 'accepted', state: { ...accepted, scopeId } })
  const inherited = session.append('gateway/execution', { kind: 'inherit', scope })
  const continuation = session.append('gateway/continuation', { key: 'goal:test:1', scope })
  for (const event of [scoped, inherited, continuation]) {
    expect(() => projection.apply(initial, event)).toThrow('requires its reader admission event')
  }
  const marker = session.append('gateway/scoped-execution', { version: 1 })
  const admitted = projection.apply(initial, marker)
  expect(projection.apply(admitted, scoped).state.scopeId).toBe(scopeId)
  expect(projection.apply(admitted, inherited).inheritance).toEqual(scope)
  expect(projection.apply(admitted, continuation).continuation).toEqual({ key: 'goal:test:1', scope })
  expect(() => projection.apply(initial, { ...marker, data: { version: 2 } } as never)).toThrow('unsupported scoped execution protocol')
  expect(() => projection.apply(initial, { ...marker, ignorable: true })).toThrow('unsupported scoped execution protocol')
})
