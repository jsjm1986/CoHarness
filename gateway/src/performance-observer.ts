/** Process-local request and event-loop diagnostics without request identifiers or retained samples. */
import type { ServerResponse } from 'node:http'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'

const DURATION_BOUNDS_MS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000] as const
const noop = (): void => {}

/** Fixed operation categories keep long-lived streams separate from ordinary HTTP response times. */
export type GatewayOperationClass = 'http' | 'websocket' | 'internal'

/** Explicit process-observation settings supplied by the Gateway entry. */
export interface GatewayPerformanceOptions {
  readonly enabled: boolean
  /** Sampling resolution in milliseconds for Node's event-loop delay histogram. */
  readonly eventLoopResolutionMs: number
}

/** Lifetime request durations; percentiles are histogram upper-bound estimates. */
export interface GatewayDurationHistogram {
  readonly count: number
  readonly sumMs: number
  readonly maxMs: number
  readonly overflow: number
  readonly percentileMethod: 'bucket-upper-bound'
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  /** Non-cumulative counts; null identifies the overflow bucket above 60 seconds. */
  readonly buckets: readonly { readonly upperBoundMs: number | null; readonly count: number }[]
}

/** Cumulative counts for one fixed category or the aggregate across all categories. */
export interface GatewayRequestMetrics {
  readonly started: number
  readonly completed: number
  readonly inflight: number
  readonly peakInflight: number
  /** Responses with 5xx status or an aborted response. */
  readonly errors: number
  readonly clientErrors: number
  readonly aborted: number
  readonly durationMs: GatewayDurationHistogram
}

class RequestMetrics {
  private readonly buckets = Array<number>(DURATION_BOUNDS_MS.length + 1).fill(0)
  started = 0
  completed = 0
  inflight = 0
  peakInflight = 0
  errors = 0
  clientErrors = 0
  aborted = 0
  private durationSum = 0
  private durationMax = 0

  start(): void {
    this.started += 1
    this.inflight += 1
    this.peakInflight = Math.max(this.peakInflight, this.inflight)
  }

  finish(duration: number, statusCode: number, aborted: boolean): void {
    this.inflight -= 1
    this.completed += 1
    if (aborted || statusCode >= 500) this.errors += 1
    if (statusCode >= 400 && statusCode < 500) this.clientErrors += 1
    if (aborted) this.aborted += 1
    const index = DURATION_BOUNDS_MS.findIndex(bound => duration <= bound)
    const bucket = index === -1 ? DURATION_BOUNDS_MS.length : index
    this.buckets[bucket] = this.buckets[bucket]! + 1
    this.durationSum += duration
    this.durationMax = Math.max(this.durationMax, duration)
  }

  snapshot(): GatewayRequestMetrics {
    return {
      started: this.started, completed: this.completed, inflight: this.inflight,
      peakInflight: this.peakInflight, errors: this.errors, clientErrors: this.clientErrors, aborted: this.aborted,
      durationMs: {
        count: this.completed, sumMs: this.durationSum, maxMs: this.durationMax,
        overflow: this.buckets[DURATION_BOUNDS_MS.length]!, percentileMethod: 'bucket-upper-bound',
        p50Ms: this.percentile(0.5), p95Ms: this.percentile(0.95), p99Ms: this.percentile(0.99),
        buckets: this.buckets.map((count, index) => ({ upperBoundMs: DURATION_BOUNDS_MS[index] ?? null, count })),
      },
    }
  }

  private percentile(fraction: number): number {
    if (this.completed === 0) return 0
    const rank = Math.ceil(this.completed * fraction)
    let count = 0
    for (const [index, value] of this.buckets.entries()) {
      count += value
      if (count >= rank) return DURATION_BOUNDS_MS[index] ?? this.durationMax
    }
    return this.durationMax
  }
}

/** Cumulative process diagnostics; runtime capacity belongs to its external owner. */
export interface GatewayPerformanceSnapshot<Capacity> {
  readonly schemaVersion: 1
  readonly enabled: boolean
  readonly disposed: boolean
  readonly measurement: {
    readonly kind: 'cumulative'
    readonly startedAtUnixMs: number
    /** Wall-clock anchor plus monotonic elapsed time; frozen after disposal. */
    readonly endedAtUnixMs: number
    readonly elapsedMs: number
  }
  readonly requests: GatewayRequestMetrics
  readonly operationClasses: Readonly<Record<GatewayOperationClass, GatewayRequestMetrics>>
  readonly eventLoop: {
    /** Delay samples since construction; zero until Node collects its first sample. */
    readonly samples: number
    readonly meanMs: number
    readonly maxMs: number
    readonly p50Ms: number
    readonly p95Ms: number
    readonly p99Ms: number
    /** Utilization since construction; zero when observation is disabled. */
    readonly utilization: number
  }
  readonly memory: NodeJS.MemoryUsage
  readonly runtimeCapacity: Capacity
}

/** Owns bounded histograms and response listeners; it creates no reporting timer or HTTP route. */
export class GatewayPerformanceObserver {
  private readonly startedAt = performance.now()
  private readonly startedAtUnixMs = Date.now()
  private readonly utilizationBaseline = performance.eventLoopUtilization()
  private readonly delay: ReturnType<typeof monitorEventLoopDelay> | undefined
  private readonly requests = new RequestMetrics()
  private readonly operationClasses: Record<GatewayOperationClass, RequestMetrics> = {
    http: new RequestMetrics(), websocket: new RequestMetrics(), internal: new RequestMetrics(),
  }
  private readonly responseCleanups = new Set<() => void>()
  private endedAt: number | undefined
  private endedUtilization: number | undefined

  /**
   * Start the native event-loop sampler when enabled.
   * @param options - Deployment settings; resolution must be an integer from 1 to 2,147,483,647 ms.
   */
  constructor(private readonly options: GatewayPerformanceOptions) {
    if (!Number.isSafeInteger(options.eventLoopResolutionMs) || options.eventLoopResolutionMs <= 0
      || options.eventLoopResolutionMs > 2_147_483_647) {
      throw new RangeError('eventLoopResolutionMs must be an integer from 1 to 2147483647')
    }
    if (options.enabled) {
      this.delay = monitorEventLoopDelay({ resolution: options.eventLoopResolutionMs })
      this.delay.enable()
    }
  }

  /**
   * Count one request through its response settlement; repeated or post-disposal completions do nothing.
   * @param operationClass - Fixed category; callers classify protocol streaming separately from ordinary HTTP.
   * @returns Completion callback receiving HTTP status and whether the response was interrupted.
   */
  beginRequest(operationClass: GatewayOperationClass = 'http'): (statusCode: number, aborted?: boolean) => void {
    if (!this.options.enabled || this.endedAt !== undefined) return noop
    const start = performance.now()
    const category = this.operationClasses[operationClass]
    this.requests.start()
    category.start()
    let completed = false
    return (statusCode, aborted = false) => {
      if (completed || this.endedAt !== undefined) return
      completed = true
      const duration = Math.max(0, performance.now() - start)
      this.requests.finish(duration, statusCode, aborted)
      category.finish(duration, statusCode, aborted)
    }
  }

  /**
   * Observe the complete HTTP response, including streamed bytes and disconnects.
   * @param response - Response admitted at the start of the server's request callback.
   * @param operationClass - Fixed category selected from the protocol route, never a request identifier.
   */
  observeResponse(response: ServerResponse, operationClass: GatewayOperationClass = 'http'): void {
    if (!this.options.enabled || this.endedAt !== undefined) return
    const finish = this.beginRequest(operationClass)
    const cleanup = (): void => {
      response.off('finish', settle)
      response.off('close', settle)
      this.responseCleanups.delete(cleanup)
    }
    const settle = (): void => {
      cleanup()
      finish(response.statusCode, !response.writableFinished)
    }
    this.responseCleanups.add(cleanup)
    response.once('finish', settle)
    response.once('close', settle)
  }

  /**
   * Read cumulative diagnostics without resetting the histogram or retaining the supplied capacity value.
   * @param runtimeCapacity - Snapshot supplied by the runtime-capacity owner; no identifiers are added here.
   * @returns Request, process and externally supplied capacity measurements.
   */
  snapshot<Capacity>(runtimeCapacity: Capacity): GatewayPerformanceSnapshot<Capacity> {
    const delay = this.delay
    const samples = delay?.count ?? 0
    const measured = samples > 0 && delay !== undefined
    const elapsedMs = (this.endedAt ?? performance.now()) - this.startedAt
    return {
      schemaVersion: 1,
      enabled: this.options.enabled,
      disposed: this.endedAt !== undefined,
      measurement: {
        kind: 'cumulative', startedAtUnixMs: this.startedAtUnixMs,
        endedAtUnixMs: this.startedAtUnixMs + elapsedMs, elapsedMs,
      },
      requests: this.requests.snapshot(),
      operationClasses: {
        http: this.operationClasses.http.snapshot(), websocket: this.operationClasses.websocket.snapshot(),
        internal: this.operationClasses.internal.snapshot(),
      },
      eventLoop: {
        samples, meanMs: measured ? delay.mean / 1e6 : 0, maxMs: measured ? delay.max / 1e6 : 0,
        p50Ms: measured ? delay.percentile(50) / 1e6 : 0,
        p95Ms: measured ? delay.percentile(95) / 1e6 : 0,
        p99Ms: measured ? delay.percentile(99) / 1e6 : 0,
        utilization: this.utilization(),
      },
      memory: process.memoryUsage(), runtimeCapacity,
    }
  }

  /** Stop sampling and detach pending response listeners; late completions cannot change request counts. */
  dispose(): void {
    if (this.endedAt !== undefined) return
    this.endedAt = performance.now()
    this.endedUtilization = this.utilization()
    this.delay?.disable()
    for (const cleanup of this.responseCleanups) cleanup()
  }

  private utilization(): number {
    return this.endedUtilization
      ?? (this.options.enabled ? performance.eventLoopUtilization(this.utilizationBaseline).utilization : 0)
  }
}
