/** Unpublished resource reports and early-cancellation capacity use original identities. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { setImmediate } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import { ResourceAdmissionError } from '@deepseek-ai/dsh-resource-budget'
import { expect, it, vi } from 'vitest'
import { SdkParentControl } from '../src/bridge.ts'
import { controlConnection, controlRecord, type SdkControlConfig } from '../src/control.ts'
import { ParentControlClient } from '../src/managed-client.ts'
import { ManagedSdkBudget } from '../src/managed-budget.ts'
import { parentAgent } from './agent-fixture.ts'

const limits: SdkControlConfig = { maxBytes: 4096, maxOperations: 2,
  requestTimeoutMs: 1000, pollMs: 10, cleanupTimeoutMs: 2000 }

it('keeps observing parent cancellation after uncertain resource completion is acknowledged', async () => {
  const ctx = new Context()
  const client = new ParentControlClient({ url: 'http://127.0.0.1:1/', token: 'owned-unit-control-capability', config: limits })
  let observations = 0
  const entered = Promise.withResolvers<undefined>(), observed = Promise.withResolvers<Record<string, unknown>>()
  vi.spyOn(client, 'post').mockImplementation(async (path) => {
    if (path !== '/resource/status') return {}
    if (++observations === 1) return { state: 'granted' }
    entered.resolve(undefined)
    return observed.promise
  })
  const budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  let lease: Awaited<ReturnType<typeof budget.acquire>> | undefined
  try {
    lease = await budget.acquire({ kind: 'process' })
    await entered.promise
    await lease.uncertain()
    observed.resolve({ state: 'cancelled' })
    await setImmediate()
    expect(lease.signal.aborted).toBe(true)
    await lease.release()
  } finally {
    observed.resolve({ state: 'cancelled' })
    await lease?.release()
    await budget.close()
    client.close()
    await ctx.fiber.dispose()
  }
})

it.each(['close', 'next-acquire', 'failed-retry'] as const)('retries an unpublished grant completion during %s after its first acknowledgement fails', async (action) => {
  const parent = new Context(), child = new Context(), caller = new AbortController()
  let recovered = false, held = false, firstGrant = true
  const release = vi.fn(async () => {
    if (!recovered) throw new Error('Owned coordinator temporarily unavailable.')
    held = false
  })
  const uncertain = vi.fn(async () => {})
  const acquire = vi.fn(async () => {
    if (held) throw new ResourceAdmissionError('refused', 'Owned capacity is still occupied.')
    held = true
    return { signal: new AbortController().signal, release, uncertain }
  })
  parent.provide('resourceBudget', { acquire })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'unpublished-resource', parent),
    prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  const budget = new ManagedSdkBudget(child, client, new AsyncLocalStorage())
  const post = client.post.bind(client)
  vi.spyOn(client, 'post').mockImplementation(async (path, body, signal) => {
    const response = await post(path, body, signal)
    if (path === '/resource/status' && response.state === 'granted' && firstGrant) {
      firstGrant = false
      caller.abort(new Error('Caller cancelled before lease publication.'))
    }
    return response
  })
  try {
    await expect(budget.acquire({ kind: 'process', signal: caller.signal })).rejects.toBeInstanceOf(AggregateError)
    expect(held).toBe(true)
    expect(release).toHaveBeenCalledOnce()
    if (action === 'failed-retry') {
      await expect(budget.acquire({ kind: 'process' })).rejects.toBeInstanceOf(AggregateError)
      expect(acquire).toHaveBeenCalledOnce()
    }
    recovered = true
    if (action === 'next-acquire') {
      const lease = await budget.acquire({ kind: 'process' })
      expect(acquire).toHaveBeenCalledTimes(2)
      await lease.release()
    } else await budget.close()
    expect(held).toBe(false)
    expect(release).toHaveBeenCalledTimes(action === 'close' ? 2 : 3)
    expect(uncertain).not.toHaveBeenCalled()
  } finally {
    recovered = true
    await budget.close()
    await control.close()
    client.close()
    await child.fiber.dispose()
    await parent.fiber.dispose()
  }
})

it('reclaims early-cancellation slots after later registrations make the old identities unrepeatable', async () => {
  const ctx = new Context()
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'cancellation-watermark', ctx),
    prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  try {
    for (const cancelled of [1, 3, 5, 7]) {
      await client.post('/resource/finish', { id: String(cancelled), outcome: 'released' })
      const registered = String(cancelled + 1)
      await client.post('/resource/register', { id: registered, kind: 'process' })
      await client.post('/resource/finish', { id: registered, outcome: 'released' })
    }
    await expect(client.post('/resource/register', { id: '1', kind: 'process' })).rejects.toMatchObject({ reason: 'refused' })
  } finally {
    await control.close()
    client.close()
    await ctx.fiber.dispose()
  }
})

it('retains future early cancellations while older registrations advance', async () => {
  const ctx = new Context()
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'future-cancellation', ctx),
    prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  try {
    await client.post('/resource/finish', { id: '3', outcome: 'released' })
    await client.post('/resource/register', { id: '1', kind: 'process' })
    await client.post('/resource/finish', { id: '1', outcome: 'released' })
    await expect(client.post('/resource/register', { id: '3', kind: 'process' })).rejects.toMatchObject({ reason: 'cancelled' })
    await expect(client.post('/resource/register', { id: '3', kind: 'process' })).rejects.toMatchObject({ reason: 'refused' })
    await client.post('/resource/register', { id: '4', kind: 'process' })
    await client.post('/resource/finish', { id: '4', outcome: 'released' })
  } finally {
    await control.close()
    client.close()
    await ctx.fiber.dispose()
  }
})

it('acknowledges repeated cancelled registrations without requiring a successful registration between them', async () => {
  const ctx = new Context(), release = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain: async () => {} }))
  ctx.provide('resourceBudget', { acquire })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'cancelled-registration-prefix', ctx),
    prompt: [], signal: new AbortController().signal }, { ...limits, maxOperations: 1 })
  const { env } = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  try {
    for (let count = 0; count < 4; count++) {
      const cancelled = new AbortController(), reason = new Error('Queued registration cancelled.')
      const pending = client.register('/resource/register', { kind: 'process' }, cancelled.signal)
      cancelled.abort(reason)
      await expect(pending.ready).rejects.toBe(reason)
      await client.post('/resource/finish', { id: pending.id, outcome: 'released' })
    }
    const admitted = client.register('/resource/register', { kind: 'process' })
    await admitted.ready
    await client.post('/resource/finish', { id: admitted.id, outcome: 'released' })
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
  } finally { await control.close(); client.close(); await ctx.fiber.dispose() }
})

it('preserves an older queued grant when a later cancelled registration settles', async () => {
  const ctx = new Context(), grant = Promise.withResolvers<Awaited<ReturnType<ManagedSdkBudget['acquire']>>>()
  const release = vi.fn(async () => {})
  ctx.provide('resourceBudget', { acquire: () => grant.promise })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'registered-wait-survives-prefix', ctx),
    prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  try {
    const waiting = client.register('/resource/register', { kind: 'process' })
    await waiting.ready
    const cancellation = new AbortController(), reason = new Error('Later registration cancelled.')
    const later = client.register('/resource/register', { kind: 'process' }, cancellation.signal)
    cancellation.abort(reason)
    await expect(later.ready).rejects.toBe(reason)
    await client.post('/resource/finish', { id: later.id, outcome: 'released' })
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    expect(await client.post('/resource/status', { id: waiting.id })).toEqual({ state: 'granted' })
    await client.post('/resource/finish', { id: waiting.id, outcome: 'released' })
    expect(release).toHaveBeenCalledOnce()
  } finally {
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    await control.close(); client.close(); await ctx.fiber.dispose()
  }
})

it.each(['/model/close', '/resource/finish'])('rejects malformed registration progress before mutating %s state', async (path) => {
  const ctx = new Context()
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'invalid-registration-prefix', ctx),
    prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  try {
    await expect(client.post(path, { id: '2', outcome: 'released', settledRegistration: 0 })).rejects.toMatchObject({
      reason: 'unavailable', message: 'SDK parent control rejected the request.' })
    await client.post('/resource/register', { id: '1', kind: 'process' })
    await client.post('/resource/finish', { id: '1', outcome: 'released' })
  } finally { await control.close(); client.close(); await ctx.fiber.dispose() }
})

it('wakes joined child shutdown when a consumer proves cleanup before the deadline', async () => {
  const ctx = new Context(), entered = Promise.withResolvers<undefined>()
  const client = new ParentControlClient({ url: 'http://127.0.0.1:1/', token: 'owned-unit-control-capability', config: limits })
  let statuses = 0, closing: Promise<void> | undefined
  vi.spyOn(client, 'post').mockImplementation(async (path, _body, signal) => {
    if (path !== '/resource/status') return {}
    if (++statuses === 1) return { state: 'granted' }
    if (signal === undefined) throw new Error('Watch cancellation is required.')
    const stopped = Promise.withResolvers<never>()
    const abort = (): void => { stopped.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    entered.resolve(undefined)
    try { return await stopped.promise } finally { signal.removeEventListener('abort', abort) }
  })
  const budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const lease = await budget.acquire({ kind: 'process' })
    await entered.promise
    let closed = false
    closing = budget.close().then(() => { closed = true })
    await setImmediate()
    expect(closed).toBe(false)
    await lease.release()
    await setImmediate()
    expect(closed).toBe(true)
    await closing
  } finally {
    await vi.runAllTimersAsync()
    await closing
    client.close()
    vi.useRealTimers()
    await ctx.fiber.dispose()
  }
})

it('includes the final completion exchange in the child shutdown deadline and retains its retry identity', async () => {
  const ctx = new Context()
  const client = new ParentControlClient({ url: 'http://127.0.0.1:1/', token: 'owned-unit-control-capability', config: limits })
  const reports: { id: string; outcome: string }[] = []
  let recovered = false, closed = false, failure: unknown, closing: Promise<void> | undefined
  const exchange = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url)
    expect(url.origin).toBe('http://127.0.0.1:1')
    if (url.pathname === '/resource/finish') {
      if (typeof init?.body !== 'string') throw new Error('Completion requires serialized JSON.')
      const row = controlRecord(JSON.parse(init.body))
      if (typeof row.id !== 'string' || typeof row.outcome !== 'string') throw new Error('Completion requires its identity and outcome.')
      reports.push({ id: row.id, outcome: row.outcome })
      if (!recovered) {
        const signal = init?.signal
        if (signal === undefined || signal === null) throw new Error('Completion must retain transport cancellation.')
        signal.throwIfAborted()
        const waiting = Promise.withResolvers<never>()
        const abort = (): void => { waiting.reject(new Error('Owned stalled completion cancelled.', { cause: signal.reason })) }
        signal.addEventListener('abort', abort, { once: true })
        try { return await waiting.promise } finally { signal.removeEventListener('abort', abort) }
      }
    }
    return new Response(JSON.stringify(url.pathname === '/resource/status' ? { state: 'granted' } : {}))
  })
  const budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const origin = Date.now(), clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - origin)
  let lease: Awaited<ReturnType<typeof budget.acquire>> | undefined
  try {
    lease = await budget.acquire({ kind: 'process' })
    closing = budget.close().then(() => { closed = true }, (error: unknown) => { closed = true; failure = error })
    await setImmediate()
    await vi.advanceTimersByTimeAsync(limits.cleanupTimeoutMs)
    expect(closed).toBe(true)
    expect(failure).toBeInstanceOf(AggregateError)
    expect(reports).toEqual([{ id: '1', outcome: 'uncertain' }])
    recovered = true
    await lease.release()
    expect(reports).toEqual([{ id: '1', outcome: 'uncertain' }, { id: '1', outcome: 'released' }])
  } finally {
    recovered = true
    await vi.runAllTimersAsync()
    await closing
    await lease?.release()
    await budget.close()
    client.close()
    exchange.mockRestore()
    clock.mockRestore()
    vi.useRealTimers()
    await ctx.fiber.dispose()
  }
})

it.each(['before expiry', 'after expiry'])('shares model and resource cleanup deadlines when nested cleanup starts %s', async (phase) => {
  const client = new ParentControlClient({ url: 'http://127.0.0.1:1/', token: 'owned-unit-control-capability', config: limits })
  const model = Promise.withResolvers<undefined>(), resource = Promise.withResolvers<undefined>()
  const joined = Promise.withResolvers<undefined>()
  const deadlines: number[] = []
  let stopped = false, failure: unknown
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  const origin = Date.now(), clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - origin)
  const closing = client.cleanup(async (deadline) => {
    deadlines.push(deadline)
    try {
      await model.promise
      await client.cleanup(async (nested) => { deadlines.push(nested); await resource.promise })
    } finally { joined.resolve(undefined) }
  }).then(() => { stopped = true }, (error: unknown) => { stopped = true; failure = error })
  try {
    await vi.advanceTimersByTimeAsync(1500)
    if (phase === 'before expiry') { model.resolve(undefined); await setImmediate() }
    await vi.advanceTimersByTimeAsync(500)
    expect(stopped).toBe(true)
    expect(failure).toBeInstanceOf(AggregateError)
    if (phase === 'after expiry') model.resolve(undefined)
    resource.resolve(undefined)
    await joined.promise
    expect(deadlines).toEqual(phase === 'before expiry' ? [2000, 2000] : [2000])
    expect(await client.cleanup(async deadline => deadline)).toBe(4000)
  } finally {
    model.resolve(undefined); resource.resolve(undefined)
    await joined.promise
    await closing
    await vi.runAllTimersAsync()
    client.close()
    clock.mockRestore()
    vi.useRealTimers()
  }
})

it('refuses late cleanup admission after the private control connection closes', async () => {
  const client = new ParentControlClient({ url: 'http://127.0.0.1:1/', token: 'owned-unit-control-capability', config: limits })
  const work = vi.fn(async () => {})
  client.close()
  await expect(client.cleanup(work)).rejects.toMatchObject({ reason: 'cancelled' })
  expect(work).not.toHaveBeenCalled()
})
