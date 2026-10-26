/** Revision-qualified cold list metadata without retaining authorization or event bodies. */
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createApiProxy } from '../src/api-proxy.ts'
import { RpcId } from '../src/api/rpc.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function fixture(limits: { coldSummaryCacheMaxEntries?: number; coldSummaryCacheMaxBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cold-summary-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const artifact = join(root, 'fixture.log')
  await writeFile(artifact, 'small\n')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestions)
  const records = new Map<SessionId, { header: SessionHeader; revision?: SessionPersistenceRevision; events: SessionEvent[] }>()
  const add = (id: string, time = 100) => {
    const sessionId = SessionId(id)
    records.set(sessionId, {
      header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: root, isSeeded: false },
      revision: SessionPersistenceRevision('initial-' + id),
      events: [{ type: 'user/message', seq: SessionSeq(0), time,
        data: createUserMessage({ content: [{ type: 'text', text: 'Synthetic message' }], source: { kind: 'user' } }), surfaceOp: 'append' }],
    })
    return sessionId
  }
  const first = add('first')
  const readFrom = vi.fn(async (id: SessionId) => {
    const record = records.get(id)!
    return { meta: record.header, events: record.events }
  })
  const listSnapshots = vi.fn(async () => [...records.values()].map(({ header, revision }) => ({ header, revision })))
  ctx.provide('sessionPersistence', {
    listSnapshots,
    locate: () => ({ kind: 'jsonl', path: artifact }),
    readFrom,
  } as never)
  const defaults = { cwd: root, defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }), ...limits }
  const api = createApiProxy(ctx, defaults)
  const list = async () => {
    const result = await api.sessions.list({ rpcId: RpcId('cold-summary'), payload: {} })
    expect(result.result.ok).toBe(true)
    if (!result.result.ok) throw new Error('Listing refused')
    return result.result.value.items
  }
  return { ctx, api, records, readFrom, listSnapshots, first, add, list }
}

it('reuses a verified summary for an unchanged revision and returns independent rows', async () => {
  const f = await fixture()
  const first = await f.list()
  const expected = structuredClone(first)
  first[0]!.updatedAt = 999
  expect(await f.list()).toEqual(expected)
  expect(f.readFrom).toHaveBeenCalledTimes(1)
})

it('reads again after a source revision or header identity changes', async () => {
  const f = await fixture()
  await f.list()
  const record = f.records.get(f.first)!
  record.revision = SessionPersistenceRevision('appended')
  record.events = [{ ...record.events[0]!, time: 200 }]
  expect(await f.list()).toMatchObject([{ updatedAt: 200 }])
  record.header = { ...record.header, createdAt: 300 }
  expect(await f.list()).toMatchObject([{ updatedAt: 300 }])
  expect(f.readFrom).toHaveBeenCalledTimes(3)
})

it('does not retain unavailable probes or snapshots without a revision', async () => {
  const f = await fixture()
  f.readFrom.mockRejectedValueOnce(new Error('Temporary synthetic read failure'))
  expect(await f.list()).toMatchObject([{ blank: false, updatedAt: 1 }])
  expect(await f.list()).toMatchObject([{ blank: false, updatedAt: 100 }])
  expect(await f.list()).toMatchObject([{ blank: false, updatedAt: 100 }])
  expect(f.readFrom).toHaveBeenCalledTimes(2)
  delete f.records.get(f.first)!.revision
  await f.list()
  await f.list()
  expect(f.readFrom).toHaveBeenCalledTimes(4)
})

it('keeps projection hints fresh while reusing only the verified scalar summary', async () => {
  const f = await fixture()
  let title = 'First title'
  f.ctx.provide('sessionProjectionCache', {
    cachedSnapshot: () => ({ asOfSeq: 0, values: { title } }),
  } as never)
  expect(await f.list()).toMatchObject([{ projections: { values: { title: 'First title' } } }])
  title = 'Second title'
  expect(await f.list()).toMatchObject([{ projections: { values: { title: 'Second title' } } }])
  expect(f.readFrom).toHaveBeenCalledTimes(1)
})

it.each([
  { coldSummaryCacheMaxEntries: 0 },
  { coldSummaryCacheMaxBytes: 0 },
  { coldSummaryCacheMaxBytes: 1 },
])('reads again when memoization is disabled or one entry exceeds %j', async (limits) => {
  const f = await fixture(limits)
  await f.list()
  await f.list()
  expect(f.readFrom).toHaveBeenCalledTimes(2)
})

it('evicts older summaries at the configured entry bound', async () => {
  const f = await fixture({ coldSummaryCacheMaxEntries: 1 })
  await f.list()
  const first = f.records.get(f.first)!
  f.records.delete(f.first)
  const second = f.add('second')
  await f.list()
  f.records.delete(second)
  f.records.set(f.first, first)
  await f.list()
  expect(f.readFrom.mock.calls.map(([id]) => id)).toEqual([f.first, second, f.first])
})

it('does not qualify a body read under a revision that changed while it was pending', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const read = f.readFrom.getMockImplementation()!
  f.readFrom.mockImplementationOnce(async (id) => {
    const value = await read(id)
    entered.resolve(undefined)
    await release.promise
    return value
  })
  const pending = f.list()
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Listing settled before the blocked read') })])
    const record = f.records.get(f.first)!
    record.revision = SessionPersistenceRevision('concurrent-append')
    record.events = [{ ...record.events[0]!, time: 200 }]
  } finally {
    release.resolve(undefined)
    await pending
  }
  expect(await f.list()).toMatchObject([{ updatedAt: 200 }])
  await f.list()
  expect(f.readFrom).toHaveBeenCalledTimes(2)
})

it('keeps a successful listing usable when optional revision verification fails', async () => {
  const f = await fixture()
  const list = f.listSnapshots.getMockImplementation()!
  f.listSnapshots.mockImplementationOnce(list).mockRejectedValueOnce(new Error('Synthetic revision read failure'))
  expect(await f.list()).toMatchObject([{ updatedAt: 100 }])
  await f.list()
  await f.list()
  expect(f.readFrom).toHaveBeenCalledTimes(2)
})

it('rechecks current collaboration visibility on every memoized listing', async () => {
  const f = await fixture()
  let readable = true
  const filter = vi.fn(async (ids: readonly SessionId[]) => new Set(readable ? ids : []))
  f.ctx.provide('collaboration', {
    capture: () => ({
      participant: { userId: 7, username: 'synthetic', displayName: 'Synthetic', role: 'user',
        scope: { kind: 'project', projectId: 1, projectName: 'Synthetic', mode: 'rw' } },
      expiresAt: Number.MAX_SAFE_INTEGER,
      signal: new AbortController().signal,
      readableSessionIds: filter,
      authorize: async (id: SessionId) => ({ sessionId: id, rootSessionId: id, mode: 'rw',
        canRead: true, canWrite: true, canManage: false, visibility: 'project', projectId: 1 }),
    }),
  } as never)
  expect(await f.list()).toMatchObject([{ visibility: 'project', projectId: 1 }])
  readable = false
  expect(await f.list()).toEqual([])
  expect(f.readFrom).toHaveBeenCalledTimes(1)
  expect(filter).toHaveBeenCalledTimes(2)
})

it('does not retain a summary when cancellation arrives during revision verification', async () => {
  const f = await fixture()
  f.ctx.provide('sessionQuery', { searchSessions: async () => ({ items: [], hasMore: false }) } as never)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const read = f.listSnapshots.getMockImplementation()!
  f.listSnapshots.mockImplementationOnce(read).mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    return read()
  })
  const pending = f.api.sessions.search({ rpcId: RpcId('cancel-summary'), payload: { query: 'Synthetic' } }, controller.signal)
  let result: Awaited<typeof pending>
  try {
    await Promise.race([entered.promise, pending.then(() => { throw new Error('Search settled before revision verification') })])
    controller.abort(new Error('Synthetic search cancelled'))
  } finally {
    release.resolve(undefined)
    result = await pending
  }
  expect(result.result).toMatchObject({ ok: false, error: { code: 'cancelled' } })
  await f.list()
  await f.list()
  expect(f.readFrom).toHaveBeenCalledTimes(2)
})
