/** Runtime wire handlers for the organization document metadata catalog. */

import type { GatewayPrincipalClaims } from './principal.ts'
import type { GatewayAuditService } from './services.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import {
  DocumentCatalogError,
  type DocumentCatalogInput,
  type DocumentCatalogIdentity,
  type DocumentCatalogProjectionBatch,
  type DocumentCatalogProjectionChange,
  type DocumentCatalogRemoval,
  type DocumentCatalogSelectionInput,
  type DocumentCatalogScope,
  type DocumentCatalogOverviewOptions,
  type PostgresDocumentCatalogService,
} from './postgres/document-catalog-service.ts'

export { DocumentCatalogError } from './postgres/document-catalog-service.ts'

/** Catalog ownership after browser or Runtime authentication; process identity grants no document access. */
export type DocumentCatalogSubject = Pick<RuntimeCredentialSubject, 'organizationId' | 'target'> & {
  /** Present on authenticated Runtime callbacks; browser storage access has no process generation. */
  readonly generation?: number
}

/** Current authenticated actor and document scope; local browser operations mint no execution credential. */
export type DocumentCatalogActor = Pick<GatewayPrincipalClaims, 'user' | 'scope' | 'purpose'>

/** Runtime callback consumed by the authenticated loopback API. */
export interface RuntimeDocumentCatalogSyncHandler {
  (input: {
    readonly subject: DocumentCatalogSubject
    readonly principal: DocumentCatalogActor
    readonly payload: unknown
  }): Promise<{ readonly version: 1; readonly accepted: number }>
}

/** Runtime callback marking permanently purged document metadata. */
export interface RuntimeDocumentCatalogPurgeHandler {
  (input: {
    readonly subject: DocumentCatalogSubject
    readonly principal: DocumentCatalogActor
    readonly payload: unknown
  }): Promise<{ readonly version: 1; readonly accepted: number }>
}

/** Runtime callback for ownership-aware document mutations. */
export interface RuntimeDocumentCatalogAuthorizeHandler {
  (input: {
    readonly subject: DocumentCatalogSubject
    readonly principal: DocumentCatalogActor
    readonly payload: unknown
  }): Promise<{ readonly version: 1; readonly allowed: true; readonly selections: readonly unknown[] }>
}

/** Runtime callback for the metadata-only all-scope overview. */
export interface RuntimeDocumentCatalogOverviewHandler {
  (input: {
    readonly subject: DocumentCatalogSubject
    readonly principal: DocumentCatalogActor
    readonly options?: unknown
  }): Promise<unknown>
}

/** Runtime callback for recent current-scope document operations. */
export interface RuntimeDocumentCatalogHistoryHandler {
  (input: {
    readonly subject: DocumentCatalogSubject
    readonly principal: DocumentCatalogActor
  }): Promise<{ readonly version: 1; readonly items: readonly unknown[] }>
}

/** Runtime callback that reads or commits the durable identity projection cursor. */
export interface RuntimeDocumentCatalogProjectionHandler {
  (input: {
    readonly subject: DocumentCatalogSubject
    readonly principal: DocumentCatalogActor
    readonly payload: unknown
  }): Promise<{ readonly version: 1; readonly cursor: { readonly sequence: number; readonly ordinal: number } }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function currentScope(subject: DocumentCatalogSubject): DocumentCatalogScope {
  return subject.target.kind === 'user'
    ? { kind: 'personal', userId: subject.target.id }
    : { kind: 'project', projectId: subject.target.id }
}

function safeText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value !== '' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value)
}

function safeRelativeId(value: unknown, allowEmpty: boolean): value is string {
  return typeof value === 'string' && value.length <= 4096
    && (value === '' ? allowEmpty : value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'
      && !segment.includes('\\') && !/[\u0000-\u001f\u007f]/u.test(segment)))
}

/**
 * Validate untrusted metadata filters shared by browser and Runtime catalog routes.
 * @param value - decoded JSON or query fields with a numeric limit.
 * @returns normalized, bounded overview options.
 */
export function parseDocumentOverviewOptions(value: unknown): DocumentCatalogOverviewOptions {
  if (value === undefined) return {}
  const row = record(value)
  if (row === undefined) throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document overview query.')
  const query = row.query
  const type = row.type
  const sort = row.sort
  const limit = row.limit
  const cursor = row.cursor
  if (query !== undefined && (typeof query !== 'string' || query.length > 255 || /[\u0000-\u001f\u007f]/u.test(query))
    || cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 4096)
    || limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 200)
    || type !== undefined && !['all', 'image', 'pdf', 'text', 'other'].includes(type as string)
    || sort !== undefined && !['date-desc', 'date-asc', 'name-asc', 'name-desc', 'size-desc', 'size-asc'].includes(sort as string)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document overview query.')
  }
  return {
    ...(query === undefined || query === '' ? {} : { query }),
    ...(type === undefined ? {} : { type: type as DocumentCatalogOverviewOptions['type'] }),
    ...(sort === undefined ? {} : { sort: sort as DocumentCatalogOverviewOptions['sort'] }),
    ...(limit === undefined ? {} : { limit: limit as number }),
    ...(cursor === undefined ? {} : { cursor }),
  }
}

function metadata(value: unknown): DocumentCatalogInput {
  const row = record(value)
  if (row === undefined || !safeRelativeId(row.docId, false) || !safeText(row.name, 255)
    || !safeText(row.mediaType, 255) || (row.directoryId !== undefined && !safeRelativeId(row.directoryId, true))
    || typeof row.bytes !== 'number' || !Number.isSafeInteger(row.bytes) || row.bytes < 0
    || typeof row.modifiedAt !== 'number' || !Number.isFinite(row.modifiedAt) || row.modifiedAt < 0) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document metadata.')
  }
  let identity: DocumentCatalogIdentity | undefined
  if (row.identity !== undefined) {
    const value = record(row.identity)
    if (value === undefined || typeof value.incarnationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.incarnationId)
      || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1
      || value.origin !== 'upload' && value.origin !== 'transfer' && value.origin !== 'legacy' && value.origin !== 'admin'
      || value.createdBy !== undefined && (typeof value.createdBy !== 'string' || !/^user:[1-9][0-9]{0,14}$/u.test(value.createdBy))) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document identity metadata.')
    }
    identity = {
      incarnationId: value.incarnationId,
      revision: value.revision,
      origin: value.origin,
      ...(value.createdBy === undefined ? {} : { createdBy: value.createdBy }),
    }
  }
  return {
    docId: row.docId,
    ...(row.directoryId === undefined ? {} : { directoryId: row.directoryId }),
    name: row.name,
    bytes: row.bytes,
    mediaType: row.mediaType,
    modifiedAt: row.modifiedAt,
    ...(identity === undefined ? {} : { identity }),
  }
}

function selection(value: unknown): DocumentCatalogSelectionInput {
  const row = record(value)
  if (row === undefined || !safeRelativeId(row.docId, false)
    || (row.incarnationId !== undefined && (typeof row.incarnationId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.incarnationId)))
    || (row.revision !== undefined && (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1))
    || (row.trashId !== undefined && (typeof row.trashId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.trashId)))
    || (row.incarnationId === undefined) !== (row.revision === undefined)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document identity selection.')
  }
  return {
    docId: row.docId,
    ...(row.incarnationId === undefined ? {} : { incarnationId: row.incarnationId as string, revision: row.revision as number }),
    ...(row.trashId === undefined ? {} : { trashId: row.trashId as string }),
  }
}

function removal(value: unknown): DocumentCatalogRemoval {
  if (typeof value === 'string') {
    if (!safeRelativeId(value, false)) throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document deletion request.')
    return { docId: value }
  }
  const row = record(value)
  if (row === undefined || (row.state !== undefined && row.state !== 'trash' && row.state !== 'missing' && row.state !== 'purged')) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document deletion request.')
  }
  const selected = selection(row)
  if (row.trashedAt !== undefined && (typeof row.trashedAt !== 'number' || !Number.isFinite(row.trashedAt) || row.trashedAt < 0)
    || row.purgeAfter !== undefined && (typeof row.purgeAfter !== 'number' || !Number.isFinite(row.purgeAfter) || row.purgeAfter < 0)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document deletion timestamp.')
  }
  return { ...selected, ...(row.state === undefined ? {} : { state: row.state }),
    ...(row.trashedAt === undefined ? {} : { trashedAt: row.trashedAt }),
    ...(row.purgeAfter === undefined ? {} : { purgeAfter: row.purgeAfter }) }
}

function projectionPosition(value: unknown): { readonly sequence: number; readonly ordinal: number } {
  const row = record(value)
  if (row === undefined || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 0
    || typeof row.ordinal !== 'number' || !Number.isSafeInteger(row.ordinal) || row.ordinal < 0
    || (row.sequence === 0) !== (row.ordinal === 0)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection position.')
  }
  return { sequence: row.sequence, ordinal: row.ordinal }
}

function projectionBatch(value: unknown): DocumentCatalogProjectionBatch {
  const row = record(value)
  if (row === undefined || typeof row.rootId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(row.rootId)
    || !Array.isArray(row.changes) || row.changes.length > 500 || typeof row.hasMore !== 'boolean') {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection batch.')
  }
  const parseChange = (input: unknown): DocumentCatalogProjectionChange => {
    const change = record(input)
    const identity = record(change?.document)
    const action = change?.action
    if (change === undefined || identity === undefined || typeof change.committedAt !== 'number'
      || !Number.isFinite(change.committedAt) || change.committedAt < 0
      || change.actor !== undefined && (typeof change.actor !== 'string' || !/^user:[1-9][0-9]{0,14}$/u.test(change.actor))
      || !['publish', 'adopt', 'trash', 'restore', 'purge', 'move', 'relocate', 'remove', 'observe', 'missing'].includes(action as string)) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection change.')
    }
    const source = metadata({
      docId: identity.docId,
      name: typeof identity.docId === 'string' ? identity.docId.split('/').at(-1) : undefined,
      bytes: identity.bytes,
      mediaType: identity.mediaType,
      modifiedAt: identity.modifiedAt,
      identity: {
        incarnationId: identity.incarnationId,
        revision: identity.revision,
        origin: identity.origin,
        ...(identity.createdBy === undefined ? {} : { createdBy: identity.createdBy }),
      },
    })
    if (identity.state !== 'active' && identity.state !== 'trash' && identity.state !== 'purged' && identity.state !== 'missing') {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection state.')
    }
    let trash: DocumentCatalogProjectionChange['document']['trash']
    if (identity.trash !== undefined) {
      const value = record(identity.trash)
      if (value === undefined || typeof value.trashId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.trashId)
        || !safeRelativeId(value.docId, false) || typeof value.trashedAt !== 'number' || !Number.isFinite(value.trashedAt)
        || typeof value.purgeAfter !== 'number' || !Number.isFinite(value.purgeAfter)) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document trash projection.')
      }
      trash = { trashId: value.trashId, docId: value.docId, trashedAt: value.trashedAt, purgeAfter: value.purgeAfter }
    }
    if (identity.state === 'trash' && trash === undefined) {
      throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Trash projection is missing its action identity.')
    }
    const currentIdentity = source.identity!
    return {
      cursor: projectionPosition(change.cursor),
      previous: projectionPosition(change.previous),
      action: action as DocumentCatalogProjectionChange['action'],
      committedAt: change.committedAt,
      ...(change.actor === undefined ? {} : { actor: change.actor as string }),
      document: {
        incarnationId: currentIdentity.incarnationId,
        revision: currentIdentity.revision,
        docId: source.docId,
        state: identity.state,
        ...(currentIdentity.createdBy === undefined ? {} : { createdBy: currentIdentity.createdBy }),
        origin: currentIdentity.origin,
        bytes: source.bytes,
        mediaType: source.mediaType,
        modifiedAt: source.modifiedAt,
        ...(trash === undefined ? {} : { trash }),
      },
    }
  }
  return {
    rootId: row.rootId,
    after: projectionPosition(row.after),
    head: projectionPosition(row.head),
    next: projectionPosition(row.next),
    changes: row.changes.map(parseChange),
    hasMore: row.hasMore,
  }
}

function serviceError(error: unknown): never {
  if (error instanceof DocumentCatalogError) throw error
  throw new DocumentCatalogError('DOCUMENT_CATALOG_UNAVAILABLE', 503, 'Document metadata catalog is unavailable.')
}

/** Create handlers backed by one PostgreSQL catalog service. */
export function createDocumentCatalogHandlers(
  catalog: Pick<PostgresDocumentCatalogService, 'sync' | 'markDeleted' | 'authorize' | 'overview' | 'history' | 'projectionCursor' | 'project'>
    & Partial<Pick<PostgresDocumentCatalogService, 'markDeletedBatch' | 'projectionOwner'>>,
  audit?: Pick<GatewayAuditService, 'write'>,
): {
  sync: RuntimeDocumentCatalogSyncHandler
  authorize: RuntimeDocumentCatalogAuthorizeHandler
  overview: RuntimeDocumentCatalogOverviewHandler
  history: RuntimeDocumentCatalogHistoryHandler
  purge: RuntimeDocumentCatalogPurgeHandler
  projection: RuntimeDocumentCatalogProjectionHandler
  projectionOwner(rootId: UserDocRootId): Promise<DocumentCatalogScope | null>
} {
  const sync: RuntimeDocumentCatalogSyncHandler = async ({ subject, principal, payload }) => {
    try {
      const value = record(payload)
      if (value?.version !== 1 || !Array.isArray(value.documents) || value.documents.length > 2000) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document catalog sync request.')
      }
      const documents = value.documents.map(metadata)
      let removed: DocumentCatalogRemoval[] | undefined
      if (value.removed !== undefined) {
        if (!Array.isArray(value.removed) || value.removed.length > 2000) {
          throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document catalog deletion request.')
        }
        removed = value.removed.map(removal)
      }
      const source = value.source
      const ownerSource = source === 'upload' || source === 'transfer' || source === 'admin' || source === 'legacy'
        ? source : 'legacy'
      await catalog.sync({
        actorUserId: principal.user.id,
        scope: currentScope(subject),
        documents,
        replace: value.replace === true,
        ownerSource,
      })
      if (removed !== undefined && removed.length > 0) {
        if (catalog.markDeletedBatch !== undefined) {
          await catalog.markDeletedBatch(principal.user.id, currentScope(subject), removed)
        } else {
          for (const item of removed) {
            if (item.state !== undefined || item.incarnationId !== undefined) {
              throw new DocumentCatalogError('DOCUMENT_CATALOG_UNAVAILABLE', 503, 'Exact document lifecycle metadata is unavailable.')
            }
            await catalog.markDeleted(principal.user.id, currentScope(subject), item.docId)
          }
        }
      }
      if (ownerSource !== 'legacy' || (removed !== undefined && removed.length > 0)) {
        await Promise.resolve(audit?.write({
          userId: principal.user.id,
          action: 'documents.catalog.sync',
          status: 200,
          detail: JSON.stringify({ source: ownerSource, count: documents.length, removed: removed?.length ?? 0 }),
        })).catch(() => {})
      }
      return { version: 1, accepted: documents.length }
    } catch (error) {
      if (error instanceof DocumentCatalogError) {
        await Promise.resolve(audit?.write({ userId: principal.user.id, action: 'documents.catalog.denied', status: error.status, detail: JSON.stringify({ code: error.code }) })).catch(() => {})
      }
      return serviceError(error)
    }
  }

  const authorize: RuntimeDocumentCatalogAuthorizeHandler = async ({ subject, principal, payload }) => {
    try {
      const value = record(payload)
      const documents = Array.isArray(value?.documents) ? value.documents.map(selection)
        : Array.isArray(value?.docIds) ? value.docIds.map(docId => selection({ docId })) : undefined
      if (value?.version !== 1 || (value.action !== 'delete' && value.action !== 'move' && value.action !== 'ownership'
        && value.action !== 'restore' && value.action !== 'purge')
        || documents === undefined || documents.length === 0 || documents.length > 2000) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document authorization request.')
      }
      const authorized = await catalog.authorize({
        actorUserId: principal.user.id,
        scope: currentScope(subject),
        action: value.action,
        documents,
        administrator: principal.purpose === 'document-admin' && principal.user.role === 'admin',
      })
      return { version: 1, ...authorized }
    } catch (error) {
      if (error instanceof DocumentCatalogError) {
        await Promise.resolve(audit?.write({ userId: principal.user.id, action: 'documents.catalog.denied', status: error.status, detail: JSON.stringify({ code: error.code }) })).catch(() => {})
      }
      return serviceError(error)
    }
  }

  const overview: RuntimeDocumentCatalogOverviewHandler = async ({ principal, options }) => {
    try {
      return await catalog.overview(principal.user.id, parseDocumentOverviewOptions(options))
    } catch (error) {
      return serviceError(error)
    }
  }
  const history: RuntimeDocumentCatalogHistoryHandler = async ({ subject, principal }) => {
    try {
      const scope = subject.target.kind === 'user'
        ? { kind: 'personal' as const, userId: subject.target.id }
        : { kind: 'project' as const, projectId: subject.target.id }
      const items = await catalog.history(principal.user.id, scope)
      return { version: 1, items }
    } catch (error) {
      return serviceError(error)
    }
  }
  const purge: RuntimeDocumentCatalogPurgeHandler = async ({ subject, principal, payload }) => {
    try {
      const value = record(payload)
      if (value?.version !== 1 || !Array.isArray(value.documents) || value.documents.length === 0
        || value.documents.length > 50) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document purge request.')
      }
      if (catalog.markDeletedBatch === undefined) {
        throw new DocumentCatalogError('DOCUMENT_CATALOG_UNAVAILABLE', 503, 'Exact document lifecycle metadata is unavailable.')
      }
      const scope = currentScope(subject)
      const removals = value.documents.map((item): DocumentCatalogRemoval => {
        const selected = selection(item)
        if (selected.incarnationId === undefined || selected.revision === undefined || selected.trashId === undefined) {
          throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'A purge requires an exact trash action identity.')
        }
        return { ...selected, revision: selected.revision + 1, state: 'purged' }
      })
      await catalog.markDeletedBatch(principal.user.id, scope, removals)
      return { version: 1, accepted: removals.length }
    } catch (error) {
      return serviceError(error)
    }
  }
  const projection: RuntimeDocumentCatalogProjectionHandler = async ({ subject, principal, payload }) => {
    try {
      const value = record(payload)
      if (value?.version !== 1 || typeof value.rootId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value.rootId)) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document projection request.')
      }
      const scope = currentScope(subject)
      const administrator = principal.purpose === 'document-admin' && principal.user.role === 'admin'
      let cursor: { readonly sequence: number; readonly ordinal: number }
      if (value.batch === undefined) {
        cursor = await catalog.projectionCursor(principal.user.id, scope, value.rootId, administrator)
      } else {
        const batch = projectionBatch(value.batch)
        if (batch.rootId !== value.rootId) throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Projection root does not match its request.')
        cursor = await catalog.project(principal.user.id, scope, batch, administrator)
      }
      return { version: 1, cursor }
    } catch (error) {
      return serviceError(error)
    }
  }
  return { sync, authorize, overview, history, purge, projection,
    async projectionOwner(rootId) {
      if (catalog.projectionOwner === undefined) {
        throw new DocumentCatalogError('DOCUMENT_CATALOG_UNAVAILABLE', 503, 'Document scope ownership is unavailable.')
      }
      try { return await catalog.projectionOwner(rootId) } catch (error) { serviceError(error) }
    },
  }
}

/** Parse a public project scope selector for future plan/commit callers. */
export function publicProjectScope(value: unknown): { kind: 'project'; projectId: number } {
  const row = record(value)
  if (row?.kind !== 'project' || !positiveInteger(row.projectId)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid project document scope.')
  }
  return { kind: 'project', projectId: row.projectId }
}
