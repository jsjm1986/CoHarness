/** Organization deployment policy and browser-entry identity; Runtime placement remains independent. @module */
import { z } from 'zod'
import { isIP } from 'node:net'
import type { UserRow } from './auth.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { transaction, type Queryable } from './postgres/database.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'

import type { DeploymentContext, DeploymentBlocker, DeploymentPreflight, DeploymentCandidates } from './deployment-protocol.ts'
export type { DeploymentContext, DeploymentBlocker, DeploymentPreflight } from './deployment-protocol.ts'

/** Declared topology refusal; it never changes a request's target. */
export class DeploymentTopologyError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 503, readonly code: string) { super(code); this.name = 'DeploymentTopologyError' }
}

interface Row {
  enabled: boolean; revision: string; primary_node_id: RuntimeNodeId | null; primary_origin: string | null;
  primary_name: string | null; attachment_state: string | null; legacy_initialization_required: boolean
}

const uuidTest = (value: string): boolean => z.uuid().safeParse(value).success
const update = z.object({ revision: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u), enabled: z.boolean(),
  primaryOrigin: z.string().optional() }).strict()

function origin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new DeploymentTopologyError(400, 'deployment/invalid-origin') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:') || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new DeploymentTopologyError(400, 'deployment/invalid-origin')
  return url.origin
}

/** Durable organization settings; all resource traffic still uses existing computer and Runtime authorization. */
export class PostgresDeploymentTopology {
  constructor(private readonly context: PostgresRuntimeContext, private readonly options: {
    legacyForwarding: boolean; refreshAfterMs: number; pageSize: number; maxBytes: number; allowedOrigins: readonly string[]
  }) {}

  private async row(query: Queryable): Promise<Row> {
    const result = await query.query<Row>(`SELECT t.enabled,t.revision::text,t.primary_node_id,t.primary_origin,t.legacy_initialization_required,
      n.name::text primary_name,a.attachment_state FROM harness.deployment_topology t
      LEFT JOIN harness.compute_nodes n ON n.organization_id=t.organization_id AND n.id=t.primary_node_id
      LEFT JOIN harness.node_agents a ON a.organization_id=t.organization_id AND a.node_id=$2
      WHERE t.organization_id=$1`, [this.context.organizationId, this.context.nodeId])
    const row = result.rows[0]
    if (row === undefined) throw new DeploymentTopologyError(503, 'deployment/configuration-unavailable')
    return row
  }

  private view(row: Row): DeploymentContext {
    const primary = row.primary_node_id === null ? null : { nodeId: row.primary_node_id,
      name: row.primary_name!, origin: row.primary_origin! }
    const aggregate = row.enabled && row.primary_node_id === this.context.nodeId
    return { mode: row.enabled ? 'multi' : 'single', revision: row.revision,
      entry: { nodeId: this.context.nodeId as RuntimeNodeId, name: this.context.nodeName }, primary,
      scope: aggregate ? 'organization' : 'local', role: aggregate ? 'primary'
        : row.enabled && row.attachment_state === 'managed' ? 'computer' : 'standalone',
      refreshAfterMs: this.options.refreshAfterMs,
      legacyMigrationRequired: row.legacy_initialization_required }
  }

  /** Read entry-local policy without contacting another computer or starting a Runtime.
   * @param query - current retained transaction, or the entry's pool for standalone reads.
   * @returns current policy for this entry.
   */
  async read(query: Queryable = this.context.pool): Promise<DeploymentContext> { return this.view(await this.row(query)) }

  /** Read configuration after retaining current administrator eligibility. @param actor - authenticated administrator candidate. */
  async adminRead(actor: UserRow): Promise<DeploymentContext> {
    return transaction(this.context.pool, async tx => {
      await lockAdministrator(tx, this.context, actor.id)
      return this.view(await this.row(tx))
    })
  }

  private async blockers(query: Queryable): Promise<DeploymentPreflight> {
    const read = await query.query<{ total: string; computers: DeploymentBlocker[] }>(`WITH blockers AS (
      SELECT a.node_id "nodeId",n.name::text name,a.attachment_state state,
        (SELECT count(*)::int FROM harness.instances i WHERE i.organization_id=a.organization_id AND i.assigned_node_id=a.node_id
          AND (i.observed_state<>'stopped' OR i.desired_state<>'stopped')) "activeRuntimes"
      FROM harness.node_agents a JOIN harness.compute_nodes n ON n.id=a.node_id AND n.organization_id=a.organization_id
      WHERE a.organization_id=$1 AND a.attachment_state<>'detached' ORDER BY n.name,n.id
    ) SELECT (SELECT count(*)::text FROM blockers) total,
      COALESCE((SELECT jsonb_agg(page) FROM (SELECT * FROM blockers LIMIT $2) page),'[]'::jsonb) computers`,
    [this.context.organizationId, this.options.pageSize])
    const row = read.rows[0]!
    const result: DeploymentPreflight = { canDisable: row.total === '0', blockingCount: Number(row.total), computers: [] }
    for (const computer of row.computers) {
      if (Buffer.byteLength(JSON.stringify({ ...result, computers: [...result.computers, computer] })) > this.options.maxBytes) break
      result.computers.push(computer)
    }
    if (row.computers.length > 0 && result.computers.length === 0) throw new DeploymentTopologyError(503, 'deployment/metadata-too-large')
    return result
  }

  /** Inspect retained attachments without probing disconnected computers. @param actor - current administrator. */
  async preflight(actor: UserRow): Promise<DeploymentPreflight> {
    return transaction(this.context.pool, async tx => {
      await lockAdministrator(tx, this.context, actor.id)
      return this.blockers(tx)
    })
  }

  /** List prepared local Gateways without reserving or changing their authority. @param actor - current administrator. @param cursor - preceding page continuation. @returns bounded metadata. */
  async candidates(actor: UserRow, cursor?: string): Promise<DeploymentCandidates> {
    if (cursor !== undefined && !uuidTest(cursor)) throw new DeploymentTopologyError(400, 'deployment/invalid-request')
    return transaction(this.context.pool, async tx => {
      await lockAdministrator(tx, this.context, actor.id)
      const policy = await this.row(tx)
      if (!policy.enabled || policy.primary_node_id !== this.context.nodeId) throw new DeploymentTopologyError(403, 'deployment/primary-required')
      const rows = (await tx.query<{ nodeId: RuntimeNodeId; name: string }>(`SELECT n.id "nodeId",n.name::text name FROM harness.compute_nodes n
        WHERE n.organization_id=$1 AND n.id<>$2 AND ($3::uuid IS NULL OR n.id>$3)
          AND NOT EXISTS(SELECT 1 FROM harness.node_agents a WHERE a.organization_id=n.organization_id AND a.node_id=n.id)
        ORDER BY n.id LIMIT $4`, [this.context.organizationId, this.context.nodeId, cursor ?? null, this.options.pageSize + 1])).rows
      const result: DeploymentCandidates = { items: [], nextCursor: null }
      for (const row of rows.slice(0, this.options.pageSize)) {
        const next = rows.length > result.items.length + 1 ? row.nodeId : null
        if (Buffer.byteLength(JSON.stringify({ items: [...result.items, row], nextCursor: next })) > this.options.maxBytes) {
          if (result.items.length === 0) throw new DeploymentTopologyError(503, 'deployment/metadata-too-large')
          result.nextCursor = result.items.at(-1)!.nodeId
          break
        }
        result.items.push(row); result.nextCursor = next
      }
      return result
    })
  }

  /**
   * Apply a reviewed organization mode; enabling selects this ingress as primary.
   * @param actor - administrator whose current membership is rechecked.
   * @param value - untrusted revision, mode and configured HTTPS origin.
   * @param ip - browser request source, when available.
   * @returns committed entry policy; a rejected preflight preserves every setting.
   */
  async save(actor: UserRow, value: unknown, ip?: string): Promise<DeploymentContext> {
    const parsed = update.safeParse(value)
    if (!parsed.success) throw new DeploymentTopologyError(400, 'deployment/invalid-request')
    const input = parsed.data
    return transaction(this.context.pool, async tx => {
      await lockAdministrator(tx, this.context, actor.id)
      await tx.query('SELECT 1 FROM harness.deployment_topology WHERE organization_id=$1 FOR UPDATE', [this.context.organizationId])
      const current = await this.row(tx)
      if (current.revision !== input.revision) throw new DeploymentTopologyError(409, 'deployment/revision-conflict')
      if (current.legacy_initialization_required && (!input.enabled || !this.options.legacyForwarding)) {
        throw new DeploymentTopologyError(409, 'deployment/legacy-primary-required')
      }
      if (current.enabled && current.primary_node_id !== this.context.nodeId) throw new DeploymentTopologyError(403, 'deployment/primary-required')
      if (!input.enabled && !(await this.blockers(tx)).canDisable) throw new DeploymentTopologyError(409, 'deployment/computers-still-attached')
      if (input.enabled && current.attachment_state === 'managed') throw new DeploymentTopologyError(409, 'deployment/current-computer-attached')
      const address = input.enabled ? origin(input.primaryOrigin ?? current.primary_origin ?? '') : current.primary_origin
      if (input.enabled && !this.options.allowedOrigins.includes(address!)) throw new DeploymentTopologyError(409, 'deployment/origin-not-configured')
      await tx.query(`UPDATE harness.deployment_topology SET enabled=$2,legacy_initialization_required=false,
        primary_node_id=CASE WHEN $2 THEN $3::uuid ELSE primary_node_id END,primary_origin=$4,
        revision=revision+1,updated_at=clock_timestamp() WHERE organization_id=$1`,
      [this.context.organizationId, input.enabled, this.context.nodeId, address])
      const result = this.view(await this.row(tx))
      const addressIp = ip?.replace(/^::ffff:/u, '')
      await tx.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,outcome,source_ip,detail)
        VALUES($1,(SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2),
          'admin.deployment.topology','deployment','success',$3::inet,$4::jsonb)`,
      [this.context.organizationId, actor.id, addressIp !== undefined && isIP(addressIp) !== 0 ? addressIp : null,
        JSON.stringify({ mode: result.mode, revision: result.revision, primaryNodeId: result.primary?.nodeId ?? null })])
      return result
    })
  }

  /** Refuse foreign targets outside this ingress's aggregation scope. @param nodeId - resolved resource computer. */
  async assertNode(nodeId: string): Promise<void> {
    if (nodeId === this.context.nodeId) return
    const result = await this.context.pool.query<{ allowed: boolean }>('SELECT harness.entry_node_visible($1,$2,$3) allowed',
      [this.context.organizationId, this.context.nodeId, nodeId])
    if (result.rows[0]?.allowed !== true) throw new DeploymentTopologyError(409, 'deployment/remote-target-unavailable')
  }
}
