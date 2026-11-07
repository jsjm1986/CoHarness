/** Live JSONL retention refuses work before committed Session events can be lost. */

import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { JsonlHandleStorage, JsonlSessionHandle } from '../src/storage.ts'
import { SessionHandleClosedError } from '@deepseek-ai/dsh-session-persistence'
import { expect, it, vi } from 'vitest'

it('refuses an event before Session commit when the live pending-event capacity is full', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-retention-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const config = { root, compression: 'none' as const, maxPendingEvents: 2, maxPendingBytes: 4_096 }
    await ctx.plugin(JsonlSessionPersistence, config)
    const session = ctx.sessions.create(SessionId('bounded-live'))
    const writer = await ctx.sessionPersistence.create(session.header)
    session.append('session/end-seed', {})
    session.append('session/end-seed', {})

    expect(() => session.append('session/end-seed', {})).toThrow(/pending.event.*limit|pending.event.*capacity/iu)
    expect(session.seq).toBe(2)
    await expect(writer.append([{ type: 'session/end-seed', seq: SessionSeq(2), time: 0, data: {} }]))
      .rejects.toThrow(/new event refused/iu)
    await expect(ctx.sessions.flush(session)).rejects.toThrow(/new event refused/iu)
    const reader = await ctx.sessionPersistence.open(session.id, 'read')
    try {
      expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
    } finally {
      await reader.close()
    }
    await expect(writer.close()).rejects.toThrow(/new event refused/iu)
    const resumed = await ctx.sessionPersistence.open(session.id, 'write')
    session.append('session/end-seed', {})
    await ctx.sessions.flush(session)
    await resumed.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('counts an active write against the provider capacity shared by different Sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-active-retention-'))
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  let draining: Promise<void> | undefined
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', maxPendingEvents: 1 })
    const first = ctx.sessions.create(SessionId('active'))
    const second = ctx.sessions.create(SessionId('blocked'))
    const writer = await ctx.sessionPersistence.create(first.header) as JsonlSessionHandle
    const blocked = await ctx.sessionPersistence.create(second.header)
    await writer.flush()
    const storage = ctx.sessionPersistence as SessionPersistence & JsonlHandleStorage
    const original = storage.persistBatch.bind(storage)
    const entered = Promise.withResolvers<undefined>()
    const persist = vi.spyOn(storage, 'persistBatch').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      await original(...args)
    })
    first.append('session/end-seed', {})
    draining = writer.drainLive()
    await entered.promise
    expect(() => second.append('session/end-seed', {})).toThrow(/pending-event limit/u)
    expect(second.seq).toBe(0)
    release.resolve(undefined)
    await draining
    persist.mockRestore()
    await expect(blocked.close()).rejects.toThrow(/new event refused/u)
    const replacement = await ctx.sessionPersistence.create(second.header)
    second.append('session/end-seed', {})
    await ctx.sessions.flush(second)
    await replacement.close()
    await writer.close()
  } finally {
    release.resolve(undefined)
    await draining?.catch(() => {})
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('bounds a failed live drain, preserves accepted events, and refuses later candidates until reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-failed-retention-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', maxPendingEvents: 2 })
    const session = ctx.sessions.create(SessionId('failed'))
    const writer = await ctx.sessionPersistence.create(session.header) as JsonlSessionHandle
    await writer.flush()
    const storage = ctx.sessionPersistence as SessionPersistence & JsonlHandleStorage
    const persist = vi.spyOn(storage, 'persistBatch').mockRejectedValueOnce(new Error('simulated disk failure'))
    session.append('session/end-seed', {})
    await expect(writer.drainLive()).rejects.toThrow('simulated disk failure')
    let accepted = 1
    let refused = 0
    for (let index = 0; index < 2_000; index++) {
      try {
        session.append('session/end-seed', {})
        accepted++
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(Error)
        refused++
      }
    }
    expect({ accepted, refused, seq: session.seq }).toEqual({ accepted: 2, refused: 1_999, seq: 2 })
    persist.mockRestore()
    await expect(ctx.sessions.flush(session)).rejects.toThrow(/new event refused/u)
    await expect(writer.close()).rejects.toThrow(/new event refused/u)
    const resumed = await ctx.sessionPersistence.open(session.id, 'write')
    expect((await resumed.read()).events.map(event => event.seq)).toEqual([0, 1])
    session.append('session/end-seed', {})
    await ctx.sessions.flush(session)
    expect((await resumed.read()).events.map(event => event.seq)).toEqual([0, 1, 2])
    await resumed.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('rolls back partial explicit-batch reservations without closing the writer to a smaller batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-explicit-retention-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', maxPendingEvents: 2 })
    const session = ctx.sessions.create(SessionId('explicit'))
    const writer = await ctx.sessionPersistence.create(session.header)
    const batch: SessionEvent[] = Array.from({ length: 3 }, (_, seq) => ({
      type: 'session/end-seed', seq: SessionSeq(seq), time: 0, data: {},
    }))
    await expect(writer.append(batch)).rejects.toThrow(/pending-event limit/u)
    await writer.append(batch.slice(0, 2))
    expect((await writer.read()).events.map(event => event.seq)).toEqual([0, 1])
    await writer.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('releases live capacity when a later Session admission rejects the candidate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-rollback-retention-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', maxPendingEvents: 1 })
    const session = ctx.sessions.create(SessionId('rollback'))
    const writer = await ctx.sessionPersistence.create(session.header)
    const remove = ctx.sessions.registerAppendAdmission(() => { throw new Error('later refusal') })
    expect(() => session.append('session/end-seed', {})).toThrow('later refusal')
    await remove()
    expect(session.append('session/end-seed', {}).seq).toBe(0)
    await ctx.sessions.flush(session)
    await writer.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('reports a persistent close failure without promising its pending events reached storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-close-retention-'))
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none', maxPendingEvents: 1 })
    const session = ctx.sessions.create(SessionId('undurable'))
    const writer = await ctx.sessionPersistence.create(session.header)
    await writer.flush()
    const storage = ctx.sessionPersistence as SessionPersistence & JsonlHandleStorage
    const persist = vi.spyOn(storage, 'persistBatch').mockRejectedValue(new Error('disk remains unavailable'))
    session.append('session/end-seed', {})
    await expect(writer.close()).rejects.toThrow('disk remains unavailable')
    persist.mockRestore()
    const reopened = await ctx.sessionPersistence.open(session.id, 'write')
    expect((await reopened.read()).events).toEqual([])
    await reopened.close()
    const next = ctx.sessions.create(SessionId('other'))
    const nextWriter = await ctx.sessionPersistence.create(next.header)
    next.append('session/end-seed', {})
    await ctx.sessions.flush(next)
    await nextWriter.close()
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('refuses live candidates before commit while final write-lease release is pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-release-retention-'))
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  let closing: Promise<void> | undefined
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const session = ctx.sessions.create(SessionId('release-window'))
    const writer = await ctx.sessionPersistence.create(session.header)
    const storage = ctx.sessionPersistence as SessionPersistence & JsonlHandleStorage
    const acquire = storage.acquireWriteLease.bind(storage)
    const entered = Promise.withResolvers<undefined>()
    const lease = vi.spyOn(storage, 'acquireWriteLease').mockImplementationOnce(async (header) => {
      const owned = await acquire(header)
      const original = owned.release.bind(owned)
      vi.spyOn(owned, 'release').mockImplementationOnce(async () => {
        entered.resolve(undefined)
        await release.promise
        await original()
      })
      return owned
    })
    session.append('session/end-seed', {})
    closing = writer.close()
    await entered.promise
    expect(() => session.append('session/end-seed', {})).toThrow(SessionHandleClosedError)
    expect(session.seq).toBe(1)
    release.resolve(undefined)
    await closing
    lease.mockRestore()
    const reopened = await ctx.sessionPersistence.open(session.id, 'write')
    expect((await reopened.read()).events.map(event => event.seq)).toEqual([0])
    await reopened.close()
  } finally {
    release.resolve(undefined)
    await closing?.catch(() => {})
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
