/** Fetch observation ownership across overlapping Inspector lifetimes. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installFetchObserver, type FetchObserver } from '../src/host/inspection/network.ts'

const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'fetch')
const owners: FetchObserver[] = []
const limits = { maxRequestBodyBytes: 1024, maxResponseBodyBytes: 1024, maxChunkBytes: 128 }

afterEach(async () => {
  try { await Promise.all(owners.splice(0).map(owner => owner.stop())) }
  finally {
    if (originalDescriptor === undefined) Reflect.deleteProperty(globalThis, 'fetch')
    else Object.defineProperty(globalThis, 'fetch', originalDescriptor)
    vi.restoreAllMocks()
  }
})

function observe() {
  const publish = vi.fn()
  const owner = installFetchObserver({ publish }, limits)
  owners.push(owner)
  return { owner, publish, fetch: globalThis.fetch }
}

describe('retired fetch observation', () => {
  it.each([
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ])('restores live descriptors after disposal order %s → %s → %s', async (...order) => {
    const native = vi.fn(async () => new Response(null, { status: 204 }))
    const descriptor = { value: native, enumerable: false, writable: true, configurable: true }
    Object.defineProperty(globalThis, 'fetch', descriptor)
    const instances = [observe(), observe(), observe()]
    const live = new Set([0, 1, 2])
    for (const index of order) {
      await instances[index]!.owner.stop()
      live.delete(index)
      const latest = [...live].at(-1)
      expect(globalThis.fetch).toBe(latest === undefined ? native : instances[latest]!.fetch)
    }
    expect(Object.getOwnPropertyDescriptor(globalThis, 'fetch')).toEqual(descriptor)
  })

  it('delegates through a stopped inner observer without publishing to its retired source', async () => {
    const native = vi.fn(async () => new Response(null, { status: 204 }))
    Object.defineProperty(globalThis, 'fetch', { value: native, configurable: true, writable: true })
    const inner = observe(), outer = observe()
    await inner.owner.stop()
    const response = await fetch('https://example.test/live-outer')
    expect(response.status).toBe(204)
    await outer.owner.stop()
    expect(inner.publish).not.toHaveBeenCalled()
    expect(outer.publish).toHaveBeenCalledWith('fetch/start', expect.anything())
    expect(native).toHaveBeenCalledOnce()
  })

  it('keeps a retained stopped fetch reference inert and preserves caller arguments', async () => {
    const native = vi.fn(async () => new Response(null, { status: 204 }))
    Object.defineProperty(globalThis, 'fetch', { value: native, configurable: true, writable: true })
    const captured = observe()
    await captured.owner.stop()
    const input = new URL('https://example.test/retained'), init = { method: 'POST', body: 'caller body' }
    expect((await captured.fetch(input, init)).status).toBe(204)
    expect(captured.publish).not.toHaveBeenCalled()
    expect(native).toHaveBeenCalledExactlyOnceWith(input, init)
  })

  it.each([
    { mode: 'response', body: null }, { mode: 'response', body: 'late caller body' }, { mode: 'error', body: null },
  ])('does not resume observation after late native $mode settlement with body $body', async ({ mode, body }) => {
    const waiting = Promise.withResolvers<Response>()
    const native = vi.fn(async () => waiting.promise)
    Object.defineProperty(globalThis, 'fetch', { value: native, configurable: true, writable: true })
    const captured = observe(), reason = new Error('late native refusal')
    const pending = captured.fetch('https://example.test/pending')
    const outcome = Promise.allSettled([pending])
    await captured.owner.stop()
    const published = captured.publish.mock.calls.length
    if (mode === 'response') waiting.resolve(new Response(body, { status: body === null ? 204 : 200 }))
    else waiting.reject(reason)
    const [settled] = await outcome
    expect(settled).toMatchObject(mode === 'response' ? { status: 'fulfilled', value: { status: body === null ? 204 : 200 } }
      : { status: 'rejected', reason })
    if (settled?.status === 'fulfilled') expect(await settled.value.text()).toBe(body ?? '')
    expect(captured.publish).toHaveBeenCalledTimes(published)
  })
})
