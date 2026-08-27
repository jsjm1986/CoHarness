import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { transaction } from './database.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'

/** Scope addressed by the organization document catalog. */
export type DocumentCatalogScope =
  | { readonly kind: 'personal'; readonly userId: number }
  | { readonly kind: 'project'; readonly projectId: number }

/** Durable lifecycle state of one catalog row. */
export type DocumentCatalogState = 'active' | 'trash' | 'purged' | 'deleted'

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
  readonly state: DocumentCatalogState
  readonly trashedAt: number | null
  readonly restoredAt: number | null
  readonly purgeAfter: number | null
  readonly purgedAt: number | null
  readonly legacy: boolean
  readonly lineageRootId: string | null
}

/** Filter accepted by the independent administrator document dashboard. */
export interface DocumentCatalogAdminFilter {
  readonly scopeKind?: 'personal' | 'project'
  readonly projectId?: number
  readonly ownerUserId?: number
  readonly state?: DocumentCatalogState | 'all'
  readonly query?: string
  readonly limit?: number
  readonly offset?: number
  /** Opaque continuation token; takes precedence over `offset`. */
  readonly cursor?: string
}

/** Cursor page returned by the administrator document index. */
export interface DocumentCatalogAdminPage {
  readonly documents: readonly DocumentCatalogRow[]
  readonly nextCursor?: string
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

/** Runtime address and metadata needed by an administrator lifecycle action. */
export interface DocumentCatalogTarget {
  readonly catalogId: string
  readonly scope: DocumentCatalogScope
  readonly docId: string
  readonly directoryId: string
  readonly name: string
  readonly state: DocumentCatalogState
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
  readonly trash?: number
  readonly purged?: number
  /** Number of non-active rows retained for compatibility with older dashboards. */
  readonly deleted: number
  readonly personal: number
  readonly project: number
  readonly bytes: number
  readonly operations24h: number
  readonly failures24h: number
}

/** Bounded metadata filters for the all-scope overview. */
export interface DocumentCatalogOverviewOptions {
  readonly query?: string
  readonly type?: 'all' | 'image' | 'pdf' | 'text' | 'other'
  readonly sort?: 'date-desc' | 'date-asc' | 'name-asc' | 'name-desc' | 'size-desc' | 'size-asc'
  readonly limit?: number
  readonly cursor?: string
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
  state: DocumentCatalogState
  trashed_at_ms: string | null
  restored_at_ms: string | null
  purge_after_ms: string | null
  purged_at_ms: string | null
}

function safeNumber(value: string | number, label: string): number
function safeNumber(value: string | number | null, label: string, nullable: true): number | null
function safeNumber(value: string | number | null, label: string, nullable = false): number | null {
  if (value === null && nullable) return null
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is outside the safe integer range`)
  return number
}

function retentionDeadline(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000)
}

/** Maximum offset accepted from a metadata cursor; prevents pathological scans. */
const MAX_CATALOG_OFFSET = 1_000_000

function decodeCatalogCursor(cursor: string | undefined, fingerprint?: string): number {
  if (cursor === undefined || cursor === '') return 0
  if (cursor.length > 4096) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document cursor.')
  }
  let value: unknown
  try {
    const encoded = Buffer.from(cursor, 'base64url')
    if (encoded.toString('base64url') !== cursor) throw new Error('non-canonical cursor')
    value = JSON.parse(encoded.toString('utf8')) as unknown
  } catch {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document cursor.')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Number.isSafeInteger((value as { offset?: unknown }).offset)
    || ((value as { offset: number }).offset) < 0
    || ((value as { offset: number }).offset) > MAX_CATALOG_OFFSET) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document cursor.')
  }
  if (fingerprint !== undefined && (value as { fingerprint?: unknown }).fingerprint !== fingerprint) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document cursor.')
  }
  return (value as { offset: number }).offset
}

function encodeCatalogCursor(offset: number, fingerprint?: string): string {
  return Buffer.from(JSON.stringify({ offset, ...(fingerprint === undefined ? {} : { fingerprint }) }), 'utf8').toString('base64url')
}

function adminFilterFingerprint(filter: DocumentCatalogAdminFilter): string {
  const state = filter.state === 'deleted' ? 'trash' : filter.state ?? 'all'
  return JSON.stringify({
    scopeKind: filter.scopeKind ?? 'all',
    projectId: filter.projectId ?? null,
    ownerUserId: filter.ownerUserId ?? null,
    state,
    query: filter.query?.trim() ?? '',
  })
}

function overviewFilterFingerprint(options: DocumentCatalogOverviewOptions): string {
  return JSON.stringify({
    query: options.query?.trim() ?? '',
    type: options.type ?? 'all',
    sort: options.sort ?? 'date-desc',
  })
}

/** Escape PostgreSQL LIKE metacharacters so document search remains literal. */
function literalLikePattern(value: string): string {
  return `%${value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
}

function validateAdminFilter(filter: DocumentCatalogAdminFilter): void {
  if (filter.scopeKind !== undefined && filter.scopeKind !== 'personal' && filter.scopeKind !== 'project') {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document scope filter.')
  }
  if (filter.projectId !== undefined && (!Number.isSafeInteger(filter.projectId) || filter.projectId <= 0)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid project filter.')
  }
  if (filter.ownerUserId !== undefined && (!Number.isSafeInteger(filter.ownerUserId) || filter.ownerUserId <= 0)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid owner filter.')
  }
  if (filter.state !== undefined && !['active', 'trash', 'purged', 'deleted', 'all'].includes(filter.state)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document state filter.')
  }
  if (filter.query !== undefined && (filter.query.length > 255 || /[\u0000-\u001f\u007f]/u.test(filter.query))) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document search filter.')
  }
  if (filter.limit !== undefined && (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 1000)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document page size.')
  }
  if (filter.offset !== undefined && (!Number.isSafeInteger(filter.offset) || filter.offset < 0 || filter.offset > MAX_CATALOG_OFFSET)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document offset.')
  }
  if (filter.cursor !== undefined && (filter.cursor === '' || filter.cursor.length > 4096)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document cursor.')
  }
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
    trashedAt: safeNumber(row.trashed_at_ms, 'trashed time', true),
    restoredAt: safeNumber(row.restored_at_ms, 'restored time', true),
    purgeAfter: safeNumber(row.purge_after_ms, 'purge time', true),
    purgedAt: safeNumber(row.purged_at_ms, 'purged time', true),
    legacy: row.legacy,
    lineageRootId: row.lineage_root_id,
  }
}

function validScopeInput(input: DocumentCatalogInput): void {
  const validRelative = (value: string, allowEmpty: boolean): boolean => value.length <= 4096
    && (value === '' ? allowEmpty : value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
      && !segment.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(segment)))
  if (!validRelative(input.docId, false) || input.name === '' || input.name.length > 255
    || /[\\/\u0000-\u001f\u007f]/u.test(input.name) || input.mediaType === '' || input.mediaType.length > 255
    || /[\u0000-\u001f\u007f]/u.test(input.mediaType)
    || !Number.isSafeInteger(input.bytes) || input.bytes < 0
    || !Number.isFinite(input.modifiedAt) || input.modifiedAt < 0
    || (input.directoryId !== undefined && !validRelative(input.directoryId, true))) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document metadata.')
  }
}

/** PostgreSQL-backed metadata catalog and document operation history. */
export class PostgresDocumentCatalogService {
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly retentionDays = 30,
  ) {
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1
      || retentionDays > Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 86_400_000)) {
      throw new Error('document catalog retention days must be a positive safe integer')
    }
  }

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
      CASE WHEN membership.role='admin' OR p.owner_user_id=$2 OR p.created_by=$2 THEN 'rw'::text ELSE member.access_mode END mode,
      membership.role='admin' administrator,
      (p.owner_user_id=$3 OR p.created_by=$3) owner
      FROM harness.projects p
      LEFT JOIN harness.memberships membership ON membership.organization_id=p.organization_id
        AND membership.user_id=$2 AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=p.organization_id
        AND member.project_id=p.id AND member.user_id=$2
      WHERE p.organization_id=$1 AND p.id=$4 AND p.status='active'
        AND (membership.role='admin' OR member.user_id IS NOT NULL OR p.owner_user_id=$2 OR p.created_by=$2)`,
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
        const existing = await client.query<{ id: string; owner_user_id: string | null; state: DocumentCatalogState }>(`SELECT id,owner_user_id,state
          FROM harness.document_catalog
          WHERE organization_id=$1 AND scope_kind=$2
            AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND runtime_doc_id=$5`, [this.context.organizationId, scope.kind, scope.userId, scope.projectId, document.docId])
        const row = existing.rows[0]
        // A permanent purge is an immutable catalog fact.  A stale runtime
        // listing (or a later file reusing the same provider id) must not make
        // that metadata readable again through an ordinary reconciliation.
        if (row?.state === 'purged') continue
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
          await client.query(`UPDATE harness.document_catalog SET directory_id=$3,name=$4,bytes=$5,media_type=$6,
            modified_at_ms=$7,state='active',deleted_at=NULL,trashed_at=NULL,trashed_by_user_id=NULL,
            purge_after=NULL,purged_at=NULL,purged_by_user_id=NULL,
            restored_at=CASE WHEN state='trash' THEN now() ELSE restored_at END,
            restored_by_user_id=CASE WHEN state='trash' THEN $11 ELSE restored_by_user_id END,updated_at=now(),
            owner_user_id=COALESCE(owner_user_id,$8),owner_source=CASE WHEN owner_user_id IS NULL THEN $9 ELSE owner_source END,
            legacy=CASE WHEN owner_user_id IS NULL THEN $10 ELSE legacy END
            WHERE id=$1 AND organization_id=$2`, [row.id, this.context.organizationId, directoryId, document.name,
            document.bytes, document.mediaType, Math.trunc(document.modifiedAt), owner, input.ownerSource ?? 'legacy',
            input.ownerSource === undefined || input.ownerSource === 'legacy', actorId])
          await this.insertHistory(client, {
            catalogId: row.id,
            actorId,
            eventKind: row.state === 'active' ? 'updated' : 'restored',
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
          const trashedAt = new Date()
          const purgeAfter = retentionDeadline(trashedAt, this.retentionDays)
          await client.query(`UPDATE harness.document_catalog SET state='trash',deleted_at=$2,trashed_at=$2,
            trashed_by_user_id=$3,purge_after=$4,updated_at=now() WHERE id=$1`, [row.id, trashedAt, actorId, purgeAfter])
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
      const trashedAt = new Date()
      await client.query(`UPDATE harness.document_catalog SET state='trash',deleted_at=$2,trashed_at=$2,
        trashed_by_user_id=$3,purge_after=$4,updated_at=now() WHERE id=$1`, [
        row.rows[0].id, trashedAt, actorId, retentionDeadline(trashedAt, this.retentionDays),
      ])
      await this.insertHistory(client, { catalogId: row.rows[0].id, actorId, eventKind: 'deleted', detail: { reason: 'runtime' } })
    })
  }

  /** Mark one runtime-local document permanently purged after its bytes are gone. */
  async markPurged(actorUserId: number, scope: DocumentCatalogScope, docId: string): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, actorUserId)
      const ids = await this.scopeIds(client, scope)
      if (ids.kind === 'project') {
        const authority = await this.projectAuthority(client, ids.projectId!, actorId)
        if (authority === null || authority.mode !== 'rw') {
          throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot purge project document metadata.')
        }
      }
      const row = await client.query<{ id: string }>(`SELECT c.id FROM harness.document_catalog c
        WHERE c.organization_id=$1 AND c.scope_kind=$2
          AND ((c.scope_kind='personal' AND c.scope_user_id=$3) OR (c.scope_kind='project' AND c.scope_project_id=$4))
          AND c.runtime_doc_id=$5 AND c.state='trash'`, [this.context.organizationId, ids.kind, ids.userId, ids.projectId, docId])
      if (row.rows[0] === undefined) return
      const at = new Date()
      await client.query(`UPDATE harness.document_catalog SET state='purged',purged_at=$2,purged_by_user_id=$3,
        purge_after=NULL,updated_at=now() WHERE id=$1`, [row.rows[0].id, at, actorId])
      await this.insertHistory(client, { catalogId: row.rows[0].id, actorId, eventKind: 'purged', detail: { reason: 'runtime' } })
    })
  }

  /** Check ownership-aware mutation permission for one or more runtime ids. */
  async authorize(input: {
    actorUserId: number
    scope: DocumentCatalogScope
    action: 'delete' | 'move' | 'ownership' | 'restore' | 'purge'
    docIds: readonly string[]
  }): Promise<{ allowed: true }> {
    if (input.docIds.length === 0 || input.docIds.length > 50) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document authorization request.')
    }
    await transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, input.actorUserId)
      const ids = await this.scopeIds(client, input.scope)
      const expectedState: DocumentCatalogState = input.action === 'restore' || input.action === 'purge' ? 'trash' : 'active'
      if (ids.kind === 'personal') {
        const rows = await client.query<{ owner_user_id: string | null }>(`SELECT owner_user_id
          FROM harness.document_catalog WHERE organization_id=$1 AND scope_kind='personal' AND scope_user_id=$2
            AND runtime_doc_id=ANY($3::text[]) AND state=$4`, [this.context.organizationId, ids.userId, input.docIds, expectedState])
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
            AND runtime_doc_id=ANY($3::text[]) AND state=$4`, [this.context.organizationId, ids.projectId, input.docIds, expectedState])
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
  async overview(
    actorUserId: number,
    options: DocumentCatalogOverviewOptions = {},
  ): Promise<{ version: 1; documents: readonly DocumentCatalogRow[]; metrics: DocumentCatalogMetrics; totalDocuments?: number; nextCursor?: string }> {
    if (options.query !== undefined && (options.query.length > 255 || /[\u0000-\u001f\u007f]/u.test(options.query))
      || options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 200)
      || options.type !== undefined && !['all', 'image', 'pdf', 'text', 'other'].includes(options.type)
      || options.sort !== undefined && !['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(options.sort)) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document overview query.')
    }
    const actorId = await this.actorInternalId(this.context.pool, actorUserId)
    const baseValues: unknown[] = [this.context.organizationId, actorId]
    const visibilityClauses = [
      'c.organization_id=$1',
      "c.state='active'",
      "(c.scope_user_id=$2 OR membership.role='admin' OR member.user_id IS NOT NULL OR p.owner_user_id=$2 OR p.created_by=$2)",
    ]
    const clauses = [...visibilityClauses]
    const values = [...baseValues]
    const add = (clause: string, value: unknown): void => {
      values.push(value)
      clauses.push(clause.replace('?', `$${String(values.length)}`))
    }
    const needle = options.query?.trim() ?? ''
    if (needle !== '') add('c.name ILIKE ?', literalLikePattern(needle))
    const textBucket = "(c.media_type LIKE 'text/%' OR c.media_type IN ('application/json','application/xml','application/x-yaml','application/javascript') OR c.media_type LIKE '%+json' OR c.media_type LIKE '%+xml')"
    switch (options.type) {
      case undefined:
      case 'all':
        break
      case 'image':
        clauses.push("c.media_type LIKE 'image/%'")
        break
      case 'pdf':
        clauses.push("c.media_type='application/pdf'")
        break
      case 'text':
        clauses.push(textBucket)
        break
      case 'other':
        clauses.push(`NOT (c.media_type LIKE 'image/%' OR c.media_type='application/pdf' OR ${textBucket})`)
        break
      default:
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document overview query.')
    }
    const sort = options.sort ?? 'date-desc'
    const orderBy = sort === 'date-asc' ? 'c.modified_at_ms ASC,c.id ASC'
      : sort === 'name-asc' ? 'LOWER(c.name) ASC,c.id ASC'
        : sort === 'name-desc' ? 'LOWER(c.name) DESC,c.id ASC'
          : sort === 'size-asc' ? 'c.bytes ASC,c.id ASC'
            : sort === 'size-desc' ? 'c.bytes DESC,c.id ASC'
              : 'c.modified_at_ms DESC,c.id ASC'
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const fingerprint = overviewFilterFingerprint(options)
    const offset = decodeCatalogCursor(options.cursor, fingerprint)
    const rowValues = [...values, limit + 1, offset]
    const limitArg = `$${String(values.length + 1)}`
    const offsetArg = `$${String(values.length + 2)}`
    const from = `FROM harness.document_catalog c
      LEFT JOIN harness.users u ON u.id=c.scope_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.projects p ON p.id=c.scope_project_id AND p.organization_id=c.organization_id
      LEFT JOIN harness.memberships membership ON membership.organization_id=c.organization_id
        AND membership.user_id=$2 AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=c.organization_id
        AND member.project_id=c.scope_project_id AND member.user_id=$2
      LEFT JOIN harness.users owner ON owner.id=c.owner_user_id AND owner.organization_id=c.organization_id`
    const where = `WHERE ${clauses.join(' AND ')}`
    const visibilityWhere = `WHERE ${visibilityClauses.join(' AND ')}`
    const select = `SELECT c.id catalog_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      CASE WHEN c.scope_kind='project' AND (membership.role='admin' OR p.owner_user_id=$2 OR p.created_by=$2) THEN 'rw'::text
        WHEN c.scope_kind='project' THEN member.access_mode ELSE NULL END access_mode,
      c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state,
      (extract(epoch FROM c.trashed_at)*1000)::bigint::text trashed_at_ms,
      (extract(epoch FROM c.restored_at)*1000)::bigint::text restored_at_ms,
      (extract(epoch FROM c.purge_after)*1000)::bigint::text purge_after_ms,
      (extract(epoch FROM c.purged_at)*1000)::bigint::text purged_at_ms`
    const [result, countResult, metricResult] = await Promise.all([
      this.context.pool.query<CatalogDbRow>(`${select} ${from} ${where} ORDER BY ${orderBy} LIMIT ${limitArg} OFFSET ${offsetArg}`, rowValues),
      this.context.pool.query<{ count: string }>(`SELECT COUNT(*)::text count ${from} ${where}`, values),
      this.context.pool.query<{ total: string; personal: string; project: string; bytes: string }>(
        `SELECT COUNT(*)::text total,COUNT(*) FILTER (WHERE c.scope_kind='personal')::text personal,
          COUNT(*) FILTER (WHERE c.scope_kind='project')::text project,COALESCE(SUM(c.bytes),0)::text bytes
          ${from} ${visibilityWhere}`,
        baseValues,
      ),
    ])
    const documents = result.rows.slice(0, limit).map(scopeRow)
    const totalDocuments = Number(countResult.rows[0]?.count ?? 0)
    const metricsRow = metricResult.rows[0]
    if (!Number.isSafeInteger(totalDocuments) || totalDocuments < 0
      || !Number.isSafeInteger(Number(metricsRow?.total ?? 0))
      || !Number.isSafeInteger(Number(metricsRow?.personal ?? 0))
      || !Number.isSafeInteger(Number(metricsRow?.project ?? 0))
      || !Number.isSafeInteger(Number(metricsRow?.bytes ?? 0))) {
      throw new Error('document overview counts are outside the safe integer range')
    }
    const metrics: DocumentCatalogMetrics = {
      total: Number(metricsRow?.total ?? 0),
      active: Number(metricsRow?.total ?? 0),
      trash: 0,
      purged: 0,
      deleted: 0,
      personal: Number(metricsRow?.personal ?? 0),
      project: Number(metricsRow?.project ?? 0),
      bytes: Number(metricsRow?.bytes ?? 0),
      operations24h: 0,
      failures24h: 0,
    }
    const hasMore = offset + documents.length < totalDocuments
    return {
      version: 1,
      documents,
      metrics,
      totalDocuments,
      ...(hasMore ? { nextCursor: encodeCatalogCursor(offset + documents.length, fingerprint) } : {}),
    }
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
    validateAdminFilter(filter)
    const clauses = ['c.organization_id=$1']
    const values: unknown[] = [this.context.organizationId]
    const add = (clause: string, value: unknown): void => { values.push(value); clauses.push(clause.replace('?', `$${String(values.length)}`)) }
    if (filter.scopeKind !== undefined) add('c.scope_kind=?', filter.scopeKind)
    if (filter.projectId !== undefined) add('p.public_id=?', filter.projectId)
    if (filter.ownerUserId !== undefined) add('owner.public_id=?', filter.ownerUserId)
    if (filter.state === 'active' || filter.state === 'trash' || filter.state === 'purged') add('c.state=?', filter.state)
    else if (filter.state === 'deleted') add('c.state=?', 'trash')
    if (filter.query !== undefined && filter.query.trim() !== '') {
      const needle = literalLikePattern(filter.query.trim())
      values.push(needle)
      const first = `$${String(values.length)}`
      values.push(needle)
      const second = `$${String(values.length)}`
      clauses.push(`(c.name ILIKE ${first} OR c.runtime_doc_id ILIKE ${second})`)
    }
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    const fingerprint = adminFilterFingerprint(filter)
    const offset = filter.cursor === undefined
      ? Math.max(filter.offset ?? 0, 0)
      : decodeCatalogCursor(filter.cursor, fingerprint)
    values.push(limit); const limitArg = `$${String(values.length)}`
    values.push(offset); const offsetArg = `$${String(values.length)}`
    // The two placeholders above are assembled separately to keep all user
    // values parameterized; the query below is deliberately metadata-only.
    const result = await this.context.pool.query<CatalogDbRow>(`SELECT c.id catalog_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      NULL::text access_mode,c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state,
      (extract(epoch FROM c.trashed_at)*1000)::bigint::text trashed_at_ms,
      (extract(epoch FROM c.restored_at)*1000)::bigint::text restored_at_ms,
      (extract(epoch FROM c.purge_after)*1000)::bigint::text purge_after_ms,
      (extract(epoch FROM c.purged_at)*1000)::bigint::text purged_at_ms
      FROM harness.document_catalog c
      LEFT JOIN harness.users u ON u.id=c.scope_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.projects p ON p.id=c.scope_project_id AND p.organization_id=c.organization_id
      LEFT JOIN harness.users owner ON owner.id=c.owner_user_id AND owner.organization_id=c.organization_id
      WHERE ${clauses.join(' AND ')} ORDER BY c.updated_at DESC,c.id LIMIT ${limitArg} OFFSET ${offsetArg}`, values)
    return result.rows.map(scopeRow)
  }

  /** Return one bounded administrator page with an opaque continuation cursor. */
  async adminListPage(filter: DocumentCatalogAdminFilter = {}): Promise<DocumentCatalogAdminPage> {
    validateAdminFilter(filter)
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
    const fingerprint = adminFilterFingerprint(filter)
    const initialOffset = filter.cursor === undefined ? Math.max(filter.offset ?? 0, 0) : undefined
    const rows = await this.adminList({
      ...filter,
      limit: limit + 1,
      cursor: filter.cursor,
      ...(initialOffset === undefined ? { offset: undefined } : { offset: initialOffset }),
    })
    const documents = rows.slice(0, limit)
    return {
      documents,
      ...(rows.length > limit ? {
        nextCursor: encodeCatalogCursor((filter.cursor === undefined
          ? initialOffset ?? 0
          : decodeCatalogCursor(filter.cursor, fingerprint)) + limit, fingerprint),
      } : {}),
    }
  }

  /** Return dashboard counters, including recent failed operations. */
  async adminMetrics(): Promise<DocumentCatalogMetrics> {
    const result = await this.context.pool.query<{
      total: string; active: string; trash: string; purged: string; deleted: string; personal: string; project: string; bytes: string; operations: string; failures: string
    }>(`SELECT
      COUNT(*)::text total,
      COUNT(*) FILTER (WHERE state='active')::text active,
      COUNT(*) FILTER (WHERE state='trash')::text trash,
      COUNT(*) FILTER (WHERE state='purged')::text purged,
      COUNT(*) FILTER (WHERE state<>'active')::text deleted,
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
      total: Number(row.total), active: Number(row.active), trash: Number(row.trash), purged: Number(row.purged), deleted: Number(row.deleted),
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
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state,
      (extract(epoch FROM c.trashed_at)*1000)::bigint::text trashed_at_ms,
      (extract(epoch FROM c.restored_at)*1000)::bigint::text restored_at_ms,
      (extract(epoch FROM c.purge_after)*1000)::bigint::text purge_after_ms,
      (extract(epoch FROM c.purged_at)*1000)::bigint::text purged_at_ms
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
        AND actor.organization_id=h.organization_id
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

  /** Resolve a catalog row to the runtime scope and opaque document id. */
  async target(catalogId: string): Promise<DocumentCatalogTarget | null> {
    const result = await this.context.pool.query<{
      id: string
      scope_kind: 'personal' | 'project'
      scope_public_id: string
      runtime_doc_id: string
      directory_id: string
      name: string
      state: DocumentCatalogState
    }>(`SELECT c.id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      c.runtime_doc_id,c.directory_id,c.name,c.state
      FROM harness.document_catalog c
      LEFT JOIN harness.users u ON u.id=c.scope_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.projects p ON p.id=c.scope_project_id AND p.organization_id=c.organization_id
      WHERE c.organization_id=$1 AND c.id=$2`, [this.context.organizationId, catalogId])
    const row = result.rows[0]
    if (row === undefined) return null
    const publicId = publicNumber(row.scope_public_id, row.scope_kind === 'project' ? 'project' : 'user')
    return {
      catalogId: row.id,
      scope: row.scope_kind === 'project' ? { kind: 'project', projectId: publicId } : { kind: 'personal', userId: publicId },
      docId: row.runtime_doc_id,
      directoryId: row.directory_id,
      name: row.name,
      state: row.state,
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

  private async adminTransition(
    actorUserId: number,
    catalogId: string,
    target: 'trash' | 'active' | 'purged',
  ): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      const actor = await this.actorInternalId(client, actorUserId)
      const row = await client.query<{ id: string; state: DocumentCatalogState }>(`SELECT id,state
        FROM harness.document_catalog WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, catalogId])
      const current = row.rows[0]
      if (current === undefined) throw new DocumentCatalogError('DOCUMENT_NOT_FOUND', 404, 'Document metadata was not found.')
      if (current.state === target) return
      if (target === 'active' && current.state !== 'trash') {
        throw new DocumentCatalogError('DOCUMENT_RESTORE_CONFLICT', 409, 'Only a trashed document can be restored.')
      }
      if (target === 'trash' && current.state === 'purged') {
        throw new DocumentCatalogError('DOCUMENT_NOT_FOUND', 404, 'Document metadata was purged.')
      }
      if (target === 'purged' && current.state !== 'trash') {
        throw new DocumentCatalogError('DOCUMENT_RESTORE_CONFLICT', 409, 'Only a trashed document can be permanently cleaned.')
      }
      const at = new Date()
      const operation = await client.query<{ id: string }>(`INSERT INTO harness.document_operations(
        organization_id,actor_user_id,operation_kind,status,requested_count,completed_count,detail,completed_at
      ) VALUES($1,$2,'admin-action','completed',1,1,$3::jsonb,now()) RETURNING id`, [
        this.context.organizationId, actor, JSON.stringify({ action: target, catalogId }),
      ])
      if (target === 'trash') {
        await client.query(`UPDATE harness.document_catalog SET state='trash',deleted_at=$2,trashed_at=$2,
          trashed_by_user_id=$3,purge_after=$4,updated_at=now() WHERE id=$1`, [
          catalogId, at, actor, retentionDeadline(at, this.retentionDays),
        ])
        await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'deleted', detail: { reason: 'admin' } })
      } else if (target === 'active') {
        await client.query(`UPDATE harness.document_catalog SET state='active',deleted_at=NULL,trashed_at=NULL,
          trashed_by_user_id=NULL,purge_after=NULL,restored_at=$2,restored_by_user_id=$3,updated_at=now() WHERE id=$1`, [catalogId, at, actor])
        await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'restored', detail: { reason: 'admin' } })
      } else {
        await client.query(`UPDATE harness.document_catalog SET state='purged',purged_at=$2,purged_by_user_id=$3,
          purge_after=NULL,updated_at=now() WHERE id=$1`, [catalogId, at, actor])
        await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'purged', detail: { reason: 'admin' } })
      }
    })
  }

  /** Move a catalog row into the administrator-visible recovery trash. */
  async adminTrash(actorUserId: number, catalogId: string): Promise<void> {
    await this.adminTransition(actorUserId, catalogId, 'trash')
  }

  /** Restore a catalog row after its runtime file has been restored. */
  async adminRestore(actorUserId: number, catalogId: string): Promise<void> {
    await this.adminTransition(actorUserId, catalogId, 'active')
  }

  /** Retain an audit row while marking a catalog document permanently purged. */
  async adminPurge(actorUserId: number, catalogId: string): Promise<void> {
    await this.adminTransition(actorUserId, catalogId, 'purged')
  }

  /** Mark expired trash metadata as purged; runtime bytes are reconciled on its next start. */
  async purgeDue(limit = 100): Promise<number> {
    const bounded = Math.min(Math.max(limit, 1), 500)
    const due = await this.context.pool.query<{ id: string }>(`SELECT id
      FROM harness.document_catalog
      WHERE organization_id=$1 AND state='trash' AND purge_after IS NOT NULL AND purge_after <= now()
      ORDER BY purge_after,id LIMIT $2`, [this.context.organizationId, bounded])
    let count = 0
    for (const row of due.rows) {
      await transaction(this.context.pool, async (client) => {
        const locked = await client.query<{ state: DocumentCatalogState }>(`SELECT state
          FROM harness.document_catalog WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, row.id])
        if (locked.rows[0]?.state !== 'trash') return
        const at = new Date()
        await client.query(`UPDATE harness.document_catalog SET state='purged',purged_at=$3,
          purge_after=NULL,updated_at=now() WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, row.id, at])
        await this.insertHistory(client, { catalogId: row.id, eventKind: 'purged', detail: { reason: 'retention' } })
        count += 1
      })
    }
    return count
  }

  /** Backward-compatible name for an administrator trash action. */
  async adminDelete(actorUserId: number, catalogId: string): Promise<void> {
    await this.adminTrash(actorUserId, catalogId)
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
        } else {
          await client.query(`UPDATE harness.document_operations SET requested_count=requested_count+1,updated_at=now()
            WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, operationId])
        }
      }
      const source = await client.query<{ id: string; lineage_root_id: string | null }>(`SELECT id,lineage_root_id FROM harness.document_catalog WHERE organization_id=$1
        AND scope_kind=$2 AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
        AND runtime_doc_id=$5`, [this.context.organizationId, sourceIds.kind, sourceIds.userId, sourceIds.projectId, input.sourceDocId])
      let targetCatalogId: string | null = null
      if (input.target !== undefined) {
        const found = await client.query<{ id: string; state: DocumentCatalogState }>(`SELECT id,state FROM harness.document_catalog WHERE organization_id=$1
          AND scope_kind=$2 AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
          AND runtime_doc_id=$5`, [this.context.organizationId, targetIds.kind, targetIds.userId, targetIds.projectId, input.target.docId])
        const existingTarget = found.rows[0]
        if (existingTarget?.state === 'purged') {
          // A purged catalog id is an immutable tombstone. Never reactivate it
          // when a provider later reuses an opaque runtime id.
          throw new DocumentCatalogError('DOCUMENT_TARGET_CONFLICT', 409, 'The target document id was permanently purged.')
        }
        targetCatalogId = existingTarget?.id ?? null
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
          await client.query(`UPDATE harness.document_catalog SET directory_id=$2,name=$3,bytes=$4,media_type=$5,
            modified_at_ms=$6,source_catalog_id=COALESCE(source_catalog_id,$7),
            lineage_root_id=COALESCE(lineage_root_id,$8),state='active',deleted_at=NULL,trashed_at=NULL,
            trashed_by_user_id=NULL,purge_after=NULL,purged_at=NULL,purged_by_user_id=NULL,updated_at=now() WHERE id=$1`, [
            targetCatalogId, input.target.directoryId ?? '', input.target.name, input.target.bytes, input.target.mediaType,
            Math.trunc(input.target.modifiedAt), source.rows[0]?.id ?? null,
            source.rows[0]?.lineage_root_id ?? source.rows[0]?.id ?? null,
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

/** Generate a stable opaque operation id for clients that need an id before commit. */
export function newDocumentOperationId(): string {
  return randomUUID()
}
