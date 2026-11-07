/** Private process-wire validation, bounded transport, and cleanup ownership. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, request as httpRequest, Server, type RequestListener } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ModelChannel } from '../src/channel.ts'
import { SdkParentControl } from '../src/bridge.ts'
import { controlChunk, controlConnection, controlId, controlJson, controlOptions, type SdkControlConfig } from '../src/control.ts'
import { ParentControlClient } from '../src/managed-client.ts'
import { ManagedSdkBudget } from '../src/managed-budget.ts'
import { parentAgent } from './agent-fixture.ts'
import { managedControlEntry } from '../src/control-entry.ts'
import { mountManaged } from './managed-fixture.ts'
import LlmRuntime, { LlmAdapter, type StreamChunk } from '@deepseek-ai/dsh-llm'

const limits: SdkControlConfig = { maxBytes: 4096, maxOperations: 8, requestTimeoutMs: 500, pollMs: 20, cleanupTimeoutMs: 1000 }
const token = 'owned-control-capability-000000000000'
const connection = { url: 'http://127.0.0.1:1/', token, config: limits }

it('retains translation purpose without accepting child ownership claims', () => {
  expect(controlOptions({ provider: 'p', model: 'm', messages: [], purpose: 'translation',
    sessionId: 'forged', resourceOrigin: 'interactive', executionIdentity: { primaryActorUserId: 99 } }))
    .toEqual({ provider: 'p', model: 'm', messages: [], purpose: 'translation' })
})

it.each([
  ['stalled', 20, 4096, '', 'unavailable', 'SDK control request body timed out.'],
  ['oversized', 5000, 128, 'x'.repeat(129), 'refused', 'SDK control message exceeds its byte limit.'],
] as const)('bounds an incomplete authenticated control body: %s and restores the occupied request slot', async (
  _kind, requestTimeoutMs, maxBytes, partial, code, message,
) => {
  const ctx = new Context()
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'control-body-deadline', ctx),
    prompt: [], signal: new AbortController().signal }, {
    ...limits, maxOperations: 1, requestTimeoutMs, maxBytes, pollMs: 1, cleanupTimeoutMs: 10_000,
  })
  const { env } = await control.open()
  const descriptor = controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!))
  const client = new ParentControlClient({ ...descriptor, config: { ...descriptor.config, requestTimeoutMs: 1000 } })
  const continued = Promise.withResolvers<undefined>()
  const received = Promise.withResolvers<{ status: number | undefined; text: string; connection: string | undefined }>()
  const outgoing = httpRequest(new URL('/resource/register', descriptor.url), { method: 'POST', headers: {
    authorization: `Bearer ${descriptor.token}`, 'content-length': '1000', expect: '100-continue', connection: 'keep-alive',
  } }, (response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of response as AsyncIterable<Buffer>) parts.push(part)
      return { status: response.statusCode, text: Buffer.concat(parts).toString('utf8'), connection: response.headers.connection }
    })().then(received.resolve, received.reject)
  })
  const closed = new Promise<void>((resolve) => { outgoing.once('close', () => { resolve() }) })
  outgoing.once('continue', () => { continued.resolve(undefined) })
  outgoing.once('error', (error) => { continued.reject(error); received.reject(error) })
  let watchdog: ReturnType<typeof setTimeout> | undefined
  try {
    outgoing.flushHeaders()
    await continued.promise
    if (partial !== '') outgoing.write(partial)
    const result = await Promise.race([received.promise, new Promise<undefined>((resolve) => {
      watchdog = setTimeout(() => { resolve(undefined) }, 1500)
    })])
    expect(result?.status).toBe(400)
    expect(result?.connection).toBe('close')
    expect(JSON.parse(result?.text ?? '{}')).toEqual({ error: { code, message } })
    await closed
    await client.post('/runtime/ready', { id: '1' })
    expect(() => { control.assertReady() }).not.toThrow()
  } finally {
    clearTimeout(watchdog); outgoing.destroy(); await closed; client.close()
    try { await control.close() } finally { await ctx.fiber.dispose() }
  }
})

async function server(listener: RequestListener, config = limits): Promise<ParentControlClient> {
  const http = createServer(listener)
  onTestFinished(async () => {
    http.closeAllConnections()
    await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => { http.removeListener('error', reject); resolve() })
  })
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('Owned HTTP fixture did not bind.')
  const client = new ParentControlClient({ url: `http://127.0.0.1:${String(address.port)}/`, token, config })
  onTestFinished(() => { client.close() })
  return client
}

it.each([undefined, null, [], '0', '-1', '1.1', '01', '9007199254740992'])('refuses invalid operation identity: %j', (value) => {
  expect(() => controlId(value)).toThrow()
})

it('accepts safe operation identities and strips child-supplied parent authority', () => {
  expect(controlId('9007199254740991')).toBe('9007199254740991')
  const input = { provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'input' }] }],
    system: '', reasoningEffort: 'max', purpose: 'web-search', maxTokens: 2, temperature: 0, stop: ['stop'],
    tools: [{ name: 'tool', description: 'Tool', parameters: {}, deferLoading: true }], operation: { name: 'native', request: {} } }
  expect(controlOptions({ ...input, sessionId: 'forged', resourceOrigin: 'infrastructure', signal: {}, executionIdentity: { primaryActorUserId: 99 } }))
    .toEqual(input)
})

it.each([
  { provider: undefined }, { provider: '', model: 'm', messages: [] }, { provider: 'p', model: 'm', messages: [{}] },
  { messages: [{ role: 'invalid', content: [] }] }, { messages: [{ role: 'user', content: [{ type: '' }] }] },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 1 }] }] },
  { system: [] }, { reasoningEffort: '' }, { purpose: 'unregistered' }, { tools: {} },
  { tools: [{ name: 'x', description: 'x', parameters: [], deferLoading: true }] },
  { tools: [{ name: 'x', description: 'x', parameters: {}, deferLoading: false }] },
  { maxTokens: 0 }, { maxTokens: 1.1 }, { temperature: Infinity }, { stop: ['x', 1] },
  { operation: { name: '', request: {} } }, { operation: { name: 'native' } },
])('refuses malformed child model input: %j', (value) => {
  expect(() => controlOptions({ provider: 'p', model: 'm', messages: [], ...value })).toThrow()
})

it.each([
  { url: 'https://127.0.0.1/' }, { url: 'http://localhost/' }, { url: 'http://127.0.0.1/path' },
  { url: 'http://user@127.0.0.1/' }, { url: 'http://127.0.0.1/?query' }, { url: 'http://127.0.0.1/#hash' },
  { token: 'short' }, { config: { ...limits, maxBytes: 0 } }, { config: { ...limits, maxOperations: 1.5 } },
  { config: { ...limits, pollMs: limits.requestTimeoutMs } }, { config: { ...limits, cleanupTimeoutMs: 2_147_483_648 } },
])('refuses invalid parent connection settings: %j', (value) => {
  expect(() => controlConnection({ ...connection, ...value })).toThrow()
})

it('accepts the loopback capability and decodes split UTF-8 within its byte budget', async () => {
  expect(controlConnection(connection)).toEqual(connection)
  const bytes = Buffer.from('{"text":"模型"}')
  const parts = async function* () { yield bytes.subarray(0, 11); yield bytes.subarray(11) }
  expect(await controlJson(parts(), bytes.length)).toEqual({ text: '模型' })
  await expect(controlJson(parts(), bytes.length - 1)).rejects.toMatchObject({ reason: 'refused' })
  await expect(controlJson((async function* () { yield Buffer.from('1e999') })(), 32)).rejects.toThrow('Invalid SDK JSON number.')
})

it.each([
  { type: 'unknown' }, { type: 'usage', usage: { inputTokens: -1, outputTokens: 0 } },
  { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 1.5 } },
  { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 }, credentialSource: 1 },
  { type: 'finish', reason: { kind: 'error' } }, { type: 'finish', reason: { kind: '' } },
  { type: 'text-delta', index: 0, text: 1 }, { type: 'tool-call-delta', index: 0, id: 'x', argumentsDelta: 1 },
  { type: 'block-start', index: 0 }, { type: 'block-end', index: 0, block: {} },
  { type: 'text-delta', index: -1, text: 'x' },
])('refuses malformed model stream input: %j', (value) => {
  expect(() => controlChunk(value)).toThrow()
})

it('keeps cancellation local to a polling read while retaining backpressure', async () => {
  const channel = new ModelChannel<number>(), cancel = new AbortController()
  const first = channel.take(cancel.signal), rejected = expect(first).rejects.toThrow('cancelled')
  cancel.abort()
  await rejected
  const acknowledged = vi.fn()
  const send = channel.push(7).then(acknowledged)
  expect(acknowledged).not.toHaveBeenCalled()
  expect(await channel.take()).toEqual({ done: false, value: 7 })
  await send
  expect(acknowledged).toHaveBeenCalledOnce()
  channel.close()
  expect(await channel.take()).toEqual({ done: true, value: undefined })
})

it('closes pending readers and rejects undelivered or concurrent frames', async () => {
  const reading = new ModelChannel<number>(), sending = new ModelChannel<number>()
  const read = reading.take()
  await expect(reading.take()).rejects.toThrow('Concurrent')
  reading.close()
  expect(await read).toEqual({ done: true, value: undefined })
  const send = sending.push(1), rejected = expect(send).rejects.toThrow('owned relay failure')
  await expect(sending.push(2)).rejects.toThrow('Concurrent')
  sending.close(new Error('owned relay failure'))
  sending.close()
  await rejected
  await expect(sending.take()).rejects.toThrow('owned relay failure')
  await expect(sending.push(3)).rejects.toThrow('owned relay failure')
  await expect(reading.take(AbortSignal.abort())).rejects.toThrow('cancelled')
  await expect(reading.push(4)).rejects.toThrow('closed')
  const undelivered = new ModelChannel<number>(), failedReader = new ModelChannel<number>()
  const sendPending = expect(undelivered.push(5)).rejects.toThrow('closed')
  undelivered.close()
  await sendPending
  const readPending = expect(failedReader.take()).rejects.toThrow('owned read failure')
  failedReader.close(new Error('owned read failure'))
  await readPending
})

it('validates native tool deltas and complete error and usage envelopes', () => {
  const delta = { type: 'tool-call-delta', index: 1, id: 'call', name: 'tool', argumentsDelta: '{}' }
  expect(controlChunk(delta)).toEqual(delta)
  expect(controlChunk({ ...delta, name: undefined })).toEqual({ ...delta, name: undefined })
  expect(() => controlChunk({ ...delta, name: 2 })).toThrow('Invalid SDK tool delta.')
  expect(() => controlChunk({ type: 'finish', reason: { kind: 'error', failure: { code: 1, message: 'error' } } }))
    .toThrow('Invalid SDK model failure.')
  expect(() => controlChunk({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: -1 } }))
    .toThrow('Invalid SDK token usage.')
  const message = { provider: 'p', model: 'm', messages: [{ role: 'assistant', content: [{ type: 'reasoning', text: 'owned' }] }] }
  expect(controlOptions(message)).toEqual(message)
})

it('bounds request and response bodies and preserves structured refusal reasons', async () => {
  const received: string[] = []
  const client = await server((request, response) => {
    expect(request.headers.authorization).toBe(`Bearer ${token}`)
    received.push(request.url ?? '')
    request.resume()
    response.setHeader('content-type', 'application/json')
    if (request.url === '/large') response.end(JSON.stringify({ content: 'x'.repeat(limits.maxBytes) }))
    else { response.statusCode = 400; response.end(JSON.stringify({ error: { code: 'expired', message: 'Owned admission expiry.' } })) }
  })
  await expect(client.post('/oversized', { content: 'x'.repeat(limits.maxBytes) })).rejects.toMatchObject({ reason: 'refused' })
  expect(received).toEqual([])
  await expect(client.post('/large', {})).rejects.toMatchObject({ reason: 'refused' })
  await expect(client.post('/expired', {})).rejects.toMatchObject({ reason: 'expired', message: 'Owned admission expiry.' })
})

it('preserves admission and cleanup failures when cancellation cannot be acknowledged', async () => {
  const client = await server((request, response) => {
    request.resume()
    response.setHeader('content-type', 'application/json')
    if (request.url === '/resource/register') response.end('{}')
    else if (request.url === '/resource/status') response.end('{"state":"failed","reason":"expired"}')
    else { response.statusCode = 400; response.end('{"error":{"code":"unavailable","message":"Owned cleanup failure."}}') }
  })
  const ctx = new Context(), budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  onTestFinished(() => ctx.fiber.dispose())
  await expect(budget.acquire({ kind: 'process' })).rejects.toMatchObject({ errors: [
    expect.objectContaining({ reason: 'expired' }), expect.objectContaining({ reason: 'unavailable' }),
  ] })
  await expect(budget.close()).rejects.toBeInstanceOf(AggregateError)
  await expect(budget.acquire({ kind: 'process' })).rejects.toMatchObject({ reason: 'unavailable' })
})

it('refuses unowned model admission and retains an unacknowledged active permit as uncertain on shutdown', async () => {
  const outcomes: unknown[] = []
  const client = await server((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => { parts.push(part) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>
      response.setHeader('content-type', 'application/json')
      if (request.url === '/resource/status') response.end('{"state":"granted"}')
      else { if (request.url === '/resource/finish') outcomes.push(body.outcome); response.end('{}') }
    })
  }, { ...limits, requestTimeoutMs: 100, pollMs: 20, cleanupTimeoutMs: 200 })
  const ctx = new Context(), budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  onTestFinished(() => ctx.fiber.dispose())
  await expect(budget.acquire({ kind: 'model' })).rejects.toMatchObject({ reason: 'unavailable' })
  const lease = await budget.acquire({ kind: 'process' })
  await budget.close()
  expect(lease.signal.aborted).toBe(true)
  expect(outcomes).toEqual(['uncertain'])
})

it('rejects malformed parent error documents and responses without a JSON body', async () => {
  const client = await server((request, response) => {
    request.resume()
    if (request.url === '/empty') { response.statusCode = 204; response.end(); return }
    response.statusCode = 400
    response.setHeader('content-type', 'application/json')
    response.end('{"error":{}}')
  })
  await expect(client.post('/empty', {})).rejects.toBeInstanceOf(SyntaxError)
  await expect(client.post('/invalid-error', {})).rejects.toMatchObject({ code: 'SDK_PARENT_CONTROL_ERROR' })
})

it.each(['released', 'uncertain'] as const)('joins consumer %s reports during resource-provider shutdown', async (outcome) => {
  const outcomes: unknown[] = []
  const client = await server((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => { parts.push(part) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>
      if (request.url === '/resource/finish') outcomes.push(body.outcome)
      response.setHeader('content-type', 'application/json')
      response.end(request.url === '/resource/status' ? '{"state":"granted"}' : '{}')
    })
  })
  const ctx = new Context(), budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  onTestFinished(() => ctx.fiber.dispose())
  const lease = await budget.acquire({ kind: 'process' }), report = Promise.withResolvers<undefined>()
  lease.signal.addEventListener('abort', () => {
    void lease[outcome === 'released' ? 'release' : 'uncertain']().then(() => { report.resolve(undefined) }, report.reject)
  }, { once: true })
  await budget.close()
  await report.promise
  expect(outcomes).toEqual([outcome])
})

it('reports failed uncertain-resource acknowledgements instead of claiming successful shutdown', async () => {
  const client = await server((request, response) => {
    request.resume()
    response.setHeader('content-type', 'application/json')
    if (request.url === '/resource/finish') {
      response.statusCode = 400
      response.end('{"error":{"code":"unavailable","message":"Owned uncertain report failure."}}')
    } else response.end(request.url === '/resource/status' ? '{"state":"granted"}' : '{}')
  }, { ...limits, requestTimeoutMs: 100, cleanupTimeoutMs: 200 })
  const ctx = new Context(), budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  onTestFinished(() => ctx.fiber.dispose())
  await budget.acquire({ kind: 'process' })
  await expect(budget.close()).rejects.toMatchObject({ errors: [expect.objectContaining({ reason: 'unavailable' })] })
})

it.each([false, true])('retains a control listener failure with failed cleanup=%s', async (cleanupFails) => {
  const ctx = new Context(), failure = new Error('Owned listen failure.'), cleanup = new Error('Owned listener cleanup failure.')
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'listen-owner', ctx), prompt: [], signal: AbortSignal.abort() }, limits)
  const listening = vi.spyOn(Server.prototype, 'listen').mockImplementation(function (this: Server) { this.emit('error', failure); return this })
  const closing = cleanupFails ? vi.spyOn(control, 'close').mockRejectedValue(cleanup) : undefined
  try {
    if (cleanupFails) await expect(control.open()).rejects.toMatchObject({ errors: [failure, cleanup] })
    else await expect(control.open()).rejects.toBe(failure)
  } finally {
    listening.mockRestore()
    closing?.mockRestore()
    await control.close()
    await ctx.fiber.dispose()
  }
})

it('selects the matching source or built child entry without requiring build output on a clean checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-control-entry-'))
  try {
    const source = pathToFileURL(join(root, 'src/bridge.ts')), built = pathToFileURL(join(root, 'lib/managed.js'))
    expect(managedControlEntry(source)).toEqual(pathToFileURL(join(root, 'src/managed.ts')))
    await mkdir(join(root, 'lib'))
    await writeFile(built, 'export {}\n')
    expect(managedControlEntry(source)).toEqual(built)
    expect(managedControlEntry(pathToFileURL(join(root, 'lib/index.js')))).toEqual(built)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it.each([null, 'unexpected-unix-listener'])('joins the listener when its bound address cannot be published: %j', async (address) => {
  const ctx = new Context(), control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'invalid-address', ctx),
    prompt: [], signal: new AbortController().signal }, limits)
  const reading = vi.spyOn(Server.prototype, 'address').mockReturnValue(address)
  try { await expect(control.open()).rejects.toThrow('has no loopback listener') }
  finally { reading.mockRestore(); await control.close(); await ctx.fiber.dispose() }
})

it.each(['readiness', 'output', 'input', 'finish'] as const)('refuses a malformed or failed parent %s exchange', async (fault) => {
  const resourceOutcomes: unknown[] = []
  const client = await server((request, response) => {
    const parts: Buffer[] = []
    request.on('data', (part: Buffer) => { parts.push(part) })
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>
      let output: unknown = {}
      if (request.url === '/model/ready') output = { dispatch: fault === 'readiness' ? 0 : fault !== 'output' }
      if (request.url === '/model/output') output = fault === 'output' ? { done: 0 } : { pending: true }
      if (request.url === '/resource/status') output = { state: 'granted' }
      if (request.url === '/resource/finish') resourceOutcomes.push(body.outcome)
      if ((fault === 'input' || fault === 'finish') && request.url === `/model/${fault}`) {
        response.statusCode = 400
        output = { error: { code: 'OWNED_PARENT_EXCHANGE_FAILED', message: 'Owned parent exchange failure.' } }
      }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(output))
    })
  })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await mountManaged(ctx, JSON.stringify(client.connection))
  await ctx.plugin(LlmRuntime)
  const dispatch = vi.fn()
  class Adapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> { dispatch(); yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['wire-fixture'], new Adapter()))
  const drain = async () => { for await (const _chunk of ctx.llm.stream({ provider: 'wire-fixture', model: 'm', messages: [] })) { /* Drain output. */ } }
  await expect(drain()).rejects.toMatchObject({
    code: fault === 'readiness' || fault === 'output' ? 'SDK_PARENT_CONTROL_ERROR' : 'OWNED_PARENT_EXCHANGE_FAILED',
  })
  if (fault === 'readiness' || fault === 'output') expect(dispatch).not.toHaveBeenCalled()
  else { expect(dispatch).toHaveBeenCalledOnce(); expect(resourceOutcomes).toEqual(['released']) }
})

it('retains explicit child policy and root requirements while installing mandatory parent guards', async () => {
  const client = await server((request, response) => { request.resume(); response.end('{}') })
  const ctx = new Context(), policy = { decide: () => ({ allowed: true as const }) }
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('resourceBudgetRequired', true)
  ctx.provide('modelAccessRequired', true)
  ctx.provide('modelAccess', policy)
  const managed = await mountManaged(ctx, JSON.stringify(client.connection))
  await ctx.plugin(LlmRuntime)
  expect(ctx.get('modelAccess')).toBe(policy)
  await managed.dispose()
  await expect(ctx.serial(ctx.llm, 'llm/authorize', { provider: 'p', model: 'm', messages: [] }))
    .rejects.toMatchObject({ code: 'MODEL_POLICY_UNAVAILABLE' })
})

it('never lets an obsolete aborted read cancel its replacement after delivery', async () => {
  const channel = new ModelChannel<number>(), signal = new AbortController()
  let replacement: Promise<IteratorResult<number>> | undefined
  signal.signal.addEventListener('abort', () => { void channel.push(1); replacement = channel.take() }, { once: true })
  const first = channel.take(signal.signal)
  signal.abort()
  expect(await first).toEqual({ done: false, value: 1 })
  await channel.push(2)
  expect(await replacement).toEqual({ done: false, value: 2 })
  channel.close()
})

it('joins a late status response after the consumer acknowledged cleanup', async () => {
  const client = await server((request, response) => {
    request.resume()
    response.end(request.url === '/resource/status' ? '{"state":"granted"}' : '{}')
  })
  const ctx = new Context(), budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  onTestFinished(() => ctx.fiber.dispose())
  const actualPost = client.post.bind(client), observed = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  let statusCalls = 0
  const exchanges = vi.spyOn(client, 'post').mockImplementation(async (path, body, signal) => {
    const value = await actualPost(path, body, signal)
    if (path === '/resource/status' && ++statusCalls === 2) { observed.resolve(undefined); await proceed.promise }
    return value
  })
  const lease = await budget.acquire({ kind: 'process' })
  try {
    await observed.promise
    const closing = budget.close()
    await lease.release()
    proceed.resolve(undefined)
    await closing
  } finally { proceed.resolve(undefined); exchanges.mockRestore() }
})

it('preserves failed parent uncertainty reports while closing its HTTP listener', async () => {
  const ctx = new Context(), failure = new Error('Owned parent uncertainty failure.')
  const release = vi.fn(async () => {}), uncertain = vi.fn(async () => { throw failure })
  ctx.provide('resourceBudget', { acquire: async () => ({ signal: new AbortController().signal, release, uncertain }) })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'uncertain-close', ctx),
    prompt: [], signal: new AbortController().signal }, limits)
  const env = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.env.DSH_SDK_PARENT_CONTROL!)))
  try {
    await client.post('/resource/register', { id: '1', kind: 'process' })
    expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'granted' })
    await expect(control.close()).rejects.toMatchObject({ errors: [failure] })
    expect(uncertain).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
  } finally { client.close(); await Promise.allSettled([control.close()]); await ctx.fiber.dispose() }
})

it.each(['parent', 'child'] as const)('retries an unacknowledged %s resource completion after recovery without another admission', async (side) => {
  const ctx = new Context(), child = new Context()
  let recovered = false, held = true
  const release = vi.fn(async () => { if (!recovered) throw new Error('Accountant temporarily unavailable.'); held = false })
  const acquire = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain: async () => {} }))
  ctx.provide('resourceBudget', { acquire })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'completion-retry', ctx), prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open(), client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  const budget = new ManagedSdkBudget(child, client, new AsyncLocalStorage())
  let lease: ResourceLease | undefined
  try {
    if (side === 'child') lease = await budget.acquire({ kind: 'process' })
    else {
      await client.post('/resource/register', { id: '1', kind: 'process' })
      expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'granted' })
    }
    const complete = () => lease === undefined ? client.post('/resource/finish', { id: '1', outcome: 'released' }) : lease.release()
    await expect(complete()).rejects.toBeInstanceOf(Error)
    expect(held).toBe(true)
    recovered = true
    await Promise.all([complete(), complete()])
    await complete()
    expect(held).toBe(false)
    expect(release).toHaveBeenCalledTimes(2)
    expect(acquire).toHaveBeenCalledOnce()
  } finally {
    recovered = true
    await Promise.allSettled([budget.close(), control.close()])
    client.close(); await child.fiber.dispose(); await ctx.fiber.dispose()
  }
})

it.each(['parent', 'child'] as const)('upgrades acknowledged %s uncertainty when later cleanup proves quiescence', async (side) => {
  const ctx = new Context(), child = new Context()
  let held = true
  const release = vi.fn(async () => { held = false }), uncertain = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain }))
  ctx.provide('resourceBudget', { acquire })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'completion-upgrade', ctx), prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open(), client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  const budget = new ManagedSdkBudget(child, client, new AsyncLocalStorage())
  let lease: ResourceLease | undefined
  try {
    if (side === 'child') lease = await budget.acquire({ kind: 'process' })
    else {
      await client.post('/resource/register', { id: '1', kind: 'process' })
      expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'granted' })
    }
    if (lease === undefined) await client.post('/resource/finish', { id: '1', outcome: 'uncertain' })
    else await lease.uncertain()
    expect(held).toBe(true); expect(uncertain).toHaveBeenCalledOnce()
    if (lease === undefined) await client.post('/resource/finish', { id: '1', outcome: 'released' })
    else await lease.release()
    expect(held).toBe(false); expect(release).toHaveBeenCalledOnce()
    expect(acquire).toHaveBeenCalledOnce()
  } finally {
    await budget.close(); await control.close(); client.close()
    await child.fiber.dispose(); await ctx.fiber.dispose()
  }
})

it('retains uncertain parent operations in capacity until their original cleanup is acknowledged', async () => {
  const ctx = new Context(), release = vi.fn(async () => {}), uncertain = vi.fn(async () => {})
  const acquire = vi.fn(async () => ({ signal: new AbortController().signal, release, uncertain }))
  ctx.provide('resourceBudget', { acquire })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'uncertain-capacity', ctx), prompt: [], signal: new AbortController().signal }, { ...limits, maxOperations: 1 })
  const { env } = await control.open(), client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  try {
    await client.post('/resource/register', { id: '1', kind: 'process' })
    expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'granted' })
    await client.post('/resource/finish', { id: '1', outcome: 'uncertain' })
    await expect(client.post('/resource/register', { id: '2', kind: 'process' })).rejects.toMatchObject({ reason: 'refused' })
    expect(acquire).toHaveBeenCalledOnce()
    await client.post('/resource/finish', { id: '1', outcome: 'released' })
    await client.post('/resource/register', { id: '2', kind: 'process' })
    expect(await client.post('/resource/status', { id: '2' })).toEqual({ state: 'granted' })
    await client.post('/resource/finish', { id: '2', outcome: 'released' })
    expect(acquire).toHaveBeenCalledTimes(2); expect(release).toHaveBeenCalledTimes(2)
    expect(uncertain).toHaveBeenCalledOnce()
  } finally { await control.close(); client.close(); await ctx.fiber.dispose() }
})

it('serializes child quiescence after an in-flight uncertainty acknowledgement and never downgrades it', async () => {
  const ctx = new Context(), child = new Context()
  const entered = Promise.withResolvers<undefined>(), proceed = Promise.withResolvers<undefined>()
  const outcomes: string[] = []
  ctx.provide('resourceBudget', { acquire: async () => ({ signal: new AbortController().signal,
    async release() { outcomes.push('released') },
    async uncertain() { outcomes.push('uncertain'); entered.resolve(undefined); await proceed.promise },
  }) })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'completion-order', ctx), prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open(), client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  const budget = new ManagedSdkBudget(child, client, new AsyncLocalStorage())
  let first: Promise<void> | undefined, second: Promise<void> | undefined
  try {
    const lease = await budget.acquire({ kind: 'process' })
    first = lease.uncertain(); await entered.promise
    second = lease.release(); proceed.resolve(undefined)
    await Promise.all([first, second])
    await lease.uncertain(); await lease.release()
    expect(outcomes).toEqual(['uncertain', 'released'])
  } finally {
    proceed.resolve(undefined); await Promise.allSettled([first, second])
    await budget.close(); await control.close(); client.close()
    await child.fiber.dispose(); await ctx.fiber.dispose()
  }
})

it.each(['released', 'uncertain'] as const)('retries parent shutdown after a failed %s report while preserving known quiescence', async (outcome) => {
  const ctx = new Context()
  let recovered = false
  const report = vi.fn(async () => { if (!recovered) throw new Error('Accountant temporarily unavailable.') })
  const release = outcome === 'released' ? report : vi.fn(async () => {}), uncertain = outcome === 'uncertain' ? report : vi.fn(async () => {})
  ctx.provide('resourceBudget', { acquire: async () => ({ signal: new AbortController().signal, release, uncertain }) })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'close-report-retry', ctx), prompt: [], signal: new AbortController().signal }, limits)
  const { env } = await control.open(), client = new ParentControlClient(controlConnection(JSON.parse(env.DSH_SDK_PARENT_CONTROL!)))
  try {
    await client.post('/resource/register', { id: '1', kind: 'process' })
    expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'granted' })
    if (outcome === 'released') await expect(client.post('/resource/finish', { id: '1', outcome })).rejects.toBeInstanceOf(Error)
    await expect(control.close()).rejects.toBeInstanceOf(AggregateError)
    const attempts = report.mock.calls.length
    recovered = true
    await Promise.all([control.close(), control.close()]); await control.close()
    expect(report).toHaveBeenCalledTimes(attempts + 1)
    expect(outcome === 'released' ? uncertain : release).not.toHaveBeenCalled()
  } finally { recovered = true; await control.close(); client.close(); await ctx.fiber.dispose() }
})

it('keeps the cleanup deadline bounded when wall time moves backwards', async () => {
  const client = new ParentControlClient({ ...connection, config: { ...limits, requestTimeoutMs: 100, cleanupTimeoutMs: 200 } })
  const outcomes: unknown[] = []
  vi.spyOn(client, 'post').mockImplementation(async (path, body) => {
    if (path === '/resource/finish') outcomes.push(body.outcome)
    return path === '/resource/status' ? { state: 'granted' } : {}
  })
  const ctx = new Context(), budget = new ManagedSdkBudget(ctx, client, new AsyncLocalStorage())
  const lease = await budget.acquire({ kind: 'process' }), actualNow = Date.now
  const clock = vi.spyOn(Date, 'now').mockImplementationOnce(actualNow).mockImplementation(() => actualNow() - 60_000)
  let timer: ReturnType<typeof setTimeout> | undefined
  const closing = budget.close()
  try {
    const completed = await Promise.race([closing.then(() => true), new Promise<boolean>((resolve) => {
      timer = setTimeout(() => { resolve(false) }, 1500)
    })])
    expect(completed).toBe(true)
    expect(outcomes).toEqual(['uncertain'])
  } finally {
    clock.mockRestore()
    clearTimeout(timer)
    await lease.release()
    await closing
    client.close()
    await ctx.fiber.dispose()
  }
})

it('bounds parent shutdown while an HTTP cleanup report waits for an uncooperative resource provider', async () => {
  const ctx = new Context(), grant = Promise.withResolvers<ResourceLease>()
  const release = vi.fn(async () => {})
  ctx.provide('resourceBudget', { acquire: () => grant.promise })
  const control = new SdkParentControl({ parent: parentAgent(process.cwd(), 'owned-close', ctx), prompt: [], signal: new AbortController().signal }, limits)
  const env = await control.open()
  const client = new ParentControlClient(controlConnection(JSON.parse(env.env.DSH_SDK_PARENT_CONTROL!)))
  let timer: ReturnType<typeof setTimeout> | undefined
  let finishing: Promise<unknown> | undefined
  try {
    await client.post('/resource/register', { id: '1', kind: 'process' })
    finishing = client.post('/resource/finish', { id: '1', outcome: 'released' }).then(() => undefined, (error: unknown) => error)
    await vi.waitFor(async () => { expect(await client.post('/resource/status', { id: '1' })).toEqual({ state: 'cancelled' }) })
    const watchdog = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('Test watchdog waited for parent shutdown.')) }, 5000) })
    await expect(Promise.race([control.close(), watchdog])).rejects.toThrow('SDK parent control cleanup did not settle.')
  } finally {
    clearTimeout(timer)
    grant.resolve({ signal: new AbortController().signal, release, uncertain: async () => { throw new Error('Unused grant is certain.') } })
    await finishing
    await Promise.allSettled([control.close()])
    client.close()
    await ctx.fiber.dispose()
  }
  expect(release).toHaveBeenCalledOnce()
}, 10_000)
