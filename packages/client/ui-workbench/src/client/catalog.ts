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
  /** Whether the personal runtime's Session and archive directories were both read successfully. */
  personalComplete: boolean
  /** Only the selected Runtime's bounded pages have been read. */
  paged?: boolean
  /** Other granted conversations may be outside the currently loaded search scope. */
  scopePartial?: boolean
  nextCursor?: string | null
  moreComputers?: boolean
  activeRuntime: SessionRuntimeTarget
  projects: readonly ({ projectId: number; name: string; mode: 'ro' | 'rw' }
    & Pick<SessionRuntimeTarget, 'nodeId' | 'nodeName' | 'runtimeId'>)[]
  items: readonly WorkbenchConversation[]
  /** Allocated personal environments visible at this Gateway, including stopped Runtimes. */
  personalRuntimes?: readonly Extract<SessionRuntimeTarget, { kind: 'personal' }>[]
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid workbench catalog')
  return value as Record<string, unknown>
}

function validateLocation(target: Record<string, unknown>): void {
  for (const key of ['runtimeId', 'nodeId']) {
    const value = target[key]
    if (value !== undefined && (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value))) throw new Error('invalid workbench environment')
  }
  if (target.nodeName !== undefined && typeof target.nodeName !== 'string') throw new Error('invalid workbench computer')
}

/** Parse the bounded browser catalog without trusting its target identifiers.
 * @param value - decoded catalog candidate.
 * @returns validated catalog projection.
 */
export function parseWorkbenchCatalog(value: unknown): WorkbenchCatalog {
  const root = object(value)
  const personal = object(root.personal)
  const activeRuntime = object(root.activeRuntime)
  validateLocation(activeRuntime)
  if (typeof personal.id !== 'number' || !Number.isSafeInteger(personal.id) || personal.id <= 0
    || typeof personal.name !== 'string' || (activeRuntime.kind !== 'personal'
      && (activeRuntime.kind !== 'project' || typeof activeRuntime.projectId !== 'number'
        || !Number.isSafeInteger(activeRuntime.projectId) || activeRuntime.projectId <= 0))
    || typeof root.personalComplete !== 'boolean' || !Array.isArray(root.projects) || !Array.isArray(root.items)) {
    throw new Error('invalid workbench catalog')
  }
  const projects = root.projects.map<WorkbenchCatalog['projects'][number]>((candidate) => {
    const row = object(candidate)
    validateLocation(row)
    if (typeof row.projectId !== 'number' || !Number.isSafeInteger(row.projectId) || row.projectId <= 0
      || typeof row.name !== 'string' || (row.mode !== 'ro' && row.mode !== 'rw')) throw new Error('invalid workbench project')
    return { projectId: row.projectId, name: row.name, mode: row.mode,
      ...(row.runtimeId === undefined ? {} : { runtimeId: row.runtimeId as NonNullable<SessionRuntimeTarget['runtimeId']> }),
      ...(row.nodeId === undefined ? {} : { nodeId: row.nodeId as NonNullable<SessionRuntimeTarget['nodeId']> }),
      ...(row.nodeName === undefined ? {} : { nodeName: row.nodeName as string }),
    }
  })
  const items = root.items.map((candidate) => {
    const row = object(candidate)
    const runtime = object(row.runtime)
    validateLocation(runtime)
    if (typeof row.sessionId !== 'string' || row.sessionId === ''
      || (runtime.kind !== 'personal' && runtime.kind !== 'project')
      || (runtime.kind === 'project' && (typeof runtime.projectId !== 'number' || !Number.isSafeInteger(runtime.projectId) || runtime.projectId <= 0 || typeof runtime.projectName !== 'string'))
      || (row.title !== undefined && typeof row.title !== 'string')
      || (row.cwd !== undefined && typeof row.cwd !== 'string')
      || (row.visibility !== 'personal' && row.visibility !== 'project' && row.visibility !== 'private')
      || typeof row.creatorUserId !== 'number' || !Number.isSafeInteger(row.creatorUserId) || row.creatorUserId <= 0
      || typeof row.creatorDisplayName !== 'string' || typeof row.updatedAt !== 'number'
      || !Number.isFinite(row.updatedAt) || row.updatedAt < 0
      || (row.visibleContentSeq !== undefined && (typeof row.visibleContentSeq !== 'number'
        || !Number.isSafeInteger(row.visibleContentSeq) || row.visibleContentSeq < 0))
      || (row.lastPromptAt !== undefined && (typeof row.lastPromptAt !== 'number'
        || !Number.isFinite(row.lastPromptAt) || row.lastPromptAt < 0))
      || typeof row.blank !== 'boolean' || typeof row.canWrite !== 'boolean') throw new Error('invalid workbench conversation')
    return row as unknown as WorkbenchConversation
  })
  let personalRuntimes: WorkbenchCatalog['personalRuntimes']
  if (root.personalWorkspaces !== undefined) {
    if (!Array.isArray(root.personalWorkspaces)) throw new Error('invalid workbench personal environments')
    personalRuntimes = root.personalWorkspaces.map((candidate) => {
      const runtime = object(object(candidate).runtime)
      validateLocation(runtime)
      if (runtime.kind !== 'personal' || typeof runtime.runtimeId !== 'string'
        || typeof runtime.nodeId !== 'string' || typeof runtime.nodeName !== 'string') throw new Error('invalid workbench personal environment')
      return runtime as unknown as Extract<SessionRuntimeTarget, { kind: 'personal' }>
    })
  }
  return { personal: { id: personal.id, name: personal.name }, personalComplete: root.personalComplete,
    ...(typeof root.scopePartial === 'boolean' ? { scopePartial: root.scopePartial } : {}),
    ...(root.paged === true ? { paged: true, moreComputers: typeof root.computerCursor === 'string', nextCursor: typeof root.nextCursor === 'string' ? root.nextCursor : null } : {}),
    activeRuntime: activeRuntime as unknown as SessionRuntimeTarget, projects, items,
    ...(personalRuntimes === undefined ? {} : { personalRuntimes }) }
}

/** Fetch the authenticated account's ACL-filtered conversation directory.
 * @param signal - optional request cancellation.
 * @returns the validated catalog projection.
 */
export async function loadWorkbenchCatalog(signal?: AbortSignal): Promise<WorkbenchCatalog> {
  const current = new URLSearchParams(typeof location === 'undefined' ? '' : location.search)
  const selection = new URLSearchParams()
  for (const key of ['dshRuntime', 'dshTarget']) {
    const value = current.get(key)
    if (value !== null) selection.set(key, value)
  }
  const query = selection.toString()
  const response = await fetch(`/account/api/workbench/catalog${query === '' ? '' : `?${query}`}`, {
    headers: { accept: 'application/json' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`workbench catalog unavailable (${String(response.status)})`)
  return parseWorkbenchCatalog(await readApiResponseJson(response))
}
