import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

/** Scope addressed by the organization document catalog. */
export type DocumentCatalogScope =
  | { readonly kind: 'personal'; readonly userId: number }
  | { readonly kind: 'project'; readonly projectId: number }

/** Metadata reported by a runtime without exposing its absolute file path. */
export interface DocumentCatalogInput {
  readonly docId: string
  readonly directoryId?: string
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
}

/** Safe catalog row projected to runtime and browser callers. */
export interface DocumentCatalogRow {
  readonly catalogId: string
  readonly scope: { readonly kind: 'personal' | 'project'; readonly id?: number; readonly label: string; readonly mode?: 'ro' | 'rw' }
  readonly docId: string
  readonly directoryId: string
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
  readonly owner: { readonly id: number; readonly displayName: string } | null
  readonly ownerSource: 'upload' | 'transfer' | 'legacy' | 'admin'
  readonly state: 'active' | 'deleted'
  readonly legacy: boolean
  readonly lineageRootId: string | null
}

/** Filter accepted by the independent administrator document dashboard. */
export interface DocumentCatalogAdminFilter {
  readonly scopeKind?: 'personal' | 'project'
  readonly projectId?: number
  readonly ownerUserId?: number
  readonly state?: 'active' | 'deleted' | 'all'
  readonly query?: string
  readonly limit?: number
  readonly offset?: number
}

/** One operation item returned by the admin detail drawer. */
export interface DocumentCatalogHistoryRow {
  readonly id: number
  readonly eventKind: string
  readonly actor: { readonly id: number; readonly displayName: string } | null
  readonly operationId: string | null
  readonly detail: unknown
  readonly createdAt: number
}

/** Detailed metadata and lineage for one catalog document. */
export interface DocumentCatalogDetail {
  readonly document: DocumentCatalogRow
  readonly history: readonly DocumentCatalogHistoryRow[]
  readonly copies: readonly {
    readonly operationId: string
    readonly status: string
    readonly source: { readonly name: string; readonly docId: string }
    readonly targetDocId: string | null
    readonly error: { readonly code: string; readonly message: string } | null
    readonly createdAt: number
  }[]
}

/** Recent audited operations visible to a member in one document scope. */
export interface DocumentCatalogScopeHistoryRow extends DocumentCatalogHistoryRow {
  readonly catalogId: string | null
  readonly documentName: string | null
}

/** Aggregate counters used by the administrator dashboard. */
export interface DocumentCatalogMetrics {
  readonly total: number
  readonly active: number
  readonly deleted: number
  readonly personal: number
  readonly project: number
  readonly bytes: number
  readonly operations24h: number
  readonly failures24h: number
}

/** Stable catalog refusal which can be mapped to an HTTP status. */
export class DocumentCatalogError extends Error {
  /** @param code - stable wire code. @param status - HTTP status. @param message - safe diagnostic. */
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.name = 'DocumentCatalogError'
  }
}

interface ScopeIds {
  readonly kind: 'personal' | 'project'
  readonly userId: string | null
  readonly projectId: string | null
  readonly publicId: number
  readonly label: string
}

interface CatalogDbRow {
  catalog_id: string
  scope_kind: 'personal' | 'project'
  scope_public_id: string
  scope_label: string
  access_mode: 'ro' | 'rw' | null
  runtime_doc_id: string
  directory_id: string
  name: string
  bytes: string
  media_type: string
  modified_at_ms: string
  owner_public_id: string | null
  owner_display_name: string | null
  owner_source: 'upload' | 'transfer' | 'legacy' | 'admin'
  legacy: boolean
  lineage_root_id: string | null
  state: 'active' | 'deleted'
}

function safeNumber(value: string | number, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is outside the safe integer range`)
  return number
}

function jsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number') return value
  if (Array.isArray(value)) return value
  if (typeof value === 'object') return value
  return String(value)
}

function scopeRow(row: CatalogDbRow): DocumentCatalogRow {
  const id = publicNumber(row.scope_public_id, row.scope_kind === 'project' ? 'project' : 'user')
  return {
    catalogId: row.catalog_id,
    scope: {
      kind: row.scope_kind,
      ...(row.scope_kind === 'personal' ? { id } : { id }),
      label: row.scope_label,
      ...(row.scope_kind === 'project' && row.access_mode !== null ? { mode: row.access_mode } : {}),
    },
    docId: row.runtime_doc_id,
    directoryId: row.directory_id,
    name: row.name,
    bytes: safeNumber(row.bytes, 'document bytes'),
    mediaType: row.media_type,
    modifiedAt: safeNumber(row.modified_at_ms, 'document modified time'),
    owner: row.owner_public_id === null || row.owner_display_name === null
      ? null
      : { id: publicNumber(row.owner_public_id, 'owner'), displayName: row.owner_display_name },
    ownerSource: row.owner_source,
    state: row.state,
    legacy: row.legacy,
    lineageRootId: row.lineage_root_id,
  }
}

function validScopeInput(input: DocumentCatalogInput): void {
  if (input.docId === '' || input.name === '' || input.mediaType === ''
    || !Number.isSafeInteger(input.bytes) || input.bytes < 0
    || !Number.isFinite(input.modifiedAt) || input.modifiedAt < 0
    || (input.directoryId !== undefined && input.directoryId.length > 4096)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document metadata.')
  }
}

/** PostgreSQL-backed metadata catalog and document operation history. */
export class PostgresDocumentCatalogService {
  constructor(private readonly context: PostgresRuntimeContext) {}

  private async actorInternalId(client: Pool | PoolClient, userId: number): Promise<string> {
    const result = await client.query<{ id: string }>(`SELECT id FROM harness.users
      WHERE organization_id=$1 AND public_id=$2 AND status='active' AND deleted_at IS NULL`,
    [this.context.organizationId, userId])
    const id = result.rows[0]?.id
    if (id === undefined) throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Document actor is unavailable.')
    return id
  }

  private async scopeIds(client: Pool | PoolClient, scope: DocumentCatalogScope): Promise<ScopeIds> {
    if (scope.kind === 'personal') {
      const result = await client.query<{ id: string; public_id: string; display_name: string }>(`SELECT id,public_id::text,display_name
        FROM harness.users WHERE organization_id=$1 AND public_id=$2 AND status='active' AND deleted_at IS NULL`,
      [this.context.organizationId, scope.userId])
      const row = result.rows[0]
      if (row === undefined) throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
      return { kind: 'personal', userId: row.id, projectId: null, publicId: publicNumber(row.public_id, 'user'), label: '个人文档' }
    }
    const result = await client.query<{ id: string; public_id: string; name: string }>(`SELECT id,public_id::text,name::text
      FROM harness.projects WHERE organization_id=$1 AND public_id=$2 AND status='active'`,
    [this.context.organizationId, scope.projectId])
    const row = result.rows[0]
    if (row === undefined) throw new DocumentCatalogError('DOCUMENT_SCOPE_NOT_FOUND', 404, 'Project document scope is unavailable.')
    return { kind: 'project', userId: null, projectId: row.id, publicId: publicNumber(row.public_id, 'project'), label: row.name }
  }

  private async projectAuthority(client: Pool | PoolClient, projectId: string, actorId: string): Promise<{
    mode: 'ro' | 'rw'
    administrator: boolean
    owner: boolean
  } | null> {
    const result = await client.query<{ mode: 'ro' | 'rw'; administrator: boolean; owner: boolean }>(`SELECT
      CASE WHEN membership.role='admin' THEN 'rw'::text ELSE member.access_mode END mode,
      membership.role='admin' administrator,
      (p.owner_user_id=$3 OR p.created_by=$3) owner
      FROM harness.projects p
      LEFT JOIN harness.memberships membership ON membership.organization_id=p.organization_id
        AND membership.user_id=$2 AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=p.organization_id
        AND member.project_id=p.id AND member.user_id=$2
      WHERE p.organization_id=$1 AND p.id=$4 AND p.status='active'
        AND (membership.role='admin' OR member.user_id IS NOT NULL)`,
    [this.context.organizationId, actorId, actorId, projectId])
    return result.rows[0] ?? null
  }

  private async insertHistory(
    client: PoolClient,
    input: { catalogId?: string; operationId?: string; actorId?: string; eventKind: string; detail?: unknown },
  ): Promise<void> {
    await client.query(`INSERT INTO harness.document_history(
      organization_id,catalog_id,operation_id,actor_user_id,event_kind,detail
    ) VALUES($1,$2,$3,$4,$5,$6::jsonb)`, [
      this.context.organizationId,
      input.catalogId ?? null,
      input.operationId ?? null,
      input.actorId ?? null,
      input.eventKind,
      JSON.stringify(input.detail ?? {}),
    ])
  }

  /** Upsert a runtime listing into one scope; repeated calls are idempotent. */
  async sync(input: {
    actorUserId: number
    scope: DocumentCatalogScope
    documents: readonly DocumentCatalogInput[]
    replace?: boolean
    ownerSource?: 'upload' | 'transfer' | 'legacy' | 'admin'
  }): Promise<void> {
    for (const document of input.documents) validScopeInput(document)
    await transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, input.actorUserId)
      const scope = await this.scopeIds(client, input.scope)
      let canReconcileMissing = true
      if (scope.kind === 'project') {
        const authority = await this.projectAuthority(client, scope.projectId!, actorId)
        if (authority === null) throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot update this project document scope.')
        canReconcileMissing = authority.mode === 'rw'
      }
      let legacyOwner: string | null = scope.userId
      if (scope.kind === 'project') {
        const owner = await client.query<{ owner_user_id: string | null; created_by: string | null }>(`SELECT owner_user_id,created_by
          FROM harness.projects WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, scope.projectId])
        legacyOwner = owner.rows[0]?.owner_user_id ?? owner.rows[0]?.created_by ?? actorId
      }
      const seen = new Set<string>()
      for (const document of input.documents) {
        seen.add(document.docId)
        const directoryId = document.directoryId ?? ''
        const existing = await client.query<{ id: string; owner_user_id: string | null }>(`SELECT id,owner_user_id
          FROM harness.document_catalog
          WHERE organization_id=$1 AND scope_kind=$2
            AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND runtime_doc_id=$5`, [this.context.organizationId, scope.kind, scope.userId, scope.projectId, document.docId])
        const row = existing.rows[0]
        const owner = row?.owner_user_id ?? (input.ownerSource === 'upload' || input.ownerSource === 'transfer' ? actorId : legacyOwner)
        if (row === undefined) {
          const inserted = await client.query<{ id: string }>(`INSERT INTO harness.document_catalog(
            organization_id,scope_kind,scope_user_id,scope_project_id,runtime_doc_id,directory_id,name,bytes,media_type,
            modified_at_ms,owner_user_id,owner_source,state,legacy
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active',$13)
          RETURNING id`, [this.context.organizationId, scope.kind, scope.userId, scope.projectId, document.docId,
            directoryId, document.name, document.bytes, document.mediaType, Math.trunc(document.modifiedAt), owner,
            input.ownerSource ?? 'legacy', input.ownerSource === undefined || input.ownerSource === 'legacy'])
          await this.insertHistory(client, {
            catalogId: inserted.rows[0]!.id,
            actorId,
            eventKind: 'created',
            detail: { source: input.ownerSource ?? 'legacy' },
          })
        } else {
          await client.query(`UPDATE harness.document_catalog SET directory_id=$6,name=$7,bytes=$8,media_type=$9,
            modified_at_ms=$10,state='active',deleted_at=NULL,updated_at=now(),
            owner_user_id=COALESCE(owner_user_id,$11),owner_source=CASE WHEN owner_user_id IS NULL THEN $12 ELSE owner_source END,
            legacy=CASE WHEN owner_user_id IS NULL THEN $13 ELSE legacy END
            WHERE id=$1 AND organization_id=$2`, [row.id, this.context.organizationId, scope.kind, scope.userId,
            scope.projectId, directoryId, document.name, document.bytes, document.mediaType, Math.trunc(document.modifiedAt),
            owner, input.ownerSource ?? 'legacy', input.ownerSource === undefined || input.ownerSource === 'legacy'])
          await this.insertHistory(client, {
            catalogId: row.id,
            actorId,
            eventKind: 'updated',
            detail: { source: input.ownerSource ?? 'legacy' },
          })
        }
      }
      if (input.replace === true && canReconcileMissing) {
        const active = await client.query<{ id: string; runtime_doc_id: string }>(`SELECT id,runtime_doc_id
          FROM harness.document_catalog WHERE organization_id=$1 AND scope_kind=$2
            AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND state='active'`, [this.context.organizationId, scope.kind, scope.userId, scope.projectId])
        for (const row of active.rows) {
          if (seen.has(row.runtime_doc_id)) continue
          await client.query(`UPDATE harness.document_catalog SET state='deleted',deleted_at=now(),updated_at=now()
            WHERE id=$1`, [row.id])
          await this.insertHistory(client, { catalogId: row.id, actorId, eventKind: 'deleted', detail: { reason: 'runtime-reconcile' } })
        }
      }
    })
  }

  /** Mark one runtime-local document deleted without exposing its bytes. */
  async markDeleted(actorUserId: number, scope: DocumentCatalogScope, docId: string): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, actorUserId)
      const ids = await this.scopeIds(client, scope)
      if (ids.kind === 'project') {
        const authority = await this.projectAuthority(client, ids.projectId!, actorId)
        if (authority === null || authority.mode !== 'rw') {
          throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot remove project document metadata.')
        }
      }
      const row = await client.query<{ id: string }>(`SELECT c.id FROM harness.document_catalog c
        WHERE c.organization_id=$1 AND c.scope_kind=$2
          AND ((c.scope_kind='personal' AND c.scope_user_id=$3) OR (c.scope_kind='project' AND c.scope_project_id=$4))
          AND c.runtime_doc_id=$5 AND c.state='active'`, [this.context.organizationId, ids.kind, ids.userId, ids.projectId, docId])
      if (row.rows[0] === undefined) return
      await client.query(`UPDATE harness.document_catalog SET state='deleted',deleted_at=now(),updated_at=now() WHERE id=$1`, [row.rows[0].id])
      await this.insertHistory(client, { catalogId: row.rows[0].id, actorId, eventKind: 'deleted', detail: { reason: 'runtime' } })
    })
  }

  /** Check ownership-aware mutation permission for one or more runtime ids. */
  async authorize(input: {
    actorUserId: number
    scope: DocumentCatalogScope
    action: 'delete' | 'move' | 'ownership'
    docIds: readonly string[]
  }): Promise<{ allowed: true }> {
    if (input.docIds.length === 0 || input.docIds.length > 50) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document authorization request.')
    }
    await transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, input.actorUserId)
      const ids = await this.scopeIds(client, input.scope)
      if (ids.kind === 'personal') {
        const rows = await client.query<{ owner_user_id: string | null }>(`SELECT owner_user_id
          FROM harness.document_catalog WHERE organization_id=$1 AND scope_kind='personal' AND scope_user_id=$2
            AND runtime_doc_id=ANY($3::text[]) AND state='active'`, [this.context.organizationId, ids.userId, input.docIds])
        if (rows.rows.length !== input.docIds.length || rows.rows.some(row => row.owner_user_id !== actorId)) {
          throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Only the document owner can modify this document.')
        }
      } else {
        const authority = await this.projectAuthority(client, ids.projectId!, actorId)
        if (authority === null || authority.mode !== 'rw') {
          throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot modify project documents.')
        }
        const rows = await client.query<{ owner_user_id: string | null }>(`SELECT owner_user_id
          FROM harness.document_catalog WHERE organization_id=$1 AND scope_kind='project' AND scope_project_id=$2
            AND runtime_doc_id=ANY($3::text[]) AND state='active'`, [this.context.organizationId, ids.projectId, input.docIds])
        if (rows.rows.length !== input.docIds.length) {
          throw new DocumentCatalogError('DOCUMENT_OWNERSHIP_UNKNOWN', 503, 'Document ownership is not yet synchronized.')
        }
        if (!authority.administrator && !authority.owner
          && rows.rows.some(row => row.owner_user_id !== actorId)) {
          throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Only the document owner can modify this document.')
        }
      }
    })
    return { allowed: true }
  }

  /** Return metadata for all scopes the actor may read. */
  async overview(actorUserId: number): Promise<{ version: 1; documents: readonly DocumentCatalogRow[]; metrics: DocumentCatalogMetrics }> {
    const actorId = await this.actorInternalId(this.context.pool, actorUserId)
    const result = await this.context.pool.query<CatalogDbRow>(`SELECT c.id catalog_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      CASE WHEN c.scope_kind='project' AND membership.role='admin' THEN 'rw'::text
        WHEN c.scope_kind='project' THEN member.access_mode ELSE NULL END access_mode,
      c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state
      FROM harness.document_catalog c
      LEFT JOIN harness.users u ON u.id=c.scope_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.projects p ON p.id=c.scope_project_id AND p.organization_id=c.organization_id
      LEFT JOIN harness.memberships membership ON membership.organization_id=c.organization_id
        AND membership.user_id=$2 AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=c.organization_id
        AND member.project_id=c.scope_project_id AND member.user_id=$2
      LEFT JOIN harness.users owner ON owner.id=c.owner_user_id AND owner.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND c.state='active'
        AND (c.scope_user_id=$2 OR membership.role='admin' OR member.user_id IS NOT NULL)
      ORDER BY c.updated_at DESC,c.id`, [this.context.organizationId, actorId])
    const documents = result.rows.map(scopeRow)
    return { version: 1, documents, metrics: metricsFromRows(documents) }
  }

  /** Return recent metadata operations for one authorized current scope. */
  async history(actorUserId: number, scope: DocumentCatalogScope, limit = 200): Promise<readonly DocumentCatalogScopeHistoryRow[]> {
    const actorId = await this.actorInternalId(this.context.pool, actorUserId)
    const ids = await this.scopeIds(this.context.pool, scope)
    if (ids.kind === 'project' && await this.projectAuthority(this.context.pool, ids.projectId!, actorId) === null) {
      throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot read this project document history.')
    }
    const bounded = Math.min(Math.max(limit, 1), 500)
    const result = await this.context.pool.query<{
      id: string; event_kind: string; actor_public_id: string | null; actor_display_name: string | null; operation_id: string | null; detail: unknown; created_at_ms: string; catalog_id: string | null; document_name: string | null
    }>(`SELECT h.id::text,h.event_kind,actor.public_id::text actor_public_id,actor.display_name actor_display_name,
      h.operation_id,h.detail,(extract(epoch FROM h.created_at)*1000)::text created_at_ms,
      h.catalog_id,c.name document_name
      FROM harness.document_history h
      LEFT JOIN harness.document_catalog c ON c.id=h.catalog_id AND c.organization_id=h.organization_id
      LEFT JOIN harness.users actor ON actor.id=h.actor_user_id AND actor.organization_id=h.organization_id
      WHERE h.organization_id=$1 AND ((c.scope_kind='personal' AND c.scope_user_id=$2)
        OR (c.scope_kind='project' AND c.scope_project_id=$3))
      ORDER BY h.id DESC LIMIT $4`, [this.context.organizationId, ids.userId, ids.projectId, bounded])
    return result.rows.map(item => ({
      id: publicNumber(item.id, 'history'), eventKind: item.event_kind,
      actor: item.actor_public_id === null || item.actor_display_name === null ? null
        : { id: publicNumber(item.actor_public_id, 'actor'), displayName: item.actor_display_name },
      operationId: item.operation_id, detail: jsonValue(item.detail), createdAt: Number(item.created_at_ms),
      catalogId: item.catalog_id, documentName: item.document_name,
    }))
  }

  /** List rows for the administrator dashboard. */
  async adminList(filter: DocumentCatalogAdminFilter = {}): Promise<readonly DocumentCatalogRow[]> {
    const clauses = ['c.organization_id=$1']
    const values: unknown[] = [this.context.organizationId]
    const add = (clause: string, value: unknown): void => { values.push(value); clauses.push(clause.replace('?', `$${String(values.length)}`)) }
    if (filter.scopeKind !== undefined) add('c.scope_kind=?', filter.scopeKind)
    if (filter.projectId !== undefined) add('p.public_id=?', filter.projectId)
    if (filter.ownerUserId !== undefined) add('owner.public_id=?', filter.ownerUserId)
    if (filter.state === 'active' || filter.state === 'deleted') add('c.state=?', filter.state)
    if (filter.query !== undefined && filter.query.trim() !== '') {
      const needle = `%${filter.query.trim()}%`
      values.push(needle)
      const first = `$${String(values.length)}`
      values.push(needle)
      const second = `$${String(values.length)}`
      clauses.push(`(c.name ILIKE ${first} OR c.runtime_doc_id ILIKE ${second})`)
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    const offset = Math.max(filter.offset ?? 0, 0)
    values.push(limit); const limitArg = `$${String(values.length)}`
    values.push(offset); const offsetArg = `$${String(values.length)}`
    // The two placeholders above are assembled separately to keep all user
    // values parameterized; the query below is deliberately metadata-only.
    const result = await this.context.pool.query<CatalogDbRow>(`SELECT c.id catalog_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      NULL::text access_mode,c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state
      FROM harness.document_catalog c
      LEFT JOIN harness.users u ON u.id=c.scope_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.projects p ON p.id=c.scope_project_id AND p.organization_id=c.organization_id
      LEFT JOIN harness.users owner ON owner.id=c.owner_user_id AND owner.organization_id=c.organization_id
      WHERE ${clauses.join(' AND ')} ORDER BY c.updated_at DESC,c.id LIMIT ${limitArg} OFFSET ${offsetArg}`, values)
    return result.rows.map(scopeRow)
  }

  /** Return dashboard counters, including recent failed operations. */
  async adminMetrics(): Promise<DocumentCatalogMetrics> {
    const result = await this.context.pool.query<{
      total: string; active: string; deleted: string; personal: string; project: string; bytes: string; operations: string; failures: string
    }>(`SELECT
      COUNT(*)::text total,
      COUNT(*) FILTER (WHERE state='active')::text active,
      COUNT(*) FILTER (WHERE state='deleted')::text deleted,
      COUNT(*) FILTER (WHERE state='active' AND scope_kind='personal')::text personal,
      COUNT(*) FILTER (WHERE state='active' AND scope_kind='project')::text project,
      COALESCE(SUM(bytes) FILTER (WHERE state='active'),0)::text bytes,
      (SELECT COUNT(*)::text FROM harness.document_operations o
        WHERE o.organization_id=$1 AND o.created_at >= now()-interval '24 hours') operations,
      (SELECT COUNT(*)::text FROM harness.document_operation_items i
        JOIN harness.document_operations o ON o.id=i.operation_id
        WHERE o.organization_id=$1 AND i.status='failed' AND i.updated_at >= now()-interval '24 hours') failures
      FROM harness.document_catalog WHERE organization_id=$1`, [this.context.organizationId])
    const row = result.rows[0]!
    return {
      total: Number(row.total), active: Number(row.active), deleted: Number(row.deleted),
      personal: Number(row.personal), project: Number(row.project), bytes: Number(row.bytes),
      operations24h: Number(row.operations), failures24h: Number(row.failures),
    }
  }

  /** Load one document's metadata, lineage history, and copy attempts. */
  async detail(catalogId: string): Promise<DocumentCatalogDetail | null> {
    const row = await this.context.pool.query<CatalogDbRow>(`SELECT c.id catalog_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      NULL::text access_mode,c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state
      FROM harness.document_catalog c
      LEFT JOIN harness.users u ON u.id=c.scope_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.projects p ON p.id=c.scope_project_id AND p.organization_id=c.organization_id
      LEFT JOIN harness.users owner ON owner.id=c.owner_user_id AND owner.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND c.id=$2`, [this.context.organizationId, catalogId])
    const base = row.rows[0]
    if (base === undefined) return null
    const history = await this.context.pool.query<{
      id: string; event_kind: string; actor_public_id: string | null; actor_display_name: string | null; operation_id: string | null; detail: unknown; created_at_ms: string
    }>(`SELECT h.id::text,h.event_kind,actor.public_id::text actor_public_id,actor.display_name actor_display_name,
      h.operation_id,h.detail,(extract(epoch FROM h.created_at)*1000)::text created_at_ms
      FROM harness.document_history h LEFT JOIN harness.users actor ON actor.id=h.actor_user_id
      WHERE h.organization_id=$1 AND h.catalog_id=$2 ORDER BY h.id DESC LIMIT 500`, [this.context.organizationId, catalogId])
    const copies = await this.context.pool.query<{
      operation_id: string; status: string; source_name: string; source_runtime_doc_id: string; target_runtime_doc_id: string | null; error_code: string | null; error_message: string | null; created_at_ms: string
    }>(`SELECT i.operation_id,i.status,i.source_name,i.source_runtime_doc_id,i.target_runtime_doc_id,
      i.error_code,i.error_message,(extract(epoch FROM i.created_at)*1000)::text created_at_ms
      FROM harness.document_operation_items i
      WHERE i.organization_id=$1 AND (i.source_catalog_id=$2 OR i.target_catalog_id=$2)
      ORDER BY i.created_at DESC LIMIT 500`, [this.context.organizationId, catalogId])
    return {
      document: scopeRow(base),
      history: history.rows.map(item => ({
        id: publicNumber(item.id, 'history'), eventKind: item.event_kind,
        actor: item.actor_public_id === null || item.actor_display_name === null ? null
          : { id: publicNumber(item.actor_public_id, 'actor'), displayName: item.actor_display_name },
        operationId: item.operation_id, detail: jsonValue(item.detail), createdAt: Number(item.created_at_ms),
      })),
      copies: copies.rows.map(item => ({
        operationId: item.operation_id, status: item.status,
        source: { name: item.source_name, docId: item.source_runtime_doc_id },
        targetDocId: item.target_runtime_doc_id,
        error: item.error_code === null || item.error_message === null ? null : { code: item.error_code, message: item.error_message },
        createdAt: Number(item.created_at_ms),
      })),
    }
  }

  /** Transfer ownership with an explicit audit event. */
  async transferOwnership(actorUserId: number, catalogId: string, ownerUserId: number): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const actor = await this.actorInternalId(client, actorUserId)
      const target = await this.actorInternalId(client, ownerUserId)
      const row = await client.query<{ id: string; scope_project_id: string | null; owner_user_id: string | null }>(`SELECT id,scope_project_id,owner_user_id
        FROM harness.document_catalog WHERE organization_id=$1 AND id=$2 AND state='active' FOR UPDATE`, [this.context.organizationId, catalogId])
      const document = row.rows[0]
      if (document === undefined) throw new DocumentCatalogError('DOCUMENT_NOT_FOUND', 404, 'Document metadata was not found.')
      if (document.scope_project_id === null) {
        throw new DocumentCatalogError('DOCUMENT_OWNERSHIP_FORBIDDEN', 403, 'Personal document ownership cannot be transferred.')
      }
      const authority = await this.projectAuthority(client, document.scope_project_id, actor)
      if (authority === null || (!authority.administrator && !authority.owner)) {
        throw new DocumentCatalogError('DOCUMENT_OWNERSHIP_FORBIDDEN', 403, 'Only a project owner or administrator can transfer ownership.')
      }
      const member = await client.query(`SELECT 1 FROM harness.project_members WHERE organization_id=$1 AND project_id=$2 AND user_id=$3
        UNION ALL SELECT 1 FROM harness.projects p WHERE p.organization_id=$1 AND p.id=$2 AND (p.owner_user_id=$3 OR p.created_by=$3)`,
      [this.context.organizationId, document.scope_project_id, target])
      if (member.rows.length === 0) throw new DocumentCatalogError('DOCUMENT_OWNER_NOT_MEMBER', 409, 'The new owner must belong to the project.')
      const operation = await client.query<{ id: string }>(`INSERT INTO harness.document_operations(
        organization_id,actor_user_id,operation_kind,status,requested_count,completed_count,detail,completed_at
      ) VALUES($1,$2,'ownership-transfer','completed',1,1,$3::jsonb,now()) RETURNING id`, [
        this.context.organizationId, actor, JSON.stringify({ catalogId, ownerUserId }),
      ])
      await client.query(`UPDATE harness.document_catalog SET owner_user_id=$3,owner_source='admin',legacy=false,updated_at=now() WHERE id=$1 AND organization_id=$2`, [catalogId, this.context.organizationId, target])
      await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'ownership-transferred', detail: { ownerUserId } })
    })
  }

  /** Mark a catalog row deleted from an administrator action. */
  async adminDelete(actorUserId: number, catalogId: string): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const actor = await this.actorInternalId(client, actorUserId)
      const row = await client.query<{ id: string; state: string }>(`SELECT id,state FROM harness.document_catalog WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, catalogId])
      if (row.rows[0] === undefined) throw new DocumentCatalogError('DOCUMENT_NOT_FOUND', 404, 'Document metadata was not found.')
      if (row.rows[0].state === 'deleted') return
      const operation = await client.query<{ id: string }>(`INSERT INTO harness.document_operations(
        organization_id,actor_user_id,operation_kind,status,requested_count,completed_count,detail,completed_at
      ) VALUES($1,$2,'admin-action','completed',1,1,$3::jsonb,now()) RETURNING id`, [this.context.organizationId, actor, JSON.stringify({ action: 'delete', catalogId })])
      await client.query(`UPDATE harness.document_catalog SET state='deleted',deleted_at=now(),updated_at=now() WHERE id=$1`, [catalogId])
      await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'deleted', detail: { reason: 'admin' } })
    })
  }

  /** Record one copy attempt and connect source and target lineage. */
  async recordCopy(input: {
    actorUserId: number
    source: DocumentCatalogScope
    targetScope: DocumentCatalogScope
    sourceDocId: string
    sourceName: string
    target?: DocumentCatalogInput
    error?: { code: string; message: string }
    operationId?: string
  }): Promise<{ operationId: string; targetCatalogId: string | null }> {
    return transaction(this.context.pool, async (client) => {
      const actor = await this.actorInternalId(client, input.actorUserId)
      const sourceIds = await this.scopeIds(client, input.source)
      const targetIds = await this.scopeIds(client, input.targetScope)
      let operationId = input.operationId
      if (operationId === undefined) {
        const operation = await client.query<{ id: string }>(`INSERT INTO harness.document_operations(
          organization_id,actor_user_id,operation_kind,status,requested_count,
          source_scope_kind,source_user_id,source_project_id,target_scope_kind,target_user_id,target_project_id
        ) VALUES($1,$2,'copy','running',1,$3,$4,$5,$6,$7,$8) RETURNING id`, [
          this.context.organizationId, actor, sourceIds.kind, sourceIds.userId, sourceIds.projectId,
          targetIds.kind, targetIds.userId, targetIds.projectId,
        ])
        operationId = operation.rows[0]!.id
      } else {
        const existingOperation = await client.query<{ id: string }>(`SELECT id FROM harness.document_operations
          WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, operationId])
        if (existingOperation.rows[0] === undefined) {
          await client.query(`INSERT INTO harness.document_operations(
            id,organization_id,actor_user_id,operation_kind,status,requested_count,
            source_scope_kind,source_user_id,source_project_id,target_scope_kind,target_user_id,target_project_id
          ) VALUES($1,$2,$3,'copy','running',1,$4,$5,$6,$7,$8,$9)`, [
            operationId, this.context.organizationId, actor, sourceIds.kind, sourceIds.userId, sourceIds.projectId,
            targetIds.kind, targetIds.userId, targetIds.projectId,
          ])
        }
      }
      const source = await client.query<{ id: string; lineage_root_id: string | null }>(`SELECT id,lineage_root_id FROM harness.document_catalog WHERE organization_id=$1
        AND scope_kind=$2 AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
        AND runtime_doc_id=$5`, [this.context.organizationId, sourceIds.kind, sourceIds.userId, sourceIds.projectId, input.sourceDocId])
      let targetCatalogId: string | null = null
      if (input.target !== undefined) {
        const found = await client.query<{ id: string }>(`SELECT id FROM harness.document_catalog WHERE organization_id=$1
          AND scope_kind=$2 AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
          AND runtime_doc_id=$5`, [this.context.organizationId, targetIds.kind, targetIds.userId, targetIds.projectId, input.target.docId])
        targetCatalogId = found.rows[0]?.id ?? null
        if (targetCatalogId === null) {
          const inserted = await client.query<{ id: string }>(`INSERT INTO harness.document_catalog(
            organization_id,scope_kind,scope_user_id,scope_project_id,runtime_doc_id,directory_id,name,bytes,media_type,
            modified_at_ms,owner_user_id,owner_source,lineage_root_id,source_catalog_id,state,legacy
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'transfer',$12,$13,'active',false) RETURNING id`, [
            this.context.organizationId, targetIds.kind, targetIds.userId, targetIds.projectId, input.target.docId,
            input.target.directoryId ?? '', input.target.name, input.target.bytes, input.target.mediaType,
            Math.trunc(input.target.modifiedAt), actor, source.rows[0]?.lineage_root_id ?? source.rows[0]?.id ?? null, source.rows[0]?.id ?? null,
          ])
          targetCatalogId = inserted.rows[0]!.id
          await this.insertHistory(client, { catalogId: targetCatalogId, actorId: actor, eventKind: 'created', detail: { source: 'transfer' } })
        } else {
          await client.query(`UPDATE harness.document_catalog SET source_catalog_id=COALESCE(source_catalog_id,$2),
            lineage_root_id=COALESCE(lineage_root_id,$3),state='active',deleted_at=NULL,updated_at=now() WHERE id=$1`, [
            targetCatalogId, source.rows[0]?.id ?? null, source.rows[0]?.lineage_root_id ?? source.rows[0]?.id ?? null,
          ])
        }
      }
      const status = input.error === undefined ? 'copied' : 'failed'
      await client.query(`INSERT INTO harness.document_operation_items(
        organization_id,operation_id,source_catalog_id,target_catalog_id,source_runtime_doc_id,source_name,target_runtime_doc_id,status,error_code,error_message
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [this.context.organizationId, operationId, source.rows[0]?.id ?? null,
        targetCatalogId, input.sourceDocId, input.sourceName, input.target?.docId ?? null, status,
        input.error?.code ?? null, input.error?.message ?? null])
      await this.insertHistory(client, {
        catalogId: targetCatalogId ?? source.rows[0]?.id,
        operationId,
        actorId: actor,
        eventKind: input.error === undefined ? 'copied-in' : 'denied',
        detail: { source: input.source, target: input.target, error: input.error },
      })
      if (source.rows[0]?.id !== undefined && source.rows[0].id !== targetCatalogId) {
        await this.insertHistory(client, {
          catalogId: source.rows[0].id,
          operationId,
          actorId: actor,
          eventKind: input.error === undefined ? 'copied-out' : 'denied',
          detail: { target: input.target, error: input.error },
        })
      }
      await client.query(`UPDATE harness.document_operations SET completed_count=completed_count+$2,
        failed_count=failed_count+$3,status=CASE WHEN failed_count+$3>0 THEN 'partial' ELSE 'completed' END,completed_at=now(),updated_at=now()
        WHERE id=$1`, [operationId, input.error === undefined ? 1 : 0, input.error === undefined ? 0 : 1])
      return { operationId, targetCatalogId }
    })
  }
}

function metricsFromRows(rows: readonly DocumentCatalogRow[]): DocumentCatalogMetrics {
  return {
    total: rows.length,
    active: rows.length,
    deleted: 0,
    personal: rows.filter(row => row.scope.kind === 'personal').length,
    project: rows.filter(row => row.scope.kind === 'project').length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    operations24h: 0,
    failures24h: 0,
  }
}

/** Generate a stable opaque operation id for clients that need an id before commit. */
export function newDocumentOperationId(): string {
  return randomUUID()
}
