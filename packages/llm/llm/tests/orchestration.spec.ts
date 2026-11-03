import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import LlmRuntime, { LlmAdapter, LlmError, type GenerateOptions, type PreparedAdapterCall, type StreamChunk } from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

it.each(['stream', 'prepared'] as const)('admits each physical request inside an orchestrated %s without reserving its whole turn', async (mode) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.provide('modelAccessRequired', true)
  ctx.provide('modelAccess', { decide: (target: { provider: string }) => target.provider === 'physical'
    ? { allowed: true as const } : { allowed: false as const, reason: 'Only the physical model is authorized.' },
  })
  let active = 0, acquired = 0, released = 0, upstream = 0
  const metered: string[] = []
  ctx.provide('resourceBudget', { async acquire() {
    if (active !== 0) throw new LlmError('The single model slot is already occupied.', 'RATE_LIMIT')
    active += 1
    acquired += 1
    return { signal: new AbortController().signal, release: async () => { active -= 1; released += 1 },
      uncertain: async () => { throw new Error('The physical request must finish before its permit is released.') },
    }
  } })
  ctx.on('llm/stream', async function* (options, next) {
    metered.push(options.provider)
    yield* next()
  })
  class Physical extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      expect(active).toBe(1)
      upstream += 1
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  class Orchestration extends LlmAdapter {
    override readonly callKind = 'orchestration' as const
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      for (let request = 0; request < 2; request += 1) {
        for await (const chunk of ctx.llm.stream({ ...options, provider: 'physical', model: 'm' })) {
          if (chunk.type === 'finish' && chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
        }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['physical'], new Physical())
  ctx.llm.registerAdapter(['member'], new Orchestration())
  const options: GenerateOptions = { provider: 'member', model: 'external', sessionId: SessionId('member-session'), messages: [] }
  const call = mode === 'prepared' ? await ctx.llm.prepareCall(options) : undefined
  const stream = call === undefined ? ctx.llm.stream(options) : call.stream({ ...options, ...call.config })
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
  expect({ active, acquired, released, upstream }).toEqual({ active: 0, acquired: 2, released: 2, upstream: 2 })
  expect(metered).toEqual(['physical', 'physical'])
})

it('retains mandatory policy ownership while orchestration metadata resolves', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.provide('modelAccessRequired', true)
  const original = ctx.plugin((scope: Context) => {
    scope.provide('modelAccess', { decide: () => ({ allowed: true as const }) })
  })
  await original
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  let dispatched = false
  class Orchestration extends LlmAdapter {
    override readonly callKind = 'orchestration' as const
    override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
      entered.resolve(undefined)
      await release.promise
      return super.prepareCall(provider, model)
    }
    async *stream(): AsyncIterable<StreamChunk> {
      dispatched = true
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['member'], new Orchestration())
  const result = (async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of ctx.llm.stream({ provider: 'member', model: 'm', messages: [] })) chunks.push(chunk)
    return chunks
  })()
  await entered.promise
  await original.dispose()
  ctx.provide('modelAccess', { decide: () => ({ allowed: true as const }) })
  release.resolve(undefined)
  expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_POLICY_UNAVAILABLE' } } })
  expect(dispatched).toBe(false)
})

it.each(['prepareOperation', 'prepareDelegatedOperation'] as const)('does not expose physical operation factories through orchestration: %s', async (method) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  let factoryCalled = false
  class Orchestration extends LlmAdapter {
    override readonly callKind = 'orchestration' as const
    override prepareCall(): Promise<PreparedAdapterCall> {
      return Promise.resolve({ model: { provider: 'member', id: 'm', name: 'm' }, stream: () => this.stream(), operations: {
        'native-stream': () => { factoryCalled = true; throw new Error('An orchestration is not a physical model operation.') },
      } })
    }
    async *stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  ctx.llm.registerAdapter(['member'], new Orchestration())
  await expect(ctx.llm[method]({ provider: 'member', model: 'm' }, 'native-stream', {
    protocol: 'openai-responses', body: {}, maxResponseBytes: 100, write: () => Promise.resolve(),
  })).rejects.toMatchObject({ code: 'MODEL_OPERATION_UNSUPPORTED' })
  expect(factoryCalled).toBe(false)
})

it.each(['model', 'orchestration'] as const)('rejects middleware rerouting a %s call across execution kinds', async (kind) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  let dispatched = 0
  class Model extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> { dispatched += 1; yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  class Orchestration extends Model { override readonly callKind = 'orchestration' as const }
  ctx.llm.registerAdapter(['model'], new Model())
  ctx.llm.registerAdapter(['orchestration'], new Orchestration())
  const event = kind === 'model' ? 'llm/stream' : 'llm/orchestration'
  ctx.on(event, (options, next) => {
    options.provider = kind === 'model' ? 'orchestration' : 'model'
    return next()
  })
  const chunks: StreamChunk[] = []
  for await (const chunk of ctx.llm.stream({ provider: kind, model: 'm', messages: [] })) chunks.push(chunk)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_PREPARED_CALL' } } })
  expect(dispatched).toBe(0)
})

it('retains a prepared orchestration and its middleware when a model adapter replaces its route', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const invoked: string[] = []
  class Orchestration extends LlmAdapter {
    override readonly callKind = 'orchestration' as const
    async *stream(): AsyncIterable<StreamChunk> { invoked.push('captured orchestration'); yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  class Replacement extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> { invoked.push('replacement model'); yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  ctx.on('llm/orchestration', (_options, next) => { invoked.push('orchestration middleware'); return next() })
  ctx.on('llm/stream', (_options, next) => { invoked.push('model middleware'); return next() })
  const unregister = ctx.llm.registerAdapter(['member'], new Orchestration())
  const prepared = await ctx.llm.prepareCall({ provider: 'member', model: 'm' })
  unregister()
  ctx.llm.registerAdapter(['member'], new Replacement())
  for await (const chunk of prepared.stream({ ...prepared.config, messages: [] })) expect(chunk.type).toBe('finish')
  expect(invoked).toEqual(['orchestration middleware', 'captured orchestration'])
})
