/** Model dispatch retains its actual resource provider across queued admission. */
import { Context } from '@deepseek-ai/cordis'
import { ResourceAdmissionError, type ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '../src/index.ts'
import { assertResourceOwner, captureResourceOwner } from '../src/resource-owner.ts'

it.each([
  ['unavailable', 'RESOURCE_BUDGET_UNAVAILABLE'], ['cancelled', 'ABORTED'],
  ['expired', 'RESOURCE_ADMISSION_EXPIRED'], ['refused', 'RESOURCE_ADMISSION_REFUSED'],
] as const)('retains %s admission failure before model dispatch', async (reason, code) => {
  const ctx = new Context(), dispatched = vi.fn()
  try {
    await ctx.plugin(LlmRuntime)
    ctx.provide('resourceBudgetRequired', true)
    ctx.provide('resourceBudget', { acquire: async () => { throw new ResourceAdmissionError(reason, 'Model admission unavailable.') } })
    class Adapter extends LlmAdapter {
      override async *stream() { dispatched(); yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['model-admission'], new Adapter()))
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'model-admission', model: 'm', messages: [] })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: reason === 'cancelled' ? 'aborted' : 'error',
      failure: { message: 'Model admission unavailable.', code } } }])
    expect(dispatched).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose() }
})

it.each(['withdrawn', 'replaced'] as const)('refuses a resource owner %s during queued model admission', async (change) => {
  const ctx = new Context(), entered = Promise.withResolvers<undefined>()
  const grant = Promise.withResolvers<ResourceLease>(), release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const dispatch = vi.fn(), nextAcquire = vi.fn(async () => { throw new Error('An old request cannot migrate to a replacement provider.') })
  const lease = { signal: new AbortController().signal, release, uncertain }
  let result: Promise<StreamChunk[]> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    ctx.provide('resourceBudgetRequired', true)
    const withdraw = ctx.provide('resourceBudget', { acquire: async () => {
      entered.resolve(undefined)
      return grant.promise
    } })
    class Adapter extends LlmAdapter {
      override async *stream() { dispatch(); yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['owned-resource-route'], new Adapter()))
    result = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of ctx.llm.stream({ provider: 'owned-resource-route', model: 'm', messages: [],
        sessionId: SessionId('queued-resource-owner'), resourceOrigin: 'execution' })) chunks.push(chunk)
      return chunks
    })()
    await Promise.race([entered.promise, result.then(() => { throw new Error('The model must wait for admission.') })])
    withdraw()
    if (change === 'replaced') ctx.provide('resourceBudget', { acquire: nextAcquire })
    grant.resolve(lease)
    const chunks = await result
    expect(dispatch).not.toHaveBeenCalled()
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'RESOURCE_BUDGET_UNAVAILABLE' } } })
    expect(release).toHaveBeenCalledOnce()
    expect(uncertain).not.toHaveBeenCalled()
    expect(nextAcquire).not.toHaveBeenCalled()
  } finally { grant.resolve(lease); await result; await ctx.fiber.dispose() }
})

it.each(['middleware', 'preparation', 'authorization', 'physical-request'] as const)(
  'refuses resource replacement while waiting in %s', async (phase) => {
    const ctx = new Context(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {}), wire = vi.fn()
    const acquire = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain }))
    const replacement = vi.fn(async () => { throw new Error('The old call cannot borrow new capacity.') })
    let result: Promise<StreamChunk[]> | undefined
    const wait = async (): Promise<void> => { entered.resolve(undefined); await proceed.promise }
    try {
      await ctx.plugin(LlmRuntime)
      ctx.provide('resourceBudgetRequired', true)
      const withdraw = ctx.provide('resourceBudget', { acquire })
      class Adapter extends LlmAdapter {
        override async resolveModel(provider: string, model: string) {
          if (phase === 'preparation') await wait()
          return { provider, id: model, name: model }
        }
        override async *stream(_options: Parameters<LlmAdapter['stream']>[0], dispatch?: Parameters<LlmAdapter['stream']>[1]) {
          if (phase === 'physical-request') await wait()
          if (dispatch === undefined) throw new Error('The model must carry its physical request guard.')
          await dispatch(async () => { wire() })
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        }
      }
      ctx.effect(() => ctx.llm.registerAdapter(['resource-transition'], new Adapter()))
      if (phase === 'middleware') ctx.on('llm/stream', (_options, next) => (async function* () { await wait(); yield* next() })())
      if (phase === 'authorization') ctx.on('llm/pre-dispatch', async (_options, next) => { await wait(); await next() })
      result = (async () => {
        const chunks: StreamChunk[] = []
        for await (const chunk of ctx.llm.stream({ provider: 'resource-transition', model: 'm', messages: [] })) chunks.push(chunk)
        return chunks
      })()
      await Promise.race([entered.promise, result.then(() => { throw new Error('The model did not reach its controlled wait.') })])
      withdraw(); ctx.provide('resourceBudget', { acquire: replacement }); proceed.resolve(undefined)
      expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'RESOURCE_BUDGET_UNAVAILABLE' } } })
      expect(wire).not.toHaveBeenCalled()
      expect(acquire).toHaveBeenCalledTimes(phase === 'middleware' || phase === 'preparation' ? 0 : 1)
      expect(release).toHaveBeenCalledTimes(phase === 'middleware' || phase === 'preparation' ? 0 : 1)
      expect(uncertain).not.toHaveBeenCalled()
      expect(replacement).not.toHaveBeenCalled()
    } finally { proceed.resolve(undefined); await result; await ctx.fiber.dispose() }
  },
)

it('retains standalone resource absence and refuses a later provider or managed requirement', async () => {
  const ctx = new Context()
  try {
    const captured = captureResourceOwner(ctx)
    expect(captured).toEqual({ owner: undefined, required: false })
    expect(() => { assertResourceOwner(ctx, captured) }).not.toThrow()
    const requirement = ctx.provide('resourceBudgetRequired', true)
    expect(() => { assertResourceOwner(ctx, captured) }).toThrow(expect.objectContaining({ code: 'RESOURCE_BUDGET_UNAVAILABLE' }))
    const required = captureResourceOwner(ctx)
    requirement()
    expect(() => { assertResourceOwner(ctx, required) }).toThrow(expect.objectContaining({ code: 'RESOURCE_BUDGET_UNAVAILABLE' }))
    ctx.provide('resourceBudget', { acquire: async () => { throw new Error('No old call may acquire from this provider.') } })
    expect(() => { assertResourceOwner(ctx, captured) }).toThrow(expect.objectContaining({ code: 'RESOURCE_BUDGET_UNAVAILABLE' }))
  } finally { await ctx.fiber.dispose() }
})

it('keeps a live resource Service through fresh Cordis tracing proxies', async () => {
  const { ResourceBudget } = await import('@deepseek-ai/dsh-resource-budget')
  const ctx = new Context(), release = vi.fn(async () => {})
  try {
    class Budget extends ResourceBudget {
      override async acquire() { return { signal: new AbortController().signal, release, uncertain: async () => {} } }
    }
    await ctx.plugin(Budget)
    ctx.provide('resourceBudgetRequired', true)
    const captured = captureResourceOwner(ctx)
    expect(() => { assertResourceOwner(ctx, captured) }).not.toThrow()
    await ctx.plugin(LlmRuntime)
    class Adapter extends LlmAdapter {
      override async *stream() { yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['live-resource'], new Adapter()))
    const chunks = []
    for await (const chunk of ctx.llm.stream({ provider: 'live-resource', model: 'm', messages: [] })) chunks.push(chunk)
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(release).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})

it.each(['stream', 'prepared'] as const)('admits nested models under their current owner after an orchestration %s wait', async (mode) => {
  const ctx = new Context(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const originalAcquire = vi.fn(async () => { throw new Error('The orchestration must not reserve model capacity.') })
  const release = vi.fn(async () => {}), wire = vi.fn()
  const acquire = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain: async () => {} }))
  let result: Promise<StreamChunk[]> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    ctx.provide('resourceBudgetRequired', true)
    const withdraw = ctx.provide('resourceBudget', { acquire: originalAcquire })
    class Physical extends LlmAdapter {
      override async *stream() { wire(); yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
    }
    class Orchestration extends LlmAdapter {
      override readonly callKind = 'orchestration' as const
      override async *stream(_options: Parameters<LlmAdapter['stream']>[0], dispatch?: Parameters<LlmAdapter['stream']>[1]) {
        entered.resolve(undefined)
        await proceed.promise
        if (dispatch === undefined) throw new Error('The orchestration must retain its policy guard.')
        await dispatch(async () => {
          for await (const chunk of ctx.llm.stream({ provider: 'physical', model: 'm', messages: [] })) {
            if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
          }
        })
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['physical'], new Physical()))
    ctx.effect(() => ctx.llm.registerAdapter(['orchestrated'], new Orchestration()))
    const options = { provider: 'orchestrated', model: 'm', messages: [] }
    const prepared = mode === 'prepared' ? await ctx.llm.prepareCall(options) : undefined
    result = (async () => {
      const chunks: StreamChunk[] = []
      const stream = prepared === undefined ? ctx.llm.stream(options) : prepared.stream({ ...options, ...prepared.config })
      for await (const chunk of stream) chunks.push(chunk)
      return chunks
    })()
    await Promise.race([entered.promise, result.then(() => { throw new Error('The orchestration did not reach its wait.') })])
    withdraw(); ctx.provide('resourceBudget', { acquire }); proceed.resolve(undefined)
    expect(await result).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(originalAcquire).not.toHaveBeenCalled()
    expect(acquire).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledOnce()
    expect(wire).toHaveBeenCalledOnce()
  } finally { proceed.resolve(undefined); await result; await ctx.fiber.dispose() }
})
