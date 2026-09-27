/** Purge coordinates resource release, review artifacts, local lineage and database acknowledgement. */
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionHeader } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it } from 'vitest'
import ArchiveGateway from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const root = SessionId('root'), child = SessionId('child'), grandchild = SessionId('grandchild'), other = SessionId('other')
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
function corpus() {
  return new Map<SessionId, SessionHeader>([root, child, grandchild, other].map(id => [id, {
    id, version: SESSION_FORMAT_VERSION, createdAt: 1, isSeeded: false,
    ...id === child ? { parentSession: root } : id === grandchild ? { parentSession: child } : {},
  }]))
}

async function fixture(options: {
  kind?: 'user' | 'project'
  headers?: Map<SessionId, SessionHeader>
  failLocal?: SessionId
  missingReviews?: boolean
  recordedReview?: boolean
  concurrentChild?: boolean
} = {}) {
  const ctx = new Context(), headers = options.headers ?? corpus()
  contexts.push(ctx)
  const archived = new Set(headers.keys()), calls: string[] = [], failures: string[] = []
  let queued = true, reserved = false
  const completed = Promise.withResolvers<undefined>()
  ctx.provide('connection', { http: { handlePrefix: () => () => {} } } as never)
  ctx.provide('hostSessionLifecycle', { withReleased: async (_ids: SessionId[], operation: () => Promise<void>) => {
    reserved = true
    if (options.concurrentChild) headers.set(SessionId('concurrent-child'), {
      id: SessionId('concurrent-child'), version: SESSION_FORMAT_VERSION, createdAt: 2, isSeeded: true, parentSession: root,
    })
    try { await operation() } finally { reserved = false }
  } } as never)
  if (!options.missingReviews) ctx.provide('workspaceChanges', {
    removeStored: async (id: SessionId) => { calls.push(`review:${id}`) },
  } as never)
  ctx.provide('workspaceRegistry', {
    get archivedSessionIds() { return [...archived] },
    archiveSnapshot: () => ({ revision: 1, archivedSessionIds: [...archived] }),
    archivedEntries: async () => [],
    restoreSession: async (id: SessionId) => { calls.push(`membership:${id}`); archived.delete(id) },
  } as never)
  ctx.provide('sessionPersistence', {
    list: async () => [...headers.values()].map(header => ({ header })),
    readPage: async (id: SessionId) => ({ meta: headers.get(id), hasMore: false, endSeq: 0,
      events: options.recordedReview ? [{ type: 'workspace/changes', seq: SessionSeq(0), data: { turn: 1 } }] : [],
    }),
    remove: async (id: SessionId) => {
      expect(reserved).toBe(true)
      calls.push(`log:${id}`)
      if (id === options.failLocal) throw new Error('fixture local deletion failed')
      headers.delete(id)
    },
  } as never)
  ctx.provide('gatewayRuntime', {
    identity: { kind: options.kind ?? 'user', id: 1, generation: 1 },
    request: async (path: string, init?: RequestInit) => {
      if (path.endsWith('/pending')) return json({ pending: queued })
      if (!path.endsWith('/ack')) return json({ commands: queued ? [{ id: 'purge-command', rootSessionId: root, action: 'purge' }] : [] })
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON acknowledgement body')
      const payload = JSON.parse(init.body) as { error?: string }
      queued = false
      if (payload.error !== undefined) failures.push(payload.error)
      else {
        expect(reserved).toBe(true)
        await Promise.resolve()
        expect(reserved).toBe(true)
        calls.push('database-ack')
        if (options.kind === 'project') { headers.delete(grandchild); headers.delete(child); headers.delete(root) }
      }
      completed.resolve(undefined)
      return json({ acknowledged: true })
    },
  } as never)
  await ctx.plugin(ArchiveGateway)
  await completed.promise
  return { ctx, headers, archived, calls, failures }
}

it('removes all reviews before logs and removes descendants before ancestors', async () => {
  const f = await fixture()
  expect(f.failures).toEqual([])
  expect(f.calls.filter(call => call.startsWith('log:'))).toEqual(['log:grandchild', 'log:child', 'log:root'])
  expect(f.calls.findIndex(call => call.startsWith('log:'))).toBeGreaterThan(f.calls.findLastIndex(call => call.startsWith('review:')))
  expect([...f.headers.keys()]).toEqual([other])
  expect(f.archived.has(other)).toBe(true)
  expect(f.calls).not.toContain('review:other')
})

it('retains all data when a fork completes after the selected archive snapshot', async () => {
  const f = await fixture({ concurrentChild: true })
  expect(f.failures).toEqual(['Archive tree changed while releasing Sessions; retry purge'])
  expect(f.headers.size).toBe(5)
  expect(f.calls).toEqual([])
})

it('keeps enough lineage to retry after a runtime restart following partial local deletion', async () => {
  const first = await fixture({ failLocal: child })
  expect(first.failures).toEqual(['fixture local deletion failed'])
  expect(first.headers.has(root)).toBe(true)
  expect(first.headers.has(child)).toBe(true)
  expect(first.headers.has(grandchild)).toBe(false)
  await first.ctx.fiber.dispose()
  const next = await fixture({ headers: first.headers })
  expect(next.failures).toEqual([])
  expect([...next.headers.keys()]).toEqual([other])
})

it('leaves project database deletion to the one acknowledged transaction', async () => {
  const f = await fixture({ kind: 'project' })
  expect(f.failures).toEqual([])
  expect(f.calls.some(call => call.startsWith('log:'))).toBe(false)
  expect(f.calls.at(-1)).toBe('database-ack')
  expect([...f.headers.keys()]).toEqual([other])
})

it('refuses missing review cleanup when the durable log declares that owner', async () => {
  const f = await fixture({ missingReviews: true, recordedReview: true })
  expect(f.failures).toEqual(['Historical review cleanup provider is unavailable'])
  expect(f.headers.size).toBe(4)
  expect(f.calls).toEqual([])
})

it('does not require review cleanup for a composition whose logs have no review records', async () => {
  const f = await fixture({ missingReviews: true })
  expect(f.failures).toEqual([])
  expect([...f.headers.keys()]).toEqual([other])
})
