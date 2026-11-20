/** Durable, organization-scoped access revocation delivery between Gateways. @module */

import type { Pool, PoolClient } from 'pg'
import { errorCodeForDiagnostics } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'

/** Traffic affected by an access change; an empty subject invalidates the organization. */
export interface AccessInvalidationSubject {
  /** Omitted for organization-wide changes; present changes affect only this computer. */
  nodeId?: RuntimeNodeId
  userId?: number
  projectId?: number
  /** Directory projections or runtime ownership changed and require a fresh process. */
  restartRuntime?: boolean
}

/** Admission catches up with durable changes; subscribers also receive live revocations. */
export interface GatewayAccessMonitor {
  /** Initial/reconnect catch-up and disconnect cleanup have settled; fresh admission still calls synchronize. */
  readonly available: boolean
  /** Read committed changes before admitting a runtime operation. */
  synchronize(): Promise<void>
  /**
   * Apply a revision supplied by this request's fresh governance query without rereading an already applied revision.
   * Omitted by adapters that cannot prove revision identity; those adapters cannot admit the optimized asset path.
   * @param revision - authorization revision read with the current request's account and Runtime checks.
   * @returns true only while the connected monitor has applied exactly that revision; a newer revision requires a new admission.
   */
  synchronizeTo?(revision: bigint): Promise<boolean>
  /** Register cancellation/projection work, awaited before its revision is acknowledged. */
  subscribe(listener: (subject: AccessInvalidationSubject) => void | Promise<void>): () => void
}

/**
 * Bind local process, file and execution consumers to their computer while retaining global revocations.
 * @param monitor - organization-owned monitor; cross-computer forwarding keeps this original monitor.
 * @param nodeId - computer whose local consumers receive qualification changes.
 * @returns a subscriber adapter; synchronization and lifecycle remain owned by the original monitor.
 */
export function scopeAccessMonitor(monitor: GatewayAccessMonitor, nodeId: RuntimeNodeId): GatewayAccessMonitor {
  return {
    get available() { return monitor.available },
    synchronize: () => monitor.synchronize(),
    ...(monitor.synchronizeTo === undefined ? {} : { synchronizeTo: (revision: bigint) => monitor.synchronizeTo!(revision) }),
    subscribe: listener => monitor.subscribe(subject => subject.nodeId === undefined || subject.nodeId === nodeId ? listener(subject) : undefined),
  }
}

function subjects(value: unknown): AccessInvalidationSubject[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('invalid access invalidation subjects')
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('invalid access invalidation subject')
    const row = item as Record<string, unknown>
    for (const [key, entry] of Object.entries(row)) {
      if (key === 'nodeId' && typeof entry === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(entry)) continue
      if (key === 'restartRuntime' && typeof entry === 'boolean') continue
      if ((key === 'userId' || key === 'projectId') && typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0) continue
      throw new Error('invalid access invalidation subject field')
    }
    if (row.restartRuntime === true && row.userId === undefined && row.projectId === undefined) {
      throw new Error('runtime invalidation requires an owner')
    }
    return row as AccessInvalidationSubject
  })
}

/** LISTEN wakes an ordered outbox reader; disconnects cancel admitted traffic immediately. */
export class PostgresAccessMonitor implements GatewayAccessMonitor {
  private readonly listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
  private client: PoolClient | undefined
  private cursor: bigint | undefined
  private flight: { observed: Promise<void>; applied: Promise<void> } | undefined
  private applying: { through: bigint; fenced: boolean } | undefined
  private followUpRead: Promise<boolean> | undefined
  private wakePending = false
  private waking: Promise<void> | undefined
  private cancellations: Promise<void> = Promise.resolve()
  private cancelling = false
  private readonly timer: NodeJS.Timeout
  private closed = false
  private unavailable = false
  private caughtUp = false

  /**
   * Construct the monitor; call synchronize before accepting traffic.
   * @param context - database and organization owned by this Gateway
   * @param pollMs - fallback interval for a lost notification and reconnect attempts
   * @param listenerPool - reserved listener and outbox connection pool. Omission uses the injected context pool.
   */
  constructor(private readonly context: PostgresRuntimeContext, pollMs: number,
    private readonly listenerPool: Pool = context.pool) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 2_147_483_647) throw new Error('invalid access invalidation poll interval')
    this.timer = setInterval(() => { this.wake() }, pollMs)
    this.timer.unref()
  }

  get available(): boolean {
    return this.caughtUp && this.client !== undefined && !this.closed && !this.cancelling && !this.unavailable
  }

  /**
   * Add an owner of admitted traffic or runtime projections.
   * @param listener - idempotent work performed before advancing the local cursor
   * @returns disposer for the subscription
   */
  subscribe(listener: (subject: AccessInvalidationSubject) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Observe a database snapshot taken after this call, including missed notifications.
   * @returns completion after all observed invalidations have been applied
   */
  synchronize(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('access monitor is closed'))
    const pending = this.flight?.applied
    // Calls arriving during a read share the next read, whose snapshot cannot
    // precede their admission. Continued traffic cannot postpone earlier callers.
    return pending === undefined ? this.readFresh().applied : pending.then(() => this.readFresh().applied)
  }

  /**
   * Verify that the listener can observe committed changes and dispatch cancellation.
   * @returns after observation or fencing of newer traffic, independently of Runtime and projection cleanup.
   */
  async checkControlReadiness(): Promise<void> {
    if (this.closed) throw new Error('access monitor is closed')
    const followUp = this.checkPendingApplication()
    if (followUp === undefined) await this.readFresh().observed
    else if (!await followUp) throw new Error('access invalidation listener could not observe current revision')
    if (this.client === undefined) throw new Error('access invalidation listener disconnected')
  }

  /**
   * Catch up to a fresh authorization snapshot; a newer local revision invalidates that snapshot.
   * @param revision - revision returned by the request's governance admission.
   * @returns whether the connected monitor and the admission still describe the same revision.
   */
  async synchronizeTo(revision: bigint): Promise<boolean> {
    if (!this.available || this.cursor === undefined || this.cursor < revision) await this.synchronize()
    return this.available && this.cursor === revision
  }

  private readFresh(): NonNullable<PostgresAccessMonitor['flight']> {
    if (this.closed) throw new Error('access monitor is closed')
    if (this.flight !== undefined) return this.flight
    let observe!: () => void
    let rejectObservation!: (error: unknown) => void
    const observed = new Promise<void>((resolve, reject) => {
      observe = resolve
      rejectObservation = reject
    })
    const applied = this.drain(observe).catch((error: unknown) => {
      this.reportFailure(error)
      this.disconnect()
      rejectObservation(error)
      throw error
    }).finally(() => { this.flight = undefined })
    void observed.catch(() => { /* Admission callers can await only application. */ })
    void applied.catch(() => { /* Readiness callers can await only observation. */ })
    return this.flight = { observed, applied }
  }

  /** Stop reconnect attempts, release the dedicated listener, and await in-flight work. */
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.disconnect()
    await this.flight?.applied.catch(() => { /* shutdown already closed traffic and the database listener */ })
    await this.followUpRead
    await this.waking
    await this.cancellations
  }

  private wake(): void {
    if (this.closed || this.listeners.size === 0) return
    if (this.applying?.fenced !== true) this.checkPendingApplication()
    this.wakePending = true
    this.waking ??= Promise.resolve().then(async () => {
      try {
        while (this.wakePending && !this.closed) {
          this.wakePending = false
          await this.synchronize().catch(() => {
            // The failed read closed traffic. A later wake can reconnect.
          })
        }
      } finally {
        this.waking = undefined
      }
    })
  }

  private checkPendingApplication(): Promise<boolean> | undefined {
    const application = this.applying, client = this.client
    if (application === undefined || client === undefined) return
    return this.followUpRead ??= Promise.resolve().then(async () => {
      try {
        const current = await client.query<{ access_revision: string }>(
          "SELECT access_revision::text FROM harness.organizations WHERE id=$1 AND status='active'",
          [this.context.organizationId],
        )
        if (this.closed || this.client !== client) return false
        const revision = current.rows[0]
        if (revision === undefined || BigInt(revision.access_revision) < application.through) {
          throw new Error('access invalidation authority changed while applying a revision')
        }
        if (this.applying !== application || application.fenced || BigInt(revision.access_revision) === application.through) return true
        // A later committed revocation must stop admitted traffic even while
        // physical Runtime cleanup for an earlier revision is still waiting.
        application.fenced = true
        this.caughtUp = false
        this.cancelAdmitted()
        return true
      } catch (error) {
        if (!this.closed && this.client === client) {
          this.reportFailure(error)
          this.disconnect()
        }
        return false
      } finally {
        this.followUpRead = undefined
      }
    })
  }

  private reportFailure(error: unknown): void {
    if (this.unavailable || this.closed) return
    this.unavailable = true
    console.error(`[gateway] access invalidation unavailable (${errorCodeForDiagnostics(error)})`)
  }

  private async notify(subjects: readonly AccessInvalidationSubject[]): Promise<void> {
    // Every transport sees cancellation before a slow runtime stop is awaited.
    const listeners = [...this.listeners]
    const settled = await Promise.allSettled(subjects.flatMap(subject =>
      listeners.map(async listener => { await listener(subject) })))
    const errors: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'access invalidation did not settle')
  }

  private disconnect(): void {
    this.caughtUp = false
    const client = this.client
    this.client = undefined
    if (client !== undefined) client.release(true)
    this.cancelAdmitted()
  }

  private cancelAdmitted(): void {
    if (this.cancelling) return
    this.cancelling = true
    const pending = (async () => {
      const settled = await Promise.allSettled([this.cancellations, this.notify([{}])])
      const failed = settled.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
    this.cancellations = pending
    void pending.finally(() => {
      if (this.cancellations === pending) this.cancelling = false
    }).catch((error: unknown) => { this.reportFailure(error) })
  }

  private async connection(): Promise<PoolClient> {
    await this.cancellations
    if (this.closed) throw new Error('access monitor is closed')
    if (this.client !== undefined) return this.client
    const client = await this.listenerPool.connect()
    if (this.closed) {
      client.release(true)
      throw new Error('access monitor is closed')
    }
    this.client = client
    client.on('error', (error: unknown) => {
      if (this.client === client) {
        this.reportFailure(error)
        this.disconnect()
      }
    })
    client.on('end', () => {
      if (this.client === client) this.disconnect()
    })
    client.on('notification', (notification) => {
      if (notification.channel === 'harness_access_invalidation' && notification.payload === this.context.organizationId) this.wake()
    })
    await client.query("SELECT set_config('application_name',$1,false)", [`hgw-access:${this.context.nodeName}`])
    await client.query('LISTEN harness_access_invalidation')
    return client
  }

  private async drain(observe: () => void): Promise<void> {
    const client = await this.connection()
    const revision = await client.query<{ access_revision: string; access_applied_revision: string; status: string }>(
      `SELECT o.access_revision::text,n.access_applied_revision::text,o.status FROM harness.organizations o
       JOIN harness.compute_nodes n ON n.organization_id=o.id AND n.id=$2 AND n.status='active' WHERE o.id=$1`,
      [this.context.organizationId, this.context.nodeId],
    )
    const organization = revision.rows[0]
    if (organization === undefined || organization.status !== 'active') throw new Error('access organization is not active')
    const target = BigInt(organization.access_revision)
    // A cold process has no admitted streams and can resume its node's applied
    // runtime projection. Reconnects always retain this process's own cursor.
    const initial = this.cursor ?? BigInt(organization.access_applied_revision)
    if (initial > target) throw new Error('access invalidation revision moved backwards')
    let cursor = initial
    const changes = new Map<string, AccessInvalidationSubject>()
    while (cursor < target) {
      const result = await client.query<{ revision: string; subjects: unknown }>(
        `SELECT payload->>'revision' AS revision,payload->'subjects' AS subjects FROM harness.outbox
         WHERE organization_id=$1 AND topic='access.invalidate'
           AND (payload->>'revision')::bigint>$2 AND (payload->>'revision')::bigint<=$3
         ORDER BY (payload->>'revision')::bigint LIMIT 128`,
        [this.context.organizationId, String(cursor), String(target)],
      )
      if (result.rows.length === 0) throw new Error('access invalidation history has a gap')
      for (const row of result.rows) {
        const next = BigInt(row.revision)
        if (next !== cursor + 1n) throw new Error('access invalidation revision is not contiguous')
        for (const subject of subjects(row.subjects)) {
          const key = `${subject.nodeId ?? '*'}:${subject.userId ?? '*'}:${subject.projectId ?? '*'}`
          const prior = changes.get(key)
          changes.set(key, { ...subject, ...(prior?.restartRuntime === true ? { restartRuntime: true } : {}) })
        }
        cursor = next
      }
    }
    if (changes.size > 0) {
      this.applying = { through: target, fenced: false }
      try {
        const cleanup = this.notify([...changes.values()])
        observe()
        await cleanup
      } finally {
        this.applying = undefined
      }
    } else observe()
    if (this.closed || this.client !== client) throw new Error('access invalidation listener disconnected')
    if (cursor > initial) {
      const acknowledged = await client.query(
        `UPDATE harness.compute_nodes SET access_applied_revision=GREATEST(access_applied_revision,$3)
         WHERE organization_id=$1 AND id=$2`,
        [this.context.organizationId, this.context.nodeId, String(cursor)],
      )
      if (acknowledged.rowCount !== 1) throw new Error('access invalidation compute node disappeared')
    }
    this.cursor = cursor
    this.unavailable = false
    this.caughtUp = true
  }
}
