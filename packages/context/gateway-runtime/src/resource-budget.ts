/** Runtime-owned permits retained through execution cancellation and confirmed cleanup. @module */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Service, type Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import ResourceBudget, { ResourceAdmissionError, type ResourceLease, type ResourceOperationId, type ResourceRequest } from '@deepseek-ai/dsh-resource-budget'
import {
  RESOURCE_ACTIVE_MODEL_CHECK_HEADER, RESOURCE_CHANGE_CURSOR_HEADER, RESOURCE_CHANGE_WAIT_TIMING_HEADER, RESOURCE_GRANT_AGE_HEADER,
  RESOURCE_INGRESS_TIMING_HEADER, RESOURCE_MESSAGE_MAX_BYTES, RESOURCE_PHASE_TIMING_HEADER,
  RESOURCE_POLL_MAX_OPERATIONS, RESOURCE_QUALIFIED_GRANT_HEADER,
  resourceErrorSchema, resourceRegistrationSchema,
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

interface ModelResourceTiming {
  operationId: ResourceOperationId
  startedAt: number
  started: number
  originMs: number
  registrationReady?: number
  registrationWaitMs: number
  submitMs: number
  submitCalls: number
  statusMs: number
  statusCalls: number
  lastStatusOperationId?: ResourceOperationId
  statusChangeWaitSamples: number
  statusChangeWaitMs: number
  queuedResponses: number
  pollReady?: number | undefined
  pollWaitMs: number
  gatewaySamples: number
  gatewayHandlerBearerMs: number
  gatewayAuthorityMs: number
  gatewayTransactionMs: number
  gatewayIngressSamples: number
  gatewayIngressBearerMs: number
  gatewayWriteAdmissionMs: number
  grantQueueMs?: number
}

interface ResourceExchangeObservation {
  operationId: ResourceOperationId
  samples: readonly ModelResourceTiming[]
}

function observeSingle(timing: ModelResourceTiming | undefined): ResourceExchangeObservation | undefined {
  return timing === undefined ? undefined : { operationId: timing.operationId, samples: [timing] }
}

function readCoordinatorTiming(response: Response | undefined, name: string, count: 2): [number, number] | undefined
function readCoordinatorTiming(response: Response | undefined, name: string, count: 3): [number, number, number] | undefined
function readCoordinatorTiming(
  response: Response | undefined, name: string, count: 2 | 3,
): [number, number] | [number, number, number] | undefined {
  const header = response?.headers.get(name)
  if (header === undefined || header === null || header.length > 128) return
  try {
    const phases: unknown = JSON.parse(header)
    const duration = (ms: unknown): ms is number => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 && ms <= Number.MAX_SAFE_INTEGER
    if (!Array.isArray(phases) || phases.length !== count) return
    const first: unknown = phases[0], second: unknown = phases[1], third: unknown = phases[2]
    if (!duration(first) || !duration(second)) return
    if (count === 2) return [first, second]
    if (duration(third)) return [first, second, third]
  } catch { /* Invalid optional timing data cannot influence admission. */ }
}

function reportTiming(timing: ModelResourceTiming, outcome: 'granted' | 'failed'): void {
  const round = (ms: number): number => Math.round(ms * 100) / 100
  const {
    operationId, startedAt, started, originMs, registrationWaitMs, submitMs, submitCalls, statusMs, statusCalls,
    lastStatusOperationId, statusChangeWaitSamples, statusChangeWaitMs,
    queuedResponses, pollWaitMs, gatewaySamples, gatewayHandlerBearerMs, gatewayAuthorityMs, gatewayTransactionMs,
    gatewayIngressSamples, gatewayIngressBearerMs, gatewayWriteAdmissionMs,
  } = timing
  try {
    console.info(`[model-resource-timing] ${JSON.stringify({
      operationId, startedAt, outcome, elapsedMs: round(performance.now() - started), originMs: round(originMs),
      registrationWaitMs: round(registrationWaitMs), submitMs: round(submitMs), submitCalls,
      statusMs: round(statusMs), statusCalls, lastStatusOperationId, queuedResponses, pollWaitMs: round(pollWaitMs),
      ...(statusChangeWaitSamples === 0 ? {} : { statusChangeWaitSamples, statusChangeWaitMs: round(statusChangeWaitMs) }),
      ...(timing.grantQueueMs === undefined ? {} : { grantQueueMs: timing.grantQueueMs }),
      ...(gatewaySamples === 0 ? {} : { gatewaySamples, gatewayHandlerBearerMs: round(gatewayHandlerBearerMs),
        gatewayAuthorityMs: round(gatewayAuthorityMs), gatewayTransactionMs: round(gatewayTransactionMs) }),
      ...(gatewayIngressSamples === 0 ? {} : { gatewayIngressSamples, gatewayIngressBearerMs: round(gatewayIngressBearerMs),
        gatewayWriteAdmissionMs: round(gatewayWriteAdmissionMs) }),
    })}`)
  } catch { /* Diagnostic output cannot interrupt a resource lease. */ }
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
  readonly timing: ModelResourceTiming | undefined
  bytes: number
  request?: ResourceWireRequest
  changeCursor?: string | undefined
  qualifiedGrant?: true | undefined
  attempted: boolean
  registered: boolean
  delivered: boolean
  completed: boolean
  quiescent: boolean
  retryingCompletion: boolean
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

  private readonly owner: {
    readonly runtime: GatewayRuntime
    readonly config: Config
    readonly acquire: (caller: Context, request: ResourceRequest) => Promise<ResourceLease>
  }
  private readonly lifetime = new AbortController()
  private readonly operations = new Map<ResourceOperationId, Operation>()
  private readonly work = new Set<Promise<void>>()
  private policy: ResourcePolicy | undefined
  private nextSequence = 1
  private readonly registrations = new Set<Operation>()
  private registering = false
  private pollWork: Promise<void> | undefined
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
    this.owner = {
      runtime: ctx.gatewayRuntime, config: resolved,
      acquire: (caller, request) => this.acquireForCaller(caller, request),
    }
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

  acquire(request: ResourceRequest): Promise<ResourceLease> {
    // Keep the caller for authority reads. Rescheduled polling belongs to the provider and must not retain nested caller shadows.
    return this.owner.acquire(this.ctx, request)
  }

  private async acquireForCaller(caller: Context, request: ResourceRequest): Promise<ResourceLease> {
    const policy = this.policy
    if (!this.initialized || this.closed || policy === undefined) throw new ResourceAdmissionError('unavailable', 'Resource admission is unavailable.')
    if (request.signal?.aborted === true) throw cancellation(request.signal)
    const initialBytes = Buffer.byteLength(JSON.stringify({ kind: request.kind, sessionId: request.sessionId, origin: request.origin }))
    if ([...this.operations.values()].filter(entry => !entry.delivered).length >= policy.maxQueued
      || this.bytes + initialBytes > policy.maxQueuedBytes) throw new ResourceAdmissionError('refused', 'The Runtime resource queue is full.')
    const controller = new AbortController()
    const result = deferred<ResourceLease>(), done = deferred<void>()
    const operationId = randomUUID() as ResourceOperationId
    const timing = request.kind === 'model' && this.owner.runtime.modelTimings ? {
      operationId, startedAt: Date.now(), started: performance.now(), originMs: 0, registrationWaitMs: 0,
      submitMs: 0, submitCalls: 0, statusMs: 0, statusCalls: 0, queuedResponses: 0, pollWaitMs: 0,
      statusChangeWaitSamples: 0, statusChangeWaitMs: 0,
      gatewaySamples: 0, gatewayHandlerBearerMs: 0, gatewayAuthorityMs: 0, gatewayTransactionMs: 0,
      gatewayIngressSamples: 0, gatewayIngressBearerMs: 0, gatewayWriteAdmissionMs: 0,
    } satisfies ModelResourceTiming : undefined
    // The origin read starts in the caller's scope, before joining the serial registration queue.
    const origin = this.captureOrigin(caller, request).then((value) => {
      if (timing !== undefined) timing.originMs = performance.now() - timing.started
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
      id: operationId, kind: request.kind, controller, result, done, origin,
      signal: AbortSignal.any([this.lifetime.signal, controller.signal, ...request.signal === undefined ? [] : [request.signal]]),
      detach: () => { request.signal?.removeEventListener('abort', onAbort) },
      timer: setTimeout(() => { controller.abort(new ResourceAdmissionError('expired', 'Resource admission expired.')) }, policy.maxWaitMs),
      bytes: initialBytes, timing, attempted: false, registered: false, delivered: false, completed: false,
      quiescent: false, retryingCompletion: false,
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
    if (timing === undefined) return result.promise
    return result.promise.then((lease) => {
      reportTiming(timing, 'granted')
      return lease
    }, (error: unknown) => {
      reportTiming(timing, 'failed')
      throw error
    })
  }

  private async prepareRegistration(entry: Operation): Promise<void> {
    try {
      await abortable(entry.origin, entry.controller.signal)
      if (entry.completed) return
      if (entry.timing !== undefined) entry.timing.registrationReady = performance.now()
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
    const timing = entry.timing
    if (timing?.registrationReady !== undefined) timing.registrationWaitMs = performance.now() - timing.registrationReady
    const observation = observeSingle(timing)
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
        try { status = resourceStatusSchema.parse(await this.post('request', request, undefined, undefined, observation, entry)) } catch (error) {
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
        await this.acceptStatus(entry, request, status, entry.qualifiedGrant === true)
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
          const scopedModel = request.kind === 'model' && request.origin.kind === 'session' && request.origin.scopeId !== undefined
          const response = await this.post(scopedModel ? 'confirm-active-model' : 'statuses',
            { operations: [{ sequence: request.sequence, requestId: entry.id }] }, undefined, undefined, observeSingle(entry.timing))
          if (!Array.isArray(response) || response.length !== 1) throw new Error('invalid resource grant check')
          await this.acceptStatus(entry, request, resourceStatusSchema.parse(response[0]), true)
          return
        }
        entry.controller.signal.throwIfAborted()
        if (!this.available()) { await this.cancel(entry); return }
        entry.delivered = true
        clearTimeout(entry.timer)
        entry.result.resolve({ operationId: entry.id, signal: entry.signal,
          release: () => this.release(entry), uncertain: () => this.complete(entry, 'uncertain') })
        return
      }
      case 'queued':
        if (entry.timing !== undefined) {
          entry.timing.queuedResponses += 1
          entry.timing.pollReady = performance.now()
        }
        this.schedulePoll()
        return
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
    if (this.closed || this.pollTimer !== undefined || this.pollWork !== undefined || policy === undefined) return
    const waiting = [...this.operations.values()].filter(entry => this.awaitingGrant(entry))
    if (waiting.length === 0) return
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      const work = this.poll().finally(() => {
        this.pollWork = undefined
        this.schedulePoll()
      })
      this.pollWork = work
      this.track(work)
    }, waiting.length === 1 && waiting[0]?.changeCursor !== undefined ? 0 : policy.sampleMs)
  }

  private awaitingGrant(entry: Operation): boolean { return entry.registered && !entry.delivered && !entry.completed }

  private async poll(): Promise<void> {
    const waiting = [...this.operations.values()].flatMap(entry => this.awaitingGrant(entry)
      && entry.request !== undefined ? [{ entry, request: entry.request }] : [])
    for (let offset = 0; offset < waiting.length && !this.closed; offset += RESOURCE_POLL_MAX_OPERATIONS) {
      const batch = waiting.slice(offset, offset + RESOURCE_POLL_MAX_OPERATIONS)
      const samples = batch.flatMap(({ entry }) => {
        const timing = entry.timing
        if (timing === undefined) return []
        if (timing.pollReady !== undefined) {
          timing.pollWaitMs += performance.now() - timing.pollReady
          timing.pollReady = undefined
        }
        return [timing]
      })
      try {
        const single = batch.length === 1 ? batch[0]?.entry : undefined
        const observed = single?.changeCursor === undefined ? undefined : single
        const observation = samples.length === 0 ? undefined : {
          operationId: single?.id ?? (randomUUID() as ResourceOperationId), samples,
        }
        const response = await this.post(observed === undefined ? 'statuses' : 'confirm-active-model', {
          operations: batch.map(({ entry, request }) => ({ sequence: request.sequence, requestId: entry.id })),
        }, undefined, observed?.controller.signal, observation, observed)
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
      } finally {
        for (const { entry } of batch) {
          if (!entry.completed && !entry.delivered && entry.timing?.queuedResponses && entry.timing.pollReady === undefined) {
            entry.timing.pollReady = performance.now()
          }
        }
      }
    }
  }

  private async cancel(entry: Operation): Promise<void> {
    if (entry.completed || entry.delivered) return
    entry.result.reject(cancellation(entry.controller.signal))
    try { await this.complete(entry, 'not-started') } catch (error) { this.failClosed(error) }
  }

  private async release(entry: Operation): Promise<void> {
    entry.quiescent = true
    const model = entry.kind === 'model'
    try {
      await this.complete(entry, 'quiescent', { retry: !model })
    } catch (error) {
      if (!model || this.closed || (error instanceof ResourceHttpError && error.status < 500)) throw error
      if (entry.retryingCompletion) return
      entry.retryingCompletion = true
      this.track(this.retryModelCompletion(entry))
    }
  }

  private async retryModelCompletion(entry: Operation): Promise<void> {
    const signal = this.lifetime.signal
    this.ctx.logger.warn('Model resource completion is awaiting acknowledgement.')
    try {
      for (;;) {
        await delay(this.owner.config.requestTimeoutMs, undefined, { signal, ref: false })
        try {
          await this.complete(entry, 'quiescent', { signal, retry: false })
          return
        } catch (error) {
          if (error instanceof ResourceHttpError && error.status < 500) {
            this.ctx.logger.warn('Model resource completion was denied by the coordinator.')
            return
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      entry.retryingCompletion = false
    }
  }

  private complete(entry: Operation, outcome: 'not-started' | 'quiescent' | 'uncertain',
    { deadline, signal, retry = true }: { deadline?: number; signal?: AbortSignal; retry?: boolean } = {}): Promise<void> {
    const completion = entry.completion.catch(() => { /* a later report retries the same exact operation */ }).then(async () => {
      if (entry.acknowledged === 'quiescent' || entry.acknowledged === 'not-started' || entry.acknowledged === outcome) return
      if (entry.request === undefined) { this.forget(entry); return }
      const until = Math.min(deadline ?? Number.POSITIVE_INFINITY, this.shutdownDeadline ?? Number.POSITIVE_INFINITY,
        Date.now() + this.owner.config.cleanupTimeoutMs)
      for (;;) {
        signal?.throwIfAborted()
        try {
          await this.post('finish', { sequence: entry.request.sequence, requestId: entry.id, outcome }, until, signal)
          entry.acknowledged = outcome
          this.forget(entry)
          return
        } catch (error) {
          if (!retry || (error instanceof ResourceHttpError && error.status < 500) || Date.now() >= until || signal?.aborted) throw error
          const retryMs = Math.min(this.policy?.sampleMs ?? this.owner.config.requestTimeoutMs, Math.max(0, until - Date.now()))
          await delay(retryMs, undefined, { signal })
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
    await Promise.allSettled([...this.operations.values()].map(entry => this.complete(entry,
      entry.quiescent ? 'quiescent' : entry.delivered ? 'uncertain' : 'not-started', { deadline: until })))
    await settleBefore(Promise.allSettled([...this.work]), until)
    this.shutdownDeadline = undefined
  }

  private async post(
    action: string, value: unknown, deadline?: number, upstream?: AbortSignal,
    observation?: ResourceExchangeObservation, observed?: Operation,
  ): Promise<unknown> {
    const confirmingModel = action === 'confirm-active-model'
    const route = confirmingModel ? 'statuses' : action
    const timeout = Math.min(this.owner.config.requestTimeoutMs,
      deadline === undefined ? this.owner.config.requestTimeoutMs : deadline - Date.now())
    if (timeout <= 0) throw new ResourceAdmissionError('unavailable', 'Resource accounting deadline expired.')
    const signal = upstream === undefined ? AbortSignal.timeout(timeout) : AbortSignal.any([upstream, AbortSignal.timeout(timeout)])
    const body = JSON.stringify(value)
    if (Buffer.byteLength(body) > RESOURCE_MESSAGE_MAX_BYTES) throw new ResourceAdmissionError('refused', 'Resource metadata exceeds the protocol byte limit.')
    const started = observation === undefined ? undefined : performance.now()
    const cursor = confirmingModel ? observed?.changeCursor : undefined
    if (observed !== undefined) observed.changeCursor = undefined
    let response: Response | undefined
    try {
      response = await this.owner.runtime.request(`/internal/runtime/resources/${route}`, {
        method: 'POST', headers: { 'content-type': 'application/json',
          ...(observation === undefined ? {} : { 'x-dsh-operation-id': observation.operationId }),
          ...(confirmingModel ? { [RESOURCE_ACTIVE_MODEL_CHECK_HEADER]: '1' } : {}),
          ...(cursor === undefined ? {} : { [RESOURCE_CHANGE_CURSOR_HEADER]: cursor }) }, body, signal,
      })
      const payload = await readGatewayResponseJson(response, RESOURCE_MESSAGE_MAX_BYTES, signal)
      if (!response.ok) {
        const error = resourceErrorSchema.safeParse(payload)
        throw new ResourceHttpError(response.status, error.success ? error.data.error : 'resource-response')
      }
      const change = response.headers.get(RESOURCE_CHANGE_CURSOR_HEADER)
      if (observed !== undefined && change !== null && /^[a-f0-9-]{36}\.\d{1,16}$/u.test(change)) observed.changeCursor = change
      if (action === 'request' && observed !== undefined) {
        const request = observed.request
        observed.qualifiedGrant = response.headers.get(RESOURCE_QUALIFIED_GRANT_HEADER) === '1'
          && request?.kind === 'model' && request.origin.kind === 'session' && request.origin.scopeId !== undefined
          ? true : undefined
      }
      return payload
    } finally {
      if (started !== undefined && observation !== undefined) {
        const elapsed = performance.now() - started
        const phases = readCoordinatorTiming(response, RESOURCE_PHASE_TIMING_HEADER, 3)
        const ingress = readCoordinatorTiming(response, RESOURCE_INGRESS_TIMING_HEADER, 2)
        const age = response?.headers.get(RESOURCE_GRANT_AGE_HEADER) ?? ''
        const changeWait = response?.headers.get(RESOURCE_CHANGE_WAIT_TIMING_HEADER) ?? ''
        for (const timing of observation.samples) {
          if (action === 'request') { timing.submitCalls += 1; timing.submitMs += elapsed }
          if (route === 'statuses') {
            timing.statusCalls += 1
            timing.statusMs += elapsed
            timing.lastStatusOperationId = observation.operationId
            if (/^\d{1,12}(?:\.\d{1,2})?$/u.test(changeWait)) {
              timing.statusChangeWaitSamples += 1
              timing.statusChangeWaitMs += Math.min(elapsed, Number(changeWait))
            }
          }
          if (/^\d{1,12}$/u.test(age)) timing.grantQueueMs = Number(age)
          if (phases !== undefined) {
            timing.gatewaySamples += 1
            timing.gatewayHandlerBearerMs += phases[0]
            timing.gatewayAuthorityMs += phases[1]
            timing.gatewayTransactionMs += phases[2]
          }
          if (ingress !== undefined) {
            timing.gatewayIngressSamples += 1
            timing.gatewayIngressBearerMs += ingress[0]
            timing.gatewayWriteAdmissionMs += ingress[1]
          }
        }
      }
    }
  }
}

export default GatewayResourceBudget
