/** Runtime-local batching and deadlines for registered event connections. */
import type { GatewayPrincipalClaims, GatewayRequestPrincipal } from './index.ts'

/** Deployment-owned private renewal pacing; signed expiry always remains authoritative. */
export interface StreamPrincipalRenewalConfig {
  enabled: true
  intervalMs: number
  requestTimeoutMs: number
  maxBatchSize: number
}

interface Lease {
  id: string
  initialIdentity: string
  current: GatewayRequestPrincipal
  lifetime: AbortController
  source: AbortSignal
  release: () => void
  timer: ReturnType<typeof setTimeout> | undefined
  renewAt: number
}

function identity(claims: GatewayPrincipalClaims): string {
  return JSON.stringify([claims.organization, claims.user, claims.scope, claims.runtime, claims.purpose ?? null])
}

/** Cancel the wait even if a transport adapter settles after its owned deadline. */
function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const failure = (): Error => signal.reason instanceof Error ? signal.reason
    : new Error('Gateway event connection renewal cancelled', { cause: signal.reason })
  if (signal.aborted) { void operation.catch(() => {}); return Promise.reject(failure()) }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => { signal.removeEventListener('abort', abort); reject(failure()) }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then((value) => { signal.removeEventListener('abort', abort); resolve(value) }, (error: unknown) => {
      signal.removeEventListener('abort', abort)
      reject(error instanceof Error ? error : new Error('Gateway event connection renewal failed', { cause: error }))
    })
  })
}

/** One service-owned pool; storage follows live sockets and at most one bounded request. */
export class StreamPrincipalLeasePool {
  private readonly leases = new Map<string, Lease>()
  private readonly lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private flight: Promise<void> | undefined

  /**
   * @param options - validated pacing, private transport, signature verifier and bounded diagnostic owner.
   */
  constructor(private readonly options: {
    config: StreamPrincipalRenewalConfig
    renew: (leaseIds: readonly string[], signal: AbortSignal) => Promise<unknown>
    verify: (assertion: string) => GatewayPrincipalClaims
    reportUnavailable: () => void
  }) {}

  /**
   * Retain an updatable principal only for one explicitly owned event socket.
   * @param principal - verified initial browser assertion, whose nonce identifies the Gateway registration.
   * @param source - socket close/error signal; closing cannot be undone by a late renewal.
   * @returns a principal handle that exposes only verified replacements and its finite lifetime.
   */
  open(principal: GatewayRequestPrincipal, source: AbortSignal): GatewayRequestPrincipal {
    this.lifetime.signal.throwIfAborted()
    if (principal.claims.purpose !== undefined || principal.claims.expiresAt - principal.claims.issuedAt > 30_000) {
      throw new Error('event connection requires a short-lived browser principal')
    }
    if (this.leases.has(principal.claims.nonce)) throw new Error('event connection principal nonce is already open')
    const lease: Lease = {
      id: principal.claims.nonce, initialIdentity: identity(principal.claims), current: principal,
      lifetime: new AbortController(), source, timer: undefined, renewAt: 0,
      release: () => {
        clearTimeout(lease.timer)
        source.removeEventListener('abort', lease.release)
        if (this.leases.get(lease.id) === lease) this.leases.delete(lease.id)
        lease.lifetime.abort(new Error('Gateway event connection authority ended'))
        this.schedule()
      },
    }
    this.leases.set(lease.id, lease)
    source.addEventListener('abort', lease.release, { once: true })
    if (source.aborted || principal.claims.expiresAt <= Date.now()) lease.release()
    else { this.arm(lease); this.schedule() }
    return {
      get assertion() { return lease.current.assertion },
      get claims() { return lease.current.claims },
      signal: lease.lifetime.signal,
    }
  }

  /**
   * Cancel sockets, timers and transport, then join the one in-flight batch.
   * @returns completion after transport cancellation and all socket authority has ended.
   */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Gateway runtime principal renewal stopped'))
    clearTimeout(this.timer)
    for (const lease of [...this.leases.values()]) lease.release()
    await this.flight
  }

  /**
   * Count live event-socket registrations without principal identifiers.
   * @returns the number of still-owned sockets.
   */
  get size(): number { return this.leases.size }

  private arm(lease: Lease): void {
    clearTimeout(lease.timer)
    const remaining = lease.current.claims.expiresAt - Date.now()
    lease.renewAt = Date.now() + Math.min(this.options.config.intervalMs, Math.max(1, Math.floor(remaining / 2)))
    lease.timer = setTimeout(lease.release, Math.max(0, remaining))
    lease.timer.unref()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (this.lifetime.signal.aborted || this.flight !== undefined || this.leases.size === 0) return
    let at = Number.POSITIVE_INFINITY
    for (const lease of this.leases.values()) at = Math.min(at, lease.renewAt)
    this.timer = setTimeout(() => { this.startBatch() }, Math.max(1, at - Date.now()))
    this.timer.unref()
  }

  private startBatch(): void {
    this.timer = undefined
    if (this.lifetime.signal.aborted || this.flight !== undefined) return
    const batch: Lease[] = []
    for (const lease of this.leases.values()) {
      if (lease.renewAt <= Date.now()) batch.push(lease)
      if (batch.length === this.options.config.maxBatchSize) break
    }
    if (batch.length === 0) { this.schedule(); return }
    for (const lease of batch) lease.renewAt = lease.current.claims.expiresAt
    const pending = this.refresh(batch)
    this.flight = pending
    void pending.finally(() => {
      if (this.flight === pending) this.flight = undefined
      this.schedule()
    }).catch(() => { this.options.reportUnavailable() })
  }

  private async refresh(batch: readonly Lease[]): Promise<void> {
    const deadline = new AbortController()
    const remaining = Math.min(...batch.map(lease => lease.current.claims.expiresAt - Date.now()))
    const timeout = setTimeout(() => { deadline.abort(new Error('Gateway event connection renewal timed out')) },
      Math.max(1, Math.min(remaining, this.options.config.requestTimeoutMs)))
    timeout.unref()
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal])
    let value: unknown
    let transport: Promise<unknown> | undefined
    try {
      transport = this.options.renew(batch.map(lease => lease.id), signal)
      value = await cancellable(transport, signal)
    } catch {
      // A transport failure grants no additional time. Each previous signed
      // deadline remains armed; reconnect performs fresh admission after it.
      if (!this.lifetime.signal.aborted) this.options.reportUnavailable()
      return
    } finally {
      clearTimeout(timeout)
      // Cancellation retires authority immediately; the owner still joins
      // the actual transport and body reader before another batch or disposal.
      await transport?.catch(() => {})
    }
    if (this.lifetime.signal.aborted) return
    const reply = value as { version?: unknown; leases?: unknown } | null
    if (reply === null || typeof reply !== 'object' || reply.version !== 1 || !Array.isArray(reply.leases)
      || reply.leases.length !== batch.length) { this.reject(batch); return }
    const requested = new Set(batch.map(lease => lease.id))
    const updates = new Map<string, { status: 'denied' } | { status: 'renewed'; assertion: string }>()
    for (const item of reply.leases as unknown[]) {
      const update = item as { leaseId?: unknown; status?: unknown; assertion?: unknown } | null
      if (update === null || typeof update !== 'object' || typeof update.leaseId !== 'string'
        || updates.has(update.leaseId) || !requested.has(update.leaseId)
        || (update.status !== 'denied' && (update.status !== 'renewed' || typeof update.assertion !== 'string'))) {
        this.reject(batch); return
      }
      updates.set(update.leaseId, update.status === 'denied' ? { status: 'denied' }
        : { status: 'renewed', assertion: update.assertion as string })
    }
    for (const lease of batch) {
      if (this.leases.get(lease.id) !== lease || lease.lifetime.signal.aborted) continue
      if (lease.current.claims.expiresAt <= Date.now()) { lease.release(); continue }
      const update = updates.get(lease.id)
      if (update === undefined || update.status === 'denied') { lease.release(); continue }
      let claims: GatewayPrincipalClaims
      try {
        claims = this.options.verify(update.assertion)
        if (identity(claims) !== lease.initialIdentity || claims.purpose !== undefined
          || claims.expiresAt - claims.issuedAt > 30_000 || claims.expiresAt <= lease.current.claims.expiresAt
          || claims.issuedAt < lease.current.claims.issuedAt || claims.nonce === lease.current.claims.nonce) {
          throw new Error('Gateway event connection renewal changed its authority or freshness')
        }
      } catch { lease.release(); this.options.reportUnavailable(); continue }
      lease.current = { assertion: update.assertion, claims }
      this.arm(lease)
    }
  }

  private reject(batch: readonly Lease[]): void {
    for (const lease of batch) if (this.leases.get(lease.id) === lease) lease.release()
    this.options.reportUnavailable()
  }
}
