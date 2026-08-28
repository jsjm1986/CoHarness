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
export type DocumentsWorkspaceScope =
  | { kind: 'personal'; projects?: readonly DocumentsProjectScope[] }
  | {
    kind: 'project'
    projectName: string
    projectId?: number
    mode?: 'ro' | 'rw'
    projects?: readonly DocumentsProjectScope[]
  }

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
  if (scope === null || typeof scope !== 'object') return { kind: 'personal' }
  if (!('kind' in scope) || scope.kind !== 'project') return projects.length === 0 ? { kind: 'personal' } : { kind: 'personal', projects }
  if (!('projectName' in scope) || typeof scope.projectName !== 'string' || scope.projectName === ''
    || scope.projectName.length > 200 || /[\u0000-\u001f\u007f]/u.test(scope.projectName)) {
    return projects.length === 0 ? { kind: 'personal' } : { kind: 'personal', projects }
  }
  const projectId = 'projectId' in scope && typeof scope.projectId === 'number'
    && Number.isSafeInteger(scope.projectId) && scope.projectId > 0 ? scope.projectId : undefined
  const mode = 'mode' in scope && (scope.mode === 'ro' || scope.mode === 'rw') ? scope.mode : undefined
  return {
    kind: 'project',
    projectName: scope.projectName,
    ...(projectId === undefined ? {} : { projectId }),
    ...(mode === undefined ? {} : { mode }),
    ...(projects.length === 0 ? {} : { projects }),
  }
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
