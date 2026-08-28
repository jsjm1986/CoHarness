/** Runtime wire handlers for the organization document metadata catalog. */

import type { GatewayPrincipalClaims } from './principal.ts'
import type { GatewayAuditService } from './services.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import {
  DocumentCatalogError,
  type DocumentCatalogInput,
  type DocumentCatalogScope,
  type DocumentCatalogOverviewOptions,
  type PostgresDocumentCatalogService,
} from './postgres/document-catalog-service.ts'

export { DocumentCatalogError } from './postgres/document-catalog-service.ts'

/** Runtime callback consumed by the authenticated loopback API. */
export interface RuntimeDocumentCatalogSyncHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
  }): Promise<{ readonly version: 1; readonly accepted: number }>
}

/** Runtime callback marking permanently purged document metadata. */
export interface RuntimeDocumentCatalogPurgeHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
  }): Promise<{ readonly version: 1; readonly accepted: number }>
}

/** Runtime callback for ownership-aware document mutations. */
export interface RuntimeDocumentCatalogAuthorizeHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly payload: unknown
  }): Promise<{ readonly version: 1; readonly allowed: true }>
}

/** Runtime callback for the metadata-only all-scope overview. */
export interface RuntimeDocumentCatalogOverviewHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
    readonly options?: unknown
  }): Promise<unknown>
}

/** Runtime callback for recent current-scope document operations. */
export interface RuntimeDocumentCatalogHistoryHandler {
  (input: {
    readonly subject: RuntimeCredentialSubject
    readonly principal: GatewayPrincipalClaims
  }): Promise<{ readonly version: 1; readonly items: readonly unknown[] }>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function currentScope(subject: RuntimeCredentialSubject): DocumentCatalogScope {
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

function overviewOptions(value: unknown): DocumentCatalogOverviewOptions {
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
  return {
    docId: row.docId,
    ...(row.directoryId === undefined ? {} : { directoryId: row.directoryId }),
    name: row.name,
    bytes: row.bytes,
    mediaType: row.mediaType,
    modifiedAt: row.modifiedAt,
  }
}

function serviceError(error: unknown): never {
  if (error instanceof DocumentCatalogError) throw error
  throw new DocumentCatalogError('DOCUMENT_CATALOG_UNAVAILABLE', 503, 'Document metadata catalog is unavailable.')
}

/** Create handlers backed by one PostgreSQL catalog service. */
export function createDocumentCatalogHandlers(
  catalog: Pick<PostgresDocumentCatalogService, 'sync' | 'markDeleted' | 'authorize' | 'overview' | 'history'>
    & Partial<Pick<PostgresDocumentCatalogService, 'markDeletedBatch' | 'markPurged'>>,
  audit?: Pick<GatewayAuditService, 'write'>,
): {
  sync: RuntimeDocumentCatalogSyncHandler
  authorize: RuntimeDocumentCatalogAuthorizeHandler
  overview: RuntimeDocumentCatalogOverviewHandler
  history: RuntimeDocumentCatalogHistoryHandler
  purge: RuntimeDocumentCatalogPurgeHandler
} {
  const sync: RuntimeDocumentCatalogSyncHandler = async ({ subject, principal, payload }) => {
    try {
      const value = record(payload)
      if (value?.version !== 1 || !Array.isArray(value.documents) || value.documents.length > 2000) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document catalog sync request.')
      }
      const documents = value.documents.map(metadata)
      let removed: string[] | undefined
      if (value.removed !== undefined) {
        if (!Array.isArray(value.removed) || value.removed.length > 2000
          || !value.removed.every(item => safeRelativeId(item, false))) {
          throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document catalog deletion request.')
        }
        removed = [...value.removed]
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
          for (const docId of removed) await catalog.markDeleted(principal.user.id, currentScope(subject), docId)
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
      if (value?.version !== 1 || (value.action !== 'delete' && value.action !== 'move' && value.action !== 'ownership'
        && value.action !== 'restore' && value.action !== 'purge')
        || !Array.isArray(value.docIds) || value.docIds.length === 0 || value.docIds.length > 50
        || !value.docIds.every(item => safeRelativeId(item, false))) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document authorization request.')
      }
      await catalog.authorize({
        actorUserId: principal.user.id,
        scope: currentScope(subject),
        action: value.action,
        docIds: value.docIds,
      })
      return { version: 1, allowed: true }
    } catch (error) {
      if (error instanceof DocumentCatalogError) {
        await Promise.resolve(audit?.write({ userId: principal.user.id, action: 'documents.catalog.denied', status: error.status, detail: JSON.stringify({ code: error.code }) })).catch(() => {})
      }
      return serviceError(error)
    }
  }

  const overview: RuntimeDocumentCatalogOverviewHandler = async ({ principal, options }) => {
    try {
      return await catalog.overview(principal.user.id, overviewOptions(options))
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
      if (value?.version !== 1 || !Array.isArray(value.docIds) || value.docIds.length === 0
        || value.docIds.length > 50 || !value.docIds.every(item => safeRelativeId(item, false))) {
        throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid document purge request.')
      }
      const scope = currentScope(subject)
      for (const docId of value.docIds) {
        if (catalog.markPurged === undefined) throw new DocumentCatalogError('DOCUMENT_CATALOG_UNAVAILABLE', 503, 'Document purge metadata is unavailable.')
        await catalog.markPurged(principal.user.id, scope, docId)
      }
      return { version: 1, accepted: value.docIds.length }
    } catch (error) {
      return serviceError(error)
    }
  }
  return { sync, authorize, overview, history, purge }
}

/** Parse a public project scope selector for future plan/commit callers. */
export function publicProjectScope(value: unknown): { kind: 'project'; projectId: number } {
  const row = record(value)
  if (row?.kind !== 'project' || !positiveInteger(row.projectId)) {
    throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA', 400, 'Invalid project document scope.')
  }
  return { kind: 'project', projectId: row.projectId }
}
