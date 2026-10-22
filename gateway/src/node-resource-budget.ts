/** Durable node-wide admission with equal-user, per-user project round robin. */
import { createHash } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { z } from 'zod'
import type { ResourceKind } from '@deepseek-ai/dsh-resource-budget/types'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { RuntimeTarget } from './instances.ts'
import { pressureCredits, type NodePressureConfig, type NodePressureSample } from './node-resource-pressure.ts'
import { transaction } from './postgres/database.ts'

const KINDS: readonly ResourceKind[] = ['model', 'process']

/** Validated deployment limits; active limits count actual resources, including uncertain cleanup. */
export interface NodeResourceBudgetConfig extends NodePressureConfig {
  readonly maxQueued: number
  readonly maxQueuedPerUser: number
  readonly maxQueuedPerProject: number
  readonly maxQueuedBytes: number
  readonly maxWaitMs: number
}

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const resourceLimits = z.object({
  sampleMs: positive, staleMs: positive, cpuTarget: z.number().positive().max(1),
  eventLoopTargetMs: positive, linuxMemoryReserveRatio: z.number().positive().max(1),
  maxQueued: positive, maxQueuedPerUser: positive, maxQueuedPerProject: positive,
  maxQueuedBytes: positive, maxWaitMs: positive,
}).strict().refine(value => value.maxQueuedPerUser <= value.maxQueued && value.maxQueuedPerProject <= value.maxQueued,
  'per-user/project resource queues must not exceed the node queue')

/** One Runtime-local request sequence and server-verified execution attribution. */
export interface NodeResourceRequest {
  readonly sequence: number
  readonly kind: ResourceKind
  readonly actorId: number
  readonly projectId: number
  readonly sessionId?: string
  readonly scopeId?: string
}

/** Replayed terminal sequences cannot re-enter admission after their retained row is removed. */
export type NodeResourceStatus = { readonly state: 'queued' | 'active' | 'uncertain' | 'closed' }
  | { readonly state: 'refused'; readonly reason: 'queue-full' | 'user-queue-full' | 'project-queue-full' | 'queue-bytes' | 'nested-capacity' }

/** Safe request rejection, without SQL or owner identifiers. */
export class NodeResourceBudgetError extends Error {
  constructor(readonly status: 400 | 403 | 409, message: string) {
    super(message)
    this.name = 'NodeResourceBudgetError'
  }
}

interface Row {
  runtime_kind: 'user' | 'project'
  runtime_public_id: string
  generation: string
  sequence: string
  kind: ResourceKind
  actor_public_id: string
  project_public_id: string
  session_id: string | null
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
      await client.query(`UPDATE harness.node_resource_state SET limits=$3::jsonb WHERE ${NODE}`,
        [this.organizationId, this.nodeId, JSON.stringify(this.config)])
      await this.schedule(client, this.config)
    })
  }

  /**
   * Publish a completed host sample; multiple coordinators cannot multiply start credits.
   * @param sample - host observation, never supplied by a Runtime.
   * @returns completion after fair queued admissions commit.
   */
  async observe(sample: NodePressureSample): Promise<void> {
    await this.lock(async (client, limits) => {
      const changed = await client.query(`UPDATE harness.node_resource_state SET pressure=$3::jsonb,sampled_at=clock_timestamp(),
        valid_until=clock_timestamp()+$4*interval '1 millisecond',credits=$5 WHERE ${NODE}
        AND (sampled_at IS NULL OR sampled_at<=clock_timestamp()-$6*interval '1 millisecond') RETURNING node_id`,
      [this.organizationId, this.nodeId, JSON.stringify(sample), limits.staleMs, pressureCredits(sample, limits), limits.sampleMs])
      if (changed.rowCount !== 0) await this.schedule(client, limits)
    })
  }

  /**
   * Register the current Runtime generation before it can claim any execution budget.
   * @param subject - authenticated Runtime belonging to this node.
   * @returns the next serial registration sequence; active reservations remain intact.
   */
  async register(subject: RuntimeCredentialSubject): Promise<{ nextSequence: number }> {
    return this.lock(async client => {
      await this.current(client, subject)
      await client.query(`INSERT INTO harness.node_resource_runtimes
        (organization_id,node_id,runtime_kind,runtime_public_id,generation) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, this.owner(subject))
      const result = await client.query<{ last_sequence: string }>(`SELECT last_sequence::text FROM harness.node_resource_runtimes WHERE ${OWNER}`, this.owner(subject))
      return { nextSequence: Number(result.rows[0]!.last_sequence) + 1 }
    })
  }

  /**
   * Serialize registration, fair selection and the durable reservation under one node lock.
   * @param subject - current authenticated Runtime generation.
   * @param request - bounded metadata whose actor and project were resolved by the Gateway.
   * @returns bounded admission, idempotent replay, or explicit refusal.
   */
  async request(subject: RuntimeCredentialSubject, request: NodeResourceRequest): Promise<NodeResourceStatus> {
    return this.lock(async (client, limits) => {
      await this.current(client, subject)
      const owner = this.owner(subject)
      const key = [...owner, request.sequence]
      const fingerprint = createHash('sha256').update(JSON.stringify([request.kind, request.actorId, request.projectId, request.sessionId ?? null, request.scopeId ?? null])).digest('hex')
      const previous = await client.query<Row>(`SELECT * FROM harness.node_resource_requests WHERE ${REQUEST}`, [...key])
      if (previous.rows[0] !== undefined) {
        if (previous.rows[0].fingerprint !== fingerprint) throw new NodeResourceBudgetError(409, 'resource request conflicts with its first registration')
        await this.schedule(client, limits)
        return this.read(client, key)
      }
      const counter = await client.query<{ last_sequence: string }>(`SELECT last_sequence::text FROM harness.node_resource_runtimes WHERE ${OWNER}`, owner)
      const last = counter.rows[0]?.last_sequence
      if (last === undefined) throw new NodeResourceBudgetError(409, 'resource Runtime is not registered')
      if (request.sequence <= Number(last)) return { state: 'closed' }
      if (request.sequence !== Number(last) + 1) throw new NodeResourceBudgetError(409, 'resource registration sequence is not contiguous')
      await client.query(`UPDATE harness.node_resource_runtimes SET last_sequence=$6 WHERE ${OWNER}`, key)
      await this.schedule(client, limits)
      const legacy = await this.unregistered(client)
      const existing = await this.rows(client)
      const waiting = existing.filter(row => row.state === 'queued')
      const occupied = existing.filter(row => row.kind === request.kind && row.state !== 'queued')
      const immediate = legacy === 0 && !waiting.some(row => row.kind === request.kind) && await this.hasCredits(client)
      if (!immediate) {
        // A nested producer cannot wait for the same exhausted resource class while retaining its parent.
        if (request.sessionId !== undefined && !await this.hasCredits(client)) {
          const ancestors = await client.query<{ session_id: string }>(`WITH RECURSIVE chain AS (
            SELECT session_id,parent_session_id FROM harness.execution_sessions WHERE organization_id=$1 AND runtime_kind=$2 AND runtime_public_id=$3 AND session_id=$4
            UNION ALL SELECT p.session_id,p.parent_session_id FROM harness.execution_sessions p JOIN chain c ON p.session_id=c.parent_session_id
              WHERE p.organization_id=$1 AND p.runtime_kind=$2 AND p.runtime_public_id=$3
          ) SELECT session_id FROM chain`, [this.organizationId, subject.target.kind, subject.target.id, request.sessionId])
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
      const bytes = Buffer.byteLength(JSON.stringify({ ...request, runtime: subject.target, generation: subject.generation }))
      if (existing.reduce((total, row) => total + row.queued_bytes, 0) + bytes > limits.maxQueuedBytes) return this.refuse(client, 'queue-bytes')
      const turn = await this.turn(client)
      const sameUser = waiting.find(row => Number(row.actor_public_id) === request.actorId)
      const sameProject = waiting.find(row => Number(row.actor_public_id) === request.actorId && Number(row.project_public_id) === request.projectId)
      await client.query(`INSERT INTO harness.node_resource_requests
        (organization_id,node_id,runtime_kind,runtime_public_id,generation,sequence,kind,actor_public_id,project_public_id,session_id,fingerprint,state,user_turn,project_turn,queued_bytes,deadline)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$13,$14,clock_timestamp()+$15*interval '1 millisecond')`,
      [...key, request.kind, request.actorId, request.projectId, request.sessionId ?? null, fingerprint, sameUser?.user_turn ?? turn, sameProject?.project_turn ?? turn, bytes, limits.maxWaitMs])
      await this.schedule(client, limits)
      return this.read(client, key)
    })
  }

  /**
   * Observe admission after applying expiry and newly available reservations.
   * @param subject - current Runtime generation.
   * @param sequence - already registered operation.
   * @returns durable state, or closed after completion, cancellation or queue expiry.
   */
  async status(subject: RuntimeCredentialSubject, sequence: number): Promise<NodeResourceStatus> {
    return this.lock(async (client, limits) => {
      await this.current(client, subject)
      await this.schedule(client, limits)
      return this.read(client, [...this.owner(subject), sequence])
    })
  }

  /**
   * Read all pending requests in one Runtime poll.
   * @param subject - authenticated current generation.
   * @param sequences - byte-bounded request sequences.
   * @returns matching durable states in request order.
   */
  async statuses(subject: RuntimeCredentialSubject, sequences: readonly number[]): Promise<NodeResourceStatus[]> {
    return this.lock(async (client, limits) => {
      await this.current(client, subject)
      await this.schedule(client, limits)
      const rows = await client.query<{ sequence: string; state: 'queued' | 'active' | 'uncertain' }>(`SELECT sequence::text,state FROM harness.node_resource_requests WHERE ${OWNER} AND sequence=ANY($6::bigint[])`, [...this.owner(subject), sequences])
      const states = new Map(rows.rows.map(row => [Number(row.sequence), row.state]))
      return sequences.map(sequence => ({ state: states.get(sequence) ?? 'closed' }))
    })
  }

  /**
   * Report local quiescence or unstarted cancellation; neither a disconnect nor a timeout calls this operation.
   * @param subject - authenticated Runtime owning this operation.
   * @param sequence - monotonically registered operation, including a cancelled registration in flight.
   * @param outcome - caller-proven completion or uncertainty that retains occupation.
   * @returns confirmation after accounting and any next grants commit.
   */
  async finish(subject: RuntimeCredentialSubject, sequence: number, outcome: 'quiescent' | 'not-started' | 'uncertain'): Promise<void> {
    await this.lock(async (client, limits) => {
      await this.current(client, subject, true)
      const owner = this.owner(subject), key = [...owner, sequence]
      const counter = await client.query<{ last_sequence: string }>(`SELECT last_sequence::text FROM harness.node_resource_runtimes WHERE ${OWNER}`, owner)
      const last = Number(counter.rows[0]?.last_sequence ?? -1)
      if (last < 0 || sequence > last + 1 || (sequence === last + 1 && outcome !== 'not-started')) throw new NodeResourceBudgetError(409, 'unknown resource completion sequence')
      if (sequence === last + 1) await client.query(`UPDATE harness.node_resource_runtimes SET last_sequence=$6 WHERE ${OWNER}`, key)
      if (outcome === 'uncertain') {
        await client.query(`UPDATE harness.node_resource_requests SET state='uncertain' WHERE ${REQUEST} AND state='active'`, key)
      } else {
        const removed = await client.query(`DELETE FROM harness.node_resource_requests WHERE ${REQUEST} RETURNING state`, key)
        if (removed.rowCount !== 0) await client.query(`UPDATE harness.node_resource_state SET ${outcome === 'not-started' ? 'cancelled=cancelled+1' : 'completed=completed+1'} WHERE ${NODE}`, [this.organizationId, this.nodeId])
      }
      await this.schedule(client, limits)
    })
  }

  /**
   * Reclaim only generations whose managed process tree has been confirmed stopped.
   * @param target - exact user/project Runtime.
   * @param generation - highest confirmed stopped generation.
   * @returns completion after durable cleanup and fair wakeup.
   */
  async stopped(target: RuntimeTarget, generation: number): Promise<void> {
    await this.lock(async (client, limits) => {
      const args = [this.organizationId, this.nodeId, target.kind, target.id, generation]
      const removed = await client.query(`DELETE FROM harness.node_resource_requests WHERE ${NODE} AND runtime_kind=$3 AND runtime_public_id=$4 AND generation<=$5 RETURNING state`, args)
      await client.query(`DELETE FROM harness.node_resource_runtimes WHERE ${NODE} AND runtime_kind=$3 AND runtime_public_id=$4 AND generation<=$5`, args)
      await client.query(`UPDATE harness.node_resource_state SET reclaimed=reclaimed+$3 WHERE ${NODE}`, [this.organizationId, this.nodeId, removed.rowCount ?? 0])
      await this.schedule(client, limits)
    })
  }

  /**
   * Refuse proxy reuse of a Runtime that cannot participate in node accounting.
   * @param target - live Runtime selected by the proxy.
   * @param generation - selected live generation.
   * @returns true only after its node-budget provider has registered.
   */
  async registered(target: RuntimeTarget, generation: number): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM harness.node_resource_runtimes WHERE ${OWNER}`,
      [this.organizationId, this.nodeId, target.kind, target.id, generation])
    return result.rowCount === 1
  }

  /** @returns identifier-free current counts and cumulative node admission outcomes. */
  async snapshot() {
    const rows = await this.pool.query<{ kind: ResourceKind; state: string; count: string; bytes: string; age_ms: number }>(`SELECT kind,state,count(*)::text count,
      COALESCE(sum(queued_bytes),0)::text bytes,COALESCE(max(EXTRACT(EPOCH FROM clock_timestamp()-created_at)*1000),0)::float8 age_ms
      FROM harness.node_resource_requests WHERE ${NODE} GROUP BY kind,state`, [this.organizationId, this.nodeId])
    const stats = await this.pool.query<{ limits: unknown } & Record<string, unknown>>(`SELECT admitted::text,rejected::text,completed::text,cancelled::text,timed_out::text,reclaimed::text,
      wait_ms_total,wait_ms_max,limits FROM harness.node_resource_state WHERE ${NODE}`, [this.organizationId, this.nodeId])
    const kinds = Object.fromEntries(KINDS.map(kind => [kind, { active: 0, queued: 0, uncertain: 0, queuedBytes: 0, oldestQueuedMs: 0 }])) as Record<ResourceKind, { active: number; queued: number; uncertain: number; queuedBytes: number; oldestQueuedMs: number }>
    for (const row of rows.rows) {
      const kind = kinds[row.kind], count = Number(row.count)
      if (row.state === 'queued') { kind.queued = count; kind.queuedBytes = Number(row.bytes); kind.oldestQueuedMs = row.age_ms }
      else { kind.active += count; if (row.state === 'uncertain') kind.uncertain = count }
    }
    return { limits: stats.rows[0] === undefined ? this.config : resourceLimits.parse(stats.rows[0].limits), kinds, outcomes: Object.fromEntries(Object.entries(stats.rows[0] ?? {}).filter(([key]) => key !== 'limits').map(([key, value]) => [key, Number(value)])), unregisteredRuntimes: await this.unregistered(this.pool) }
  }

  private owner(subject: RuntimeCredentialSubject): [string, string, 'user' | 'project', number, number] {
    if (subject.organizationId !== this.organizationId) throw new NodeResourceBudgetError(403, 'resource Runtime belongs to another organization')
    return [this.organizationId, this.nodeId, subject.target.kind, subject.target.id, subject.generation]
  }

  private async current(client: PoolClient, subject: RuntimeCredentialSubject, cleanup = false): Promise<void> {
    const owner = this.owner(subject)
    const result = await client.query(`SELECT 1 FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=$3
        AND COALESCE(u.public_id,p.public_id)=$4 AND i.generation=$5 AND i.observed_state=ANY($6::text[])
      FOR SHARE OF i`, [...owner, cleanup ? ['starting', 'ready', 'stopping'] : ['starting', 'ready']])
    if (result.rowCount !== 1) throw new NodeResourceBudgetError(409, 'resource Runtime generation is no longer current')
  }

  private async lock<T>(work: (client: PoolClient, limits: NodeResourceBudgetConfig) => Promise<T>): Promise<T> {
    return transaction(this.pool, async client => {
      await client.query(`INSERT INTO harness.node_resource_state(organization_id,node_id,limits) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, [this.organizationId, this.nodeId, JSON.stringify(this.config)])
      const state = await client.query<{ limits: unknown }>(`SELECT limits FROM harness.node_resource_state WHERE ${NODE} FOR UPDATE`, [this.organizationId, this.nodeId])
      const limits = resourceLimits.parse(state.rows[0]!.limits)
      const expired = await client.query(`DELETE FROM harness.node_resource_requests WHERE ${NODE} AND state='queued' AND deadline<=clock_timestamp() RETURNING state`, [this.organizationId, this.nodeId])
      if ((expired.rowCount ?? 0) > 0) await client.query(`UPDATE harness.node_resource_state SET timed_out=timed_out+$3 WHERE ${NODE}`, [this.organizationId, this.nodeId, expired.rowCount])
      return work(client, limits)
    })
  }

  private async rows(client: PoolClient): Promise<Row[]> {
    return (await client.query<Row>(`SELECT *,GREATEST(0,EXTRACT(EPOCH FROM clock_timestamp()-created_at)*1000)::float8 wait_ms
      FROM harness.node_resource_requests WHERE ${NODE}`, [this.organizationId, this.nodeId])).rows
  }

  private async turn(client: PoolClient): Promise<string> {
    const result = await client.query<{ next_turn: string }>(`UPDATE harness.node_resource_state SET next_turn=next_turn+1 WHERE ${NODE} RETURNING next_turn::text`, [this.organizationId, this.nodeId])
    return result.rows[0]!.next_turn
  }

  private async read(client: PoolClient, key: readonly unknown[]): Promise<NodeResourceStatus> {
    const result = await client.query<{ state: 'queued' | 'active' | 'uncertain' }>(`SELECT state FROM harness.node_resource_requests WHERE ${REQUEST}`, [...key])
    return { state: result.rows[0]?.state ?? 'closed' }
  }

  private async refuse(client: PoolClient, reason: Extract<NodeResourceStatus, { state: 'refused' }>['reason']): Promise<NodeResourceStatus> {
    await client.query(`UPDATE harness.node_resource_state SET rejected=rejected+1 WHERE ${NODE}`, [this.organizationId, this.nodeId])
    return { state: 'refused', reason }
  }

  private async unregistered(database: Pick<Pool, 'query'> | PoolClient): Promise<number> {
    const result = await database.query<{ count: string }>(`SELECT count(*)::text count FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2 AND i.observed_state IN ('ready','starting','stopping')
        AND NOT EXISTS(SELECT 1 FROM harness.node_resource_runtimes r WHERE r.organization_id=i.organization_id AND r.node_id=i.assigned_node_id
          AND r.runtime_kind=CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END AND r.runtime_public_id=COALESCE(u.public_id,p.public_id) AND r.generation=i.generation)`, [this.organizationId, this.nodeId])
    return Number(result.rows[0]!.count)
  }

  private async hasCredits(client: PoolClient): Promise<boolean> {
    const result = await client.query<{ ready: boolean }>(`SELECT credits>0 AND valid_until>clock_timestamp() ready FROM harness.node_resource_state WHERE ${NODE}`, [this.organizationId, this.nodeId])
    return result.rows[0]!.ready
  }

  private async schedule(client: PoolClient, _limits: NodeResourceBudgetConfig): Promise<void> {
    if (await this.unregistered(client) > 0) return
    while (await this.hasCredits(client)) {
      const next = (await this.rows(client)).filter(row => row.state === 'queued').sort((a, b) =>
        Number(a.user_turn) - Number(b.user_turn) || Number(a.project_turn) - Number(b.project_turn) || Number(a.sequence) - Number(b.sequence))[0]
      if (next === undefined) break
      const key = [this.organizationId, this.nodeId, next.runtime_kind, next.runtime_public_id, next.generation, next.sequence]
      await client.query(`UPDATE harness.node_resource_requests SET state='active',granted_at=clock_timestamp() WHERE ${REQUEST}`, key)
      await client.query(`UPDATE harness.node_resource_state SET credits=credits-1,admitted=admitted+1,wait_ms_total=wait_ms_total+$3,wait_ms_max=GREATEST(wait_ms_max,$3) WHERE ${NODE}`, [this.organizationId, this.nodeId, next.wait_ms])
      const turn = await this.turn(client)
      await client.query(`UPDATE harness.node_resource_requests SET user_turn=$4 WHERE ${NODE} AND actor_public_id=$3 AND state='queued'`, [this.organizationId, this.nodeId, next.actor_public_id, turn])
      await client.query(`UPDATE harness.node_resource_requests SET project_turn=$5 WHERE ${NODE} AND actor_public_id=$3 AND project_public_id=$4 AND state='queued'`, [this.organizationId, this.nodeId, next.actor_public_id, next.project_public_id, turn])
    }
  }
}
