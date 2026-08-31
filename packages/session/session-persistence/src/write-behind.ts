/**
 * Bounded per-session write batching for the shared persistence coordinator.
 * @module @deepseek-ai/dsh-session-persistence/write-behind
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Dependencies and scheduling policy for one live session's write controller. */
export interface SessionWriteBehindOptions {
  /** Maximum intentional batching wait after an idle queue receives work. */
  readonly maxDelayMs: number
  /** Maximum events retained across the pending queue and active write. */
  readonly maxPendingEvents?: number
  /** Maximum UTF-8 JSON bytes retained across the pending queue and active write. */
  readonly maxPendingBytes?: number
  /** Persist one stable ordered prefix; resolves only after backend durability. */
  readonly write: (events: readonly SessionEvent[]) => Promise<void>
  /** Observe a detached background write failure without rejecting the producer. */
  readonly reportBackgroundFailure: (error: unknown) => void
}

/** Default pending-event bound for one live session controller. */
export const DEFAULT_MAX_PENDING_EVENTS = 100_000
/** Default UTF-8 byte bound for one live session's pending write queue. */
export const DEFAULT_MAX_PENDING_BYTES = 64 * 1024 * 1024

function serializedBytes(event: SessionEvent): number {
  const encoded = JSON.stringify(event)
  return Buffer.byteLength(encoded, 'utf8')
}

/**
 * Owns one live session's pending events, fixed batching deadline, active write,
 * failure retention, and explicit quiescence barrier.
 */
export class SessionWriteBehind {
  private pending: SessionEvent[] = []
  private pendingBytes = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: Promise<void> | undefined
  private activeBatchSize = 0
  private activeBatchBytes = 0
  private barrier: Promise<void> | undefined
  private deadlineExpired = false
  private automaticPaused = false

  /**
   * @param options - fixed scheduling policy and durable batch sink.
   */
  private readonly maxPendingEvents: number
  private readonly maxPendingBytes: number

  constructor(private readonly options: SessionWriteBehindOptions) {
    const maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS
    if (!Number.isSafeInteger(maxPendingEvents) || maxPendingEvents < 1) {
      throw new TypeError('maxPendingEvents must be a positive safe integer')
    }
    this.maxPendingEvents = maxPendingEvents
    const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
    if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < 1) {
      throw new TypeError('maxPendingBytes must be a positive safe integer')
    }
    this.maxPendingBytes = maxPendingBytes
  }

  /** Whether this controller owns queued events or an active durable write. */
  get hasWork(): boolean {
    return this.pending.length > 0 || this.active !== undefined
  }

  /**
   * Copy one event into the persistence-owned queue and start a fixed deadline
   * when the automatic path is idle.
  * @param event - frozen live event to retain independently of its producer.
  */
  enqueue(event: SessionEvent): void {
    // Measure before cloning so an event that cannot fit is rejected without
    // first allocating another copy of a potentially very large payload.
    const eventBytes = serializedBytes(event)
    if (this.pending.length + this.activeBatchSize >= this.maxPendingEvents) {
      const error = new Error(`session write-behind pending-event limit exceeded (${String(this.maxPendingEvents)})`)
      this.options.reportBackgroundFailure(error)
      throw error
    }
    const available = this.maxPendingBytes - this.pendingBytes - this.activeBatchBytes
    if (eventBytes > available) {
      const error = new Error(`session write-behind pending-byte limit exceeded (${String(this.maxPendingBytes)})`)
      this.options.reportBackgroundFailure(error)
      throw error
    }
    const retained = structuredClone(event)
    const wasEmpty = this.pending.length === 0
    this.pending.push(retained)
    this.pendingBytes += eventBytes
    if (this.barrier !== undefined) return
    if (this.automaticPaused) {
      this.automaticPaused = false
      this.deadlineExpired = false
      this.armTimer()
    } else if (wasEmpty) {
      this.armTimer()
    }
  }

  /**
   * Cancel the batching wait and durably drain through a quiescent point.
   * Concurrent callers join the same barrier.
   * @returns a promise that rejects if the barrier's durable retry fails.
   */
  flush(): Promise<void> {
    if (this.barrier !== undefined) return this.barrier
    this.cancelTimer()
    this.deadlineExpired = false
    this.automaticPaused = false
    const barrier = Promise.withResolvers<void>()
    this.barrier = barrier.promise
    void this.drainBarrier(barrier.resolve, barrier.reject)
    return barrier.promise
  }

  /** Cancel the current automatic deadline without draining retained work. */
  cancelAutomaticWait(): void {
    this.cancelTimer()
    this.deadlineExpired = false
  }

  /** Start the one fixed window for the current pending prefix. */
  private armTimer(): void {
    this.timer = setTimeout(() => { this.onDeadline() }, this.options.maxDelayMs)
  }

  /** Cancel any pending automatic deadline. */
  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Start a background write now, or remember that an active write used the budget. */
  private onDeadline(): void {
    this.timer = undefined
    if (this.active !== undefined) {
      this.deadlineExpired = true
      return
    }
    this.startBackground()
  }

  /** Start one detached write whose failure is reported and retained. */
  private startBackground(): void {
    const active = this.startWrite(true)
    void active.then(() => { this.continueAutomatic() }, () => {})
  }

  /** Continue immediately after an over-budget active write, otherwise keep its timer. */
  private continueAutomatic(): void {
    if (this.barrier !== undefined || this.pending.length === 0) return
    if (this.deadlineExpired) {
      this.deadlineExpired = false
      this.startBackground()
    }
  }

  /** Await overlapping work, drain to quiescence, and settle the shared barrier. */
  private async drainBarrier(resolve: () => void, reject: (reason?: unknown) => void): Promise<void> {
    try {
      const overlapping = this.active
      if (overlapping !== undefined) {
        await Promise.allSettled([overlapping])
        this.automaticPaused = false
      }
      while (this.pending.length > 0) await this.startWrite(false)
    } catch (error: unknown) {
      this.barrier = undefined
      reject(error)
      return
    }
    // Close admission to this barrier in the same job that observes the empty
    // queue, before resolving callers. A later enqueue therefore starts its own
    // automatic window instead of being stranded behind a settled barrier.
    this.barrier = undefined
    resolve()
  }

  /** Start one stable pending prefix, retaining it in order if durability fails. */
  private startWrite(background: boolean): Promise<void> {
    const batch = this.pending.splice(0)
    const batchBytes = this.pendingBytes
    this.pendingBytes = 0
    this.activeBatchSize = batch.length
    this.activeBatchBytes = batchBytes
    this.cancelTimer()
    this.deadlineExpired = false
    const operation = Promise.resolve().then(() => this.options.write(batch))
    const active = operation
      .catch((error: unknown) => {
        this.pending = batch.concat(this.pending)
        this.pendingBytes = batchBytes + this.pendingBytes
        this.cancelTimer()
        this.deadlineExpired = false
        this.automaticPaused = true
        this.activeBatchSize = 0
        this.activeBatchBytes = 0
        if (background) this.options.reportBackgroundFailure(error)
        throw error
      })
      .finally(() => {
        this.activeBatchSize = 0
        this.activeBatchBytes = 0
        this.active = undefined
      })
    this.active = active
    return active
  }
}
