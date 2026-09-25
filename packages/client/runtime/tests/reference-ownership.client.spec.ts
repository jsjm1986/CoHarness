/** Independent Session consumers share opening and own an exact local generation. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionRuntime } from '../src/client/sessions/service.ts'
import { commitSessionNavigation } from '../src/client/navigation.ts'
import { deferred, FakeApiClient, fakeRemote, ok } from './fake-api.client.ts'

const id = 'owned' as SessionId
const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => root.fiber.dispose()))
})

async function bench() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(() => {}).await()
  const api = new FakeApiClient()
  api.onList = () => Promise.resolve(ok({ items: [{ sessionId: id, updatedAt: 1, running: false, blank: true }] }))
  const sessions = new SessionRuntime(ctx, api, fakeRemote(api), undefined, { persistSelection: false })
  await sessions.refresh()
  return { ctx, api, sessions }
}

describe('Session reference ownership', () => {
  it('commits navigation only after history succeeds and transfers ownership to the view', async () => {
    const { api, sessions } = await bench()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const commit = vi.fn(() => { sessions.open(id) })
    const navigation = commitSessionNavigation(sessions, id, sessions.beginNavigation(), commit)
    const generation = sessions.binding(id)
    expect(commit).not.toHaveBeenCalled()
    expect(sessions.list.getSnapshot().current).toBeUndefined()
    history.resolve(ok({ events: [], hasMore: false }))
    await expect(navigation).resolves.toBe(true)
    expect(commit).toHaveBeenCalledOnce()
    expect(sessions.binding(id)).toBe(generation)
    expect(sessions.retainInfo(id).getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { conversation: 1 } })
  })

  it('preserves the view when history rejects and allows a subsequent successful navigation', async () => {
    const { api, sessions } = await bench()
    api.onHistory = () => Promise.resolve({
      rpcId: 'rejected-history' as never,
      result: { ok: false, error: { code: 'collaboration-forbidden', message: 'Session access revoked', details: { action: 'read', reason: 'forbidden' } } },
    })
    const commit = vi.fn()
    await expect(commitSessionNavigation(sessions, id, sessions.beginNavigation(), commit)).rejects.toThrow('Session access revoked')
    expect(commit).not.toHaveBeenCalled()
    expect(sessions.list.getSnapshot().current).toBeUndefined()
    expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(0)
    api.onHistory = () => Promise.resolve(ok({ events: [], hasMore: false }))
    await expect(commitSessionNavigation(sessions, id, sessions.beginNavigation(), () => { sessions.open(id) })).resolves.toBe(true)
    expect(sessions.list.getSnapshot().current).toBe(id)
  })

  it('releases superseded navigation without waiting for the abandoned history response', async () => {
    const { api, sessions } = await bench()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const commit = vi.fn()
    const signal = sessions.beginNavigation()
    const navigation = commitSessionNavigation(sessions, id, signal, commit)
    sessions.beginNavigation()
    await expect(navigation).resolves.toBe(false)
    expect(commit).not.toHaveBeenCalled()
    expect(sessions.binding(id)).toBeUndefined()
    await expect(commitSessionNavigation(sessions, id, signal, commit)).resolves.toBe(false)
    expect(api.callsOf('session.history')).toHaveLength(1)
    history.resolve(ok({ events: [], hasMore: false }))
    await history.promise
    expect(sessions.binding(id)).toBeUndefined()
  })

  it('observes absent identities without creating a scope or starting history', async () => {
    const { api, sessions } = await bench()
    const unknown = 'missing' as SessionId
    const source = sessions.retainInfo(unknown)
    const off = source.subscribe(() => {})
    off()
    expect(sessions.retainInfo(unknown)).toBe(source)
    expect(source.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    expect(sessions.binding(id)).toBeUndefined()
    expect(sessions.scope(id)).toBeUndefined()
    expect(sessions.provideInfoFor(id)).toBeUndefined()
    expect(() => sessions.retain(unknown, { source: 'controllerOperation' })).toThrow('unknown session')
    expect(api.callsOf('session.history')).toHaveLength(0)
  })

  it('shares one opening while each consumer owns an independent reference', async () => {
    const { api, sessions } = await bench()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const source = sessions.retainInfo(id)
    const first = sessions.retain(id, { source: 'controllerOperation' })
    const second = sessions.retain(id, { source: 'workbench' })
    expect(first.binding).toBe(second.binding)
    expect(source.getSnapshot()).toEqual({ referenceCount: 2, retainedBy: { controllerOperation: 1, workbench: 1 } })
    expect(api.callsOf('session.history')).toHaveLength(1)
    first.release()
    first.release()
    await expect(first.ready).rejects.toThrow('released')
    expect(() => first.binding).toThrow('released')
    history.resolve(ok({ events: [], hasMore: false }))
    await expect(second.ready).resolves.toBe(second.binding)
    expect(second.binding.session.getSnapshot().openState).toBe('open')
    expect(source.getSnapshot()).toEqual({ referenceCount: 1, retainedBy: { workbench: 1 } })
    const old = second.binding
    second.release()
    expect(sessions.binding(id)).toBeUndefined()
    expect(sessions.sessionOf(old.ctx)).toBeUndefined()
    expect(source.getSnapshot()).toEqual({ referenceCount: 0, retainedBy: {} })
    expect(api.callsOf('session.cancel')).toHaveLength(0)
    const next = sessions.retain(id, { source: 'controllerOperation' })
    expect(next.binding).not.toBe(old)
    expect(sessions.retainInfo(id)).toBe(source)
    expect(sessions.sessionOf(old.ctx)).toBeUndefined()
    next.release()
  })

  it('coalesces reentrant view selection from a retention observer', async () => {
    const { sessions } = await bench()
    const off = sessions.retainInfo(id).subscribe(() => { sessions.open(id) })
    sessions.open(id)
    expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(1)
    off()
    sessions.clear()
    expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(0)
  })

  it('counts repeated sources without mutating prior snapshots', async () => {
    const { sessions } = await bench()
    const source = sessions.retainInfo(id)
    const first = sessions.retain(id, { source: 'controllerOperation' })
    const previous = source.getSnapshot()
    const second = sessions.retain(id, { source: 'controllerOperation' })
    expect(previous.retainedBy.controllerOperation).toBe(1)
    expect(source.getSnapshot().retainedBy.controllerOperation).toBe(2)
    expect(Object.isFrozen(source.getSnapshot().retainedBy)).toBe(true)
    expect(Object.getPrototypeOf(source.getSnapshot().retainedBy)).toBeNull()
    first.release()
    expect(source.getSnapshot().retainedBy.controllerOperation).toBe(1)
    second[Symbol.dispose]()
    expect(source.getSnapshot().retainedBy.controllerOperation).toBeUndefined()
  })

  it('cancels one readiness waiter without cancelling another owner or leaking listeners', async () => {
    const { api, sessions } = await bench()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const controller = new AbortController()
    const first = sessions.retain(id, { source: 'controllerOperation', signal: controller.signal })
    const second = sessions.retain(id, { source: 'workbench' })
    const reason = new Error('superseded navigation')
    controller.abort(reason)
    await expect(first.ready).rejects.toBe(reason)
    expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(2)
    first.release()
    history.resolve(ok({ events: [], hasMore: false }))
    await expect(second.ready).resolves.toBe(second.binding)
    expect(second.binding.session.getSnapshot().openState).toBe('open')
    second.release()
    expect(() => sessions.retain(id, { source: 'workbench', signal: controller.signal })).toThrow(reason)
    expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(0)
  })

  it('releases operation references on success and synchronous or asynchronous failure', async () => {
    const { sessions } = await bench()
    await expect(sessions.using(id, { source: 'controllerOperation' }, ref => ref.sessionId)).resolves.toBe(id)
    const reason = new Error('operation failed')
    await expect(sessions.using(id, { source: 'controllerOperation' }, () => { throw reason })).rejects.toBe(reason)
    await expect(sessions.using(id, { source: 'controllerOperation' }, () => Promise.reject(reason))).rejects.toBe(reason)
    expect(sessions.retainInfo(id).getSnapshot().referenceCount).toBe(0)
    expect(sessions.binding(id)).toBeUndefined()
  })

  it('invalidates pending references and observers when the root closes', async () => {
    const { ctx, api, sessions } = await bench()
    const history = deferred<Awaited<ReturnType<FakeApiClient['onHistory']>>>()
    api.onHistory = () => history.promise
    const source = sessions.retainInfo(id)
    const changed = vi.fn()
    source.subscribe(changed)
    const reference = sessions.retain(id, { source: 'controllerOperation' })
    const rejected = expect(reference.ready).rejects.toThrow('disposed')
    await ctx.fiber.dispose()
    await rejected
    expect(() => reference.binding).toThrow('released')
    expect(source.getSnapshot().referenceCount).toBe(0)
    expect(changed).toHaveBeenCalledTimes(2)
    expect(() => sessions.retain(id, { source: 'controllerOperation' })).toThrow('disposed')
    history.resolve(ok({ events: [], hasMore: false }))
    reference.release()
  })
})
