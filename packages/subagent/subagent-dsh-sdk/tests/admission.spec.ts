/** SDK process ownership at admission, publication and failed cleanup. */
import { Context } from '@deepseek-ai/cordis'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { ExecutionAuthority, ExecutionInheritance } from '@deepseek-ai/dsh-execution-authority'
import { DeepSeekHarness, HarnessSession, type RunResult } from '@deepseek-ai/dsh-sdk-client'
import { ResourceAdmissionError, ResourceBudget, type ResourceLease, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import Subagents from '@deepseek-ai/dsh-subagent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SdkRunLifetime } from '../src/admission.ts'
import { internals, SdkStartupCleanupError, startSdkRun, type SdkRunSpec } from '../src/run.ts'
import { parentAgent } from './agent-fixture.ts'
import * as Sdk from '../src/index.ts'
import { SdkParentControl } from '../src/bridge.ts'

const spec: SdkRunSpec = {
  profile: 'sdk-minimal', patches: [], dshHome: process.cwd(), cwd: process.cwd(),
  provider: 'fixture', model: 'm', env: {}, initializeTimeoutMs: 1000,
  shutdownTimeoutMs: 1000, disposeEofGraceMs: 1000, disposeGraceMs: 1000,
}

function fixture() {
  const ctx = new Context(), controller = new AbortController()
  const harness = new DeepSeekHarness({ dshBin: import.meta.filename })
  const create = vi.spyOn(internals, 'createHarness').mockReturnValue(harness)
  const start = vi.spyOn(harness, 'start').mockImplementation(async () => {
    const raw = create.mock.calls.at(-1)?.[0].env?.DSH_SDK_PARENT_CONTROL
    if (raw === undefined) return
    const connection = JSON.parse(raw) as { url: string; token: string }
    const response = await fetch(new URL('/runtime/ready', connection.url), { method: 'POST',
      headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: '1' }) })
    if (!response.ok) throw new Error('Mock SDK parent-control acknowledgement failed.')
    await response.body?.cancel()
  })
  const close = vi.spyOn(harness, 'close').mockResolvedValue()
  const directory = vi.spyOn(HarnessSession.prototype, 'setWorkingDirectory').mockResolvedValue(process.cwd())
  const turn = vi.spyOn(HarnessSession.prototype, 'run').mockReturnValue(Promise.withResolvers<RunResult>().promise)
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {}), cancellation = new AbortController()
  const lease: ResourceLease = { signal: cancellation.signal, release, uncertain }
  const acquire = vi.fn(async (_request: ResourceRequest) => lease)
  const withdrawRequirement = ctx.provide('resourceBudgetRequired', true)
  const withdraw = ctx.provide('resourceBudget', { acquire })
  const lifetime = new SdkRunLifetime(ctx, { maxBytes: 1024 * 1024, maxOperations: 64,
    requestTimeoutMs: 1000, pollMs: 100, cleanupTimeoutMs: 2000 })
  const request = { parent: parentAgent(process.cwd(), 'sdk-owned', ctx), prompt: [{ type: 'text' as const, text: 'owned task' }],
    signal: controller.signal }
  const state = { expectedCleanupFailure: false }
  onTestFinished(async () => {
    try {
      const [cleanup] = await Promise.allSettled([ctx.fiber.dispose()])
      if (cleanup?.status === 'rejected' && !state.expectedCleanupFailure) throw cleanup.reason
    } finally { vi.restoreAllMocks() }
  })
  return { ctx, withdraw, withdrawRequirement, controller, cancellation, harness, create, start, close, directory, lease, turn,
    release, uncertain, acquire, lifetime, request, state }
}

it('refuses required SDK process allocation before constructing a client', async () => {
  const f = fixture(), reason = new ResourceAdmissionError('refused', 'Owned process limit reached.')
  f.acquire.mockRejectedValue(reason)
  await expect(f.lifetime.start(f.request, spec)).rejects.toBe(reason)
  expect(f.acquire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'process', origin: 'execution', sessionId: f.request.parent.id }))
  expect(f.create).not.toHaveBeenCalled()
})

it.each([false, true])('requires parent control for authority-only SDK execution with isolated=%s', async (isolated) => {
  const f = fixture(), local = new AsyncLocalStorage<ExecutionInheritance>()
  f.withdraw(); f.withdrawRequirement()
  const scope = { parentSessionId: f.request.parent.id, inputs: [], primaryActorUserId: 7, unverifiedHistory: false }
  const authority = { capture: () => scope,
    runCaptured: <T>(_agent: unknown, saved: ExecutionInheritance, work: () => T): T => local.run(saved, work),
    current: () => local.getStore(),
  } satisfies Pick<ExecutionAuthority, 'capture' | 'runCaptured' | 'current'>
  const owner = isolated ? f.ctx.isolate('executionAuthority') : f.ctx
  owner.provide('executionAuthority', authority)
  const request = { ...f.request, parent: { ...f.request.parent, ctx: owner } }
  const run = await f.lifetime.start(request, spec)
  try {
    expect(f.create.mock.calls.at(-1)?.[0].env?.DSH_SDK_PARENT_CONTROL).toBeTypeOf('string')
    expect(f.create.mock.calls.at(-1)?.[0].env?.DSH_SDK_PARENT_BOOTSTRAP).toBeTypeOf('string')
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.release).not.toHaveBeenCalled()
  } finally { await run.dispose() }
})

it.each(['replaced', 'downgraded'] as const)('refuses a parent resource owner %s during queued SDK startup', async (change) => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>()
  const replacement = vi.fn(async () => { throw new Error('An old SDK start cannot acquire replacement capacity.') })
  f.acquire.mockImplementation(() => { entered.resolve(undefined); return grant.promise })
  const starting = f.lifetime.start(f.request, spec)
  const outcome = starting.then(async (run) => { await run.dispose(); return { started: true } }, (error: unknown) => ({ error }))
  try {
    await entered.promise
    f.withdraw()
    if (change === 'replaced') f.ctx.provide('resourceBudget', { acquire: replacement })
    else f.withdrawRequirement()
    grant.resolve(f.lease)
    expect(await outcome).toMatchObject({ error: { reason: 'unavailable' } })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.uncertain).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  } finally { grant.resolve(f.lease); await outcome }
})

it.each(['replaced', 'downgraded'] as const)('refuses a parent resource owner %s while opening SDK control', async (change) => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- The saved method is invoked with the original control receiver.
  const open = SdkParentControl.prototype.open
  vi.spyOn(SdkParentControl.prototype, 'open').mockImplementation(async function (this: SdkParentControl) {
    const settings = await open.call(this)
    entered.resolve(undefined)
    await proceed.promise
    return settings
  })
  const starting = f.lifetime.start(f.request, spec)
  const outcome = starting.then(async (run) => { await run.dispose(); return { started: true } }, (error: unknown) => ({ error }))
  try {
    await entered.promise
    f.withdraw()
    if (change === 'replaced') f.ctx.provide('resourceBudget', { acquire: f.acquire })
    else f.withdrawRequirement()
    proceed.resolve(undefined)
    expect(await outcome).toMatchObject({ error: { reason: 'unavailable' } })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.uncertain).not.toHaveBeenCalled()
  } finally { proceed.resolve(undefined); await outcome }
})

it.each(['provider', 'requirement'] as const)('refuses newly managed SDK startup before adopting a new $0', async (change) => {
  const f = fixture()
  f.withdraw(); f.withdrawRequirement()
  const starting = f.lifetime.start(f.request, spec)
  if (change === 'provider') f.ctx.provide('resourceBudget', { acquire: f.acquire })
  else f.ctx.provide('resourceBudgetRequired', true)
  await expect(starting).rejects.toMatchObject({ reason: 'unavailable' })
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
})

it('retains a missing initial managed requirement even when it is removed during cleanup', async () => {
  const f = fixture()
  f.withdraw()
  const starting = f.lifetime.start(f.request, spec)
  f.withdrawRequirement()
  await expect(starting).rejects.toMatchObject({ reason: 'unavailable' })
  expect(f.create).not.toHaveBeenCalled()
})

it.each(['construction', 'handshake'] as const)('closes an unpublished SDK child after owner replacement during %s', async (phase) => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const replace = (): void => { f.withdraw(); f.ctx.provide('resourceBudget', { acquire: f.acquire }) }
  if (phase === 'construction') {
    f.create.mockImplementation(() => { replace(); return f.harness })
  } else {
    const start = f.start.getMockImplementation()!
    f.start.mockImplementation(async () => { await start(); entered.resolve(undefined); await proceed.promise })
  }
  const starting = f.lifetime.start(f.request, spec)
  const outcome = starting.then(async (run) => { await run.dispose(); return { started: true } }, (error: unknown) => ({ error }))
  try {
    if (phase === 'handshake') { await entered.promise; replace(); proceed.resolve(undefined) }
    expect(await outcome).toMatchObject({ error: { cause: { reason: 'unavailable' } } })
    expect(f.create).toHaveBeenCalledOnce()
    expect(f.start).toHaveBeenCalledTimes(phase === 'construction' ? 0 : 1)
    expect(f.directory).not.toHaveBeenCalled()
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.uncertain).not.toHaveBeenCalled()
  } finally { proceed.resolve(undefined); await outcome }
})

it.each([false, true])('refuses execution authority replacement during SDK admission with isolated=%s', async (isolated) => {
  const f = fixture(), local = new AsyncLocalStorage<ExecutionInheritance>()
  const scope = { parentSessionId: f.request.parent.id, inputs: [], primaryActorUserId: 7, unverifiedHistory: false }
  const authority = { capture: () => scope,
    runCaptured: <T>(_agent: unknown, saved: ExecutionInheritance, work: () => T): T => local.run(saved, work),
    current: () => local.getStore(),
  } satisfies Pick<ExecutionAuthority, 'capture' | 'runCaptured' | 'current'>
  const owner = isolated ? f.ctx.isolate('executionAuthority') : f.ctx
  const withdraw = owner.provide('executionAuthority', authority)
  const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>()
  f.acquire.mockImplementation(() => { entered.resolve(undefined); return grant.promise })
  const request = { ...f.request, parent: { ...f.request.parent, ctx: owner } }
  const starting = f.lifetime.start(request, spec)
  try {
    await entered.promise
    withdraw(); owner.provide('executionAuthority', { ...authority })
    grant.resolve(f.lease)
    await expect(starting).rejects.toMatchObject({ reason: 'unavailable' })
    expect(f.create).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  } finally { grant.resolve(f.lease); await Promise.allSettled([starting]) }
})

it('retains startup ownership across recovery of an earlier unpublished permit', async () => {
  const f = fixture(), failed = new Error('Original completion failed.')
  vi.spyOn(SdkParentControl.prototype, 'open').mockRejectedValueOnce(new Error('Original control failed.'))
  f.release.mockRejectedValueOnce(failed)
  await expect(f.lifetime.start(f.request, spec)).rejects.toBeInstanceOf(SdkStartupCleanupError)
  const entered = Promise.withResolvers<undefined>(), recovered = Promise.withResolvers<undefined>()
  f.release.mockImplementationOnce(() => { entered.resolve(undefined); return recovered.promise })
  const replacement = vi.fn(async () => f.lease)
  const starting = f.lifetime.start(f.request, spec)
  try {
    await entered.promise
    f.withdraw(); f.ctx.provide('resourceBudget', { acquire: replacement })
    recovered.resolve(undefined)
    await expect(starting).rejects.toMatchObject({ reason: 'unavailable' })
    expect(f.acquire).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
    expect(f.create).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledTimes(2)
  } finally { recovered.resolve(undefined); await Promise.allSettled([starting]) }
})

it.each([false, true])('retains stale unpublished runtime cleanup through its final handoff: cleanupFails=%s', async (cleanupFails) => {
  const f = fixture(), failure = new Error('Original runtime cleanup failed.')
  const initialized = vi.fn(() => { queueMicrotask(() => {
    f.withdraw(); f.ctx.provide('resourceBudget', { acquire: f.acquire })
  }) })
  if (cleanupFails) f.close.mockRejectedValueOnce(failure)
  const starting = f.lifetime.start(f.request, { ...spec, onInitialized: initialized })
  if (cleanupFails) await expect(starting).rejects.toBeInstanceOf(SdkStartupCleanupError)
  else await expect(starting).rejects.toMatchObject({ reason: 'unavailable' })
  expect(initialized).toHaveBeenCalledOnce()
  expect(f.create).toHaveBeenCalledOnce()
  expect(f.turn).not.toHaveBeenCalled()
  await f.ctx.fiber.dispose()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.uncertain).toHaveBeenCalledTimes(cleanupFails ? 1 : 0)
})

it('checks ownership before dispatching the first SDK turn after directory configuration', async () => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), configured = Promise.withResolvers<undefined>()
  f.directory.mockImplementation(async () => { entered.resolve(undefined); await configured.promise; return process.cwd() })
  const run = await f.lifetime.start(f.request, spec)
  try {
    await entered.promise
    f.withdraw(); f.ctx.provide('resourceBudget', { acquire: f.acquire })
    configured.resolve(undefined)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'error' })
    expect(f.turn).not.toHaveBeenCalled()
    await run.dispose()
    expect(f.release).toHaveBeenCalledOnce()
    expect(f.uncertain).not.toHaveBeenCalled()
  } finally { configured.resolve(undefined); await run.dispose() }
})

it('preserves a caller ownership assertion and returns its unused process permit', async () => {
  const f = fixture(), failure = new Error('Additional ownership refused.')
  const assertOwnership = vi.fn(() => { throw failure })
  await expect(f.lifetime.start(f.request, { ...spec, assertOwnership })).rejects.toBe(failure)
  expect(assertOwnership).toHaveBeenCalledOnce()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
})

it.each(['cancelled', 'replaced'] as const)('rechecks a startup owner changed by a caller assertion: %s', async (change) => {
  const f = fixture(), reason = new ResourceAdmissionError('cancelled', 'Caller cancelled during ownership verification.')
  const opening = vi.spyOn(SdkParentControl.prototype, 'open')
  const assertOwnership = vi.fn(() => {
    if (change === 'cancelled') f.controller.abort(reason)
    else { f.withdraw(); f.ctx.provide('resourceBudget', { acquire: f.acquire }) }
  })
  await expect(f.lifetime.start(f.request, { ...spec, assertOwnership }))
    .rejects.toMatchObject({ reason: change === 'cancelled' ? 'cancelled' : 'unavailable' })
  expect(assertOwnership).toHaveBeenCalledOnce()
  expect(opening).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
})

it('retains a live resource Service through fresh Cordis startup tracing proxies', async () => {
  const f = fixture()
  f.withdraw()
  class Budget extends ResourceBudget {
    override acquire(request: ResourceRequest): Promise<ResourceLease> { return f.acquire(request) }
  }
  await f.ctx.plugin(Budget)
  const run = await f.lifetime.start(f.request, spec)
  await run.dispose()
  expect(f.create).toHaveBeenCalledOnce()
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledOnce()
})

it('refuses an absent required provider and an already cancelled caller before constructing a client', async () => {
  const f = fixture()
  f.withdraw()
  await expect(f.lifetime.start(f.request, spec)).rejects.toMatchObject({ reason: 'unavailable' })
  f.controller.abort('caller cancelled')
  await expect(f.lifetime.start(f.request, spec)).rejects.toBe('caller cancelled')
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
})

it('retains a process permit until SDK cleanup confirms exit and shares disposal', async () => {
  const f = fixture(), closing = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  f.close.mockImplementation(() => { entered.resolve(undefined); return closing.promise })
  const run = await f.lifetime.start(f.request, spec)
  expect(f.release).not.toHaveBeenCalled()
  const disposal = run.dispose()
  expect(run.dispose()).toBe(disposal)
  await entered.promise
  expect(f.release).not.toHaveBeenCalled()
  closing.resolve(undefined)
  await disposal
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.uncertain).not.toHaveBeenCalled()
  expect((await run.result).stopReason).toBe('aborted')
})

it('retries the original published runtime permit after cleanup accounting recovers', async () => {
  const f = fixture(), failure = new Error('Accountant temporarily unavailable.')
  f.release.mockRejectedValueOnce(failure)
  const run = await f.lifetime.start(f.request, spec)
  await expect(run.dispose()).rejects.toMatchObject({ cause: failure })
  await Promise.all([run.dispose(), run.dispose()]); await run.dispose()
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.create).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledTimes(2)
  expect(f.uncertain).not.toHaveBeenCalled()
})

it('joins a late grant during provider unload without constructing a client', async () => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>()
  f.acquire.mockImplementation(() => { entered.resolve(undefined); return grant.promise })
  const starting = f.lifetime.start(f.request, spec)
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = f.ctx.fiber.dispose()
    grant.resolve(f.lease)
    await expect(starting).rejects.toMatchObject({ reason: 'cancelled' })
    await closing
    expect(f.create).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  } finally { grant.resolve(f.lease); await Promise.allSettled([starting, closing]) }
})

it('withdraws a published child on lease cancellation and joins its cleanup on unload', async () => {
  const f = fixture(), closing = Promise.withResolvers<undefined>(), entered = Promise.withResolvers<undefined>()
  f.close.mockImplementation(() => { entered.resolve(undefined); return closing.promise })
  const run = await f.lifetime.start(f.request, spec)
  f.cancellation.abort('owned permit withdrawn')
  await entered.promise
  expect(f.release).not.toHaveBeenCalled()
  const unloading = f.ctx.fiber.dispose()
  closing.resolve(undefined)
  await unloading
  await run.dispose()
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledOnce()
})

it('returns an unused process permit when SDK construction fails', async () => {
  const f = fixture(), reason = new Error('Owned invalid launch configuration.')
  f.create.mockImplementation(() => { throw reason })
  await expect(f.lifetime.start(f.request, spec)).rejects.toBe(reason)
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.close).not.toHaveBeenCalled()
})

it('preserves construction and unused-permit release failures', async () => {
  const f = fixture(), reason = new Error('Owned construction failure.'), accounting = new Error('Owned release failure.')
  f.create.mockImplementation(() => { throw reason })
  f.release.mockRejectedValue(accounting)
  await expect(f.lifetime.start(f.request, spec)).rejects.toMatchObject({ errors: [reason, accounting] })
})

it('releases failed startup only after confirmed SDK cleanup', async () => {
  const f = fixture()
  f.start.mockRejectedValue(new Error('Owned handshake failure.'))
  await expect(f.lifetime.start(f.request, spec)).rejects.toThrow('stage: initialize')
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.uncertain).not.toHaveBeenCalled()
})

it('retains failed startup accounting for provider teardown after the runtime has exited', async () => {
  const f = fixture(), accounting = new Error('Owned startup completion unavailable.')
  f.start.mockRejectedValueOnce(new Error('Owned handshake failure.'))
  f.release.mockRejectedValueOnce(accounting)
  await expect(f.lifetime.start(f.request, spec)).rejects.toBeInstanceOf(AggregateError)
  expect(f.release).toHaveBeenCalledOnce()
  await f.ctx.fiber.dispose()
  expect(f.release).toHaveBeenCalledTimes(2)
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.create).toHaveBeenCalledOnce()
  expect(f.uncertain).not.toHaveBeenCalled()
})

it('recovers the original failed startup permit before admitting another runtime', async () => {
  const f = fixture(), order: string[] = []
  let reports = 0
  f.acquire.mockImplementation(async () => { order.push('acquire'); return f.lease })
  f.start.mockRejectedValueOnce(new Error('Owned handshake failure.'))
  f.release.mockImplementation(async () => {
    if (++reports === 1) { order.push('failed-completion'); throw new Error('Owned startup completion unavailable.') }
    order.push('acknowledged-completion')
  })
  await expect(f.lifetime.start(f.request, spec)).rejects.toBeInstanceOf(AggregateError)
  const run = await f.lifetime.start(f.request, spec)
  expect(order).toEqual(['acquire', 'failed-completion', 'acknowledged-completion', 'acquire'])
  await run.dispose()
  expect(f.acquire).toHaveBeenCalledTimes(2)
})

it.each(['control', 'construction', 'initialize'] as const)('recovers retained %s startup cleanup before a replacement', async (stage) => {
  const f = fixture(), failure = new Error('Owned startup refusal.')
  if (stage === 'control') vi.spyOn(SdkParentControl.prototype, 'open').mockRejectedValueOnce(failure)
  else if (stage === 'construction') f.create.mockImplementationOnce(() => { throw failure })
  else f.start.mockRejectedValueOnce(failure)
  f.release.mockRejectedValueOnce(new Error('Owned completion unavailable.'))
  await expect(f.lifetime.start(f.request, spec)).rejects.toBeInstanceOf(SdkStartupCleanupError)
  const run = await f.lifetime.start(f.request, spec)
  expect(f.acquire).toHaveBeenCalledTimes(2)
  expect(f.release).toHaveBeenCalledTimes(2)
  await run.dispose()
})

it('refuses replacement while original startup cleanup still fails, then recovers that same permit', async () => {
  const f = fixture(), offline = new Error('Owned completion unavailable.')
  f.start.mockRejectedValueOnce(new Error('Owned startup refusal.'))
  f.release.mockRejectedValue(offline)
  await expect(f.lifetime.start(f.request, spec)).rejects.toBeInstanceOf(SdkStartupCleanupError)
  await expect(f.lifetime.start(f.request, spec)).rejects.toMatchObject({ errors: [offline] })
  expect(f.acquire).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce()
  f.release.mockResolvedValue(undefined)
  const run = await f.lifetime.start(f.request, spec)
  expect(f.release).toHaveBeenCalledTimes(3)
  await run.dispose()
})

it('does not allocate a replacement when its caller cancels while original startup cleanup is recovering', async () => {
  const f = fixture(), entered = Promise.withResolvers<undefined>(), acknowledged = Promise.withResolvers<undefined>()
  f.start.mockRejectedValueOnce(new Error('Owned startup refusal.'))
  f.release.mockRejectedValueOnce(new Error('Owned completion unavailable.'))
  await expect(f.lifetime.start(f.request, spec)).rejects.toBeInstanceOf(SdkStartupCleanupError)
  f.release.mockImplementation(async () => { entered.resolve(undefined); await acknowledged.promise })
  const starting = f.lifetime.start(f.request, spec)
  try {
    await entered.promise
    f.controller.abort('caller cancelled during recovery')
    acknowledged.resolve(undefined)
    await expect(starting).rejects.toBe('caller cancelled during recovery')
    expect(f.acquire).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce()
    expect(f.release).toHaveBeenCalledTimes(2)
  } finally { acknowledged.resolve(undefined); await Promise.allSettled([starting]) }
})

it('shares failed startup cleanup attempts and preserves acknowledged success', async () => {
  const entered = Promise.withResolvers<undefined>(), report = Promise.withResolvers<undefined>()
  const retry = vi.fn(async () => { entered.resolve(undefined); await report.promise })
  const failure = new SdkStartupCleanupError(new Error('Owned startup failure.'), retry)
  const pending = failure.cleanup()
  expect(failure.cleanup()).toBe(pending)
  await entered.promise
  report.reject(new Error('Owned completion unavailable.'))
  await expect(pending).rejects.toThrow('Owned completion unavailable.')
  retry.mockResolvedValue(undefined)
  await Promise.all([failure.cleanup(), failure.cleanup()]); await failure.cleanup()
  expect(retry).toHaveBeenCalledTimes(2)
})

it('transfers unused-permit cleanup when an already cancelled start cannot acknowledge release', async () => {
  const f = fixture()
  f.controller.abort('already cancelled')
  f.release.mockRejectedValueOnce(new Error('Owned completion unavailable.'))
  const failure = await startSdkRun(f.request, spec, f.lease).then(() => { throw new Error('Cancelled SDK start unexpectedly published') },
    (error: unknown) => { if (!(error instanceof SdkStartupCleanupError)) throw error; return error })
  await failure.cleanup()
  expect(f.create).not.toHaveBeenCalled(); expect(f.release).toHaveBeenCalledTimes(2)
})

it('retains uncertain occupancy when failed startup cannot confirm cleanup', async () => {
  const f = fixture()
  f.start.mockRejectedValue(new Error('Owned handshake failure.'))
  f.close.mockRejectedValue(new Error('Owned unconfirmed process cleanup.'))
  await expect(f.lifetime.start(f.request, spec)).rejects.toBeInstanceOf(AggregateError)
  expect(f.release).not.toHaveBeenCalled()
  expect(f.uncertain).toHaveBeenCalledOnce()
})

it('preserves cleanup and uncertain-accounting failures after publication', async () => {
  const f = fixture(), cleanup = new Error('Owned process cleanup failure.'), accounting = new Error('Owned accounting failure.')
  const run = await f.lifetime.start(f.request, spec)
  f.state.expectedCleanupFailure = true
  f.close.mockRejectedValue(cleanup)
  f.uncertain.mockRejectedValue(accounting)
  await expect(run.dispose()).rejects.toMatchObject({ cause: { errors: [cleanup, accounting] } })
  expect(f.release).not.toHaveBeenCalled()
})

it('returns an already-aborted transferred permit without constructing an SDK client', async () => {
  const f = fixture()
  f.controller.abort('caller cancelled')
  await expect(startSdkRun(f.request, spec, f.lease)).rejects.toThrow('aborted before the SDK child started')
  expect(f.release).toHaveBeenCalledOnce()
  expect(f.create).not.toHaveBeenCalled()
})

it('reaps a child cancelled while its first activity is being published', async () => {
  const f = fixture()
  f.directory.mockImplementation(async () => {
    f.controller.abort('withdrawn during first activity')
    return process.cwd()
  })
  await expect(f.lifetime.start(f.request, spec)).rejects.toBe('withdrawn during first activity')
  expect(f.close).toHaveBeenCalledOnce()
  expect(f.release).toHaveBeenCalledOnce()
})

it('retains uncertain occupancy when cancellation races an unconfirmed startup cleanup', async () => {
  const f = fixture(), entered = Promise.withResolvers<undefined>()
  f.start.mockImplementation(() => { entered.resolve(undefined); return Promise.withResolvers<undefined>().promise })
  f.close.mockRejectedValue(new Error('Owned unconfirmed process cleanup.'))
  const starting = f.lifetime.start(f.request, spec)
  await entered.promise
  f.controller.abort('caller cancelled')
  await expect(starting).rejects.toBeInstanceOf(AggregateError)
  expect(f.release).not.toHaveBeenCalled()
  expect(f.uncertain).toHaveBeenCalledOnce()
})

it('preserves the initialization cause when the SDK already reported a cleanup aggregate', async () => {
  const f = fixture(), original = new Error('Owned handshake failure.'), cleanup = new Error('Owned unconfirmed process cleanup.')
  f.start.mockRejectedValue(new AggregateError([original, cleanup]))
  f.close.mockRejectedValue(cleanup)
  await expect(f.lifetime.start(f.request, spec)).rejects.toMatchObject({ errors: [
    expect.objectContaining({ cause: original }),
    expect.objectContaining({ cause: cleanup }),
  ] })
  expect(f.uncertain).toHaveBeenCalledOnce()
})

it('reports automatic cleanup failure while keeping the child owned for provider teardown', async () => {
  const f = fixture(), warned = Promise.withResolvers<undefined>()
  vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => { warned.resolve(undefined) })
  const run = await f.lifetime.start(f.request, spec)
  f.state.expectedCleanupFailure = true
  f.close.mockRejectedValue(new Error('Owned process cleanup failure.'))
  f.cancellation.abort('permit withdrawn')
  await warned.promise
  expect(f.uncertain).toHaveBeenCalledOnce()
  await expect(run.dispose()).rejects.toThrow('stage: shutdown')
  expect(f.uncertain).toHaveBeenCalledTimes(2)
})

it('defers the same-version default SDK executable to the SDK client after admission', async () => {
  const f = fixture()
  provideWorkingDirectoryFixture(f.ctx)
  await f.ctx.plugin(Subagents)
  await f.ctx.plugin(Sdk, { providerName: 'sdk-owned', profile: 'sdk-minimal', patches: [],
    dshHome: process.cwd(), provider: 'fixture', model: 'm', env: {},
  })
  const run = await f.ctx.subagents.start('sdk-owned', f.request)
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.create.mock.calls[0]?.[0]).not.toHaveProperty('dshBin')
  await run.dispose()
})

it.each([false, true])('retains original execution scope before SDK process admission with an isolated owner=%s', async (isolated) => {
  const f = fixture(), local = new AsyncLocalStorage<ExecutionInheritance>()
  const scope = { parentSessionId: f.request.parent.id, inputs: [], primaryActorUserId: 7, unverifiedHistory: false }
  const capture = vi.fn(() => scope)
  const authority = { capture,
    runCaptured: <T>(_agent: unknown, saved: ExecutionInheritance, work: () => T): T => local.run(saved, work),
    current: () => local.getStore(),
  } satisfies Pick<ExecutionAuthority, 'capture' | 'runCaptured' | 'current'>
  const owner = isolated ? f.ctx.isolate('executionAuthority') : f.ctx
  owner.provide('executionAuthority', authority)
  const request = { ...f.request, parent: { ...f.request.parent, ctx: owner } }
  f.acquire.mockImplementation(async () => {
    expect(capture).toHaveBeenCalledExactlyOnceWith(request.parent)
    expect(local.getStore()).toBe(scope)
    return f.lease
  })
  const run = await f.lifetime.start(request, spec)
  await run.dispose()
  expect(f.release).toHaveBeenCalledOnce()
})

it('owns managed policy-only SDK cleanup without inventing a parent resource permit', async () => {
  const f = fixture()
  f.withdraw()
  f.withdrawRequirement()
  f.ctx.provide('modelAccess', { decide: () => ({ allowed: true }) })
  const run = await f.lifetime.start(f.request, spec)
  expect(f.create.mock.calls[0]?.[0].env?.DSH_SDK_PARENT_CONTROL).toBeTypeOf('string')
  expect(f.acquire).not.toHaveBeenCalled()
  await run.dispose()
  expect(f.release).not.toHaveBeenCalled()
})

it.each([false, true])('retains control-start failure and failed unused-permit cleanup: cleanupFails=%s', async (cleanupFails) => {
  const f = fixture(), failure = new Error('Owned control listener failure.'), cleanup = new Error('Owned unused-permit release failure.')
  vi.spyOn(SdkParentControl.prototype, 'open').mockRejectedValue(failure)
  if (cleanupFails) f.release.mockRejectedValue(cleanup)
  if (cleanupFails) await expect(f.lifetime.start(f.request, spec)).rejects.toMatchObject({ errors: [failure, cleanup] })
  else await expect(f.lifetime.start(f.request, spec)).rejects.toBe(failure)
  expect(f.create).not.toHaveBeenCalled()
  expect(f.release).toHaveBeenCalledOnce()
})

it.each(['released', 'uncertain'] as const)('preserves both failed control and process reports during %s cleanup', async (outcome) => {
  const f = fixture(), controlFailure = new Error('Owned control close failure.'), processFailure = new Error('Owned process report failure.')
  const run = await f.lifetime.start(f.request, spec)
  const closing = vi.spyOn(SdkParentControl.prototype, 'close').mockRejectedValue(controlFailure)
  f.state.expectedCleanupFailure = true
  if (outcome === 'released') f.release.mockRejectedValue(processFailure)
  else { f.close.mockRejectedValue(new Error('Owned unconfirmed process cleanup.')); f.uncertain.mockRejectedValue(processFailure) }
  try {
    await expect(run.dispose()).rejects.toThrow()
    expect(outcome === 'released' ? f.release : f.uncertain).toHaveBeenCalledOnce()
  } finally {
    const owners = closing.mock.contexts.filter((owner): owner is SdkParentControl => owner instanceof SdkParentControl)
    closing.mockRestore()
    await Promise.all(owners.map(owner => owner.close()))
  }
})

it('uses the initiating Agent resource realm instead of the provider registration realm', async () => {
  const f = fixture(), scope = f.ctx.isolate('resourceBudget')
  const refusal = new ResourceAdmissionError('refused', 'Scoped process capacity exhausted')
  const scopedAcquire = vi.fn(async () => { throw refusal })
  scope.provide('resourceBudget', { acquire: scopedAcquire })
  const request = { ...f.request, parent: { ...f.request.parent, ctx: scope } }
  await expect(f.lifetime.start(request, spec)).rejects.toBe(refusal)
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.create).not.toHaveBeenCalled()
})

it('installs child control for a policy isolated below an independent provider', async () => {
  const f = fixture(), owner = f.ctx.isolate('modelAccess')
  f.withdraw()
  f.withdrawRequirement()
  owner.provide('modelAccess', { decide: () => ({ allowed: false, reason: 'Scoped models refused' }) })
  const request = { ...f.request, parent: { ...f.request.parent, ctx: owner } }
  const run = await f.lifetime.start(request, spec)
  expect(f.create.mock.calls[0]?.[0].env?.DSH_SDK_PARENT_CONTROL).toBeTypeOf('string')
  expect(f.acquire).not.toHaveBeenCalled()
  await run.dispose()
})
