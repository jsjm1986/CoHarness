/** Prepared consumers retain live authorization through queues, credentials and provider retries. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk } from '../src/index.ts'
import type { LlmOperationDispatch } from '../src/operations.ts'

it.each(['admission', 'authorization', 'credentials', 'final-check', 'retry'] as const)(
  'refuses a prepared consumer withdrawn during %s and returns its permit', async (phase) => {
    const ctx = new Context(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
    const release = vi.fn(async () => {}), uncertain = vi.fn(async () => {}), wire = vi.fn(async () => {})
    let current = true, authorizations = 0
    const wait = async (): Promise<void> => { entered.resolve(undefined); await proceed.promise }
    let result: Promise<StreamChunk[]> | undefined
    try {
      await ctx.plugin(LlmRuntime)
      ctx.provide('resourceBudget', { async acquire() {
        if (phase === 'admission') await wait()
        return { signal: new AbortController().signal, release, uncertain }
      } })
      class Adapter extends LlmAdapter {
        override async *stream(_options: GenerateOptions, dispatch?: LlmOperationDispatch) {
          if (dispatch === undefined) throw new Error('Runtime dispatch authorization is required.')
          if (phase === 'credentials') await wait()
          await dispatch(wire)
          if (phase === 'retry') { await wait(); await dispatch(wire) }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        }
      }
      ctx.effect(() => ctx.llm.registerAdapter(['guarded'], new Adapter()))
      const call = await ctx.llm.prepareCall({ provider: 'guarded', model: 'm' })
      result = (async () => {
        const chunks: StreamChunk[] = []
        for await (const chunk of call.stream({ ...call.config, messages: [] }, {
          async authorize() {
            authorizations++
            if (phase === 'authorization' && authorizations === 1) await wait()
            if (phase === 'final-check') queueMicrotask(() => { current = false })
          },
          assertCurrent() {
            if (!current) throw new LlmError('Prepared consumer was withdrawn.', 'CONSUMER_WITHDRAWN')
          },
        })) chunks.push(chunk)
        return chunks
      })()
      if (phase !== 'final-check') {
        await Promise.race([entered.promise, result.then(() => { throw new Error('The request did not reach its controlled wait.') })])
        current = false
        proceed.resolve(undefined)
      }
      expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CONSUMER_WITHDRAWN' } } })
      expect(wire).toHaveBeenCalledTimes(phase === 'retry' ? 1 : 0)
      expect(release).toHaveBeenCalledOnce()
      expect(uncertain).not.toHaveBeenCalled()
    } finally { proceed.resolve(undefined); await result; await ctx.fiber.dispose() }
  },
)

it('isolates guards between simultaneous prepared calls without exposing callbacks to the adapter', async () => {
  const ctx = new Context(), entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const seen: GenerateOptions[] = []
  let blocked: Promise<StreamChunk[]> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    class Adapter extends LlmAdapter {
      override async *stream(options: GenerateOptions, dispatch?: LlmOperationDispatch) {
        if (dispatch === undefined) throw new Error('Runtime dispatch authorization is required.')
        await dispatch(async () => { seen.push(options) })
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['guarded'], new Adapter()))
    const first = await ctx.llm.prepareCall({ provider: 'guarded', model: 'blocked' })
    const second = await ctx.llm.prepareCall({ provider: 'guarded', model: 'allowed' })
    blocked = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of first.stream({ ...first.config, messages: [] }, {
        async authorize() { entered.resolve(undefined); await proceed.promise; throw new LlmError('No longer eligible.', 'CONSUMER_WITHDRAWN') },
        assertCurrent() { throw new Error('Asynchronous authorization must refuse this call.') },
      })) chunks.push(chunk)
      return chunks
    })()
    await Promise.race([entered.promise, blocked.then(() => { throw new Error('The first call did not wait for authorization.') })])
    const chunks = []
    for await (const chunk of second.stream({ ...second.config, messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    proceed.resolve(undefined)
    expect((await blocked).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'CONSUMER_WITHDRAWN' } } })
    expect(seen).toEqual([{ ...second.config, messages: [] }])
    expect(Object.keys(seen[0]!)).not.toContain('guard')
  } finally { proceed.resolve(undefined); await blocked; await ctx.fiber.dispose() }
})

it('cancels asynchronous prepared authorization when its admitted permit is revoked', async () => {
  const ctx = new Context(), entered = Promise.withResolvers<undefined>(), revoked = new AbortController()
  const release = vi.fn(async () => {}), wire = vi.fn()
  let result: Promise<StreamChunk[]> | undefined
  try {
    await ctx.plugin(LlmRuntime)
    ctx.provide('resourceBudget', { acquire: async () => ({ signal: revoked.signal, release,
      uncertain: async () => { throw new Error('Authorization cancellation must return its unused permit.') } }) })
    class Adapter extends LlmAdapter {
      override async *stream() { wire(); yield { type: 'finish' as const, reason: { kind: 'stop' as const } } }
    }
    ctx.effect(() => ctx.llm.registerAdapter(['guarded'], new Adapter()))
    const call = await ctx.llm.prepareCall({ provider: 'guarded', model: 'm' })
    result = (async () => {
      const chunks: StreamChunk[] = []
      for await (const chunk of call.stream({ ...call.config, messages: [] }, {
        async authorize(signal?: AbortSignal) {
          if (signal === undefined) throw new Error('Prepared authorization did not receive effective cancellation.')
          signal.throwIfAborted()
          entered.resolve(undefined)
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => { resolve() }, { once: true })
          })
          signal.throwIfAborted()
        },
        assertCurrent() {},
      })) chunks.push(chunk)
      return chunks
    })()
    await Promise.race([entered.promise, result.then(() => { throw new Error('The guard did not reach its cancellable wait.') })])
    revoked.abort(new Error('Permit revoked.'))
    expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(wire).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  } finally { revoked.abort(new Error('Fixture cleanup.')); await result; await ctx.fiber.dispose() }
})
