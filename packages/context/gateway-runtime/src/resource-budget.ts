/** Runtime-owned permits retained through execution cancellation and confirmed cleanup. @module */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import ResourceBudget, { ResourceAdmissionError, type ResourceLease, type ResourceOperationId, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import {
  RESOURCE_MESSAGE_MAX_BYTES, RESOURCE_POLL_MAX_OPERATIONS, resourceErrorSchema, resourceRegistrationSchema,
  resourceStatusSchema, type ResourceOrigin, type ResourcePolicy, type ResourceStatus, type ResourceWireRequest,
} from '@deepseek-ai/dsh-resource-budget/wire'
import { readGatewayResponseJson, type GatewayRuntime } from './index.ts'

/** Bounded coordinator transport and disposal timing, in milliseconds. */
export interface Config {
  /** Maximum lifetime of one HTTP exchange, including its body. */
  requestTimeoutMs: number
  /** Total disposal budget, including a final uncertain-cleanup report. */
  cleanupTimeoutMs: number
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(reason: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

interface Operation {
  readonly id: ResourceOperationId
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly result: Deferred<ResourceLease>
  readonly done: Deferred<void>
  readonly origin: Promise<ResourceOrigin>
  readonly kind: ResourceRequest['kind']
  readonly detach: () => void
  readonly timer: ReturnType<typeof setTimeout>
  bytes: number
  request?: ResourceWireRequest
  attempted: boolean
  registered: boolean
  delivered: boolean
  completed: boolean
  acknowledged?: 'uncertain' | 'quiescent' | 'not-started'
  completion: Promise<void>
}

class ResourceHttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super('Resource coordinator rejected the operation.')
  }
}

function cancellation(signal: AbortSignal): ResourceAdmissionError {
  return signal.reason instanceof ResourceAdmissionError ? signal.reason
    : new ResourceAdmissionError('cancelled', 'Resource admission was cancelled.', { cause: signal.reason })
}

/** The read may finish later; cancellation prevents its result from entering admission. */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw cancellation(signal)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(cancellation(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
    void work.then(resolve, reject).finally(() => { signal.removeEventListener('abort', onAbort) })
  })
}

/** Join owned work until an absolute deadline, clearing the observation timer. */
async function settleBefore(work: Promise<unknown>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => { resolve(false) }, Math.max(0, deadline - Date.now())) }),
    ])
  } finally { clearTimeout(timer) }
}

/** Concrete provider for the Gateway-managed Runtime generation. */
export class GatewayResourceBudget extends ResourceBudget {
  static inject = ['gatewayRuntime']
  static Config: Schema<Config> = Schema.object({
    requestTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(5000),
    cleanupTimeoutMs: Schema.natural().min(1).max(2_147_483_647).default(30_000),
  })

  private readonly owner: { readonly ctx: Context; readonly runtime: GatewayRuntime; readonly config: Config }
  private readonly lifetime = new AbortController()
  private readonly operations = new Map<ResourceOperationId, Operation>()
  private readonly work = new Set<Promise<void>>()
  private policy: ResourcePolicy | undefined
  private nextSequence = 1
  private readonly registrations = new Set<Operation>()
  private registering = false
  private pollWork: Promise<void> = Promise.resolve()
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  private initialized = false
  private closed = false
  private bytes = 0
  private shutdownDeadline: number | undefined

  /** @param ctx - provider-owning Context. @param config - validated HTTP and disposal timing. */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    const resolved = GatewayResourceBudget.Config(config)
    if (resolved.cleanupTimeoutMs <= resolved.requestTimeoutMs) throw new Error('resource cleanup timeout must exceed its request timeout')
    this.owner = { ctx, runtime: ctx.gatewayRuntime, config: resolved }
    ctx.effect(() => () => this.shutdown(), 'gateway-resource-budget: operation ownership')
  }

  protected [Service.check](): boolean { return this.available() }

  private available(): boolean { return this.initialized && !this.closed }

  async [Service.init](): Promise<void> {
    const registered = resourceRegistrationSchema.parse(await this.post('register', {}, undefined, this.lifetime.signal))
    this.lifetime.signal.throwIfAborted()
    if (this.closed) throw new ResourceAdmissionError('unavailable', 'Resource admission is stopping.')
    this.policy = registered.policy
    this.nextSequence = registered.nextSequence
    this.initialized = true
  }

  async acquire(request: ResourceRequest): Promise<ResourceLease> {
    const policy = this.policy
    if (!this.initialized || this.closed || policy === undefined) throw new ResourceAdmissionError('unavailable', 'Resource admission is unavailable.')
    if (request.signal?.aborted === true) throw cancellation(request.signal)
    const initialBytes = Buffer.byteLength(JSON.stringify({ kind: request.kind, sessionId: request.sessionId, origin: request.origin }))
    if ([...this.operations.values()].filter(entry => !entry.delivered).length >= policy.maxQueued
      || this.bytes + initialBytes > policy.maxQueuedBytes) throw new ResourceAdmissionError('refused', 'The Runtime resource queue is full.')
    const controller = new AbortController()
    const result = deferred<ResourceLease>(), done = deferred<void>()
    // The origin read starts in the caller's scope, before joining the serial registration queue.
    const origin = this.captureOrigin(this.ctx, request).then((value) => {
      if (entry.completed || entry.controller.signal.aborted) throw cancellation(entry.controller.signal)
      const size = Buffer.byteLength(JSON.stringify({ requestId: entry.id, sequence: this.nextSequence, kind: entry.kind, origin: value }))
      if (size > RESOURCE_MESSAGE_MAX_BYTES || this.bytes - entry.bytes + size > policy.maxQueuedBytes) {
        throw new ResourceAdmissionError('refused', 'The Runtime resource metadata queue is full.')
      }
      this.bytes += size - entry.bytes
      entry.bytes = size
      return value
    })
    void origin.catch(() => { /* preparation reports this failure or its prior cancellation */ })
    const onAbort = (): void => { controller.abort(request.signal?.reason) }
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const entry: Operation = {
      id: randomUUID() as ResourceOperationId, kind: request.kind, controller, result, done, origin,
      signal: AbortSignal.any([this.lifetime.signal, controller.signal, ...request.signal === undefined ? [] : [request.signal]]),
      detach: () => { request.signal?.removeEventListener('abort', onAbort) },
      timer: setTimeout(() => { controller.abort(new ResourceAdmissionError('expired', 'Resource admission expired.')) }, policy.maxWaitMs),
      bytes: initialBytes, attempted: false, registered: false, delivered: false, completed: false,
      completion: Promise.resolve(),
    }
    controller.signal.addEventListener('abort', () => {
      if (entry.delivered || entry.completed) return
      entry.result.reject(cancellation(controller.signal))
      if (entry.registered) this.track(this.cancel(entry))
      else if (!entry.attempted) this.forget(entry)
    }, { once: true })
    this.operations.set(entry.id, entry)
    this.bytes += initialBytes
    this.track(this.prepareRegistration(entry))
    return result.promise
  }

  private async prepareRegistration(entry: Operation): Promise<void> {
    try {
      await abortable(entry.origin, entry.controller.signal)
      if (entry.completed) return
      this.registrations.add(entry)
      if (!this.registering) this.track(this.drainRegistrations().catch((error: unknown) => { this.failClosed(error) }))
    } catch (error) {
      entry.result.reject(error)
      this.forget(entry)
    }
  }

  private async drainRegistrations(): Promise<void> {
    this.registering = true
    try {
      while (!this.closed) {
        const entry = this.registrations.values().next().value
        if (entry === undefined) return
        this.registrations.delete(entry)
        if (!entry.completed) await this.register(entry)
      }
    } finally { this.registering = false }
  }

  private async captureOrigin(ctx: Context, request: ResourceRequest): Promise<ResourceOrigin> {
    if (request.origin === 'infrastructure') return { kind: 'runtime' }
    const runtime = this.owner.runtime
    const principal = runtime.interactive()
    if (request.origin === 'interactive') {
      if (principal === undefined || principal.claims.purpose === 'archive-read') {
        throw new ResourceAdmissionError('unavailable', 'Resource admission requires a live interactive caller.')
      }
      return { kind: 'principal', assertion: principal.assertion }
    }
    const authority = ctx.get('executionAuthority')
    const captured = authority?.current()
    if (captured !== undefined && (request.sessionId === undefined || request.sessionId === captured.parentSessionId)) {
      return { kind: 'session', sessionId: captured.parentSessionId,
        ...(captured.scopeId === undefined ? {} : { scopeId: captured.scopeId }) }
    }
    const agents = ctx.get('agents')
    const agent = request.sessionId === undefined ? agents?.currentInitiator() : agents?.get(request.sessionId)
    const sessionId = request.sessionId ?? agent?.id
    if (sessionId !== undefined) {
      if (authority === undefined) throw new ResourceAdmissionError('unavailable', 'The resource execution origin is unavailable.')
      const scope = agent === undefined ? await authority.captureSession(sessionId) : authority.capture(agent)
      return { kind: 'session', sessionId, ...(scope.scopeId === undefined ? {} : { scopeId: scope.scopeId }) }
    }
    if (request.origin === 'execution') throw new ResourceAdmissionError('unavailable', 'Resource admission requires an executing Session.')
    return principal === undefined || principal.claims.purpose === 'archive-read'
      ? { kind: 'runtime' } : { kind: 'principal', assertion: principal.assertion }
  }

  private async register(entry: Operation): Promise<void> {
    try {
      const policy = this.policy
      if (policy === undefined) throw new ResourceAdmissionError('unavailable', 'Resource admission has not initialized.')
      const origin = await abortable(entry.origin, entry.controller.signal)
      while (!entry.controller.signal.aborted && !this.closed) {
        const request: ResourceWireRequest = { requestId: entry.id, sequence: this.nextSequence, kind: entry.kind, origin }
        const size = Buffer.byteLength(JSON.stringify(request))
        if (size > RESOURCE_MESSAGE_MAX_BYTES || this.bytes - entry.bytes + size > policy.maxQueuedBytes) {
          throw new ResourceAdmissionError('refused', 'The Runtime resource metadata queue is full.')
        }
        this.bytes += size - entry.bytes
        entry.bytes = size
        entry.request = request
        entry.attempted = true
        let status: ResourceStatus
        try { status = resourceStatusSchema.parse(await this.post('request', request)) } catch (error) {
          if (error instanceof ResourceHttpError && (error.code === 'resource-request-conflict' || error.code === 'resource-sequence-gap')) {
            entry.attempted = false
            await this.resynchronize()
            continue
          }
          throw error
        }
        if (status.state === 'closed') {
          entry.attempted = false
          await this.resynchronize()
          continue
        }
        entry.registered = true
        this.nextSequence = request.sequence + 1
        entry.controller.signal.throwIfAborted()
        if (!this.available()) { await this.cancel(entry); return }
        await this.acceptStatus(entry, request, status)
        return
      }
      throw cancellation(entry.controller.signal)
    } catch (error) {
      entry.result.reject(error)
      if (entry.attempted) {
        try {
          await this.complete(entry, 'not-started')
          if (!entry.registered) await this.resynchronize()
        } catch (cleanupError) {
          this.failClosed(cleanupError)
        }
      } else this.forget(entry)
    }
  }

  private async resynchronize(): Promise<void> {
    const result = resourceRegistrationSchema.parse(await this.post('register', {}))
    this.nextSequence = result.nextSequence
    this.policy = result.policy
  }

  private async acceptStatus(entry: Operation, request: ResourceWireRequest, status: ResourceStatus, qualified = false): Promise<void> {
    if (entry.completed || entry.delivered) return
    if (entry.controller.signal.aborted || this.closed) { await this.cancel(entry); return }
    switch (status.state) {
      case 'active': {
        if (!qualified) {
          const response = await this.post('statuses', { operations: [{ sequence: request.sequence, requestId: entry.id }] })
          if (!Array.isArray(response) || response.length !== 1) throw new Error('invalid resource grant check')
          await this.acceptStatus(entry, request, resourceStatusSchema.parse(response[0]), true)
          return
        }
        entry.controller.signal.throwIfAborted()
        if (!this.available()) { await this.cancel(entry); return }
        entry.delivered = true
        clearTimeout(entry.timer)
        entry.result.resolve({ signal: entry.signal,
          release: () => this.complete(entry, 'quiescent'), uncertain: () => this.complete(entry, 'uncertain') })
        return
      }
      case 'queued': this.schedulePoll(); return
      case 'closed':
        entry.result.reject(new ResourceAdmissionError('expired', 'Resource admission is no longer queued.'))
        this.forget(entry)
        return
      case 'uncertain':
      case 'refused':
        entry.result.reject(new ResourceAdmissionError('refused', 'Resource admission was refused.'))
        await this.cancel(entry)
        return
    }
  }

  private schedulePoll(): void {
    const policy = this.policy
    if (this.closed || this.pollTimer !== undefined || policy === undefined) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      this.pollWork = this.poll().finally(() => {
        if ([...this.operations.values()].some(entry => entry.registered && !entry.delivered && !entry.completed)) this.schedulePoll()
      })
      this.track(this.pollWork)
    }, policy.sampleMs)
  }

  private async poll(): Promise<void> {
    const waiting = [...this.operations.values()].flatMap(entry => entry.registered && !entry.delivered && !entry.completed
      && entry.request !== undefined ? [{ entry, request: entry.request }] : [])
    for (let offset = 0; offset < waiting.length && !this.closed; offset += RESOURCE_POLL_MAX_OPERATIONS) {
      const batch = waiting.slice(offset, offset + RESOURCE_POLL_MAX_OPERATIONS)
      try {
        const response = await this.post('statuses', {
          operations: batch.map(({ entry, request }) => ({ sequence: request.sequence, requestId: entry.id })),
        })
        if (!Array.isArray(response) || response.length !== batch.length) throw new Error('invalid resource status batch')
        for (const [index, { entry, request }] of batch.entries()) {
          // Another operation's authorization can delay a batched grant.
          try { await this.acceptStatus(entry, request, resourceStatusSchema.parse(response[index]), batch.length === 1) } catch (error) {
            entry.result.reject(error)
            await this.cancel(entry)
          }
        }
      } catch (error) {
        if (error instanceof ResourceHttpError && error.status < 500) this.failClosed(error)
        // Transport failure retains the original queue and its cancellation deadline.
      }
    }
  }

  private async cancel(entry: Operation): Promise<void> {
    if (entry.completed || entry.delivered) return
    entry.result.reject(cancellation(entry.controller.signal))
    try { await this.complete(entry, 'not-started') } catch (error) { this.failClosed(error) }
  }

  private complete(entry: Operation, outcome: 'not-started' | 'quiescent' | 'uncertain', deadline?: number): Promise<void> {
    const completion = entry.completion.catch(() => { /* a later report retries the same exact operation */ }).then(async () => {
      if (entry.acknowledged === 'quiescent' || entry.acknowledged === 'not-started' || entry.acknowledged === outcome) return
      if (entry.request === undefined) { this.forget(entry); return }
      const until = Math.min(deadline ?? Number.POSITIVE_INFINITY, this.shutdownDeadline ?? Number.POSITIVE_INFINITY,
        Date.now() + this.owner.config.cleanupTimeoutMs)
      for (;;) {
        try {
          await this.post('finish', { sequence: entry.request.sequence, requestId: entry.id, outcome }, until)
          entry.acknowledged = outcome
          this.forget(entry)
          return
        } catch (error) {
          if ((error instanceof ResourceHttpError && error.status < 500) || Date.now() >= until) throw error
          await delay(Math.min(this.policy?.sampleMs ?? this.owner.config.requestTimeoutMs, Math.max(0, until - Date.now())))
        }
      }
    })
    entry.completion = completion
    this.track(completion)
    return completion
  }

  private forget(entry: Operation): void {
    if (entry.completed) return
    entry.completed = true
    clearTimeout(entry.timer)
    entry.detach()
    this.operations.delete(entry.id)
    this.registrations.delete(entry)
    this.bytes -= entry.bytes
    entry.done.resolve()
  }

  private track(work: Promise<void>): void {
    this.work.add(work)
    void work.then(() => { this.work.delete(work) }, () => { this.work.delete(work) })
  }

  private failClosed(cause: unknown): void {
    if (this.closed) return
    this.closed = true
    this.initialized = false
    clearTimeout(this.pollTimer)
    const error = new ResourceAdmissionError('unavailable', 'Resource accounting could not be confirmed.', { cause })
    this.lifetime.abort(error)
    for (const entry of this.operations.values()) entry.controller.abort(error)
  }

  private async shutdown(): Promise<void> {
    this.closed = true
    this.initialized = false
    this.lifetime.abort(new ResourceAdmissionError('unavailable', 'Resource admission is stopping.'))
    clearTimeout(this.pollTimer)
    const until = Date.now() + this.owner.config.cleanupTimeoutMs
    this.shutdownDeadline = until
    for (const entry of this.operations.values()) {
      entry.controller.abort(new ResourceAdmissionError('unavailable', 'Resource admission is stopping.'))
    }
    const finished = Promise.all([...this.operations.values()].map(entry => entry.done.promise))
    await settleBefore(finished, until - this.owner.config.requestTimeoutMs)
    await Promise.allSettled([...this.operations.values()].map(entry => this.complete(entry, entry.delivered ? 'uncertain' : 'not-started', until)))
    await settleBefore(Promise.allSettled([...this.work]), until)
    this.shutdownDeadline = undefined
  }

  private async post(action: string, value: unknown, deadline?: number, upstream?: AbortSignal): Promise<unknown> {
    const timeout = Math.min(this.owner.config.requestTimeoutMs,
      deadline === undefined ? this.owner.config.requestTimeoutMs : deadline - Date.now())
    if (timeout <= 0) throw new ResourceAdmissionError('unavailable', 'Resource accounting deadline expired.')
    const signal = upstream === undefined ? AbortSignal.timeout(timeout) : AbortSignal.any([upstream, AbortSignal.timeout(timeout)])
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > RESOURCE_MESSAGE_MAX_BYTES) throw new ResourceAdmissionError('refused', 'Resource metadata exceeds the protocol byte limit.')
    const response = await this.owner.runtime.request(`/internal/runtime/resources/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal,
    })
    const payload = await readGatewayResponseJson(response, RESOURCE_MESSAGE_MAX_BYTES, signal)
    if (!response.ok) {
      const error = resourceErrorSchema.safeParse(payload)
      throw new ResourceHttpError(response.status, error.success ? error.data.error : 'resource-response')
    }
    return payload
  }
}

export default GatewayResourceBudget
