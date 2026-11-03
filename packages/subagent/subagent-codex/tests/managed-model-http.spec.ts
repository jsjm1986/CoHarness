/** Real private HTTP validation, independent policy owners and transport teardown. */
import { Context } from '@deepseek-ai/cordis'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import { Server, ServerResponse, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import LlmRuntime, { LlmAdapter, LlmError, type LlmOperationFactories, type NativeModelStreamParameters,
  type PreparedAdapterCall, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { expect, it, onTestFinished, vi } from 'vitest'
import { parentAgent } from './agent-fixture.ts'
import { startManagedCodexModel, type ManagedCodexModelSpec } from '../src/managed-model.ts'

const spec: ManagedCodexModelSpec = { provider: 'parent-route', model: 'm', maxRequestBytes: 4096,
  maxResponseBytes: 65536, requestTimeoutMs: 5000, maxPendingRequests: 8 }

class NativeAdapter extends LlmAdapter {
  readonly requests: NativeModelStreamParameters[] = []
  failure: string | undefined
  text = JSON.stringify({ type: 'response.completed' })
  beforeWrite: (() => Promise<void>) | undefined
  beforePrepare: (() => void | Promise<void>) | undefined
  supportsNative = true

  override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
    await this.beforePrepare?.()
    const operations: LlmOperationFactories = { 'native-stream': parameters => ({
      request: { protocol: parameters.protocol, body: parameters.body },
      run: (options, observer) => observer.dispatch(async () => {
        this.requests.push(parameters)
        if (this.failure !== undefined) throw new LlmError('Provider diagnostic must remain private.', this.failure)
        await this.beforeWrite?.()
        options.signal?.throwIfAborted()
        await parameters.write({ event: 'response.completed', data: this.text })
      }),
    }) }
    return Promise.resolve({ model: { provider, id: model, name: model }, stream: () => this.stream(),
      ...this.supportsNative ? { operations } : {} })
  }

  stream(): AsyncIterable<StreamChunk> { throw new Error('Native requests cannot dispatch conversation inference.') }
}

async function fixture(overrides: Partial<ManagedCodexModelSpec> = {}, expectedCleanupFailure?: () => unknown) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new NativeAdapter()
  ctx.llm.registerAdapter(['parent-route'], adapter)
  const parent = parentAgent(undefined, 'native-http-owner', ctx)
  const controller = new AbortController()
  const owner = await startManagedCodexModel(ctx, parent, { ...spec, ...overrides }, controller.signal)
  onTestFinished(async () => {
    try { await owner.close() } catch (error) { if (error !== expectedCleanupFailure?.()) throw error }
  })
  const prefix = 'model_providers.dsh_parent.base_url='
  const setting = owner.config.find(value => value.startsWith(prefix))
  if (setting === undefined) throw new Error('The owner must publish its native provider URL.')
  const baseURL = JSON.parse(setting.slice(prefix.length)) as string
  const token = owner.env.DSH_CODEX_MODEL_TOKEN
  if (token === undefined) throw new Error('The owner must publish its private native credential.')
  const post = (body = JSON.stringify({ model: 'm', stream: true, input: [] }), options: RequestInit = {}) =>
    fetch(`${baseURL}/responses`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body, ...options })
  return { ctx, parent, adapter, owner, post, baseURL, controller, token }
}

it('delivers complete multiline SSE data and joins idempotent shutdown', async () => {
  const f = await fixture()
  f.adapter.text = '{\n"type":"response.completed"\n}'
  f.adapter.beforeWrite = async () => {
    const call = f.adapter.requests[0]
    if (call === undefined) throw new Error('The native call must exist before response streaming.')
    await call.write({ event: 'response.created', data: '{"type":"response.created"}' })
  }
  const response = await f.post()
  expect(response.status).toBe(200)
  expect(await response.text()).toBe('event: response.created\ndata: {"type":"response.created"}\n\n'
    + 'event: response.completed\ndata: {\ndata: "type":"response.completed"\ndata: }\n\n')
  expect(f.parent.session.snapshotEvents().filter(event => event.type === 'subagent/codex-model-request')).toHaveLength(1)
  await Promise.all([f.owner.close(), f.owner.close()])
  await expect(f.post()).rejects.toThrow()
})

it.each(['missing', 'wrong-length', 'wrong-value', 'method', 'path'] as const)('refuses %s before reading native input', async (mode) => {
  const f = await fixture()
  let response: Response
  if (mode === 'path') response = await fetch(`${f.baseURL}/other`, { method: 'POST' })
  else response = await f.post('not JSON', mode === 'method' ? { method: 'PUT' }
    : { headers: mode === 'missing' ? {} : { authorization: mode === 'wrong-length' ? 'x'
      : `Bearer ${'x'.repeat(f.token.length)}` } })
  expect(response.status).toBe(403)
  await response.text()
  expect(f.adapter.requests).toHaveLength(0)
  expect(f.parent.session.snapshotEvents()).toHaveLength(0)
})

it.each(['null', '[]', '42', '"text"', '{', '{"model":"other","stream":true}', '{"model":"m","stream":false}'])(
  'refuses malformed or substituted native input %s', async (body) => {
    const f = await fixture()
    const response = await f.post(body)
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain('Provider diagnostic')
    expect(f.adapter.requests).toHaveLength(0)
  })

it('refuses an oversized child request with an HTTP status and no adapter request', async () => {
  const f = await fixture({ maxRequestBytes: 16 })
  const response = await f.post(JSON.stringify({ model: 'm', stream: true, input: 'x'.repeat(5000) }))
  expect(response.status).toBe(413)
  await response.text()
  expect(f.adapter.requests).toHaveLength(0)
})

it.each([
  ['stalled', 20, 4096, '', 504, 'TIMEOUT'],
  ['oversized', 5000, 64, 'x'.repeat(65), 413, 'REQUEST_TOO_LARGE'],
] as const)('refuses an incomplete authenticated %s body and admits a subsequent request', async (
  _kind, requestTimeoutMs, maxRequestBytes, partial, status, code,
) => {
  const f = await fixture({ requestTimeoutMs, maxRequestBytes, maxPendingRequests: 1 })
  const continued = Promise.withResolvers<undefined>()
  const received = Promise.withResolvers<{ status: number | undefined; text: string }>()
  const outgoing = httpRequest(`${f.baseURL}/responses`, { method: 'POST', headers: {
    authorization: `Bearer ${f.token}`, 'content-length': '1000', expect: '100-continue', connection: 'close',
  } }, (response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of response as AsyncIterable<Buffer>) parts.push(part)
      return { status: response.statusCode, text: Buffer.concat(parts).toString('utf8') }
    })().then(received.resolve, received.reject)
  })
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
    expect(result?.status).toBe(status)
    expect(JSON.parse(result?.text ?? '{}')).toMatchObject({ error: { code } })
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.parent.session.snapshotEvents()).toHaveLength(0)
    await vi.waitFor(async () => {
      const response = await f.post()
      expect(response.status).toBe(200)
      await response.text()
    })
    expect(f.adapter.requests).toHaveLength(1)
  } finally { clearTimeout(watchdog); outgoing.destroy() }
})

it.each([
  ['MODEL_FORBIDDEN', 403], ['MODEL_POLICY_UNAVAILABLE', 503], ['INVALID_REQUEST', 400],
  ['REQUEST_TOO_LARGE', 413], ['RATE_LIMIT', 429], ['TIMEOUT', 504], ['SERVER', 502],
] as const)('reports %s safely with status %s', async (code, status) => {
  const f = await fixture()
  f.adapter.failure = code
  const response = await f.post()
  expect(response.status).toBe(status)
  expect(await response.json()).toEqual({ error: { message: 'Parent model admission or execution failed.', type: 'parent_model_error', code } })
})

it('joins an authenticated pending upload when its model owner closes', async () => {
  const f = await fixture(), accepted = Promise.withResolvers<undefined>()
  const socket = connect(Number(new URL(f.baseURL).port), '127.0.0.1')
  const closed = new Promise<void>((resolve) => { socket.once('close', () => { resolve() }) })
  let text = ''
  socket.on('data', (part: Buffer) => { text += part.toString('utf8'); if (text.includes('100 Continue')) accepted.resolve(undefined) })
  socket.once('error', accepted.reject)
  try {
    socket.write('POST /v1/responses HTTP/1.1\r\nHost: localhost\r\n'
      + `Authorization: Bearer ${f.token}\r\nContent-Length: 1000\r\nExpect: 100-continue\r\n\r\n`)
    await accepted.promise
    await f.owner.close()
    await closed
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.parent.session.snapshotEvents()).toHaveLength(0)
  } finally { socket.destroy(); await closed }
})

it('contains a diagnostic sink failure and closes the failed response', async () => {
  const f = await fixture()
  f.adapter.failure = 'SERVER'
  vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => { throw new Error('Diagnostic sink unavailable.') })
  await expect(f.post()).rejects.toThrow()
  await f.owner.close()
})

it('propagates client cancellation after response headers without admitting another request', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  f.adapter.beforeWrite = async () => { entered.resolve(undefined); await release.promise }
  const controller = new AbortController()
  const pending = f.post(undefined, { signal: controller.signal })
  const outcome = expect(pending).rejects.toThrow()
  await entered.promise
  controller.abort()
  release.resolve(undefined)
  await outcome
  await f.owner.close()
  expect(f.adapter.requests).toHaveLength(1)
})

it('respects writer backpressure for a large native event', async () => {
  const f = await fixture()
  f.adapter.text = 'x'.repeat(2 * 1024 * 1024)
  const response = await f.post()
  expect((await response.text()).length).toBeGreaterThan(f.adapter.text.length)
  await f.owner.close()
})

it.each([true, false])('joins a backpressured writer when its connection closes synchronously=%s', async (synchronous) => {
  const f = await fixture()
  f.adapter.text = 'x'.repeat(2 * 1024 * 1024)
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies the response instance.
  const original = ServerResponse.prototype.write
  const write = vi.spyOn(ServerResponse.prototype, 'write')
  onTestFinished(() => { write.mockRestore() })
  write.mockImplementation(function (this: ServerResponse, ...args: Parameters<typeof original>) {
    write.mockRestore()
    const accepted = Reflect.apply(original, this, args)
    expect(accepted).toBe(false)
    if (synchronous) this.destroy()
    else setImmediate(() => { this.destroy() })
    return accepted
  })
  await expect(f.post().then(response => response.text())).rejects.toThrow()
  await f.owner.close()
  expect(f.adapter.requests).toHaveLength(1)
})

it('bounds pipelined requests on one native connection before allocating another model request', async () => {
  const f = await fixture({ maxPendingRequests: 1 })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  f.adapter.beforeWrite = async () => { entered.resolve(undefined); await release.promise }
  const socket = connect({ host: '127.0.0.1', port: Number(new URL(f.baseURL).port) })
  onTestFinished(() => { socket.destroy() })
  const result = new Promise<string>((resolve, reject) => {
    const parts: Buffer[] = []
    socket.on('data', (part) => { parts.push(part) })
    socket.once('error', reject)
    socket.once('end', () => { resolve(Buffer.concat(parts).toString()) })
  })
  const body = JSON.stringify({ model: 'm', stream: true, input: [] })
  const request = (connection: string) => 'POST /v1/responses HTTP/1.1\r\nHost: localhost\r\n'
    + `Authorization: Bearer ${f.token}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: ${connection}\r\n\r\n${body}`
  socket.write(request('keep-alive') + request('close'))
  await entered.promise
  release.resolve(undefined)
  const response = await result
  expect(response.match(/HTTP\/1\.1 \d+/gu)).toEqual(['HTTP/1.1 200', 'HTTP/1.1 429'])
  expect(f.adapter.requests).toHaveLength(1)
})

it('leaves unrelated parent model authorization and delegated operations independent', async () => {
  const f = await fixture()
  await f.ctx.serial(f.ctx.llm, 'llm/authorize', { provider: 'parent-route', model: 'm', messages: [] })
  const call = await f.ctx.llm.prepareDelegatedOperation({ provider: 'parent-route', model: 'm' }, 'native-stream', {
    protocol: 'openai-responses', body: {}, maxResponseBytes: 4096, write: () => Promise.resolve(),
  })
  await call.run(call.config)
  expect(f.adapter.requests).toHaveLength(1)
  expect(f.parent.session.snapshotEvents()).toHaveLength(0)
})

it('refuses an unsupported native operation with an actionable provider capability error', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new NativeAdapter()
  adapter.supportsNative = false
  ctx.llm.registerAdapter(['parent-route'], adapter)
  await expect(startManagedCodexModel(ctx, parentAgent(undefined, 'no-native-operation', ctx), spec, new AbortController().signal))
    .rejects.toThrow('Responses protocol')
})

it('honors cancellation delivered during native capability preparation before opening a listener', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new NativeAdapter()
  const controller = new AbortController()
  adapter.beforePrepare = () => { controller.abort() }
  ctx.llm.registerAdapter(['parent-route'], adapter)
  await expect(startManagedCodexModel(ctx, parentAgent(undefined, 'cancel-native-preflight', ctx), spec, controller.signal))
    .rejects.toMatchObject({ name: 'AbortError' })
  expect(adapter.requests).toHaveLength(0)
})

it.each(['parent', 'registration', 'replaced'] as const)('rechecks %s policy after held native capability preparation', async (owner) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new NativeAdapter()
  ctx.llm.registerAdapter(['parent-route'], adapter)
  const parent = ctx.isolate('modelAccess')
  let allowed = true
  const policy = { decide: () => allowed ? { allowed: true as const } : { allowed: false as const, reason: 'Revoked during model preparation.' } }
  const policyCtx = owner === 'parent' ? parent : ctx
  const withdraw = policyCtx.provide('modelAccess', policy)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  adapter.beforePrepare = async () => { entered.resolve(undefined); await release.promise }
  const starting = startManagedCodexModel(ctx, parentAgent(undefined, 'held-native-preflight', parent), spec, new AbortController().signal)
    .then(async (value) => { await value.close(); return 'listener-opened' }, (error: unknown) => error instanceof LlmError ? error.code : 'OTHER')
  await entered.promise
  if (owner === 'replaced') { withdraw(); policyCtx.provide('modelAccess', { ...policy }) }
  else allowed = false
  release.resolve(undefined)
  expect(await starting).toBe(owner === 'replaced' ? 'MODEL_POLICY_UNAVAILABLE' : 'MODEL_FORBIDDEN')
  expect(adapter.requests).toHaveLength(0)
})

it('releases native authorization ownership when the operating system refuses its listener', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['parent-route'], new NativeAdapter())
  const listen = vi.spyOn(Server.prototype, 'listen').mockImplementationOnce(function (this: Server) {
    queueMicrotask(() => { this.emit('error', new Error('Private listener unavailable.')) })
    return this
  })
  try {
    await expect(startManagedCodexModel(ctx, parentAgent(undefined, 'listener-failure', ctx), spec, new AbortController().signal))
      .rejects.toThrow('Private listener unavailable.')
  } finally { listen.mockRestore() }
})

it('refuses a missing parent model service before opening a listener', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await expect(startManagedCodexModel(ctx, parentAgent(undefined, 'missing-llm', ctx), spec, new AbortController().signal))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
})

it.each(['absent', 'different'] as const)('refuses an isolated %s resource owner', async (mode) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const budget = { acquire: async () => ({ signal: new AbortController().signal, release: async () => {}, uncertain: async () => {} }) }
  ctx.provide('resourceBudget', budget)
  const isolated = ctx.isolate('resourceBudget')
  if (mode === 'different') isolated.provide('resourceBudget', { ...budget })
  await expect(startManagedCodexModel(ctx, parentAgent(undefined, 'isolated-budget', isolated), spec, new AbortController().signal))
    .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
})

it.each(['before-request', 'queued', 'withdrawn', 'registration'] as const)('refuses a parent resource owner replaced %s', async (mode) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new NativeAdapter()
  ctx.llm.registerAdapter(['parent-route'], adapter)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const permit = { signal: new AbortController().signal, release: vi.fn(async () => {}), uncertain: vi.fn(async () => {}) }
  const budget = { acquire: async () => { entered.resolve(undefined); await release.promise; return permit } }
  const withdrawRegistered = ctx.provide('resourceBudget', budget)
  const parent = ctx.isolate('resourceBudget')
  const withdraw = parent.provide('resourceBudget', budget)
  const substitute = { acquire: vi.fn(async () => permit) }
  const owner = await startManagedCodexModel(ctx, parentAgent(undefined, 'changed-native-resource-owner', parent), spec,
    new AbortController().signal)
  onTestFinished(() => owner.close())
  const setting = owner.config.find(value => value.startsWith('model_providers.dsh_parent.base_url='))
  if (setting === undefined) throw new Error('The native provider must publish its private URL.')
  const url = JSON.parse(setting.slice(setting.indexOf('=') + 1)) as string
  if (mode === 'registration') { withdrawRegistered(); ctx.provide('resourceBudget', substitute) }
  else if (mode !== 'queued') {
    withdraw()
    if (mode === 'withdrawn') parent.provide('resourceBudgetRequired', true)
    else parent.provide('resourceBudget', substitute)
  }
  const pending = fetch(`${url}/responses`, { method: 'POST', headers: { authorization: `Bearer ${owner.env.DSH_CODEX_MODEL_TOKEN}` },
    body: JSON.stringify({ model: 'm', stream: true, input: [] }) })
  if (mode === 'queued') { await entered.promise; withdraw(); parent.provide('resourceBudget', substitute) }
  release.resolve(undefined)
  const response = await pending
  expect(response.status).toBe(503)
  await response.text()
  expect(adapter.requests).toHaveLength(0)
  expect(substitute.acquire).not.toHaveBeenCalled()
  if (mode === 'queued') expect(permit.release).toHaveBeenCalledOnce()
})

it('retains an unknown model configuration error without opening a native transport', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await expect(startManagedCodexModel(ctx, parentAgent(undefined, 'unknown-route', ctx), spec, new AbortController().signal))
    .rejects.toMatchObject({ code: 'NO_ADAPTER' })
})

it('publishes the remote port while retaining the exact local model listener for forwarding cleanup', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  const adapter = new NativeAdapter()
  ctx.llm.registerAdapter(['parent-route'], adapter)
  let localPort: number | undefined
  const closed = vi.fn(async () => {})
  const owner = await startManagedCodexModel(ctx, parentAgent(undefined, 'remote-http-owner', ctx), spec,
    new AbortController().signal, async (port, beforeClose) => {
      localPort = port
      let closing: Promise<void> | undefined
      return { port: 32109, close: () => closing ??= beforeClose().then(closed) }
    })
  onTestFinished(() => owner.close())
  expect(owner.config).toContain('model_providers.dsh_parent.base_url="http://127.0.0.1:32109/v1"')
  const response = await fetch(`http://127.0.0.1:${localPort}/v1/responses`, { method: 'POST',
    headers: { authorization: `Bearer ${owner.env.DSH_CODEX_MODEL_TOKEN}` },
    body: JSON.stringify({ model: 'm', stream: true, input: [] }) })
  expect(response.status).toBe(200)
  await response.text()
  await Promise.all([owner.close(), owner.close()])
  expect(closed).toHaveBeenCalledOnce()
  await expect(fetch(`http://127.0.0.1:${localPort}`)).rejects.toThrow()
})

it.each(['allocation', 'cancelled-publication'] as const)('closes its local listener after remote forwarding %s failure', async (mode) => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['parent-route'], new NativeAdapter())
  const controller = new AbortController()
  let localPort: number | undefined
  const remoteClose = vi.fn(async () => {})
  const starting = startManagedCodexModel(ctx, parentAgent(undefined, 'remote-startup-owner', ctx), spec,
    controller.signal, async (port, beforeClose) => {
      localPort = port
      if (mode === 'allocation') throw new Error('remote forwarding refused')
      controller.abort(new Error('remote forwarding cancelled'))
      return { port: 32109, close: async () => { await beforeClose(); await remoteClose() } }
    })
  await expect(starting).rejects.toThrow(mode === 'allocation' ? 'refused' : 'cancelled')
  expect(remoteClose).toHaveBeenCalledTimes(mode === 'allocation' ? 0 : 1)
  await expect(fetch(`http://127.0.0.1:${localPort}`)).rejects.toThrow()
})

it.each([1, 2])('joins and preserves %s rejected native request cleanup outcomes', async (count) => {
  let retained: unknown
  const f = await fixture({}, () => retained)
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  let arrived = 0
  f.adapter.beforeWrite = async () => { if (++arrived === count) entered.resolve(undefined); await release.promise }
  const failure = new Error('Diagnostic sink unavailable during request cleanup')
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => { throw failure })
  const pending = Array.from({ length: count }, () => f.post().then(() => 'unexpected response', () => 'disconnected'))
  try {
    await entered.promise
    const closing = f.owner.close()
    release.resolve(undefined)
    retained = await closing.then(() => undefined, (error: unknown) => error)
    if (count === 1) expect(retained).toBe(failure)
    else expect(retained).toMatchObject({ errors: [failure, failure] })
    expect(await Promise.all(pending)).toEqual(Array.from({ length: count }, () => 'disconnected'))
  } finally { warn.mockRestore() }
})

it('preserves forwarding allocation and local listener cleanup failures independently', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['parent-route'], new NativeAdapter())
  const startup = new Error('Remote forwarding allocation failed'), cleanup = new Error('Listener close observation failed')
  // oxlint-disable-next-line typescript/unbound-method -- The native close method is applied to the same server below.
  const originalClose = Server.prototype.close
  const close = vi.spyOn(Server.prototype, 'close').mockImplementationOnce(function (this: Server, callback) {
    return originalClose.call(this, () => { callback?.(cleanup) })
  })
  let port: number | undefined
  try {
    await expect(startManagedCodexModel(ctx, parentAgent(undefined, 'remote-cleanup-failure', ctx), spec,
      new AbortController().signal, async (value) => { port = value; throw startup }))
      .rejects.toMatchObject({ errors: [startup, cleanup] })
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow()
  } finally { close.mockRestore() }
})

it('refuses native HTTP dispatch when its real Session durability listener fails', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(Sessions)
  const adapter = new NativeAdapter()
  ctx.llm.registerAdapter(['parent-route'], adapter)
  const id = SessionId('native-durable-owner')
  const parent = { ...parentAgent(undefined, id, ctx), session: ctx.sessions.create(id) }
  const failure = new Error('Session durability refused')
  ctx.on('session/flush', async (session) => { expect(session).toBe(parent.session); throw failure })
  const owner = await startManagedCodexModel(ctx, parent, spec, new AbortController().signal)
  onTestFinished(() => owner.close())
  const setting = owner.config.find(value => value.startsWith('model_providers.dsh_parent.base_url='))!
  const response = await fetch(`${JSON.parse(setting.slice(setting.indexOf('=') + 1))}/responses`, {
    method: 'POST', headers: { authorization: `Bearer ${owner.env.DSH_CODEX_MODEL_TOKEN}` },
    body: JSON.stringify({ model: 'm', stream: true, input: [] }),
  })
  expect(response.status).toBe(502)
  expect(adapter.requests).toHaveLength(0)
  expect(await response.json()).toEqual({ error: { message: 'Parent model admission or execution failed.', type: 'parent_model_error', code: 'SERVER' } })
})
