/** Session append reservations settle at the same acceptance point as the event log. */

import { Context } from '@deepseek-ai/cordis'
import { createMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq, appendPluginRecord } from '../src/index.ts'
import { expect, it, vi } from 'vitest'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:admission-test/state': { count: number }
  }
}

it('runs admissions on frozen candidates and passes committed reservations to the event consumer', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('admission'))
    const rollback = vi.fn()
    const admitted: unknown[] = []
    ctx.sessions.registerAppendAdmission((owner, event) => {
      expect(owner).toBe(session)
      expect(owner.seq).toBe(event.seq)
      expect(Object.isFrozen(event)).toBe(true)
      expect(Object.isFrozen(event.data)).toBe(true)
      admitted.push(event)
      return rollback
    })
    ctx.on('session/event', (_owner, event) => { expect(admitted.at(-1)).toBe(event) })
    const event = session.append('session/end-seed', {})
    expect(admitted).toEqual([event])
    expect(rollback).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})

it('rolls back earlier admissions in reverse order and leaves the next candidate admissible', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('refusal'))
    const order: number[] = []
    ctx.sessions.registerAppendAdmission(() => () => { order.push(1) })
    ctx.sessions.registerAppendAdmission(() => () => { order.push(2) })
    const refusal = new Error('capacity reached')
    const remove = ctx.sessions.registerAppendAdmission(() => { throw refusal })
    expect(() => session.append('session/end-seed', {})).toThrow(refusal)
    expect(order).toEqual([2, 1])
    expect(session.seq).toBe(0)
    await remove()
    expect(session.append('session/end-seed', {}).seq).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

it('rolls back reservations when surface or internal dispatch validation refuses a candidate', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('validation'))
    const rollback = vi.fn()
    ctx.sessions.registerAppendAdmission(() => rollback)
    const message = createMessage({ role: 'user', content: [{ type: 'text', text: 'input' }], source: { kind: 'user' } })
    expect(() => session.append('user/message', message, {
      surfaceOp: 'append', sourceEventSeqs: [SessionSeq(1)],
    })).toThrow()
    const remove = ctx.on('internal/dispatch', (_mode, event) => {
      if (event === 'session/event') throw new Error('dispatch refused')
    })
    expect(() => session.append('session/end-seed', {})).toThrow('dispatch refused')
    remove()
    expect(rollback).toHaveBeenCalledTimes(2)
    expect(session.seq).toBe(0)
    expect(session.append('session/end-seed', {}).seq).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

it('rolls back every reservation even when a rollback throws', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('rollback-failure'))
    const first = vi.fn()
    ctx.sessions.registerAppendAdmission(() => first)
    ctx.sessions.registerAppendAdmission(() => () => { throw new Error('rollback failed') })
    ctx.sessions.registerAppendAdmission(() => { throw new Error('refused') })
    expect(() => session.append('session/end-seed', {})).toThrow(AggregateError)
    expect(first).toHaveBeenCalledOnce()
    expect(session.seq).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

it('prevents same-session reentrance from an admission and removes a disposed contribution', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('reentrant'))
    const owner = ctx.plugin({
      inject: ['sessions'],
      apply(inner: Context) {
        inner.sessions.registerAppendAdmission(() => { session.append('session/end-seed', {}) })
      },
    })
    await owner
    expect(() => session.append('session/end-seed', {})).toThrow(/cannot reenter/u)
    expect(session.seq).toBe(0)
    await owner.dispose()
    expect(session.append('session/end-seed', {}).seq).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

it('keeps detached Sessions independent and admits plugin records through the same reservation path', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const refusal = new Error('attached only')
    ctx.sessions.registerAppendAdmission(() => { throw refusal })
    const detached = Session.create(SessionId('detached'))
    expect(detached.append('session/end-seed', {}).seq).toBe(0)
    const attached = ctx.sessions.create(SessionId('plugin-record'))
    expect(() => appendPluginRecord(attached, 'plugin:admission-test/state', { count: 1 })).toThrow(refusal)
    expect(attached.seq).toBe(0)
  } finally { await ctx.fiber.dispose() }
})

it('rejects duplicate callback ownership without removing the existing admission', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('duplicate-admission'))
    const refusal = new Error('owned admission')
    const admission = (): never => { throw refusal }
    const owner = ctx.plugin({ inject: ['sessions'], apply(inner: Context) { inner.sessions.registerAppendAdmission(admission) } })
    await owner
    const duplicate = ctx.plugin({ inject: ['sessions'], apply(inner: Context) { inner.sessions.registerAppendAdmission(admission) } })
    await expect(duplicate).rejects.toThrow('already registered')
    await duplicate.dispose()
    expect(() => session.append('session/end-seed', {})).toThrow(refusal)
    await owner.dispose()
    expect(session.append('session/end-seed', {}).seq).toBe(0)
  } finally { await ctx.fiber.dispose() }
})
