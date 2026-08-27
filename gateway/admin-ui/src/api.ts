export type AdminUser = {
  id: number
  username: string
  displayName: string
  role: 'admin' | 'user'
  status: 'active' | 'disabled'
  homePath: string
  mustChangePassword: boolean
  port: number
  instanceState: string
}

export type Project = {
  id: number
  name: string
  path: string
  memberCount: number
  origin?: 'admin' | 'user'
  modelAccessDefaultAllowed?: boolean
  owner?: { id: number; username: string; displayName: string } | null
  createdBy?: { id: number; username: string; displayName: string } | null
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
}

export type ProjectDirectoryListing = {
  path: string | null
  scope: 'filesystem' | 'configured-roots'
  crumbs: Array<{ name: string; path: string | null }>
  entries: Array<{ name: string; path: string; hidden: boolean }>
  selectable: boolean
  truncated: boolean
}

export type AuditEntry = {
  id: number
  ts: number
  userId: number | null
  action: string
  methodPath: string
  status: number | null
  ip: string
}

export type AuditFilter = {
  userId?: number
  actionPrefix?: string
  from?: number
  to?: number
  limit?: number
  offset?: number
}

export type ConversationArchiveState = 'archived' | 'trash' | 'purged'

export type ConversationArchiveRow = {
  rootSessionId: string
  title: string
  creator: { id: number; displayName: string } | null
  project: { id: number; name: string } | null
  runtime: { kind: 'user' | 'project'; id: number }
  workspace: { path: string; title: string; position: number | null } | null
  state: ConversationArchiveState
  archivedAt: number
  restoredAt: number | null
  trashedAt: number | null
  purgeAfter: number | null
  syncState: 'pending' | 'synced' | 'conflict' | 'unavailable'
  childCount: number
  messageCount: number
  updatedAt: number
  recordKind?: 'empty-draft'
}

export type EmptyDraftCandidate = {
  rootSessionId: string
  runtime: { kind: 'user' | 'project'; id: number }
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
  state: 'active' | 'trash' | 'purged' | 'deleted'
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
  constructor(readonly status: number, message: string) {
    super(message)
    this.name = 'AdminRequestError'
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    let message = `Request failed (${String(res.status)})`
    try {
      const body = await res.json() as { error?: unknown; message?: unknown }
      if (typeof body.error === 'string' && body.error !== '') message = body.error
      else if (typeof body.message === 'string' && body.message !== '') message = body.message
    } catch {
      // Keep the status-only diagnostic when a proxy returns a non-JSON body.
    }
    throw new AdminRequestError(res.status, message)
  }
  if (res.status === 204) return undefined as T
  return await res.json() as T
}

export function listUsers(): Promise<AdminUser[]> {
  return request('/admin/api/users')
}

export function createUser(body: {
  username: string
  password: string
  role?: 'admin' | 'user'
  displayName?: string
}): Promise<AdminUser> {
  return request('/admin/api/users', { method: 'POST', body: JSON.stringify(body) })
}

export function patchUser(id: number, body: {
  displayName?: string
  role?: 'admin' | 'user'
  status?: 'active' | 'disabled'
}): Promise<void> {
  return request(`/admin/api/users/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
}

export function deleteUser(id: number): Promise<void> {
  return request(`/admin/api/users/${id}`, { method: 'DELETE' })
}

export function resetPassword(id: number, password: string): Promise<void> {
  return request(`/admin/api/users/${id}/password`, { method: 'POST', body: JSON.stringify({ password }) })
}

export function controlInstance(id: number, op: 'start' | 'stop' | 'restart'): Promise<void> {
  return request(`/admin/api/users/${id}/instance/${op}`, { method: 'POST' })
}

export function listProjects(origin?: 'admin' | 'user'): Promise<Project[]> {
  return request(`/admin/api/projects${origin === undefined ? '' : `?origin=${origin}`}`)
}

export function listProjectDirectories(path?: string): Promise<ProjectDirectoryListing> {
  const query = path === undefined ? '' : `?${new URLSearchParams({ path }).toString()}`
  return request(`/admin/api/project-directories${query}`)
}

export function createProject(body: { name: string; path?: string }): Promise<Project> {
  return request('/admin/api/projects', { method: 'POST', body: JSON.stringify(body) })
}

export function getProject(id: number): Promise<ProjectDetail> {
  return request(`/admin/api/projects/${id}`)
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

export function listAudit(filter: AuditFilter = {}): Promise<AuditEntry[]> {
  const q = new URLSearchParams()
  if (filter.userId !== undefined) q.set('userId', String(filter.userId))
  if (filter.actionPrefix !== undefined && filter.actionPrefix !== '') q.set('actionPrefix', filter.actionPrefix)
  if (filter.from !== undefined) q.set('from', String(filter.from))
  if (filter.to !== undefined) q.set('to', String(filter.to))
  if (filter.limit !== undefined) q.set('limit', String(filter.limit))
  if (filter.offset !== undefined) q.set('offset', String(filter.offset))
  const qs = q.toString()
  return request(`/admin/api/audit${qs === '' ? '' : `?${qs}`}`)
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
  return request(`/admin/api/archives${suffix === '' ? '' : `?${suffix}`}`)
}

export function previewEmptyDrafts(options: { olderThanMs?: number; limit?: number } = {}): Promise<{
  cutoff: number
  candidates: EmptyDraftCandidate[]
}> {
  const query = new URLSearchParams()
  if (options.olderThanMs !== undefined) query.set('ageMs', String(options.olderThanMs))
  if (options.limit !== undefined) query.set('limit', String(options.limit))
  const suffix = query.toString()
  return request(`/admin/api/archives/empty-drafts/preview${suffix === '' ? '' : `?${suffix}`}`)
}

export function trashEmptyDrafts(ids: string[]): Promise<{ trashed: string[] }> {
  return request('/admin/api/archives/empty-drafts/trash', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export function getArchive(rootSessionId: string, fromSeq = 0, limit = 200): Promise<ConversationArchiveDetail> {
  const query = new URLSearchParams({ fromSeq: String(fromSeq), limit: String(limit) })
  return request(`/admin/api/archives/${encodeURIComponent(rootSessionId)}?${query.toString()}`)
}

export function exportArchive(rootSessionId: string): string {
  return `/admin/api/archives/${encodeURIComponent(rootSessionId)}/export`
}

export function applyArchiveAction(action: 'restore' | 'trash' | 'purge', ids: string[]): Promise<{
  action: string
  results: Array<{ rootSessionId: string; ok: boolean; error?: string }>
}> {
  return request('/admin/api/archives/actions', {
    method: 'POST',
    body: JSON.stringify({ action, ids, idempotencyKey: crypto.randomUUID() }),
  })
}

export function listDocumentMetrics(): Promise<AdminDocumentMetrics> {
  return request('/admin/api/documents/metrics')
}

export async function listAdminDocuments(filter: {
  scope?: 'personal' | 'project'
  projectId?: number
  ownerUserId?: number
  state?: 'active' | 'trash' | 'purged' | 'deleted' | 'all'
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
  state?: 'active' | 'trash' | 'purged' | 'deleted' | 'all'
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
  profile?: Record<string, unknown>
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

export type AdminUsageSummary = UsageSummary & { userId: number; username: string }

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
  return request(`/admin/api/project-model-access?projectId=${projectId}`)
}

export function setProjectModelAccess(
  projectId: number,
  provider: string,
  model: string,
  allowed: boolean | null,
): Promise<void> {
  return request('/admin/api/project-model-access', {
    method: 'PUT', body: JSON.stringify({ projectId, provider, model, allowed }),
  })
}

export function setAllProjectModelAccess(projectId: number, allowed: true | null): Promise<void> {
  return request('/admin/api/project-model-access', {
    method: 'PUT', body: JSON.stringify({ projectId, all: true, allowed }),
  })
}

export function setQuota(body: {
  subjectType: 'role' | 'user' | 'project'
  subjectId: string
  tokenLimit: number | null | 'inherit'
  companyCostMicrosLimit: number | null | 'inherit'
}): Promise<void> {
  return request('/admin/api/quotas', { method: 'PUT', body: JSON.stringify(body) })
}

export function listUsage(month?: string): Promise<AdminUsageSummary[]> {
  return request(`/admin/api/usage${month === undefined || month === '' ? '' : `?month=${encodeURIComponent(month)}`}`)
}

export function listUsageOverview(month?: string): Promise<UsageOverview> {
  return request(`/admin/api/usage/overview${month === undefined || month === '' ? '' : `?month=${encodeURIComponent(month)}`}`)
}

export function listUsageContributors(projectId?: number, month?: string): Promise<UsageContributorReport> {
  const query = new URLSearchParams()
  if (projectId !== undefined) query.set('projectId', String(projectId))
  if (month !== undefined && month !== '') query.set('month', month)
  const suffix = query.toString()
  return request(`/admin/api/usage/contributors${suffix === '' ? '' : `?${suffix}`}`)
}

export function getUsageHealth(month?: string): Promise<UsageHealth> {
  return request(`/admin/api/usage/health${month === undefined || month === '' ? '' : `?month=${encodeURIComponent(month)}`}`)
}

export function getProjectUsage(projectId: number, month?: string): Promise<UsageSummary> {
  const query = new URLSearchParams({ projectId: String(projectId) })
  if (month !== undefined && month !== '') query.set('month', month)
  return request(`/admin/api/usage?${query.toString()}`)
}
