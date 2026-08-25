/** Browser HTTP client for the optional Host user-document service. */
import type {
  UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocIdType,
  UserDocLimits,
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

export type {
  UserDocDirectoryIdType,
  UserDocDirectoryListing,
  UserDocDirectoryRef,
  UserDocIdType,
  UserDocLimits,
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
        && typeof item.name === 'string' && item.name !== ''
        && (item.mode === 'ro' || item.mode === 'rw')
        ? [{ projectId: item.projectId, name: item.name, mode: item.mode }]
        : []
    })
    : []
  const scope = value.scope
  if (scope === null || typeof scope !== 'object') return { kind: 'personal' }
  if (!('kind' in scope) || scope.kind !== 'project') return projects.length === 0 ? { kind: 'personal' } : { kind: 'personal', projects }
  if (!('projectName' in scope) || typeof scope.projectName !== 'string' || scope.projectName === '') {
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
 * Fail-open: a missing collaboration route, HTTP error, or invalid JSON is personal.
 * @param signal - aborts the request when the modal unmounts.
 * @returns personal scope unless the Gateway reports a named project.
 */
export async function readDocumentsScope(signal?: AbortSignal): Promise<DocumentsWorkspaceScope> {
  try {
    const response = await fetch('/account/api/context', signal === undefined ? {} : { signal })
    if (!response.ok) return { kind: 'personal' }
    return parseDocumentsScope(await response.json() as unknown)
  } catch (_accountContextUnavailable) {
    // Missing collaboration route, abort, or non-JSON body: keep personal chrome.
    return { kind: 'personal' }
  }
}
