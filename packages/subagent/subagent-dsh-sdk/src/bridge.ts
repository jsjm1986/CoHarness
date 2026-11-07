/** Parent-owned authenticated control endpoint for SDK model and process admission. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { on } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { ResourceAdmissionError, resourceBudgetOf, type ResourceBudget, type ResourceLease } from '@deepseek-ai/dsh-resource-budget'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { executionAuthorityOf, sameExecutionAuthority } from '@deepseek-ai/dsh-execution-authority'
import { ParentModelRelay } from './model-relay.ts'
import { managedControlEntry } from './control-entry.ts'
import { SDK_PARENT_CONTROL_ENV, controlChunk, controlId, controlJson, controlOptions, controlRecord,
  type SdkControlConfig, type SdkControlId, type SdkControlConnection } from './control.ts'

interface ResourceOperation {
  readonly id: SdkControlId
  readonly controller: AbortController
  readonly model: ParentModelRelay | undefined
  work: Promise<void>
  lease?: ResourceLease
  delivered: boolean
  failure?: ResourceAdmissionError
  outcome?: 'released' | 'uncertain'
  acknowledged?: 'released' | 'uncertain'
  completion?: Promise<void>
}

/** Wait for owned cleanup without leaving a live timeout behind. */
async function joinBefore(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('SDK parent control cleanup did not settle.')) }, timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** One private endpoint retained until the SDK process cleanup transaction. */
export class SdkParentControl {
  private readonly token = randomBytes(32).toString('base64url')
  private readonly lifecycle = new AbortController()
  private readonly resources = new Map<SdkControlId, ResourceOperation>()
  private readonly models = new Map<SdkControlId, ParentModelRelay>()
  private readonly preclosed = new Set<SdkControlId>()
  private readonly handlers = new Set<Promise<void>>()
  private readonly budget: ResourceBudget | undefined
  private readonly ctx: Context
  private readonly server: Server
  private readonly scope = AsyncLocalStorage.snapshot()
  private readonly authority: ReturnType<typeof executionAuthorityOf>
  private closeTask: Promise<void> | undefined
  private lastId = 0
  private activeRequests = 0
  private closed = false
  private connected = false
  private connection: SdkControlConnection | undefined

  /** @param request - retained initiating Agent and its service realms. @param config - validated control limits. */
  constructor(private readonly request: SubagentStartRequest, private readonly config: SdkControlConfig) {
    this.ctx = request.parent.ctx
    this.budget = resourceBudgetOf(this.ctx)
    this.authority = executionAuthorityOf(this.ctx)
    this.server = createServer((incoming, outgoing) => {
      const work = this.scope(() => this.handle(incoming, outgoing))
      this.handlers.add(work)
      void work.then(() => { this.handlers.delete(work) }, (error: unknown) => {
        this.handlers.delete(work)
        outgoing.destroy()
        this.ctx.logger.warn('SDK parent control response failed: %o', error)
      })
    })
    this.server.requestTimeout = 0
    this.server.headersTimeout = config.requestTimeoutMs
  }

  /**
   * Listen on the authenticated loopback endpoint before publishing child startup settings.
   * @returns private bootstrap and connection environment after listening.
   */
  async open(): Promise<{ env: Record<string, string> }> {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => { reject(error) }
        this.server.once('error', onError)
        this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', onError); resolve() })
      })
      const address = this.server.address()
      if (address === null || typeof address === 'string') throw new Error('SDK parent control has no loopback listener.')
      this.connection = { url: `http://127.0.0.1:${String(address.port)}/`, token: this.token, config: this.config }
      const entry = managedControlEntry(new URL(import.meta.url))
      return { env: { [SDK_PARENT_CONTROL_ENV]: JSON.stringify(this.connection), DSH_SDK_PARENT_BOOTSTRAP: entry.href } }
    } catch (error) {
      try { await this.close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'SDK control startup and cleanup failed.') }
      throw error
    }
  }

  private authenticated(request: IncomingMessage): boolean {
    const actual = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.token}`)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private respond(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed || response.writableEnded) return
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > this.config.maxBytes) { response.destroy(); return }
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(body)
  }

  private async readRequest(request: IncomingMessage): Promise<unknown> {
    const timeout = new AbortController()
    const timer = setTimeout(() => {
      timeout.abort(new ResourceAdmissionError('unavailable', 'SDK control request body timed out.'))
    }, this.config.requestTimeoutMs)
    const signal = AbortSignal.any([timeout.signal, this.lifecycle.signal])
    try {
      const parts = on(request, 'data', { signal, close: ['end'], highWaterMark: 1, lowWaterMark: 1 }) as AsyncIterable<[Buffer]>
      return await controlJson((async function* () {
        for await (const [chunk] of parts) yield chunk
      })(), this.config.maxBytes)
    } catch (error) { signal.throwIfAborted(); throw error }
    finally { clearTimeout(timer) }
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed || !this.authenticated(request) || request.method !== 'POST') {
      response.writeHead(this.closed ? 503 : 401, { connection: 'close' }); response.end(); return
    }
    // Each operation can hold both relay directions, or resource observation and completion.
    const requestCapacity = Math.min(Number.MAX_SAFE_INTEGER, 2 * this.config.maxOperations)
    if (this.activeRequests >= requestCapacity) { response.writeHead(503, { connection: 'close' }); response.end(); return }
    this.activeRequests++
    try {
      const value = controlRecord(await this.readRequest(request))
      // Node's server callback supplies the parsed request target.
      this.respond(response, 200, await this.dispatch(request.url as string, value))
    } catch (error) {
      if (!request.complete) response.setHeader('connection', 'close')
      const known = error instanceof LlmError || error instanceof ResourceAdmissionError
      const code = error instanceof LlmError ? error.code : error instanceof ResourceAdmissionError ? error.reason : 'unavailable'
      this.respond(response, 400, { error: { code, message: known ? error.message : 'SDK parent control rejected the request.' } })
      if (!known && !(error instanceof TypeError || error instanceof SyntaxError)) this.ctx.logger.warn('SDK parent control failed: %o', error)
    } finally { this.activeRequests-- }
  }

  private register(id: SdkControlId): void {
    if (this.preclosed.delete(id)) {
      this.advanceRegistration(id)
      throw new ResourceAdmissionError('cancelled', 'SDK control operation was cancelled before registration.')
    }
    if (Number(id) <= this.lastId) throw new ResourceAdmissionError('refused', 'SDK control operation was already completed.')
    if (this.resources.size + this.models.size >= this.config.maxOperations) throw new ResourceAdmissionError('refused', 'SDK control operation capacity is full.')
    this.advanceRegistration(id)
  }

  /** Registrations at or below the last id are already refused and need no early-cancellation slot. */
  private advanceRegistration(id: SdkControlId): void {
    this.lastId = Math.max(this.lastId, Number(id))
    for (const cancelled of this.preclosed) {
      if (Number(cancelled) <= this.lastId) this.preclosed.delete(cancelled)
    }
  }

  private model(id: unknown): ParentModelRelay {
    const model = this.models.get(controlId(id))
    if (model === undefined) throw new ResourceAdmissionError('unavailable', 'SDK model stream is unavailable.')
    return model
  }

  private closeBeforeRegister(id: SdkControlId): void {
    if (Number(id) <= this.lastId) return
    if (this.preclosed.size >= this.config.maxOperations) throw new ResourceAdmissionError('refused', 'SDK early-cancellation capacity is full.')
    this.preclosed.add(id)
  }

  /** Retire only the ordered registration attempts already settled in the child. */
  private settleRegistrations(value: unknown): void {
    if (value !== undefined) this.advanceRegistration(controlId(value))
  }

  private async dispatch(path: string, row: Record<string, unknown>): Promise<unknown> {
    if (this.closed) throw new ResourceAdmissionError('unavailable', 'SDK parent control is stopping.')
    if (!sameExecutionAuthority(executionAuthorityOf(this.ctx), this.authority)) {
      throw new ResourceAdmissionError('unavailable', 'SDK parent execution authority changed.')
    }
    const id = controlId(row.id)
    switch (path) {
      case '/runtime/ready': this.connected = true; return {}
      case '/model/open': {
        if (this.models.has(id)) return {}
        const options = controlOptions(row.options)
        this.register(id)
        this.models.set(id, new ParentModelRelay(this.ctx, this.request.parent.id, options))
        return {}
      }
      case '/model/ready': return this.model(id).ready()
      case '/model/authorize': await this.model(id).authorize(controlOptions(row.options)); return {}
      case '/model/input': await this.model(id).input.push(controlChunk(row.chunk)); return {}
      case '/model/output': return this.output(this.model(id))
      case '/model/finish': this.model(id).finishInput(); return {}
      case '/model/close': {
        this.settleRegistrations(row.settledRegistration)
        const model = this.models.get(id)
        if (model === undefined) { this.closeBeforeRegister(id); return {} }
        model.cancel()
        await joinBefore(model.work, this.config.cleanupTimeoutMs)
        this.models.delete(id)
        return {}
      }
      case '/resource/register': {
        if (this.resources.has(id)) return {}
        if (row.kind !== 'model' && row.kind !== 'process') throw new TypeError('Invalid SDK resource kind.')
        const model = row.kind === 'model' ? this.model(row.modelId) : undefined
        this.register(id)
        const operation: ResourceOperation = { id, controller: new AbortController(), model,
          work: Promise.resolve(), delivered: false }
        this.resources.set(id, operation)
        operation.work = this.acquire(operation, row.kind)
        return {}
      }
      case '/resource/status': {
        const operation = this.resources.get(id)
        if (operation === undefined) return { state: 'finished' }
        if (operation.failure !== undefined) return { state: 'failed', reason: operation.failure.reason }
        if (operation.controller.signal.aborted || operation.model?.controller.signal.aborted === true
          || operation.lease?.signal.aborted === true) return { state: 'cancelled' }
        if (operation.lease === undefined) return { state: 'waiting' }
        operation.delivered = true
        operation.model?.leases.add(operation.lease)
        return { state: 'granted' }
      }
      case '/resource/finish': {
        if (row.outcome !== 'released' && row.outcome !== 'uncertain') throw new TypeError('Invalid SDK resource outcome.')
        this.settleRegistrations(row.settledRegistration)
        const operation = this.resources.get(id)
        if (operation !== undefined) await this.complete(operation, row.outcome)
        else this.closeBeforeRegister(id)
        return {}
      }
      default: throw new TypeError('Unknown SDK control method.')
    }
  }

  /** Refuse SDK transports that did not install the mandatory child bootstrap. */
  assertReady(): void {
    if (!this.connected || this.closed) throw new LlmError('SDK child did not activate required parent control.', 'MODEL_POLICY_UNAVAILABLE')
  }

  private async output(model: ParentModelRelay): Promise<unknown> {
    const poll = new AbortController()
    const timer = setTimeout(() => { poll.abort() }, this.config.pollMs)
    try {
      const item = await model.output.take(poll.signal)
      return item.done ? { done: true } : { done: false, chunk: item.value }
    } catch (error) {
      if (poll.signal.aborted) return { pending: true }
      throw error
    } finally { clearTimeout(timer) }
  }

  private async acquire(operation: ResourceOperation, kind: 'model' | 'process'): Promise<void> {
    try {
      const original = (value: ResourceBudget | undefined): ResourceBudget | undefined =>
        (value as (ResourceBudget & { [symbols.original]?: ResourceBudget }) | undefined)?.[symbols.original] ?? value
      if (original(resourceBudgetOf(this.ctx)) !== original(this.budget)) throw new ResourceAdmissionError('unavailable', 'SDK parent resource owner changed.')
      const signal = AbortSignal.any([this.lifecycle.signal, operation.controller.signal,
        ...operation.model === undefined ? [] : [operation.model.controller.signal]])
      const acquire = (): Promise<ResourceLease> | undefined => this.budget?.acquire({ kind, origin: 'execution',
        sessionId: this.request.parent.id, signal })
      const lease = await (operation.model === undefined ? acquire() : operation.model.inScope(acquire))
      operation.lease = lease ?? { signal, release: () => Promise.resolve(), uncertain: () => Promise.resolve() }
      if (this.closed || operation.outcome !== undefined || signal.aborted) {
        await operation.lease.release()
        delete operation.lease
        return
      }
      if (original(this.ctx.get('resourceBudget')) !== original(this.budget)
        || this.ctx.get('resourceBudgetRequired') === true && this.budget === undefined) {
        await operation.lease.release()
        delete operation.lease
        throw new ResourceAdmissionError('unavailable', 'SDK parent resource owner changed during admission.')
      }
    } catch (error) {
      operation.failure = error instanceof ResourceAdmissionError ? error : new ResourceAdmissionError('unavailable', 'SDK parent admission failed.', { cause: error })
    }
  }

  private complete(operation: ResourceOperation, outcome: 'released' | 'uncertain'): Promise<void> {
    operation.outcome = outcome === 'released' || operation.outcome === 'released' ? 'released' : 'uncertain'
    operation.completion = (operation.completion ?? Promise.resolve()).catch(() => {
      // A later report retries the same permit without losing proven quiescence.
    }).then(async () => {
      operation.controller.abort(new ResourceAdmissionError('cancelled', 'SDK resource operation completed.'))
      await operation.work
      const lease = operation.lease
      const reported = operation.outcome === 'uncertain' && operation.delivered ? 'uncertain' : 'released'
      if (operation.acknowledged === 'released' || operation.acknowledged === reported) return
      if (lease !== undefined) {
        operation.model?.leases.delete(lease)
        await (reported === 'uncertain' ? lease.uncertain() : lease.release())
      }
      operation.acknowledged = reported
      if (reported === 'released') this.resources.delete(operation.id)
    })
    return operation.completion
  }

  /**
   * Stop admission, close HTTP and join resource reports; a rejection retains retryable accounting.
   * @returns Joined disposal; proven quiescence remains stronger than shutdown uncertainty.
   */
  close(): Promise<void> {
    this.closeTask ??= this.closeOwned().catch((error: unknown) => { this.closeTask = undefined; throw error })
    return this.closeTask
  }

  private async closeOwned(): Promise<void> {
    this.closed = true
    this.lifecycle.abort(new ResourceAdmissionError('cancelled', 'SDK parent control was closed.'))
    for (const model of this.models.values()) model.cancel()
    const operations = [...this.resources.values()].map(operation => this.complete(operation, 'uncertain'))
    const work = Promise.allSettled([...operations, ...[...this.models.values()].map(model => model.work), ...this.handlers])
    let failure: Error | undefined
    try {
      await joinBefore(work.then((values) => {
        const failures = values.flatMap((value): unknown[] => value.status === 'rejected' ? [value.reason] : [])
        if (failures.length > 0) throw new AggregateError(failures, 'SDK managed resource cleanup failed.')
      }), this.config.cleanupTimeoutMs)
    } catch (error) {
      // This promise rejects only with the cleanup AggregateError or joinBefore's deadline Error.
      failure = error as Error
    }
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => { this.server.close(() => { resolve() }) })
    if (failure !== undefined) throw failure
  }
}
