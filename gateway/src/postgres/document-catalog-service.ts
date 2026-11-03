import { randomUUID } from 'node:crypto'
import type { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { escapeLiteral, type Pool, type PoolClient } from 'pg'
import { transaction } from './database.ts'
import { literalLikePattern } from './literal-like-pattern.ts'
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'
import type { RuntimeNodeId } from '../runtime-catalog.ts'

/** Scope addressed by the organization document catalog. */
export type DocumentCatalogScope =
  | { readonly kind: 'personal'; readonly userId: number }
  | { readonly kind: 'project'; readonly projectId: number }

/** Durable lifecycle state of one catalog row. */
export type DocumentCatalogState = 'active' | 'trash' | 'purged' | 'missing' | 'deleted'

/** Immutable filesystem incarnation and current revision supplied by the document root. */
export interface DocumentCatalogIdentity {
  readonly incarnationId: string
  readonly revision: number
  readonly origin: 'upload' | 'transfer' | 'legacy' | 'admin'
  readonly createdBy?: string
}

/** Exact current file version selected by a Gateway catalog authorization. */
export interface DocumentCatalogSelectionInput {
  readonly docId: string
  readonly incarnationId?: string
  readonly revision?: number
  readonly trashId?: string
}

/** PostgreSQL-approved filesystem version captured before one local mutation. */
export interface DocumentCatalogSelection {
  readonly docId: string
  readonly incarnationId: string
  readonly revision: number
  readonly state: 'active' | 'trash'
  readonly trashId?: string
}

/** One identity-aware result from a completed filesystem deletion or trash operation. */
export interface DocumentCatalogRemoval extends DocumentCatalogSelectionInput {
  readonly state?: 'trash' | 'missing' | 'purged'
  readonly trashedAt?: number
  readonly purgeAfter?: number
}

/** One validated root-owned journal change sent to the organization catalog. */
export interface DocumentCatalogProjectionChange {
  readonly cursor: { readonly sequence: number; readonly ordinal: number }
  readonly previous: { readonly sequence: number; readonly ordinal: number }
  readonly action: 'publish' | 'adopt' | 'trash' | 'restore' | 'purge' | 'move' | 'relocate' | 'remove' | 'observe' | 'missing'
  readonly committedAt: number
  readonly actor?: string
  readonly document: {
    readonly incarnationId: string
    readonly revision: number
    readonly docId: string
    readonly state: 'active' | 'trash' | 'purged' | 'missing'
    readonly createdBy?: string
    readonly origin: 'upload' | 'transfer' | 'legacy' | 'admin'
    readonly bytes: number
    readonly mediaType: string
    readonly modifiedAt: number
    readonly trash?: {
      readonly trashId: string
      readonly docId: string
      readonly trashedAt: number
      readonly purgeAfter: number
    }
  }
}

/** Durable prefix exported by one private identity database. */
export interface DocumentCatalogProjectionBatch {
  readonly rootId: string
  readonly after: { readonly sequence: number; readonly ordinal: number }
  readonly head: { readonly sequence: number; readonly ordinal: number }
  readonly next: { readonly sequence: number; readonly ordinal: number }
  readonly changes: readonly DocumentCatalogProjectionChange[]
  readonly hasMore: boolean
}

/** Metadata reported by a runtime without exposing its absolute file path. */
export interface DocumentCatalogInput {
  readonly docId: string
  readonly directoryId?: string
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
  /** Absent only while reconciling metadata from an older document provider. */
  readonly identity?: DocumentCatalogIdentity
}

/** Safe catalog row projected to runtime and browser callers. */
export interface DocumentCatalogRow {
  readonly catalogId: string
  readonly scope: { readonly kind: 'personal' | 'project'; readonly id?: number; readonly label: string; readonly mode?: 'ro' | 'rw'; readonly nodeId?: RuntimeNodeId }
  readonly docId: string
  readonly directoryId: string
  readonly name: string
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
  readonly owner: { readonly id: number; readonly displayName: string } | null
  /** Stable filesystem identity; absent for catalog rows not yet migrated from the old provider. */
  readonly identity: { readonly incarnationId: string; readonly revision: number } | null
  /** Current recoverable-trash operation, independent of the original document path. */
  readonly trashId: string | null
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
  readonly identity?: { readonly incarnationId: string; readonly revision: number }
  readonly trashId?: string
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
  node_id: RuntimeNodeId
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
  runtime_incarnation_id: string | null
  runtime_revision: string | number
  trash_action_id: string | null
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

function projectionPosition(value: { readonly sequence: number; readonly ordinal: number }): void {
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || !Number.isSafeInteger(value.ordinal) || value.ordinal < 0
    || (value.sequence === 0) !== (value.ordinal === 0)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection position.')
  }
}

function compareProjectionPosition(
  left: { readonly sequence: number; readonly ordinal: number }, right: { readonly sequence: number; readonly ordinal: number },
): number {
  return left.sequence === right.sequence ? left.ordinal - right.ordinal : left.sequence - right.sequence
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
  if (filter.state !== undefined && !['active', 'trash', 'purged', 'missing', 'deleted', 'all'].includes(filter.state)) {
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
      nodeId: row.node_id,
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
    identity: row.runtime_incarnation_id === null ? null : {
      incarnationId: row.runtime_incarnation_id,
      revision: safeNumber(row.runtime_revision, 'document identity revision'),
    },
    trashId: row.trash_action_id,
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
    || input.identity !== undefined && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.identity.incarnationId)
      || !Number.isSafeInteger(input.identity.revision) || input.identity.revision < 1
      || !['upload', 'transfer', 'legacy', 'admin'].includes(input.identity.origin)
      || input.identity.createdBy !== undefined && !/^user:[1-9][0-9]{0,14}$/u.test(input.identity.createdBy))
    || (input.directoryId !== undefined && !validRelative(input.directoryId, true))) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document metadata.')
  }
}

/** PostgreSQL metadata and history; member mutations recheck current authority before commit. */
export class PostgresDocumentCatalogService {
  private readonly nodeSql: string
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly retentionDays = 30,
    private readonly entryNodeId?: RuntimeNodeId,
  ) {
    this.nodeSql = `${escapeLiteral(context.nodeId)}::uuid`
    if (!Number.isSafeInteger(retentionDays) || retentionDays < 1
      || retentionDays > Math.floor((Number.MAX_SAFE_INTEGER - Date.now()) / 86_400_000)) {
      throw new Error('document catalog retention days must be a positive safe integer')
    }
  }

  /** Node-filtered rows retain the underlying table's row-locking and join behavior. */
  private nodeRows(table: 'document_catalog' | 'document_projection_checkpoints' | 'document_operations'): string {
    return `(SELECT * FROM harness.${table} WHERE node_id=${this.nodeSql})`
  }

  /**
   * Inspect a protected legacy root's committed receiver owner without creating a checkpoint.
   * @param rootId - identity root read from the provider-owned domain marker.
   * @returns its current scope after a nonempty journal prefix committed, or null when no committed owner remains.
   */
  async projectionOwner(rootId: UserDocRootId): Promise<DocumentCatalogScope | null> {
    const result = await this.context.pool.query<{ scope_kind: 'personal' | 'project'; user_id: string | null; project_id: string | null }>(
      `SELECT checkpoint.scope_kind,u.public_id::text user_id,p.public_id::text project_id
       FROM ${this.nodeRows('document_projection_checkpoints')} checkpoint
       LEFT JOIN harness.users u ON u.id=checkpoint.scope_user_id AND u.organization_id=checkpoint.organization_id
       LEFT JOIN harness.projects p ON p.id=checkpoint.scope_project_id AND p.organization_id=checkpoint.organization_id
       WHERE checkpoint.organization_id=$1 AND checkpoint.root_id=$2 AND checkpoint.sequence>0`,
      [this.context.organizationId, rootId],
    )
    const row = result.rows[0]
    if (row === undefined) return null
    if (row.scope_kind === 'personal') {
      if (row.user_id === null) throw new Error('Document projection scope no longer exists.')
      return { kind: 'personal', userId: publicNumber(row.user_id, 'user') }
    }
    if (row.project_id === null) throw new Error('Document projection scope no longer exists.')
    return { kind: 'project', projectId: publicNumber(row.project_id, 'project') }
  }

  private async actorInternalId(client: Pool | PoolClient, userId: number): Promise<string> {
    const result = await client.query<{ id: string }>(`SELECT u.id FROM harness.users u
      JOIN harness.memberships membership
        ON membership.organization_id=u.organization_id AND membership.user_id=u.id
      JOIN harness.organizations organization ON organization.id=u.organization_id AND organization.status='active'
      WHERE u.organization_id=$1 AND u.public_id=$2
        AND u.status='active' AND u.deleted_at IS NULL AND membership.status='active'`,
    [this.context.organizationId, userId])
    const id = result.rows[0]?.id
    if (id === undefined) throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Document actor is unavailable.')
    return id
  }

  private async historicalUserInternalId(client: Pool | PoolClient, actor: string | undefined): Promise<string | undefined> {
    if (actor === undefined) return undefined
    const match = /^user:([1-9][0-9]{0,14})$/u.exec(actor)
    const publicId = match === null ? Number.NaN : Number(match[1])
    if (!Number.isSafeInteger(publicId)) throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document actor.')
    const result = await client.query<{ id: string }>(`SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2`,
      [this.context.organizationId, publicId])
    return result.rows[0]?.id
  }

  private async identityOwnerInternalId(client: PoolClient, owner: string | undefined): Promise<string | null> {
    return owner === undefined ? null : await this.historicalUserInternalId(client, owner) ?? null
  }

  private async projectionAuthority(client: PoolClient, actorUserId: number, scope: DocumentCatalogScope, administrator: boolean): Promise<{
    actorId: string; ids: ScopeIds
  }> {
    const actorId = await this.actorInternalId(client, actorUserId), ids = await this.scopeIds(client, scope)
    if (administrator) await this.assertAdministrator(client, actorUserId)
    if (ids.kind === 'personal' && ids.userId !== actorId && !administrator
      || ids.kind === 'project' && await this.projectAuthority(client, ids.projectId!, actorId) === null) {
      throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Document projection scope is unavailable.')
    }
    return { actorId, ids }
  }

  /** Read the receiver's committed cursor for one immutable identity root. */
  async projectionCursor(actorUserId: number, scope: DocumentCatalogScope, rootId: string, administrator = false): Promise<{
    readonly sequence: number; readonly ordinal: number
  }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(rootId)) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection root.')
    }
    return transaction(this.context.pool, async (client) => {
      const { ids } = await this.projectionAuthority(client, actorUserId, scope, administrator)
      await this.lockDocumentScope(client, ids)
      await this.assertProjectionComputer(client, rootId)
      const row = await client.query<{ scope_kind: 'personal' | 'project'; scope_user_id: string | null; scope_project_id: string | null; sequence: string | number; ordinal: number }>(
        `SELECT scope_kind,scope_user_id,scope_project_id,sequence,ordinal FROM ${this.nodeRows('document_projection_checkpoints')} document_projection_checkpoints
          WHERE organization_id=$1 AND root_id=$2 FOR UPDATE`, [this.context.organizationId, rootId])
      const checkpoint = row.rows[0]
      if (checkpoint === undefined) {
        await client.query(`INSERT INTO harness.document_projection_checkpoints(node_id,
          organization_id,root_id,scope_kind,scope_user_id,scope_project_id,sequence,ordinal
        ) VALUES(${this.nodeSql},$1,$2,$3,$4,$5,0,0)`, [this.context.organizationId, rootId, ids.kind, ids.userId, ids.projectId])
        await this.projectionAuthority(client, actorUserId, scope, administrator)
        return { sequence: 0, ordinal: 0 }
      }
      if (checkpoint.scope_kind !== ids.kind || checkpoint.scope_user_id !== ids.userId || checkpoint.scope_project_id !== ids.projectId) {
        throw new DocumentCatalogError('DOCUMENT_PROJECTION_CONFLICT', 409, 'Document identity root is already bound to another scope.')
      }
      const position = { sequence: safeNumber(checkpoint.sequence, 'document projection sequence'), ordinal: checkpoint.ordinal }
      projectionPosition(position)
      await this.projectionAuthority(client, actorUserId, scope, administrator)
      return position
    })
  }

  /** Apply one ordered identity prefix and advance its receiver cursor in the same PostgreSQL transaction. */
  async project(actorUserId: number, scope: DocumentCatalogScope, batch: DocumentCatalogProjectionBatch, administrator = false): Promise<{
    readonly sequence: number; readonly ordinal: number
  }> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(batch.rootId)) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection root.')
    }
    projectionPosition(batch.after); projectionPosition(batch.head); projectionPosition(batch.next)
    if (compareProjectionPosition(batch.after, batch.next) > 0 || compareProjectionPosition(batch.next, batch.head) > 0
      || batch.changes.length > 500 || batch.hasMore !== (compareProjectionPosition(batch.next, batch.head) < 0)) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection batch.')
    }
    let previous = batch.after
    for (const change of batch.changes) {
      projectionPosition(change.cursor); projectionPosition(change.previous)
      validScopeInput({ docId: change.document.docId, name: change.document.docId.split('/').at(-1)!,
        bytes: change.document.bytes, mediaType: change.document.mediaType, modifiedAt: change.document.modifiedAt,
        identity: { incarnationId: change.document.incarnationId, revision: change.document.revision,
          origin: change.document.origin, ...(change.document.createdBy === undefined ? {} : { createdBy: change.document.createdBy }) } })
      if (compareProjectionPosition(change.previous, previous) !== 0
        || compareProjectionPosition(change.cursor, change.previous) <= 0
        || change.action !== 'publish' && change.action !== 'adopt' && change.action !== 'trash' && change.action !== 'restore'
          && change.action !== 'purge' && change.action !== 'move' && change.action !== 'relocate'
          && change.action !== 'remove' && change.action !== 'observe' && change.action !== 'missing'
        || change.document.state === 'trash' && change.document.trash === undefined) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection change.')
      }
      previous = change.cursor
    }
    if (compareProjectionPosition(batch.next, previous) !== 0
      || batch.changes.length === 0 && compareProjectionPosition(batch.after, batch.next) !== 0) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Document projection cursor does not match its changes.')
    }
    return transaction(this.context.pool, async (client) => {
      const { ids } = await this.projectionAuthority(client, actorUserId, scope, administrator)
      await this.lockDocumentScope(client, ids)
      await this.assertProjectionComputer(client, batch.rootId)
      const locked = await client.query<{
        scope_kind: 'personal' | 'project'; scope_user_id: string | null; scope_project_id: string | null
        sequence: string | number; ordinal: number
      }>(`SELECT scope_kind,scope_user_id,scope_project_id,sequence,ordinal FROM ${this.nodeRows('document_projection_checkpoints')} document_projection_checkpoints
        WHERE organization_id=$1 AND root_id=$2 FOR UPDATE`, [this.context.organizationId, batch.rootId])
      let checkpoint = locked.rows[0]
      if (checkpoint === undefined) {
        if (batch.after.sequence !== 0 || batch.after.ordinal !== 0) {
          throw new DocumentCatalogError('DOCUMENT_PROJECTION_CONFLICT', 409, 'The document projection cursor was not registered.')
        }
        const inserted = await client.query(`INSERT INTO harness.document_projection_checkpoints(node_id,
          organization_id,root_id,scope_kind,scope_user_id,scope_project_id,sequence,ordinal
        ) VALUES(${this.nodeSql},$1,$2,$3,$4,$5,0,0) RETURNING sequence,ordinal,scope_kind,scope_user_id,scope_project_id`,
        [this.context.organizationId, batch.rootId, ids.kind, ids.userId, ids.projectId])
        checkpoint = inserted.rows[0] as typeof checkpoint
      }
      if (checkpoint === undefined) throw new Error('Document projection checkpoint could not be created.')
      if (checkpoint.scope_kind !== ids.kind || checkpoint.scope_user_id !== ids.userId || checkpoint.scope_project_id !== ids.projectId) {
        throw new DocumentCatalogError('DOCUMENT_PROJECTION_CONFLICT', 409, 'Document identity root is already bound to another scope.')
      }
      const current = { sequence: safeNumber(checkpoint.sequence, 'document projection sequence'), ordinal: checkpoint.ordinal }
      if (compareProjectionPosition(current, batch.next) === 0) {
        await this.projectionAuthority(client, actorUserId, scope, administrator)
        return current
      }
      if (compareProjectionPosition(current, batch.after) !== 0) {
        throw new DocumentCatalogError('DOCUMENT_PROJECTION_CONFLICT', 409, 'The document projection cursor is stale.')
      }
      await this.lockIdentityRows(client, ids, batch.changes.map(change => change.document))
      for (const change of batch.changes) {
        const document = change.document
        const mutationActorId = await this.historicalUserInternalId(client, change.actor)
        const ownerId = document.createdBy === undefined
          ? ids.userId : await this.identityOwnerInternalId(client, document.createdBy)
        const identityRow = await client.query<{ id: string; runtime_revision: string | number; state: DocumentCatalogState }>(
          `SELECT id,runtime_revision,state FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND scope_kind=$2
            AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND runtime_incarnation_id=$5 FOR UPDATE`,
          [this.context.organizationId, ids.kind, ids.userId, ids.projectId, document.incarnationId])
        const state = document.state
        const trashId = state === 'trash' ? document.trash?.trashId ?? null : null
        if (state === 'trash' && trashId === null) {
          throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Trash projection is missing its action identity.')
        }
        const directoryId = document.docId.split('/').slice(0, -1).join('/')
        const existing = identityRow.rows[0]
        if (existing?.state === 'purged'
          || existing !== undefined && safeNumber(existing.runtime_revision, 'document identity revision') >= document.revision) {
          continue
        }
        if (existing === undefined && change.action === 'adopt' && document.origin === 'legacy' && state === 'trash') {
          const retired = await client.query<{ id: string }>(`UPDATE harness.document_catalog
            SET state='missing',trash_action_id=NULL,missing_at=clock_timestamp(),updated_at=now()
            WHERE node_id=${this.nodeSql} AND organization_id=$1 AND scope_kind=$2
              AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
              AND runtime_doc_id=$5 AND runtime_incarnation_id IS NULL AND state='trash' RETURNING id`,
          [this.context.organizationId, ids.kind, ids.userId, ids.projectId, document.docId])
          for (const old of retired.rows) await this.insertHistory(client, { catalogId: old.id,
            actorId: mutationActorId, eventKind: 'missing', detail: { reason: 'legacy-trash-reconciled', rootId: batch.rootId } })
        }
        if (state === 'active') {
          const activePath = await client.query<{ id: string; runtime_incarnation_id: string | null }>(
            `SELECT id,runtime_incarnation_id FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND scope_kind=$2
              AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
              AND runtime_doc_id=$5 AND state='active' FOR UPDATE`,
            [this.context.organizationId, ids.kind, ids.userId, ids.projectId, document.docId])
          for (const old of activePath.rows) {
            if (old.runtime_incarnation_id === document.incarnationId) continue
            await client.query(`UPDATE harness.document_catalog SET state='missing',missing_at=clock_timestamp(),updated_at=now()
              WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2 AND state='active'`, [this.context.organizationId, old.id])
            await this.insertHistory(client, { catalogId: old.id, actorId: mutationActorId, eventKind: 'missing',
              detail: { reason: 'path-reused', rootId: batch.rootId } })
          }
        }
        let catalogId: string
        if (existing === undefined) {
          const inserted = await client.query<{ id: string }>(`INSERT INTO harness.document_catalog(node_id,
            organization_id,scope_kind,scope_user_id,scope_project_id,runtime_doc_id,directory_id,name,bytes,media_type,
            modified_at_ms,owner_user_id,owner_source,runtime_incarnation_id,runtime_revision,trash_action_id,
            state,legacy,deleted_at,trashed_at,trashed_by_user_id,purge_after,purged_at,purged_by_user_id,missing_at
          ) VALUES(${this.nodeSql},$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
            CASE WHEN $16='trash' THEN to_timestamp($18::double precision/1000) END,
            CASE WHEN $16='trash' THEN to_timestamp($18::double precision/1000) END,
            CASE WHEN $16='trash' THEN $19::uuid END,
            CASE WHEN $16='trash' THEN to_timestamp($20::double precision/1000) END,
            CASE WHEN $16='purged' THEN to_timestamp($18::double precision/1000) END,
            CASE WHEN $16='purged' THEN $19::uuid END,
            CASE WHEN $16='missing' THEN to_timestamp($18::double precision/1000) END
          ) RETURNING id`, [
            this.context.organizationId, ids.kind, ids.userId, ids.projectId, document.docId, directoryId,
            document.docId.split('/').at(-1)!, document.bytes, document.mediaType, Math.trunc(document.modifiedAt),
            ownerId, document.origin, document.incarnationId, document.revision, trashId, state, document.origin === 'legacy',
            change.committedAt, mutationActorId ?? null, document.trash?.purgeAfter ?? change.committedAt,
          ])
          catalogId = inserted.rows[0]!.id
        } else {
          catalogId = existing.id
          await client.query(`UPDATE harness.document_catalog SET runtime_doc_id=$3,directory_id=$4,name=$5,bytes=$6,
              media_type=$7,modified_at_ms=$8,runtime_revision=$9,state=$10,trash_action_id=$11,
              deleted_at=CASE WHEN $10='trash' THEN to_timestamp($12::double precision/1000) END,
              trashed_at=CASE WHEN $10='trash' THEN to_timestamp($12::double precision/1000) END,
              trashed_by_user_id=CASE WHEN $10='trash' THEN $13::uuid END,
              purge_after=CASE WHEN $10='trash' THEN to_timestamp($14::double precision/1000) END,
              purged_at=CASE WHEN $10='purged' THEN to_timestamp($12::double precision/1000) END,
              purged_by_user_id=CASE WHEN $10='purged' THEN $13::uuid END,
              missing_at=CASE WHEN $10='missing' THEN to_timestamp($12::double precision/1000) END,
              restored_at=CASE WHEN $15='restore' THEN to_timestamp($12::double precision/1000) ELSE restored_at END,
              restored_by_user_id=CASE WHEN $15='restore' THEN $13::uuid ELSE restored_by_user_id END,updated_at=now()
              WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2`, [
              this.context.organizationId, catalogId, document.docId, directoryId, document.docId.split('/').at(-1)!,
              document.bytes, document.mediaType, Math.trunc(document.modifiedAt), document.revision, state, trashId,
              change.committedAt, mutationActorId ?? null, document.trash?.purgeAfter ?? change.committedAt, change.action,
          ])
        }
        const eventKind = state === 'trash' ? 'deleted' : state === 'purged' ? 'purged'
          : state === 'missing' ? 'missing' : existing === undefined ? 'created'
            : change.action === 'restore' ? 'restored' : 'updated'
        await this.insertHistory(client, { catalogId, actorId: mutationActorId, eventKind,
          detail: { source: 'identity-projection', action: change.action, rootId: batch.rootId,
            sequence: change.cursor.sequence, ordinal: change.cursor.ordinal } })
      }
      await client.query(`UPDATE harness.document_projection_checkpoints SET sequence=$3,ordinal=$4,updated_at=now()
        WHERE node_id=${this.nodeSql} AND organization_id=$1 AND root_id=$2`, [this.context.organizationId, batch.rootId, batch.next.sequence, batch.next.ordinal])
      await this.projectionAuthority(client, actorUserId, scope, administrator)
      return batch.next
    })
  }

  private async scopeIds(client: Pool | PoolClient, scope: DocumentCatalogScope): Promise<ScopeIds> {
    if (scope.kind === 'personal') {
      const result = await client.query<{ id: string; public_id: string; display_name: string }>(`SELECT u.id,u.public_id::text,u.display_name
        FROM harness.users u JOIN harness.node_user_accounts account
          ON account.organization_id=u.organization_id AND account.user_id=u.id AND account.node_id=$3
        WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL`,
      [this.context.organizationId, scope.userId, this.context.nodeId])
      const row = result.rows[0]
      if (row === undefined) throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'Personal document scope is unavailable.')
      return { kind: 'personal', userId: row.id, projectId: null, publicId: publicNumber(row.public_id, 'user'), label: '个人文档' }
    }
    const result = await client.query<{ id: string; public_id: string; name: string }>(`SELECT p.id,p.public_id::text,p.name::text
      FROM harness.projects p JOIN harness.instances i ON i.organization_id=p.organization_id AND i.project_id=p.id AND i.assigned_node_id=$3
      WHERE p.organization_id=$1 AND p.public_id=$2 AND p.status='active'`,
    [this.context.organizationId, scope.projectId, this.context.nodeId])
    const row = result.rows[0]
    if (row === undefined) throw new DocumentCatalogError('DOCUMENT_SCOPE_NOT_FOUND', 404, 'Project document scope is unavailable.')
    return { kind: 'project', userId: null, projectId: row.id, publicId: publicNumber(row.public_id, 'project'), label: row.name }
  }

  private async lockDocumentScope(client: PoolClient, scope: ScopeIds): Promise<void> {
    const id = scope.kind === 'personal' ? scope.userId : scope.projectId
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `document-catalog:${this.context.organizationId}:${this.context.nodeId}:${scope.kind}:${String(id)}`,
    ])
  }

  private async assertProjectionComputer(client: PoolClient, rootId: string): Promise<void> {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`document-root:${this.context.organizationId}:${rootId}`])
    const result = await client.query<{ node_id: string }>(`SELECT node_id FROM harness.document_projection_checkpoints
      WHERE organization_id=$1 AND root_id=$2`, [this.context.organizationId, rootId])
    if (result.rows[0] !== undefined && result.rows[0].node_id !== this.context.nodeId) {
      throw new DocumentCatalogError('DOCUMENT_PROJECTION_CONFLICT', 409, 'Document identity root belongs to another computer.')
    }
  }

  private async lockIdentityRows(
    client: PoolClient, scope: ScopeIds, documents: readonly { readonly docId: string; readonly incarnationId: string }[],
    includeActive = false,
  ): Promise<void> {
    await client.query(`SELECT id FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND scope_kind=$2
      AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
      AND (runtime_incarnation_id=ANY($5::uuid[]) OR runtime_doc_id=ANY($6::text[]) OR ($7::boolean AND state='active'))
      ORDER BY id FOR UPDATE`, [this.context.organizationId, scope.kind, scope.userId, scope.projectId,
      documents.map(document => document.incarnationId), documents.map(document => document.docId), includeActive])
  }

  private async projectAuthority(client: Pool | PoolClient, projectId: string, actorId: string): Promise<{
    mode: 'ro' | 'rw'
    administrator: boolean
    owner: boolean
  } | null> {
    const result = await client.query<{ mode: 'ro' | 'rw'; administrator: boolean; owner: boolean }>(`SELECT
      CASE WHEN membership.role='admin' THEN 'rw'::text ELSE member.access_mode END mode,
      membership.role='admin' administrator,
      (p.owner_user_id=$2) owner
      FROM harness.projects p
      JOIN harness.memberships membership ON membership.organization_id=p.organization_id
        AND membership.user_id=$2 AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=p.organization_id
        AND member.project_id=p.id AND member.user_id=$2
      WHERE p.organization_id=$1 AND p.id=$3 AND p.status='active'
        AND harness.project_computer_use_allowed(p.organization_id,$2,p.id)
        AND (p.kind<>'steward' AND (membership.role='admin' OR member.user_id IS NOT NULL)
          OR p.kind='steward' AND membership.role='admin' AND EXISTS (
            SELECT 1 FROM harness.steward_access_policies sp
            WHERE sp.organization_id=p.organization_id AND sp.user_id=$2 AND sp.node_id=harness.project_node_id($1,$3) AND sp.enabled))`,
    [this.context.organizationId, actorId, projectId])
    return result.rows[0] ?? null
  }

  /** Validate current writer admission after catalog and history statements have settled. */
  private async assertScopeWriter(client: PoolClient, actorUserId: number, scope: DocumentCatalogScope): Promise<void> {
    const actor = await this.actorInternalId(client, actorUserId)
    const ids = await this.scopeIds(client, scope)
    if (ids.kind === 'project') {
      const authority = await this.projectAuthority(client, ids.projectId!, actor)
      if (authority === null || authority.mode !== 'rw') {
        throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot update this project document scope.')
      }
    }
  }

  private async assertAdministrator(client: PoolClient, actorUserId: number): Promise<void> {
    const result = await client.query(`SELECT u.id FROM harness.users u
      JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
      JOIN harness.organizations o ON o.id=u.organization_id AND o.status='active'
      WHERE u.organization_id=$1 AND u.public_id=$2 AND u.status='active' AND u.deleted_at IS NULL
        AND m.status='active' AND m.role='admin'`, [this.context.organizationId, actorUserId])
    if (result.rows.length === 0) {
      throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'An active administrator is required.')
    }
  }

  private async transferParties(client: PoolClient, projectId: string, actorUserId: number, ownerUserId: number): Promise<{
    actor: string; target: string
  }> {
    const actor = await this.actorInternalId(client, actorUserId)
    const target = await this.actorInternalId(client, ownerUserId)
    const authority = await this.projectAuthority(client, projectId, actor)
    if (authority === null || (!authority.administrator && !authority.owner)) {
      throw new DocumentCatalogError('DOCUMENT_OWNERSHIP_FORBIDDEN', 403, 'Only a project owner or administrator can transfer ownership.')
    }
    const member = await client.query(`SELECT 1 FROM harness.project_members WHERE organization_id=$1 AND project_id=$2 AND user_id=$3`,
      [this.context.organizationId, projectId, target])
    if (member.rows.length === 0) {
      throw new DocumentCatalogError('DOCUMENT_OWNER_NOT_MEMBER', 409, 'The new owner must belong to the project.')
    }
    return { actor, target }
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

  /** Insert one fixed-detail history entry for each catalog id in one SQL round-trip. */
  private async insertHistoryBatch(
    client: PoolClient,
    entries: readonly { catalogId: string; eventKind: string }[],
    actorId: string,
    detail: unknown,
  ): Promise<void> {
    if (entries.length === 0) return
    await client.query(`INSERT INTO harness.document_history(
      organization_id,catalog_id,actor_user_id,event_kind,detail
    ) SELECT $1,item.catalog_id,$2,item.event_kind,$5::jsonb
      FROM unnest($3::uuid[],$4::text[]) AS item(catalog_id,event_kind)`, [
      this.context.organizationId,
      actorId,
      entries.map(item => item.catalogId),
      entries.map(item => item.eventKind),
      JSON.stringify(detail ?? {}),
    ])
  }

  /**
   * Upsert one listing; replacement reconciles its locked catalog snapshot and preserves later registrations.
   * @param input - actor, document scope, listing and replacement intent.
   * @returns after catalog changes and their history commit together.
   */
  async sync(input: {
    actorUserId: number
    scope: DocumentCatalogScope
    documents: readonly DocumentCatalogInput[]
    replace?: boolean
    ownerSource?: 'upload' | 'transfer' | 'legacy' | 'admin'
  }): Promise<void> {
    for (const document of input.documents) validScopeInput(document)
    const documentIds = new Set<string>()
    for (const document of input.documents) {
      if (documentIds.has(document.docId)) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Duplicate document id in catalog sync.')
      }
      documentIds.add(document.docId)
    }
    await transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, input.actorUserId)
      const scope = await this.scopeIds(client, input.scope)
      if (scope.kind === 'project') {
        const authority = await this.projectAuthority(client, scope.projectId!, actorId)
        if (authority === null || authority.mode !== 'rw') {
          throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot update this project document scope.')
        }
      }
      let legacyOwner: string | null = scope.userId
      if (scope.kind === 'project') {
        const owner = await client.query<{ owner_user_id: string | null; created_by: string | null }>(`SELECT owner_user_id,created_by
          FROM harness.projects WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, scope.projectId])
        legacyOwner = owner.rows[0]?.owner_user_id ?? owner.rows[0]?.created_by ?? actorId
      }
      const identityCount = input.documents.filter(document => document.identity !== undefined).length
      if (identityCount !== 0 && identityCount !== input.documents.length) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Identity-aware and legacy document metadata cannot be mixed.')
      }
      if (identityCount > 0) {
        await this.lockDocumentScope(client, scope)
        await this.lockIdentityRows(client, scope,
          input.documents.map(document => ({ docId: document.docId, incarnationId: document.identity!.incarnationId })), input.replace === true)
        for (const document of input.documents) {
          const identity = document.identity!
          const origin = identity.origin
          const identityOwner = identity.createdBy === undefined ? scope.userId : await this.identityOwnerInternalId(client, identity.createdBy)
          const priorRows = await client.query<{
            id: string; state: DocumentCatalogState; runtime_revision: string | number
          }>(`SELECT id,state,runtime_revision FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1
            AND scope_kind=$2 AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND runtime_incarnation_id=$5 FOR UPDATE`,
          [this.context.organizationId, scope.kind, scope.userId, scope.projectId, identity.incarnationId])
          const prior = priorRows.rows[0]
          const priorRevision = prior === undefined ? undefined
            : safeNumber(prior.runtime_revision, 'document identity revision')
          if (prior?.state === 'purged'
            || priorRevision !== undefined && priorRevision > identity.revision
            || prior !== undefined && prior.state !== 'active' && priorRevision !== undefined && priorRevision >= identity.revision) continue
          const activePath = await client.query<{ id: string; runtime_incarnation_id: string | null }>(`SELECT id,runtime_incarnation_id
            FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND scope_kind=$2
              AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
              AND runtime_doc_id=$5 AND state='active' FOR UPDATE`,
          [this.context.organizationId, scope.kind, scope.userId, scope.projectId, document.docId])
          for (const previous of activePath.rows) {
            if (previous.runtime_incarnation_id === identity.incarnationId) continue
            await client.query(`UPDATE harness.document_catalog SET state='missing',missing_at=clock_timestamp(),updated_at=now()
              WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2 AND state='active'`, [this.context.organizationId, previous.id])
            await this.insertHistory(client, { catalogId: previous.id, actorId, eventKind: 'missing',
              detail: { reason: 'identity-replaced' } })
          }
          const directoryId = document.directoryId ?? ''
          if (prior === undefined) {
            const inserted = await client.query<{ id: string }>(`INSERT INTO harness.document_catalog(node_id,
              organization_id,scope_kind,scope_user_id,scope_project_id,runtime_doc_id,directory_id,name,bytes,media_type,
              modified_at_ms,owner_user_id,owner_source,runtime_incarnation_id,runtime_revision,state,legacy
            ) VALUES(${this.nodeSql},$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'active',$15) RETURNING id`, [
              this.context.organizationId, scope.kind, scope.userId, scope.projectId, document.docId, directoryId,
              document.name, document.bytes, document.mediaType, Math.trunc(document.modifiedAt), identityOwner, origin,
              identity.incarnationId, identity.revision, origin === 'legacy',
            ])
            await this.insertHistory(client, { catalogId: inserted.rows[0]!.id, actorId,
              eventKind: 'created', detail: { source: origin, identity: identity.incarnationId } })
          } else {
            await client.query(`UPDATE harness.document_catalog SET runtime_doc_id=$3,directory_id=$4,name=$5,bytes=$6,
              media_type=$7,modified_at_ms=$8,runtime_revision=$9,state='active',trash_action_id=NULL,deleted_at=NULL,
              trashed_at=NULL,trashed_by_user_id=NULL,purge_after=NULL,purged_at=NULL,purged_by_user_id=NULL,missing_at=NULL,
              restored_at=CASE WHEN state='trash' THEN now() ELSE restored_at END,
              restored_by_user_id=CASE WHEN state='trash' THEN $10 ELSE restored_by_user_id END,
              owner_user_id=COALESCE(owner_user_id,$11),owner_source=CASE WHEN owner_user_id IS NULL THEN $12 ELSE owner_source END,
              legacy=CASE WHEN owner_user_id IS NULL THEN $13 ELSE legacy END,updated_at=now()
              WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2`, [this.context.organizationId, prior.id, document.docId, directoryId,
              document.name, document.bytes, document.mediaType, Math.trunc(document.modifiedAt), identity.revision,
              actorId, identityOwner, origin, origin === 'legacy'])
            await this.insertHistory(client, { catalogId: prior.id, actorId,
              eventKind: prior.state === 'trash' || prior.state === 'missing' ? 'restored' : 'updated',
              detail: { source: origin, identity: identity.incarnationId } })
          }
        }
        if (input.replace === true) {
          const retained = input.documents.map(document => document.identity!.incarnationId)
          const missing = await client.query<{ id: string }>(`UPDATE harness.document_catalog SET state='missing',
            missing_at=clock_timestamp(),updated_at=now() WHERE node_id=${this.nodeSql} AND organization_id=$1 AND scope_kind=$2
            AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND state='active' AND (runtime_incarnation_id IS NULL OR NOT(runtime_incarnation_id=ANY($5::uuid[]))) RETURNING id`,
          [this.context.organizationId, scope.kind, scope.userId, scope.projectId, retained])
          await this.insertHistoryBatch(client, missing.rows.map(row => ({ catalogId: row.id, eventKind: 'missing' })), actorId,
            { reason: 'runtime-reconcile' })
        }
        await this.assertScopeWriter(client, input.actorUserId, input.scope)
        return
      }
      // Catalog rows precede the organization revision row taken by access-invalidation triggers.
      const existing = input.documents.length === 0 && input.replace !== true
        ? { rows: [] as { id: string; runtime_doc_id: string; owner_user_id: string | null; state: DocumentCatalogState }[] }
        : await client.query<{ id: string; runtime_doc_id: string; owner_user_id: string | null; state: DocumentCatalogState }>(`SELECT id,runtime_doc_id,owner_user_id,state
          FROM ${this.nodeRows('document_catalog')} document_catalog
          WHERE organization_id=$1 AND scope_kind=$2
            AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND ($6::boolean OR runtime_doc_id=ANY($5::text[]))
          ORDER BY id FOR UPDATE`, [
          this.context.organizationId, scope.kind, scope.userId, scope.projectId, input.documents.map(document => document.docId),
          input.replace === true,
        ])
      const existingByDocId = new Map(existing.rows.map(row => [row.runtime_doc_id, row]))
      // A permanent purge is an immutable catalog fact. Stale runtime listings
      // are excluded from the upsert instead of reactivating their tombstones.
      const incoming = input.documents.filter(document => existingByDocId.get(document.docId)?.state !== 'purged')
      const source = input.ownerSource ?? 'legacy'
      const ownerFor = (document: DocumentCatalogInput): string | null => {
        const prior = existingByDocId.get(document.docId)
        return prior?.owner_user_id ?? (source === 'upload' || source === 'transfer' ? actorId : legacyOwner)
      }
      const upserted = incoming.length === 0
        ? { rows: [] as { id: string; runtime_doc_id: string }[] }
        : await client.query<{ id: string; runtime_doc_id: string }>(`INSERT INTO harness.document_catalog(node_id,
            organization_id,scope_kind,scope_user_id,scope_project_id,runtime_doc_id,directory_id,name,bytes,media_type,
            modified_at_ms,owner_user_id,owner_source,state,legacy
          ) SELECT ${this.nodeSql},$1,$2,$3,$4,item.runtime_doc_id,item.directory_id,item.name,item.bytes,item.media_type,
            item.modified_at_ms,item.owner_user_id,item.owner_source,'active',item.legacy
            FROM unnest($5::text[],$6::text[],$7::text[],$8::bigint[],$9::text[],$10::bigint[],$11::uuid[],$12::text[],$13::boolean[])
              AS item(runtime_doc_id,directory_id,name,bytes,media_type,modified_at_ms,owner_user_id,owner_source,legacy)
          ON CONFLICT ${scope.kind === 'personal'
            ? "(organization_id,node_id,scope_user_id,runtime_doc_id) WHERE scope_kind='personal' AND state='active'"
            : "(organization_id,node_id,scope_project_id,runtime_doc_id) WHERE scope_kind='project' AND state='active'"} DO UPDATE SET
            directory_id=EXCLUDED.directory_id,name=EXCLUDED.name,bytes=EXCLUDED.bytes,media_type=EXCLUDED.media_type,
            modified_at_ms=EXCLUDED.modified_at_ms,state='active',deleted_at=NULL,trashed_at=NULL,trashed_by_user_id=NULL,
            purge_after=NULL,purged_at=NULL,purged_by_user_id=NULL,
            restored_at=CASE WHEN document_catalog.state='trash' THEN now() ELSE document_catalog.restored_at END,
            restored_by_user_id=CASE WHEN document_catalog.state='trash' THEN $14 ELSE document_catalog.restored_by_user_id END,
            updated_at=now(),owner_user_id=COALESCE(document_catalog.owner_user_id,EXCLUDED.owner_user_id),
            owner_source=CASE WHEN document_catalog.owner_user_id IS NULL THEN EXCLUDED.owner_source ELSE document_catalog.owner_source END,
            legacy=CASE WHEN document_catalog.owner_user_id IS NULL THEN EXCLUDED.legacy ELSE document_catalog.legacy END
          WHERE document_catalog.state<>'purged'
          RETURNING id,runtime_doc_id`, [
          this.context.organizationId, scope.kind, scope.userId, scope.projectId,
          incoming.map(document => document.docId), incoming.map(document => document.directoryId ?? ''),
          incoming.map(document => document.name), incoming.map(document => document.bytes),
          incoming.map(document => document.mediaType), incoming.map(document => Math.trunc(document.modifiedAt)),
          incoming.map(document => ownerFor(document)), incoming.map(() => source),
          incoming.map(() => source === 'legacy'), actorId,
        ])
      await this.insertHistoryBatch(client, upserted.rows.map(row => ({
        catalogId: row.id,
        eventKind: existingByDocId.get(row.runtime_doc_id)?.state === 'active' ? 'updated'
          : existingByDocId.get(row.runtime_doc_id) === undefined ? 'created' : 'restored',
      })), actorId, { source })
      if (input.replace === true) {
        const missing = existing.rows.filter(row => row.state === 'active' && !documentIds.has(row.runtime_doc_id))
        if (missing.length > 0) {
          const updated = await client.query<{ id: string }>(`UPDATE harness.document_catalog AS catalog SET state='missing',
            missing_at=clock_timestamp(),updated_at=now()
            FROM unnest($2::uuid[]) AS missing(id)
            WHERE catalog.node_id=${this.nodeSql} AND catalog.organization_id=$1 AND catalog.id=missing.id AND catalog.state='active'
            RETURNING catalog.id`, [this.context.organizationId, missing.map(row => row.id)])
          await this.insertHistoryBatch(client, updated.rows.map(row => ({ catalogId: row.id, eventKind: 'missing' })),
            actorId, { reason: 'runtime-reconcile' })
        }
      }
      await this.assertScopeWriter(client, input.actorUserId, input.scope)
    })
  }

  /** Trash only current active metadata; a committed permanent purge is retained. */
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
      const trashedAt = new Date()
      const row = await client.query<{ id: string }>(`UPDATE harness.document_catalog c SET
          state='trash',trash_action_id=gen_random_uuid(),deleted_at=$6,trashed_at=$6,trashed_by_user_id=$7,purge_after=$8,updated_at=now()
        WHERE c.node_id=${this.nodeSql} AND c.organization_id=$1 AND c.scope_kind=$2
          AND ((c.scope_kind='personal' AND c.scope_user_id=$3) OR (c.scope_kind='project' AND c.scope_project_id=$4))
          AND c.runtime_doc_id=$5 AND c.state='active' RETURNING c.id`, [
        this.context.organizationId, ids.kind, ids.userId, ids.projectId, docId,
        trashedAt, actorId, retentionDeadline(trashedAt, this.retentionDays),
      ])
      if (row.rows[0] === undefined) { await this.assertScopeWriter(client, actorUserId, scope); return }
      await this.insertHistory(client, { catalogId: row.rows[0].id, actorId, eventKind: 'deleted', detail: { reason: 'runtime' } })
      await this.assertScopeWriter(client, actorUserId, scope)
    })
  }

  /**
   * Trash the locked initial set; concurrent registrations remain available for later reconciliation.
   * @param actorUserId - public id of the authenticated actor.
   * @param scope - personal or project document scope.
   * @param requests - exact lifecycle results or legacy runtime-local document ids.
   * @returns a promise that settles after metadata and history are committed.
   */
  async markDeletedBatch(
    actorUserId: number, scope: DocumentCatalogScope,
    requests: readonly (string | DocumentCatalogRemoval)[],
  ): Promise<void> {
    if (requests.length === 0) return
    if (requests.length > 2_000) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Document deletion batch is too large.')
    }
    const removals = requests.map(request => typeof request === 'string' ? { docId: request } : request)
    if (removals.some(item => item.state !== undefined || item.incarnationId !== undefined
      || item.revision !== undefined || item.trashId !== undefined)) {
      await transaction(this.context.pool, async (client) => {
        const actorId = await this.actorInternalId(client, actorUserId)
        const ids = await this.scopeIds(client, scope)
        if (ids.kind === 'project') {
          const authority = await this.projectAuthority(client, ids.projectId!, actorId)
          if (authority === null || authority.mode !== 'rw') {
            throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot remove project document metadata.')
          }
        }
        await this.lockDocumentScope(client, ids)
        for (const removal of removals) {
          const state = removal.state ?? 'trash'
          const identity = removal.incarnationId
          const revision = removal.revision
          const trashId = removal.trashId
          if (state === 'trash' && (identity === undefined || revision === undefined || trashId === undefined)
            || state === 'purged' && (identity === undefined || revision === undefined || trashId === undefined)) {
            throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'A trash update requires its exact document and action identity.')
          }
          const trashedAt = removal.trashedAt ?? Date.now()
          const purgeAfter = removal.purgeAfter ?? trashedAt + this.retentionDays * 86_400_000
          const update = state === 'trash'
            ? await client.query<{ id: string }>(`UPDATE harness.document_catalog SET state='trash',runtime_revision=$8,
              trash_action_id=$9,deleted_at=to_timestamp($10::double precision/1000),
              trashed_at=to_timestamp($10::double precision/1000),trashed_by_user_id=$7,
              purge_after=to_timestamp($11::double precision/1000),updated_at=now()
              WHERE node_id=${this.nodeSql} AND organization_id=$1 AND scope_kind=$2
                AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
                AND runtime_doc_id=$5 AND runtime_incarnation_id=$6 AND runtime_revision=$8-1 AND state='active'
              RETURNING id`, [this.context.organizationId, ids.kind, ids.userId, ids.projectId, removal.docId,
              identity, actorId, revision, trashId, trashedAt, purgeAfter])
            : state === 'missing'
              ? await client.query<{ id: string }>(`UPDATE harness.document_catalog SET state='missing',
                runtime_revision=COALESCE($8,runtime_revision+1),missing_at=clock_timestamp(),updated_at=now()
                WHERE node_id=${this.nodeSql} AND organization_id=$1 AND scope_kind=$2
                  AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
                  AND runtime_doc_id=$5 AND ($6::uuid IS NULL OR runtime_incarnation_id=$6)
                  AND ($7::bigint IS NULL OR runtime_revision=$7) AND state='active' RETURNING id`,
              [this.context.organizationId, ids.kind, ids.userId, ids.projectId, removal.docId, identity ?? null,
                revision === undefined ? null : revision - 1, revision ?? null])
              : await client.query<{ id: string }>(`UPDATE harness.document_catalog SET state='purged',runtime_revision=$7,
                trash_action_id=NULL,purged_at=clock_timestamp(),purged_by_user_id=$8,purge_after=NULL,updated_at=now()
                WHERE node_id=${this.nodeSql} AND organization_id=$1 AND scope_kind=$2
                  AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
                  AND runtime_doc_id=$5 AND runtime_incarnation_id=$6 AND runtime_revision=$7-1
                  AND trash_action_id=$9 AND state='trash' RETURNING id`,
              [this.context.organizationId, ids.kind, ids.userId, ids.projectId, removal.docId, identity ?? null,
                revision ?? null, actorId, trashId ?? null])
          if (update.rows[0] === undefined) {
            const current = await client.query<{ state: DocumentCatalogState; runtime_revision: string | number; trash_action_id: string | null }>(
              `SELECT state,runtime_revision,trash_action_id FROM ${this.nodeRows('document_catalog')} document_catalog
                WHERE organization_id=$1 AND scope_kind=$2
                  AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
                  AND runtime_doc_id=$5 AND ($6::uuid IS NULL OR runtime_incarnation_id=$6)
                ORDER BY id FOR UPDATE`, [this.context.organizationId, ids.kind, ids.userId, ids.projectId,
                removal.docId, identity ?? null])
            const currentRevision = current.rows.length === 1
              ? safeNumber(current.rows[0]!.runtime_revision, 'document identity revision') : undefined
            const alreadyApplied = current.rows.length === 1 && (state === 'trash'
              ? current.rows[0]!.state === 'trash' && currentRevision === revision && current.rows[0]!.trash_action_id === trashId
              : state === 'purged'
                ? current.rows[0]!.state === 'purged' && currentRevision === revision && current.rows[0]!.trash_action_id === null
                : current.rows[0]!.state === 'missing' && (revision === undefined || currentRevision === revision))
            if (alreadyApplied) continue
            throw new DocumentCatalogError('DOCUMENT_IDENTITY_STALE', 409, 'The document catalog changed before its lifecycle update.')
          }
          await this.insertHistory(client, { catalogId: update.rows[0].id, actorId,
            eventKind: state === 'trash' ? 'deleted' : state === 'purged' ? 'purged' : 'missing',
            detail: { reason: 'runtime', ...(trashId === undefined ? {} : { trashId }) } })
        }
        await this.assertScopeWriter(client, actorUserId, scope)
      })
      return
    }
    const docIds = removals.map(item => item.docId)
    await transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, actorUserId)
      const ids = await this.scopeIds(client, scope)
      if (ids.kind === 'project') {
        const authority = await this.projectAuthority(client, ids.projectId!, actorId)
        if (authority === null || authority.mode !== 'rw') {
          throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot remove project document metadata.')
        }
      }
      const candidates = await client.query<{ id: string }>(`SELECT id FROM ${this.nodeRows('document_catalog')} document_catalog
        WHERE organization_id=$1 AND scope_kind=$2
          AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
          AND runtime_doc_id=ANY($5::text[]) AND state='active'
        ORDER BY id FOR UPDATE`, [this.context.organizationId, ids.kind, ids.userId, ids.projectId, [...new Set(docIds)]])
      const trashedAt = new Date()
      const updated = await client.query<{ id: string }>(`UPDATE harness.document_catalog AS catalog SET
          state='trash',trash_action_id=gen_random_uuid(),deleted_at=$5,trashed_at=$5,trashed_by_user_id=$6,purge_after=$7,updated_at=now()
        WHERE catalog.node_id=${this.nodeSql} AND catalog.organization_id=$1 AND catalog.scope_kind=$2
          AND ((catalog.scope_kind='personal' AND catalog.scope_user_id=$3) OR (catalog.scope_kind='project' AND catalog.scope_project_id=$4))
          AND catalog.id=ANY($8::uuid[]) AND catalog.state='active'
        RETURNING catalog.id`, [
        this.context.organizationId, ids.kind, ids.userId, ids.projectId, trashedAt, actorId,
        retentionDeadline(trashedAt, this.retentionDays), candidates.rows.map(row => row.id),
      ])
      await this.insertHistoryBatch(client, updated.rows.map(row => ({ catalogId: row.id, eventKind: 'deleted' })), actorId, { reason: 'runtime' })
      await this.assertScopeWriter(client, actorUserId, scope)
    })
  }

  /** Mark current trash purged after its bytes are gone; a concurrent restore remains active. */
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
      const candidates = await client.query<{ id: string }>(`SELECT id FROM ${this.nodeRows('document_catalog')} c
        WHERE c.organization_id=$1 AND c.scope_kind=$2
          AND ((c.scope_kind='personal' AND c.scope_user_id=$3) OR (c.scope_kind='project' AND c.scope_project_id=$4))
          AND c.runtime_doc_id=$5 AND c.state='trash' ORDER BY c.id FOR UPDATE`, [
        this.context.organizationId, ids.kind, ids.userId, ids.projectId, docId,
      ])
      if (candidates.rows.length > 1) {
        throw new DocumentCatalogError('DOCUMENT_IDENTITY_AMBIGUOUS', 409, 'Select the exact document version before purging it.')
      }
      const row = candidates.rows[0] === undefined ? { rows: [] as { id: string }[] }
        : await client.query<{ id: string }>(`UPDATE harness.document_catalog c SET
            state='purged',trash_action_id=NULL,runtime_revision=runtime_revision+1,
            purged_at=clock_timestamp(),purged_by_user_id=$3,purge_after=NULL,updated_at=now()
          WHERE c.node_id=${this.nodeSql} AND c.organization_id=$1 AND c.id=$2 AND c.state='trash' RETURNING c.id`, [
          this.context.organizationId, candidates.rows[0].id, actorId,
        ])
      if (row.rows[0] === undefined) { await this.assertScopeWriter(client, actorUserId, scope); return }
      await this.insertHistory(client, { catalogId: row.rows[0].id, actorId, eventKind: 'purged', detail: { reason: 'runtime' } })
      await this.assertScopeWriter(client, actorUserId, scope)
    })
  }

  /** Check ownership-aware mutation permission for one or more runtime ids. */
  async authorize(input: {
    actorUserId: number
    scope: DocumentCatalogScope
    action: 'delete' | 'move' | 'ownership' | 'restore' | 'purge'
    documents?: readonly DocumentCatalogSelectionInput[]
    /** @deprecated Use documents to carry an exact trash action when a path is ambiguous. */
    docIds?: readonly string[]
    administrator?: boolean
  }): Promise<{ allowed: true; selections: readonly DocumentCatalogSelection[] }> {
    const requestedDocuments: readonly DocumentCatalogSelectionInput[] = input.documents ?? input.docIds?.map(docId => ({ docId })) ?? []
    if (requestedDocuments.length === 0 || requestedDocuments.length > 2000) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document authorization request.')
    }
    const unique = new Set(requestedDocuments.map(document => document.docId))
    if (unique.size !== requestedDocuments.length) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Duplicate document authorization target.')
    }
    return transaction(this.context.pool, async (client) => {
      const actorId = await this.actorInternalId(client, input.actorUserId)
      const ids = await this.scopeIds(client, input.scope)
      const expectedState: DocumentCatalogState = input.action === 'restore' || input.action === 'purge' ? 'trash' : 'active'
      if (input.administrator === true) await this.assertAdministrator(client, input.actorUserId)
      if (ids.kind === 'personal') {
        if (!input.administrator && ids.userId !== actorId) {
          throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Only the personal document owner can modify this document.')
        }
      } else {
        const authority = await this.projectAuthority(client, ids.projectId!, actorId)
        if (authority === null || authority.mode !== 'rw') {
          throw new DocumentCatalogError('COLLABORATION_FORBIDDEN', 403, 'You cannot modify project documents.')
        }
      }
      const rows = ids.kind === 'personal'
        ? await client.query<{
        id: string; runtime_doc_id: string; owner_user_id: string | null; state: DocumentCatalogState
        runtime_incarnation_id: string | null; runtime_revision: string | number; trash_action_id: string | null
      }>(`SELECT id,runtime_doc_id,owner_user_id,state,runtime_incarnation_id,runtime_revision,trash_action_id
          FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND scope_kind='personal' AND scope_user_id=$2
            AND runtime_doc_id=ANY($3::text[]) AND state=$4 ORDER BY id FOR UPDATE`,
      [this.context.organizationId, ids.userId, requestedDocuments.map(document => document.docId), expectedState])
        : await client.query<{
          id: string; runtime_doc_id: string; owner_user_id: string | null; state: DocumentCatalogState
          runtime_incarnation_id: string | null; runtime_revision: string | number; trash_action_id: string | null
        }>(`SELECT id,runtime_doc_id,owner_user_id,state,runtime_incarnation_id,runtime_revision,trash_action_id
          FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND scope_kind='project' AND scope_project_id=$2
            AND runtime_doc_id=ANY($3::text[]) AND state=$4 ORDER BY id FOR UPDATE`,
        [this.context.organizationId, ids.projectId, requestedDocuments.map(document => document.docId), expectedState])
      const byDocId = new Map<string, typeof rows.rows>()
      for (const row of rows.rows) byDocId.set(row.runtime_doc_id, [...byDocId.get(row.runtime_doc_id) ?? [], row])
      const selections: DocumentCatalogSelection[] = []
      for (const requested of requestedDocuments) {
        const candidates = byDocId.get(requested.docId) ?? []
        const selected = candidates.filter(row => (requested.trashId === undefined || row.trash_action_id === requested.trashId)
          && (requested.incarnationId === undefined || row.runtime_incarnation_id === requested.incarnationId))
        if (selected.length === 0) {
          if (requested.incarnationId !== undefined || requested.trashId !== undefined) {
            throw new DocumentCatalogError('DOCUMENT_IDENTITY_STALE', 409, 'The selected document version has changed.')
          }
          throw new DocumentCatalogError('DOCUMENT_OWNERSHIP_UNKNOWN', 503, 'Document ownership is not yet synchronized.')
        }
        if (selected.length !== 1) {
          throw new DocumentCatalogError('DOCUMENT_IDENTITY_AMBIGUOUS', 409, 'Select the exact document version before changing it.')
        }
        const row = selected[0]!
        const incarnationId = row.runtime_incarnation_id
        const revision = safeNumber(row.runtime_revision, 'document identity revision')
        if (incarnationId === null || requested.incarnationId !== undefined && requested.incarnationId !== incarnationId
          || requested.revision !== undefined && requested.revision !== revision
          || requested.trashId !== undefined && requested.trashId !== row.trash_action_id) {
          throw new DocumentCatalogError('DOCUMENT_IDENTITY_STALE', 409, 'The selected document version has changed.')
        }
        if (!input.administrator && row.owner_user_id !== actorId
          && ids.kind === 'personal') {
          throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Only the document owner can modify this document.')
        }
        if (!input.administrator && ids.kind === 'project') {
          const authority = await this.projectAuthority(client, ids.projectId!, actorId)
          if (authority === null || !authority.administrator && !authority.owner && row.owner_user_id !== actorId) {
            throw new DocumentCatalogError('DOCUMENT_NOT_OWNER', 403, 'Only the document owner can modify this document.')
          }
        }
        selections.push({ docId: row.runtime_doc_id, incarnationId, revision,
          state: expectedState === 'trash' ? 'trash' : 'active',
          ...(expectedState === 'trash' && row.trash_action_id !== null ? { trashId: row.trash_action_id } : {}) })
      }
      return { allowed: true, selections }
    })
  }

  /** Return readable metadata from active projects, including Steward qualification checks. */
  async overview(
    actorUserId: number,
    options: DocumentCatalogOverviewOptions = {},
    allNodes = false,
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
      ...(this.entryNodeId === undefined ? [] : [`harness.entry_node_visible(c.organization_id,${escapeLiteral(this.entryNodeId)}::uuid,c.node_id)`]),
      `harness.computer_use_allowed(c.organization_id,$2,c.node_id)`,
      "c.state='active'",
      "(c.scope_user_id=$2 OR membership.role='admin' OR member.user_id IS NOT NULL)",
      `(c.scope_kind<>'project' OR harness.project_computer_use_allowed(c.organization_id,$2,c.scope_project_id))`,
      `(c.scope_kind<>'project' OR (p.status='active' AND (p.kind<>'steward'
        OR membership.role='admin' AND EXISTS (SELECT 1 FROM harness.steward_access_policies sp
          WHERE sp.organization_id=c.organization_id AND sp.user_id=$2 AND sp.node_id=harness.project_node_id(c.organization_id,c.scope_project_id) AND sp.enabled))))`,
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
    const fingerprint = `${allNodes ? 'all-computers' : this.context.nodeId}:${this.entryNodeId ?? ''}:${actorUserId}:${overviewFilterFingerprint(options)}`
    const offset = decodeCatalogCursor(options.cursor, fingerprint)
    const rowValues = [...values, limit + 1, offset]
    const limitArg = `$${String(values.length + 1)}`
    const offsetArg = `$${String(values.length + 2)}`
    const from = `FROM ${allNodes ? 'harness.document_catalog' : this.nodeRows('document_catalog')} c
      LEFT JOIN harness.users u ON u.id=c.scope_user_id AND u.organization_id=c.organization_id
      LEFT JOIN harness.projects p ON p.id=c.scope_project_id AND p.organization_id=c.organization_id
      LEFT JOIN harness.memberships membership ON membership.organization_id=c.organization_id
        AND membership.user_id=$2 AND membership.status='active'
      LEFT JOIN harness.project_members member ON member.organization_id=c.organization_id
        AND member.project_id=c.scope_project_id AND member.user_id=$2
      LEFT JOIN harness.users owner ON owner.id=c.owner_user_id AND owner.organization_id=c.organization_id`
    const where = `WHERE ${clauses.join(' AND ')}`
    const visibilityWhere = `WHERE ${visibilityClauses.join(' AND ')}`
    const select = `SELECT c.id catalog_id,c.node_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      CASE WHEN c.scope_kind='project' AND membership.role='admin' THEN 'rw'::text
        WHEN c.scope_kind='project' THEN member.access_mode ELSE NULL END access_mode,
      c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      c.runtime_incarnation_id,c.runtime_revision,c.trash_action_id,
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
      LEFT JOIN ${this.nodeRows('document_catalog')} c ON c.id=h.catalog_id AND c.organization_id=h.organization_id
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
    if (filter.state === 'active' || filter.state === 'trash' || filter.state === 'purged' || filter.state === 'missing') add('c.state=?', filter.state)
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
    const fingerprint = `${this.context.nodeId}:${adminFilterFingerprint(filter)}`
    const offset = filter.cursor === undefined
      ? Math.max(filter.offset ?? 0, 0)
      : decodeCatalogCursor(filter.cursor, fingerprint)
    values.push(limit); const limitArg = `$${String(values.length)}`
    values.push(offset); const offsetArg = `$${String(values.length)}`
    // The two placeholders above are assembled separately to keep all user
    // values parameterized; the query below is deliberately metadata-only.
    const result = await this.context.pool.query<CatalogDbRow>(`SELECT c.id catalog_id,c.node_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      NULL::text access_mode,c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      c.runtime_incarnation_id,c.runtime_revision,c.trash_action_id,
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state,
      (extract(epoch FROM c.trashed_at)*1000)::bigint::text trashed_at_ms,
      (extract(epoch FROM c.restored_at)*1000)::bigint::text restored_at_ms,
      (extract(epoch FROM c.purge_after)*1000)::bigint::text purge_after_ms,
      (extract(epoch FROM c.purged_at)*1000)::bigint::text purged_at_ms
      FROM ${this.nodeRows('document_catalog')} c
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
    const fingerprint = `${this.context.nodeId}:${adminFilterFingerprint(filter)}`
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
      (SELECT COUNT(*)::text FROM ${this.nodeRows('document_operations')} o
        WHERE o.organization_id=$1 AND o.created_at >= now()-interval '24 hours') operations,
      (SELECT COUNT(*)::text FROM harness.document_operation_items i
        JOIN ${this.nodeRows('document_operations')} o ON o.id=i.operation_id
        WHERE o.organization_id=$1 AND i.status='failed' AND i.updated_at >= now()-interval '24 hours') failures
      FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1`, [this.context.organizationId])
    const row = result.rows[0]!
    return {
      total: Number(row.total), active: Number(row.active), trash: Number(row.trash), purged: Number(row.purged), deleted: Number(row.deleted),
      personal: Number(row.personal), project: Number(row.project), bytes: Number(row.bytes),
      operations24h: Number(row.operations), failures24h: Number(row.failures),
    }
  }

  /** Load one document's metadata, lineage history, and copy attempts. */
  async detail(catalogId: string): Promise<DocumentCatalogDetail | null> {
    const row = await this.context.pool.query<CatalogDbRow>(`SELECT c.id catalog_id,c.node_id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      CASE WHEN c.scope_kind='personal' THEN '个人文档' ELSE p.name::text END scope_label,
      NULL::text access_mode,c.runtime_doc_id,c.directory_id,c.name,c.bytes::text,c.media_type,c.modified_at_ms::text,
      c.runtime_incarnation_id,c.runtime_revision,c.trash_action_id,
      owner.public_id::text owner_public_id,owner.display_name owner_display_name,c.owner_source,c.legacy,c.lineage_root_id,c.state,
      (extract(epoch FROM c.trashed_at)*1000)::bigint::text trashed_at_ms,
      (extract(epoch FROM c.restored_at)*1000)::bigint::text restored_at_ms,
      (extract(epoch FROM c.purge_after)*1000)::bigint::text purge_after_ms,
      (extract(epoch FROM c.purged_at)*1000)::bigint::text purged_at_ms
      FROM ${this.nodeRows('document_catalog')} c
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
      runtime_incarnation_id: string | null
      runtime_revision: string | number
      trash_action_id: string | null
    }>(`SELECT c.id,c.scope_kind,
      CASE WHEN c.scope_kind='personal' THEN u.public_id::text ELSE p.public_id::text END scope_public_id,
      c.runtime_doc_id,c.directory_id,c.name,c.state,c.runtime_incarnation_id,c.runtime_revision,c.trash_action_id
      FROM ${this.nodeRows('document_catalog')} c
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
      ...(row.runtime_incarnation_id === null ? {} : {
        identity: { incarnationId: row.runtime_incarnation_id, revision: safeNumber(row.runtime_revision, 'document identity revision') },
      }),
      ...(row.trash_action_id === null ? {} : { trashId: row.trash_action_id }),
    }
  }

  /** Transfer ownership with an explicit audit event. */
  async transferOwnership(actorUserId: number, catalogId: string, ownerUserId: number): Promise<void> {
    await transaction(this.context.pool, async (client) => {
      await this.actorInternalId(client, actorUserId)
      const row = await client.query<{ id: string; scope_project_id: string | null; owner_user_id: string | null }>(`SELECT id,scope_project_id,owner_user_id
        FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND id=$2 AND state='active' FOR UPDATE`, [this.context.organizationId, catalogId])
      const document = row.rows[0]
      if (document === undefined) throw new DocumentCatalogError('DOCUMENT_NOT_FOUND', 404, 'Document metadata was not found.')
      if (document.scope_project_id === null) {
        throw new DocumentCatalogError('DOCUMENT_OWNERSHIP_FORBIDDEN', 403, 'Personal document ownership cannot be transferred.')
      }
      const { actor, target } = await this.transferParties(client, document.scope_project_id, actorUserId, ownerUserId)
      const operation = await client.query<{ id: string }>(`INSERT INTO harness.document_operations(node_id,
        organization_id,actor_user_id,operation_kind,status,requested_count,completed_count,detail,completed_at
      ) VALUES(${this.nodeSql},$1,$2,'ownership-transfer','completed',1,1,$3::jsonb,now()) RETURNING id`, [
        this.context.organizationId, actor, JSON.stringify({ catalogId, ownerUserId }),
      ])
      await client.query(`UPDATE harness.document_catalog SET owner_user_id=$3,owner_source='admin',legacy=false,updated_at=now() WHERE node_id=${this.nodeSql} AND id=$1 AND organization_id=$2`, [catalogId, this.context.organizationId, target])
      await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'ownership-transferred', detail: { ownerUserId } })
      await this.transferParties(client, document.scope_project_id, actorUserId, ownerUserId)
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
        FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND id=$2 FOR UPDATE`, [this.context.organizationId, catalogId])
      await this.assertAdministrator(client, actorUserId)
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
      const operation = await client.query<{ id: string }>(`INSERT INTO harness.document_operations(node_id,
        organization_id,actor_user_id,operation_kind,status,requested_count,completed_count,detail,completed_at
      ) VALUES(${this.nodeSql},$1,$2,'admin-action','completed',1,1,$3::jsonb,now()) RETURNING id`, [
        this.context.organizationId, actor, JSON.stringify({ action: target, catalogId }),
      ])
      if (target === 'trash') {
        await client.query(`UPDATE harness.document_catalog SET state='trash',trash_action_id=gen_random_uuid(),
          runtime_revision=runtime_revision+1,deleted_at=$2,trashed_at=$2,
          trashed_by_user_id=$3,purge_after=$4,updated_at=now() WHERE node_id=${this.nodeSql} AND id=$1`, [
          catalogId, at, actor, retentionDeadline(at, this.retentionDays),
        ])
        await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'deleted', detail: { reason: 'admin' } })
      } else if (target === 'active') {
        await client.query(`UPDATE harness.document_catalog SET state='active',trash_action_id=NULL,
          runtime_revision=runtime_revision+1,deleted_at=NULL,trashed_at=NULL,
          trashed_by_user_id=NULL,purge_after=NULL,restored_at=$2,restored_by_user_id=$3,updated_at=now() WHERE node_id=${this.nodeSql} AND id=$1`, [catalogId, at, actor])
        await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'restored', detail: { reason: 'admin' } })
      } else {
        await client.query(`UPDATE harness.document_catalog SET state='purged',trash_action_id=NULL,
          runtime_revision=runtime_revision+1,purged_at=$2,purged_by_user_id=$3,
          purge_after=NULL,updated_at=now() WHERE node_id=${this.nodeSql} AND id=$1`, [catalogId, at, actor])
        await this.insertHistory(client, { catalogId, operationId: operation.rows[0]!.id, actorId: actor, eventKind: 'purged', detail: { reason: 'admin' } })
      }
      await this.assertAdministrator(client, actorUserId)
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

  /** Purge only trash whose current retention deadline has passed after row-lock admission. */
  async purgeDue(limit = 100): Promise<number> {
    const bounded = Math.min(Math.max(limit, 1), 500)
    const due = await this.context.pool.query<{ id: string }>(`SELECT id
      FROM ${this.nodeRows('document_catalog')} document_catalog
      WHERE organization_id=$1 AND state='trash' AND purge_after IS NOT NULL AND purge_after <= clock_timestamp()
      ORDER BY purge_after,id LIMIT $2`, [this.context.organizationId, bounded])
    let count = 0
    for (const row of due.rows) {
      await transaction(this.context.pool, async (client) => {
        const purged = await client.query<{ id: string }>(`UPDATE harness.document_catalog SET state='purged',trash_action_id=NULL,
          runtime_revision=runtime_revision+1,
          purged_at=clock_timestamp(),purge_after=NULL,updated_at=now()
          WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2 AND state='trash'
            AND purge_after IS NOT NULL AND purge_after<=clock_timestamp() RETURNING id`, [this.context.organizationId, row.id])
        if (purged.rows.length === 0) return
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
    sourceNodeId?: RuntimeNodeId
    targetNodeId?: RuntimeNodeId
    sourceIdentity?: Pick<DocumentCatalogIdentity, 'incarnationId' | 'revision'>
    sourceName: string
    target?: DocumentCatalogInput
    error?: { code: string; message: string }
    operationId?: string
  }): Promise<{ operationId: string; targetCatalogId: string | null }> {
    if (input.targetNodeId !== undefined && input.targetNodeId !== this.context.nodeId) {
      return new PostgresDocumentCatalogService({ ...this.context, nodeId: input.targetNodeId }, this.retentionDays).recordCopy(input)
    }
    if (input.target !== undefined) validScopeInput(input.target)
    if (input.sourceIdentity !== undefined && (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.sourceIdentity.incarnationId)
      || !Number.isSafeInteger(input.sourceIdentity.revision) || input.sourceIdentity.revision < 1)) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid copied document identity.')
    }
    return transaction(this.context.pool, async (client) => {
      const actor = await this.actorInternalId(client, input.actorUserId)
      const sourceIds = await this.scopeIds(client, input.source)
      const targetIds = await this.scopeIds(client, input.targetScope)
      let operationId = input.operationId
      if (operationId === undefined) {
        const operation = await client.query<{ id: string }>(`INSERT INTO harness.document_operations(node_id,
          organization_id,actor_user_id,operation_kind,status,requested_count,
          source_scope_kind,source_user_id,source_project_id,target_scope_kind,target_user_id,target_project_id
        ) VALUES(${this.nodeSql},$1,$2,'copy','running',1,$3,$4,$5,$6,$7,$8) RETURNING id`, [
          this.context.organizationId, actor, sourceIds.kind, sourceIds.userId, sourceIds.projectId,
          targetIds.kind, targetIds.userId, targetIds.projectId,
        ])
        operationId = operation.rows[0]!.id
      } else {
        const existingOperation = await client.query<{ id: string }>(`SELECT id FROM ${this.nodeRows('document_operations')} document_operations
          WHERE organization_id=$1 AND id=$2`, [this.context.organizationId, operationId])
        if (existingOperation.rows[0] === undefined) {
          await client.query(`INSERT INTO harness.document_operations(node_id,
            id,organization_id,actor_user_id,operation_kind,status,requested_count,
            source_scope_kind,source_user_id,source_project_id,target_scope_kind,target_user_id,target_project_id
          ) VALUES(${this.nodeSql},$1,$2,$3,'copy','running',1,$4,$5,$6,$7,$8,$9)`, [
            operationId, this.context.organizationId, actor, sourceIds.kind, sourceIds.userId, sourceIds.projectId,
            targetIds.kind, targetIds.userId, targetIds.projectId,
          ])
        } else {
          await client.query(`UPDATE harness.document_operations SET requested_count=requested_count+1,updated_at=now()
            WHERE node_id=${this.nodeSql} AND organization_id=$1 AND id=$2`, [this.context.organizationId, operationId])
        }
      }
      const source = await client.query<{ id: string; lineage_root_id: string | null }>(`SELECT id,lineage_root_id FROM harness.document_catalog document_catalog WHERE organization_id=$1 AND node_id=$7::uuid
        AND scope_kind=$2 AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
        AND (($6::uuid IS NOT NULL AND runtime_incarnation_id=$6)
          OR ($6::uuid IS NULL AND runtime_doc_id=$5 AND runtime_incarnation_id IS NULL AND state='active'))`,
      [this.context.organizationId, sourceIds.kind, sourceIds.userId, sourceIds.projectId, input.sourceDocId,
        input.sourceIdentity?.incarnationId ?? null, input.sourceNodeId ?? this.context.nodeId])
      let targetCatalogId: string | null = null
      if (input.target !== undefined) {
        await this.lockDocumentScope(client, targetIds)
        const found = await client.query<{ id: string; state: DocumentCatalogState; runtime_revision: string | number }>(`SELECT id,state,runtime_revision FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1
          AND scope_kind=$2 AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
          AND (($6::uuid IS NOT NULL AND runtime_incarnation_id=$6)
            OR ($6::uuid IS NULL AND runtime_doc_id=$5 AND runtime_incarnation_id IS NULL))
          ORDER BY id FOR NO KEY UPDATE`, [this.context.organizationId, targetIds.kind, targetIds.userId, targetIds.projectId,
          input.target.docId, input.target.identity?.incarnationId ?? null])
        if (found.rows.length > 1) {
          throw new DocumentCatalogError('DOCUMENT_IDENTITY_AMBIGUOUS', 409, 'The copied document identity is ambiguous.')
        }
        const existingTarget = found.rows[0]
        if (existingTarget !== undefined && input.target.identity === undefined && existingTarget.state !== 'active') {
          throw new DocumentCatalogError('DOCUMENT_TARGET_CONFLICT', 409, 'The target document id is no longer active.')
        }
        if (existingTarget !== undefined && input.target.identity !== undefined
          && safeNumber(existingTarget.runtime_revision, 'document identity revision') < input.target.identity.revision) {
          throw new DocumentCatalogError('DOCUMENT_IDENTITY_STALE', 409, 'The copied document version is not synchronized.')
        }
        targetCatalogId = existingTarget?.id ?? null
        if (targetCatalogId === null) {
          const occupied = await client.query(`SELECT id FROM ${this.nodeRows('document_catalog')} document_catalog WHERE organization_id=$1 AND scope_kind=$2
            AND ((scope_kind='personal' AND scope_user_id=$3) OR (scope_kind='project' AND scope_project_id=$4))
            AND runtime_doc_id=$5 AND state='active' FOR NO KEY UPDATE`, [this.context.organizationId, targetIds.kind,
            targetIds.userId, targetIds.projectId, input.target.docId])
          if (occupied.rows.length > 0) {
            throw new DocumentCatalogError('DOCUMENT_TARGET_CONFLICT', 409, 'The copied document path belongs to another incarnation.')
          }
          const owner = input.target.identity?.createdBy === undefined ? actor
            : await this.identityOwnerInternalId(client, input.target.identity.createdBy)
          const inserted = await client.query<{ id: string }>(`INSERT INTO harness.document_catalog(node_id,
            organization_id,scope_kind,scope_user_id,scope_project_id,runtime_doc_id,directory_id,name,bytes,media_type,
            modified_at_ms,owner_user_id,owner_source,lineage_root_id,source_catalog_id,state,legacy,runtime_incarnation_id,runtime_revision
          ) VALUES(${this.nodeSql},$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'transfer',$12,$13,'active',false,$14,$15) RETURNING id`, [
            this.context.organizationId, targetIds.kind, targetIds.userId, targetIds.projectId, input.target.docId,
            input.target.directoryId ?? '', input.target.name, input.target.bytes, input.target.mediaType,
            Math.trunc(input.target.modifiedAt), owner, source.rows[0]?.lineage_root_id ?? source.rows[0]?.id ?? null, source.rows[0]?.id ?? null,
            input.target.identity?.incarnationId ?? null, input.target.identity?.revision ?? 1,
          ])
          targetCatalogId = inserted.rows[0]!.id
          await this.insertHistory(client, { catalogId: targetCatalogId, actorId: actor, eventKind: 'created', detail: { source: 'transfer' } })
        } else {
          if (input.target.identity === undefined) {
            await client.query(`UPDATE harness.document_catalog SET directory_id=$2,name=$3,bytes=$4,media_type=$5,
              modified_at_ms=$6,source_catalog_id=COALESCE(source_catalog_id,$7),
              lineage_root_id=COALESCE(lineage_root_id,$8),updated_at=now() WHERE node_id=${this.nodeSql} AND id=$1 AND state='active'`, [
              targetCatalogId, input.target.directoryId ?? '', input.target.name, input.target.bytes, input.target.mediaType,
              Math.trunc(input.target.modifiedAt), source.rows[0]?.id ?? null,
              source.rows[0]?.lineage_root_id ?? source.rows[0]?.id ?? null,
            ])
          } else {
            await client.query(`UPDATE harness.document_catalog SET source_catalog_id=COALESCE(source_catalog_id,$2),
              lineage_root_id=COALESCE(lineage_root_id,$3),updated_at=now() WHERE node_id=${this.nodeSql} AND id=$1`, [
              targetCatalogId, source.rows[0]?.id ?? null,
              source.rows[0]?.lineage_root_id ?? source.rows[0]?.id ?? null,
            ])
          }
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
        WHERE node_id=${this.nodeSql} AND id=$1`, [operationId, input.error === undefined ? 1 : 0, input.error === undefined ? 0 : 1])
      return { operationId, targetCatalogId }
    })
  }
}

/** Generate a stable opaque operation id for clients that need an id before commit. */
export function newDocumentOperationId(): string {
  return randomUUID()
}
