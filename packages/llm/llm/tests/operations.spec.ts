import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter, LlmError } from '../src/index.ts'
import type { GenerateOptions, LlmOperationDefinition, PreparedAdapterCall, StreamChunk } from '../src/index.ts'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { ResourceRequest } from '@deepseek-ai/dsh-resource-budget'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmOperationMap {
    'test-model-operation': LlmOperationDefinition<
      { readonly query: string },
      { readonly body: { readonly query: string; readonly generation: number; readonly maxTokens?: number } },
      { readonly text: string; readonly generation: number }
    >
  }
}

class Adapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []
  readonly generation: number
  reportUsage = true
  credentialSource: string | undefined = 'organization'
  failure: Error | undefined
  repeatDispatch = false
  onRun: ((options: GenerateOptions) => Promise<void>) | undefined
  supported: 'yes' | 'missing' | 'empty' = 'yes'

  constructor(generation = 1) { super(); this.generation = generation }

  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    const generation = this.generation
    return {
      model: { provider, id: model, name: model, defaultMaxTokens: 64 },
      stream: options => this.stream(options),
      ...this.supported === 'missing' ? {} : {
        operations: this.supported === 'empty' ? {} : {
          'test-model-operation': (parameters, config) => ({
            request: { body: {
              query: parameters.query, generation, ...config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens },
            } },
            run: async (options, observer) => {
              const request = async () => {
                this.calls.push(options)
                await this.onRun?.(options)
                if (this.reportUsage) observer.usage({ inputTokens: 3, outputTokens: 2 }, this.credentialSource)
                if (this.failure !== undefined) throw this.failure
                return { text: parameters.query, generation }
              }
              const result = await observer.dispatch(request)
              if (this.repeatDispatch) await observer.dispatch(request)
              return result
            },
          }),
        },
      },
    }
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('A native operation dispatched an ordinary conversation stream.')
  }
}

async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new Adapter()
  const unregister = ctx.llm.registerAdapter(['fixture'], adapter)
  const prepare = () => ctx.llm.prepareOperation({ provider: 'fixture', model: 'm' }, 'test-model-operation', { query: 'saved query' })
  return { ctx, adapter, unregister, prepare }
}

function lease() {
  return { signal: new AbortController().signal, release: vi.fn(async () => {}), uncertain: vi.fn(async () => {}) }
}

it('enforces the installed model policy for an operation without policy middleware', async () => {
  const f = await fixture()
  const decide = vi.fn(() => ({ allowed: false as const, reason: 'Native requests are disabled.' }))
  f.ctx.provide('modelAccess', { decide })
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: 'MODEL_FORBIDDEN' })
  expect(decide).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider: 'fixture', model: 'm' }))
  expect(f.adapter.calls).toHaveLength(0)
})

it('meters a delegated native operation without consuming the conversation middleware', async () => {
  const f = await fixture()
  const permit = lease()
  const acquire = vi.fn(async (_request: ResourceRequest) => permit)
  f.ctx.provide('resourceBudget', { acquire })
  const conversation = vi.fn(() => { throw new Error('Conversation replay must not consume a child request.') })
  f.ctx.on('llm/stream', conversation)
  const observed: StreamChunk[] = []
  const owners: GenerateOptions[] = []
  f.ctx.on('llm/delegated-stream', async function* (options, next) {
    owners.push(options)
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.ctx.llm.prepareDelegatedOperation({ provider: 'fixture', model: 'm' },
    'test-model-operation', { query: 'child request' })
  const sessionId = 'parent-session' as NonNullable<GenerateOptions['sessionId']>
  await expect(call.run({ ...call.config, sessionId, resourceOrigin: 'execution' })).resolves.toEqual({
    text: 'child request', generation: 1,
  })
  expect(conversation).not.toHaveBeenCalled()
  expect(owners).toEqual([expect.objectContaining({ sessionId, resourceOrigin: 'execution' })])
  expect(acquire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'model', sessionId, origin: 'execution' }))
  expect(permit.release).toHaveBeenCalledOnce()
  expect(observed).toContainEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'organization' })
})

it('retains the prepared model generation and exposes exact frozen input to ordinary middleware', async () => {
  const f = await fixture()
  const permit = lease()
  const acquire = vi.fn(async (_request: ResourceRequest) => permit)
  f.ctx.provide('resourceBudget', { acquire })
  const observed: StreamChunk[] = []
  f.ctx.on('llm/stream', async function* (options, next) {
    expect(options.operation).toEqual({ name: 'test-model-operation', request: { body: { query: 'saved query', generation: 1, maxTokens: 64 } } })
    expect(Object.isFrozen(options.operation?.request)).toBe(true)
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.prepare()
  f.unregister()
  const replacement = new Adapter(2)
  f.ctx.llm.registerAdapter(['fixture'], replacement)
  expect(Object.isFrozen(call.request.body)).toBe(true)
  expect(await call.run({ ...call.config, resourceOrigin: 'execution', purpose: 'web-search' }))
    .toEqual({ text: 'saved query', generation: 1 })
  expect(f.adapter.calls).toHaveLength(1)
  expect(replacement.calls).toHaveLength(0)
  expect(observed).toEqual([
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'organization' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  expect(acquire).toHaveBeenCalledOnce()
  expect(acquire.mock.calls[0]?.[0]).toMatchObject({ kind: 'model', origin: 'execution' })
  expect(permit.release).toHaveBeenCalledOnce()
  expect(permit.uncertain).not.toHaveBeenCalled()
})

it('rechecks policy after queued model admission without dispatching a denied operation', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>(), granted = Promise.withResolvers<ReturnType<typeof lease>>()
  const permit = lease()
  onTestFinished(() => { granted.resolve(permit) })
  f.ctx.provide('resourceBudget', { acquire() { entered.resolve(undefined); return granted.promise } })
  let allowed = true
  f.ctx.on('llm/pre-dispatch', async (_options, next) => {
    if (!allowed) throw new LlmError('Route was revoked.', 'MODEL_FORBIDDEN')
    await next()
  })
  const call = await f.prepare()
  const result = call.run(call.config)
  await Promise.race([entered.promise, result.then(() => { throw new Error('Operation completed before admission.') })])
  allowed = false
  granted.resolve(permit)
  await expect(result).rejects.toMatchObject({ code: 'MODEL_FORBIDDEN' })
  expect(f.adapter.calls).toHaveLength(0)
  expect(permit.release).toHaveBeenCalledOnce()
})

it.each(['empty', 'finish'] as const)('refuses middleware %s completion without an actual operation result', async (mode) => {
  const f = await fixture()
  f.ctx.on('llm/stream', () => (async function* (): AsyncIterable<StreamChunk> {
    if (mode === 'finish') yield { type: 'finish', reason: { kind: 'stop' } }
  })())
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: mode === 'empty' ? 'STREAM_CLOSED' : 'MODEL_OPERATION_RESULT_MISSING' })
  expect(f.adapter.calls).toHaveLength(0)
})

it('preserves provider usage before a failed terminal outcome', async () => {
  const f = await fixture()
  f.adapter.failure = new LlmError('Native provider failed after reporting usage.', 'TRANSPORT')
  const observed: StreamChunk[] = []
  f.ctx.on('llm/stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: 'TRANSPORT' })
  expect(observed[0]).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'organization' })
  expect(observed[1]).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
})

it('retains ordinary prepared-call mismatch and once-only checks', async () => {
  const f = await fixture()
  const call = await f.prepare()
  await expect(call.run({ ...call.config, maxTokens: 65 })).rejects.toMatchObject({ code: 'INVALID_PREPARED_CALL' })
  await expect(call.run(call.config)).resolves.toMatchObject({ text: 'saved query' })
  await expect(call.run(call.config)).rejects.toMatchObject({ code: 'INVALID_PREPARED_CALL' })
  expect(f.adapter.calls).toHaveLength(1)
})

it('refuses a second physical request from one prepared operation while retaining the first request usage', async () => {
  const f = await fixture()
  f.adapter.repeatDispatch = true
  const observed: StreamChunk[] = []
  f.ctx.on('llm/stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: 'INVALID_PREPARED_CALL' })
  expect(f.adapter.calls).toHaveLength(1)
  expect(observed[0]).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'organization' })
})

it.each(['missing', 'empty'] as const)('refuses unsupported operations when factories are %s', async (mode) => {
  const f = await fixture()
  f.adapter.supported = mode
  await expect(f.prepare()).rejects.toMatchObject({ code: 'MODEL_OPERATION_UNSUPPORTED' })
  expect(f.adapter.calls).toHaveLength(0)
})

it('does not fabricate provider usage when none was reported', async () => {
  const f = await fixture()
  f.adapter.reportUsage = false
  const observed: StreamChunk[] = []
  f.ctx.on('llm/stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.prepare()
  await expect(call.run(call.config)).resolves.toMatchObject({ text: 'saved query' })
  expect(observed).toEqual([{ type: 'finish', reason: { kind: 'stop' } }])
})

it('retains actual usage without assigning an unknown credential a source', async () => {
  const f = await fixture()
  f.adapter.credentialSource = undefined
  const observed: StreamChunk[] = []
  f.ctx.on('llm/stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const call = await f.prepare()
  await call.run(call.config)
  expect(observed[0]).toEqual({ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } })
})

it('joins a cancelled operation before releasing its model permit', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const controller = new AbortController()
  const permit = lease()
  f.ctx.provide('resourceBudget', { acquire: async () => permit })
  let quiescent = false
  f.adapter.onRun = async (options) => {
    const signal = options.signal
    if (signal === undefined) throw new Error('Operation lost its effective signal.')
    try {
      await new Promise<void>((_resolve, reject) => {
        signal.throwIfAborted()
        signal.addEventListener('abort', () => { reject(new LlmError('Native request cancelled.', 'ABORTED')) }, { once: true })
        entered.resolve(undefined)
      })
    } finally { quiescent = true }
  }
  onTestFinished(() => { controller.abort() })
  const call = await f.prepare()
  const result = call.run({ ...call.config, signal: controller.signal })
  await Promise.race([entered.promise, result.then(() => { throw new Error('Operation did not enter its transport.') })])
  expect(permit.release).not.toHaveBeenCalled()
  controller.abort()
  await expect(result).rejects.toMatchObject({ code: 'ABORTED' })
  expect(quiescent).toBe(true)
  expect(permit.release).toHaveBeenCalledOnce()
  expect(permit.uncertain).not.toHaveBeenCalled()
})

it('refuses operation input injected into an ordinary call', async () => {
  const f = await fixture()
  const operation = { name: 'test-model-operation' as const, request: { body: { query: 'injected', generation: 9 } } }
  const options: GenerateOptions = { provider: 'fixture', model: 'm', messages: [], operation }
  const chunks: StreamChunk[] = []
  for await (const chunk of f.ctx.llm.stream(options)) chunks.push(chunk)
  expect(chunks).toMatchObject([{ type: 'finish', reason: { kind: 'error', failure: { code: 'INVALID_PREPARED_CALL' } } }])
  const ordinary = await f.ctx.llm.prepareCall(options)
  expect(() => ordinary.stream({ ...options, ...ordinary.config })).toThrow(/operation input changed/u)
  expect(f.adapter.calls).toHaveLength(0)
})
