/** Real loopback control and child LLM/resource services without external inference. */
import { Context } from '@deepseek-ai/cordis'
import { ServerResponse } from 'node:http'
import LlmRuntime, { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk, type LlmOperationDefinition } from '@deepseek-ai/dsh-llm'
import ResourceBudget, { ResourceAdmissionError, type ResourceLease, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import { SessionId } from '@deepseek-ai/dsh-session'
import { expect, it, onTestFinished, vi } from 'vitest'
import { SdkParentControl } from '../src/bridge.ts'
import { SDK_PARENT_CONTROL_ENV, controlConnection, type SdkControlConfig } from '../src/control.ts'
import { mountManaged } from './managed-fixture.ts'
import { ParentControlClient } from '../src/managed-client.ts'
import { ModelChannel } from '../src/channel.ts'
import { ParentModelRelay } from '../src/model-relay.ts'
import * as Wire from '../src/control.ts'
import { parentAgent } from './agent-fixture.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface LlmOperationMap {
    'sdk-control-test': LlmOperationDefinition<{ query: string }, { query: string }, string>
  }
}

const config = { maxBytes: 1024 * 1024, maxOperations: 64, requestTimeoutMs: 3000, pollMs: 20, cleanupTimeoutMs: 4000 }
const options = (model = 'm'): GenerateOptions => ({ provider: 'fixture', model, messages: [], sessionId: SessionId('child-session') })
function* reply(text = 'child'): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'file' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

async function fixture(admit?: (request: ResourceRequest) => Promise<ResourceLease>,
  controlConfig: SdkControlConfig = config, withBudget = true) {
  const parent = new Context(), child = new Context(), cancellation = new AbortController()
  const releases = vi.fn(async () => {}), uncertainties = vi.fn(async () => {})
  const acquire = vi.fn(admit ?? (async (_request: ResourceRequest) => ({
    signal: new AbortController().signal, release: releases, uncertain: uncertainties,
  })))
  const withdrawBudgetRequirement = parent.provide('resourceBudgetRequired', true)
  class ParentBudget extends ResourceBudget {
    override acquire(request: ResourceRequest): Promise<ResourceLease> { return acquire(request) }
  }
  parent.provide('modelAccessRequired', true)
  const policy = { decide: () => ({ allowed: true as const }) }
  const withdrawPolicy = parent.provide('modelAccess', policy)
  const owned: { control?: SdkParentControl } = {}
  onTestFinished(async () => {
    cancellation.abort()
    try { await child.fiber.dispose() } finally {
      try { await owned.control?.close() } finally { await parent.fiber.dispose() }
    }
  })
  const parentLlm = await parent.plugin(LlmRuntime)
  const parentBudget = await parent.plugin(ParentBudget)
  if (!withBudget) { await parentBudget.dispose(); withdrawBudgetRequirement() }
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'parent-session', parent),
    prompt: [{ type: 'text', text: 'task' }], signal: cancellation.signal }, controlConfig)
  owned.control = control
  const { env } = await control.open()
  const connection = controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!))
  const managed = await mountManaged(child, env[SDK_PARENT_CONTROL_ENV])
  await child.plugin(LlmRuntime)
  const stream = vi.fn((_options: GenerateOptions): AsyncIterable<StreamChunk> => (async function* () { yield* reply() })())
  class Adapter extends LlmAdapter {
    override stream(request: GenerateOptions): AsyncIterable<StreamChunk> { return stream(request) }
  }
  child.effect(() => child.llm.registerAdapter(['fixture'], new Adapter()))
  return { parent, child, cancellation, control, connection, managed, parentLlm, parentBudget,
    releases, uncertainties, acquire, stream, withdrawPolicy }
}

it('admits each real child LLM call and meters usage in parent ownership without replaying the parent', async () => {
  const f = await fixture(), seen: GenerateOptions[] = [], usage: StreamChunk[] = []
  expect(() => { f.control.assertReady() }).not.toThrow()
  const rootReplay = vi.fn(() => { throw new Error('Root replay must not consume a child model request.') })
  f.parent.on('llm/stream', rootReplay)
  f.parent.on('llm/delegated-stream', (request, next) => {
    seen.push(request)
    return (async function* () { for await (const chunk of next()) { if (chunk.type === 'usage') usage.push(chunk); yield chunk } })()
  })
  const chunks = await collect(f.child.llm.stream(options()))
  expect(chunks).toEqual([...reply()])
  expect(f.acquire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'model', origin: 'execution', sessionId: 'parent-session' }))
  expect(seen).toHaveLength(1)
  expect(seen[0]?.sessionId).toBe('parent-session')
  expect(usage).toEqual([{ type: 'usage', usage: { inputTokens: 3, outputTokens: 2 }, credentialSource: 'file' }])
  expect(rootReplay).not.toHaveBeenCalled()
  expect(f.releases).toHaveBeenCalledOnce()
  expect(f.uncertainties).not.toHaveBeenCalled()
})

it('runs mandatory parent authorization even when a child waterfall stops delegating', async () => {
  const f = await fixture()
  f.withdrawPolicy()
  f.parent.provide('modelAccess', { decide: () => ({ allowed: false, reason: 'Parent route is forbidden.' }) })
  f.child.on('llm/pre-dispatch', async () => {})
  const chunks = await collect(f.child.llm.stream(options()))
  expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'error', failure: { code: 'MODEL_FORBIDDEN' } } })
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.releases).toHaveBeenCalledOnce()
})

it('keeps model permit observation available while both relay directions are held', async () => {
  const f = await fixture(undefined, { ...config, maxOperations: 2 })
  const inputHeld = Promise.withResolvers<undefined>(), outputHeld = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>(), observed = Promise.withResolvers<unknown>()
  const restores: (() => void)[] = []
  const responses = vi.spyOn(ServerResponse.prototype, 'writeHead')
  // oxlint-disable-next-line typescript/unbound-method -- The original methods are called with their actual receivers.
  const ready = ParentModelRelay.prototype.ready, post = ParentControlClient.prototype.post
  let captured = false, inputs = 0, statuses = 0
  const locating = vi.spyOn(ParentModelRelay.prototype, 'ready').mockImplementation(function (this: ParentModelRelay) {
    if (!captured) {
      captured = true
      const take = this.output.take.bind(this.output), push = this.input.push.bind(this.input)
      const reading = vi.spyOn(this.output, 'take').mockImplementation(async (signal) => {
        outputHeld.resolve(undefined)
        await resume.promise
        return take(signal)
      })
      restores.push(() => { reading.mockRestore() })
      const writing = vi.spyOn(this.input, 'push').mockImplementation((chunk) => {
        const pending = push(chunk)
        if (++inputs === 2) inputHeld.resolve(undefined)
        return pending
      })
      restores.push(() => { writing.mockRestore() })
    }
    return Reflect.apply(ready, this, [])
  })
  const watching = vi.spyOn(ParentControlClient.prototype, 'post').mockImplementation(async function (
    this: ParentControlClient, path, body, signal,
  ) {
    if (path !== '/resource/status' || ++statuses !== 2) return Reflect.apply(post, this, [path, body, signal])
    await Promise.all([inputHeld.promise, outputHeld.promise])
    try {
      const state = await Reflect.apply(post, this, [path, body, signal])
      observed.resolve(state)
      return state
    } catch (error) { observed.resolve({ failure: error }); throw error }
    finally { resume.resolve(undefined) }
  })
  f.parent.on('llm/delegated-stream', (_request, next) => (async function* () {
    for await (const chunk of next()) { await resume.promise; yield chunk }
  })())
  const result = collect(f.child.llm.stream(options()))
  const settled = result.then(() => undefined, () => undefined)
  try {
    const state = await Promise.race([observed.promise, settled.then(() => {
      throw new Error('Model stopped before concurrent permit observation.')
    })])
    expect({ state, refused: responses.mock.calls.filter(([status]) => status === 503).length })
      .toEqual({ state: { state: 'granted' }, refused: 0 })
    expect(await result).toEqual([...reply()])
    expect(f.acquire).toHaveBeenCalledOnce()
    expect(f.releases).toHaveBeenCalledOnce()
    expect(f.uncertainties).not.toHaveBeenCalled()
  } finally {
    resume.resolve(undefined); await settled
    watching.mockRestore(); locating.mockRestore(); responses.mockRestore()
    for (const restore of restores) restore()
  }
})

it('refuses the original parent policy owner replaced during queued admission', async () => {
  const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>()
  const release = vi.fn(async () => {})
  const f = await fixture(async () => { entered.resolve(undefined); return grant.promise })
  const result = collect(f.child.llm.stream(options()))
  try {
    await Promise.race([entered.promise, result.then(() => { throw new Error('Child did not wait for parent admission.') })])
    f.withdrawPolicy()
    f.parent.provide('modelAccess', { decide: () => ({ allowed: true }) })
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    const chunks = await result
    expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'error', failure: { code: 'MODEL_POLICY_UNAVAILABLE' } } })
    expect(f.stream).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  } finally {
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    await Promise.allSettled([result])
  }
})

it('honors a parent short circuit without starting a child adapter or reserving model capacity', async () => {
  const f = await fixture()
  f.parent.on('llm/delegated-stream', () => (async function* () { yield* reply('parent response') })())
  expect(await collect(f.child.llm.stream(options()))).toEqual([...reply('parent response')])
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('returns parent-transformed output to the child consumer', async () => {
  const f = await fixture()
  f.parent.on('llm/delegated-stream', (_request, next) => (async function* () {
    for await (const chunk of next()) {
      if (chunk.type === 'text-delta') yield { ...chunk, text: 'transformed' }
      else if (chunk.type === 'block-end') yield { ...chunk, block: { type: 'text', text: 'transformed' } }
      else yield chunk
    }
  })())
  const chunks = await collect(f.child.llm.stream(options()))
  expect(chunks.find(chunk => chunk.type === 'text-delta')).toMatchObject({ text: 'transformed' })
  expect(f.releases).toHaveBeenCalledOnce()
})

it('bounds concurrent child inference with independent parent permits', async () => {
  const firstEntered = Promise.withResolvers<undefined>(), secondQueued = Promise.withResolvers<undefined>()
  const finishFirst = Promise.withResolvers<undefined>()
  let active = 0, maximum = 0, calls = 0
  const waiters: (() => void)[] = []
  const f = await fixture(async () => {
    calls++
    if (active === 1) { secondQueued.resolve(undefined); await new Promise<void>((resolve) => { waiters.push(resolve) }) }
    active++; maximum = Math.max(maximum, active)
    return { signal: new AbortController().signal, async release() { active--; waiters.shift()?.() }, async uncertain() { throw new Error('Unexpected uncertainty.') } }
  })
  let adapters = 0, maximumAdapters = 0
  f.stream.mockImplementation(request => (async function* () {
    adapters++; maximumAdapters = Math.max(maximumAdapters, adapters)
    try {
      if (request.model === 'first') { firstEntered.resolve(undefined); await finishFirst.promise }
      yield* reply(request.model)
    } finally { adapters-- }
  })())
  const first = collect(f.child.llm.stream(options('first')))
  await Promise.race([firstEntered.promise, first.then(() => { throw new Error('First child did not enter its adapter.') })])
  const second = collect(f.child.llm.stream(options('second')))
  try {
    await Promise.race([secondQueued.promise, second.then(() => { throw new Error('Second child did not wait for capacity.') })])
    expect(adapters).toBe(1)
    finishFirst.resolve(undefined)
    await Promise.all([first, second])
    expect(calls).toBe(2)
    expect(maximum).toBe(1)
    expect(maximumAdapters).toBe(1)
    expect(active).toBe(0)
  } finally {
    finishFirst.resolve(undefined)
    waiters.splice(0).forEach((resolve) => { resolve() })
    await Promise.allSettled([first, second])
  }
})

it('withdraws a parent permit and waits for child adapter cleanup before releasing it', async () => {
  const permit = new AbortController(), entered = Promise.withResolvers<undefined>()
  let cleaned = false
  const release = vi.fn(async () => { expect(cleaned).toBe(true) })
  const f = await fixture(async () => ({ signal: permit.signal, release, uncertain: async () => {} }))
  f.stream.mockImplementation(request => (async function* () {
    try {
      entered.resolve(undefined)
      await new Promise<never>((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => { reject(new Error('Owned model cancelled.')) }, { once: true })
      })
    } finally { cleaned = true }
  })())
  const result = collect(f.child.llm.stream(options()))
  await Promise.race([entered.promise, result.then(() => { throw new Error('Child did not enter its adapter.') })])
  permit.abort(new ResourceAdmissionError('cancelled', 'Parent permit withdrawn.'))
  expect((await result).find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'aborted' } })
  expect(release).toHaveBeenCalledOnce()
})

it('governs an exact prepared native operation and relays its actual token source', async () => {
  const f = await fixture(), native = vi.fn(async () => 'native result'), requests: GenerateOptions[] = []
  f.parent.on('llm/delegated-stream', (request, next) => { requests.push(request); return next() })
  class Native extends LlmAdapter {
    override async prepareCall(provider: string, model: string) {
      return { model: { provider, id: model, name: model }, stream: () => (async function* () { yield* reply() })(),
        operations: { 'sdk-control-test': (parameters: { query: string }) => ({ request: { query: parameters.query },
          async run(_options: GenerateOptions,
            observer: { usage(counts: { inputTokens: number; outputTokens: number }, source: string): void }) {
            observer.usage({ inputTokens: 7, outputTokens: 4 }, 'organization')
            return native()
          },
        }) },
      }
    }
    override async *stream() { yield* reply() }
  }
  f.child.effect(() => f.child.llm.registerAdapter(['native'], new Native()))
  const prepared = await f.child.llm.prepareOperation({ provider: 'native', model: 'm' }, 'sdk-control-test', { query: 'exact query' })
  expect(prepared.request).toEqual({ query: 'exact query' })
  expect(await prepared.run({ ...prepared.config, sessionId: SessionId('native-child'), purpose: 'web-search' })).toBe('native result')
  expect(native).toHaveBeenCalledOnce()
  expect(requests[0]?.operation).toEqual({ name: 'sdk-control-test', request: { query: 'exact query' } })
  expect(requests[0]?.purpose).toBe('web-search')
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.releases).toHaveBeenCalledOnce()
})

it('joins a queued process cancellation and returns a late unused grant once', async () => {
  const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>(), cancel = new AbortController()
  const release = vi.fn(async () => {})
  const f = await fixture(async () => { entered.resolve(undefined); return grant.promise })
  const acquiring = f.child.resourceBudget.acquire({ kind: 'process', signal: cancel.signal })
  try {
    await Promise.race([entered.promise, acquiring.then(() => { throw new Error('Process did not wait for admission.') })])
    cancel.abort(new Error('Queued process cancelled.'))
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    await expect(acquiring).rejects.toThrow('Queued process cancelled.')
    expect(release).toHaveBeenCalledOnce()
  } finally {
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    await Promise.allSettled([acquiring])
  }
})

it('admits isolated child LLM services through the same mandatory parent owner', async () => {
  const f = await fixture(), isolated = f.child.isolate('llm')
  await isolated.plugin(LlmRuntime)
  class Isolated extends LlmAdapter { override async *stream() { yield* reply('isolated child') } }
  isolated.effect(() => isolated.llm.registerAdapter(['fixture'], new Isolated()))
  expect(await collect(isolated.llm.stream(options()))).toEqual([...reply('isolated child')])
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.releases).toHaveBeenCalledOnce()
})

it.each(['unavailable', 'cancelled', 'expired', 'refused'] as const)('preserves the parent resource refusal reason: %s', async (reason) => {
  const f = await fixture(async () => { throw new ResourceAdmissionError(reason, 'Owned parent refusal.') })
  await expect(f.child.resourceBudget.acquire({ kind: 'process' })).rejects.toMatchObject({ reason })
  expect(f.acquire).toHaveBeenCalledOnce()
  expect(f.releases).not.toHaveBeenCalled()
  expect(f.uncertainties).not.toHaveBeenCalled()
})

it.each([true, false])('retains mandatory root policy and one model permit across two child runtimes: allowed=%s', async (allowed) => {
  const f = await fixture(), grandchild = new Context()
  f.withdrawPolicy()
  f.parent.provide('modelAccess', { decide: () => allowed ? { allowed: true } : { allowed: false, reason: 'Root denies grandchild inference.' } })
  const second = new SdkParentControl({ parent: parentAgent(process.cwd(), 'middle-child', f.child), prompt: [],
    signal: f.cancellation.signal }, config)
  try {
    const { env } = await second.open()
    await mountManaged(grandchild, env[SDK_PARENT_CONTROL_ENV])
    await grandchild.plugin(LlmRuntime)
    const dispatch = vi.fn()
    class Adapter extends LlmAdapter { override async *stream() { dispatch(); yield* reply('grandchild') } }
    grandchild.effect(() => grandchild.llm.registerAdapter(['fixture'], new Adapter()))
    const requests: GenerateOptions[] = []
    f.parent.on('llm/delegated-stream', (request, next) => { requests.push(request); return next() })
    const chunks = await collect(grandchild.llm.stream(options()))
    if (allowed) {
      expect(chunks).toEqual([...reply('grandchild')])
      expect(dispatch).toHaveBeenCalledOnce()
    } else {
      expect(chunks.find(chunk => chunk.type === 'finish')).toMatchObject({ reason: { kind: 'error', failure: { code: 'MODEL_FORBIDDEN' } } })
      expect(dispatch).not.toHaveBeenCalled()
    }
    expect(requests).toHaveLength(1)
    expect(requests[0]?.sessionId).toBe('parent-session')
    expect(f.acquire).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'model', sessionId: 'parent-session' }))
    expect(f.releases).toHaveBeenCalledOnce()
    expect(f.uncertainties).not.toHaveBeenCalled()
    expect(f.stream).not.toHaveBeenCalled()
  } finally { try { await grandchild.fiber.dispose() } finally { await second.close() } }
})

it('joins actual adapter cleanup when the child consumer stops before the response ends', async () => {
  const f = await fixture()
  let cleaned = false
  f.stream.mockImplementation(request => (async function* () {
    try {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'response' }
      await new Promise<never>((_resolve, reject) => {
        if (request.signal?.aborted === true) reject(new Error('Owned consumer stopped.'))
        else request.signal?.addEventListener('abort', () => { reject(new Error('Owned consumer stopped.')) }, { once: true })
      })
    } finally { cleaned = true }
  })())
  for await (const chunk of f.child.llm.stream(options())) if (chunk.type === 'text-delta') break
  expect(cleaned).toBe(true)
  expect(f.releases).toHaveBeenCalledOnce()
  expect(f.uncertainties).not.toHaveBeenCalled()
})

it.each(['unload', 'caller cancellation'])('stops a paused model consumer after %s and joins its adapter and parent permit', async (cause) => {
  const f = await fixture(), cancellation = new AbortController()
  let cleaned = false
  f.stream.mockImplementation(request => (async function* () {
    try {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise<never>((_resolve, reject) => {
        if (request.signal?.aborted === true) reject(new Error('Owned model cancelled.'))
        else request.signal?.addEventListener('abort', () => { reject(new Error('Owned model cancelled.')) }, { once: true })
      })
    } finally { cleaned = true }
  })())
  const consumer = f.child.llm.stream({ ...options(), signal: cancellation.signal })[Symbol.asyncIterator]()
  let stopped = false
  let stopping: Promise<void> | undefined
  try {
    expect(await consumer.next()).toMatchObject({ done: false, value: { type: 'block-start' } })
    if (cause === 'unload') stopping = f.managed.dispose().then(() => { stopped = true })
    else { cancellation.abort(); stopped = true }
    await vi.waitFor(() => { expect(stopped).toBe(true) })
    await vi.waitFor(() => { expect(f.releases).toHaveBeenCalledOnce() })
    expect(cleaned).toBe(true)
    expect(f.uncertainties).not.toHaveBeenCalled()
  } finally {
    f.cancellation.abort()
    await consumer.return?.()
    await stopping
  }
})

it('refuses an already cancelled model before adapter dispatch and joins its unused span', async () => {
  const f = await fixture(), cancellation = new AbortController(), reason = new Error('Caller already cancelled.')
  cancellation.abort(reason)
  await expect(collect(f.child.llm.stream({ ...options(), signal: cancellation.signal }))).rejects.toBe(reason)
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('retains a failed parent model close for the consumer to observe', async () => {
  const f = await fixture(), reason = new Error('Owned model close failed.')
  // oxlint-disable-next-line typescript/unbound-method -- The original method is invoked with its client receiver.
  const original = ParentControlClient.prototype.post
  const exchange = vi.spyOn(ParentControlClient.prototype, 'post').mockImplementation(async function (this: ParentControlClient, path, body, signal) {
    if (path === '/model/close') throw reason
    return original.call(this, path, body, signal)
  })
  try { await expect(collect(f.child.llm.stream(options()))).rejects.toBe(reason) } finally { exchange.mockRestore() }
  expect(f.releases).toHaveBeenCalledOnce()
})

it.each(['before delivery', 'after acknowledgement'])('recovers model close failures %s before further model admission', async (phase) => {
  const f = await fixture(undefined, { ...config, maxOperations: 3 })
  const reason = new Error('Owned model close acknowledgement unavailable.')
  let recovered = false
  // oxlint-disable-next-line typescript/unbound-method -- The original method is invoked with its client receiver.
  const original = ParentControlClient.prototype.post
  const exchange = vi.spyOn(ParentControlClient.prototype, 'post').mockImplementation(async function (this: ParentControlClient, path, body, signal) {
    if (path === '/model/close' && !recovered) {
      if (phase === 'after acknowledgement') await original.call(this, path, body, signal)
      throw reason
    }
    return original.call(this, path, body, signal)
  })
  try {
    await expect(collect(f.child.llm.stream(options()))).rejects.toBe(reason)
    await expect(collect(f.child.llm.stream(options()))).rejects.toBe(reason)
    recovered = true
    expect(await collect(f.child.llm.stream(options()))).toEqual([...reply()])
    expect(exchange.mock.calls.filter(([path]) => path === '/model/open')).toHaveLength(2)
    const closes = exchange.mock.calls.filter(([path]) => path === '/model/close').map(([, body]) => body.id)
    expect(closes.slice(0, 3)).toEqual(['1', '1', '1'])
    expect(f.releases).toHaveBeenCalledTimes(2)
  } finally { recovered = true; exchange.mockRestore() }
})

it('retains multiple failed model closures and recovers them before process admission', async () => {
  const f = await fixture()
  const reason = new Error('Owned model closures unavailable.')
  let recovered = false
  // oxlint-disable-next-line typescript/unbound-method -- The original method is invoked with its client receiver.
  const original = ParentControlClient.prototype.post
  const exchange = vi.spyOn(ParentControlClient.prototype, 'post').mockImplementation(async function (this: ParentControlClient, path, body, signal) {
    if (path === '/model/close' && !recovered) throw reason
    return original.call(this, path, body, signal)
  })
  try {
    const first = collect(f.child.llm.stream(options('first'))), second = collect(f.child.llm.stream(options('second')))
    expect(await Promise.allSettled([first, second])).toEqual([
      { status: 'rejected', reason }, { status: 'rejected', reason },
    ])
    await expect(f.child.resourceBudget.acquire({ kind: 'process' })).rejects.toMatchObject({ errors: [reason, reason] })
    expect(f.acquire).toHaveBeenCalledTimes(2)
    recovered = true
    const lease = await f.child.resourceBudget.acquire({ kind: 'process' })
    await lease.release()
    expect(f.acquire).toHaveBeenCalledTimes(3)
    expect(f.releases).toHaveBeenCalledTimes(3)
  } finally { recovered = true; exchange.mockRestore() }
})

it.each(['completed', 'paused'])('reports unacknowledged %s model cleanup after retrying provider withdrawal', async (phase) => {
  const f = await fixture(), reason = new Error('Owned model close remains unacknowledged.')
  const errors = vi.spyOn(f.managed.ctx.logger, 'error').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/unbound-method -- The original method is invoked with its client receiver.
  const original = ParentControlClient.prototype.post
  const exchange = vi.spyOn(ParentControlClient.prototype, 'post').mockImplementation(async function (this: ParentControlClient, path, body, signal) {
    if (path === '/model/close') throw reason
    return original.call(this, path, body, signal)
  })
  let consumer: AsyncIterator<StreamChunk> | undefined
  try {
    if (phase === 'completed') await expect(collect(f.child.llm.stream(options()))).rejects.toBe(reason)
    else {
      consumer = f.child.llm.stream(options())[Symbol.asyncIterator]()
      expect((await consumer.next()).done).toBe(false)
    }
    await f.managed.dispose()
    expect(exchange.mock.calls.filter(([path]) => path === '/model/close')).toHaveLength(2)
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ errors: [reason] }))
    expect(f.releases).toHaveBeenCalledOnce()
  } finally {
    if (consumer !== undefined) await expect(consumer.return?.()).rejects.toBe(reason)
    exchange.mockRestore(); errors.mockRestore()
  }
})

it('refuses managed boot without its connection or with an independent resource provider', async () => {
  const missing = new Context(), independent = new Context()
  onTestFinished(async () => { await independent.fiber.dispose(); await missing.fiber.dispose() })
  await expect(mountManaged(missing, undefined)).rejects.toThrow('requires its parent control connection')
  independent.provide('resourceBudget', { acquire: async () => { throw new Error('Independent budget must not execute.') } })
  await expect(mountManaged(independent, JSON.stringify({ url: 'http://127.0.0.1:1/', token: 'owned-private-control-capability-00000', config })))
    .rejects.toThrow('cannot install an independent resource budget')
})

it('keeps root guards closed after the managed provider is withdrawn', async () => {
  const f = await fixture()
  await f.managed.dispose()
  expect(f.child.get('modelAccessRequired')).toBe(true)
  expect(f.child.get('resourceBudgetRequired')).toBe(true)
  expect(f.child.get('modelAccess')?.decide(options()).allowed).toBe(false)
  await expect(collect(f.child.llm.stream(options()))).rejects.toMatchObject({ code: 'MODEL_POLICY_UNAVAILABLE' })
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('refuses mandatory child authorization without an owning model span', async () => {
  const f = await fixture()
  await expect(f.child.serial(f.child.llm, 'llm/authorize', options())).rejects.toMatchObject({ code: 'MODEL_POLICY_UNAVAILABLE' })
  expect(f.stream).not.toHaveBeenCalled()
})

it('refuses dispatch when its parent LLM service disappears during model admission', async () => {
  const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>()
  const release = vi.fn(async () => {})
  const f = await fixture(async () => { entered.resolve(undefined); return grant.promise })
  const result = collect(f.child.llm.stream(options()))
  try {
    await Promise.race([entered.promise, result.then(() => { throw new Error('Child did not wait for admission.') })])
    await f.parentLlm.dispose()
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    expect((await result).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_POLICY_UNAVAILABLE' } } })
    expect(f.stream).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  } finally {
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    await Promise.allSettled([result])
  }
})

it('reports parent middleware failure before reaching a child model body', async () => {
  const f = await fixture()
  f.parent.on('llm/delegated-stream', () => (async function* () { throw new LlmError('Owned meter failure.', 'OWNED_METER_FAILED') })())
  await expect(collect(f.child.llm.stream(options()))).rejects.toMatchObject({ code: 'OWNED_METER_FAILED' })
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('waits for asynchronous parent middleware before acquiring model capacity', async () => {
  const f = await fixture(), ready = Promise.withResolvers<undefined>()
  const exchanges = vi.spyOn(ParentControlClient.prototype, 'post')
  f.parent.on('llm/delegated-stream', (_request, next) => (async function* () { await ready.promise; yield* next() })())
  const result = collect(f.child.llm.stream(options()))
  try {
    await vi.waitFor(() => { expect(exchanges.mock.calls.filter(([path]) => path === '/model/ready').length).toBeGreaterThanOrEqual(2) })
    expect(f.acquire).not.toHaveBeenCalled()
    ready.resolve(undefined)
    expect(await result).toEqual([...reply()])
  } finally { ready.resolve(undefined); await Promise.allSettled([result]); exchanges.mockRestore() }
})

it.each([
  new LlmError('Owned middleware refusal.', 'OWNED_CHILD_MIDDLEWARE'),
  new ResourceAdmissionError('refused', 'Owned middleware resource refusal.'),
  new Error('Private middleware diagnostic must not enter the parent wire.'),
])('relays a child middleware failure without dispatching its adapter: %j', async (failure) => {
  const f = await fixture()
  f.child.on('llm/stream', () => (async function* () { throw failure })())
  const chunks = await collect(f.child.llm.stream(options()))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: {
    code: failure instanceof LlmError ? failure.code : 'SDK_CHILD_MODEL_FAILED',
    message: failure instanceof LlmError || failure instanceof ResourceAdmissionError ? failure.message : 'SDK child model stream failed.',
  } } })
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('refuses a model body when the parent LLM service was withdrawn before registration', async () => {
  const f = await fixture()
  await f.parentLlm.dispose()
  await expect(collect(f.child.llm.stream(options()))).rejects.toMatchObject({ code: 'MODEL_POLICY_UNAVAILABLE' })
  expect(f.stream).not.toHaveBeenCalled()
})

it('rejects unauthorized control traffic without performing resource operations', async () => {
  const f = await fixture()
  for (const headers of [{}, { authorization: 'Bearer wrong' }, { authorization: `Bearer ${f.connection.token}` }]) {
    const response = await fetch(f.connection.url, { method: 'GET', headers })
    expect(response.status).toBe(401)
    expect(response.headers.get('connection')).toBe('close')
    await response.body?.cancel()
  }
  const response = await fetch(f.connection.url, { method: 'POST', body: '{}' })
  expect(response.status).toBe(401)
  expect(response.headers.get('connection')).toBe('close')
  await response.body?.cancel()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('bounds live registrations, consumes early cancellations and never reallocates completed ids', async () => {
  const f = await fixture(undefined, { ...config, maxOperations: 4 }), client = new ParentControlClient(f.connection)
  try {
    await client.post('/model/open', { id: '1', options: options() })
    await client.post('/model/open', { id: '1', options: options() })
    expect(await client.post('/model/ready', { id: '1' })).toEqual({ dispatch: true })
    await client.post('/resource/register', { id: '2', kind: 'model', modelId: '1' })
    await client.post('/resource/register', { id: '2', kind: 'model', modelId: '1' })
    await expect(client.post('/model/authorize', { id: '1', options: options() })).rejects.toMatchObject({ code: 'MODEL_POLICY_UNAVAILABLE' })
    await client.post('/resource/register', { id: '3', kind: 'process' })
    await client.post('/resource/register', { id: '4', kind: 'process' })
    await expect(client.post('/resource/register', { id: '5', kind: 'process' })).rejects.toMatchObject({ reason: 'refused' })
    expect(f.acquire).toHaveBeenCalledTimes(3)
    expect(await client.post('/resource/status', { id: '2' })).toEqual({ state: 'granted' })
    await expect(client.post('/model/authorize', { id: '1', options: options('changed') })).rejects.toMatchObject({ code: 'INVALID_PREPARED_CALL' })
    await client.post('/model/authorize', { id: '1', options: options() })
    await client.post('/model/input', { id: '1', chunk: { type: 'finish', reason: { kind: 'stop' } } })
    await client.post('/model/finish', { id: '1' })
    expect(await client.post('/model/output', { id: '1' })).toMatchObject({ done: false, chunk: { type: 'finish' } })
    await client.post('/model/close', { id: '1' })
    await client.post('/resource/finish', { id: '2', outcome: 'released' })
    await client.post('/resource/finish', { id: '2', outcome: 'released' })
    expect(await client.post('/resource/status', { id: '2' })).toEqual({ state: 'finished' })
    await client.post('/resource/finish', { id: '3', outcome: 'uncertain' })
    await client.post('/resource/status', { id: '4' })
    await client.post('/resource/finish', { id: '4', outcome: 'uncertain' })
    expect(f.releases).toHaveBeenCalledTimes(2)
    expect(f.uncertainties).toHaveBeenCalledOnce()
    await expect(client.post('/resource/register', { id: '2', kind: 'process' })).rejects.toMatchObject({ reason: 'refused' })
    await client.post('/resource/register', { id: '5', kind: 'process' })
    await client.post('/resource/finish', { id: '6', outcome: 'released' })
    await expect(client.post('/resource/register', { id: '6', kind: 'process' })).rejects.toMatchObject({ reason: 'cancelled' })
    for (const id of ['7', '8', '9', '10']) await client.post('/model/close', { id })
    await expect(client.post('/model/close', { id: '11' })).rejects.toMatchObject({ reason: 'refused' })
    await expect(client.post('/model/ready', { id: '99' })).rejects.toMatchObject({ reason: 'unavailable' })
    await expect(client.post('/resource/register', { id: '12', kind: 'invalid' })).rejects.toThrow()
    await expect(client.post('/resource/finish', { id: '5', outcome: 'invalid' })).rejects.toThrow()
    await expect(client.post('/unknown', { id: '5' })).rejects.toThrow()
    await client.post('/resource/finish', { id: '5', outcome: 'released' })
    await f.control.close()
    expect(() =>{  f.control.assertReady() }).toThrow('did not activate required parent control')
  } finally { client.close() }
})

it('rejects a resource provider replaced before child registration', async () => {
  const f = await fixture(), client = new ParentControlClient(f.connection)
  try {
    await f.parentBudget.dispose()
    f.parent.provide('resourceBudget', { acquire: async () => { throw new Error('Replacement budget must not execute.') } })
    await client.post('/resource/register', { id: '1', kind: 'process' })
    expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'failed', reason: 'unavailable' })
    await client.post('/resource/finish', { id: '1', outcome: 'released' })
    expect(f.acquire).not.toHaveBeenCalled()
  } finally { client.close() }
})

it('rejects control operations after the parent execution authority is replaced', async () => {
  const f = await fixture(), client = new ParentControlClient(f.connection)
  f.parent.provide('executionAuthority', {})
  try {
    await expect(client.post('/resource/register', { id: '1', kind: 'process' })).rejects.toMatchObject({ reason: 'unavailable' })
    expect(f.acquire).not.toHaveBeenCalled()
  } finally { client.close() }
})

it('admits policy-only child calls without inventing a parent capacity provider', async () => {
  const f = await fixture(undefined, config, false)
  expect(await collect(f.child.llm.stream(options()))).toEqual([...reply()])
  const lease = await f.child.resourceBudget.acquire({ kind: 'process' })
  await lease.release()
  const uncertain = await f.child.resourceBudget.acquire({ kind: 'process' })
  await uncertain.uncertain()
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.stream).toHaveBeenCalledOnce()
})

it('returns an unused grant if its parent budget is replaced during admission', async () => {
  const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>(), release = vi.fn(async () => {})
  const f = await fixture(async () => { entered.resolve(undefined); return grant.promise }), client = new ParentControlClient(f.connection)
  try {
    await client.post('/resource/register', { id: '1', kind: 'process' })
    await entered.promise
    await f.parentBudget.dispose()
    f.parent.provide('resourceBudget', { acquire: async () => { throw new Error('Replacement must not admit old work.') } })
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    await vi.waitFor(async () => {
      expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'failed', reason: 'unavailable' })
    })
    await client.post('/resource/finish', { id: '1', outcome: 'released' })
    expect(release).toHaveBeenCalledOnce()
  } finally { grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} }); client.close() }
})

it('refuses new HTTP control work while joined shutdown waits for an unused grant', async () => {
  const entered = Promise.withResolvers<undefined>(), grant = Promise.withResolvers<ResourceLease>(), release = vi.fn(async () => {})
  const f = await fixture(async () => { entered.resolve(undefined); return grant.promise }), client = new ParentControlClient(f.connection)
  let closing: Promise<void> | undefined
  try {
    await client.post('/resource/register', { id: '1', kind: 'process' })
    await entered.promise
    closing = f.control.close()
    const response = await fetch(f.connection.url, { method: 'POST', headers: { authorization: `Bearer ${f.connection.token}` }, body: '{}' })
    expect(response.status).toBe(503)
    await response.body?.cancel()
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} })
    await closing
    expect(release).toHaveBeenCalledOnce()
  } finally { grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => {} }); await closing; client.close() }
})

it('closes an oversized parent response before reaching the child adapter', async () => {
  const f = await fixture(undefined, { ...config, maxBytes: 256 })
  f.parent.on('llm/delegated-stream', () => (async function* () { yield* reply('x'.repeat(512)) })())
  await expect(collect(f.child.llm.stream(options()))).rejects.toThrow()
  expect(f.stream).not.toHaveBeenCalled()
  expect(f.acquire).not.toHaveBeenCalled()
})

it('withdraws an admitted model permit when its parent stream is closed', async () => {
  const f = await fixture(), client = new ParentControlClient(f.connection)
  try {
    await client.post('/model/open', { id: '1', options: options() })
    await client.post('/resource/register', { id: '2', kind: 'model', modelId: '1' })
    expect(await client.post('/resource/status', { id: '2' })).toEqual({ state: 'granted' })
    await client.post('/model/close', { id: '1' })
    expect(await client.post('/resource/status', { id: '2' })).toEqual({ state: 'cancelled' })
    await client.post('/resource/finish', { id: '2', outcome: 'released' })
    expect(f.releases).toHaveBeenCalledOnce()
  } finally { client.close() }
})

it('retains a separately owned process permit after the model call that created it finishes', async () => {
  const f = await fixture()
  let processLease: ResourceLease | undefined
  f.stream.mockImplementation(() => (async function* () {
    processLease = await f.child.resourceBudget.acquire({ kind: 'process' })
    yield* reply()
  })())
  try {
    expect(await collect(f.child.llm.stream(options()))).toEqual([...reply()])
    expect(processLease?.signal.aborted).toBe(false)
    expect(f.acquire.mock.calls.map(([request]) => request.kind)).toEqual(['model', 'process'])
  } finally { await processLease?.release() }
})

it('refuses model capacity before its parent middleware admits the child body', async () => {
  const f = await fixture(), ready = Promise.withResolvers<undefined>(), client = new ParentControlClient(f.connection)
  f.parent.on('llm/delegated-stream', (_request, next) => (async function* () { await ready.promise; yield* next() })())
  try {
    await client.post('/model/open', { id: '1', options: options() })
    expect(await client.post('/model/ready', { id: '1' })).toEqual({ pending: true })
    await client.post('/resource/register', { id: '2', kind: 'model', modelId: '1' })
    expect(await client.post('/resource/status', { id: '2' })).toEqual({ state: 'failed', reason: 'unavailable' })
    expect(f.acquire).not.toHaveBeenCalled()
    await client.post('/resource/finish', { id: '2', outcome: 'released' })
  } finally { ready.resolve(undefined); client.close() }
})

it('returns an already withdrawn grant before publishing a child resource lease', async () => {
  const release = vi.fn(async () => {})
  const f = await fixture(async () => ({ signal: AbortSignal.abort(), release, uncertain: async () => {} }))
  await expect(f.child.resourceBudget.acquire({ kind: 'process' })).rejects.toMatchObject({ reason: 'cancelled' })
  expect(release).toHaveBeenCalledOnce()
})

it('reports an untyped parent middleware rejection without exposing its value', async () => {
  const f = await fixture(), warning = vi.spyOn(f.parent.logger, 'warn').mockImplementation(() => {})
  f.parent.on('llm/delegated-stream', () => (async function* () {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Plugin rejections have no static Error-only guarantee.
    await Promise.reject('Owned private rejection value.')
  })())
  try {
    await expect(collect(f.child.llm.stream(options()))).rejects.toMatchObject({
      reason: 'unavailable', message: 'SDK parent control rejected the request.',
    })
    expect(f.stream).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalled()
  } finally { warning.mockRestore() }
})

it('bounds concurrent held HTTP relay requests and joins their cancellation', async () => {
  const f = await fixture(undefined, { ...config, maxOperations: 4, requestTimeoutMs: 3000, cleanupTimeoutMs: 4000 })
  const client = new ParentControlClient(f.connection), ready = Promise.withResolvers<undefined>()
  const outputHeld = Promise.withResolvers<undefined>()
  const writes = vi.spyOn(ModelChannel.prototype, 'push'), sends: Promise<unknown>[] = []
  // oxlint-disable-next-line typescript/unbound-method -- The original read is called with its actual channel receiver.
  const take = ModelChannel.prototype.take
  let reads = 0
  const reading = vi.spyOn(ModelChannel.prototype, 'take').mockImplementation(async function (this: ModelChannel<unknown>, signal) {
    if (++reads === 4) outputHeld.resolve(undefined)
    await ready.promise
    return Reflect.apply(take, this, [signal])
  })
  f.parent.on('llm/delegated-stream', (_request, next) => (async function* () { await ready.promise; yield* next() })())
  try {
    for (const id of ['1', '2', '3', '4']) await client.post('/model/open', { id, options: options() })
    for (const id of ['1', '2', '3', '4']) {
      sends.push(client.post('/model/input', { id, chunk: { type: 'finish', reason: { kind: 'stop' } } })
        .then(() => undefined, (error: unknown) => error))
      sends.push(client.post('/model/output', { id }).then(() => undefined, (error: unknown) => error))
    }
    await outputHeld.promise
    await vi.waitFor(() => { expect(writes).toHaveBeenCalledTimes(4) })
    const response = await fetch(new URL('/runtime/ready', f.connection.url), { method: 'POST',
      headers: { authorization: `Bearer ${f.connection.token}` }, body: '{"id":"99"}' })
    expect(response.status).toBe(503)
    expect(response.headers.get('connection')).toBe('close')
    await response.body?.cancel()
    expect(f.acquire).not.toHaveBeenCalled()
  } finally {
    ready.resolve(undefined)
    await Promise.all(sends)
    await f.control.close()
    client.close()
    writes.mockRestore()
    reading.mockRestore()
  }
})

it.each([false, true])('contains HTTP response failures including repeated failure=%s', async (repeated) => {
  const f = await fixture(), client = new ParentControlClient(f.connection)
  const warning = vi.spyOn(f.parent.logger, 'warn').mockImplementation(() => {})
  const writing = vi.spyOn(ServerResponse.prototype, 'writeHead')
  const fail = (): never => { throw new Error('Owned HTTP response failure.') }
  if (repeated) writing.mockImplementation(fail)
  else writing.mockImplementationOnce(fail)
  try {
    await expect(client.post('/runtime/ready', { id: '1' })).rejects.toThrow()
    expect(warning).toHaveBeenCalled()
  } finally { writing.mockRestore(); warning.mockRestore(); client.close() }
})

it('refuses a control message whose parsing overlaps parent shutdown', async () => {
  const f = await fixture(), client = new ParentControlClient(f.connection)
  const decoding = Wire.controlJson, entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const parsing = vi.spyOn(Wire, 'controlJson').mockImplementation(async (parts, maxBytes) => {
    const value = await decoding(parts, maxBytes)
    if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'process') {
      entered.resolve(undefined); await proceed.promise
    }
    return value
  })
  const request = client.post('/resource/register', { id: '1', kind: 'process' })
  const received = request.then(() => undefined, (error: unknown) => error)
  let closing: Promise<void> | undefined
  try {
    await Promise.race([entered.promise, request.then(() => { throw new Error('Control message did not wait in parsing.') })])
    closing = f.control.close()
    proceed.resolve(undefined)
    await received
    await closing
    expect(f.acquire).not.toHaveBeenCalled()
  } finally { proceed.resolve(undefined); parsing.mockRestore(); client.close(); await closing; await received }
})
