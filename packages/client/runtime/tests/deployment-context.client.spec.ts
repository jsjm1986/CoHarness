// @vitest-environment jsdom
/** Entry policy refreshes never select an environment, start a Runtime, or share a draft. */
import { afterEach, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { DeploymentContextRuntime } from '../src/client/deployment-context.ts'
import { ProjectUiPolicyRuntime } from '../src/client/project-policy.ts'
import { createSnapshotStore } from '../src/client/contract/store.ts'

const a = '10000000-0000-4000-8000-000000000001'
const b = '10000000-0000-4000-8000-000000000002'
const response = (revision: string, primary = true) => ({ mode: 'multi', revision,
  entry: { nodeId: primary ? a : b, name: primary ? 'A' : 'B' }, primary: { nodeId: a, name: 'A', origin: 'https://primary.test' },
  role: primary ? 'primary' : 'computer', scope: primary ? 'organization' : 'local', refreshAfterMs: 30000, legacyMigrationRequired: false })
const stops: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers()
})
function fixture() {
  const hostDescription = createSnapshotStore({ executionAuthorityRequired: true })
  const policy = new ProjectUiPolicyRuntime(); policy.setVerifiedAccountId(7)
  const forTarget = vi.fn()
  const connection = { hostDescription, forTarget } as unknown as ConnectionHandle
  const runtime = new DeploymentContextRuntime({ requestTimeoutMs: 100, retryAfterMs: 50 })
  stops.push(runtime.start(connection, policy))
  return { runtime, policy, forTarget }
}

it('reads policy from this origin and keeps a secondary entry local even when aggregation is enabled', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(response('1', false)))
  vi.stubGlobal('fetch', fetcher)
  const f = fixture(); await f.runtime.refresh()
  expect(f.runtime.getSnapshot()).toMatchObject({ phase: 'ready', showComputer: true, aggregateComputers: false,
    context: { entry: { nodeId: b }, role: 'computer', scope: 'local' } })
  expect(fetcher.mock.calls[0]?.[0]).toBe('/account/api/deployment/context')
  expect(fetcher.mock.calls[0]?.[1].headers['x-dsh-expected-principal-id']).toBe('7')
  expect(f.forTarget).not.toHaveBeenCalled()
})

it('keeps computer labels while account verification refreshes without retaining account authority', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json(response('1')))))
  const f = fixture(); await f.runtime.refresh()
  f.policy.setVerifiedAccountId(undefined)
  expect(f.runtime.getSnapshot()).toEqual({ phase: 'unknown', showComputer: true, aggregateComputers: false })
  f.policy.setVerifiedAccountId(7)
  expect(f.runtime.getSnapshot()).toEqual({ phase: 'unknown', showComputer: true, aggregateComputers: false })
  await f.runtime.refresh()
  expect(f.runtime.getSnapshot()).toMatchObject({ phase: 'ready', showComputer: true, aggregateComputers: true,
    context: { revision: '1' } })
  expect(f.forTarget).not.toHaveBeenCalled()
})

it('coalesces invalidations during a read and fetches the policy committed after that snapshot', async () => {
  let release!: (value: Response) => void
  const pending = new Promise<Response>((resolve) => { release = resolve })
  const fetcher = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(Response.json({ ...response('2'),
    mode: 'single', scope: 'local', role: 'standalone' }))
  vi.stubGlobal('fetch', fetcher)
  const f = fixture()
  const invalidated = f.runtime.invalidate()
  expect(f.runtime.invalidate()).toBe(invalidated)
  release(Response.json(response('1')))
  await invalidated
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(f.runtime.getSnapshot()).toMatchObject({ phase: 'ready', showComputer: false, aggregateComputers: false,
    context: { revision: '2' } })
  expect(f.forTarget).not.toHaveBeenCalled()
})

it('does not drop a second mode change while the follow-up snapshot is still in flight', async () => {
  const first = Promise.withResolvers<Response>(), second = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    .mockResolvedValue(Response.json(response('3')))
  vi.stubGlobal('fetch', fetcher)
  const f = fixture()
  const invalidated = f.runtime.invalidate()
  first.resolve(Response.json(response('1')))
  await vi.waitFor(() =>{  expect(fetcher).toHaveBeenCalledTimes(2) })
  expect(f.runtime.invalidate()).toBe(invalidated)
  second.resolve(Response.json(response('2')))
  await invalidated
  expect(fetcher).toHaveBeenCalledTimes(3)
  expect(f.runtime.getSnapshot()).toMatchObject({ context: { revision: '3' } })
})

it('refreshes visible metadata on the configured interval and preserves the last verified policy after a failure', async () => {
  vi.useFakeTimers()
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(response('1'))).mockRejectedValue(new TypeError('offline'))
  vi.stubGlobal('fetch', fetcher); vi.spyOn(console, 'error').mockImplementation(() => {})
  const f = fixture(); await f.runtime.refresh()
  await vi.advanceTimersByTimeAsync(30000)
  expect(f.runtime.getSnapshot()).toMatchObject({ phase: 'error', aggregateComputers: true, context: { revision: '1' } })
  expect(fetcher).toHaveBeenCalledTimes(2)
  expect(f.forTarget).not.toHaveBeenCalled()
})

it('times out a stalled initial read, reports it, and retries without waiting for a focus event', async () => {
  vi.useFakeTimers(); vi.spyOn(console, 'error').mockImplementation(() => {})
  const fetcher = vi.fn().mockImplementationOnce((_url, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener('abort', () =>{  reject(new DOMException('Cancelled', 'AbortError')) }, { once: true })
  })).mockResolvedValue(Response.json(response('2')))
  vi.stubGlobal('fetch', fetcher)
  const f = fixture()
  await vi.advanceTimersByTimeAsync(100)
  expect(f.runtime.getSnapshot().phase).toBe('error')
  await vi.advanceTimersByTimeAsync(50)
  expect(f.runtime.getSnapshot()).toMatchObject({ phase: 'ready', context: { revision: '2' } })
})

it('discards a response from the previous account and joins every cancelled request on disposal', async () => {
  let release!: (value: Response) => void
  const pending = new Promise<Response>((resolve) => { release = resolve })
  const fetcher = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(Response.json(response('8')))
  vi.stubGlobal('fetch', fetcher)
  const f = fixture()
  f.policy.setVerifiedAccountId(8)
  await f.runtime.refresh()
  expect(fetcher.mock.calls[1]?.[1].headers['x-dsh-expected-principal-id']).toBe('8')
  let disposed = false
  const stop = stops.shift()!(); void stop.then(() => { disposed = true })
  await Promise.resolve(); expect(disposed).toBe(false)
  release(Response.json(response('1', false))); await stop
  expect(f.runtime.getSnapshot()).toMatchObject({ context: { revision: '8' } })
})

it('broadcasts only invalidate policy and cannot replace another tab’s current environment', async () => {
  const receivers: Array<{ onmessage?: (value: { data: unknown }) => void }> = []
  class Channel {
    onmessage?: (value: { data: unknown }) => void
    constructor() { receivers.push(this) }
    close() {}
  }
  vi.stubGlobal('BroadcastChannel', Channel)
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(Response.json(response('3')))))
  const first = fixture(), second = fixture()
  await Promise.all([first.runtime.refresh(), second.runtime.refresh()])
  receivers[1]!.onmessage?.({ data: { revision: '4', runtimeId: b, draft: 'must not be copied' } })
  await second.runtime.refresh()
  expect(second.runtime.getSnapshot()).toMatchObject({ context: { entry: { nodeId: a } } })
  expect(first.forTarget).not.toHaveBeenCalled(); expect(second.forTarget).not.toHaveBeenCalled()
})

it('coalesces foreground events while rechecking a deployment read that began before focus', async () => {
  const pending = Promise.withResolvers<Response>()
  const fetcher = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(Response.json(response('2')))
  vi.stubGlobal('fetch', fetcher)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const f = fixture()
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  window.dispatchEvent(new Event('focus'))
  expect(fetcher).toHaveBeenCalledTimes(1)
  pending.resolve(Response.json(response('1')))
  await vi.waitFor(() =>{  expect(f.runtime.getSnapshot().context?.revision).toBe('2') })
  expect(fetcher).toHaveBeenCalledTimes(2)
})
