import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { attributionHeaders, ReasoningEffortId, type LlmCallConfig, type NativeModelStreamEvent, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { PiAiAdapter, type PiAiAuthInjection } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

async function fixture(auth: PiAiAuthInjection = memoryAuth()) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: unknown }[] = []
  const sockets = new Set<Socket>()
  const state = { response: [{ type: 'response.completed', response: {
    status: 'completed', usage: { input_tokens: 10, output_tokens: 5,
      input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 } },
  } }] as Record<string, unknown>[], suffix: 'data: [DONE]\n\n', hold: false, status: 200,
  contentType: 'text/event-stream' }
  const started = Promise.withResolvers<undefined>()
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request as AsyncIterable<Buffer>) parts.push(part)
      requests.push({ path: request.url!, headers: request.headers, body: JSON.parse(Buffer.concat(parts).toString()) })
      response.writeHead(state.status, { 'content-type': state.contentType })
      response.flushHeaders()
      started.resolve(undefined)
      if (state.hold) return
      for (const event of state.response) response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      response.end(state.suffix)
    })().catch(() => { response.destroy() })
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    const closed = new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
    for (const socket of sockets) socket.destroy()
    await closed
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let profiles = resolveProfiles({ native: { api: 'openai-responses', baseURL: `${baseURL}/first/v1`, apiKeyEnv: 'FIRST_KEY',
    models: [{ id: 'm', maxTokens: 64 }], headers: { 'x-owned-profile': 'first' } } })
  let key = 'first-key'
  const resolveApiKey = vi.fn(async (): Promise<string | { value: string; source: string } | undefined> => ({ value: key, source: 'file' }))
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['native'], new PiAiAdapter({ profiles: () => profiles, resolveApiKey, auth }))
  const observed: StreamChunk[] = []
  ctx.on('llm/delegated-stream', async function* (_options, next) {
    for await (const chunk of next()) { observed.push(chunk); yield chunk }
  })
  const events: NativeModelStreamEvent[] = []
  const prepare = (maxResponseBytes = 8192, config: LlmCallConfig = { provider: 'native', model: 'm', maxTokens: 12 }) => ctx.llm.prepareDelegatedOperation(config,
    'native-stream', { protocol: 'openai-responses', body: { model: 'child-m', input: [{ role: 'user', content: 'task' }], store: true },
      maxResponseBytes, write: (event) => { events.push(event); return Promise.resolve() } })
  return { ctx, requests, state, observed, events, prepare, started: started.promise, resolveApiKey, baseURL,
    setProfiles(next: Parameters<typeof resolveProfiles>[0]) { profiles = resolveProfiles(next) },
    replace() {
      key = 'fresh-key'
      profiles = resolveProfiles({ native: { api: 'openai-responses', baseURL: `${baseURL}/second/v1`, apiKeyEnv: 'SECOND_KEY',
        models: [{ id: 'm', maxTokens: 128 }] } })
    },
  }
}

it.each(['stream', 'prepared'] as const)('refuses an ordinary %s request when authorization changes during credential lookup', async (mode) => {
  const f = await fixture()
  let allowed = true
  f.ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'revoked' } })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.resolveApiKey.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    return 'owned-key'
  })
  const options = { provider: 'native', model: 'm', messages: [] }
  const call = mode === 'prepared' ? await f.ctx.llm.prepareCall(options) : undefined
  const stream = call === undefined ? f.ctx.llm.stream(options) : call.stream({ ...options, ...call.config })
  const result = (async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  })()
  await entered.promise
  allowed = false
  release.resolve(undefined)
  const chunks = await result
  expect(f.requests).toHaveLength(0)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_FORBIDDEN' } } })
})

it('rechecks ordinary authorization after pi-ai resolves its own stored credential', async () => {
  const auth = memoryAuth({ native: { type: 'api_key', key: 'stored-key' } })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  auth.credentials.read = async (id) => {
    entered.resolve(undefined)
    await release.promise
    return auth.stored.get(id)
  }
  const f = await fixture(auth)
  f.resolveApiKey.mockResolvedValue(undefined)
  let allowed = true
  f.ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'revoked' } })
  const result = (async () => {
    const chunks: StreamChunk[] = []
    for await (const chunk of f.ctx.llm.stream({ provider: 'native', model: 'm', messages: [] })) chunks.push(chunk)
    return chunks
  })()
  await entered.promise
  allowed = false
  release.resolve(undefined)
  const chunks = await result
  expect(f.requests).toHaveLength(0)
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_FORBIDDEN' } } })
})

it('retains the exact endpoint generation, resolves parent credentials after admission, and separates cached usage', async () => {
  const f = await fixture()
  const call = await f.prepare()
  expect(f.resolveApiKey).not.toHaveBeenCalled()
  f.replace()
  await call.run(call.config)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]).toMatchObject({ path: '/first/v1/responses', headers: {
    authorization: 'Bearer fresh-key', 'x-owned-profile': 'first', ...attributionHeaders(),
  }, body: call.request.body })
  expect(call.request.body).toMatchObject({ model: 'm', stream: true, store: false, max_output_tokens: 12 })
  expect(f.observed).toContainEqual({ type: 'usage', usage: { inputTokens: 7, outputTokens: 5,
    totalTokens: 15, cacheReadTokens: 3, reasoningTokens: 2 }, credentialSource: 'file' })
  expect(f.events).toEqual([{ event: 'response.completed', data: JSON.stringify(f.state.response[0]) }])
})

it('rechecks a changed model policy after a delivered queue permit before resolving any credential or HTTP', async () => {
  const f = await fixture()
  let allowed = true
  f.ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'revoked' } })
  const queued = Promise.withResolvers<undefined>()
  const deliver = Promise.withResolvers<undefined>()
  const release = vi.fn(async () => {})
  f.ctx.provide('resourceBudget', { acquire: async () => {
    queued.resolve(undefined); await deliver.promise
    return { signal: new AbortController().signal, release, uncertain: vi.fn(async () => {}) }
  } })
  const call = await f.prepare()
  const run = call.run(call.config)
  const outcome = expect(run).rejects.toMatchObject({ code: 'MODEL_FORBIDDEN' })
  await queued.promise
  allowed = false
  deliver.resolve(undefined)
  await outcome
  expect(f.requests).toHaveLength(0)
  expect(f.resolveApiKey).not.toHaveBeenCalled()
  expect(release).toHaveBeenCalledOnce()
})

it('retains actual usage reported before a native failed response', async () => {
  const f = await fixture()
  f.state.response[0]!.type = 'response.failed'
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: 'SERVER' })
  expect(f.observed.some(chunk => chunk.type === 'usage' && chunk.usage.totalTokens === 15)).toBe(true)
})

it('rechecks parent authorization after asynchronous credential resolution before HTTP', async () => {
  const f = await fixture()
  let allowed = true
  f.ctx.provide('modelAccess', { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'revoked' } })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.resolveApiKey.mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    return { value: 'parent-key', source: 'file' }
  })
  const call = await f.prepare()
  const run = call.run(call.config).then(() => 'dispatched', (error: unknown) => (error as { code: string }).code)
  await entered.promise
  allowed = false
  release.resolve(undefined)
  expect(await run).toBe('MODEL_FORBIDDEN')
  expect(f.requests).toHaveLength(0)
})

it.each(['truncated', 'oversized', 'invalid-json', 'invalid-usage'] as const)('contains %s native streams without invented usage', async (mode) => {
  const f = await fixture()
  if (mode === 'invalid-usage') {
    f.state.response = [{ type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2,
      input_tokens_details: { cached_tokens: 3 } } } }]
  } else {
    f.state.response = []
    f.state.suffix = mode === 'oversized' ? 'data: '+ 'x'.repeat(9000) : mode === 'invalid-json' ? 'data: invalid\n\n' : 'data: {'
  }
  const call = await f.prepare()
  if (mode === 'invalid-usage') await call.run(call.config)
  else await expect(call.run(call.config)).rejects.toMatchObject({ code: mode === 'truncated' ? 'STREAM_TRUNCATED'
    : mode === 'oversized' ? 'RESPONSE_TOO_LARGE' : 'MALFORMED_RESPONSE' })
  expect(f.observed.some(chunk => chunk.type === 'usage')).toBe(false)
})

it('cancels a held native response and releases its provider transport', async () => {
  const f = await fixture()
  f.state.hold = true
  const call = await f.prepare()
  const controller = new AbortController()
  const run = call.run({ ...call.config, signal: controller.signal })
  const outcome = expect(run).rejects.toMatchObject({ code: 'ABORTED' })
  await f.started
  controller.abort()
  await outcome
})

it('refuses a mismatched native protocol during preparation without credentials or HTTP', async () => {
  const f = await fixture()
  await expect(f.ctx.llm.prepareDelegatedOperation({ provider: 'native', model: 'm' }, 'native-stream', {
    protocol: 'anthropic-messages', body: {}, maxResponseBytes: 8192, write: () => Promise.resolve(),
  })).rejects.toMatchObject({ code: 'MODEL_OPERATION_UNSUPPORTED' })
  expect(f.resolveApiKey).not.toHaveBeenCalled()
  expect(f.requests).toHaveLength(0)
})

it.each([401, 403, 429, 500])('contains upstream HTTP %s without delivering provider content', async (status) => {
  const f = await fixture()
  f.state.status = status
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: status === 401 || status === 403 ? 'AUTH'
    : status === 429 ? 'RATE_LIMIT' : 'SERVER' })
  expect(f.events).toHaveLength(0)
})

it.each(['application/json', 'bodyless'])('refuses %s Responses replies', async (type) => {
  const f = await fixture()
  if (type === 'bodyless') { f.state.status = 204; f.state.response = []; f.state.suffix = '' }
  else f.state.contentType = type
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
})

it.each([
  { input_tokens: 10, output_tokens: 5 },
  { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 8 } },
  { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: false } },
])('keeps absent usage details absent and rejects inconsistent detail counters %j', async (usage) => {
  const f = await fixture()
  f.state.response = [{ type: 'response.completed', response: { usage } }]
  const call = await f.prepare()
  await call.run(call.config)
  const actual = f.observed.filter(chunk => chunk.type === 'usage')
  if ('output_tokens_details' in usage) expect(actual).toHaveLength(0)
  else expect(actual).toEqual([{ type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, credentialSource: 'file' }])
})

it.each(['invalid-type', 'mismatched-event', 'invalid-framing', 'provider-error'])('contains %s native events', async (mode) => {
  const f = await fixture()
  f.state.response = []
  f.state.suffix = mode === 'invalid-type' ? 'data: {"type":"invalid\\nheader"}\n\n'
    : mode === 'mismatched-event' ? 'event: other\ndata: {"type":"response.created"}\n\n'
      : mode === 'invalid-framing' ? 'retry: invalid\n\n' : 'data: {"type":"error","message":"private diagnostic"}\n\n'
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: mode === 'provider-error' ? 'SERVER' : 'MALFORMED_RESPONSE' })
  expect(f.events).toHaveLength(0)
})

for (const trailerKind of ['event', 'framing', 'oversized'] as const) {
  it.each([true, false])(`preserves a terminal response independently of trailing-frame chunking: trailer=${trailerKind}, batched=%s`, async (batched) => {
    const f = await fixture()
    const terminal = 'data: {"type":"response.completed"}\n\n'
    const trailer = trailerKind === 'event' ? 'data: {"type":"response.created"}\n\n'
      : trailerKind === 'framing' ? 'retry: invalid\n\n' : 'data: ' + 'x'.repeat(9000)
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(batched ? terminal + trailer : terminal))
      if (!batched) controller.enqueue(encoder.encode(trailer))
      controller.close()
    } })
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    onTestFinished(() => { fetch.mockRestore() })
    const call = await f.prepare(trailerKind === 'oversized' ? encoder.encode(terminal).byteLength : 8192)
    await expect(call.run(call.config)).resolves.toBeUndefined()
    expect(f.events).toEqual([{ event: 'response.completed', data: '{"type":"response.completed"}' }])
  })
}

it('retains a framing failure that precedes the terminal event in the same network chunk', async () => {
  const f = await fixture()
  const response = new Response('retry: invalid\n\ndata: {"type":"response.completed"}\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
  onTestFinished(() => { fetch.mockRestore() })
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  expect(f.events).toHaveLength(0)
})

it.each([undefined, 'plain-parent-key'])('supports explicit protocol routes with credential source %s', async (credential) => {
  const f = await fixture()
  f.setProfiles({ native: { api: 'openai-responses', baseURL: `${f.baseURL}/v1`, models: [{ id: 'm' }] } })
  f.resolveApiKey.mockResolvedValueOnce(credential)
  const call = await f.prepare()
  await call.run(call.config)
  expect(f.requests[0]?.headers.authorization).toBe(credential === undefined ? undefined : `Bearer ${credential}`)
  expect(f.observed.find(chunk => chunk.type === 'usage')).not.toHaveProperty('credentialSource')
})

it('sends configured temperature and reasoning while preserving absent output overrides', async () => {
  const f = await fixture()
  f.setProfiles({ native: { api: 'openai-responses', baseURL: `${f.baseURL}/v1`, models: [{ id: 'm',
    reasoningEfforts: { high: 'high' } }] } })
  const call = await f.prepare(8192, { provider: 'native', model: 'm', temperature: 0.25, reasoningEffort: ReasoningEffortId('high') })
  await call.run(call.config)
  expect(call.request.body).toMatchObject({ model: 'm', temperature: 0.25, reasoning: { effort: 'high' } })
  expect(f.requests[0]?.body).toEqual(call.request.body)
})

it.each(['openai', 'openai-codex'])('does not project catalog-only %s authentication onto a native route', async (provider) => {
  const f = await fixture()
  const profiles = resolveProfiles({ [provider]: {} })
  f.setProfiles({ [provider]: {} })
  const model = profiles.get(provider)?.piProvider?.getModels()[0]
  if (model === undefined) throw new Error('The installed catalog must expose a model for its declared provider.')
  f.ctx.llm.registerAdapter([provider], new PiAiAdapter({ profiles: () => profiles,
    resolveApiKey: f.resolveApiKey, auth: memoryAuth() }))
  await expect(f.ctx.llm.prepareDelegatedOperation({ provider, model: model.id }, 'native-stream', {
    protocol: 'openai-responses', body: {}, maxResponseBytes: 8192, write: () => Promise.resolve(),
  })).rejects.toMatchObject({ code: provider === 'openai' ? 'MODEL_OPERATION_AUTH_UNSUPPORTED' : 'MODEL_OPERATION_UNSUPPORTED' })
  expect(f.requests).toHaveLength(0)
})

it('preserves an independent native response cleanup failure', async () => {
  const f = await fixture()
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed"}\n\n'))
  }, cancel() { throw new Error('Owned body cleanup failed.') } })
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  onTestFinished(() => { fetch.mockRestore() })
  const call = await f.prepare()
  await expect(call.run(call.config)).rejects.toThrow('Owned body cleanup failed.')
})
