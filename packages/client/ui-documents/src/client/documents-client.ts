/** Browser HTTP client for the optional Host user-document service. */
import type { UserDocIdType, UserDocLimits, UserDocRef } from '@deepseek-ai/dsh-userdoc'
import { createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError } from './userdoc-client.ts'

export type { UserDocIdType, UserDocLimits, UserDocRef }

export { createUserDocClient, UserDocHttpError, UserDocServiceUnavailableError }

/** Runtime scope shown in the document manager title and delete warning. */
export type DocumentsWorkspaceScope =
  | { kind: 'personal' }
  | { kind: 'project'; projectName: string }

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
  const scope = value.scope
  if (scope === null || typeof scope !== 'object') return { kind: 'personal' }
  if (!('kind' in scope) || scope.kind !== 'project') return { kind: 'personal' }
  if (!('projectName' in scope) || typeof scope.projectName !== 'string' || scope.projectName === '') {
    return { kind: 'personal' }
  }
  return { kind: 'project', projectName: scope.projectName }
}

/**
 * Load the current runtime scope for manager chrome.
 * Fail-open: a missing collaboration route, HTTP error, or invalid JSON is personal.
 * @param signal - aborts the request when the modal unmounts.
 * @returns personal scope unless the Gateway reports a named project.
 */
export async function readDocumentsScope(signal?: AbortSignal): Promise<DocumentsWorkspaceScope> {
  try {
    const response = await fetch('/account/api/context', { signal })
    if (!response.ok) return { kind: 'personal' }
    return parseDocumentsScope(await response.json() as unknown)
  } catch (_accountContextUnavailable) {
    // Missing collaboration route, abort, or non-JSON body: keep personal chrome.
    return { kind: 'personal' }
  }
}
