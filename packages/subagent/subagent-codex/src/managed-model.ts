/** Run-owned loopback Responses entry point for parent-governed Codex inference. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { on } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket, AddressInfo } from 'node:net'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { authorizeModelPolicy, captureModelPolicy, LlmError, type NativeModelStreamRequest } from '@deepseek-ai/dsh-llm'
import { SubagentError, type ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type ResourceBudget from '@deepseek-ai/dsh-resource-budget'
import type { SshConnection, SshLoopbackForward } from '@deepseek-ai/dsh-ssh'
import { resourceBudgetOf } from '@deepseek-ai/dsh-resource-budget'

type Parent = ResolvedSubagentStartRequest['parent']

/** Validated parent model route and transport limits for one external run. */
export interface ManagedCodexModelSpec {
  readonly provider: string
  readonly model: string
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly requestTimeoutMs: number
  readonly maxPendingRequests: number
}

/** Run-owned configuration and cleanup; carries no upstream credential. */
export interface ManagedCodexModel {
  /** Exact model bound to the parent's prepared route. */
  readonly model: string
  readonly config: readonly string[]
  readonly env: Readonly<Record<string, string>>
  /**
   * Abort admitted work and join the native listener and all its connections.
   * @returns after owned requests, native connections and authorization listeners are released.
   */
  close(): Promise<void>
}

function equalCredential(value: string | undefined, expected: string): boolean {
  if (value === undefined) return false
  const actual = Buffer.from(value)
  const wanted = Buffer.from(expected)
  return actual.byteLength === wanted.byteLength && timingSafeEqual(actual, wanted)
}

function failureStatus(code: string): number {
  switch (code) {
    case 'MODEL_FORBIDDEN': return 403
    case 'MODEL_POLICY_UNAVAILABLE': return 503
    case 'RESOURCE_BUDGET_UNAVAILABLE': return 503
    case 'INVALID_REQUEST': return 400
    case 'REQUEST_TOO_LARGE': return 413
    case 'RATE_LIMIT': return 429
    case 'TIMEOUT': return 504
    default: return 502
  }
}

/** Collect bounded body chunks; cancellation preserves the connection for its error response. */
async function requestBody(request: IncomingMessage, maximum: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  let bytes = 0
  const parts: Buffer[] = []
  try {
    for await (const [part] of on(request, 'data', {
      signal, close: ['end'], highWaterMark: 1, lowWaterMark: 1,
    }) as AsyncIterable<[Buffer]>) {
      bytes += part.byteLength
      if (bytes > maximum) throw new LlmError('Child model request exceeds its byte limit.', 'REQUEST_TOO_LARGE')
      parts.push(part)
    }
  } catch (error) { signal.throwIfAborted(); throw error }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(parts).toString('utf8')) }
  catch (cause) { throw new LlmError('Child model request must be valid JSON.', 'INVALID_REQUEST', { cause }) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LlmError('Child model request must be a JSON object.', 'INVALID_REQUEST')
  }
  return value as Record<string, unknown>
}

async function writeEvent(response: ServerResponse, event: string, data: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (response.write(`event: ${event}\n${data.split(/\r\n|\r|\n/u).map(line => `data: ${line}`).join('\n')}\n\n`)) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off('drain', drained)
      response.off('close', closed)
      signal.removeEventListener('abort', closed)
    }
    const drained = (): void => { cleanup(); resolve() }
    const closed = (): void => { cleanup(); reject(new LlmError('Child model connection closed.', 'ABORTED')) }
    response.once('drain', drained)
    response.once('close', closed)
    signal.addEventListener('abort', closed, { once: true })
    if (signal.aborted || response.destroyed) closed()
  })
}

/* v8 ignore next -- Preparing an operation never writes response events. */
function preflightWrite(): Promise<void> { return Promise.resolve() }

function currentBudget(ctx: Context): ResourceBudget | undefined {
  try { return resourceBudgetOf(ctx) } catch (cause) {
    throw new LlmError('Parent resource admission is unavailable; restart this child run.', 'RESOURCE_BUDGET_UNAVAILABLE', { cause })
  }
}

/**
 * Bind a private model entry point to the actual initiating Agent and execution scope.
 * @param registration - provider registration context whose model policy also applies.
 * @param parent - actual parent; supplies Session, permissions, model service and usage identity.
 * @param spec - explicit registered route and validated transport bounds.
 * @param signal - cancels the external run and queued model requests.
 * @param forward - remote loopback forwarding owner; omission serves the child locally.
 * @returns native Codex overrides and idempotent, awaited transport cleanup.
 */
export async function startManagedCodexModel(
  registration: Context,
  parent: Parent,
  spec: ManagedCodexModelSpec,
  signal: AbortSignal,
  forward?: SshConnection['forwardLoopback'],
): Promise<ManagedCodexModel> {
  const inScope = AsyncLocalStorage.snapshot()
  const llm = parent.ctx.get('llm')
  if (llm === undefined) throw new SubagentError('Parent model service is required for managed Codex inference.', 'UNSUPPORTED_CAPABILITY')
  const registeredBudget = resourceBudgetOf(registration)
  const parentBudget = resourceBudgetOf(parent.ctx)
  const original = (value: ResourceBudget | undefined): ResourceBudget | undefined =>
    (value as (ResourceBudget & { [symbols.original]?: ResourceBudget }) | undefined)?.[symbols.original] ?? value
  if (registeredBudget !== undefined && original(registeredBudget) !== original(parentBudget)) {
    throw new SubagentError('Managed Codex requires the initiating parent resource owner.', 'UNSUPPORTED_CAPABILITY')
  }
  const assertResourceOwner = (): void => {
    if (original(currentBudget(registration)) !== original(registeredBudget)
      || original(currentBudget(parent.ctx)) !== original(parentBudget)) {
      throw new LlmError('Parent resource admission changed; restart this child run.', 'RESOURCE_BUDGET_UNAVAILABLE')
    }
  }
  const registrationPolicy = captureModelPolicy(registration)
  const parentPolicy = captureModelPolicy(parent.ctx)
  authorizeModelPolicy(registration, registrationPolicy, spec)
  authorizeModelPolicy(parent.ctx, parentPolicy, spec)
  try {
    await llm.prepareDelegatedOperation({ provider: spec.provider, model: spec.model }, 'native-stream', {
      protocol: 'openai-responses', body: { model: spec.model, stream: true, input: [] },
      maxResponseBytes: spec.maxResponseBytes, write: preflightWrite,
    }, signal)
  } catch (cause) {
    if (!(cause instanceof LlmError) || cause.code !== 'MODEL_OPERATION_UNSUPPORTED') throw cause
    throw new SubagentError('Managed Codex requires a parent model route with the Responses protocol. '
      + 'Choose a compatible model route or an SDK subagent provider.', 'UNSUPPORTED_CAPABILITY', { cause })
  }
  signal.throwIfAborted()
  assertResourceOwner()
  authorizeModelPolicy(registration, registrationPolicy, spec)
  authorizeModelPolicy(parent.ctx, parentPolicy, spec)
  const token = randomUUID()
  const controller = new AbortController()
  const ownedSignal = AbortSignal.any([signal, controller.signal])
  const sockets = new Set<Socket>()
  const work = new Set<Promise<void>>()
  const policies = new WeakMap<NativeModelStreamRequest, ReturnType<typeof captureModelPolicy>>()
  const removeAuthorization = parent.ctx.on('llm/authorize', (options) => {
    if (options.operation?.name !== 'native-stream') return Promise.resolve()
    const policy = policies.get(options.operation.request)
    if (policy !== undefined) {
      assertResourceOwner()
      authorizeModelPolicy(registration, policy, options)
    }
    return Promise.resolve()
  })
  const serve = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST' || request.url !== '/v1/responses'
      || !equalCredential(request.headers.authorization, `Bearer ${token}`)) {
      response.writeHead(403, { connection: 'close' }).end()
      return
    }
    const peer = new AbortController()
    const effective = AbortSignal.any([ownedSignal, peer.signal])
    /* v8 ignore next -- the early-close disconnect race is pinned by the POSIX suite. */
    const disconnected = (): void => { peer.abort() }
    response.once('close', disconnected)
    try {
      const bodyTimeout = new AbortController()
      const bodyTimer = setTimeout(() => {
        bodyTimeout.abort(new LlmError('Child model request body timed out.', 'TIMEOUT'))
      }, spec.requestTimeoutMs)
      let body: Record<string, unknown>
      try { body = await requestBody(request, spec.maxRequestBytes, AbortSignal.any([effective, bodyTimeout.signal])) }
      finally { clearTimeout(bodyTimer) }
      if (body.model !== spec.model || body.stream !== true) {
        throw new LlmError('Child model request changed its registered model or streaming mode.', 'INVALID_REQUEST')
      }
      assertResourceOwner()
      const registrationPolicy = captureModelPolicy(registration)
      const call = await llm.prepareDelegatedOperation({ provider: spec.provider, model: spec.model }, 'native-stream', {
        protocol: 'openai-responses', body, maxResponseBytes: spec.maxResponseBytes,
        write: async (frame) => {
          if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
          await writeEvent(response, frame.event, frame.data, effective)
        },
      }, effective)
      policies.set(call.request, registrationPolicy)
      parent.session.append('subagent/codex-model-request', { provider: call.config.provider, model: call.config.model, request: call.request })
      await parent.ctx.get('sessions')?.flush(parent.session)
      effective.throwIfAborted()
      assertResourceOwner()
      await call.run({ ...call.config, signal: effective, sessionId: parent.id, resourceOrigin: 'execution' })
      response.end()
    } catch (error) {
      const code = error instanceof LlmError ? error.code : 'SERVER'
      registration.logger.warn(`subagent-codex: parent model request failed (${code})`)
      if (response.headersSent) response.destroy()
      else response.writeHead(failureStatus(code),
        { 'content-type': 'application/json', connection: 'close' }).end(JSON.stringify({
        error: { message: 'Parent model admission or execution failed.', type: 'parent_model_error', code },
      }))
    } finally {
      response.off('close', disconnected)
      peer.abort()
    }
  }
  const server = createServer({ requestTimeout: spec.requestTimeoutMs }, (request, response) => {
    if (work.size >= spec.maxPendingRequests) {
      response.writeHead(429, { connection: 'close' }).end()
      return
    }
    const task = inScope(() => serve(request, response))
    work.add(task)
    void task.finally(() => { work.delete(task) }).catch(() => { response.destroy() })
  })
  // Preserve Node's derived header timeout; the authenticated reader owns body expiry.
  server.requestTimeout = 0
  server.maxConnections = spec.maxPendingRequests
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (error) { removeAuthorization(); throw error }
  let closing: Promise<void> | undefined
  const closeLocal = (): Promise<void> => {
    closing ??= (async () => {
      controller.abort()
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => {
          /* v8 ignore if -- Only this owner closes the successfully opened listener. */
          if (error !== undefined) reject(error)
          else resolve()
        })
      })
      for (const socket of sockets) socket.destroy()
      const outcomes = await Promise.allSettled([closed, ...work])
      removeAuthorization()
      const failures = outcomes.flatMap((outcome): unknown[] => outcome.status === 'rejected' ? [outcome.reason] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'Codex local model transport cleanup failed.')
    })()
    return closing
  }
  const localPort = (server.address() as AddressInfo).port
  let endpoint: SshLoopbackForward | undefined
  try {
    endpoint = forward === undefined ? { port: localPort, close: closeLocal } : await forward(localPort, closeLocal, signal)
    signal.throwIfAborted()
  } catch (error) {
    try { await (endpoint === undefined ? closeLocal() : endpoint.close()) } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Codex model forwarding allocation and local cleanup failed.')
    }
    throw error
  }
  const ownedEndpoint = endpoint
  const baseURL = `http://127.0.0.1:${ownedEndpoint.port}/v1`
  return {
    model: spec.model,
    config: [
      'model_provider="dsh_parent"', 'model_providers.dsh_parent.name="Harness parent"',
      `model_providers.dsh_parent.base_url=${JSON.stringify(baseURL)}`,
      'model_providers.dsh_parent.env_key="DSH_CODEX_MODEL_TOKEN"',
      'model_providers.dsh_parent.wire_api="responses"',
      'model_providers.dsh_parent.requires_openai_auth=false',
      'model_providers.dsh_parent.supports_websockets=false',
      'model_providers.dsh_parent.request_max_retries=0',
      'model_providers.dsh_parent.stream_max_retries=0',
    ],
    env: { DSH_CODEX_MODEL_TOKEN: token },
    close: () => ownedEndpoint.close(),
  }
}
