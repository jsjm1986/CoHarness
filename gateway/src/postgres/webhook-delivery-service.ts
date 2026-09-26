/** Durable webhook dispatch reservations shared by all Gateway nodes. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { RuntimeTarget } from '../instances.ts'
import { transaction } from './database.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/** Replay dedup horizon; keeps the PG interval computation inside the supported range. */
export const REPLAY_WINDOW_LIMIT_MS = 2_592_000_000
/** A server-created endpoint identity, independent of secret rotation or configuration revision. */
export type WebhookEndpointId = Branded<'WebhookEndpointId'>
/** A durable reservation identity; possessing it alone grants no execution permission. */
export type WebhookReceiptId = Branded<'WebhookReceiptId'>

const completion = z.discriminatedUnion('state', [
  z.object({ state: z.literal('submitted'), sessionId: z.string().min(1).max(256) }).strict(),
  z.object({ state: z.literal('ignored'),
    errorCode: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u).optional() }).strict(),
  z.object({ state: z.enum(['rejected', 'unknown']), errorCode: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/u) }).strict(),
])

/** Public status deliberately excludes payloads, secrets and private runtime diagnostics. */
export interface WebhookReceipt {
  id: WebhookReceiptId
  deliveryId: string
  configurationRevision: string
  state: 'dispatching' | 'submitted' | 'ignored' | 'rejected' | 'unknown'
  sessionId: string | null
  errorCode: string | null
  receivedAt: string
}

interface ReceiptRow {
  id: WebhookReceiptId; delivery_id: string; request_hash: string; configuration_revision: string
  state: WebhookReceipt['state']; session_id: string | null; error_code: string | null; received_at: Date
  endpoint_id: string; execution_user_id: string; runtime_kind: 'user' | 'project'; runtime_public_id: string
  event: unknown
}
const columns = `id,delivery_id,request_hash,configuration_revision::text,state,session_id,error_code,received_at,
  endpoint_id,execution_user_id,runtime_kind,runtime_public_id::text,event`
function view(row: ReceiptRow): WebhookReceipt {
  return { id: row.id, deliveryId: row.delivery_id, configurationRevision: row.configuration_revision,
    state: row.state, sessionId: row.session_id, errorCode: row.error_code, receivedAt: row.received_at.toISOString() }
}

/** Intake or completion cannot be accepted with the supplied delivery identity. */
export class WebhookReceiptError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429, message: string) { super(message) }
}

/** Signature and account authorization must succeed before reserving a delivery. */
export class PostgresWebhookDeliveryService {
  constructor(private readonly context: PostgresRuntimeContext) {}

  /**
   * Read one bounded page for administrative delivery diagnostics.
   * @param endpoint - endpoint UUID received from the admin query.
   * @param cursor - last receipt id from the previous page, or undefined.
   * @param limit - page size, defaulting to 50 and capped at 100.
   * @returns newest receipts and the next cursor, without payloads or credentials.
   */
  async list(endpoint: unknown, cursor?: unknown, limit: unknown = 50): Promise<{ items: WebhookReceipt[]; nextCursor: WebhookReceiptId | null }> {
    const query = z.object({ endpoint: z.uuid(), cursor: z.uuid().optional(), limit: z.number().int().min(1).max(100) }).safeParse({ endpoint, cursor, limit })
    if (!query.success) throw new WebhookReceiptError(400, 'invalid webhook receipt query')
    const input = query.data
    return transaction(this.context.pool, async client => {
      if (input.cursor !== undefined) {
        const found = await client.query('SELECT id FROM harness.webhook_delivery_receipts WHERE organization_id=$1 AND endpoint_id=$2 AND id=$3',
          [this.context.organizationId, input.endpoint, input.cursor])
        if (found.rowCount !== 1) throw new WebhookReceiptError(400, 'webhook receipt cursor does not belong to this endpoint')
      }
      const rows = await client.query<ReceiptRow>(`SELECT ${columns} FROM harness.webhook_delivery_receipts
        WHERE organization_id=$1 AND endpoint_id=$2 AND ($3::uuid IS NULL OR (received_at,id)<(
          SELECT received_at,id FROM harness.webhook_delivery_receipts WHERE organization_id=$1 AND endpoint_id=$2 AND id=$3))
        ORDER BY received_at DESC,id DESC LIMIT $4`, [this.context.organizationId, input.endpoint, input.cursor ?? null, input.limit + 1])
      const items = rows.rows.slice(0, input.limit).map(view)
      return { items, nextCursor: rows.rows.length > input.limit ? items.at(-1)!.id : null }
    })
  }

  /**
   * Reserve one dispatch across nodes, retaining delivery identities after secret rotation.
   * Equal bodies with new ids share the original receipt within replayWindowMs;
   * unresolved dispatches remain protected beyond that window. The independent
   * windowMs and limit bound intake of new work, not transport retries.
   * @param input - verified delivery digest and server-resolved configuration and execution account.
   * @returns whether this caller owns dispatch, plus the durable status for repeat deliveries.
   */
  async reserve(input: {
    endpointId: WebhookEndpointId; deliveryId: string; requestHash: string; configurationRevision: string
    executionUserUuid: string; target: RuntimeTarget; limit: number; windowMs: number; replayWindowMs: number
    event: unknown
  }): Promise<{ dispatch: boolean; receipt: WebhookReceipt }> {
    const parsed = z.object({ endpointId: z.uuid(), deliveryId: z.string().min(1).max(256), requestHash: z.string().regex(/^[0-9a-f]{64}$/u),
      configurationRevision: z.string().regex(/^[1-9][0-9]{0,17}$/u), executionUserUuid: z.uuid(),
      target: z.object({ kind: z.enum(['user', 'project']), id: z.number().int().positive() }).strict(),
      limit: z.number().int().min(1).max(1_000_000), windowMs: z.number().int().min(1).max(86_400_000),
      replayWindowMs: z.number().int().min(1).max(REPLAY_WINDOW_LIMIT_MS), event: z.unknown(),
    }).strict().safeParse(input)
    if (!parsed.success) throw new WebhookReceiptError(400, 'invalid webhook reservation')
    const org = this.context.organizationId, endpoint = input.endpointId
    return transaction(this.context.pool, async client => {
      await client.query(`INSERT INTO harness.webhook_intake_windows(organization_id,endpoint_id)
        VALUES($1,$2) ON CONFLICT DO NOTHING`, [org, endpoint])
      await client.query('SELECT endpoint_id FROM harness.webhook_intake_windows WHERE organization_id=$1 AND endpoint_id=$2 FOR UPDATE', [org, endpoint])
      const prior = await client.query<ReceiptRow>(`SELECT ${columns} FROM harness.webhook_delivery_receipts
        WHERE organization_id=$1 AND endpoint_id=$2 AND (delivery_id=$3 OR id=(
          SELECT receipt_id FROM harness.webhook_delivery_aliases
          WHERE organization_id=$1 AND endpoint_id=$2 AND delivery_id=$3))`, [org, endpoint, input.deliveryId])
      if (prior.rows[0] !== undefined) {
        if (prior.rows[0].request_hash !== input.requestHash) throw new WebhookReceiptError(409, 'webhook delivery identity was reused with different content')
        return { dispatch: false, receipt: view(prior.rows[0]) }
      }
      const matchingBody = await client.query<ReceiptRow>(`SELECT ${columns} FROM harness.webhook_delivery_receipts
        WHERE organization_id=$1 AND endpoint_id=$2 AND request_hash=$3
          AND (received_at > statement_timestamp() - $4*interval '1 millisecond' OR state IN ('dispatching','unknown'))
        ORDER BY received_at DESC,id DESC LIMIT 1`, [org, endpoint, input.requestHash, input.replayWindowMs])
      const original = matchingBody.rows[0]
      if (original !== undefined) {
        await client.query(`INSERT INTO harness.webhook_delivery_aliases(organization_id,endpoint_id,delivery_id,receipt_id)
          VALUES($1,$2,$3,$4)`, [org, endpoint, input.deliveryId, original.id])
        return { dispatch: false, receipt: view(original) }
      }
      const budget = await client.query(`UPDATE harness.webhook_intake_windows SET
        accepted=CASE WHEN started_at + $4*interval '1 millisecond' <= statement_timestamp() THEN 1 ELSE accepted+1 END,
        started_at=CASE WHEN started_at + $4*interval '1 millisecond' <= statement_timestamp() THEN statement_timestamp() ELSE started_at END
        WHERE organization_id=$1 AND endpoint_id=$2
          AND (accepted<$3 OR started_at + $4*interval '1 millisecond' <= statement_timestamp())`, [org, endpoint, input.limit, input.windowMs])
      if (budget.rowCount !== 1) throw new WebhookReceiptError(429, 'webhook intake limit reached')
      const inserted = await client.query<ReceiptRow>(`INSERT INTO harness.webhook_delivery_receipts
        (organization_id,endpoint_id,delivery_id,request_hash,configuration_revision,node_id,execution_user_id,runtime_kind,runtime_public_id,event)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,
      [org, endpoint, input.deliveryId, input.requestHash, input.configurationRevision, this.context.nodeId,
        input.executionUserUuid, input.target.kind, input.target.id, JSON.stringify(input.event ?? null)])
      return { dispatch: true, receipt: view(inserted.rows[0]!) }
    })
  }

  /**
   * Read one receipt with its endpoint binding for administrative redispatch.
   * @param receiptId - receipt UUID from the admin query.
   * @returns the receipt, owning endpoint UUID, and stored event.
   */
  async get(receiptId: unknown): Promise<{ receipt: WebhookReceipt; endpointId: string; event: unknown }> {
    const parsed = z.uuid().safeParse(receiptId)
    if (!parsed.success) throw new WebhookReceiptError(400, 'invalid webhook receipt id')
    const rows = await this.context.pool.query<ReceiptRow>(`SELECT ${columns} FROM harness.webhook_delivery_receipts
      WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, parsed.data])
    const row = rows.rows[0]
    if (row === undefined) throw new WebhookReceiptError(404, 'webhook receipt not found')
    return { receipt: view(row), endpointId: row.endpoint_id, event: row.event }
  }

  /**
   * Create a fresh dispatch reservation replaying one settled receipt's stored
   * event. The synthetic delivery identity bypasses content deduplication; the
   * administrator decision is auditable through the new receipt row.
   * @param receiptId - settled receipt to replay.
   * @param endpoint - the endpoint's current configuration and account binding.
   * @returns the new reservation and the stored event for dispatch.
   */
  async redispatch(receiptId: unknown, endpoint: {
    endpointId: string; configurationRevision: string; executionUserUuid: string; target: RuntimeTarget
  }): Promise<{ receipt: WebhookReceipt; event: unknown; deliveryId: string }> {
    const parsed = z.uuid().safeParse(receiptId)
    if (!parsed.success) throw new WebhookReceiptError(400, 'invalid webhook receipt id')
    return transaction(this.context.pool, async client => {
      const original = await client.query<ReceiptRow>(`SELECT ${columns} FROM harness.webhook_delivery_receipts
        WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, parsed.data])
      const row = original.rows[0]
      if (row === undefined) throw new WebhookReceiptError(404, 'webhook receipt not found')
      if (row.state === 'dispatching' || row.state === 'unknown') {
        throw new WebhookReceiptError(409, 'only settled webhook deliveries can be redispatched')
      }
      if (row.endpoint_id !== endpoint.endpointId) {
        throw new WebhookReceiptError(400, 'webhook receipt belongs to another endpoint')
      }
      const alive = await client.query('SELECT 1 FROM harness.webhook_endpoints WHERE organization_id=$1 AND id=$2',
        [this.context.organizationId, endpoint.endpointId])
      if (alive.rowCount !== 1) throw new WebhookReceiptError(404, 'webhook endpoint was removed')
      const deliveryId = `rerun:${row.id}:${randomUUID()}`
      const inserted = await client.query<ReceiptRow>(`INSERT INTO harness.webhook_delivery_receipts
        (organization_id,endpoint_id,delivery_id,request_hash,configuration_revision,node_id,execution_user_id,runtime_kind,runtime_public_id,event)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${columns}`,
      [this.context.organizationId, row.endpoint_id, deliveryId, row.request_hash, endpoint.configurationRevision,
        this.context.nodeId, endpoint.executionUserUuid, endpoint.target.kind, endpoint.target.id,
        JSON.stringify(row.event ?? null)])
      return { receipt: view(inserted.rows[0]!), event: row.event, deliveryId }
    })
  }

  /**
   * Record admission, no action or a bounded failure, without claiming Agent success.
   * @param endpoint - endpoint owning the reservation.
   * @param id - exact receipt returned to the dispatching node.
   * @param result - validated runtime admission or classified failure; no raw error text.
   * @returns the recorded result; identical repeats are idempotent, conflicting repeats fail.
   */
  async complete(endpoint: WebhookEndpointId, id: WebhookReceiptId, result: unknown): Promise<WebhookReceipt> {
    const parsed = completion.safeParse(result)
    if (!parsed.success) throw new WebhookReceiptError(400, 'invalid webhook completion')
    const value = parsed.data
    const session = value.state === 'submitted' ? value.sessionId : null
    const error = value.state === 'submitted' ? null : (value.errorCode ?? null)
    return transaction(this.context.pool, async client => {
      const existing = await client.query<ReceiptRow>(`SELECT ${columns} FROM harness.webhook_delivery_receipts
        WHERE organization_id=$1 AND endpoint_id=$2 AND id=$3 AND node_id=$4 FOR UPDATE`,
      [this.context.organizationId, endpoint, id, this.context.nodeId])
      const row = existing.rows[0]
      if (row === undefined) throw new WebhookReceiptError(404, 'webhook reservation not found on this node')
      if (row.state !== 'dispatching') {
        if (row.state !== value.state || row.session_id !== session || row.error_code !== error) throw new WebhookReceiptError(409, 'webhook result already recorded')
        return view(row)
      }
      const updated = await client.query<ReceiptRow>(`UPDATE harness.webhook_delivery_receipts SET state=$3,session_id=$4,error_code=$5,updated_at=clock_timestamp()
        WHERE organization_id=$1 AND id=$2 RETURNING ${columns}`, [this.context.organizationId, id, value.state, session, error])
      return view(updated.rows[0]!)
    })
  }
}
