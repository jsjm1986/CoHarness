/** Decode the authenticated HTML input used only to pin one browser document's requests. */
import type { ClientRuntimeId, ClientRuntimeTarget } from '@deepseek-ai/dsh-host-apiproxy/api'

/** Account and initial Runtime authenticated by the current HTML response. */
export interface ConnectionDocumentIdentity {
  /** Authenticated Gateway account; used only to pin requests and namespace browser state. */
  readonly principalId: number
  /** Runtime selected by this HTML response, independently of later scope-cookie changes. */
  readonly runtimeTarget: ClientRuntimeTarget
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Parse the Gateway's document-owned account and Runtime input without accepting credentials or permissions.
 * @param value - the JSON value delivered with this HTML response; absence retains describe-first admission.
 * @returns a detached identity for the connection fence, or undefined when the page supplied none.
 * @throws when present input has an unsupported version or invalid fields.
 */
export function parseDocumentIdentity(value: unknown): ConnectionDocumentIdentity | undefined {
  if (value === undefined) return undefined
  if (!record(value) || value.version !== 1 || !positiveId(value.principalId)
    || Object.keys(value).some(key => !['version', 'principalId', 'runtimeTarget'].includes(key))) {
    throw new Error('Connection document identity requires version 1, a positive principalId and a runtimeTarget')
  }
  const target = value.runtimeTarget
  if (!record(target)) {
    throw new Error('Connection document runtimeTarget requires personal or project with a positive projectId')
  }
  if (target.runtimeId !== undefined && (typeof target.runtimeId !== 'string' || target.runtimeId === '')) {
    throw new Error('Connection document runtimeTarget requires personal or project with a positive projectId')
  }
  const location = target.runtimeId === undefined ? {} : { runtimeId: target.runtimeId as ClientRuntimeId }
  if (target.kind === 'personal' && Object.keys(target).every(key => key === 'kind' || key === 'runtimeId')) {
    return { principalId: value.principalId, runtimeTarget: { kind: 'personal', ...location } }
  }
  if (target.kind === 'project' && positiveId(target.projectId)
    && Object.keys(target).every(key => ['kind', 'projectId', 'runtimeId'].includes(key))) {
    return { principalId: value.principalId, runtimeTarget: { kind: 'project', projectId: target.projectId, ...location } }
  }
  throw new Error('Connection document runtimeTarget requires personal or project with a positive projectId')
}
