import { readApiResponseJson } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionRuntimeTarget, SessionId } from '@deepseek-ai/dsh-client-runtime/client'

/** Account-wide conversation metadata returned by the Gateway catalog. */
export interface WorkbenchConversation {
  sessionId: SessionId
  runtime: SessionRuntimeTarget & { readonly projectName?: string }
  title?: string
  cwd?: string
  visibility: 'personal' | 'project' | 'private'
  creatorUserId: number
  creatorDisplayName: string
  updatedAt: number
  blank: boolean
  visibleContentSeq?: number
  lastPromptAt?: number
  canWrite: boolean
}

/** ACL-filtered account conversation directory response. */
export interface WorkbenchCatalog {
  personal: { id: number; name: string }
  activeRuntime: SessionRuntimeTarget
  projects: readonly { projectId: number; name: string; mode: 'ro' | 'rw' }[]
  items: readonly WorkbenchConversation[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid workbench catalog')
  return value as Record<string, unknown>
}

/** Parse the bounded browser catalog without trusting its target identifiers.
 * @param value - decoded catalog candidate.
 * @returns validated catalog projection.
 */
export function parseWorkbenchCatalog(value: unknown): WorkbenchCatalog {
  const root = object(value)
  const personal = object(root.personal)
  const activeRuntime = object(root.activeRuntime)
  if (typeof personal.id !== 'number' || !Number.isSafeInteger(personal.id) || personal.id <= 0
    || typeof personal.name !== 'string' || (activeRuntime.kind !== 'personal'
      && (activeRuntime.kind !== 'project' || typeof activeRuntime.projectId !== 'number'
        || !Number.isSafeInteger(activeRuntime.projectId) || activeRuntime.projectId <= 0))
    || !Array.isArray(root.projects) || !Array.isArray(root.items)) {
    throw new Error('invalid workbench catalog')
  }
  const projects = root.projects.map<WorkbenchCatalog['projects'][number]>((candidate) => {
    const row = object(candidate)
    if (typeof row.projectId !== 'number' || !Number.isSafeInteger(row.projectId) || row.projectId <= 0
      || typeof row.name !== 'string' || (row.mode !== 'ro' && row.mode !== 'rw')) throw new Error('invalid workbench project')
    return { projectId: row.projectId, name: row.name, mode: row.mode }
  })
  const items = root.items.map((candidate) => {
    const row = object(candidate)
    const runtime = object(row.runtime)
    if (typeof row.sessionId !== 'string' || row.sessionId === ''
      || (runtime.kind !== 'personal' && runtime.kind !== 'project')
      || (runtime.kind === 'project' && (typeof runtime.projectId !== 'number' || !Number.isSafeInteger(runtime.projectId) || runtime.projectId <= 0 || typeof runtime.projectName !== 'string'))
      || (row.title !== undefined && typeof row.title !== 'string')
      || (row.cwd !== undefined && typeof row.cwd !== 'string')
      || (row.visibility !== 'personal' && row.visibility !== 'project' && row.visibility !== 'private')
      || typeof row.creatorUserId !== 'number' || !Number.isSafeInteger(row.creatorUserId)
      || typeof row.creatorDisplayName !== 'string' || typeof row.updatedAt !== 'number'
      || typeof row.blank !== 'boolean' || typeof row.canWrite !== 'boolean') throw new Error('invalid workbench conversation')
    return row as unknown as WorkbenchConversation
  })
  return { personal: { id: personal.id, name: personal.name }, activeRuntime: activeRuntime as SessionRuntimeTarget, projects, items }
}

/** Fetch the authenticated account's ACL-filtered conversation directory.
 * @param signal - optional request cancellation.
 * @returns the validated catalog projection.
 */
export async function loadWorkbenchCatalog(signal?: AbortSignal): Promise<WorkbenchCatalog> {
  const response = await fetch('/account/api/workbench/catalog', {
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`workbench catalog unavailable (${String(response.status)})`)
  return parseWorkbenchCatalog(await readApiResponseJson(response))
}
