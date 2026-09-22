/** Durable, organization-scoped access revocation delivery between Gateways. @module */

import type { PoolClient } from 'pg'
import { errorCodeForDiagnostics } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'

/** Traffic affected by an access change; an empty subject invalidates the organization. */
export interface AccessInvalidationSubject {
  userId?: number
  projectId?: number
  /** Directory projections or runtime ownership changed and require a fresh process. */
  restartRuntime?: boolean
}

/** Admission catches up with durable changes; subscribers also receive live revocations. */
export interface GatewayAccessMonitor {
  /** Read committed changes before admitting a runtime operation. */
  synchronize(): Promise<void>
  /** Register cancellation/projection work, awaited before its revision is acknowledged. */
  subscribe(listener: (subject: AccessInvalidationSubject) => void | Promise<void>): () => void
}

function subjects(value: unknown): AccessInvalidationSubject[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('invalid access invalidation subjects')
  return value.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('invalid access invalidation subject')
    const row = item as Record<string, unknown>
    for (const [key, entry] of Object.entries(row)) {
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
  private flight: Promise<void> | undefined
  private cancellations: Promise<void> = Promise.resolve()
  private cancelling = false
  private readonly timer: NodeJS.Timeout
  private closed = false
  private unavailable = false

  /**
   * Construct the monitor; call synchronize before accepting traffic.
   * @param context - database and organization owned by this Gateway
   * @param pollMs - fallback interval for a lost notification and reconnect attempts
   */
  constructor(private readonly context: PostgresRuntimeContext, pollMs: number) {
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 2_147_483_647) throw new Error('invalid access invalidation poll interval')
    this.timer = setInterval(() => { this.wake() }, pollMs)
    this.timer.unref()
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
    const pending = this.flight
    // Calls arriving during a read share the next read, whose snapshot cannot
    // precede their admission. Continued traffic cannot postpone earlier callers.
    return pending === undefined ? this.readFresh() : pending.then(() => this.readFresh())
  }

  private readFresh(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('access monitor is closed'))
    this.flight ??= this.drain().catch((error: unknown) => {
      this.reportFailure(error)
      this.disconnect()
      throw error
    }).finally(() => { this.flight = undefined })
    return this.flight
  }

  /** Stop reconnect attempts, release the dedicated listener, and await in-flight work. */
  async close(): Promise<void> {
    this.closed = true
    clearInterval(this.timer)
    this.disconnect()
    await this.flight?.catch(() => { /* shutdown already closed traffic and the database listener */ })
    await this.cancellations
  }

  private wake(): void {
    if (this.closed || this.listeners.size === 0) return
    void this.synchronize().catch(() => {
      // Admission remains blocked until a later explicit read/reconnect succeeds.
      // The connection's error handler and disconnect have already closed traffic.
    })
  }

  private reportFailure(error: unknown): void {
    if (this.unavailable || this.closed) return
    this.unavailable = true
    console.error(`[gateway] access invalidation unavailable (${errorCodeForDiagnostics(error)})`)
  }

  private async notify(subject: AccessInvalidationSubject): Promise<void> {
    // Every transport sees cancellation before a slow runtime stop is awaited.
    const settled = await Promise.allSettled([...this.listeners].map(async listener => { await listener(subject) }))
    const errors: unknown[] = settled.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'access invalidation did not settle')
  }

  private disconnect(): void {
    const client = this.client
    if (client === undefined && this.cancelling) return
    this.client = undefined
    if (client !== undefined) client.release(true)
    this.cancelling = true
    const pending = (async () => {
      const settled = await Promise.allSettled([this.cancellations, this.notify({})])
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
    const client = await this.context.pool.connect()
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

  private async drain(): Promise<void> {
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
          const key = `${subject.userId ?? '*'}:${subject.projectId ?? '*'}`
          const prior = changes.get(key)
          changes.set(key, { ...subject, ...(prior?.restartRuntime === true ? { restartRuntime: true } : {}) })
        }
        cursor = next
      }
    }
    for (const subject of changes.values()) {
      await this.notify(subject)
    }
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
  }
}
