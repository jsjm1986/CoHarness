import { nodeContentHealthSchema, type NodeContentHealth } from '../../src/node-content-health.ts'
import { deploymentContextSchema, deploymentCandidatesSchema, deploymentPreflightSchema, nodeConnectionViewSchema, type DeploymentContext, type DeploymentPreflight } from '../../src/deployment-protocol.ts'
import type { NodeConnectionView } from '../../src/deployment-protocol.ts'
import { parseConversationSessionIdentity, type ConversationSessionIdentity } from '../../src/session-identity.ts'
export type { ConversationSessionIdentity } from '../../src/session-identity.ts'
import { parseConversationArchiveId, type ConversationArchiveId } from '../../src/archive-identity.ts'
import type { RuntimeId, RuntimeNodeId } from '../../src/runtime-catalog.ts'
export type { ConversationArchiveId } from '../../src/archive-identity.ts'
import { adminComputerRequestUrl, adminComputerTarget } from './computer-target.ts'
import { computerErrorMessage } from './computer.copy.ts'
import type { DesktopEnvironment } from '@deepseek-ai/dsh-native-command'
export type { DesktopEnvironment } from '@deepseek-ai/dsh-native-command'

/** Read desktop-session evidence from this Admin document's selected computer without starting a Runtime. */
export function getDesktopEnvironment(signal?: AbortSignal): Promise<DesktopEnvironment> {
  return request('/admin/api/desktop-environment', { cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
}

export type AdminUser = {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  homePath: string
  mustChangePassword: boolean
  autoReviewEligible: boolean
  port: number | null
  instanceState: string
  runtimeCount?: number
  homeNodeId?: import('../../src/runtime-catalog.ts').RuntimeNodeId
}

export type Project = {
  metadataOnNode?: true
  nodeId?: RuntimeNodeId
  runtimeId?: RuntimeId
  ownerDisplayLoaded?: true
  id: number
  name: string
  path: string
  memberCount: number
  origin?: 'admin' | 'user'
  modelAccessDefaultAllowed?: boolean
  owner?: { id: number; username: string; displayName: string } | null
  createdBy?: { id: number; username: string; displayName: string } | null
  uiThemePolicy?: 'follow-user' | 'light' | 'dark'
}

export type GrantMode = 'ro' | 'rw'

export type ProjectQuota = {
  source: 'inherit' | 'independent'
  tokenLimit: number | null
  companyCostMicrosLimit: number | null
}

export type ProjectDetail = Project & {
  members: Array<{ userId: number; username: string; mode: GrantMode }>
  quota?: ProjectQuota
  configurationSummary?: {
    themePolicy: 'follow-user' | 'light' | 'dark'
    managementSurface: 'user-frontend'
    runtimeState: string
    runtimeGeneration: number
    filesystemManagedIn: '/admin'
    projectModels?: { providerCount: number; revision: number }
  }
}

export type ProjectDirectoryListing = {
  path: string | null
  scope: 'filesystem' | 'configured-roots'
  crumbs: Array<{ name: string; path: string | null }>
  entries: Array<{ name: string; path: string; hidden: boolean }>
  selectable: boolean
  truncated: boolean
}

export type AuditFamily = 'admin' | 'auth' | 'model' | 'steward' | 'api' | 'other'

export type AuditEntry = {
  outcome: 'success' | 'failure' | 'recorded' | 'unknown'
  metadata: Record<string, string | number | boolean>
  id: number
  ts: number
  userId: number | null
  username: string | null
  displayName: string | null
  action: string
  methodPath: string
  status: number | null
  ip: string
}

export type AuditFilter = {
  userId?: number
  actor?: string
  action?: string
  actionPrefix?: string
  query?: string
  family?: AuditFamily
  outcome?: 'success' | 'failure'
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export type AuditPage = {
  entries: AuditEntry[]
  /** Matching rows across all pages; absent when the server predates the total header. */
  total: number | null
}

export type ConversationArchiveState = 'archived' | 'trash' | 'purged'

export type ConversationArchiveRow = {
  archiveId: ConversationArchiveId
  rootSessionId: string
  title: string
  contentPreview?: string | null
  creator: { id: number; displayName: string } | null
  project: { id: number; name: string } | null
  runtime: { kind: 'user' | 'project'; id: number; runtimeId?: RuntimeId; nodeId?: RuntimeNodeId }
  workspace: { path: string; title: string; position: number | null } | null
  state: ConversationArchiveState
  archivedAt: number
  restoredAt: number | null
  trashedAt: number | null
  purgeAfter: number | null
  syncState: 'pending' | 'synced' | 'conflict' | 'unavailable'
  lastSyncError?: string
  childCount: number
  messageCount: number
  updatedAt: number
  recordKind?: 'empty-draft'
}

export type EmptyDraftCandidate = {
  rootSessionId: string
  runtime: { kind: 'user' | 'project'; id: number; runtimeId: RuntimeId; nodeId?: RuntimeNodeId }
  creator: { id: number; displayName: string } | null
  project: { id: number; name: string } | null
  createdAt: number
  updatedAt: number
  eventCount: number
}

export type ConversationArchiveDetail = {
  record: ConversationArchiveRow
  descendants: Array<{ sessionId: string; parentSessionId: string | null; title: string }>
  events: Array<{ sessionId: string; seq: number; type: string; time: number; data: unknown }>
  hasMore: boolean
}

export type AdminDocument = {
  catalogId: string
  scope: { kind: 'personal' | 'project'; id?: number; label: string; mode?: 'ro' | 'rw' }
  docId: string
  directoryId: string
  name: string
  bytes: number
  mediaType: string
  modifiedAt: number
  owner: { id: number; displayName: string } | null
  ownerSource: 'upload' | 'transfer' | 'legacy' | 'admin'
  state: 'active' | 'trash' | 'purged' | 'missing' | 'deleted'
  trashedAt?: number | null
  restoredAt?: number | null
  purgeAfter?: number | null
  purgedAt?: number | null
  legacy: boolean
  lineageRootId: string | null
}

export type AdminDocumentMetrics = {
  total: number
  active: number
  trash?: number
  purged?: number
  deleted: number
  personal: number
  project: number
  bytes: number
  operations24h: number
  failures24h: number
}

export type AdminDocumentDetail = {
  document: AdminDocument
  history: Array<{
    id: number
    eventKind: string
    actor: { id: number; displayName: string } | null
    operationId: string | null
    detail: unknown
    createdAt: number
  }>
  copies: Array<{
    operationId: string
    status: string
    source: { name: string; docId: string }
    targetDocId: string | null
    error: { code: string; message: string } | null
    createdAt: number
  }>
}

export type AdminDocumentPage = {
  documents: AdminDocument[]
  nextCursor?: string
}

export class AdminRequestError extends Error {
  /**
   * @param status - failed HTTP status.
   * @param message - localized text for the operator.
   * @param code - original Gateway code; omission retains the supplied diagnostic.
   */
  constructor(readonly status: number, message: string, readonly code = message) {
    super(message)
    this.name = 'AdminRequestError'
  }
}

const MAX_ADMIN_RESPONSE_BYTES = 16 * 1024 * 1024

/** Read one Admin response without handing an unbounded body to JSON.parse. */
/* jscpd:ignore-start -- this private Vite app cannot depend on the host package's runtime bundle. */
async function readResponseJson<T>(response: Response): Promise<T> {
  const responseLike = response as unknown as {
    headers?: Pick<Headers, 'get'>
    body?: ReadableStream<Uint8Array> | null
    json?: () => Promise<unknown>
    text?: () => Promise<string>
  }
  const headers = responseLike.headers
  const body = responseLike.body
  if (body == null && headers === undefined && responseLike.json !== undefined) {
    return await responseLike.json() as T
  }
  const declared = headers?.get('content-length') ?? null
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ADMIN_RESPONSE_BYTES) {
      await body?.cancel().catch(() => {})
      throw new Error('Admin response is too large.')
    }
  }
  if (body == null) {
    if (headers === undefined && responseLike.text !== undefined) {
      const text = await responseLike.text()
      if (new TextEncoder().encode(text).byteLength > MAX_ADMIN_RESPONSE_BYTES) throw new Error('Admin response is too large.')
      return (text === '' ? undefined : JSON.parse(text)) as T
    }
    return undefined as T
  }
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_ADMIN_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('Admin response is too large.')
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  const text = new TextDecoder().decode(bytes)
  return (text === '' ? undefined : JSON.parse(text)) as T
}
/* jscpd:ignore-end */

/** Preserve the Gateway discriminator while localizing computer diagnostics. */
async function responseError(res: Response): Promise<AdminRequestError> {
  let message = `Request failed (${String(res.status)})`
  let code: string | undefined
  try {
    const body = await readResponseJson<{ error?: unknown; message?: unknown; code?: unknown }>(res)
    if (typeof body.error === 'string' && body.error !== '') message = body.error
    else if (typeof body.message === 'string' && body.message !== '') message = body.message
    if (body.error !== null && typeof body.error === 'object') {
      const nested = body.error as { code?: unknown; message?: unknown }
      if (typeof nested.message === 'string' && nested.message !== '') message = nested.message
      if (typeof nested.code === 'string' && nested.code !== '') code = nested.code
    }
    if (typeof body.code === 'string' && body.code !== '') code = body.code
  } catch {
    // Preserve the HTTP status when the upstream body is absent, invalid or too large.
  }
  return new AdminRequestError(res.status, computerErrorMessage(message), code ?? message)
}

async function request<T>(url: string, init: RequestInit = {}, target?: 'computer' | 'organization'): Promise<T> {
  const res = await fetch(adminComputerRequestUrl(url, undefined, target), {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  if (!res.ok) throw await responseError(res)
  if (res.status === 204) return undefined as T
  return await readResponseJson<T>(res)
}

/** Read or confirm a reviewed personal directory or account UserDoc publication at its exact computer. */
export function personalPublication<T>(kind:'directory'|'documents', userId:number, runtimeId:string,nodeId:string, signal:AbortSignal,approval?:Record<string,unknown>):Promise<T> {
  const path=kind==='directory' ? '/admin/api/runtimes/'+encodeURIComponent(runtimeId)+'/personal-directory/promote'
    : '/admin/api/documents/personal/'+userId+'/migration'
  return request(path+'?dshNode='+encodeURIComponent(nodeId),{signal,...(approval?{method:'POST',body:JSON.stringify(approval)}:{})},'organization')
}

/** Read shared account choices, or explicitly request the selected computer's instance columns. */
export function listUsers(target: 'organization' | 'computer' = 'organization'): Promise<AdminUser[]> {
  return request('/admin/api/users', {}, target)
}

export function getUser(id: number): Promise<AdminUser> {
  return request(`/admin/api/users/${id}`, {}, 'organization')
}

/** Read only the current Admin document's computer-local home and instance metadata. */
export function getUserComputerProfile(id: number, signal?: AbortSignal): Promise<AdminUser> {
  return request(`/admin/api/users/${id}`, { signal })
}

/** One stored project membership row as seen from the member's account side. */
export type UserMembership = {
  projectId: number
  name: string
  path: string
  mode: GrantMode
}

export function listUserMemberships(userId: number): Promise<{ memberships: UserMembership[] }> {
  return request(`/admin/api/users/${userId}/memberships`)
}

/** Row shape POST /admin/api/users answers — no instance join until the account is listed. */
export type CreatedUser = Omit<AdminUser, 'port' | 'instanceState'>

export function createUser(body: {
  username: string
  password: string
  role?: 'admin' | 'user'
  displayName?: string
}): Promise<CreatedUser> {
  return request('/admin/api/users', { method: 'POST', body: JSON.stringify(body) })
}

export function patchUser(id: number, body: {
  displayName?: string
  role?: 'admin' | 'user'
  status?: 'active' | 'disabled'
  autoReviewEligible?: boolean
}): Promise<void> {
  return request(`/admin/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, 'organization')
}

export function deleteUser(id: number): Promise<void> {
  return request(`/admin/api/users/${id}`, { method: 'DELETE' })
}

export function resetPassword(id: number, password: string): Promise<void> {
  return request(`/admin/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) }, 'organization')
}

export function controlInstance(id: number, op: 'start' | 'stop' | 'restart'): Promise<void> {
  return request(`/admin/api/users/${id}/instance/${op}`, { method: 'POST' })
}

/** Operate this node's project runtime without changing project membership or ownership. */
export function controlProjectInstance(id: number, op: 'start' | 'stop' | 'restart'): Promise<void> {
  return request(`/admin/api/projects/${id}/instance/${op}`, { method: 'POST' })
}

export type { NodeConfigurationView, NodeSettingValues } from '../../src/node-config-fields.ts'

/** Read current-node effective and pending settings; no credential contents are returned. */
export function getNodeConfiguration(signal?: AbortSignal): Promise<import('../../src/node-config-fields.ts').NodeConfigurationView> {
  return request('/admin/api/deployment/configuration', { ...(signal === undefined ? {} : { signal }) })
}

/** Save or explicitly apply the reviewed node and revision. */
export function mutateNodeConfiguration(input: {
  action: 'save' | 'apply'
  organizationId: string
  nodeId: string
  revision: number
  values?: import('../../src/node-config-fields.ts').NodeSettingValues
}): Promise<import('../../src/node-config-fields.ts').NodeConfigurationView> {
  return request('/admin/api/deployment/configuration', { method: 'POST', body: JSON.stringify(input) })
}

export interface BackupNodeConfigurationPreview {
  backupId: string
  configFile: string | null
  appliedRevision: number | null
  values: import('../../src/node-config-fields.ts').NodeSettingValues | null
  incompatibleFields: string[]
}

/** Read only declared node settings from a verified backup without applying them. */
export function inspectBackupNodeConfiguration(id: string): Promise<BackupNodeConfigurationPreview> {
  return request('/admin/api/backups/node-configuration', { method: 'POST', body: JSON.stringify({ id }) })
}

/** Read only explicitly selected project names and paths on one computer. Incomplete or mixed responses fail closed.
 * @param projects - one page of projects from the current Admin directory.
 * @param signal - current view lifetime.
 * @returns this computer's authorized display fields indexed by public project ID.
 */
export async function getOwnerProjectDisplays(projects: readonly Project[], signal?: AbortSignal): Promise<Map<number, { name: string; path: string }>> {
  if (!projects.length) return new Map()
  const node = projects[0]?.nodeId
  const selected = adminComputerTarget(globalThis.location?.pathname ?? '/admin')
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu
  if (!node || !uuid.test(node) || selected && selected !== node || projects.length > 32 || projects.some(row => !row.metadataOnNode || row.nodeId !== node || !row.runtimeId || !uuid.test(row.runtimeId)
    || !Number.isSafeInteger(row.id) || row.id <= 0)) throw new Error('Invalid project owner selection')
  const expected = new Map(projects.map(row => [row.id, row.runtimeId]))
  if (expected.size !== projects.length) throw new Error('Duplicate project selection')
  const query = new URLSearchParams({ dshNode: node, ids: [...expected.keys()].join(',') })
  const raw = await request<unknown>(`/admin/api/project-metadata?${query}`, { cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
  if (!raw || typeof raw !== 'object' || !('items' in raw) || !Array.isArray(raw.items)) throw new Error('Invalid project metadata')
  const result = new Map<number, { name: string; path: string }>()
  for (const item of raw.items as unknown[]) {
    if (!item || typeof item !== 'object' || !('projectId' in item) || typeof item.projectId !== 'number'
      || !expected.has(item.projectId) || result.has(item.projectId) || !('runtimeId' in item) || expected.get(item.projectId) !== item.runtimeId
      || !('nodeId' in item) || item.nodeId !== node || !('name' in item) || typeof item.name !== 'string' || !item.name
      || !('rootPath' in item) || typeof item.rootPath !== 'string' || !item.rootPath) throw new Error('Project owner mismatch')
    result.set(item.projectId, { name: item.name, path: item.rootPath })
  }
  if (result.size !== expected.size) throw new Error('Project names unavailable from their computer')
  return result
}

export async function listProjects(origin?: 'admin' | 'user', display?: 'directory', signal?: AbortSignal): Promise<Project[]> {
  const query = new URLSearchParams()
  if (origin) query.set('origin', origin)
  if (display) query.set('display', display)
  const rows = await request<Project[]>(`/admin/api/projects${query.size ? `?${query}` : ''}`, signal === undefined ? {} : { signal })
  if (display !== 'directory') return rows
  const selected = adminComputerTarget(globalThis.location?.pathname ?? '/admin')
  const nodes = new Set(rows.filter(row => row.metadataOnNode).map(row => row.nodeId))
  if (nodes.size > 1 || selected && nodes.size && !nodes.has(selected)) throw new Error('Project directory belongs to another computer')
  return rows.map(row => {
    if (!row.metadataOnNode) return row
    const neutral = { ...row, name: `#${row.id}`, path: '' }
    delete neutral.ownerDisplayLoaded
    return neutral
  })
}

export function listProjectDirectories(path?: string): Promise<ProjectDirectoryListing> {
  const query = path === undefined ? '' : `?${new URLSearchParams({ path }).toString()}`
  return request(`/admin/api/project-directories${query}`)
}

export function createProject(body: { name: string; path?: string }): Promise<Project> {
  return request('/admin/api/projects', { method: 'POST', body: JSON.stringify(body) })
}

export async function getProject(id: number, display?: 'directory' | 'members', signal?: AbortSignal): Promise<ProjectDetail> {
  const row = await request<ProjectDetail>(`/admin/api/projects/${id}${display ? '?display=directory' : ''}`, signal === undefined ? {} : { signal })
  if (row.id !== id) throw new Error('Project metadata belongs to another project')
  if (!display || !row.metadataOnNode) return row
  if (display === 'members') return { ...row, name: `#${id}`, path: '' }
  const values = await getOwnerProjectDisplays([row], signal)
  return { ...row, ...values.get(id)!, ownerDisplayLoaded: true }
}

export function renameProject(id: number, name: string): Promise<void> {
  return request(`/admin/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
}

export function deleteProject(id: number): Promise<void> {
  return request(`/admin/api/projects/${id}`, { method: 'DELETE' })
}

export function setMember(projectId: number, userId: number, mode: GrantMode): Promise<void> {
  return request(`/admin/api/projects/${projectId}/members/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({ mode }),
  })
}

export function removeMember(projectId: number, userId: number): Promise<void> {
  return request(`/admin/api/projects/${projectId}/members/${userId}`, { method: 'DELETE' })
}

export async function listAudit(filter: AuditFilter = {}): Promise<AuditPage> {
  const q = new URLSearchParams()
  if (filter.userId !== undefined) q.set('userId', String(filter.userId))
  if (filter.actor !== undefined && filter.actor !== '') q.set('actor', filter.actor)
  if (filter.action !== undefined && filter.action !== '') q.set('action', filter.action)
  if (filter.actionPrefix !== undefined && filter.actionPrefix !== '') q.set('actionPrefix', filter.actionPrefix)
  if (filter.query !== undefined && filter.query !== '') q.set('q', filter.query)
  if (filter.family !== undefined) q.set('family', filter.family)
  if (filter.outcome !== undefined) q.set('outcome', filter.outcome)
  if (filter.from !== undefined) q.set('from', String(filter.from))
  if (filter.to !== undefined) q.set('to', String(filter.to))
  if (filter.limit !== undefined) q.set('limit', String(filter.limit))
  if (filter.offset !== undefined) q.set('offset', String(filter.offset))
  const qs = q.toString()
  const res = await fetch(adminComputerRequestUrl(`/admin/api/audit${qs === '' ? '' : `?${qs}`}`), { credentials: 'same-origin' })
  if (!res.ok) throw await responseError(res)
  const totalHeader = res.headers.get('x-total-count')
  const total = totalHeader === null ? null : Number(totalHeader)
  return { entries: await res.json() as AuditEntry[], total: total !== null && Number.isFinite(total) ? total : null }
}

export function listArchives(filter: {
  state?: ConversationArchiveState | 'all'
  query?: string
  userId?: number
  projectId?: number
  from?: number
  to?: number
  limit?: number
  offset?: number
  recordKind?: 'conversation' | 'empty-draft' | 'all'
} = {}): Promise<ConversationArchiveRow[]> {
  const query = new URLSearchParams()
  if (filter.state !== undefined) query.set('state', filter.state)
  if (filter.recordKind !== undefined) query.set('kind', filter.recordKind)
  if (filter.query !== undefined && filter.query !== '') query.set('q', filter.query)
  for (const key of ['userId', 'projectId', 'from', 'to', 'limit', 'offset'] as const) {
    const value = filter[key]
    if (value !== undefined) query.set(key, String(value))
  }
  const suffix = query.toString()
  return request<ConversationArchiveRow[]>(`/admin/api/archives/records${suffix === '' ? '' : `?${suffix}`}`).then(rows => rows.map(row => decodeArchiveRecord(row)))
}

export async function previewEmptyDrafts(options: { olderThanMs?: number; limit?: number } = {}): Promise<{
  cutoff: number
  candidates: EmptyDraftCandidate[]
}> {
  const query = new URLSearchParams()
  if (options.olderThanMs !== undefined) query.set('ageMs', String(options.olderThanMs))
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const suffix = query.toString()
  const result = await request<{ cutoff: number; candidates: EmptyDraftCandidate[] }>(`/admin/api/archives/empty-drafts/preview${suffix === '' ? '' : `?${suffix}`}`)
  return { ...result, candidates: result.candidates.map(candidate => {
    const identity = parseConversationSessionIdentity({ rootSessionId: candidate.rootSessionId, runtimeId: candidate.runtime.runtimeId })
    if (identity === undefined) throw new Error('invalid empty-draft identity')
    return { ...candidate, runtime: { ...candidate.runtime, runtimeId: identity.runtimeId } }
  }) }
}

export function trashEmptyDrafts(sessions: readonly ConversationSessionIdentity[], cutoff?: number): Promise<{ trashed: ConversationSessionIdentity[] }> {
  return request('/admin/api/archives/empty-drafts/trash', {
    method: 'POST',
    body: JSON.stringify({ sessions, ...(cutoff === undefined ? {} : { cutoff }) }),
  })
}

/** Decode the archive identity at the HTTP response; Host IDs never substitute for it. */
function decodeArchiveRecord(value: unknown, expected?: ConversationArchiveId): ConversationArchiveRow {
  if (typeof value !== 'object' || value === null) throw new Error('invalid archive response')
  const row = value as Record<string, unknown>
  const archiveId = parseConversationArchiveId(row.archiveId)
  if (archiveId === undefined || expected !== undefined && archiveId !== expected) throw new Error('invalid archive identity in response')
  return { ...row, archiveId } as ConversationArchiveRow
}

export async function getArchive(archiveId: ConversationArchiveId, fromSeq = 0, limit = 200): Promise<ConversationArchiveDetail> {
  const query = new URLSearchParams({ fromSeq: String(fromSeq), limit: String(limit) })
  const detail = await request<ConversationArchiveDetail>(`/admin/api/archives/records/${encodeURIComponent(archiveId)}?${query.toString()}`)
  return { ...detail, record: decodeArchiveRecord(detail.record, archiveId) }
}

export async function getArchiveStatus(archiveId: ConversationArchiveId): Promise<ConversationArchiveRow> {
  return decodeArchiveRecord(await request(`/admin/api/archives/records/${encodeURIComponent(archiveId)}/status`), archiveId)
}

export function exportArchive(archiveId: ConversationArchiveId): string {
  return adminComputerRequestUrl(`/admin/api/archives/records/${encodeURIComponent(archiveId)}/export`)
}

export async function applyArchiveAction(action: 'restore' | 'trash' | 'purge' | 'settle', archiveIds: ConversationArchiveId[]): Promise<{
  action: string
  results: Array<{ archiveId: ConversationArchiveId; ok: boolean; error?: string }>
}> {
  const result = await request<{
    action: string
    results: Array<{ archiveId: ConversationArchiveId; ok: boolean; error?: string }>
  }>('/admin/api/archives/records/actions', {
    method: 'POST',
    body: JSON.stringify({ action, archiveIds, idempotencyKey: crypto.randomUUID() }),
  })
  if (result.action !== action || result.results.length !== archiveIds.length
    || result.results.some((item, index) => parseConversationArchiveId(item.archiveId) !== archiveIds[index])) {
    throw new Error('invalid archive action response')
  }
  return result
}

export function listDocumentMetrics(): Promise<AdminDocumentMetrics> {
  return request('/admin/api/documents/metrics')
}

export async function listAdminDocuments(filter: {
  scope?: 'personal' | 'project'
  projectId?: number
  ownerUserId?: number
  state?: 'active' | 'trash' | 'purged' | 'missing' | 'deleted' | 'all'
  query?: string
  limit?: number
  offset?: number
} = {}): Promise<AdminDocument[]> {
  const query = new URLSearchParams()
  if (filter.scope !== undefined) query.set('scope', filter.scope)
  if (filter.projectId !== undefined) query.set('projectId', String(filter.projectId))
  if (filter.ownerUserId !== undefined) query.set('ownerUserId', String(filter.ownerUserId))
  if (filter.state !== undefined) query.set('state', filter.state)
  if (filter.query !== undefined && filter.query !== '') query.set('q', filter.query)
  if (filter.limit !== undefined) query.set('limit', String(filter.limit))
  if (filter.offset !== undefined) query.set('offset', String(filter.offset))
  const suffix = query.toString()
  const value = await request<AdminDocument[] | AdminDocumentPage>(`/admin/api/documents${suffix === '' ? '' : `?${suffix}`}`)
  return Array.isArray(value) ? value : value.documents
}

/** Cursor-based administrator document listing; accepts legacy array responses. */
export async function listAdminDocumentsPage(filter: {
  scope?: 'personal' | 'project'
  projectId?: number
  ownerUserId?: number
  state?: 'active' | 'trash' | 'purged' | 'missing' | 'deleted' | 'all'
  query?: string
  limit?: number
  cursor?: string
} = {}): Promise<AdminDocumentPage> {
  const query = new URLSearchParams()
  if (filter.scope !== undefined) query.set('scope', filter.scope)
  if (filter.projectId !== undefined) query.set('projectId', String(filter.projectId))
  if (filter.ownerUserId !== undefined) query.set('ownerUserId', String(filter.ownerUserId))
  if (filter.state !== undefined) query.set('state', filter.state)
  if (filter.query !== undefined && filter.query !== '') query.set('q', filter.query)
  if (filter.limit !== undefined) query.set('limit', String(filter.limit))
  if (filter.cursor !== undefined) query.set('cursor', filter.cursor)
  const suffix = query.toString()
  const value = await request<AdminDocumentPage | AdminDocument[]>(`/admin/api/documents${suffix === '' ? '' : `?${suffix}`}`)
  return Array.isArray(value) ? { documents: value } : value
}

export function getAdminDocument(id: string): Promise<AdminDocumentDetail> {
  return request(`/admin/api/documents/${encodeURIComponent(id)}`)
}

export function deleteAdminDocument(id: string): Promise<void> {
  return request(`/admin/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Apply one lifecycle action to one or more catalog rows. */
export function applyAdminDocumentAction(action: 'trash' | 'restore' | 'purge', ids: string[]): Promise<{
  action: string
  results: Array<{ catalogId: string; ok: boolean; error?: string }>
}> {
  return request('/admin/api/documents/actions', {
    method: 'POST',
    body: JSON.stringify({ action, ids }),
  })
}

export function transferAdminDocumentOwnership(id: string, ownerUserId: number): Promise<void> {
  return request(`/admin/api/documents/${encodeURIComponent(id)}/ownership`, {
    method: 'POST', body: JSON.stringify({ ownerUserId }),
  })
}

export type AdminDesktopResource = {
  resourceKey: string
  node: string
  desktop: string
  fencingSeq: number
  queueSeq: number
  state: 'available' | 'unavailable'
  stateNote: string | null
  updatedAt: number
}

export type AdminDesktopGrant = {
  grantId: string
  resourceKey: string
  fencing: number
  holderKey: string
  holderJson: string
  requestId: string
  state: 'held' | 'stopping' | 'pending-confirm' | 'released'
  reason: string | null
  acquiredAt: number
  heartbeatAt: number
  stoppingAt: number | null
  releasedAt: number | null
}

export type AdminDesktopQueueEntry = {
  queueId: string
  resourceKey: string
  position: number
  holderKey: string
  holderJson: string
  requestId: string
  state: 'queued' | 'cancelled' | 'expired' | 'promoted'
  queuedAt: number
  settledAt: number | null
  grantId: string | null
}

export type AdminDesktopDetail = {
  resource?: AdminDesktopResource
  grants: AdminDesktopGrant[]
  queue: AdminDesktopQueueEntry[]
}

/** Verified holder identity embedded in a grant or queue row. */
export type DesktopHolder = {
  organization: string
  runtime: { kind: 'user' | 'project'; id: number; generation: number }
  user: { id: number; username: string }
  runId?: string
}

export function desktopHolderOf(row: { holderJson: string }): DesktopHolder | undefined {
  try {
    return JSON.parse(row.holderJson) as DesktopHolder
  } catch {
    return undefined
  }
}

/** An administrator decision and its optimistic revision, scoped to one resource owner. */
export interface AdminResourcePolicy {
  kind: 'user' | 'project'
  id: number
  enabled: boolean
  revision: string
}

export type AdminDesktopPolicy = AdminResourcePolicy

export function getDesktopPolicy(kind: AdminDesktopPolicy['kind'], id: number, signal?: AbortSignal): Promise<AdminDesktopPolicy> {
  return request(`/admin/api/desktops/permissions?kind=${kind}&id=${String(id)}`, { signal })
}

export function setDesktopPolicy(policy: AdminDesktopPolicy): Promise<AdminDesktopPolicy> {
  return request('/admin/api/desktops/permissions', { method: 'POST', body: JSON.stringify(policy) })
}

export function getTerminalPolicy(kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal): Promise<AdminResourcePolicy> {
  return request(`/admin/api/terminals/permissions?kind=${kind}&id=${String(id)}`, { signal })
}

export function setTerminalPolicy(policy: AdminResourcePolicy): Promise<AdminResourcePolicy> {
  return request('/admin/api/terminals/permissions', { method: 'POST', body: JSON.stringify(policy) })
}

export function getSshPolicy(kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal): Promise<AdminResourcePolicy> {
  return request(`/admin/api/ssh/permissions?kind=${kind}&id=${String(id)}`, { signal })
}

export function setSshPolicy(policy: AdminResourcePolicy): Promise<AdminResourcePolicy> {
  return request('/admin/api/ssh/permissions', { method: 'POST', body: JSON.stringify(policy) })
}

export function getPluginPolicy(kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal): Promise<AdminResourcePolicy> {
  return request(`/admin/api/plugins/permissions?kind=${kind}&id=${String(id)}`, { signal })
}

export function setPluginPolicy(policy: AdminResourcePolicy): Promise<AdminResourcePolicy> {
  return request('/admin/api/plugins/permissions', { method: 'POST', body: JSON.stringify(policy) })
}

export function getMemoryPolicy(kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal): Promise<AdminResourcePolicy> {
  return request(`/admin/api/memory/permissions?kind=${kind}&id=${String(id)}`, { signal })
}

export function setMemoryPolicy(policy: AdminResourcePolicy): Promise<AdminResourcePolicy> {
  return request('/admin/api/memory/permissions', { method: 'POST', body: JSON.stringify(policy) })
}

export function getStewardPolicy(kind: AdminResourcePolicy['kind'], id: number, signal?: AbortSignal): Promise<AdminResourcePolicy> {
  return request(`/admin/api/steward/permissions?kind=${kind}&id=${String(id)}`, { signal })
}

export function setStewardPolicy(policy: AdminResourcePolicy): Promise<AdminResourcePolicy> {
  return request('/admin/api/steward/permissions', { method: 'POST', body: JSON.stringify(policy) })
}

/** One organization member's steward qualification as the management surface lists it. */
export interface StewardAccessEntry {
  userId: number
  username: string
  displayName: string
  role: 'admin' | 'member'
  userStatus: string
  membershipStatus: string
  grantable: boolean
  qualified: boolean
  effective: boolean
  revision: string
}

/** Steward space overview: provisioning plus every member's qualification state. */
export interface StewardOverview {
  enabled: boolean
  space: { id: number; name: string; path: string; runtime: string } | null
  members: StewardAccessEntry[]
}

export function getStewardOverview(signal?: AbortSignal): Promise<StewardOverview> {
  return request('/admin/api/steward', { signal })
}

/** Administrator-registered OpenSSH target with its project shares. */
export interface AdminSshTarget {
  publicId: number
  name: string
  host: string
  node: string
  helper: string
  helperHash: string
  workspace: string
  bootstrapPath: string | null
  bootstrapHash: string | null
  passwordRef: string | null
  requestTimeoutMs: number | null
  maxFrameBytes: number | null
  maxPending: number | null
  leaseMs: number | null
  enabled: boolean
  revision: string
  sharedProjects: number[]
}

/** Editable connection coordinates; ids and revisions are server-owned. */
export type AdminSshTargetFields = Pick<AdminSshTarget,
  'name' | 'host' | 'node' | 'helper' | 'helperHash' | 'workspace'
  | 'bootstrapPath' | 'bootstrapHash' | 'passwordRef' | 'requestTimeoutMs' | 'maxFrameBytes' | 'maxPending' | 'leaseMs'>

export function listSshTargets(): Promise<{ targets: AdminSshTarget[] }> {
  return request('/admin/api/ssh-targets')
}

export function createSshTarget(fields: AdminSshTargetFields): Promise<AdminSshTarget> {
  return request('/admin/api/ssh-targets', { method: 'POST', body: JSON.stringify(fields) })
}

export function updateSshTarget(targetId: number, revision: string, fields: AdminSshTargetFields): Promise<AdminSshTarget> {
  return request('/admin/api/ssh-targets/update', { method: 'POST', body: JSON.stringify({ targetId, revision, fields }) })
}

export function mutateSshTarget(targetId: number, revision: string, action: 'enable' | 'disable' | 'remove'): Promise<AdminSshTarget | { removed: true }> {
  return request('/admin/api/ssh-targets/mutate', { method: 'POST', body: JSON.stringify({ targetId, revision, action }) })
}

export function shareSshTarget(targetId: number, projectId: number, shared: boolean): Promise<AdminSshTarget> {
  return request('/admin/api/ssh-targets/share', { method: 'POST', body: JSON.stringify({ targetId, projectId, shared }) })
}

/** Administrator-registered webhook endpoint; the signing secret is write-only. */
export interface AdminWebhookEndpoint {
  /** Visibility of roots created in a project runtime. */
  projectVisibility: 'project' | 'private'
  id: string
  publicId: number
  name: string
  provider: 'github'
  source: string
  events: string[]
  actions: string[]
  repositories: string[]
  titleTemplate: string
  promptTemplate: string
  workspacePath: string
  agentPreset: string
  permissionPreset: string
  modelProvider: string | null
  modelId: string | null
  modelMaxTokens: number | null
  executionUserId: number
  runtimeKind: 'user' | 'project'
  runtimePublicId: number
  runtimeId?: import('../../src/runtime-catalog.ts').RuntimeId | null
  nodeId?: import('../../src/runtime-catalog.ts').RuntimeNodeId | null
  intakeLimit: number
  intakeWindowMs: number
  replayWindowMs: number
  maxBodyBytes: number
  enabled: boolean
  revision: string
}

/** Editable endpoint fields; ids, revisions, and the secret are server-owned channels. */
export type AdminWebhookEndpointFields = Pick<AdminWebhookEndpoint,
  'name' | 'provider' | 'source' | 'events' | 'actions' | 'repositories' | 'titleTemplate' | 'promptTemplate' | 'workspacePath'
  | 'agentPreset' | 'permissionPreset' | 'modelProvider' | 'modelId' | 'modelMaxTokens'
  | 'executionUserId' | 'runtimeKind' | 'runtimePublicId' | 'runtimeId' | 'intakeLimit' | 'intakeWindowMs'
  | 'replayWindowMs' | 'maxBodyBytes' | 'projectVisibility'>

export function listWebhookEndpoints(): Promise<{ endpoints: AdminWebhookEndpoint[] }> {
  return request('/admin/api/webhook-endpoints')
}

export function createWebhookEndpoint(fields: AdminWebhookEndpointFields & { secret: string }): Promise<AdminWebhookEndpoint> {
  return request('/admin/api/webhook-endpoints', { method: 'POST', body: JSON.stringify(fields) })
}

export function updateWebhookEndpoint(
  targetId: number, revision: string, fields: AdminWebhookEndpointFields, secret?: string,
): Promise<AdminWebhookEndpoint> {
  return request('/admin/api/webhook-endpoints/update', {
    method: 'POST', body: JSON.stringify({ targetId, revision, fields, ...(secret === undefined ? {} : { secret }) }),
  })
}

export function mutateWebhookEndpoint(
  targetId: number, revision: string, action: 'enable' | 'disable' | 'remove',
): Promise<AdminWebhookEndpoint | { removed: true }> {
  return request('/admin/api/webhook-endpoints/mutate', { method: 'POST', body: JSON.stringify({ targetId, revision, action }) })
}

/** One durable delivery receipt; payloads and secrets are never exposed. */
export interface AdminWebhookReceipt {
  id: string
  deliveryId: string
  configurationRevision: string
  state: 'dispatching' | 'submitted' | 'ignored' | 'rejected' | 'unknown'
  sessionId: string | null
  errorCode: string | null
  receivedAt: string
}

export function listWebhookDeliveries(
  endpointId: string, cursor?: string, limit?: number,
): Promise<{ items: AdminWebhookReceipt[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ endpointId })
  if (cursor !== undefined) params.set('cursor', cursor)
  if (limit !== undefined) params.set('limit', String(limit))
  return request(`/admin/api/webhook-deliveries?${params.toString()}`)
}

/** Replay one settled receipt's stored event under the endpoint's current configuration. */
export function redispatchWebhookDelivery(receiptId: string): Promise<AdminWebhookReceipt> {
  return request('/admin/api/webhook-deliveries/redispatch', { method: 'POST', body: JSON.stringify({ receiptId }) })
}

export function listDesktops(): Promise<{ resources: AdminDesktopResource[] }> {
  return request('/admin/api/desktops')
}

export function getDesktopDetail(node: string, desktop: string): Promise<AdminDesktopDetail> {
  return request(`/admin/api/desktops/detail?node=${encodeURIComponent(node)}&desktop=${encodeURIComponent(desktop)}`)
}

/** Apply one coordination action: revoke a held grant or clear an unavailable resource. */
export function applyDesktopAction(
  action: 'revoke' | 'clear',
  target: { grantId?: string; node?: string; desktop?: string },
): Promise<{ action: string; ok: boolean }> {
  return request('/admin/api/desktops/actions', {
    method: 'POST',
    body: JSON.stringify({ action, ...target }),
  })
}

export type ModelGovernanceRow = {
  provider: string
  model: string
  displayName: string
  enabled: boolean
  adminAllowed: boolean
  userAllowed: boolean
  inputMicrosPerMillion: number
  outputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheWriteMicrosPerMillion: number
}

export type ModelProviderProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'
export type ModelProviderStatus = 'draft' | 'enabled' | 'disabled' | 'archived'
export type ModelProviderAuthMode = 'api-key' | 'none'

export type ModelProviderRow = {
  provider: string
  displayName: string
  driver: 'pi-ai'
  protocol: ModelProviderProtocol | null
  baseURL: string | null
  authMode: ModelProviderAuthMode
  status: ModelProviderStatus
  credentialRef: string | null
  credentialConfigured: boolean
  source: 'managed' | 'legacy-catalog'
  revision: number
  modelCount: number
  profile?: Record<string, unknown>
}

export type ModelProviderInput = {
  provider: string
  displayName: string
  driver: 'pi-ai'
  protocol: ModelProviderProtocol
  baseURL: string
  authMode: ModelProviderAuthMode
  status: ModelProviderStatus
  credential?: string | null
}

export type OrganizationModelSettingsView = {
  writable: boolean
  hasDocument: boolean
  namespaces: Array<{
    ns: 'llm-pi-ai'
    schema: unknown
    value: unknown
    base?: unknown
    user?: unknown
    applies: 'live'
    secrets: Array<{ path: string[]; set: boolean }>
    revision: number
  }>
}

export type OrganizationCredentialView = {
  configured: boolean
  source: 'organization'
  writable: true
}

export type OrganizationModelDiscovery = {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}

export function describeOrganizationModelSettings(): Promise<OrganizationModelSettingsView> {
  return request('/admin/api/model-settings')
}

export function mutateOrganizationModelSettings(body: {
  ops: Array<{ op: 'set' | 'unset'; path: string[]; value?: unknown }>
  expectedRevision?: number
}): Promise<OrganizationModelSettingsView> {
  return request('/admin/api/model-settings', { method: 'PUT', body: JSON.stringify(body) })
}

export function describeOrganizationCredentials(refs: string[]): Promise<{ credentials: Record<string, OrganizationCredentialView> }> {
  const query = new URLSearchParams()
  for (const ref of refs) query.append('refs', ref)
  return request(`/admin/api/model-settings/credentials?${query.toString()}`)
}

export function setOrganizationCredential(ref: string, value: string): Promise<void> {
  return request('/admin/api/model-settings/credentials', { method: 'PUT', body: JSON.stringify({ ref, value }) })
}

export function unsetOrganizationCredential(ref: string): Promise<void> {
  return request('/admin/api/model-settings/credentials', { method: 'DELETE', body: JSON.stringify({ ref }) })
}

export function discoverOrganizationModels(body: OrganizationModelDiscovery): Promise<{
  models: Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>
}> {
  return request('/admin/api/model-settings/discover', { method: 'POST', body: JSON.stringify(body) })
}

export type ModelAccessView = {
  effective: {
    version: number
    defaultAllowed: boolean
    models: Array<{ provider: string; model: string; allowed: boolean }>
  }
  overrides: Array<{ provider: string; model: string; allowed: boolean }>
}

/** Effective model authorization and the project fallback mode returned by the admin API. */
export type ProjectModelAccessView = ModelAccessView & {
  /** Project-level fallback used when a route has no explicit override. */
  projectDefaultAllowed: boolean
}

export type UsagePricingView = {
  status: 'priced' | 'unpriced' | 'configured-zero' | 'mixed' | 'historical-unknown' | 'none'
  pricedCalls: number
  unpricedCalls: number
  configuredZeroCalls: number
  unknownCalls: number
}

export type UsageMeasure = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  estimatedCostMicros: number
  companyCostMicros: number
  calls: number
  missingUsageCalls: number
  pricing?: UsagePricingView
}

export type UsageSummary = UsageMeasure & {
  month: string
  tokenLimit: number | null
  companyCostMicrosLimit: number | null
  alerts: Array<{ metric: 'tokens' | 'company-cost'; threshold: 80 | 100; createdAt: number }>
}

export type UsageContributorRow = UsageMeasure & {
  userId: number
  username: string
  archived?: boolean
  projectCount: number
}

export type UsageContributorReport = {
  month: string
  timeZone: string
  projectId?: number
  rows: UsageContributorRow[]
  unattributed: UsageMeasure
}

export type UsageOverview = {
  month: string
  timeZone: string
  personal: UsageMeasure
  projects: UsageMeasure
  unattributedProjects: UsageMeasure
  users: Array<{
    userId: number
    username: string
    archived?: boolean
    personal: UsageSummary
    projectContribution: UsageMeasure
  }>
}

export type UsageHealth = {
  month: string
  timeZone: string
  missingUsageCalls: number
  unattributedProjectCalls: number
  unattributedProjectTokens: number
  unpricedCalls: number
  historicalUnknownCalls: number
  maxIntakeLagMs: number
}

export type ModelRegistrationAction =
  | 'provider-created' | 'provider-modified' | 'provider-deleted'
  | 'model-created' | 'model-modified' | 'model-deleted'

export type ModelRegistrationRow = {
  eventId: string
  userId: number
  occurredAt: number
  receivedAt: number
  provider: string
  model: string | null
  action: ModelRegistrationAction
  scope: 'personal'
}

export type ModelRegistrationReport = {
  summary: {
    providerCount: number
    modelCount: number
    eventCount: number
    createdCount: number
    modifiedCount: number
    deletedCount: number
  }
  rows: ModelRegistrationRow[]
}

export function listModelRegistrations(filter: {
  userId?: number
  provider?: string
  model?: string
  action?: ModelRegistrationAction
  from?: number
  to?: number
  offset?: number
  limit?: number
} = {}): Promise<ModelRegistrationReport> {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  const suffix = query.toString()
  return request(`/admin/api/model-registrations${suffix === '' ? '' : `?${suffix}`}`)
}

export function listModels(): Promise<ModelGovernanceRow[]> {
  return request('/admin/api/models')
}

export function listModelProviders(): Promise<ModelProviderRow[]> {
  return request('/admin/api/model-providers')
}

export function saveModelProvider(provider: ModelProviderInput): Promise<void> {
  return request('/admin/api/model-providers', { method: 'PUT', body: JSON.stringify(provider) })
}

export function saveModel(model: ModelGovernanceRow): Promise<void> {
  return request('/admin/api/models', { method: 'PUT', body: JSON.stringify(model) })
}

export function getModelAccess(userId: number): Promise<ModelAccessView> {
  return request(`/admin/api/model-access?userId=${userId}`)
}

export function setModelAccess(userId: number, provider: string, model: string, allowed: boolean | null): Promise<void> {
  return request('/admin/api/model-access', {
    method: 'PUT', body: JSON.stringify({ userId, provider, model, allowed }),
  })
}

export function getProjectModelAccess(projectId: number): Promise<ProjectModelAccessView> {
  return request(`/admin/api/project-model-access?projectId=${projectId}`, {}, 'computer')
}

export function setProjectModelAccess(
  projectId: number,
  provider: string,
  model: string,
  allowed: boolean | null,
): Promise<void> {
  return request('/admin/api/project-model-access', {
    method: 'PUT', body: JSON.stringify({ projectId, provider, model, allowed }),
  }, 'computer')
}

export function setAllProjectModelAccess(projectId: number, allowed: true | null): Promise<void> {
  return request('/admin/api/project-model-access', {
    method: 'PUT', body: JSON.stringify({ projectId, all: true, allowed }),
  }, 'computer')
}

export function setQuota(body: {
  subjectType: 'role' | 'user' | 'project'
  subjectId: string
  tokenLimit: number | null | 'inherit'
  companyCostMicrosLimit: number | null | 'inherit'
}): Promise<void> {
  return request('/admin/api/quotas', { method: 'PUT', body: JSON.stringify(body) }, body.subjectType === 'project' ? 'computer' : 'organization')
}

/** Per-metric user quota setting: role inheritance, unlimited, or an explicit monthly cap. */
export type UserQuotaMode = 'inherit' | 'unlimited' | 'custom'

/** Stored per-user quota modes; limits are set only for `custom` entries. */
export type UserQuotaView = {
  tokenMode: UserQuotaMode
  tokenLimit: number | null
  companyCostMode: UserQuotaMode
  companyCostMicrosLimit: number | null
}

export function getUserQuota(userId: number): Promise<UserQuotaView> {
  return request(`/admin/api/quotas?subjectType=user&subjectId=${userId}`)
}

/** Stored role limits; a missing role row means unlimited limits. */
export type RoleQuotaView = {
  tokenLimit: number | null
  companyCostMicrosLimit: number | null
}

/**
 * Read a role's stored monthly limits.
 * @param role - the `admin` or `user` quota subject.
 * @returns the stored limits; null means the role is unlimited. Rejects when
 * the admin API cannot serve the read.
 */
export function getRoleQuota(role: 'admin' | 'user'): Promise<RoleQuotaView> {
  return request(`/admin/api/quotas?subjectType=role&subjectId=${role}`)
}

export function listUsageOverview(month?: string): Promise<UsageOverview> {
  return request(`/admin/api/usage/overview${month === undefined || month === '' ? '' : `?month=${encodeURIComponent(month)}`}`)
}

export function listUsageContributors(projectId?: number, month?: string): Promise<UsageContributorReport> {
  const query = new URLSearchParams()
  if (projectId !== undefined) query.set('projectId', String(projectId))
  if (month !== undefined && month !== '') query.set('month', month)
  const suffix = query.toString()
  return request(`/admin/api/usage/contributors${suffix === '' ? '' : `?${suffix}`}`, {}, projectId === undefined ? 'organization' : 'computer')
}

export function getUsageHealth(month?: string): Promise<UsageHealth> {
  return request(`/admin/api/usage/health${month === undefined || month === '' ? '' : `?month=${encodeURIComponent(month)}`}`)
}

export function getProjectUsage(projectId: number, month?: string): Promise<UsageSummary> {
  const query = new URLSearchParams({ projectId: String(projectId) })
  if (month !== undefined && month !== '') query.set('month', month)
  return request(`/admin/api/usage?${query.toString()}`, {}, 'computer')
}

export type AdminTerminal = {
  ownerId: string
  sessionId: string
  id: string
  creatorUserId?: number
  state: 'starting' | 'running' | 'exited' | 'failed' | 'stopping'
}
export type AdminTerminalInventory = {
  nodeId: string
  target: { kind: 'user' | 'project'; id: number; runtimeId?: import('../../src/runtime-catalog.ts').RuntimeId }
  generation: number | null
  terminals: AdminTerminal[]
}

export function listTerminals(kind: 'user' | 'project', id: number, signal?: AbortSignal, runtimeId?: import('../../src/runtime-catalog.ts').RuntimeId): Promise<AdminTerminalInventory> {
  return request(`/admin/api/terminals?kind=${kind}&id=${String(id)}${runtimeId === undefined ? '' : `&dshRuntime=${encodeURIComponent(runtimeId)}`}`, { signal })
}

export function closeTerminal(inventory: AdminTerminalInventory, entry: AdminTerminal): Promise<{ closed: true }> {
  return request('/admin/api/terminals/close', { method: 'POST', body: JSON.stringify({
    kind: inventory.target.kind, targetId: inventory.target.id, nodeId: inventory.nodeId,
    generation: inventory.generation, runtimeId: inventory.target.runtimeId, ownerId: entry.ownerId, id: entry.id,
  }) })
}

/** Exact current-node profile binding returned before management actions are enabled. */
export interface PluginManagementTarget { nodeId: string; target: { kind: 'user' | 'project'; id: number; runtimeId?: import('../../src/runtime-catalog.ts').RuntimeId }; generation: number | null }
export function pluginManagementTarget(kind: 'user' | 'project', id: number, signal?: AbortSignal, runtimeId?: import('../../src/runtime-catalog.ts').RuntimeId): Promise<PluginManagementTarget> {
  return request(`/admin/api/plugins/target?kind=${kind}&id=${String(id)}${runtimeId === undefined ? '' : `&dshRuntime=${encodeURIComponent(runtimeId)}`}`, { signal })
}
/** Generated Remote codecs validate the answer in the profile adapter. */
export function pluginManagementInvoke(input: unknown, signal: AbortSignal): Promise<unknown> {
  return request('/admin/api/plugins/invoke', { method: 'POST', body: JSON.stringify(input), signal })
}

/** One patch row the desired-state store records, matching the profile's managed-row form. */
export interface PluginDesiredEntry { id: string; name?: string; disabled: boolean }
/** The deployment's saved plugin composition for one runtime owner. */
export interface PluginDesiredState { entries: PluginDesiredEntry[]; bundles: string[] }
/** Localized display text resolved for state rows whose instance cannot answer live. */
export interface PluginStateMeta {
  title?: string | ({ en: string } & Record<string, string>)
  description?: string | ({ en: string } & Record<string, string>)
}
/** The store row, the instance's applied marker, and the files' observed composition. */
export interface PluginManagementState {
  revision: string
  state: PluginDesiredState | null
  appliedRevision: string
  generation: number | null
  observed: PluginDesiredState | null
  /** Display metadata keyed by state-row id and bundle name. */
  meta?: { entries: Record<string, PluginStateMeta>; bundles: Record<string, PluginStateMeta> }
}
export function pluginManagementState(kind: 'user' | 'project', id: number, signal?: AbortSignal, runtimeId?: import('../../src/runtime-catalog.ts').RuntimeId): Promise<PluginManagementState> {
  return request(`/admin/api/plugins/state?kind=${kind}&id=${String(id)}${runtimeId === undefined ? '' : `&dshRuntime=${encodeURIComponent(runtimeId)}`}`, { signal })
}

/** One space holding a saved plugin composition, as the cross-space overview lists it. */
export interface PluginManagementOverviewRow {
  target: { kind: 'user' | 'project'; id: number; label: string }
  entries: number
  disabled: number
  bundles: number
  revision: string
  updatedAt: string
  live: boolean
  generation: number | null
}
export function pluginManagementOverview(signal?: AbortSignal): Promise<PluginManagementOverviewRow[]> {
  return request('/admin/api/plugins/overview', { signal })
}
export function pluginManagementSaveState(input: { target: { kind: 'user' | 'project'; id: number; runtimeId?: import('../../src/runtime-catalog.ts').RuntimeId }; revision: string; state: PluginDesiredState | null }, signal?: AbortSignal): Promise<PluginManagementState> {
  return request('/admin/api/plugins/state', { method: 'POST', body: JSON.stringify(input), signal })
}

export type DeploymentNodeStatus = 'active' | 'draining' | 'offline'
export type ClusterMode = 'serving' | 'maintenance' | 'restoring'

export interface DeploymentNode {
  nodeId: string
  name: string
  status: DeploymentNodeStatus
  lastHeartbeatAt: string | null
  heartbeatAgeMs: number | null
  maintenanceAppliedEpoch: string
  /** -1 means the node's build predates inflight reporting; it cannot quiesce. */
  inflightWrites: number
  activeRuntimes: number
  quiesced: boolean
}

export interface DeploymentOperation {
  id: string
  kind: 'enter-maintenance' | 'exit-maintenance' | 'apply' | 'backup' | 'restore' | 'node-status'
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted'
  nodeName: string | null
  detail: unknown
  createdBy: number | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  error: string | null
}

export interface ClusterState {
  mode: ClusterMode
  maintenanceEpoch: string
  writeEpoch: string
  reason: string | null
  enteredAt: string | null
  updatedAt: string
  nodes: DeploymentNode[]
  writersQuiesced: boolean
}

export interface DeploymentState extends ClusterState {
  migrations: { applied: number[]; pending: Array<{ version: number; name: string }>; drifted: number[]; current: number } | null
  operations: DeploymentOperation[]
}

export interface DeploymentBackup {
  id: string
  path: string
  format: string
  migrationVersion: number
  writeEpoch: string
  sizeBytes: number | null
  sha256: string | null
  managedSnapshot: {
    version: 1
    roots: Array<{ owner: string; kind: 'file' | 'directory'; path: string }>
    files: Array<{ member: string; sourcePath: string; sizeBytes: number; sha256: string; mode: number; uid: number; gid: number }>
    directories: Array<{ path: string; mode: number; uid: number; gid: number }>
    absent: string[]
  } | null
  status: 'recording' | 'verified' | 'failed' | 'restored'
  createdBy: number | null
  createdAt: string
  verifiedAt: string | null
  restoredAt: string | null
  error: string | null
}

export function getDeployment(signal?: AbortSignal): Promise<DeploymentState> {
  return request('/admin/api/deployment', signal === undefined ? {} : { signal })
}
export function setMaintenance(action: 'enter' | 'exit', reason?: string): Promise<ClusterState> {
  return request('/admin/api/deployment/maintenance', { method: 'POST', body: JSON.stringify({ action, reason }) })
}
export function setDeploymentNodeStatus(nodeId: string, status: DeploymentNodeStatus): Promise<DeploymentNode> {
  return request('/admin/api/deployment/nodes/status', { method: 'POST', body: JSON.stringify({ nodeId, status }) })
}

export type { NodeAccessEntry, NodeAccessPage, NodeEnrollment } from '../../src/node-access.ts'

/** A success response did not identify the requested node operation; its effect remains unconfirmed. */
export class NodeAccessResponseError extends Error {
  readonly code = 'node-access/unconfirmed-response'
  constructor() { super('The node operation response did not match the request.'); this.name = 'NodeAccessResponseError' }
}

/**
 * Read one cached node page without probing or starting nodes.
 * @param cursor - continuation returned by the preceding page.
 * @param signal - cancellation owned by this directory view.
 * @returns validated current node metadata; an incomplete page is never deletion evidence.
 */
export async function listNodeAccess(cursor?: string, signal?: AbortSignal): Promise<import('../../src/node-access.ts').NodeAccessPage> {
  const query = cursor === undefined ? '' : `?${new URLSearchParams({ cursor }).toString()}`
  const value = await request<unknown>(`/admin/api/deployment/nodes/access${query}`, { cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
  return (await import('../../src/node-access.ts')).nodeAccessPageSchema.parse(value)
}

/**
 * Read the center identity without contacting managed computers.
 * @param signal - selector-owned cancellation.
 * @returns validated center and forwarding metadata.
 */
export async function getAdminComputerContext(signal?: AbortSignal): Promise<import('../../src/node-access.ts').AdminComputerContext> {
  const value = await request<unknown>('/admin/api/deployment/current-node', { cache: 'no-store', ...(signal === undefined ? {} : { signal }) })
  return (await import('../../src/node-access.ts')).adminComputerContextSchema.parse(value)
}

/**
 * Issue a ticket once; this operation must never be retried automatically.
 * @param name - administrator-selected computer name.
 * @param requestId - caller-generated durable issuance identity.
 * @returns one-time credential material; a transport or malformed-response failure may follow a committed issuance.
 */
export async function issueNodeEnrollment(name: string, requestId: import('../../src/node-access.ts').NodeEnrollmentId, nodeId?: RuntimeNodeId): Promise<import('../../src/node-access.ts').NodeEnrollment> {
  const value = await request<unknown>('/admin/api/deployment/nodes/enrollments', { method: 'POST', body: JSON.stringify(nodeId === undefined ? { name, requestId } : { nodeId, requestId }) })
  const receipt = (await import('../../src/node-access.ts')).nodeEnrollmentSchema.parse(value)
  if (receipt.enrollmentId !== requestId || receipt.revision !== 1 || nodeId !== undefined && receipt.nodeId !== nodeId) throw new NodeAccessResponseError()
  return receipt
}

/**
 * Replace a node credential after explicit confirmation using its current revision.
 * @param node - directory entry whose revision the administrator reviewed.
 * @param requestId - new durable issuance identity.
 * @returns one-time replacement ticket; failures with an unknown outcome require directory inspection.
 */
export async function reissueNodeEnrollment(node: import('../../src/node-access.ts').NodeAccessEntry,
  requestId: import('../../src/node-access.ts').NodeEnrollmentId): Promise<import('../../src/node-access.ts').NodeEnrollment> {
  const value = await request<unknown>(`/admin/api/deployment/nodes/access/${encodeURIComponent(node.nodeId)}`, {
    method: 'POST', body: JSON.stringify({ action: 'issue-enrollment', revision: node.revision, requestId }),
  })
  const receipt = (await import('../../src/node-access.ts')).nodeEnrollmentSchema.parse(value)
  if (receipt.nodeId !== node.nodeId || receipt.enrollmentId !== requestId || receipt.revision !== node.revision + 1) throw new NodeAccessResponseError()
  return receipt
}

/**
 * Revoke one node credential without changing process state or releasing runtime allocations.
 * @param node - directory entry whose revision the administrator reviewed.
 * @returns validated revocation receipt; stale revisions are refused.
 */
export async function revokeNodeAccess(node: import('../../src/node-access.ts').NodeAccessEntry): Promise<import('zod').infer<typeof import('../../src/node-access.ts').nodeRevocationSchema>> {
  const value = await request<unknown>(`/admin/api/deployment/nodes/access/${encodeURIComponent(node.nodeId)}`, {
    method: 'POST', body: JSON.stringify({ action: 'revoke', revision: node.revision }),
  })
  const receipt = (await import('../../src/node-access.ts')).nodeRevocationSchema.parse(value)
  if (receipt.nodeId !== node.nodeId || receipt.revision !== node.revision + 1) throw new NodeAccessResponseError()
  return receipt
}
export function requestDeploymentRestore(backupId: string): Promise<DeploymentOperation> {
  return request('/admin/api/deployment/restore', { method: 'POST', body: JSON.stringify({ backupId }) })
}
export function listBackups(signal?: AbortSignal): Promise<{ backups: DeploymentBackup[] }> {
  return request('/admin/api/backups', signal === undefined ? {} : { signal })
}
export function createBackup(): Promise<DeploymentBackup> {
  return request('/admin/api/backups', { method: 'POST', body: '{}' })
}
export function verifyBackup(id: string): Promise<DeploymentBackup> {
  return request('/admin/api/backups/verify', { method: 'POST', body: JSON.stringify({ id }) })
}

/** Administrator-registered remote-desktop endpoint. */
export interface RemoteDesktopEndpoint {
  nodeId: string
  desktop?: string
  host: string
  port: number
  /** Login user name for password-authenticated servers; requires `passwordRef`. */
  username?: string
  /**
   * Environment-variable name resolved to the endpoint password by the
   * runtime credential store; the host authenticates with it and the browser
   * never sees the password.
   */
  passwordRef?: string
}

/** Stored remote-desktop grant row. */
export interface RemoteDesktopGrant {
  id: string
  target: { nodeId: string; desktop?: string }
  principal: string
  level: 'view' | 'control'
  scope: { kind: 'machine' } | { kind: 'session'; sessionId: string; expiresAt: number }
  recording: boolean
  grantedBy: string
  createdAt: number
  revokedAt?: number
}

/** Provider audit event tail row. */
export interface RemoteDesktopAuditEvent {
  kind: string
  principal?: string
  target?: { nodeId: string; desktop?: string }
  at: number
}

export function listRemoteDesktopEndpoints(): Promise<{ endpoints: RemoteDesktopEndpoint[] }> {
  return request('/admin/api/remote-desktop/endpoints')
}

export function saveRemoteDesktopEndpoints(endpoints: RemoteDesktopEndpoint[]): Promise<{ endpoints: RemoteDesktopEndpoint[] }> {
  return request('/admin/api/remote-desktop/endpoints', { method: 'POST', body: JSON.stringify({ endpoints }) })
}

export function listRemoteDesktopGrants(): Promise<{ grants: RemoteDesktopGrant[] }> {
  return request('/admin/api/remote-desktop/grants')
}

export function createRemoteDesktopGrant(input: {
  principal: string
  target: { nodeId: string; desktop?: string }
  level: 'view' | 'control'
  recording: boolean
}): Promise<{ grant: RemoteDesktopGrant }> {
  return request('/admin/api/remote-desktop/grants', { method: 'POST', body: JSON.stringify(input) })
}

export function setRemoteDesktopGrantLevel(id: string, level: 'view' | 'control'): Promise<{ grant: RemoteDesktopGrant }> {
  return request('/admin/api/remote-desktop/grants/level', { method: 'POST', body: JSON.stringify({ id, level }) })
}

export function revokeRemoteDesktopGrant(id: string): Promise<{ grant: RemoteDesktopGrant }> {
  return request('/admin/api/remote-desktop/grants/revoke', { method: 'POST', body: JSON.stringify({ id }) })
}

export function listRemoteDesktopAudit(limit = 100): Promise<{ events: RemoteDesktopAuditEvent[] }> {
  return request(`/admin/api/remote-desktop/audit?limit=${limit}`)
}

export type TunnelAccessView = {
  supported: boolean
  binary: { path: string; version: string | null; source: string } | null
  mode: 'off' | 'quick' | 'named'
  desired: 'stopped' | 'running'
  state: 'stopped' | 'starting' | 'running' | 'error'
  publicUrl: string | null
  hostname: string | null
  domain: string | null
  apiTokenConfigured: boolean
  lastError: string | null
  revision: number
  startedAt: string | null
  updatedAt: string
}

export function getTunnelAccess(): Promise<TunnelAccessView> {
  return request('/admin/api/tunnel')
}
export function installTunnelBinary(): Promise<TunnelAccessView> {
  return request('/admin/api/tunnel/install', { method: 'POST', body: '{}' })
}
export function tunnelAccessAction(
  body: { action: 'start-quick' | 'stop' | 'clear' }
    | { action: 'start-named'; hostname: string; domain?: string; apiToken?: string },
): Promise<TunnelAccessView> {
  return request('/admin/api/tunnel/actions', { method: 'POST', body: JSON.stringify(body) })
}

export type DigestModelSettings = {
  model: string | null
  candidates: Array<{ provider: string; model: string }>
}

export function getDigestModelSettings(): Promise<DigestModelSettings> {
  return request('/admin/api/progress/digest-model')
}
export function setDigestModel(model: string | null): Promise<DigestModelSettings> {
  return request('/admin/api/progress/digest-model', { method: 'POST', body: JSON.stringify({ model }) })
}

/** Stable Runtime and computer metadata used by scoped Admin actions. */
export type { RuntimeCatalogEntry, RuntimeCatalogPage, RuntimeId, RuntimeNodeId } from '../../src/runtime-catalog.ts'
/** Effective allocation limits as returned by the Admin wire API. */
export interface RuntimeAllocationPolicy { revision: string; maxTotal: number; maxPerNode: number; source: 'organization' | 'user' }
/** Idempotent allocation receipt; no process is started by allocating. */
export interface RuntimeAllocationReceipt { requestId: string; runtimeId: import('../../src/runtime-catalog.ts').RuntimeId; nodeId: import('../../src/runtime-catalog.ts').RuntimeNodeId; userId: number; status: 'preparing' | 'allocated' | 'retired' }

/** Read one bounded environment page without starting a Runtime. */
export function listRuntimeEnvironments(cursor?: string, signal?: AbortSignal): Promise<import('../../src/runtime-catalog.ts').RuntimeCatalogPage> {
  return request(`/admin/api/runtimes${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { signal })
}
/** Read one user's assignments across computers. */
export function listUserRuntimes(userId: number, cursor?: string, signal?: AbortSignal): Promise<import('../../src/runtime-catalog.ts').RuntimeCatalogPage> {
  return request(`/admin/api/users/${String(userId)}/runtimes${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { signal })
}
/** Read the current effective allocation limits and optimistic revision. */
export function getRuntimeAllocationPolicy(userId?: number, signal?: AbortSignal): Promise<RuntimeAllocationPolicy> {
  return request(`/admin/api/${userId === undefined ? '' : `users/${String(userId)}/`}runtime-allocation-policy`, { signal })
}
/** Save a revision-checked override; null restores organization limits. */
export function saveRuntimeAllocationPolicy(userId: number | undefined, revision: string, limits: { maxTotal: number; maxPerNode: number } | null) {
  return request<RuntimeAllocationPolicy>(`/admin/api/${userId === undefined ? '' : `users/${String(userId)}/`}runtime-allocation-policy`, { method: 'PUT', body: JSON.stringify({ revision, limits }) })
}
/** Allocate a stopped Runtime on the explicitly captured computer with a retry-stable request id. */
export function allocateUserRuntime(userId: number, nodeId: import('../../src/runtime-catalog.ts').RuntimeNodeId, requestId: string) {
  return request<RuntimeAllocationReceipt>(`/admin/api/users/${String(userId)}/runtimes?dshNode=${encodeURIComponent(nodeId)}`, { method: 'POST', body: JSON.stringify({ requestId }) })
}
/** Operate one exact allocation; stop, restart and retire compare its displayed generation. */
export function operateRuntime(runtime: import('../../src/runtime-catalog.ts').RuntimeCatalogEntry, action: 'start' | 'stop' | 'restart' | 'retire') {
  return request(`/admin/api/runtimes/${encodeURIComponent(runtime.id)}/${action}?dshNode=${encodeURIComponent(runtime.node.id)}&dshRuntime=${encodeURIComponent(runtime.id)}`, {
    method: 'POST', body: JSON.stringify(action === 'start' ? {} : { generation: runtime.generation }),
  })
}

/** Current use permission independent of computer connectivity and Runtime allocations. */
export interface AdminComputerPermission { nodeId: import('../../src/runtime-catalog.ts').RuntimeNodeId; name: string; status: 'active' | 'draining' | 'offline'; enabled: boolean; revision: string }
/** Read one bounded page of the user's computer permissions. */
export function listUserComputerPermissions(userId: number, cursor?: string, signal?: AbortSignal): Promise<{ items: AdminComputerPermission[]; nextCursor: import('../../src/runtime-catalog.ts').RuntimeNodeId | null }> {
  return request(`/admin/api/users/${userId}/computers${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { signal })
}
/** Compare the displayed revision before changing one computer's use grant. */
export function saveUserComputerPermission(userId: number, computer: AdminComputerPermission, enabled: boolean): Promise<AdminComputerPermission> {
  return request(`/admin/api/users/${userId}/computers/${encodeURIComponent(computer.nodeId)}`, { method: 'PUT', body: JSON.stringify({ revision: computer.revision, enabled }) })
}

/** Read organization policy from this browser entry; never contact the selected managed computer. */
export async function getDeploymentTopology(signal?: AbortSignal): Promise<DeploymentContext> {
  return deploymentContextSchema.parse(await request<unknown>('/account/api/deployment/context', { cache: 'no-store', ...(signal === undefined ? {} : { signal }) }))
}

/** Save a reviewed mode without changing the current browser selection or form state. */
export async function saveDeploymentTopology(input: { revision: string; enabled: boolean; primaryOrigin?: string }): Promise<DeploymentContext> {
  const result = deploymentContextSchema.parse(await request<unknown>('/admin/api/deployment/topology', { method: 'PUT', body: JSON.stringify(input) }))
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('hgw-deployment-policy-changed'))
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('hgw-deployment-policy')
      channel.postMessage({ revision: result.revision }); channel.close()
    }
  }
  return result
}

/** Inspect the retained attachments that prevent disabling multi-computer mode. */
export async function preflightDeploymentTopology(): Promise<DeploymentPreflight> {
  return deploymentPreflightSchema.parse(await request<unknown>('/admin/api/deployment/topology/preflight', { cache: 'no-store' }))
}

/** Read this computer's independent-agent setup without returning its code or credential. */
export async function getNodeConnection(signal?: AbortSignal): Promise<NodeConnectionView> {
  return nodeConnectionViewSchema.parse(await request<unknown>('/admin/api/deployment/node-connection', { cache: 'no-store', ...(signal === undefined ? {} : { signal }) }))
}

/** Store a one-time code in the target computer's private setup file. */
export async function saveNodeConnection(values: { revision: number; centerUrl: string; enrollmentToken: string }): Promise<NodeConnectionView> {
  return nodeConnectionViewSchema.parse(await request<unknown>('/admin/api/deployment/node-connection', { method: 'POST', body: JSON.stringify({ action: 'save', values }) }))
}

/** Start the fixed, operator-installed Node Agent service. */
export async function startNodeConnection(): Promise<NodeConnectionView> {
  return nodeConnectionViewSchema.parse(await request<unknown>('/admin/api/deployment/node-connection', { method: 'POST', body: JSON.stringify({ action: 'start' }) }))
}

/** Exit managed execution only after Runtime stop and stream quiescence are confirmed. */
export async function detachNodeAccess(node: import('../../src/node-access.ts').NodeAccessEntry): Promise<void> {
  const value = await request<unknown>(`/admin/api/deployment/nodes/access/${encodeURIComponent(node.nodeId)}`, {
    method: 'POST', body: JSON.stringify({ action: 'detach', revision: node.revision }),
  })
  const result = (await import('../../src/node-access.ts')).nodeDetachmentSchema.parse(value)
  if (result.nodeId !== node.nodeId || result.revision !== node.revision + 1) throw new NodeAccessResponseError()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('hgw-deployment-policy-changed'))
    if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('hgw-deployment-policy'); channel.postMessage({ revision: result.topologyRevision }); channel.close() }
  }
}

/** Read one bounded page of already deployed identities without making an enrollment decision. */
export async function listDeploymentCandidates(cursor?: string, signal?: AbortSignal): Promise<import('../../src/deployment-protocol.ts').DeploymentCandidates> {
  return deploymentCandidatesSchema.parse(await request<unknown>(`/admin/api/deployment/topology/candidates${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { cache: 'no-store', ...(signal === undefined ? {} : { signal }) }))
}

/**
 * Verify one selected node's content volume without starting a project Runtime.
 * @param nodeId - selected computer in this Admin document.
 * @param signal - cancellation when the selection or page changes.
 * @returns physical storage health reported by that computer.
 */
export async function getNodeContentHealth(nodeId: string, signal: AbortSignal): Promise<NodeContentHealth> {
  const url = `/admin/api/deployment/node-content?dshNode=${encodeURIComponent(nodeId)}`
  const parsed = nodeContentHealthSchema.safeParse(await request<unknown>(url, { cache: 'no-store', signal }, 'computer'))
  if (!parsed.success || parsed.data.nodeId !== nodeId) throw new Error('Unexpected node content health response')
  return parsed.data
}
