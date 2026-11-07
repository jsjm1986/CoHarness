/** Center-owned document locations; listing never starts a Runtime or reads a filesystem. */
import type { UserDocLocation, UserDocLocationPage } from '@deepseek-ai/dsh-userdoc'
import { DocumentCatalogError } from './document-catalog-service.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'
import type { DocumentTransferScope } from '../document-transfer.ts'
import type { RuntimeCatalogLimits, RuntimeNodeId } from '../runtime-catalog.ts'

interface Row { node_id: RuntimeNodeId; node_name: string; kind: 'personal' | 'project'; public_id: string; name: string; mode: 'ro' | 'rw' }

/** Bounded directory of currently authorized, computer-local document roots. */
export class PostgresDocumentLocations {
  /** @param context - shared organization database. @param limits - configured metadata row and UTF-8 response budgets. */
  constructor(private readonly context: PostgresRuntimeContext, private readonly limits: RuntimeCatalogLimits, private readonly entryNodeId?: RuntimeNodeId) {}

  private cursor(actor: number, row: Row): string {
    return Buffer.from(JSON.stringify([this.context.organizationId, actor, row.node_id, row.kind, row.public_id])).toString('base64url')
  }

  /**
   * Read one current-account page, including retained personal stores without a live Runtime assignment.
   * @param actor - authenticated public account id, rechecked by the query.
   * @param query - untrusted continuation and optional page size.
   * @returns authorized metadata only; continuation is bound to the organization and account.
   */
  async page(actor: number, query: { cursor?: string; limit?: string }): Promise<UserDocLocationPage> {
    const limit = query.limit === undefined ? this.limits.pageSize : Number(query.limit)
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.pageSize
      || query.limit !== undefined && !/^[1-9][0-9]*$/u.test(query.limit)) throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document location page size.')
    let after: readonly unknown[] | undefined
    if (query.cursor !== undefined) {
      try { after = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as readonly unknown[] }
      catch { throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document location cursor.') }
      if (!Array.isArray(after) || after.length !== 5 || after[0] !== this.context.organizationId || after[1] !== actor
        || typeof after[2] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(after[2]) || after[3] !== 'personal' && after[3] !== 'project'
        || typeof after[4] !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(after[4])) throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document location cursor.')
    }
    const rows = await this.read(actor, after, limit + 1)
    const items: UserDocLocation[] = []
    let nextCursor: string | null = null
    for (const row of rows.slice(0, limit)) {
      const location = { nodeId: row.node_id, nodeName: row.node_name }
      const item: UserDocLocation = { name: row.name, nodeName: row.node_name, mode: row.mode,
        scope: row.kind === 'personal' ? { kind: 'personal', ...location }
          : { kind: 'project', projectId: publicNumber(row.public_id, 'project'), ...location } }
      const continuation = rows.length > items.length + 1 ? this.cursor(actor, row) : null
      if (Buffer.byteLength(JSON.stringify({ items: [...items, item], nextCursor: continuation })) > this.limits.maxBytes) {
        if (items.length === 0) throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 413, 'One document location exceeds the metadata budget.')
        break
      }
      items.push(item); nextCursor = continuation
    }
    return { items, nextCursor }
  }
  /**
   * Recheck a selected document root without requiring an assigned or running Runtime.
   * @param actor - authenticated public account id.
   * @param scope - selected computer and personal/project root.
   * @param action - required read or write permission.
   * @returns current location, or a permission error after revocation or relocation.
   */
  async resolve(actor: number, scope: DocumentTransferScope, action: 'read' | 'write'): Promise<UserDocLocation> {
    const selected = { ...scope, nodeId: scope.nodeId ?? this.context.nodeId as RuntimeNodeId }
    const row = (await this.read(actor, undefined, 1, selected))[0]
    if (row === undefined || action === 'write' && row.mode !== 'rw') throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'This document location is unavailable or read-only.')
    return { name: row.name, nodeName: row.node_name, mode: row.mode, scope: {
      ...scope, nodeId: row.node_id, nodeName: row.node_name,
    } }
  }

  private async read(actor: number, after: readonly unknown[] | undefined, limit: number, selected?: DocumentTransferScope): Promise<Row[]> {
    const result = await this.context.pool.query<{ authorized: boolean; rows: Row[] }>(`WITH actor AS MATERIALIZED (
      SELECT u.id,u.organization_id,u.public_id,u.display_name,m.role FROM harness.users u
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
      JOIN harness.organizations organization ON organization.id=u.organization_id AND organization.status='active'
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
    ), locations AS (
      SELECT n.id node_id,n.name::text node_name,'personal'::text kind,actor.public_id,actor.display_name::text name,'rw'::text mode
      FROM actor JOIN harness.node_user_accounts account ON account.organization_id=actor.organization_id AND account.user_id=actor.id
      JOIN harness.compute_nodes n ON n.organization_id=account.organization_id AND n.id=account.node_id
      WHERE harness.computer_use_allowed(actor.organization_id,actor.id,n.id)
      UNION ALL
      SELECT n.id,n.name::text,'project'::text,p.public_id,p.name::text,
        CASE WHEN actor.role='admin' THEN 'rw'::text ELSE member.access_mode END mode
      FROM actor JOIN harness.projects p ON p.organization_id=actor.organization_id AND p.status='active'
      JOIN harness.instances instance ON instance.organization_id=p.organization_id AND instance.project_id=p.id
      JOIN harness.compute_nodes n ON n.organization_id=instance.organization_id AND n.id=instance.assigned_node_id
      LEFT JOIN harness.project_members member ON member.organization_id=p.organization_id AND member.project_id=p.id AND member.user_id=actor.id
      WHERE harness.project_computer_use_allowed(actor.organization_id,actor.id,p.id) AND (actor.role='admin' OR member.user_id IS NOT NULL)
        AND (p.kind<>'steward' OR actor.role='admin' AND EXISTS(SELECT 1 FROM harness.steward_access_policies policy
          WHERE policy.organization_id=actor.organization_id AND policy.node_id=n.id AND policy.user_id=actor.id AND policy.enabled))
    ), page AS (
      SELECT * FROM locations WHERE ($10::uuid IS NULL OR harness.entry_node_visible($1,$10,node_id)) AND ($3::uuid IS NULL OR (node_id,kind,public_id)>($3::uuid,$4::text,$5::bigint))
        AND ($7::uuid IS NULL OR node_id=$7::uuid AND kind=$8::text AND ($9::bigint IS NULL OR public_id=$9::bigint))
      ORDER BY node_id,kind,public_id LIMIT $6
    ) SELECT EXISTS(SELECT 1 FROM actor) authorized,
      COALESCE((SELECT jsonb_agg(to_jsonb(page) || jsonb_build_object('public_id',public_id::text) ORDER BY node_id,kind,public_id) FROM page),'[]'::jsonb) rows`,
    [this.context.organizationId, actor, after?.[2] ?? null, after?.[3] ?? null, after?.[4] ?? null, limit, selected?.nodeId ?? null, selected?.kind ?? null, selected?.kind === 'project' ? selected.projectId : null, this.entryNodeId ?? null])
    const page = result.rows[0]!
    if (!page.authorized) throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Document locations are unavailable to this account.')
    return page.rows
  }

}
