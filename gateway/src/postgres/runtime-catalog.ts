/** Organization directory reads remain independent of node connectivity and runtime startup. */
import type { UserRow } from '../auth.ts'
import { createHash } from 'node:crypto'
import { RuntimeCatalogError } from '../runtime-catalog.ts'
import type { RuntimeCatalogCursor, RuntimeCatalogEntry, RuntimeCatalogLimits, RuntimeCatalogPage, RuntimeCatalogQuery, RuntimeId, RuntimeNodeId } from '../runtime-catalog.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'
import type { Queryable } from './database.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

interface Row {
  id: string
  kind: 'user' | 'project'
  public_id: string
  name: string
  node_id: string
  node_name: string
  node_status: 'active' | 'draining' | 'offline'
  last_heartbeat_at: string | null
  observed_state: string
  generation: string
  provisioning_state: 'preparing' | 'ready'
}

interface Cursor {
  version: 1
  organization: string
  actor: number
  audience: 'account' | 'admin'
  after: string
  owner?: string
  selection?: string
  entry?: string
}

function encodeCursor(value: Cursor): RuntimeCatalogCursor {
  return Buffer.from(JSON.stringify(value)).toString('base64url') as RuntimeCatalogCursor
}

function decodeCursor(value: string | undefined, expected: Omit<Cursor, 'after'>): string | null {
  if (value === undefined) return null
  if (value.length > 512) throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-cursor')
  let parsed: unknown
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) }
  catch { throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-cursor') }
  if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1
    || !('organization' in parsed) || parsed.organization !== expected.organization
    || !('actor' in parsed) || parsed.actor !== expected.actor
    || !('audience' in parsed) || parsed.audience !== expected.audience
    || !('after' in parsed) || typeof parsed.after !== 'string' || !UUID.test(parsed.after)
    || encodeCursor({ ...expected, after: parsed.after }) !== value) {
    throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-cursor')
  }
  return parsed.after
}

/** PostgreSQL-backed environment metadata with current actor and project authorization. */
export class PostgresRuntimeCatalog {
  /**
   * @param context - authenticated organization and local Gateway node.
   * @param limits - deployment-validated row and complete-response byte limits.
   */
  constructor(private readonly context: Pick<PostgresRuntimeContext, 'organizationId' | 'nodeId'> & { pool: Queryable },
    private readonly limits: RuntimeCatalogLimits, private readonly entryNodeId?: RuntimeNodeId) {}

  /**
   * List the actor's personal and authorized project environments without contacting nodes.
   * @param actor - authenticated account; current database authority is rechecked.
   * @param query - untrusted HTTP pagination fields.
   * @returns one page restricted to current account and project access.
   * @throws RuntimeCatalogError for malformed pagination, revoked authority, or an oversized row.
   */
  pageForAccount(actor: UserRow, query: RuntimeCatalogQuery): Promise<RuntimeCatalogPage> {
    return this.page(actor, query, 'account')
  }

  /**
   * List all active environments after rechecking administrator membership.
   * @param actor - authenticated administrator candidate.
   * @param query - untrusted HTTP pagination fields.
   * @returns one organization-wide metadata page.
   * @throws RuntimeCatalogError for malformed pagination, revoked administrator authority, or an oversized row.
   */
  pageForAdministrator(actor: UserRow, query: RuntimeCatalogQuery): Promise<RuntimeCatalogPage> {
    return this.page(actor, query, 'admin')
  }

  /**
   * Read bounded owner-specific administration metadata across computers.
   * @param actor - current administrator candidate.
   * @param owner - account or project being managed.
   * @param query - untrusted pagination fields.
   * @returns one page without contacting any computer.
   */
  pageForAdministratorOwner(actor: UserRow, owner: { kind: 'personal' | 'project'; id: number }, query: RuntimeCatalogQuery): Promise<RuntimeCatalogPage> {
    return this.page(actor, query, 'admin', undefined, owner)
  }

  /**
   * Resolve one authorized environment before its placement is dispatched by the runtime router.
   * @param actor - authenticated account whose current access is rechecked.
   * @param id - untrusted environment UUID from the request URL.
   * @returns the exact authorized environment and its node, without starting or contacting it.
   * @throws RuntimeCatalogError for malformed, inaccessible or retired environments.
   */
  async resolveForAccount(actor: UserRow, id: string): Promise<RuntimeCatalogEntry> {
    if (!UUID.test(id)) throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-id')
    const entry = (await this.page(actor, { limit: '1' }, 'account', id as RuntimeId)).items[0]
    if (entry === undefined) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
    return entry
  }

  /**
   * Resolve an environment for existing purpose-limited administrator management.
   * @param actor - current administrator candidate; ownership and computer-use grants are not required for Admin management.
   * @param id - untrusted allocated Runtime UUID.
   * @returns exact organization metadata without starting or contacting its computer.
   */
  async resolveForAdministrator(actor: UserRow, id: string): Promise<RuntimeCatalogEntry> {
    if (!UUID.test(id)) throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-id')
    const entry = (await this.page(actor, { limit: '1' }, 'admin', id as RuntimeId)).items[0]
    if (entry === undefined) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
    return entry
  }

  /**
   * Resolve an existing owner selector without choosing among multiple environments.
   * @param actor - authenticated account whose computer and project access is rechecked.
   * @param owner - personal account or project selected by an existing business interface.
   * @returns the unique accessible assignment, without contacting its computer.
   * @throws RuntimeCatalogError when absent, unauthorized or ambiguous; ambiguity requires an explicit RuntimeId.
   */
  async resolveForOwner(actor: UserRow, owner: { kind: 'personal' | 'project'; id: number }): Promise<RuntimeCatalogEntry> {
    const page = await this.page(actor, { limit: '1' }, 'account', undefined, owner)
    if (page.nextCursor !== null) throw new RuntimeCatalogError(409, 'runtime-catalog/ambiguous-target')
    const entry = page.items[0]
    if (entry === undefined) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
    return entry
  }

  /**
   * Resolve the personal environment used to enter the existing Harness UI without an explicit target.
   * Prefer this entry computer, its preserved personal storage, then allocation order; connectivity never changes the choice.
   * @param actor - current authenticated account whose computer permissions remain required.
   * @returns the first authorized personal assignment, without starting any Runtime.
   * @throws RuntimeCatalogError when the account or all personal assignments are unavailable.
   */
  async resolveForLanding(actor: UserRow): Promise<RuntimeCatalogEntry> {
    const page = await this.page(actor, { limit: '1' }, 'account', undefined, { kind: 'personal', id: actor.id }, true)
    const entry = page.items[0]
    if (entry === undefined) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
    return entry
  }

  private async page(actor: UserRow, query: RuntimeCatalogQuery, audience: Cursor['audience'], only?: RuntimeId,
    owner?: { kind: 'personal' | 'project'; id: number }, landing = false): Promise<RuntimeCatalogPage> {
    const ids = query.ids === undefined ? undefined : [...new Set(query.ids.split(','))].sort()
    if (ids !== undefined && (query.ids!.length > 32 * 37 - 1 || query.ids!.split(',').length > 32 || ids.some(id => !UUID.test(id)))) throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-id')
    const limit = query.limit === undefined ? this.limits.pageSize : Number(query.limit)
    if ((query.limit !== undefined && !/^[1-9][0-9]*$/u.test(query.limit))
      || !Number.isSafeInteger(limit) || limit < 1 || limit > this.limits.pageSize) {
      throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-limit')
    }
    const cursor = { version: 1 as const, organization: this.context.organizationId, actor: actor.id, audience,
      ...(this.entryNodeId === undefined ? {} : { entry: this.entryNodeId }),
      ...(ids === undefined ? {} : { selection: createHash('sha256').update(ids.join(',')).digest('hex') }),
      ...(owner === undefined ? {} : { owner: `${owner.kind}:${owner.id}` }) }
    const after = decodeCursor(query.cursor, cursor)
    const result = await this.context.pool.query<{ authorized: boolean; entries: Row[] }>(`WITH actor AS MATERIALIZED (
      SELECT u.id,m.role FROM harness.users u
      JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active'
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
        AND ($3<>'admin' OR m.role='admin')
    ), entries AS (
      SELECT r.id,r.owner_kind kind,COALESCE(u.public_id,p.public_id)::text public_id,
        COALESCE(NULLIF(u.display_name,''),u.username::text,p.name::text) name,
        n.id node_id,n.name::text node_name,n.status node_status,n.last_heartbeat_at,
        i.observed_state,i.generation::text,i.provisioning_state,
        CASE WHEN $11::boolean AND r.node_id=$12::uuid THEN 0 ELSE 1 END landing_node,
        CASE WHEN $11::boolean AND i.storage_layout='legacy' THEN 0 ELSE 1 END landing_storage,
        CASE WHEN $11::boolean THEN r.created_at ELSE NULL::timestamptz END landing_created_at
      FROM harness.runtime_environments r
      JOIN harness.instances i ON i.runtime_id=r.id AND i.organization_id=r.organization_id
      JOIN harness.compute_nodes n ON n.id=r.node_id AND n.organization_id=r.organization_id
      CROSS JOIN actor a
      LEFT JOIN harness.users u ON r.owner_kind='user' AND u.id=r.owner_id AND u.organization_id=r.organization_id
        AND ($3='admin' OR u.status='active') AND u.deleted_at IS NULL
      LEFT JOIN harness.memberships owner_membership ON owner_membership.user_id=u.id
        AND owner_membership.organization_id=r.organization_id AND ($3='admin' OR owner_membership.status='active')
      LEFT JOIN harness.projects p ON r.owner_kind='project' AND p.id=r.owner_id
        AND p.organization_id=r.organization_id AND ($3='admin' OR p.status='active')
      LEFT JOIN harness.project_members pm ON pm.project_id=p.id AND pm.organization_id=r.organization_id AND pm.user_id=a.id
      WHERE r.organization_id=$1 AND r.retired_at IS NULL AND ($4::uuid IS NULL OR r.id>$4::uuid)
        AND ($6::uuid IS NULL OR r.id=$6::uuid)
        AND ($9::uuid[] IS NULL OR r.id=ANY($9::uuid[]))
        AND ($10::uuid IS NULL OR harness.entry_node_visible(r.organization_id,$10,r.node_id))
        AND ($7::text IS NULL OR (r.owner_kind=$7 AND COALESCE(u.public_id,p.public_id)=$8::bigint))
        AND ($3='admin' OR harness.computer_use_allowed(r.organization_id,a.id,r.node_id))
        AND ((u.id IS NOT NULL AND owner_membership.user_id IS NOT NULL AND ($3='admin' OR u.id=a.id))
          OR (p.id IS NOT NULL AND ($3='admin' OR (
            (p.kind<>'steward' AND (a.role='admin' OR pm.user_id IS NOT NULL))
            OR (p.kind='steward' AND a.role='admin' AND EXISTS(SELECT 1 FROM harness.steward_access_policies sp
              WHERE sp.organization_id=r.organization_id AND sp.user_id=a.id AND sp.node_id=r.node_id AND sp.enabled))))))
      ORDER BY landing_node,landing_storage,landing_created_at,r.id LIMIT $5
    ) SELECT EXISTS(SELECT 1 FROM actor) authorized,
      COALESCE((SELECT jsonb_agg(to_jsonb(entries) ORDER BY landing_node,landing_storage,landing_created_at,id) FROM entries),'[]'::jsonb) entries`,
    [this.context.organizationId, actor.id, audience, after, limit + 1, only ?? null,
      owner === undefined ? null : owner.kind === 'personal' ? 'user' : 'project', owner?.id ?? null, ids ?? null, this.entryNodeId ?? null,
      landing, this.context.nodeId])
    const page = result.rows[0]!
    if (!page.authorized) throw new RuntimeCatalogError(403, 'runtime-catalog/forbidden')
    const items: RuntimeCatalogEntry[] = []
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ items: [], nextCursor: null }))
    const nullBytes = Buffer.byteLength(JSON.stringify(null))
    let itemBytes = 0
    for (const row of page.entries.slice(0, limit)) {
      const entry: RuntimeCatalogEntry = {
        id: row.id as RuntimeId,
        owner: { kind: row.kind === 'user' ? 'personal' : 'project', id: publicNumber(row.public_id, 'Runtime owner'), name: row.name },
        node: { id: row.node_id as RuntimeNodeId, name: row.node_name, status: row.node_status,
          lastHeartbeatAt: row.last_heartbeat_at === null ? null : new Date(row.last_heartbeat_at).toISOString() },
        routing: row.node_id === this.context.nodeId ? 'local' : 'unavailable',
        observedState: row.observed_state,
        generation: publicNumber(row.generation, 'Runtime generation'),
        provisioning: row.provisioning_state,
      }
      const nextCursor = page.entries.length > items.length + 1 ? encodeCursor({ ...cursor, after: row.id }) : null
      const nextItemBytes = itemBytes + Buffer.byteLength(JSON.stringify(entry)) + (items.length === 0 ? 0 : 1)
      const bytes = envelopeBytes + nextItemBytes + Buffer.byteLength(JSON.stringify(nextCursor)) - nullBytes
      if (bytes > this.limits.maxBytes) {
        if (items.length === 0) throw new RuntimeCatalogError(413, 'runtime-catalog/entry-too-large')
        return { items, nextCursor: encodeCursor({ ...cursor, after: items.at(-1)!.id }) }
      }
      items.push(entry)
      itemBytes = nextItemBytes
    }
    return { items, nextCursor: page.entries.length > items.length && items.length > 0
      ? encodeCursor({ ...cursor, after: items.at(-1)!.id }) : null }
  }
}
