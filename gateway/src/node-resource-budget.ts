/** Durable node-wide admission with equal-user, per-user project round robin. */
import { createHash, randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient } from 'pg'
import type { ResourceKind, ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { resourcePolicySchema, resourceStatusSchema, type ResourceStatus } from '@deepseek-ai/dsh-resource-budget/wire'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { PersonalExecutionWriteFence } from './execution-identity.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { RuntimeTarget } from './instances.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { pressureCredits, type NodePressureConfig, type NodePressureObservation, type NodePressureSample } from './node-resource-pressure.ts'
import type { ResourceQueueDiagnostic } from './operation-timing.ts'
import { isDatabaseContentionError, transaction } from './postgres/database.ts'
import { RuntimeCapacityError } from './runtime-capacity.ts'

const KINDS: readonly ResourceKind[] = ['model', 'process']

/** Validated deployment limits; active limits count actual resources, including uncertain cleanup. */
export interface NodeResourceBudgetConfig extends NodePressureConfig {
  readonly maxQueued: number
  readonly maxQueuedPerUser: number
  readonly maxQueuedPerProject: number
  readonly maxQueuedBytes: number
  readonly maxWaitMs: number
}

const resourceLimits = resourcePolicySchema

/** One Runtime-local request sequence and server-verified execution attribution. */
export interface NodeResourceRequest {
  readonly requestId: ResourceOperationId
  readonly sequence: number
  readonly kind: ResourceKind
  readonly actorId: number
  readonly projectId: number
  readonly sessionId?: string
  readonly scopeId?: string
  readonly origin?: 'runtime' | 'principal' | 'session'
  readonly administrative?: boolean
}

/** Replayed terminal sequences cannot re-enter admission after their retained row is removed. */
export type NodeResourceStatus = ResourceStatus

/** Identity of one Gateway process holding an exclusive local kernel lock. */
export type GatewayResourceOwnerId = Branded<'GatewayResourceOwnerId'>

/** Process owner; releasing its kernel lock requires all local callbacks to have settled. */
export interface GatewayResourceOwner {
  readonly organizationId: string
  readonly ownerId: GatewayResourceOwnerId
  readonly generation: number
}

type ResourceOwner = RuntimeCredentialSubject | GatewayResourceOwner

/** Inode witness retained while the Gateway owns model requests. */
export interface GatewayResourceLock {
  readonly device: string
  readonly inode: string
}

/** Server-recorded ownership for a fresh grant check; never supplied by a polling Runtime. */
export type NodeResourceOrigin = { readonly kind: 'runtime' }
  | { readonly kind: 'principal'; readonly actorId: number; readonly administrative: boolean }
  | { readonly kind: 'session'; readonly sessionId: string; readonly scopeId?: string }

/** One accounting snapshot and its immutable server-recorded origin. */
export interface NodeResourceAdmission {
  readonly status: NodeResourceStatus
  readonly origin?: NodeResourceOrigin
}

/** Safe request rejection, without SQL or owner identifiers. */
export class NodeResourceBudgetError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503, readonly reason:
    'request-conflict' | 'unregistered' | 'sequence-gap' | 'operation-conflict' | 'unknown-operation'
    | 'organization-mismatch' | 'stale-generation' | 'owner-mismatch' | 'database-busy', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NodeResourceBudgetError'
  }
}

interface AdmissionRow {
  sequence: string
  operation_id: ResourceOperationId | null
  actor_public_id: string
  session_id: string | null
  scope_id: string | null
  origin_kind: NonNullable<NodeResourceRequest['origin']> | null
  principal_admin: boolean
  state: 'queued' | 'active' | 'uncertain'
}

interface ReservationRow {
  limits: unknown
  state: string
  refusal: string | null
}

interface RuntimeStartAdmission {
  state: 'waiting' | 'admitted' | 'stale-generation' | 'timeout'
  limits: unknown
}

const NODE = 'organization_id=$1 AND node_id=$2'
const OWNER = `${NODE} AND runtime_kind=$3 AND runtime_public_id=$4 AND generation=$5`
const REQUEST = `${OWNER} AND sequence=$6`
const completionReceiptSql = `SELECT last_sequence, EXISTS (
    SELECT FROM harness.node_resource_requests WHERE ${REQUEST} AND operation_id::text IS DISTINCT FROM $7::text
  ) AS owner_mismatch FROM harness.node_resource_runtimes WHERE ${OWNER}`
// Read the registration in a fresh statement after waiting for the node lock. An issued sequence can
// already be closed, while a legacy reservation with a null operation ID still occupies capacity.
const completeResourceSql = `WITH receipt AS MATERIALIZED (${completionReceiptSql}), removed AS (
    DELETE FROM harness.node_resource_requests WHERE ${REQUEST}
      AND EXISTS (SELECT FROM receipt WHERE last_sequence>=0 AND last_sequence>=$6 AND NOT owner_mismatch)
    RETURNING 1
  ), counted AS (
    UPDATE harness.node_resource_state SET completed=completed+1 WHERE ${NODE} AND EXISTS (SELECT FROM removed)
  ) SELECT last_sequence,owner_mismatch FROM receipt`
const resourceRequestSql = (allocation: '$6' | 'authorized.allocation') =>
  `harness.request_node_resource($1,$2,$3,$4,$5,${allocation},$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`
// Wait for the node before locking the actor. The scope and generation locks then cover the reservation through commit.
const personalReservationSql = (lockNode: string) => `WITH locked AS MATERIALIZED (${lockNode}), authorized AS MATERIALIZED (
    SELECT locked.allocation FROM locked CROSS JOIN LATERAL
      harness.authorize_personal_execution_scope($1,$2,locked.allocation,$5,$20,$21,$4,$14,$17)
  ), reserved AS MATERIALIZED (
    SELECT reservation.*, authorized.allocation
    FROM authorized CROSS JOIN LATERAL ${resourceRequestSql('authorized.allocation')} reservation
  ) SELECT reserved.* FROM reserved
    WHERE CASE WHEN reserved.state='active' THEN EXISTS (
      SELECT FROM harness.authorize_personal_execution_scope($1,$2,reserved.allocation,$5,$20,$21,$4,$14,$17)
    ) ELSE TRUE END`
const scopedPersonalResourceSql = personalReservationSql(
  `SELECT $6::uuid AS allocation FROM harness.lock_node_resources($1,$2,$8::jsonb)`,
)
// The lock pins the previously validated policy through the implicit commit. A policy miss has no accounting effects.
const scopedPersonalResourceWithConfiguredPolicySql = personalReservationSql(
  `SELECT $6::uuid AS allocation FROM harness.node_resource_state WHERE ${NODE} AND limits=$8::jsonb FOR UPDATE`,
)
// An active reservation needs no scheduler update. Its stored origin supplies
// the scope for fresh authorization without holding the resource lock.
const qualifiedPersonalModelSql = `WITH reservation AS MATERIALIZED (
    SELECT request.session_id,request.scope_id,request.state,
      EXTRACT(EPOCH FROM request.granted_at-request.created_at)*1000 AS queue_ms
    FROM harness.node_resource_requests request
    JOIN harness.node_resource_runtimes owner USING(organization_id,node_id,runtime_kind,runtime_public_id,generation)
    JOIN harness.node_resource_state policy USING(organization_id,node_id)
    WHERE (request.organization_id,request.node_id,request.runtime_kind,request.runtime_public_id,request.generation)
      =($1,$2,$3,$4,$5) AND owner.runtime_id=$6
      AND request.sequence=$7 AND request.operation_id=$8 AND request.kind='model'
      AND (request.state='active' OR ($12::boolean AND request.state='queued' AND request.deadline>clock_timestamp()))
      AND request.origin_kind='session' AND request.scope_id IS NOT NULL
      AND octet_length(request.session_id) BETWEEN 1 AND 256 AND request.actor_public_id=$4 AND policy.limits=$11::jsonb
  ) SELECT reservation.state,reservation.queue_ms::float8 FROM reservation CROSS JOIN LATERAL
    harness.authorize_personal_execution_scope($1,$2,$6,$5,$9,$10,$4,reservation.session_id,reservation.scope_id)`
const admissionErrors = new Map<string, NodeResourceBudgetError['reason']>([
  ['P4201', 'stale-generation'], ['P4202', 'request-conflict'], ['P4203', 'unregistered'],
  ['P4204', 'sequence-gap'], ['P4205', 'operation-conflict'],
  ['P4206', 'owner-mismatch'], ['P4207', 'unknown-operation'],
])

/** PostgreSQL owns reservations; no Gateway-local timer or lease expiry can release running work. */
export class NodeResourceBudget {
  private readonly changeEpoch = randomUUID()
  private changeRevision = 0
  private readonly changeWaiters = new Set<() => void>()
  private lastObservation: {
    readonly capturedAt: number
    readonly applied: boolean
    readonly sample: NodePressureSample
    readonly credits: number
  } | undefined
  private lastObservationErrorAt: number | undefined

  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly nodeId: string,
    readonly config: NodeResourceBudgetConfig,
  ) {
    resourceLimits.parse(config)
  }

  /** Process-local revision published with queued status responses. It carries no authority. */
  get changeCursor(): string { return `${this.changeEpoch}.${String(this.changeRevision)}` }

  private signalChange(): void {
    this.changeRevision += 1
    for (const wake of this.changeWaiters) wake()
  }

  /**
   * Summarize the coordinator's latest local pressure observation for a queued admission response.
   * @returns identifier-free queue attribution computed without an additional database query.
   */
  queueDiagnostic(): ResourceQueueDiagnostic {
    const now = performance.now()
    const round = (ms: number): number => Math.round(Math.max(0, ms) * 100) / 100
    const last = this.lastObservation
    const failedAt = this.lastObservationErrorAt
    if (last === undefined) {
      return failedAt === undefined
        ? { reason: 'no-local-observation' }
        : { reason: 'observation-failed', lastErrorAgeMs: round(now - failedAt) }
    }
    const observationAgeMs = round(now - last.capturedAt)
    const failedAfterLast = failedAt !== undefined && failedAt > last.capturedAt
    const { sample, credits, applied } = last
    const reason: ResourceQueueDiagnostic['reason'] = observationAgeMs >= this.config.staleMs
      ? (failedAfterLast ? 'observation-failed' : 'observation-stale')
      : sample.memory !== 'normal'
          || (sample.memoryAvailableRatio !== undefined && sample.memoryAvailableRatio <= this.config.linuxMemoryReserveRatio)
        ? 'pressure-memory'
        : sample.cpu >= this.config.cpuTarget
          ? 'pressure-cpu'
          : sample.eventLoopMs >= this.config.eventLoopTargetMs
            ? 'pressure-event-loop'
            : !applied
              ? 'observation-unapplied'
              : 'credits-or-unregistered'
    return {
      reason,
      observationAgeMs,
      ...(failedAfterLast ? { lastErrorAgeMs: round(now - failedAt) } : {}),
      cpu: Math.round(sample.cpu * 10_000) / 10_000,
      memory: sample.memory,
      ...(sample.memoryAvailableRatio === undefined ? {} : {
        memoryAvailableRatio: Math.round(sample.memoryAvailableRatio * 10_000) / 10_000,
      }),
      eventLoopMs: Math.round(sample.eventLoopMs * 100) / 100,
      sampleCredits: credits,
      sampleApplied: applied,
    }
  }

  /**
   * Wait for a committed pressure or completion update without a database checkout.
   * @param cursor - revision observed before the previous durable queue lookup.
   * @param timeoutMs - maximum wait within the caller's HTTP deadline.
   * @param signal - request cancellation.
   * @returns true when a wait slot was available or the cursor had already advanced. False asks the caller to use periodic polling.
   */
  async waitForChange(cursor: string, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted()
    if (cursor !== this.changeCursor) return true
    if (this.changeWaiters.size >= this.config.maxQueued) return false
    let wake!: () => void
    const waiting = new Promise<void>(resolve => { wake = resolve })
    const timer = setTimeout(wake, timeoutMs)
    timer.unref()
    const aborted = addAbortListener(signal, wake)
    this.changeWaiters.add(wake)
    try { await waiting; signal.throwIfAborted(); return true }
    finally {
      this.changeWaiters.delete(wake)
      clearTimeout(timer)
      aborted[Symbol.dispose]()
    }
  }

  /**
   * Apply the node's current deployment settings without releasing existing reservations.
   * Every coordinator reads these same durable limits while holding the node lock.
   * @returns completion after the configured limits commit.
   */
  async configure(): Promise<void> {
    await this.lock(async client => {
      await client.query(`UPDATE harness.node_resource_state SET limits=$3::jsonb,credits=0,valid_until=NULL,sampled_at=NULL,sampled_before=NULL
        WHERE ${NODE} AND limits IS DISTINCT FROM $3::jsonb`,
        [this.organizationId, this.nodeId, JSON.stringify(this.config)])
      await this.schedule(client)
    })
    this.lastObservation = undefined
    this.lastObservationErrorAt = undefined
  }

  /**
   * Publish pressure capture bounds; normal observations cannot multiply start credits.
   * @param observation - local monotonic capture and host metrics, never supplied by a Runtime.
   * @param writeEpoch - this Gateway's serving epoch; an initial database starts at epoch one.
   * @returns completion after fair queued admissions commit.
   */
  async observe(observation: NodePressureObservation, writeEpoch = 1n): Promise<void> {
    const { capturedAt, ...sample } = observation
    // One server call carries the whole round: capture age at dispatch bounds the
    // sample the same way the former pre/post-lock pair did for the lock queue.
    const elapsed = performance.now() - capturedAt
    try {
      const { rows: [round] } = await this.pool.query<{ observed: { applied: boolean } }>(
        `SELECT harness.observe_node_resources($1,$2,$3::jsonb,$4,$5::jsonb) AS observed
           FROM harness.organizations organization
           LEFT JOIN harness.cluster_control control ON control.organization_id=organization.id
          WHERE organization.id=$1 AND COALESCE(control.mode,'serving')='serving'
            AND COALESCE(control.write_epoch,1)=$6`,
        [this.organizationId, this.nodeId, JSON.stringify(sample), elapsed, JSON.stringify(this.config), String(writeEpoch)])
      const applied = round?.observed.applied === true
      this.lastObservation = {
        capturedAt,
        applied,
        sample,
        credits: pressureCredits(sample, this.config),
      }
      this.lastObservationErrorAt = undefined
      if (applied) this.signalChange()
    } catch (error) {
      this.lastObservationErrorAt = performance.now()
      if (!isDatabaseContentionError(error)) throw error
      throw new NodeResourceBudgetError(503, 'database-busy', 'Resource accounting is busy. Retry after the current operation settles.', { cause: error })
    }
  }

  /**
   * Spend one fresh node start credit immediately before allocating a Runtime.
   * Preparation owns no process; admitted or unverified generations still block unregistered execution.
   * @param target - server-selected Runtime assignment; an explicit RuntimeId must match the allocation row.
   * @param generation - exact stopped-to-starting claim retained by the launcher.
   * @param signal - cancellation before allocation.
   * @returns completion after a fresh credit and the allocation intent commit.
   */
  async admitRuntimeStart(target: RuntimeTarget, generation: number, signal: AbortSignal): Promise<void> {
    const started = performance.now()
    for (;;) {
      if (signal.aborted) throw new RuntimeCapacityError('cancelled')
      let result: { admitted: boolean; sampleMs: number; maxWaitMs: number }
      try {
        result = await transaction(this.pool, async client => {
          const response = await client.query<RuntimeStartAdmission>(
            'SELECT * FROM harness.admit_runtime_start($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',
            [this.organizationId, this.nodeId, target.kind, target.id, generation, target.runtimeId ?? null,
              JSON.stringify(this.config), performance.now() - started],
          )
          const admission = response.rows[0]!
          const limits = resourceLimits.parse(admission.limits)
          switch (admission.state) {
            case 'stale-generation': throw new NodeResourceBudgetError(409, 'stale-generation', 'Runtime allocation is no longer pending')
            case 'timeout': throw new RuntimeCapacityError('timeout')
            case 'waiting': case 'admitted': return {
              admitted: admission.state === 'admitted', sampleMs: limits.sampleMs, maxWaitMs: limits.maxWaitMs,
            }
            default: return assertNever(admission.state)
          }
        })
      } catch (error) {
        if (!isDatabaseContentionError(error)) throw error
        throw new NodeResourceBudgetError(503, 'database-busy', 'Resource accounting is busy. Retry after the current operation settles.', { cause: error })
      }
      if (signal.aborted) throw new RuntimeCapacityError('cancelled')
      if (performance.now() - started >= result.maxWaitMs) throw new RuntimeCapacityError('timeout')
      if (result.admitted) return
      const remaining = result.maxWaitMs - (performance.now() - started)
      if (remaining <= 0) throw new RuntimeCapacityError('timeout')
      try { await delay(Math.min(result.sampleMs, remaining), undefined, { signal }) } catch (error) {
        if (signal.aborted) throw new RuntimeCapacityError('cancelled')
        throw error
      }
    }
  }

  /**
   * Register the current Runtime generation before it can claim any execution budget.
   * Stored-policy validation and registration share one transaction.
   * @param subject - authenticated Runtime belonging to this node.
   * @returns the next serial registration sequence; active reservations remain intact.
   */
  async register(subject: RuntimeCredentialSubject): Promise<{ nextSequence: number; policy: NodeResourceBudgetConfig }> {
    const owner = this.owner(subject)
    try {
      return await transaction(this.pool, async client => {
        const result = await client.query<{ next_sequence: string; limits: unknown }>(
          'SELECT * FROM harness.register_runtime_resources($1,$2,$3,$4,$5,$6,$7::jsonb)',
          [...owner, subject.target.runtimeId ?? null, JSON.stringify(this.config)],
        )
        const row = result.rows[0]!
        return { nextSequence: Number(row.next_sequence), policy: resourceLimits.parse(row.limits) }
      })
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === '55000' && 'constraint' in error) {
        if (error.constraint === 'node_resource_registration_generation') {
          throw new NodeResourceBudgetError(409, 'stale-generation', 'resource Runtime generation is no longer current', { cause: error })
        }
        if (error.constraint === 'node_resource_registration_identity') {
          throw new NodeResourceBudgetError(409, 'stale-generation', 'Runtime resource registration belongs to another environment', { cause: error })
        }
      }
      if (!isDatabaseContentionError(error)) throw error
      throw new NodeResourceBudgetError(503, 'database-busy', 'Resource accounting is busy. Retry after the current operation settles.', { cause: error })
    }
  }

  /**
   * Register a model-only Gateway owner after acquiring its kernel lock.
   * @param ownerId - unique lock filename retained through all request cleanup.
   * @param witness - locked descriptor's device and inode.
   * @returns durable process generation, independent of Runtime generations.
   */
  async registerGateway(ownerId: GatewayResourceOwnerId, witness: GatewayResourceLock): Promise<GatewayResourceOwner> {
    return this.lock(async client => {
      const result = await client.query<{ generation: string; device: string; inode: string }>(`INSERT INTO harness.node_resource_gateways
        (organization_id,node_id,owner_id,device,inode) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT (organization_id,node_id,owner_id) DO UPDATE SET owner_id=excluded.owner_id
        RETURNING generation::text,device,inode`, [this.organizationId, this.nodeId, ownerId, witness.device, witness.inode])
      const row = result.rows[0]!
      if (row.device !== witness.device || row.inode !== witness.inode) throw new Error('Gateway resource lock identity changed')
      const generation = Number(row.generation)
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Gateway resource generation exceeds the supported range')
      const owner = { organizationId: this.organizationId, ownerId, generation }
      await client.query(`INSERT INTO harness.node_resource_runtimes
        (organization_id,node_id,runtime_kind,runtime_public_id,generation) VALUES($1,$2,'gateway',0,$3) ON CONFLICT DO NOTHING`,
      [this.organizationId, this.nodeId, generation])
      return owner
    })
  }

  /**
   * Read local Gateway owners without assuming a missing heartbeat means process death.
   * @returns identities whose reservations require completion or matching kernel-lock recovery.
   */
  async gateways(): Promise<Array<GatewayResourceOwner & GatewayResourceLock>> {
    const result = await this.pool.query<{ owner_id: GatewayResourceOwnerId; generation: string; device: string; inode: string }>(
      `SELECT owner_id,generation::text,device,inode FROM harness.node_resource_gateways WHERE ${NODE}`,
      [this.organizationId, this.nodeId])
    return result.rows.map(row => ({ organizationId: this.organizationId, ownerId: row.owner_id,
      generation: Number(row.generation), device: row.device, inode: row.inode }))
  }

  /**
   * Reclaim a Gateway after its model callbacks settled, or after its exact inode was exclusively locked by recovery.
   * @param subject - process generation whose physical ownership was confirmed ended.
   * @returns completion after durable cleanup and fair wakeup.
   */
  async gatewayStopped(subject: GatewayResourceOwner): Promise<void> {
    await this.lock(async client => {
      const owner = this.owner(subject)
      const current = await client.query(`SELECT 1 FROM harness.node_resource_gateways WHERE ${NODE} AND owner_id=$3 AND generation=$4 FOR UPDATE`,
        [this.organizationId, this.nodeId, subject.ownerId, subject.generation])
      if (current.rowCount === 0) return
      const removed = await client.query(`DELETE FROM harness.node_resource_requests WHERE ${OWNER} RETURNING state`, owner)
      await client.query(`DELETE FROM harness.node_resource_runtimes WHERE ${OWNER}`, owner)
      await client.query(`DELETE FROM harness.node_resource_gateways WHERE ${NODE} AND owner_id=$3 AND generation=$4`,
        [this.organizationId, this.nodeId, subject.ownerId, subject.generation])
      await client.query(`UPDATE harness.node_resource_state SET reclaimed=reclaimed+$3 WHERE ${NODE}`,
        [this.organizationId, this.nodeId, removed.rowCount ?? 0])
      await this.schedule(client)
    })
  }

  /**
   * Serialize registration, fair selection and the durable reservation under one node lock.
   * @param subject - current authenticated Runtime generation.
   * @param request - bounded metadata whose actor and project were resolved by the Gateway.
   * @param personalFence - for a scoped personal model request, verify the exact bearer, serving epoch and immutable scope in the reservation transaction. A matching stored policy permits one database round trip. Other origins use their verified attribution.
   * @returns bounded admission, idempotent replay, or explicit refusal.
   */
  async request(subject: ResourceOwner, request: NodeResourceRequest, personalFence?: PersonalExecutionWriteFence): Promise<NodeResourceStatus> {
    if ('ownerId' in subject && request.kind !== 'model') throw new Error('Gateway process ownership supports model requests only')
    if (personalFence !== undefined && ('ownerId' in subject || subject.target.kind !== 'user' || subject.target.runtimeId === undefined
      || request.kind !== 'model' || request.origin !== 'session' || request.sessionId === undefined || request.scopeId === undefined
      || request.actorId !== subject.target.id || request.projectId !== 0 || request.administrative !== false)) {
      throw new Error('Personal model reservation requires its exact Runtime, actor and Session scope')
    }
    const owner = this.owner(subject)
    const fingerprint = createHash('sha256').update(JSON.stringify([request.requestId, request.kind, request.actorId,
      request.projectId, request.sessionId ?? null, request.scopeId ?? null, request.origin ?? null, request.administrative ?? false])).digest('hex')
    const bytes = Buffer.byteLength(JSON.stringify({ ...request, owner }))
    const parameters = [...owner, ...this.exactOwner(subject), JSON.stringify(this.config), request.sequence, request.requestId,
      request.kind, request.actorId, request.projectId, request.sessionId ?? null, fingerprint, bytes,
      request.scopeId ?? null, request.origin ?? null, request.administrative ?? false,
      ...(personalFence === undefined ? [] : [createHash('sha256').update(personalFence.bearer).digest(), String(personalFence.epoch)])]
    if (personalFence !== undefined) {
      try {
        const { rows: [row] } = await this.pool.query<ReservationRow>(scopedPersonalResourceWithConfiguredPolicySql, parameters)
        if (row !== undefined) return this.reservationStatus(row)
      } catch (error) {
        this.admissionError(error)
      }
    }
    return this.admissionTransaction(async client => {
      const { rows: [row] } = await client.query<ReservationRow>(
        personalFence === undefined ? `SELECT * FROM ${resourceRequestSql('$6')}` : scopedPersonalResourceSql,
        parameters,
      )
      return this.reservationStatus(row!)
    })
  }

  private reservationStatus(row: ReservationRow): NodeResourceStatus {
    resourceLimits.parse(row.limits)
    return resourceStatusSchema.parse(row.refusal === null ? { state: row.state } : { state: row.state, reason: row.refusal })
  }

  /**
   * Observe admission after applying expiry and newly available reservations.
   * @param subject - current Runtime generation.
   * @param operation - exact registered sequence and operation identity.
   * @returns durable state, or closed after completion, cancellation or queue expiry.
   */
  async status(subject: ResourceOwner, operation: Pick<NodeResourceRequest, 'sequence' | 'requestId'>): Promise<NodeResourceStatus> {
    const [admission] = await this.admissions(subject, [operation])
    return admission!.status
  }

  /**
   * Read all pending requests in one Runtime poll.
   * @param subject - authenticated current generation.
   * @param operations - byte-bounded sequence and operation identities.
   * @returns matching durable states in request order.
   */
  async statuses(subject: RuntimeCredentialSubject, operations: readonly Pick<NodeResourceRequest, 'sequence' | 'requestId'>[]): Promise<NodeResourceStatus[]> {
    return (await this.admissions(subject, operations)).map(admission => admission.status)
  }

  /**
   * Read a personal model reservation with the same current authorization required at dispatch.
   * @param subject - authenticated Runtime and exact generation.
   * @param operation - sequence and matching operation ID.
   * @param fence - current bearer and write epoch checked by the execution authority.
   * @param includeQueued - accept an unexpired queued reservation when the client waits for committed scheduler updates.
   * @returns a qualified active or queued state, or undefined for ordinary accounting and qualification.
   */
  async checkPersonalModel(subject: RuntimeCredentialSubject, operation: Pick<NodeResourceRequest, 'sequence' | 'requestId'>,
    fence: PersonalExecutionWriteFence, includeQueued: boolean): Promise<{ state: 'queued' | 'active'; queueMs: number | null } | undefined> {
    const runtimeId = subject.target.runtimeId
    if (subject.target.kind !== 'user' || runtimeId === undefined || subject.contentBinding !== undefined) return
    const [organization, node, kind, actor, generation] = this.owner(subject)
    try {
      const { rows: [row] } = await this.pool.query<{ state: 'queued' | 'active'; queue_ms: number | null }>(qualifiedPersonalModelSql,
        [organization, node, kind, actor, generation, runtimeId, operation.sequence, operation.requestId,
          createHash('sha256').update(fence.bearer).digest(), String(fence.epoch), JSON.stringify(this.config), includeQueued])
      if (row !== undefined) return { state: row.state, queueMs: row.queue_ms }
    } catch (error) {
      // Let the ordinary status path handle authority refusal and maintenance.
      if (error instanceof Error && 'code' in error && (error.code === 'P4101' || error.code === 'P4104')) return
      this.admissionError(error)
    }
  }

  /**
   * Read accounting and captured origins before checking authority outside the node transaction.
   * @param subject - authenticated current generation.
   * @param operations - exact caller-owned operation references.
   * @returns same-order records; legacy origins remain absent and cannot authorize dispatch.
   */
  async admissions(subject: ResourceOwner, operations: readonly Pick<NodeResourceRequest, 'sequence' | 'requestId'>[]): Promise<NodeResourceAdmission[]> {
    return this.admissionTransaction(async client => {
      const { rows: [row] } = await client.query<{ limits: unknown; admissions: AdmissionRow[] }>(
        'SELECT * FROM harness.read_node_resource_admissions($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',
        [...this.owner(subject), ...this.exactOwner(subject), JSON.stringify(this.config), operations.map(operation => operation.sequence)],
      )
      resourceLimits.parse(row!.limits)
      const states = new Map(row!.admissions.map(row => [Number(row.sequence), row]))
      return operations.map(operation => {
        const row = states.get(operation.sequence)
        if (row !== undefined && row.operation_id !== operation.requestId) throw new NodeResourceBudgetError(409, 'owner-mismatch', 'resource operation does not own this sequence')
        if (row === undefined) return { status: { state: 'closed' } }
        const status: NodeResourceStatus = { state: row.state }
        switch (row.origin_kind) {
          case null: return { status }
          case 'runtime': return { status, origin: { kind: 'runtime' } }
          case 'principal': return { status, origin: { kind: 'principal', actorId: Number(row.actor_public_id), administrative: row.principal_admin } }
          case 'session': {
            if (row.session_id === null) throw new NodeResourceBudgetError(409, 'unknown-operation', 'resource execution origin is incomplete')
            return { status, origin: { kind: 'session', sessionId: row.session_id,
              ...(row.scope_id === null ? {} : { scopeId: row.scope_id }) } }
          }
          default: return assertNeverOrigin(row.origin_kind)
        }
      })
    })
  }

  /**
   * Report local quiescence or unstarted cancellation; neither a disconnect nor a timeout calls this operation.
   * @param subject - authenticated Runtime owning this operation.
   * @param operation - exact operation, including a cancelled registration in flight.
   * @param outcome - caller-proven completion or uncertainty that retains occupation.
   * @returns confirmation after accounting and any next grants commit under the current owner.
   */
  async finish(subject: ResourceOwner, operation: Pick<NodeResourceRequest, 'sequence' | 'requestId'>, outcome: 'quiescent' | 'not-started' | 'uncertain'): Promise<void> {
    if (outcome === 'quiescent') {
      let applied: boolean
      try {
        const { rows: [row] } = await this.pool.query<{ applied: boolean }>(
          'SELECT harness.complete_quiescent_node_resource($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) AS applied',
          [...this.owner(subject), ...this.exactOwner(subject), operation.sequence, operation.requestId, JSON.stringify(this.config)],
        )
        applied = row!.applied
      } catch (error) { this.admissionError(error) }
      if (applied) { this.signalChange(); return }
    }
    await this.lock(async client => {
      const { sequence, requestId } = operation
      const owner = this.owner(subject), key = [...owner, sequence]
      const receipt = await client.query<{ last_sequence: string; owner_mismatch: boolean }>(
        outcome === 'quiescent' ? completeResourceSql : completionReceiptSql, [...key, requestId],
      )
      const last = Number(receipt.rows[0]?.last_sequence ?? -1)
      if (last < 0 || sequence > last + 1 || (sequence === last + 1 && outcome !== 'not-started')) throw new NodeResourceBudgetError(409, 'unknown-operation', 'unknown resource completion sequence')
      if (receipt.rows[0]?.owner_mismatch) throw new NodeResourceBudgetError(409, 'owner-mismatch', 'resource operation does not own this sequence')
      if (sequence === last + 1) await client.query(`UPDATE harness.node_resource_runtimes SET last_sequence=$6 WHERE ${OWNER}`, key)
      if (outcome === 'uncertain') {
        await client.query(`UPDATE harness.node_resource_requests SET state='uncertain' WHERE ${REQUEST} AND state='active'`, key)
      } else if (outcome === 'not-started') {
        const removed = await client.query(`DELETE FROM harness.node_resource_requests WHERE ${REQUEST} RETURNING state`, key)
        if (removed.rowCount !== 0) await client.query(`UPDATE harness.node_resource_state SET cancelled=cancelled+1 WHERE ${NODE}`, [this.organizationId, this.nodeId])
      }
      await this.schedule(client)
      // Keep the ownership row locked only through commit. Browser admission also needs this row.
      await this.current(client, subject)
    })
    if (outcome !== 'uncertain') this.signalChange()
  }

  /**
   * Reclaim only generations whose managed process tree has been confirmed stopped.
   * @param target - exact user/project Runtime.
   * @param generation - highest confirmed stopped generation of this Runtime; other environments retain occupation.
   * @param registration - retain an empty registration while destructive work keeps the assignment stopping; remove it after stopped publication or catalog removal. Omission removes it.
   * @returns completion after durable cleanup and fair wakeup.
   */
  async stopped(target: RuntimeTarget, generation: number, registration: 'remove' | 'retain' = 'remove'): Promise<void> {
    await this.lock(async client => {
      const runtimeId = await this.stoppedRuntime(client, target, generation)
      const args = [this.organizationId, this.nodeId, target.kind, target.id, generation, runtimeId]
      const removed = await client.query(`DELETE FROM harness.node_resource_requests request USING harness.node_resource_runtimes runtime
        WHERE request.organization_id=$1 AND request.node_id=$2 AND request.runtime_kind=$3 AND request.runtime_public_id=$4 AND request.generation<=$5
          AND runtime.organization_id=request.organization_id AND runtime.node_id=request.node_id AND runtime.runtime_kind=request.runtime_kind
          AND runtime.runtime_public_id=request.runtime_public_id AND runtime.generation=request.generation AND runtime.runtime_id=$6
        RETURNING request.state`, args)
      await client.query(`DELETE FROM harness.node_resource_runtimes WHERE ${NODE} AND runtime_kind=$3 AND runtime_public_id=$4
        AND generation<=$5 AND runtime_id=$6 AND ($7='remove' OR generation<>$5)`, [...args, registration])
      if (registration === 'retain') await client.query(`INSERT INTO harness.node_resource_runtimes
        (organization_id,node_id,runtime_kind,runtime_public_id,generation,runtime_id) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT DO NOTHING`, args)
      await client.query(`UPDATE harness.node_resource_state SET reclaimed=reclaimed+$3 WHERE ${NODE}`, [this.organizationId, this.nodeId, removed.rowCount ?? 0])
      await this.schedule(client)
    })
  }

  /**
   * Refuse proxy reuse of a Runtime that cannot participate in node accounting.
   * @param target - live Runtime selected by the proxy.
   * @param generation - selected live generation.
   * @returns true only after its node-budget provider has registered.
   */
  async registered(target: RuntimeTarget, generation: number): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM harness.node_resource_runtimes WHERE ${OWNER} AND ($6::uuid IS NULL OR runtime_id=$6)`,
      [this.organizationId, this.nodeId, target.kind, target.id, generation, target.runtimeId ?? null])
    return result.rowCount === 1
  }

  /** @returns identifier-free current counts and cumulative node admission outcomes. */
  async snapshot() {
    const rows = await this.pool.query<{ kind: ResourceKind; state: string; count: string; bytes: string; age_ms: number }>(`SELECT kind,state,count(*)::text count,
      COALESCE(sum(queued_bytes),0)::text bytes,COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-created_at)*1000),0)::float8 age_ms
      FROM harness.node_resource_requests WHERE ${NODE} GROUP BY kind,state`, [this.organizationId, this.nodeId])
    const stats = await this.pool.query<{ limits: unknown } & Record<string, unknown>>(`SELECT admitted::text,rejected::text,completed::text,cancelled::text,timed_out::text,reclaimed::text,runtime_starts_admitted::text,
      wait_ms_total,wait_ms_max,limits FROM harness.node_resource_state WHERE ${NODE}`, [this.organizationId, this.nodeId])
    const kinds = Object.fromEntries(KINDS.map(kind => [kind, { active: 0, queued: 0, uncertain: 0, queuedBytes: 0, oldestQueuedMs: 0 }])) as Record<ResourceKind, { active: number; queued: number; uncertain: number; queuedBytes: number; oldestQueuedMs: number }>
    for (const row of rows.rows) {
      const kind = kinds[row.kind], count = Number(row.count)
      if (row.state === 'queued') { kind.queued = count; kind.queuedBytes = Number(row.bytes); kind.oldestQueuedMs = row.age_ms }
      else { kind.active += count; if (row.state === 'uncertain') kind.uncertain = count }
    }
    return { limits: stats.rows[0] === undefined ? this.config : resourceLimits.parse(stats.rows[0].limits), kinds, outcomes: Object.fromEntries(Object.entries(stats.rows[0] ?? {}).filter(([key]) => key !== 'limits').map(([key, value]) => [key, Number(value)])), unregisteredRuntimes: await this.unregistered(this.pool) }
  }

  private owner(subject: ResourceOwner): [string, string, 'user' | 'project' | 'gateway', number, number] {
    if (subject.organizationId !== this.organizationId) throw new NodeResourceBudgetError(403, 'organization-mismatch', 'resource Runtime belongs to another organization')
    if ('ownerId' in subject) return [this.organizationId, this.nodeId, 'gateway', 0, subject.generation]
    return [this.organizationId, this.nodeId, subject.target.kind, subject.target.id, subject.generation]
  }

  private exactOwner(subject: ResourceOwner): [RuntimeId | null, GatewayResourceOwnerId | null] {
    return 'ownerId' in subject ? [null, subject.ownerId] : [subject.target.runtimeId ?? null, null]
  }

  private async current(client: PoolClient, subject: ResourceOwner): Promise<void> {
    await client.query('SELECT harness.lock_current_node_resource_owner($1,$2,$3,$4,$5,$6,$7,true)',
      [...this.owner(subject), ...this.exactOwner(subject)])
  }

  private async stoppedRuntime(client: PoolClient, target: RuntimeTarget, generation: number): Promise<RuntimeId> {
    if (target.runtimeId !== undefined) return target.runtimeId
    const args = [this.organizationId, this.nodeId, target.kind, target.id, generation]
    const registered = await client.query<{ runtime_id: RuntimeId | null }>(`SELECT runtime_id FROM harness.node_resource_runtimes
      WHERE ${OWNER}`, args)
    if (registered.rows[0]?.runtime_id !== undefined && registered.rows[0].runtime_id !== null) return registered.rows[0].runtime_id
    const assigned = await client.query<{ runtime_id: RuntimeId }>(`SELECT i.runtime_id FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=$3
        AND COALESCE(u.public_id,p.public_id)=$4 AND i.generation=$5 LIMIT 2`, args)
    if (assigned.rows.length !== 1) throw new NodeResourceBudgetError(409, 'stale-generation', 'Stopped resource cleanup requires an exact Runtime identity')
    return assigned.rows[0]!.runtime_id
  }

  private async lock<T>(work: (client: PoolClient, limits: NodeResourceBudgetConfig) => Promise<T>): Promise<T> {
    try {
      return await transaction(this.pool, async client => {
        const state = await client.query<{ limits: unknown }>(
          'SELECT harness.lock_node_resources($1,$2,$3::jsonb) AS limits',
          [this.organizationId, this.nodeId, JSON.stringify(this.config)],
        )
        const limits = resourceLimits.parse(state.rows[0]!.limits)
        return work(client, limits)
      }, undefined, { lockWait: 'statement' })
    } catch (error) {
      this.admissionError(error)
    }
  }

  private async admissionTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await transaction(this.pool, work)
    } catch (error) {
      this.admissionError(error)
    }
  }

  private admissionError(error: unknown): never {
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
      const reason = admissionErrors.get(error.code)
      if (reason !== undefined) throw new NodeResourceBudgetError(409, reason, error.message, { cause: error })
    }
    if (!isDatabaseContentionError(error)) throw error
    throw new NodeResourceBudgetError(503, 'database-busy', 'Resource accounting is busy. Retry after the current operation settles.', { cause: error })
  }

  private async unregistered(database: Pick<Pool, 'query'> | PoolClient): Promise<number> {
    const result = await database.query<{ count: string }>(`SELECT count(*)::text count FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.observed_state IN ('ready','starting','stopping')
        AND NOT (i.observed_state='starting' AND i.allocation_state IN ('not-started','waiting'))
        AND NOT EXISTS(SELECT 1 FROM harness.node_resource_runtimes r WHERE r.organization_id=i.organization_id AND r.node_id=i.assigned_node_id
          AND r.runtime_kind=CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END AND r.runtime_public_id=COALESCE(u.public_id,p.public_id)
          AND r.generation=i.generation AND r.runtime_id=i.runtime_id)`, [this.organizationId, this.nodeId])
    return Number(result.rows[0]!.count)
  }

  private async schedule(client: PoolClient): Promise<void> {
    await client.query('SELECT harness.schedule_node_resources($1,$2)', [this.organizationId, this.nodeId])
  }
}

function assertNeverOrigin(_origin: never): never {
  throw new Error('unsupported resource origin')
}
