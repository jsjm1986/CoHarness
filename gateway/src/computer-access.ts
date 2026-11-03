/** Organization-owned computer use; project membership and capability consent remain separate. */
import type { UserRow } from './auth.ts'
import type { RuntimeCatalogLimits, RuntimeNodeId } from './runtime-catalog.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { transaction } from './postgres/database.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { nodeUuidSchema } from './node-access.ts'
import { CollaborationDeniedError } from './collaboration.ts'

/** Explicit use permission on one registered computer; revision zero means no saved decision. */
export interface ComputerUsePermission {
  nodeId: RuntimeNodeId
  name: string
  status: 'active' | 'draining' | 'offline'
  enabled: boolean
  revision: string
}

/** Bounded metadata page; the UUID cursor skips preceding nodes without granting access. */
export interface ComputerUsePage { items: ComputerUsePermission[]; nextCursor: RuntimeNodeId | null }

/** Expected computer-authorization refusal, independent of browser authentication. */
export class ComputerAccessError extends Error {
  /**
   * @param status - HTTP status for the refused operation.
   * @param code - stable diagnostic consumed by the caller.
   */
  constructor(readonly status: 400 | 403 | 404 | 409 | 413 | 503,
    readonly code: 'computer-access/invalid-request' | 'computer-access/forbidden' | 'computer-access/not-found'
      | 'computer-access/revision-conflict' | 'computer-access/response-too-large' | 'computer-access/unavailable') {
    super(code); this.name = 'ComputerAccessError'
  }
}

/** Current database authority used by browser dispatch and organization management. */
export interface GatewayComputerAccess {
  /**
   * Require the account's current permission on this Gateway's computer.
   * @param userId - authenticated organization account.
   * @returns after current account, membership and computer permission pass.
   */
  authorize(userId: number, nodeId?: RuntimeNodeId): Promise<void>
  /**
   * Read one bounded directory page without probing computers or allocating runtimes.
   * @param actor - authenticated account; administrator reads recheck current role.
   * @param query - untrusted pagination fields.
   * @param userId - administrator-selected account; omission lists the actor's granted computers.
   * @returns current permission metadata for this organization.
   */
  page(actor: UserRow, query: { cursor?: string; limit?: string }, userId?: number): Promise<ComputerUsePage>
  /**
   * Change use permission with current administrator authority and optimistic revision.
   * @param actor - authenticated administrator candidate, rechecked inside the transaction.
   * @param userId - organization account whose access is configured.
   * @param nodeId - registered computer UUID from the wire.
   * @param value - requested enabled decision and observed decimal revision.
   * @returns committed permission; revocation does not certify that running work has stopped.
   */
  set(actor: UserRow, userId: number, nodeId: string, value: unknown): Promise<ComputerUsePermission>
}

interface Row { node_id: string; name: string; status: ComputerUsePermission['status']; enabled: boolean; revision: string }
const entry = (row: Row): ComputerUsePermission => ({ nodeId: row.node_id as RuntimeNodeId, name: row.name,
  status: row.status, enabled: row.enabled, revision: row.revision })

/** Transactional permissions over the existing organization and compute-node records. */
export class PostgresComputerAccess implements GatewayComputerAccess {
  /**
   * @param context - organization and local node owned by this Gateway.
   * @param limits - existing validated directory row and complete-response byte budgets.
   */
  constructor(private readonly context: PostgresRuntimeContext, private readonly limits: RuntimeCatalogLimits, private readonly entryNodeId?: RuntimeNodeId) {}

  async authorize(userId: number, nodeId: RuntimeNodeId = this.context.nodeId as RuntimeNodeId): Promise<void> {
    const result = await this.context.pool.query(`SELECT 1 FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$2
      AND harness.computer_use_allowed($1,u.id,$3) AND ($4::uuid IS NULL OR harness.entry_node_visible($1,$4,$3))`,
      [this.context.organizationId, userId, nodeId, this.entryNodeId ?? null])
    if (result.rowCount !== 1) throw new ComputerAccessError(403, 'computer-access/forbidden')
  }

  async page(actor: UserRow, query: { cursor?: string; limit?: string }, userId?: number): Promise<ComputerUsePage> {
    const limit = query.limit === undefined ? this.limits.pageSize : Number(query.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.pageSize
      || query.limit !== undefined && !/^[1-9][0-9]*$/u.test(query.limit)
      || query.cursor !== undefined && !nodeUuidSchema.safeParse(query.cursor).success
      || userId !== undefined && (!Number.isSafeInteger(userId) || userId < 1)) {
      throw new ComputerAccessError(400, 'computer-access/invalid-request')
    }
    const result = await this.context.pool.query<{ authorized: boolean; target_exists: boolean; entries: Row[] }>(`WITH actor AS MATERIALIZED (
      SELECT u.id,m.role FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.organizations o ON o.id=u.organization_id
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
        AND m.status='active' AND o.status='active' AND ($3::bigint IS NULL OR m.role='admin')
    ), target AS MATERIALIZED (
      SELECT u.id FROM harness.users u CROSS JOIN actor WHERE u.organization_id=$1 AND u.public_id=COALESCE($3,$2) AND u.deleted_at IS NULL
    ), entries AS (
      SELECT n.id node_id,n.name::text,n.status,COALESCE(p.enabled,false) enabled,COALESCE(p.revision,0)::text revision
      FROM harness.compute_nodes n CROSS JOIN target t LEFT JOIN harness.computer_use_permissions p
        ON p.organization_id=n.organization_id AND p.node_id=n.id AND p.user_id=t.id
      WHERE n.organization_id=$1 AND ($4::uuid IS NULL OR n.id>$4) AND ($3::bigint IS NOT NULL OR p.enabled)
        AND ($6::uuid IS NULL OR harness.entry_node_visible(n.organization_id,$6,n.id))
      ORDER BY n.id LIMIT $5
    ) SELECT EXISTS(SELECT 1 FROM actor) authorized,EXISTS(SELECT 1 FROM target) target_exists,
      COALESCE((SELECT jsonb_agg(to_jsonb(entries) ORDER BY node_id) FROM entries),'[]'::jsonb) entries`,
    [this.context.organizationId, actor.id, userId ?? null, query.cursor ?? null, limit + 1, this.entryNodeId ?? null])
    const page = result.rows[0]!
    if (!page.authorized) throw new ComputerAccessError(403, 'computer-access/forbidden')
    if (!page.target_exists) throw new ComputerAccessError(404, 'computer-access/not-found')
    const items: ComputerUsePermission[] = []
    for (const row of page.entries.slice(0, limit)) {
      const next = entry(row), nextCursor = page.entries.length > items.length + 1 ? next.nodeId : null
      if (Buffer.byteLength(JSON.stringify({ items: [...items, next], nextCursor })) > this.limits.maxBytes) {
        if (items.length === 0) throw new ComputerAccessError(413, 'computer-access/response-too-large')
        return { items, nextCursor: items.at(-1)!.nodeId }
      }
      items.push(next)
    }
    return { items, nextCursor: page.entries.length > items.length ? items.at(-1)!.nodeId : null }
  }

  async set(actor: UserRow, userId: number, nodeId: string, value: unknown): Promise<ComputerUsePermission> {
    if (!Number.isSafeInteger(userId) || userId < 1 || !nodeUuidSchema.safeParse(nodeId).success
      || typeof value !== 'object' || value === null || Array.isArray(value)
      || !('enabled' in value) || typeof value.enabled !== 'boolean' || !('revision' in value) || typeof value.revision !== 'string'
      || !/^(0|[1-9][0-9]{0,18})$/u.test(value.revision) || Object.keys(value).some(key => !['enabled', 'revision'].includes(key))) {
      throw new ComputerAccessError(400, 'computer-access/invalid-request')
    }
    const { enabled, revision } = value
    return transaction(this.context.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`gateway-admin:${this.context.organizationId}`])
      try { await lockAdministrator(client, this.context, actor.id) }
      catch (error) {
        if (error instanceof CollaborationDeniedError) throw new ComputerAccessError(403, 'computer-access/forbidden')
        throw error
      }
    if (this.entryNodeId !== undefined) {
      const visible = await client.query<{ allowed: boolean }>('SELECT harness.entry_node_visible($1,$2,$3) allowed',
        [this.context.organizationId, this.entryNodeId, nodeId])
      if (visible.rows[0]?.allowed !== true) throw new ComputerAccessError(403, 'computer-access/forbidden')
    }
      const target = await client.query<{ id: string; active: boolean }>(`SELECT u.id,(u.status='active' AND m.status='active') active
        FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.deleted_at IS NULL FOR UPDATE OF u`, [this.context.organizationId, userId])
      const user = target.rows[0]
      const nodes = await client.query<{ name: string; status: Row['status'] }>(`SELECT name::text,status FROM harness.compute_nodes
        WHERE organization_id=$1 AND id=$2 FOR SHARE`, [this.context.organizationId, nodeId])
      const node = nodes.rows[0]
      if (user === undefined || node === undefined) throw new ComputerAccessError(404, 'computer-access/not-found')
      if (enabled && !user.active) throw new ComputerAccessError(403, 'computer-access/forbidden')
      const existing = await client.query<{ enabled: boolean; revision: string }>(`SELECT enabled,revision::text
        FROM harness.computer_use_permissions WHERE organization_id=$1 AND node_id=$2 AND user_id=$3 FOR UPDATE`,
      [this.context.organizationId, nodeId, user.id])
      const current = existing.rows[0]
      if ((current?.revision ?? '0') !== revision) throw new ComputerAccessError(409, 'computer-access/revision-conflict')
      if (current?.enabled === enabled) return { ...node, nodeId: nodeId as RuntimeNodeId, enabled, revision }
      const saved = await client.query<{ revision: string }>(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
        VALUES($1,$2,$3,$4) ON CONFLICT(organization_id,node_id,user_id) DO UPDATE
        SET enabled=excluded.enabled,revision=computer_use_permissions.revision+1,updated_at=clock_timestamp() RETURNING revision::text`,
      [this.context.organizationId, nodeId, user.id, enabled])
      const result = { ...node, nodeId: nodeId as RuntimeNodeId, enabled, revision: saved.rows[0]!.revision }
      await client.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,outcome,detail)
        VALUES($1,(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2),'admin.computer-use.set','computer','success',$3::jsonb)`,
      [this.context.organizationId, actor.id, JSON.stringify({ userId, ...result })])
      return result
    })
  }
}
