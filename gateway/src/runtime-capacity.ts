/** Node-local admission for managed Runtime processes; Agent and tool work have separate owners. @module */
import { performance } from 'node:perf_hooks'

/** Limits shared by every Runtime owned by one Gateway process. */
export interface RuntimeCapacityConfig {
  /** Maximum processes between cold-start admission and readiness. */
  maxStarting: number
  /** Optional emergency resident ceiling; zero disables it. Unconfirmed terminations remain counted. */
  maxResident: number
  /** Maximum distinct Runtime targets waiting for process capacity. */
  maxQueued: number
  /** Maximum queue wait before any process launch, in milliseconds. */
  maxQueueWaitMs: number
}

/** Admission failure before a Runtime starts. */
export class RuntimeCapacityError extends Error {
  readonly code = 'INSTANCE_CAPACITY'
  /** @param reason - queue rejection, deadline or lifecycle cancellation. */
  constructor(readonly reason: 'queue-full' | 'timeout' | 'cancelled' | 'closed') {
    super(`Runtime admission ${reason}`)
  }
}

/** One process reservation, retained until termination has completed. */
export interface RuntimeCapacityLease {
  /** Release the cold-start slot after readiness; retain the resident reservation. */
  ready(): void
  /** Release both reservations after failure or confirmed process termination. */
  release(): void
}

/** Successful construction confirms bounded admission; acquiring the process slot can still wait or fail. */
export interface RuntimeCapacityRequest {
  readonly lease: Promise<RuntimeCapacityLease>
}

/** Bounded observations; byte counts describe queued target identifiers, excluding caller-owned data. */
export interface RuntimeCapacitySnapshot {
  limits: RuntimeCapacityConfig
  resident: number
  starting: number
  queued: number
  queuedTargetBytes: number
  peakResident: number
  peakStarting: number
  peakQueued: number
  admitted: number
  rejected: number
  cancelled: number
  timedOut: number
  wait: { count: number; totalMs: number; maxMs: number; buckets: Array<{ leMs: number | null; count: number }> }
}

interface Waiter {
  key: string
  bytes: number
  since: number
  resolve(lease: RuntimeCapacityLease): void
  reject(error: RuntimeCapacityError): void
  cleanup(): void
}

const WAIT_BUCKETS_MS = [1, 10, 100, 1_000, 10_000, 30_000, Infinity]

/** FIFO admission by Runtime target, with bounded pending metadata and cancellable waits. */
export class RuntimeCapacity {
  private readonly residents = new Map<string, { starting: boolean }>()
  private readonly queue: Waiter[] = []
  private startingCount = 0
  private closed = false
  private peakResident = 0
  private peakStarting = 0
  private peakQueued = 0
  private admitted = 0
  private rejected = 0
  private cancelled = 0
  private timedOut = 0
  private waitCount = 0
  private waitTotalMs = 0
  private waitMaxMs = 0
  private readonly waitBuckets = WAIT_BUCKETS_MS.map(() => 0)

  /** @param config - validated deployment limits. */
  constructor(private readonly config: RuntimeCapacityConfig) {}

  /**
   * Reserve capacity before starting one previously stopped Runtime.
   * @param key - unique node-local Runtime target.
   * @param signal - cancellation owned by the start operation.
   * @returns a lease whose release follows process termination.
   */
  acquire(key: string, signal: AbortSignal): Promise<RuntimeCapacityLease> {
    try { return this.request(key, signal).lease } catch (error) { return Promise.reject(error) }
  }

  /**
   * Admit one target without waiting for a slot or process readiness.
   * @param key - unique node-local Runtime target.
   * @param signal - cancellation owned by the start operation.
   * @returns the admitted request; its lease resolves once process capacity is reserved.
   * @throws RuntimeCapacityError when the request cannot enter the bounded queue or reservation set.
   */
  request(key: string, signal: AbortSignal): RuntimeCapacityRequest {
    if (this.closed) throw new RuntimeCapacityError('closed')
    if (signal.aborted) throw new RuntimeCapacityError('cancelled')
    if (this.queue.length === 0 && this.canStart()) return { lease: Promise.resolve(this.reserve(key)) }
    if (this.queue.length >= this.config.maxQueued) {
      this.rejected += 1
      throw new RuntimeCapacityError('queue-full')
    }
    const lease = new Promise<RuntimeCapacityLease>((resolve, reject) => {
      const abort = (): void => this.remove(waiter, 'cancelled')
      const timer = setTimeout(() => this.remove(waiter, 'timeout'), this.config.maxQueueWaitMs)
      timer.unref?.()
      const waiter: Waiter = {
        key, bytes: Buffer.byteLength(key), since: performance.now(), resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort) },
      }
      this.queue.push(waiter)
      this.peakQueued = Math.max(this.peakQueued, this.queue.length)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    return { lease }
  }

  /**
   * Account for a supervisor-owned process surviving a Gateway restart.
   * Existing processes are counted even when they already exceed the configured limit.
   * @param key - durable Runtime target.
   * @returns its resident lease.
   */
  adopt(key: string): RuntimeCapacityLease {
    return this.reserve(key, false)
  }

  /** Reject queued starts; existing process reservations remain owned until released. */
  close(): void {
    this.closed = true
    for (const waiter of [...this.queue]) this.remove(waiter, 'closed')
  }

  /** @returns an isolated, constant-size observation of admission and cumulative waits. */
  snapshot(): RuntimeCapacitySnapshot {
    return {
      limits: { ...this.config }, resident: this.residents.size, starting: this.startingCount,
      queued: this.queue.length, queuedTargetBytes: this.queue.reduce((sum, item) => sum + item.bytes, 0),
      peakResident: this.peakResident, peakStarting: this.peakStarting, peakQueued: this.peakQueued,
      admitted: this.admitted, rejected: this.rejected, cancelled: this.cancelled, timedOut: this.timedOut,
      wait: {
        count: this.waitCount, totalMs: this.waitTotalMs, maxMs: this.waitMaxMs,
        buckets: WAIT_BUCKETS_MS.map((upper, index) => ({ leMs: Number.isFinite(upper) ? upper : null, count: this.waitBuckets[index]! })),
      },
    }
  }

  private canStart(): boolean {
    return (this.config.maxResident === 0 || this.residents.size < this.config.maxResident) && this.startingCount < this.config.maxStarting
  }

  private reserve(key: string, starting = true): RuntimeCapacityLease {
    if (this.residents.has(key)) throw new Error(`Runtime capacity already reserved: ${key}`)
    const entry = { starting }
    this.residents.set(key, entry)
    if (starting) this.startingCount += 1
    this.admitted += starting ? 1 : 0
    this.peakResident = Math.max(this.peakResident, this.residents.size)
    this.peakStarting = Math.max(this.peakStarting, this.startingCount)
    return {
      ready: () => {
        if (this.residents.get(key) !== entry) return
        if (entry.starting) this.startingCount -= 1
        entry.starting = false
        this.pump()
      },
      release: () => {
        if (this.residents.get(key) !== entry) return
        if (entry.starting) this.startingCount -= 1
        this.residents.delete(key)
        this.pump()
      },
    }
  }

  private observeWait(waiter: Waiter): void {
    const waited = Math.max(0, performance.now() - waiter.since)
    this.waitCount += 1
    this.waitTotalMs += waited
    this.waitMaxMs = Math.max(this.waitMaxMs, waited)
    WAIT_BUCKETS_MS.forEach((upper, index) => { if (waited <= upper) this.waitBuckets[index]! += 1 })
  }

  private remove(waiter: Waiter, reason: RuntimeCapacityError['reason']): void {
    const index = this.queue.indexOf(waiter)
    if (index === -1) return
    this.queue.splice(index, 1)
    waiter.cleanup()
    this.observeWait(waiter)
    if (reason === 'timeout') this.timedOut += 1
    else this.cancelled += 1
    waiter.reject(new RuntimeCapacityError(reason))
    this.pump()
  }

  private pump(): void {
    while (!this.closed && this.queue.length > 0 && this.canStart()) {
      const waiter = this.queue.shift()!
      waiter.cleanup()
      this.observeWait(waiter)
      waiter.resolve(this.reserve(waiter.key))
    }
  }
}
