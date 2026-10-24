/** Explicit Session bundles publish lifecycle changes independently of current selection. */
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle, ConnectionRuntimeTarget } from '@deepseek-ai/dsh-client-connection/client'
import type { HostObservable, SessionProvideInfo } from '@deepseek-ai/dsh-client-ui-slots'
import { clientSessionKey } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionReference } from '../src/client/contract/sessions.ts'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { SessionRuntimePool } from '../src/client/sessions/pool.ts'
import { FakeApiClient, deferred, fakeRemote, ok } from './fake-api.client.ts'

type ProvideOwner = Pick<ISessions, 'currentProvideInfo' | 'provideInfoFor' | 'provideInfoRevision'>

/** Older renderer hosts observe only the current bundle. */
function bindingChanges(owner: ProvideOwner): HostObservable<unknown> {
  return owner.provideInfoRevision ?? owner.currentProvideInfo
}

function seedList(api: FakeApiClient, ids: readonly SessionId[]): void {
  api.onList = async () => ok({ items: ids.map(sessionId => ({
    sessionId, updatedAt: 1, running: false, blank: false,
  })) })
}

function connection(api: FakeApiClient, target?: ConnectionRuntimeTarget): ConnectionHandle {
  return {
    api, isLoopback: true, interactions: 'none',
    hostDescription: { getSnapshot: () => undefined, subscribe: () => () => {} },
    state: { getSnapshot: () => undefined, subscribe: () => () => {} },
    rpc: { call: () => Promise.reject(new Error('unexpected rpc')) },
    reconnect: () => {},
    start: (sinks) => {
      sinks.onConnected?.({ version: 'test', cwd: '/workspace', home: '/home', attachedSessions: 0,
        canOpenPath: false, ...(target === undefined ? {} : { runtimeTarget: target }) })
      return { stop: () => {} }
    },
  }
}

function expectIncreasing(revisions: readonly unknown[]): void {
  for (const [index, revision] of revisions.entries()) {
    expect(revision).toEqual(expect.any(Number))
    if (index > 0) expect(revision).toBeGreaterThan(revisions[index - 1] as number)
  }
}

describe('explicit Session provide revisions', () => {
  it('publishes a non-current bundle after acquisition and removes it on final release', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const selected = 'selected' as SessionId
    const other = 'other' as SessionId
    seedList(api, [selected, other])
    const runtime = new SessionRuntime(ctx, api, fakeRemote(api), undefined, { persistSelection: false })
    let stop = () => {}
    let first: SessionReference | undefined
    let second: SessionReference | undefined
    try {
      await runtime.refresh()
      runtime.open(selected)
      await runtime.using(selected, { source: 'controllerOperation' }, () => {})
      const current = runtime.currentProvideInfo.getSnapshot()
      const source = bindingChanges(runtime)
      const seen: (SessionProvideInfo | undefined)[] = []
      const revisions: unknown[] = []
      const references: number[] = []
      stop = source.subscribe(() => {
        seen.push(runtime.provideInfoFor(other))
        revisions.push(source.getSnapshot())
        references.push(runtime.retainInfo(other).getSnapshot().referenceCount)
      })
      expect(runtime.provideInfoFor(other)).toBeUndefined()
      first = runtime.retain(other, { source: 'controllerOperation' })
      const retained = runtime.provideInfoFor(other)
      expect(retained?.sessionId).toBe(other)
      expect(seen.at(-1)).toBe(retained)
      expect(references.at(-1)).toBe(1)
      expect(runtime.currentProvideInfo.getSnapshot()).toBe(current)
      await first.ready
      const acquired = revisions.length
      second = runtime.retain(other, { source: 'controllerOperation' })
      await second.ready
      expect(revisions).toHaveLength(acquired)
      first.release()
      expect(runtime.provideInfoFor(other)).toBe(retained)
      expect(revisions).toHaveLength(acquired)
      second.release()
      expect(runtime.provideInfoFor(other)).toBeUndefined()
      expect(seen.at(-1)).toBeUndefined()
      expect(references.at(-1)).toBe(0)
      expect(revisions.length).toBeGreaterThan(acquired)
      expect(runtime.currentProvideInfo.getSnapshot()).toBe(current)
      expectIncreasing(revisions)
      const settled = revisions.length
      await runtime.refresh()
      runtime.handleHostEnvelope({ rpcId: 'status' as never, payload: {
        type: 'host/session-status', sessionId: selected, running: true,
      } })
      await runtime.refresh()
      expect(revisions).toHaveLength(settled)
      stop()
      first = runtime.retain(other, { source: 'controllerOperation' })
      expect(seen).toHaveLength(settled)
    } finally {
      stop()
      first?.release()
      second?.release()
      await ctx.fiber.dispose()
    }
  })

  it('publishes completed roster changes and rollback with every retained bundle readable', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const ids = ['first', 'second'] as SessionId[]
    seedList(api, ids)
    const runtime = new SessionRuntime(ctx, api, fakeRemote(api), undefined, { persistSelection: false })
    const references: SessionReference[] = []
    let stop = () => {}
    let remove = () => {}
    try {
      await runtime.refresh()
      for (const id of ids) references.push(runtime.retain(id, { source: 'controllerOperation' }))
      await Promise.all(references.map(reference => reference.ready))
      const source = bindingChanges(runtime)
      const seen: (Readonly<Record<string, unknown>> | undefined)[][] = []
      const revisions: unknown[] = []
      stop = source.subscribe(() => {
        seen.push(ids.map(id => runtime.provideInfoFor(id)?.props))
        revisions.push(source.getSnapshot())
      })
      remove = runtime.provide({ props: ['marker'], resolve: () => ({ props: { marker: 7 } }) })
      expect(seen).toEqual([[{ marker: 7 }, { marker: 7 }]])
      remove()
      remove = () => {}
      expect(seen.at(-1)).toEqual([{}, {}])
      const beforeFailure = seen.length
      expect(() => runtime.provide({ props: ['partial'], resolve: (binding) => {
        if (binding.sessionId === ids[1]) throw new Error('second provider refused')
        return { props: { partial: true } }
      } })).toThrow('second provider refused')
      expect(seen.length).toBeGreaterThan(beforeFailure)
      expect(seen.slice(beforeFailure)).toEqual([[{}, {}]])
      expectIncreasing(revisions)
    } finally {
      stop()
      remove()
      for (const reference of references) reference.release()
      await ctx.fiber.dispose()
    }
  })

  it('allows a retirement observer to acquire a fresh generation with the same Session ID', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const id = 'reopened' as SessionId
    seedList(api, [id])
    const runtime = new SessionRuntime(ctx, api, fakeRemote(api), undefined, { persistSelection: false })
    let first: SessionReference | undefined
    const replacements: SessionReference[] = []
    let stop = () => {}
    try {
      await runtime.refresh()
      first = runtime.retain(id, { source: 'controllerOperation' })
      await first.ready
      const previous = first.binding
      stop = bindingChanges(runtime).subscribe(() => {
        if (runtime.provideInfoFor(id) === undefined && replacements.length === 0) {
          replacements.push(runtime.retain(id, { source: 'controllerOperation' }))
        }
      })
      first.release()
      const reopened = replacements[0]
      expect(reopened).toBeDefined()
      await reopened?.ready
      expect(reopened?.binding.session).not.toBe(previous.session)
      expect(runtime.binding(id)).toBe(reopened?.binding)
      expect(reopened?.binding.session.getSnapshot().openState).toBe('open')
    } finally {
      stop()
      first?.release()
      for (const replacement of replacements) replacement.release()
      await ctx.fiber.dispose()
    }
  })

  it('withdraws every retained bundle before root disposal completes', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const ids = ['first', 'second'] as SessionId[]
    seedList(api, ids)
    const runtime = new SessionRuntime(ctx, api, fakeRemote(api), undefined, { persistSelection: false })
    const references: SessionReference[] = []
    const seen: (SessionProvideInfo | undefined)[][] = []
    let stop = () => {}
    try {
      await runtime.refresh()
      for (const id of ids) references.push(runtime.retain(id, { source: 'controllerOperation' }))
      await Promise.all(references.map(reference => reference.ready))
      stop = bindingChanges(runtime).subscribe(() => { seen.push(ids.map(id => runtime.provideInfoFor(id))) })
      await ctx.fiber.dispose()
      expect(seen.at(-1)).toEqual([undefined, undefined])
    } finally {
      stop()
      for (const reference of references) reference.release()
      await ctx.fiber.dispose()
    }
  })

  it.each(['runtime', 'pool'] as const)('continues notifying healthy %s observers after another observer throws', async (owner) => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const id = 'observed' as SessionId
    seedList(api, [id])
    const runtime = new SessionRuntime(ctx, api, fakeRemote(api), undefined, {
      persistSelection: false, provideService: false,
    })
    const sessions = owner === 'runtime' ? runtime : new SessionRuntimePool(ctx, runtime, connection(api), fakeRemote(api))
    const key = owner === 'runtime' ? id : clientSessionKey({ kind: 'personal' }, id)
    let stopFailed = () => {}
    let stopHealthy = () => {}
    let reference: SessionReference | undefined
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await sessions.refresh()
      const source = bindingChanges(sessions)
      const failure = new Error('observer refused')
      let seen: SessionProvideInfo | undefined
      stopFailed = source.subscribe(() => { throw failure })
      stopHealthy = source.subscribe(() => { seen = sessions.provideInfoFor(key) })
      reference = sessions.retain(key, { source: 'controllerOperation' })
      await reference.ready
      expect(seen).toBe(sessions.provideInfoFor(key))
      expect(seen?.sessionId).toBe(key)
      expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure)
    } finally {
      try {
        stopFailed()
        stopHealthy()
        reference?.release()
        await ctx.fiber.dispose()
      } finally { errorSpy.mockRestore() }
    }
  })

  it('keeps a pooled bundle through catalog removal and withdraws it on final release', async () => {
    const ctx = new Context()
    const api = new FakeApiClient()
    const id = 'catalogued' as SessionId
    seedList(api, [id])
    const runtime = new SessionRuntime(ctx, api, fakeRemote(api), undefined, {
      persistSelection: false, provideService: false,
    })
    const pool = new SessionRuntimePool(ctx, runtime, connection(api), fakeRemote(api))
    const key = clientSessionKey({ kind: 'personal' }, id)
    let reference: SessionReference | undefined
    let stop = () => {}
    try {
      await pool.refresh()
      reference = pool.retain(key, { source: 'controllerOperation' })
      await reference.ready
      const bundle = pool.provideInfoFor(key)
      const seen: (SessionProvideInfo | undefined)[] = []
      stop = bindingChanges(pool).subscribe(() => { seen.push(pool.provideInfoFor(key)) })
      seedList(api, [])
      await pool.refresh()
      expect(pool.list.getSnapshot().ids).not.toContain(key)
      expect(pool.list.getSnapshot().byId[key]).toBeDefined()
      expect(pool.provideInfoFor(key)).toBe(bundle)
      expect(seen).toEqual([])
      expect(runtime.binding(id)).toBe(reference.binding)
      seedList(api, [id])
      await pool.refresh()
      expect(pool.list.getSnapshot().ids).toContain(key)
      expect(pool.provideInfoFor(key)).toBe(bundle)
      expect(seen).toEqual([])
      seedList(api, [])
      await pool.refresh()
      reference.release()
      expect(pool.provideInfoFor(key)).toBeUndefined()
      expect(pool.list.getSnapshot().byId[key]).toBeUndefined()
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.at(-1)).toBeUndefined()
    } finally {
      stop()
      reference?.release()
      await ctx.fiber.dispose()
    }
  })

  it.each(['personal', 'project'] as const)('publishes a late alternate bundle, release and account withdrawal from a %s bootstrap', async (bootstrap) => {
    const ctx = new Context()
    const baseApi = new FakeApiClient()
    const alternateApi = new FakeApiClient()
    const id = 'same-durable-session' as SessionId
    const baseTarget: ConnectionRuntimeTarget = bootstrap === 'personal'
      ? { kind: 'personal' } : { kind: 'project', projectId: 7 }
    const alternateTarget: ConnectionRuntimeTarget = bootstrap === 'personal'
      ? { kind: 'project', projectId: 7 } : { kind: 'personal' }
    seedList(baseApi, [id])
    const listing = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    const requested = deferred<undefined>()
    alternateApi.onList = () => { requested.resolve(undefined); return listing.promise }
    const base = new SessionRuntime(ctx, baseApi, fakeRemote(baseApi), undefined, { persistSelection: false, provideService: false })
    const alternateConnection = connection(alternateApi, alternateTarget)
    const pool = new SessionRuntimePool(ctx, base, {
      ...connection(baseApi), forTarget: () => alternateConnection,
    }, fakeRemote())
    const lifetime = new AbortController()
    const operations: Promise<void>[] = []
    let stop = () => {}
    try {
      pool.setBaseRuntimeTarget(baseTarget)
      await pool.refresh()
      const baseKey = clientSessionKey(baseTarget, id)
      const alternateKey = clientSessionKey(alternateTarget, id)
      pool.open(baseKey)
      await pool.using(baseKey, { source: 'controllerOperation' }, () => {})
      const current = pool.currentProvideInfo.getSnapshot()
      const source = bindingChanges(pool)
      const seen: (SessionProvideInfo | undefined)[] = []
      const revisions: unknown[] = []
      stop = source.subscribe(() => {
        seen.push(pool.provideInfoFor(alternateKey))
        revisions.push(source.getSnapshot())
      })
      const restore = pool.usingRuntime(alternateTarget, lifetime.signal, async (signal) => {
        const discovery = pool.ensureSession(alternateTarget, id, signal)
        await requested.promise
        expect(pool.provideInfoFor(alternateKey)).toBeUndefined()
        listing.resolve(ok({ items: [{ sessionId: id, updatedAt: 1, running: false, blank: false }] }))
        expect(await discovery).toBe(true)
        pool.setAdditionalStaged([baseKey, alternateKey])
        const alternate = pool.provideInfoFor(alternateKey)
        expect(alternate?.sessionId).toBe(alternateKey)
        expect(seen.at(-1)).toBe(alternate)
        expect(pool.currentProvideInfo.getSnapshot()).toBe(current)
        await pool.using(alternateKey, { source: 'controllerOperation' }, () => {})
      })
      operations.push(restore)
      await restore
      expect(pool.provideInfoFor(alternateKey)).toBeDefined()
      const settled = revisions.length
      await pool.refresh()
      expect(revisions).toHaveLength(settled)
      const beforeRelease = revisions.length
      pool.setAdditionalStaged([baseKey])
      expect(pool.provideInfoFor(alternateKey)).toBeUndefined()
      expect(seen.at(-1)).toBeUndefined()
      expect(revisions.length).toBeGreaterThan(beforeRelease)
      expect(pool.currentProvideInfo.getSnapshot()).toBe(current)
      const withdrawn: (SessionProvideInfo | undefined)[] = []
      const stopWithdrawal = source.subscribe(() => { withdrawn.push(pool.provideInfoFor(baseKey)) })
      try {
        pool.invalidateAccount()
        expect(pool.provideInfoFor(baseKey)).toBeUndefined()
        expect(withdrawn.at(-1)).toBeUndefined()
        expect(withdrawn.length).toBeGreaterThan(0)
      } finally { stopWithdrawal() }
      expectIncreasing(revisions)
    } finally {
      stop()
      lifetime.abort()
      listing.resolve(ok({ items: [] }))
      await Promise.allSettled(operations)
      await ctx.fiber.dispose()
    }
  })
})
