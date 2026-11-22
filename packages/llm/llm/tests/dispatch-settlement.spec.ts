/** Physical dispatch cancellation and uncertain adapter cleanup preserve model admission ownership. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import LlmRuntime, { LlmAdapter, type GenerateOptions, type LlmOperationDispatch, type StreamChunk } from '../src/index.ts'

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  return ctx
}

function permit() {
  return { signal: new AbortController().signal, release: vi.fn(async () => {}), uncertain: vi.fn(async () => {}) }
}

it('refuses physical I/O cancelled during its final authorization without a resource provider', async () => {
  const ctx = await fixture(), controller = new AbortController(), wire = vi.fn()
  let authorizations = 0
  ctx.on('llm/authorize', async () => { if (++authorizations === 2) controller.abort(new Error('Request cancelled at authorization')) })
  class Adapter extends LlmAdapter {
    override async *stream(_options: GenerateOptions, dispatch?: LlmOperationDispatch) {
      if (dispatch === undefined) throw new Error('Physical dispatch requires its request guard.')
      await dispatch(async () => { wire() })
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['cancel-dispatch'], new Adapter()))
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: 'cancel-dispatch', model: 'm', messages: [], signal: controller.signal })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } })
  expect(wire).not.toHaveBeenCalled()
})

it('reports an uncertain permit when adapter construction throws after dispatch starts', async () => {
  const ctx = await fixture(), lease = permit(), failure = new Error('Adapter failed while starting its stream')
  ctx.provide('resourceBudget', { acquire: async () => lease })
  class Adapter extends LlmAdapter {
    override stream(): AsyncIterable<StreamChunk> { throw failure }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['failed-start'], new Adapter()))
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: 'failed-start', model: 'm', messages: [] })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { message: failure.message } } })
  expect(lease.uncertain).toHaveBeenCalledOnce()
  expect(lease.release).not.toHaveBeenCalled()
})

it('retains uncertain capacity when a consumer stops an iterator with no cleanup acknowledgement', async () => {
  const ctx = await fixture(), lease = permit()
  ctx.provide('resourceBudget', { acquire: async () => lease })
  class Adapter extends LlmAdapter {
    override stream(): AsyncIterable<StreamChunk> {
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({
        done: false as const, value: { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: 'Partial output' } },
      }) }) }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['no-close'], new Adapter()))
  for await (const chunk of ctx.llm.stream({ provider: 'no-close', model: 'm', messages: [] })) {
    expect(chunk.type).toBe('block-end')
    break
  }
  expect(lease.uncertain).toHaveBeenCalledOnce()
  expect(lease.release).not.toHaveBeenCalled()
})

it.each(['done', 'nonterminal', 'rejected'] as const)('settles a timed-out model close that later becomes %s', async (outcome) => {
  const ctx = await fixture(), lease = permit()
  const closing = Promise.withResolvers<IteratorResult<StreamChunk>>()
  const adapterReturn = vi.fn(() => closing.promise)
  ctx.provide('resourceBudget', { acquire: async () => lease })
  const chunk: StreamChunk = { type: 'text-delta', index: 0, text: 'partial' }
  class Adapter extends LlmAdapter {
    override stream(): AsyncIterable<StreamChunk> {
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: chunk }), return: adapterReturn }) }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['delayed-close'], new Adapter()))
  const iterator = ctx.llm.stream({ provider: 'delayed-close', model: 'm', messages: [] })[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  vi.useFakeTimers()
  try {
    const returned = expect(iterator.return?.()).rejects.toMatchObject({ code: 'ADAPTER_CLOSE_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(1000)
    await returned
    expect(adapterReturn).toHaveBeenCalledOnce()
    expect(lease.uncertain).toHaveBeenCalledOnce()
    expect(lease.release).not.toHaveBeenCalled()
    if (outcome === 'rejected') closing.reject(new Error('cleanup failed'))
    else closing.resolve(outcome === 'done' ? { done: true, value: undefined } : { done: false, value: chunk })
    await vi.advanceTimersByTimeAsync(0)
    expect(lease.release).toHaveBeenCalledTimes(outcome === 'done' ? 1 : 0)
  } finally {
    closing.resolve({ done: true, value: undefined })
    vi.useRealTimers()
  }
})
