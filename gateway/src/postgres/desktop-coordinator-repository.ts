import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { transaction } from './database.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'
import type {
  DesktopCoordinatorRepository,
  DesktopCoordinatorTx,
  DesktopGrantPatch,
  DesktopGrantRow,
  DesktopGrantState,
  DesktopQueuePatch,
  DesktopQueueRow,
  DesktopQueueState,
  DesktopResourceRow,
  DesktopResourceState,
} from '../desktop-coordinator.ts'

/** PostgreSQL-backed desktop-coordination store; durable across coordinator restarts. */

const GLOBAL_LOCK_KEY = 'desktop-coordinator'

function lockKey(resourceKey: string): bigint {
  const digest = createHash('sha256').update(resourceKey).digest()
  return digest.readBigInt64BE(0)
}

/**
 * Desktop tables are shared by every organization on one PostgreSQL cluster,
 * so rows are addressed under an organization-prefixed resource key while the
 * coordinator keeps working with its plain `{node}/{desktop}` key.
 */
function scopedKey(organizationId: string, resourceKey: string): string {
  return `${organizationId}/${resourceKey}`
}

function unscopedKey(organizationId: string, resourceKey: string): string {
  return resourceKey.startsWith(`${organizationId}/`) ? resourceKey.slice(organizationId.length + 1) : resourceKey
}

interface PgResourceRow {
  resource_key: string
  node: string
  desktop: string
  fencing_seq: string
  queue_seq: string
  state: string
  state_note: string | null
  updated_at: string
}

interface PgGrantRow {
  grant_id: string
  resource_key: string
  fencing: string
  holder_key: string
  holder_json: string
  request_id: string
  state: string
  reason: string | null
  acquired_at: string
  heartbeat_at: string
  stopping_at: string | null
  released_at: string | null
}

interface PgQueueRow {
  queue_id: string
  resource_key: string
  position: string
  holder_key: string
  holder_json: string
  request_id: string
  state: string
  queued_at: string
  settled_at: string | null
  grant_id: string | null
}

function resourceOf(organizationId: string, row: PgResourceRow): DesktopResourceRow {
  return {
    resourceKey: unscopedKey(organizationId, row.resource_key),
    node: row.node,
    desktop: row.desktop,
    fencingSeq: Number(row.fencing_seq),
    queueSeq: Number(row.queue_seq),
    state: row.state as DesktopResourceState,
    stateNote: row.state_note,
    updatedAt: Number(row.updated_at),
  }
}

function grantOf(organizationId: string, row: PgGrantRow): DesktopGrantRow {
  return {
    grantId: row.grant_id,
    resourceKey: unscopedKey(organizationId, row.resource_key),
    fencing: Number(row.fencing),
    holderKey: row.holder_key,
    holderJson: typeof row.holder_json === 'string' ? row.holder_json : JSON.stringify(row.holder_json),
    requestId: row.request_id,
    state: row.state as DesktopGrantState,
    reason: row.reason,
    acquiredAt: Number(row.acquired_at),
    heartbeatAt: Number(row.heartbeat_at),
    stoppingAt: row.stopping_at === null ? null : Number(row.stopping_at),
    releasedAt: row.released_at === null ? null : Number(row.released_at),
  }
}

function queueOf(organizationId: string, row: PgQueueRow): DesktopQueueRow {
  return {
    queueId: row.queue_id,
    resourceKey: unscopedKey(organizationId, row.resource_key),
    position: Number(row.position),
    holderKey: row.holder_key,
    holderJson: typeof row.holder_json === 'string' ? row.holder_json : JSON.stringify(row.holder_json),
    requestId: row.request_id,
    state: row.state as DesktopQueueState,
    queuedAt: Number(row.queued_at),
    settledAt: row.settled_at === null ? null : Number(row.settled_at),
    grantId: row.grant_id,
  }
}

class PostgresCoordinatorTx implements DesktopCoordinatorTx {
  constructor(
    private readonly client: PoolClient,
    private readonly organizationId: string,
  ) {}

  private key(resourceKey: string): string {
    return scopedKey(this.organizationId, resourceKey)
  }

  async resource(resourceKey: string): Promise<DesktopResourceRow | undefined> {
    const { rows } = await this.client.query<PgResourceRow>(
      `SELECT * FROM harness.desktop_resources WHERE resource_key = $1`, [this.key(resourceKey)])
    return rows[0] === undefined ? undefined : resourceOf(this.organizationId, rows[0])
  }

  async upsertResource(row: DesktopResourceRow): Promise<void> {
    await this.client.query(
      `INSERT INTO harness.desktop_resources(resource_key, node, desktop, fencing_seq, queue_seq, state, state_note, updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(resource_key) DO UPDATE SET fencing_seq = excluded.fencing_seq, queue_seq = excluded.queue_seq, state = excluded.state, state_note = excluded.state_note, updated_at = excluded.updated_at`,
      [this.key(row.resourceKey), row.node, row.desktop, row.fencingSeq, row.queueSeq, row.state, row.stateNote, row.updatedAt])
  }

  async grantById(grantId: string): Promise<DesktopGrantRow | undefined> {
    const { rows } = await this.client.query<PgGrantRow>(`SELECT * FROM harness.desktop_grants WHERE grant_id = $1`, [grantId])
    return rows[0] === undefined ? undefined : grantOf(this.organizationId, rows[0])
  }

  async activeGrant(resourceKey: string): Promise<DesktopGrantRow | undefined> {
    const { rows } = await this.client.query<PgGrantRow>(
      `SELECT * FROM harness.desktop_grants WHERE resource_key = $1 AND state != 'released'`, [this.key(resourceKey)])
    return rows[0] === undefined ? undefined : grantOf(this.organizationId, rows[0])
  }

  async grantByRequest(resourceKey: string, holderKey: string, requestId: string): Promise<DesktopGrantRow | undefined> {
    const { rows } = await this.client.query<PgGrantRow>(
      `SELECT * FROM harness.desktop_grants WHERE resource_key = $1 AND holder_key = $2 AND request_id = $3 ORDER BY acquired_at DESC LIMIT 1`,
      [this.key(resourceKey), holderKey, requestId])
    return rows[0] === undefined ? undefined : grantOf(this.organizationId, rows[0])
  }

  async insertGrant(row: DesktopGrantRow): Promise<void> {
    await this.client.query(
      `INSERT INTO harness.desktop_grants(grant_id, resource_key, fencing, holder_key, holder_json, request_id, state, reason, acquired_at, heartbeat_at, stopping_at, released_at)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12)`,
      [row.grantId, this.key(row.resourceKey), row.fencing, row.holderKey, row.holderJson, row.requestId, row.state, row.reason, row.acquiredAt, row.heartbeatAt, row.stoppingAt, row.releasedAt])
  }

  async updateGrant(grantId: string, patch: DesktopGrantPatch): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    const push = (column: string, value: unknown): void => { params.push(value); sets.push(`${column} = $${String(params.length)}`) }
    if (patch.state !== undefined) push('state', patch.state)
    if (patch.reason !== undefined) push('reason', patch.reason)
    if (patch.heartbeatAt !== undefined) push('heartbeat_at', patch.heartbeatAt)
    if (patch.stoppingAt !== undefined) push('stopping_at', patch.stoppingAt)
    if (patch.releasedAt !== undefined) push('released_at', patch.releasedAt)
    if (sets.length === 0) return
    params.push(grantId)
    await this.client.query(`UPDATE harness.desktop_grants SET ${sets.join(', ')} WHERE grant_id = $${String(params.length)}`, params)
  }

  async liveQueue(resourceKey: string): Promise<DesktopQueueRow[]> {
    const { rows } = await this.client.query<PgQueueRow>(
      `SELECT * FROM harness.desktop_queue WHERE resource_key = $1 AND state = 'queued' ORDER BY position`, [this.key(resourceKey)])
    return rows.map(row => queueOf(this.organizationId, row))
  }

  async queueEntryByRequest(resourceKey: string, holderKey: string, requestId: string): Promise<DesktopQueueRow | undefined> {
    const { rows } = await this.client.query<PgQueueRow>(
      `SELECT * FROM harness.desktop_queue WHERE resource_key = $1 AND holder_key = $2 AND request_id = $3 ORDER BY queued_at DESC LIMIT 1`,
      [this.key(resourceKey), holderKey, requestId])
    return rows[0] === undefined ? undefined : queueOf(this.organizationId, rows[0])
  }

  async queueSize(resourceKey: string): Promise<number> {
    const { rows } = await this.client.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM harness.desktop_queue WHERE resource_key = $1 AND state = 'queued'`, [this.key(resourceKey)])
    return Number(rows[0]?.n ?? 0)
  }

  async insertQueueEntry(row: DesktopQueueRow): Promise<void> {
    await this.client.query(
      `INSERT INTO harness.desktop_queue(queue_id, resource_key, position, holder_key, holder_json, request_id, state, queued_at, settled_at, grant_id)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [row.queueId, this.key(row.resourceKey), row.position, row.holderKey, row.holderJson, row.requestId, row.state, row.queuedAt, row.settledAt, row.grantId])
  }

  async updateQueueEntry(queueId: string, patch: DesktopQueuePatch): Promise<void> {
    const sets: string[] = []
    const params: unknown[] = []
    const push = (column: string, value: unknown): void => { params.push(value); sets.push(`${column} = $${String(params.length)}`) }
    if (patch.state !== undefined) push('state', patch.state)
    if (patch.settledAt !== undefined) push('settled_at', patch.settledAt)
    if (patch.grantId !== undefined) push('grant_id', patch.grantId)
    if (sets.length === 0) return
    params.push(queueId)
    await this.client.query(`UPDATE harness.desktop_queue SET ${sets.join(', ')} WHERE queue_id = $${String(params.length)}`, params)
  }

  async nextFencing(resourceKey: string): Promise<number> {
    const { rows } = await this.client.query<{ seq: string }>(
      `UPDATE harness.desktop_resources SET fencing_seq = fencing_seq + 1 WHERE resource_key = $1 RETURNING fencing_seq AS seq`, [this.key(resourceKey)])
    return Number(rows[0]?.seq ?? 0)
  }

  async nextPosition(resourceKey: string): Promise<number> {
    const { rows } = await this.client.query<{ seq: string }>(
      `UPDATE harness.desktop_resources SET queue_seq = queue_seq + 1 WHERE resource_key = $1 RETURNING queue_seq AS seq`, [this.key(resourceKey)])
    return Number(rows[0]?.seq ?? 0)
  }

  async staleGrants(heartbeatCutoff: number): Promise<DesktopGrantRow[]> {
    const { rows } = await this.client.query<PgGrantRow>(
      `SELECT * FROM harness.desktop_grants WHERE state = 'held' AND heartbeat_at < $1 AND resource_key LIKE $2 FOR UPDATE`, [heartbeatCutoff, `${this.organizationId}/%`])
    return rows.map(row => grantOf(this.organizationId, row))
  }

  async staleStopping(confirmCutoff: number): Promise<DesktopGrantRow[]> {
    const { rows } = await this.client.query<PgGrantRow>(
      `SELECT * FROM harness.desktop_grants WHERE state = 'stopping' AND stopping_at < $1 AND resource_key LIKE $2 FOR UPDATE`, [confirmCutoff, `${this.organizationId}/%`])
    return rows.map(row => grantOf(this.organizationId, row))
  }

  async staleQueue(queueCutoff: number): Promise<DesktopQueueRow[]> {
    const { rows } = await this.client.query<PgQueueRow>(
      `SELECT * FROM harness.desktop_queue WHERE state = 'queued' AND queued_at < $1 AND resource_key LIKE $2 FOR UPDATE`, [queueCutoff, `${this.organizationId}/%`])
    return rows.map(row => queueOf(this.organizationId, row))
  }
}

export class PostgresDesktopCoordinatorRepository implements DesktopCoordinatorRepository {
  constructor(private readonly context: PostgresRuntimeContext) {}

  async initialize(): Promise<void> {}

  async transact<T>(resourceKey: string, fn: (tx: DesktopCoordinatorTx) => Promise<T>): Promise<T> {
    return transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey(scopedKey(this.context.organizationId, resourceKey))])
      return fn(new PostgresCoordinatorTx(client, this.context.organizationId))
    })
  }

  async transactAll<T>(fn: (tx: DesktopCoordinatorTx) => Promise<T>): Promise<T> {
    return transaction(this.context.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey(scopedKey(this.context.organizationId, GLOBAL_LOCK_KEY))])
      return fn(new PostgresCoordinatorTx(client, this.context.organizationId))
    })
  }

  async snapshot(resourceKey: string): Promise<{ resource: DesktopResourceRow | undefined; grants: DesktopGrantRow[]; queue: DesktopQueueRow[] }> {
    const scoped = scopedKey(this.context.organizationId, resourceKey)
    const { rows: resources } = await this.context.pool.query<PgResourceRow>(
      `SELECT * FROM harness.desktop_resources WHERE resource_key = $1`, [scoped])
    const { rows: grants } = await this.context.pool.query<PgGrantRow>(
      `SELECT * FROM harness.desktop_grants WHERE resource_key = $1 ORDER BY acquired_at`, [scoped])
    const { rows: queue } = await this.context.pool.query<PgQueueRow>(
      `SELECT * FROM harness.desktop_queue WHERE resource_key = $1 ORDER BY position`, [scoped])
    return {
      resource: resources[0] === undefined ? undefined : resourceOf(this.context.organizationId, resources[0]),
      grants: grants.map(row => grantOf(this.context.organizationId, row)),
      queue: queue.map(row => queueOf(this.context.organizationId, row)),
    }
  }

  async listResources(): Promise<DesktopResourceRow[]> {
    const { rows } = await this.context.pool.query<PgResourceRow>(
      `SELECT * FROM harness.desktop_resources WHERE resource_key LIKE $1 ORDER BY resource_key`, [`${this.context.organizationId}/%`])
    return rows.map(row => resourceOf(this.context.organizationId, row))
  }
}
