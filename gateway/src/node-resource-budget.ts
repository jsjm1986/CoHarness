/** Durable node-wide admission with equal-user, per-user project round robin. */
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Pool, PoolClient } from 'pg'
import type { ResourceKind, ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { resourcePolicySchema, type ResourceStatus } from '@deepseek-ai/dsh-resource-budget/wire'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { RuntimeTarget } from './instances.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { pressureCredits, type NodePressureConfig, type NodePressureObservation } from './node-resource-pressure.ts'
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

interface Row {
  runtime_kind: 'user' | 'project' | 'gateway'
  runtime_public_id: string
  generation: string
  sequence: string
  operation_id: ResourceOperationId | null
  kind: ResourceKind
  actor_public_id: string
  project_public_id: string
  session_id: string | null
  scope_id: string | null
  origin_kind: NonNullable<NodeResourceRequest['origin']> | null
  principal_admin: boolean
  fingerprint: string
  state: 'queued' | 'active' | 'uncertain'
  user_turn: string
  project_turn: string
  queued_bytes: number
  wait_ms: number
}

const NODE = 'organization_id=$1 AND node_id=$2'
const OWNER = `${NODE} AND runtime_kind=$3 AND runtime_public_id=$4 AND generation=$5`
const REQUEST = `${OWNER} AND sequence=$6`

/** PostgreSQL owns reservations; no Gateway-local timer or lease expiry can release running work. */
export class NodeResourceBudget {
  constructor(
    private readonly pool: Pool,
    private readonly organizationId: string,
    private readonly nodeId: string,
    readonly config: NodeResourceBudgetConfig,
  ) {
    resourceLimits.parse(config)
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
  }

  /**
   * Publish pressure capture bounds; normal observations cannot multiply start credits.
   * @param observation - local monotonic capture and host metrics, never supplied by a Runtime.
   * @returns completion after fair queued admissions commit.
   */
  async observe(observation: NodePressureObservation): Promise<void> {
    await this.lock(async (client, limits) => {
      const { capturedAt, ...sample } = observation
      const before = performance.now() - capturedAt
      if (before >= limits.staleMs) return
      const clock = (await client.query<{ observed_at: string }>('SELECT clock_timestamp()::text observed_at')).rows[0]!.observed_at
      // The two ages enclose capture time despite transit; the lower bound owns credit expiration.
      const age = performance.now() - capturedAt
      if (age >= limits.staleMs) return
      const changed = await client.query(`WITH observation AS MATERIALIZED (
        SELECT $4::timestamptz-$5::double precision*interval '1 millisecond' captured_at,
          $4::timestamptz-$6::double precision*interval '1 millisecond' captured_before
      ) UPDATE harness.node_resource_state SET pressure=$3::jsonb,sampled_at=observation.captured_at,
        sampled_before=GREATEST(sampled_before,observation.captured_before),
        valid_until=CASE WHEN $8=0 THEN GREATEST(valid_until,observation.captured_at+$7*interval '1 millisecond')
          ELSE observation.captured_at+$7*interval '1 millisecond' END,credits=$8 FROM observation WHERE ${NODE}
        AND observation.captured_at+$7*interval '1 millisecond'>clock_timestamp()
        AND ($8=0 OR sampled_before IS NULL OR sampled_before<=observation.captured_at-$9*interval '1 millisecond') RETURNING node_id`,
      [this.organizationId, this.nodeId, JSON.stringify(sample), clock, age, before, limits.staleMs, pressureCredits(sample, limits), limits.sampleMs])
      if (changed.rowCount !== 0) await this.schedule(client)
    })
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
      const result = await this.lock(async (client, limits) => {
        const args = [this.organizationId, this.nodeId, target.kind, target.id, generation, target.runtimeId ?? null]
        const current = await client.query<{ id: string; allocation_state: string }>(`SELECT i.id,i.allocation_state FROM harness.instances i
          LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
          WHERE i.organization_id=$1 AND i.assigned_node_id=$2
            AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=$3
            AND COALESCE(u.public_id,p.public_id)=$4 AND i.generation=$5
            AND ($6::uuid IS NULL OR i.runtime_id=$6)
            AND i.observed_state='starting' AND i.desired_state='running'
            AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch)
          FOR UPDATE OF i`, args)
        const allocation = current.rows[0]
        if (allocation === undefined || (allocation.allocation_state !== 'not-started' && allocation.allocation_state !== 'waiting')) {
          throw new NodeResourceBudgetError(409, 'stale-generation', 'Runtime allocation is no longer pending')
        }
        await client.query("UPDATE harness.instances SET allocation_state='waiting',updated_at=now() WHERE id=$1", [allocation.id])
        await this.schedule(client)
        if (performance.now() - started >= limits.maxWaitMs) throw new RuntimeCapacityError('timeout')
        if (await this.unregistered(client) !== 0) {
          return { admitted: false, sampleMs: limits.sampleMs, maxWaitMs: limits.maxWaitMs }
        }
        const credit = await client.query(`UPDATE harness.node_resource_state SET credits=credits-1,
          runtime_starts_admitted=runtime_starts_admitted+1 WHERE ${NODE} AND credits>0 AND valid_until>clock_timestamp()
          RETURNING node_id`, [this.organizationId, this.nodeId])
        if (credit.rowCount !== 1) return { admitted: false, sampleMs: limits.sampleMs, maxWaitMs: limits.maxWaitMs }
        await client.query("UPDATE harness.instances SET allocation_state='possible',updated_at=now() WHERE id=$1", [allocation.id])
        return { admitted: true, sampleMs: limits.sampleMs, maxWaitMs: limits.maxWaitMs }
      })
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
   * @param subject - authenticated Runtime belonging to this node.
   * @returns the next serial registration sequence; active reservations remain intact.
   */
  async register(subject: RuntimeCredentialSubject): Promise<{ nextSequence: number; policy: NodeResourceBudgetConfig }> {
    return this.lock(async (client, limits) => {
      const runtimeId = (await this.current(client, subject))!
      await client.query(`INSERT INTO harness.node_resource_runtimes
        (organization_id,node_id,runtime_kind,runtime_public_id,generation,runtime_id) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(organization_id,node_id,runtime_kind,runtime_public_id,generation) DO UPDATE SET runtime_id=excluded.runtime_id
          WHERE harness.node_resource_runtimes.runtime_id IS NULL OR harness.node_resource_runtimes.runtime_id=excluded.runtime_id`,
      [...this.owner(subject), runtimeId])
      const result = await client.query<{ last_sequence: string }>(`SELECT last_sequence::text FROM harness.node_resource_runtimes
        WHERE ${OWNER} AND runtime_id=$6`, [...this.owner(subject), runtimeId])
      if (result.rows[0] === undefined) throw new NodeResourceBudgetError(409, 'stale-generation', 'Runtime resource registration belongs to another environment')
      return { nextSequence: Number(result.rows[0]!.last_sequence) + 1, policy: limits }
    })
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
   * @returns bounded admission, idempotent replay, or explicit refusal.
   */
  async request(subject: ResourceOwner, request: NodeResourceRequest): Promise<NodeResourceStatus> {
    if ('ownerId' in subject && request.kind !== 'model') throw new Error('Gateway process ownership supports model requests only')
    return this.lock(async (client, limits) => {
      const runtimeId = await this.current(client, subject)
      const owner = this.owner(subject)
      const key = [...owner, request.sequence]
      const fingerprint = createHash('sha256').update(JSON.stringify([request.requestId, request.kind, request.actorId,
        request.projectId, request.sessionId ?? null, request.scopeId ?? null, request.origin ?? null, request.administrative ?? false])).digest('hex')
      const previous = await client.query<Row>(`SELECT * FROM harness.node_resource_requests WHERE ${REQUEST}`, [...key])
      if (previous.rows[0] !== undefined) {
        if (previous.rows[0].fingerprint !== fingerprint) throw new NodeResourceBudgetError(409, 'request-conflict', 'resource request conflicts with its first registration')
        await this.schedule(client)
        return this.read(client, key, request.requestId)
      }
      const counter = await client.query<{ last_sequence: string }>(`SELECT last_sequence::text FROM harness.node_resource_runtimes WHERE ${OWNER}`, owner)
      const last = counter.rows[0]?.last_sequence
      if (last === undefined) throw new NodeResourceBudgetError(409, 'unregistered', 'resource Runtime is not registered')
      if (request.sequence <= Number(last)) return { state: 'closed' }
      if (request.sequence !== Number(last) + 1) throw new NodeResourceBudgetError(409, 'sequence-gap', 'resource registration sequence is not contiguous')
      const duplicate = await client.query(`SELECT 1 FROM harness.node_resource_requests WHERE ${OWNER} AND operation_id=$6::uuid`,
        [...owner, request.requestId])
      if (duplicate.rowCount !== 0) throw new NodeResourceBudgetError(409, 'operation-conflict', 'resource operation is already registered at another sequence')
      await client.query(`UPDATE harness.node_resource_runtimes SET last_sequence=$6 WHERE ${OWNER}`, key)
      await this.schedule(client)
      const legacy = await this.unregistered(client)
      const existing = await this.rows(client)
      const waiting = existing.filter(row => row.state === 'queued')
      const occupied = existing.filter(row => row.kind === request.kind && row.state !== 'queued')
      const immediate = legacy === 0 && !waiting.some(row => row.kind === request.kind) && await this.hasCredits(client)
      if (!immediate) {
        // A nested producer cannot wait for the same exhausted resource class while retaining its parent.
        if ('target' in subject && request.sessionId !== undefined && !await this.hasCredits(client)) {
          const ancestors = await client.query<{ session_id: string }>(`WITH RECURSIVE chain AS (
            SELECT session_id,parent_session_id FROM harness.execution_sessions WHERE organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND session_id=$4 AND runtime_id=$5
            UNION ALL SELECT p.session_id,p.parent_session_id FROM harness.execution_sessions p JOIN chain c ON p.session_id=c.parent_session_id
              WHERE p.organization_id=$1 AND p.runtime_kind=$2 AND p.runtime_public_id=$3 AND p.runtime_id=$5
          ) SELECT session_id FROM chain`, [this.organizationId, subject.target.kind, subject.target.id, request.sessionId, runtimeId])
          const ids = new Set(ancestors.rows.map(row => row.session_id))
          if (occupied.some(row => row.runtime_kind === subject.target.kind && Number(row.runtime_public_id) === subject.target.id
            && Number(row.generation) === subject.generation && row.session_id !== null && ids.has(row.session_id))) {
            return this.refuse(client, 'nested-capacity')
          }
        }
        if (waiting.length >= limits.maxQueued) return this.refuse(client, 'queue-full')
        if (waiting.filter(row => Number(row.actor_public_id) === request.actorId).length >= limits.maxQueuedPerUser) return this.refuse(client, 'user-queue-full')
        if (request.projectId !== 0 && waiting.filter(row => Number(row.project_public_id) === request.projectId).length >= limits.maxQueuedPerProject) return this.refuse(client, 'project-queue-full')
      }
      const bytes = Buffer.byteLength(JSON.stringify({ ...request, owner: this.owner(subject) }))
      if (existing.reduce((total, row) => total + row.queued_bytes, 0) + bytes > limits.maxQueuedBytes) return this.refuse(client, 'queue-bytes')
      const turn = await this.turn(client)
      const sameUser = waiting.find(row => Number(row.actor_public_id) === request.actorId)
      const sameProject = waiting.find(row => Number(row.actor_public_id) === request.actorId && Number(row.project_public_id) === request.projectId)
      await client.query(`INSERT INTO harness.node_resource_requests
        (organization_id,node_id,runtime_kind,runtime_public_id,generation,sequence,operation_id,kind,actor_public_id,project_public_id,session_id,fingerprint,state,user_turn,project_turn,queued_bytes,deadline,scope_id,origin_kind,principal_admin)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'queued',$13,$14,$15,clock_timestamp()+$16*interval '1 millisecond',$17,$18,$19)`,
      [...key, request.requestId, request.kind, request.actorId, request.projectId, request.sessionId ?? null, fingerprint,
        sameUser?.user_turn ?? turn, sameProject?.project_turn ?? turn, bytes, limits.maxWaitMs,
        request.scopeId ?? null, request.origin ?? null, request.administrative ?? false])
      await this.schedule(client)
      return this.read(client, key, request.requestId)
    })
  }

  /**
   * Observe admission after applying expiry and newly available reservations.
   * @param subject - current Runtime generation.
   * @param operation - exact registered sequence and operation identity.
   * @returns durable state, or closed after completion, cancellation or queue expiry.
   */
  async status(subject: ResourceOwner, operation: Pick<NodeResourceRequest, 'sequence' | 'requestId'>): Promise<NodeResourceStatus> {
    return this.lock(async client => {
      await this.current(client, subject)
      await this.schedule(client)
      return this.read(client, [...this.owner(subject), operation.sequence], operation.requestId)
    })
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
   * Read accounting and captured origins before checking authority outside the node transaction.
   * @param subject - authenticated current generation.
   * @param operations - exact caller-owned operation references.
   * @returns same-order records; legacy origins remain absent and cannot authorize dispatch.
   */
  async admissions(subject: RuntimeCredentialSubject, operations: readonly Pick<NodeResourceRequest, 'sequence' | 'requestId'>[]): Promise<NodeResourceAdmission[]> {
    return this.lock(async client => {
      await this.current(client, subject)
      await this.schedule(client)
      const rows = await client.query<Pick<Row, 'sequence' | 'operation_id' | 'state' | 'origin_kind' | 'session_id' | 'scope_id'
        | 'actor_public_id' | 'principal_admin'>>(`SELECT sequence::text,operation_id::text,state,origin_kind,session_id,scope_id::text,
          actor_public_id::text,principal_admin
        FROM harness.node_resource_requests WHERE ${OWNER} AND sequence=ANY($6::bigint[])`,
      [...this.owner(subject), operations.map(operation => operation.sequence)])
      const states = new Map(rows.rows.map(row => [Number(row.sequence), row]))
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
   * @returns confirmation after accounting and any next grants commit.
   */
  async finish(subject: ResourceOwner, operation: Pick<NodeResourceRequest, 'sequence' | 'requestId'>, outcome: 'quiescent' | 'not-started' | 'uncertain'): Promise<void> {
    await this.lock(async client => {
      await this.current(client, subject, true)
      const { sequence, requestId } = operation
      const owner = this.owner(subject), key = [...owner, sequence]
      const counter = await client.query<{ last_sequence: string }>(`SELECT last_sequence::text FROM harness.node_resource_runtimes WHERE ${OWNER}`, owner)
      const last = Number(counter.rows[0]?.last_sequence ?? -1)
      if (last < 0 || sequence > last + 1 || (sequence === last + 1 && outcome !== 'not-started')) throw new NodeResourceBudgetError(409, 'unknown-operation', 'unknown resource completion sequence')
      await this.read(client, key, requestId)
      if (sequence === last + 1) await client.query(`UPDATE harness.node_resource_runtimes SET last_sequence=$6 WHERE ${OWNER}`, key)
      if (outcome === 'uncertain') {
        await client.query(`UPDATE harness.node_resource_requests SET state='uncertain' WHERE ${REQUEST} AND state='active'`, key)
      } else {
        const removed = await client.query(`DELETE FROM harness.node_resource_requests WHERE ${REQUEST} RETURNING state`, key)
        if (removed.rowCount !== 0) await client.query(`UPDATE harness.node_resource_state SET ${outcome === 'not-started' ? 'cancelled=cancelled+1' : 'completed=completed+1'} WHERE ${NODE}`, [this.organizationId, this.nodeId])
      }
      await this.schedule(client)
    })
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

  private async current(client: PoolClient, subject: ResourceOwner, cleanup = false): Promise<RuntimeId | undefined> {
    const owner = this.owner(subject)
    if ('ownerId' in subject) {
      const result = await client.query(`SELECT 1 FROM harness.node_resource_gateways WHERE ${NODE} AND owner_id=$3 AND generation=$4
        AND ($5::boolean OR harness.node_execution_available($1,$2)) FOR SHARE`,
      [this.organizationId, this.nodeId, subject.ownerId, subject.generation, cleanup])
      if (result.rowCount !== 1) throw new NodeResourceBudgetError(409, 'stale-generation', 'Gateway resource owner is no longer current')
      return
    }
    const result = await client.query<{ runtime_id: RuntimeId }>(`SELECT i.runtime_id FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=$3
        AND COALESCE(u.public_id,p.public_id)=$4 AND i.generation=$5 AND i.observed_state=ANY($6::text[])
        AND ($7::uuid IS NULL OR i.runtime_id=$7)
        AND ($8::boolean OR harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch))
      FOR SHARE OF i`, [...owner, cleanup ? ['starting', 'ready', 'stopping'] : ['starting', 'ready'], subject.target.runtimeId ?? null, cleanup])
    if (result.rowCount !== 1) throw new NodeResourceBudgetError(409, 'stale-generation', 'resource Runtime generation is no longer current')
    return result.rows[0]!.runtime_id
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
      if (!isDatabaseContentionError(error)) throw error
      throw new NodeResourceBudgetError(503, 'database-busy', 'Resource accounting is busy. Retry after the current operation settles.', { cause: error })
    }
  }

  private async rows(client: PoolClient): Promise<Row[]> {
    return (await client.query<Row>(`SELECT *,GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-created_at)*1000)::float8 wait_ms
      FROM harness.node_resource_requests WHERE ${NODE}`, [this.organizationId, this.nodeId])).rows
  }

  private async turn(client: PoolClient): Promise<string> {
    const result = await client.query<{ next_turn: string }>(`UPDATE harness.node_resource_state SET next_turn=next_turn+1 WHERE ${NODE} RETURNING next_turn::text`, [this.organizationId, this.nodeId])
    return result.rows[0]!.next_turn
  }

  private async read(client: PoolClient, key: readonly unknown[], requestId: ResourceOperationId): Promise<NodeResourceStatus> {
    const result = await client.query<Pick<Row, 'state' | 'operation_id'>>(`SELECT state,operation_id::text FROM harness.node_resource_requests WHERE ${REQUEST}`, [...key])
    const row = result.rows[0]
    if (row !== undefined && row.operation_id !== requestId) throw new NodeResourceBudgetError(409, 'owner-mismatch', 'resource operation does not own this sequence')
    return { state: row?.state ?? 'closed' }
  }

  private async refuse(client: PoolClient, reason: Extract<NodeResourceStatus, { state: 'refused' }>['reason']): Promise<NodeResourceStatus> {
    await client.query(`UPDATE harness.node_resource_state SET rejected=rejected+1 WHERE ${NODE}`, [this.organizationId, this.nodeId])
    return { state: 'refused', reason }
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

  private async hasCredits(client: PoolClient): Promise<boolean> {
    const result = await client.query<{ ready: boolean }>(`SELECT credits>0 AND valid_until>clock_timestamp()
      AND harness.node_execution_available($1,$2) ready FROM harness.node_resource_state WHERE ${NODE}`, [this.organizationId, this.nodeId])
    return result.rows[0]!.ready
  }

  private async schedule(client: PoolClient): Promise<void> {
    await client.query('SELECT harness.schedule_node_resources($1,$2)', [this.organizationId, this.nodeId])
  }
}

function assertNeverOrigin(_origin: never): never {
  throw new Error('unsupported resource origin')
}
