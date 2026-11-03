/** Browser HTTP client for the optional Host user-document service. */
import type {
  UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryPage,
  UserDocDirectoryRef,
  UserDocIdType,
  UserDocLimits,
  UserDocListQuery,
  UserDocTrashRef,
  UserDocRef,
  UserDocScope,
  UserDocTransferRequest,
  UserDocTransferCapabilities,
  UserDocTransferListResponse,
  UserDocTransferDirectoriesResponse,
  UserDocTransferListedDocument,
  UserDocTransferResponse,
  UserDocTransferPlanResponse,
  UserDocTransferTargetRef,
  UserDocCatalogHistory,
  UserDocCatalogHistoryItem,
  UserDocCatalogMetrics,
  UserDocCatalogOverview,
  UserDocCatalogRow,
  UserDocLocationPage,
  UserDocScope as DocumentScope,
} from '@deepseek-ai/dsh-userdoc'
import {
  createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError,
  type UserDocUploadPhase,
} from './userdoc-client.ts'
import { readApiResponseJson } from '@deepseek-ai/dsh-client-runtime/client'

export type {
  UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryPage,
  UserDocDirectoryRef,
  UserDocIdType,
  UserDocLimits,
  UserDocListQuery,
  UserDocTrashRef,
  UserDocRef,
  UserDocTransferRequest,
  UserDocTransferResponse,
  UserDocTransferPlanResponse,
  UserDocTransferCapabilities,
  UserDocTransferListResponse,
  UserDocTransferDirectoriesResponse,
  UserDocTransferListedDocument,
  UserDocScope,
  UserDocTransferTargetRef,
  UserDocCatalogRow,
  UserDocCatalogMetrics,
  UserDocCatalogOverview,
  UserDocCatalogHistory,
  UserDocCatalogHistoryItem,
  UserDocUploadPhase,
}

/** Result of reading the optional account scope route without hiding outages. */
export interface DocumentsScopeReadResult {
  readonly scope: DocumentsWorkspaceScope
  /** True when the response was valid; false means the scope is stale/unavailable. */
  readonly available: boolean
}

export { createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError }

/** Runtime scope shown in the document manager title and delete warning. */
export type DocumentsWorkspaceScope = (
  | { kind: 'personal'; projects?: readonly DocumentsProjectScope[] }
  | {
    kind: 'project'
    projectName: string
    projectId?: number
    mode?: 'ro' | 'rw'
    projects?: readonly DocumentsProjectScope[]
  }
) & { readonly nodeId?: DocumentScope['nodeId']; readonly nodeName?: string; readonly accountId?: number }

/** Project target advertised by the Gateway account context. */
export interface DocumentsProjectScope {
  readonly projectId: number
  readonly name: string
  readonly mode: 'ro' | 'rw'
}

/**
 * Decode a Gateway account-context payload for document-manager chrome.
 * Unknown or personal payloads resolve to personal so a missing collaboration
 * route never blocks the manager.
 * @param value - parsed JSON from `GET /account/api/context`.
 * @returns personal scope, or a project name when `scope.kind` is `project`.
 */
export function parseDocumentsScope(value: unknown): DocumentsWorkspaceScope {
  if (value === null || typeof value !== 'object') return { kind: 'personal' }
  if (!('scope' in value)) return { kind: 'personal' }
  const projects = 'projects' in value && Array.isArray(value.projects)
    ? value.projects.flatMap((candidate): DocumentsProjectScope[] => {
      if (candidate === null || typeof candidate !== 'object') return []
      const item = candidate as { projectId?: unknown; name?: unknown; mode?: unknown }
      return typeof item.projectId === 'number' && Number.isSafeInteger(item.projectId) && item.projectId > 0
        && typeof item.name === 'string' && item.name !== '' && item.name.length <= 200
        && !/[\u0000-\u001f\u007f]/u.test(item.name)
        && (item.mode === 'ro' || item.mode === 'rw')
        ? [{ projectId: item.projectId, name: item.name, mode: item.mode }]
        : []
    }).slice(0, 200)
    : []
  const scope = value.scope
  const environment = 'environment' in value && typeof value.environment === 'object' && value.environment !== null ? value.environment : undefined
  const nodeId = environment !== undefined && 'nodeId' in environment && typeof environment.nodeId === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(environment.nodeId)
    ? environment.nodeId as NonNullable<DocumentScope['nodeId']> : undefined
  const user = 'user' in value && typeof value.user === 'object' && value.user !== null ? value.user : undefined
  const accountId = user !== undefined && 'id' in user && typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0 ? user.id : undefined
  const location = { ...(accountId === undefined ? {} : { accountId }), ...nodeId === undefined ? {} : { nodeId,
    ...(environment !== undefined && 'nodeName' in environment && typeof environment.nodeName === 'string' ? { nodeName: environment.nodeName } : {}) },
  }
  if (scope === null || typeof scope !== 'object') return { kind: 'personal' }
  if (!('kind' in scope) || scope.kind !== 'project') return projects.length === 0 ? { kind: 'personal', ...location } : { kind: 'personal', projects, ...location }
  if (!('projectName' in scope) || typeof scope.projectName !== 'string' || scope.projectName === ''
    || scope.projectName.length > 200 || /[\u0000-\u001f\u007f]/u.test(scope.projectName)) {
    return projects.length === 0 ? { kind: 'personal' } : { kind: 'personal', projects }
  }
  const projectId = 'projectId' in scope && typeof scope.projectId === 'number'
    && Number.isSafeInteger(scope.projectId) && scope.projectId > 0 ? scope.projectId : undefined
  const mode = 'mode' in scope && (scope.mode === 'ro' || scope.mode === 'rw') ? scope.mode : undefined
  return {
    kind: 'project',
    ...location,
    projectName: scope.projectName,
    ...(projectId === undefined ? {} : { projectId }),
    ...(mode === undefined ? {} : { mode }),
    ...(projects.length === 0 ? {} : { projects }),
  }
}

/**
 * Read a bounded directory of document locations without opening any Runtime.
 * @param signal - component-owned cancellation.
 * @param cursor - continuation from the displayed page.
 * @returns a page, or undefined for independent Hosts without a Gateway directory.
 */
export async function readDocumentLocations(signal: AbortSignal, cursor?: string): Promise<UserDocLocationPage | undefined> {
  const response = await fetch(`/account/api/document-locations${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { signal, cache: 'no-store' })
  if ([404, 501].includes(response.status)) return undefined
  if (!response.ok) throw new Error('Document locations are unavailable')
  const body = await readApiResponseJson(response) as { items?: unknown; nextCursor?: unknown }
  if (!Array.isArray(body.items) || body.nextCursor !== null && typeof body.nextCursor !== 'string') throw new Error('Invalid document locations')
  const items: UserDocLocationPage['items'] = body.items.map((value) => {
    if (typeof value !== 'object' || value === null) throw new Error('Invalid document location')
    const row = value as Record<string, unknown>, scope = row.scope as Record<string, unknown> | undefined
    if (scope === undefined || !['personal', 'project'].includes(String(scope.kind)) || typeof scope.nodeId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(scope.nodeId)
      || scope.kind === 'project' && (typeof scope.projectId !== 'number' || !Number.isSafeInteger(scope.projectId) || scope.projectId < 1)
      || typeof row.name !== 'string' || typeof row.nodeName !== 'string' || row.mode !== 'ro' && row.mode !== 'rw') throw new Error('Invalid document location')
    const location = { nodeId: scope.nodeId as NonNullable<DocumentScope['nodeId']>, nodeName: row.nodeName }
    return { name: row.name, nodeName: row.nodeName, mode: row.mode,
      scope: scope.kind === 'personal' ? { kind: 'personal' as const, ...location }
        : { kind: 'project' as const, projectId: scope.projectId as number, ...location } }
  })
  return { items, nextCursor: body.nextCursor as string | null }
}

/**
 * Load the current runtime scope for manager chrome.
 * @param signal - aborts the request when the modal unmounts.
 * @returns the decoded scope and whether the account route was available.
 */
export async function readDocumentsScopeResult(signal?: AbortSignal): Promise<DocumentsScopeReadResult> {
  return (async (): Promise<DocumentsScopeReadResult> => {
    try {
      const response = await fetch('/account/api/context', signal === undefined
        ? { cache: 'no-store' }
        : { cache: 'no-store', signal })
      if (!response.ok) return { scope: { kind: 'personal' }, available: false }
      const result = { scope: parseDocumentsScope(await readApiResponseJson(response)), available: true }
      return result
    } catch (error) {
      if (signal?.aborted) throw error
      // Missing collaboration route or a temporary network failure must not erase
      // the last known project list in an already-open manager.
      return { scope: { kind: 'personal' }, available: false }
    }
  })()
}

/**
 * Load the current runtime scope while preserving the legacy fail-open helper.
 * @param signal - aborts the request when the manager unmounts.
 * @returns the decoded scope; callers that need outage state should use {@link readDocumentsScopeResult}.
 */
export async function readDocumentsScope(signal?: AbortSignal): Promise<DocumentsWorkspaceScope> {
  return (await readDocumentsScopeResult(signal)).scope
}
