/** Center-owned node credentials and exclusive control leases, without remote database access. */
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { UserRow } from '../auth.ts'
import {
  NodeAccessError, nodeCredentialSchema, nodeEnrollmentTokenSchema, nodeUuidSchema,
  type NodeAccessConfig, type NodeAccessEntry, type NodeAccessPage,
  type NodeEnrollment, type NodeEnrollmentId, type NodeEnrollmentToken, type NodeIdentity, type NodeLease,
} from '../node-access.ts'
import type { RuntimeCatalogLimits, RuntimeNodeId } from '../runtime-catalog.ts'
import { transaction, type Queryable } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

const issueSchema = z.object({
  requestId: nodeUuidSchema,
  name: z.string().min(1).max(64).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u).optional(),
  nodeId: nodeUuidSchema.optional(),
}).strict().refine(value => (value.name === undefined) !== (value.nodeId === undefined))
const mutationSchema = z.object({
  action: z.enum(['revoke', 'issue-enrollment', 'detach']),
  revision: z.number().int().positive().safe(),
  requestId: nodeUuidSchema.optional(),
}).strict()
const enrollmentSchema = z.object({
  protocolVersion: z.literal(1), credential: nodeCredentialSchema,
  platform: z.enum(['darwin', 'linux', 'win32']), architecture: z.enum(['x64', 'arm64']),
}).strict()
const connectionSchema = z.object({ connectionId: nodeUuidSchema }).strict()
const leaseRequestSchema = connectionSchema.extend({ epoch: z.string().regex(/^[1-9][0-9]{0,18}$/u) }).strict()

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new NodeAccessError(400, 'node-access/invalid-request')
  return result.data
}

function digest(value: string): Buffer { return createHash('sha256').update(value).digest() }

interface AgentRow {
  node_id: string
  organization_id: string
  revision: string
  credential_hash: Buffer | null
  revoked_at: Date | null
  connection_id: string | null
  connection_epoch: string
  lease_expires_at: Date | null
  live: boolean
  attachment_state: 'pending' | 'managed' | 'detached'
}

type AgentLookup = { kind: 'node'; id: string } | { kind: 'credential'; hash: Buffer }

/** Authenticated node registry; leases report connectivity and never acknowledge stopped writers. */
export class PostgresNodeAccessService {
  /**
   * @param context - center organization and its PostgreSQL pool.
   * @param config - validated enrollment lifetime, lease timing and control admission.
   * @param directoryLimits - shared metadata page row and complete-response limits.
   */
  constructor(private readonly context: PostgresRuntimeContext, private readonly config: NodeAccessConfig,
    private readonly directoryLimits: RuntimeCatalogLimits) {}

  private async administrator(tx: Queryable, actor: UserRow): Promise<string> {
    const result = await tx.query<{ id: string }>(`SELECT u.id FROM harness.users u
      JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active'
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
        AND m.status='active' AND m.role='admin' FOR SHARE OF u,m,o`, [this.context.organizationId, actor.id])
    const id = result.rows[0]?.id
    if (id === undefined) throw new NodeAccessError(403, 'node-access/forbidden')
    return id
  }

  private async primary(tx: Queryable, write = true): Promise<void> {
    const row = await tx.query(`SELECT 1 FROM harness.deployment_topology
      WHERE organization_id=$1 AND ((enabled AND primary_node_id=$2)
        OR ($3 AND legacy_initialization_required AND NOT EXISTS(SELECT 1 FROM harness.node_agents a
          WHERE a.organization_id=$1 AND a.node_id=$2))) FOR ${write ? 'UPDATE' : 'SHARE'}`, [this.context.organizationId, this.context.nodeId, !write])
    if (row.rowCount !== 1) throw new NodeAccessError(409, 'node-access/mode-disabled')
  }

  private async ticket(tx: Queryable, actorId: string, nodeId: string, revision: number, requestId: string): Promise<NodeEnrollment> {
    const token = `dsh_enroll_${randomBytes(32).toString('base64url')}` as NodeEnrollmentToken
    const result = await tx.query<{ expires_at: Date }>(`INSERT INTO harness.node_agent_enrollments
      (id,organization_id,node_id,revision,token_hash,created_by,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 millisecond')
      ON CONFLICT(id) DO NOTHING RETURNING expires_at`,
    [requestId, this.context.organizationId, nodeId, revision, digest(token), actorId, this.config.enrollmentTtlMs])
    if (result.rows[0] === undefined) throw new NodeAccessError(409, 'node-access/enrollment-already-issued')
    return { nodeId: nodeId as RuntimeNodeId, enrollmentId: requestId as NodeEnrollmentId, revision, token, expiresAt: result.rows[0].expires_at.toISOString() }
  }

  /**
   * Reserve a new, offline node and issue one expiring enrollment capability.
   * @param actor - administrator candidate; current authority is locked and rechecked.
   * @param input - untrusted JSON with name and durable issuance request UUID.
   * @returns ticket material once; a lost response requires explicit reissuance from the directory.
   */
  async issue(actor: UserRow, input: unknown): Promise<NodeEnrollment> {
    const request = parse(issueSchema, input)
    return transaction(this.context.pool, async tx => {
      const actorId = await this.administrator(tx, actor)
      await this.primary(tx)
      const prior = await tx.query('SELECT 1 FROM harness.node_agent_enrollments WHERE id=$1', [request.requestId])
      if (prior.rowCount !== 0) throw new NodeAccessError(409, 'node-access/enrollment-already-issued')
      const node = request.nodeId === undefined
        ? await tx.query<{ id: string }>(`INSERT INTO harness.compute_nodes(organization_id,name,status)
          VALUES($1,$2,'offline') ON CONFLICT(organization_id,name) DO NOTHING RETURNING id`, [this.context.organizationId, request.name])
        : await tx.query<{ id: string }>(`SELECT id FROM harness.compute_nodes n
          WHERE n.organization_id=$1 AND n.id=$2 AND n.id<>$3
            AND NOT EXISTS(SELECT 1 FROM harness.node_agents a WHERE a.organization_id=n.organization_id AND a.node_id=n.id)
          FOR SHARE`, [this.context.organizationId, request.nodeId, this.context.nodeId])
      const nodeId = node.rows[0]?.id
      if (nodeId === undefined) throw new NodeAccessError(409, 'node-access/name-conflict')
      await tx.query("INSERT INTO harness.node_agents(organization_id,node_id,attachment_state) VALUES($1,$2,'pending')", [this.context.organizationId, nodeId])
      await tx.query('UPDATE harness.deployment_topology SET revision=revision+1 WHERE organization_id=$1', [this.context.organizationId])
      return this.ticket(tx, actorId, nodeId, 1, request.requestId)
    })
  }

  /**
   * Revoke a credential, or replace its enrollment ticket, after comparing the administrator's revision.
   * @param actor - current administrator candidate.
   * @param rawId - node UUID from the request path; existing Gateway nodes are ineligible.
   * @param input - untrusted action, expected revision and issuance request UUID when reissuing.
   * @returns new ticket or revoked identity and revision; instance state is never released or rewritten.
   */
  async mutate(actor: UserRow, rawId: string, input: unknown): Promise<NodeEnrollment | { nodeId: RuntimeNodeId; revision: number; status: 'revoked' | 'detached'; topologyRevision?: string }> {
    const nodeId = parse(nodeUuidSchema, rawId)
    const request = parse(mutationSchema, input)
    if (request.action === 'issue-enrollment' && request.requestId === undefined) throw new NodeAccessError(400, 'node-access/invalid-request')
    return transaction(this.context.pool, async tx => {
      const actorId = await this.administrator(tx, actor)
      await this.primary(tx)
      const result = await tx.query<{ revision: string }>(`SELECT revision FROM harness.node_agents
        WHERE organization_id=$1 AND node_id=$2 FOR UPDATE`, [this.context.organizationId, nodeId])
      const row = result.rows[0]
      if (row === undefined) throw new NodeAccessError(404, 'node-access/not-found')
      if (publicNumber(row.revision, 'Node credential revision') !== request.revision) throw new NodeAccessError(409, 'node-access/revision-conflict')
      const revision = request.revision + 1
      if (!Number.isSafeInteger(revision)) throw new NodeAccessError(409, 'node-access/revision-conflict')
      if (request.action === 'detach') {
        try {
          await tx.query(`UPDATE harness.node_agents SET attachment_state='detached',revision=$3,revoked_at=clock_timestamp(),
            connection_id=NULL,lease_expires_at=NULL,connection_epoch=connection_epoch+1 WHERE organization_id=$1 AND node_id=$2`,
          [this.context.organizationId, nodeId, revision])
        } catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error && ['55000', '55P03'].includes(String(error.code))) {
            throw new NodeAccessError(409, 'node-access/computer-busy')
          }
          throw error
        }
        const topology = await tx.query<{ revision: string }>('UPDATE harness.deployment_topology SET revision=revision+1 WHERE organization_id=$1 RETURNING revision::text', [this.context.organizationId])
        return { nodeId: nodeId as RuntimeNodeId, revision, status: 'detached', topologyRevision: topology.rows[0]!.revision }
      }
      await tx.query(`UPDATE harness.node_agents SET revision=$3,credential_hash=NULL,
        revoked_at=CASE WHEN $4 THEN clock_timestamp() ELSE NULL END,
        attachment_state=CASE WHEN NOT $4 AND attachment_state='detached' THEN 'pending' ELSE attachment_state END,
        connection_id=NULL,lease_expires_at=NULL,connection_epoch=connection_epoch+1
        WHERE organization_id=$1 AND node_id=$2`, [this.context.organizationId, nodeId, revision, request.action === 'revoke'])
      await tx.query('UPDATE harness.deployment_topology SET revision=revision+1 WHERE organization_id=$1', [this.context.organizationId])
      if (request.action === 'revoke') return { nodeId: nodeId as RuntimeNodeId, revision, status: 'revoked' as const }
      return this.ticket(tx, actorId, nodeId, revision, request.requestId!)
    })
  }

  /**
   * Read cached connection metadata with current administrator authority and bounded keyset pages.
   * @param actor - administrator candidate.
   * @param query - untrusted cursor UUID and optional row count.
   * @returns one page without contacting agents or starting runtimes.
   */
  async list(actor: UserRow, query: { cursor?: string; limit?: string }): Promise<NodeAccessPage> {
    const after = query.cursor === undefined ? null : parse(nodeUuidSchema, query.cursor)
    const limit = query.limit === undefined ? this.directoryLimits.pageSize : Number(query.limit)
    if ((query.limit !== undefined && !/^[1-9][0-9]*$/u.test(query.limit)) || !Number.isSafeInteger(limit)
      || limit < 1 || limit > this.directoryLimits.pageSize) throw new NodeAccessError(400, 'node-access/invalid-request')
    return transaction(this.context.pool, async tx => {
      await this.administrator(tx, actor)
      await this.primary(tx, false)
      const result = await tx.query<{ node_id: RuntimeNodeId; name: string; revision: string;
        status: NodeAccessEntry['status']; platform: NodeAccessEntry['platform']; architecture: NodeAccessEntry['architecture'];
        last_seen_at: Date | null; lease_expires_at: Date | null }>(`SELECT a.node_id,n.name::text,a.revision::text,
          CASE WHEN a.attachment_state='detached' THEN 'detached' WHEN a.revoked_at IS NOT NULL THEN 'revoked' WHEN a.attachment_state='pending' OR a.credential_hash IS NULL THEN 'pending'
            WHEN a.lease_expires_at>clock_timestamp() THEN 'connected' ELSE 'disconnected' END status,
          a.platform,a.architecture,a.last_seen_at,a.lease_expires_at
        FROM harness.node_agents a JOIN harness.compute_nodes n ON n.id=a.node_id AND n.organization_id=a.organization_id
        WHERE a.organization_id=$1 AND ($2::uuid IS NULL OR a.node_id>$2) ORDER BY a.node_id LIMIT $3`,
      [this.context.organizationId, after, limit + 1])
      const items: NodeAccessEntry[] = []
      let bytes = Buffer.byteLength(JSON.stringify({ items: [], nextCursor: null }))
      for (const row of result.rows.slice(0, limit)) {
        const entry: NodeAccessEntry = { nodeId: row.node_id, name: row.name, revision: publicNumber(row.revision, 'Node credential revision'),
          status: row.status, platform: row.platform, architecture: row.architecture,
          lastSeenAt: row.last_seen_at?.toISOString() ?? null, leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null, executionReady: false }
        const nextBytes = bytes + Buffer.byteLength(JSON.stringify(entry)) + (items.length === 0 ? 0 : 1)
        const cursorBytes = result.rows.length > items.length + 1 ? Buffer.byteLength(JSON.stringify(entry.nodeId)) - 4 : 0
        if (nextBytes + cursorBytes > this.directoryLimits.maxBytes) {
          if (items.length === 0) throw new NodeAccessError(413, 'node-access/response-too-large')
          return { items, nextCursor: items.at(-1)!.nodeId }
        }
        items.push(entry)
        bytes = nextBytes
      }
      return { items, nextCursor: result.rows.length > items.length ? items.at(-1)!.nodeId : null }
    })
  }

  /**
   * Exchange a ticket for the node-generated credential's assigned identity.
   * @param token - untrusted bearer ticket; organization and node come from its database row.
   * @param input - protocol, supported host platform and credential generated durably before exchange.
   * @returns the same identity on retries with the same ticket and credential, while the ticket is valid.
   */
  async enroll(token: string, input: unknown): Promise<NodeIdentity> {
    const parsedTicket = nodeEnrollmentTokenSchema.safeParse(token)
    if (!parsedTicket.success) throw new NodeAccessError(401, 'node-access/unauthorized')
    const ticket = parsedTicket.data
    if (typeof input === 'object' && input !== null && 'protocolVersion' in input && input.protocolVersion !== 1) {
      throw new NodeAccessError(422, 'node-access/unsupported-protocol')
    }
    if (typeof input === 'object' && input !== null && 'platform' in input
      && input.platform !== 'darwin' && input.platform !== 'linux' && input.platform !== 'win32') {
      throw new NodeAccessError(422, 'node-access/unsupported-platform')
    }
    const request = parse(enrollmentSchema, input)
    return transaction(this.context.pool, async tx => {
      await this.primary(tx)
      const target = await tx.query<{ node_id: string }>(`SELECT node_id FROM harness.node_agent_enrollments
        WHERE organization_id=$1 AND token_hash=$2`, [this.context.organizationId, digest(ticket)])
      const nodeId = target.rows[0]?.node_id
      if (nodeId === undefined) throw new NodeAccessError(401, 'node-access/unauthorized')
      const row = await this.lockAgent(tx, { kind: 'node', id: nodeId })
      const invitation = await tx.query<{ consumed_at: Date | null }>(`SELECT consumed_at FROM harness.node_agent_enrollments
        WHERE organization_id=$1 AND node_id=$2 AND token_hash=$3 AND revision=$4
          AND expires_at>clock_timestamp() FOR UPDATE`, [this.context.organizationId, nodeId, digest(ticket), row.revision])
      const found = invitation.rows[0]
      const credentialHash = digest(request.credential)
      if (found === undefined || row.revoked_at !== null
        || (found.consumed_at !== null && !row.credential_hash?.equals(credentialHash))) throw new NodeAccessError(401, 'node-access/unauthorized')
      if (found.consumed_at === null) {
        try {
          await tx.query(`UPDATE harness.node_agents SET credential_hash=$3,platform=$4,architecture=$5
            WHERE organization_id=$1 AND node_id=$2`, [this.context.organizationId, nodeId, credentialHash, request.platform, request.architecture])
        } catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error && error.code === '23505') throw new NodeAccessError(400, 'node-access/invalid-request')
          throw error
        }
        await tx.query('UPDATE harness.node_agent_enrollments SET consumed_at=clock_timestamp() WHERE token_hash=$1', [digest(ticket)])
      }
      return this.identity(nodeId)
    })
  }

  private identity(nodeId: string): NodeIdentity {
    return { protocolVersion: 1, organizationId: this.context.organizationId as NodeIdentity['organizationId'],
      nodeId: nodeId as RuntimeNodeId, executionReady: false }
  }

  private async lockAgent(tx: Queryable, lookup: AgentLookup, mode: 'UPDATE' | 'SHARE' = 'UPDATE'): Promise<AgentRow> {
    const column = lookup.kind === 'node' ? 'node_id' : 'credential_hash'
    const value = lookup.kind === 'node' ? lookup.id : lookup.hash
    // The lookup retains the original node while a credential changes. The
    // outer clock runs only after both authority rows have been locked.
    const result = await tx.query<AgentRow>(`WITH target AS MATERIALIZED (
      SELECT node_id FROM harness.node_agents WHERE organization_id=$1 AND ${column}=$2
    ), locked AS MATERIALIZED (
      SELECT a.* FROM harness.node_agents a JOIN target t ON t.node_id=a.node_id
      JOIN harness.organizations o ON o.id=a.organization_id AND o.status='active'
      WHERE a.organization_id=$1 FOR ${mode} OF a FOR SHARE OF o
    ) SELECT locked.*,COALESCE(lease_expires_at>clock_timestamp(),false) live FROM locked`,
    [this.context.organizationId, value])
    const row = result.rows[0]
    if (row === undefined) throw new NodeAccessError(401, 'node-access/unauthorized')
    return row
  }

  private async authenticate(tx: Queryable, token: string, mode: 'UPDATE' | 'SHARE' = 'UPDATE'): Promise<AgentRow> {
    const parsedCredential = nodeCredentialSchema.safeParse(token)
    if (!parsedCredential.success) throw new NodeAccessError(401, 'node-access/unauthorized')
    const credential = parsedCredential.data
    const row = await this.lockAgent(tx, { kind: 'credential', hash: digest(credential) }, mode)
    if (row.attachment_state === 'detached') throw new NodeAccessError(409, 'node-access/detached')
    if (row.revoked_at !== null || !row.credential_hash?.equals(digest(credential))) throw new NodeAccessError(401, 'node-access/unauthorized')
    return row
  }

  private async renew(tx: Queryable, row: AgentRow, mustBeLive = false): Promise<NodeLease> {
    const result = await tx.query<{ lease_expires_at: Date }>(`UPDATE harness.node_agents
      SET lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',last_seen_at=clock_timestamp()
      WHERE organization_id=$1 AND node_id=$2 AND (NOT $4::boolean OR lease_expires_at>clock_timestamp()) RETURNING lease_expires_at`,
    [this.context.organizationId, row.node_id, this.config.leaseMs, mustBeLive])
    if (result.rows[0] === undefined) throw new NodeAccessError(409, 'node-access/lease-lost')
    return { ...this.identity(row.node_id), connectionId: row.connection_id as NodeLease['connectionId'],
      epoch: row.connection_epoch as NodeLease['epoch'], expiresAt: result.rows[0]!.lease_expires_at.toISOString(), heartbeatMs: this.config.heartbeatMs }
  }

  /**
   * Acquire an exclusive connection lease, or recover the same acquisition after a lost response.
   * @param token - node bearer credential.
   * @param input - connection UUID generated once per node-agent process.
   * @returns a new epoch after expiry/release; a live distinct connection is refused.
   */
  async connect(token: string, input: unknown): Promise<NodeLease> {
    const request = parse(connectionSchema, input)
    return transaction(this.context.pool, async tx => {
      await this.primary(tx)
      const row = await this.authenticate(tx, token)
      if (row.live && row.connection_id !== request.connectionId) throw new NodeAccessError(409, 'node-access/already-connected')
      if (row.attachment_state !== 'managed') {
        try {
          await tx.query("UPDATE harness.node_agents SET attachment_state='managed' WHERE organization_id=$1 AND node_id=$2",
            [this.context.organizationId, row.node_id])
          await tx.query('UPDATE harness.deployment_topology SET revision=revision+1 WHERE organization_id=$1', [this.context.organizationId])
        } catch (error) {
          if (error !== null && typeof error === 'object' && 'code' in error && ['55000', '55P03'].includes(String(error.code))) {
            throw new NodeAccessError(409, 'node-access/computer-busy')
          }
          throw error
        }
      }
      if (!row.live) {
        row.connection_epoch = (BigInt(row.connection_epoch) + 1n).toString()
        row.connection_id = request.connectionId
        await tx.query('UPDATE harness.node_agents SET connection_id=$3,connection_epoch=$4,lease_expires_at=clock_timestamp() WHERE organization_id=$1 AND node_id=$2',
          [this.context.organizationId, row.node_id, row.connection_id, row.connection_epoch])
      }
      return this.renew(tx, row, row.live)
    })
  }

  /**
   * Renew only the exact, unexpired connection generation.
   * @param token - node bearer credential, rechecked on every heartbeat.
   * @param input - current connection UUID and decimal epoch.
   * @returns renewed control lease; expiry cannot be revived by a delayed heartbeat.
   */
  async heartbeat(token: string, input: unknown): Promise<NodeLease> {
    const request = parse(leaseRequestSchema, input)
    return transaction(this.context.pool, async tx => {
      await this.primary(tx, false)
      const row = await this.authenticate(tx, token)
      if (!row.live || row.connection_id !== request.connectionId || row.connection_epoch !== request.epoch) throw new NodeAccessError(409, 'node-access/lease-lost')
      return this.renew(tx, row, true)
    })
  }

  /**
   * Authorize a control socket or reply against the current unexpired lease without renewing it.
   * Concurrent readers share the node row; credential and lease mutations retain exclusive ownership.
   * @param token - node bearer credential; revocation and organization status are rechecked.
   * @param input - exact process connection UUID and epoch from the control request.
   * @returns the authenticated lease; this read changes neither connectivity nor writer acknowledgements.
   */
  async authorizeChannel(token: string, input: unknown): Promise<NodeLease> {
    const request = parse(leaseRequestSchema, input)
    return transaction(this.context.pool, async tx => {
      const row = await this.authenticate(tx, token, 'SHARE')
      if (!row.live || row.connection_id !== request.connectionId || row.connection_epoch !== request.epoch) {
        throw new NodeAccessError(409, 'node-access/lease-lost')
      }
      return { ...this.identity(row.node_id), connectionId: row.connection_id as NodeLease['connectionId'],
        epoch: row.connection_epoch as NodeLease['epoch'], expiresAt: row.lease_expires_at!.toISOString(), heartbeatMs: this.config.heartbeatMs }
    })
  }

  /**
   * Authorize an administrator's diagnostic against a node owned by this organization.
   * @param actor - administrator candidate; current account and membership authority are rechecked.
   * @param rawId - untrusted node identifier from the request path.
   * @returns the canonical node ID; no node is contacted by this authorization read.
   */
  async authorizeAdministratorNode(actor: UserRow, rawId: string): Promise<RuntimeNodeId> {
    const nodeId = parse(nodeUuidSchema, rawId)
    return transaction(this.context.pool, async tx => {
      await this.administrator(tx, actor)
      const node = await tx.query(`SELECT 1 FROM harness.compute_nodes node WHERE node.organization_id=$1 AND node.id=$2
        AND harness.entry_node_visible(node.organization_id,$3,node.id)`,
      [this.context.organizationId, nodeId, this.context.nodeId])
      if (node.rowCount === 0) throw new NodeAccessError(404, 'node-access/not-found')
      return nodeId as RuntimeNodeId
    })
  }

  /**
   * Release this generation without changing instance state or maintenance acknowledgements.
   * @param token - node bearer credential.
   * @param input - exact connection UUID and epoch; repeating release is safe until reacquisition.
   * @returns after the matching lease expires; a stale generation cannot disconnect its successor.
   */
  async disconnect(token: string, input: unknown): Promise<void> {
    const request = parse(leaseRequestSchema, input)
    await transaction(this.context.pool, async tx => {
      const row = await this.authenticate(tx, token)
      if (row.connection_id !== request.connectionId || row.connection_epoch !== request.epoch) throw new NodeAccessError(409, 'node-access/lease-lost')
      await tx.query(`UPDATE harness.node_agents SET lease_expires_at=LEAST(lease_expires_at,clock_timestamp())
        WHERE organization_id=$1 AND node_id=$2`, [this.context.organizationId, row.node_id])
    })
  }
}
