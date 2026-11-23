/** Read-only Admin API client for live Gateway performance and multi-computer forwarding diagnostics. */
import { adminRequest } from './api.ts'

/** Cumulative duration histogram summary reported by GatewayPerformanceObserver. */
export interface DurationHistogramView {
  readonly count: number
  readonly sumMs: number
  readonly maxMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
}

/** Cumulative request counts and latency percentiles for one operation category. */
export interface RequestMetricsView {
  readonly started: number
  readonly completed: number
  readonly inflight: number
  readonly peakInflight: number
  readonly errors: number
  readonly clientErrors: number
  readonly aborted: number
  readonly durationMs: DurationHistogramView
}

/** Pooled HTTP transport counters reported by Center Gateway's NodeServiceHttpPool. */
export interface NodeForwardingPoolView {
  readonly reused: number
  readonly opened: number
  readonly queued: number
  readonly active: number
  readonly idle: number
  readonly waiting: number
  readonly closedIdleEntries: number
}

/** Multi-computer forwarding counters exposed by Center Gateway. */
export interface NodeForwardingDiagnosticsView {
  readonly httpTotal: number
  readonly upgradeTotal: number
  readonly accessSyncCalls: number
  readonly accessSyncSkipped: number
  readonly preparedReadEligible: number
  readonly preparedReadHit: number
  readonly preparedReadFallback: number
  readonly pool: NodeForwardingPoolView
}

/** Center remote `/plugins/*` LRU cache statistics. */
export interface RuntimeAssetCacheDiagnosticsView {
  readonly remoteCacheHits: number
  readonly remoteCacheMisses: number
  readonly remoteCacheEntries: number
  readonly remoteCacheBytes: number
}

/** PostgreSQL pool utilization snapshot, when backed by PostgreSQL. */
export interface DatabasePoolDiagnosticsView {
  readonly maxConnections?: number
  readonly active?: number
  readonly idle?: number
  readonly waiting?: number
  readonly maxWaiting?: number
  readonly checkoutErrors?: number
  readonly checkoutWaitMs?: { readonly p95Ms?: number; readonly maxMs?: number }
}

/** Complete JSON payload returned by `GET /admin/api/performance`. */
export interface PerformanceDiagnosticsSnapshot {
  readonly schemaVersion: number
  readonly enabled: boolean
  readonly disposed: boolean
  readonly measurement: {
    readonly kind: string
    readonly startedAtUnixMs: number
    readonly endedAtUnixMs: number
    readonly elapsedMs: number
  }
  readonly requests: RequestMetricsView
  readonly operationClasses: {
    readonly http: RequestMetricsView
    readonly websocket: RequestMetricsView
    readonly internal: RequestMetricsView
  }
  readonly readySession: {
    readonly forwarded: Readonly<Record<string, number>>
    readonly ordinary: Readonly<Record<string, number>>
  }
  readonly eventLoop: {
    readonly samples: number
    readonly meanMs: number
    readonly maxMs: number
    readonly p50Ms: number
    readonly p95Ms: number
    readonly p99Ms: number
    readonly utilization: number
  }
  readonly memory: {
    readonly rss: number
    readonly heapUsed: number
    readonly heapTotal: number
  }
  readonly databasePool: DatabasePoolDiagnosticsView | null
  readonly nodeForwarding: NodeForwardingDiagnosticsView | null
  readonly runtimeAssets: RuntimeAssetCacheDiagnosticsView | null
}

/**
 * Fetch live performance, event-loop, connection-pool, and remote-asset cache metrics
 * from the currently selected computer's Gateway.
 * @param signal - caller cancellation signal.
 * @returns cumulative process diagnostics snapshot.
 */
export async function getPerformanceDiagnostics(signal?: AbortSignal): Promise<PerformanceDiagnosticsSnapshot> {
  return await adminRequest<PerformanceDiagnosticsSnapshot>('/admin/api/performance', {
    cache: 'no-store',
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
}
