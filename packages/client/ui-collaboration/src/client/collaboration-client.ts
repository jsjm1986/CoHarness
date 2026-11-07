import { addressRuntimeUrl, parseClientSessionKey, runtimeTargetKey } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, readApiResponseJson } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionRuntimeTarget } from '@deepseek-ai/dsh-client-runtime/client'
import { readSpaceNavigationPreferences, recordSpaceVisit, savedSpaceRuntimeIds, toggleSpaceFavorite } from './space-navigation-preferences.ts'

/** Authorized computer identity retained by project creation. */
export type CollaborationComputerId = NonNullable<SessionRuntimeTarget['nodeId']>
/** One metadata-only computer choice; discovery starts no Runtime. */
export interface CollaborationComputer { nodeId: CollaborationComputerId; name: string; status: string }

/** One complete work destination from the authenticated, bounded Gateway directory. */
export interface CollaborationEnvironment {
  target: SessionRuntimeTarget
  name: string
  nodeName: string
  observedState: string
  nodeStatus?: 'active' | 'draining' | 'offline'
  provisioning?: 'preparing' | 'ready'
  routing?: 'local' | 'unavailable'
}

/** A page of authorized environments; browsing starts no Runtime. */
export interface CollaborationEnvironmentPage {
  items: CollaborationEnvironment[]
  nextCursor: string | null
}
import type {
  ProjectModelSettingsTransport,
  ProjectModelSettingsView,
} from '@deepseek-ai/dsh-client-connection/client'

/** Visibility of a root conversation inside one project. */
export type CollaborationVisibility = 'project' | 'private'

/** Project UI policy returned by the Gateway. */
export type ProjectThemePolicy = 'follow-user' | 'light' | 'dark'

/** One project membership exposed by the Gateway account context. */
export interface ProjectMembership {
  projectId: number
  name: string
  path: string
  mode: 'ro' | 'rw'
  /** Fixed project computer, retained even before its first conversation exists. */
  nodeId?: CollaborationComputerId
  nodeName?: string
  /** Whether the account may invite members or rename this project. */
  canManage?: boolean
  /** Whether this is a server-admin or user-created project. */
  origin?: 'admin' | 'user'
  /** Project owner; administrator projects intentionally have no owner. */
  owner?: { id: number; username: string; displayName: string } | null
  /** Theme policy applied while this project is active. */
  uiThemePolicy?: ProjectThemePolicy
  /** Reserved space category; `steward` marks the resident maintenance space. */
  kind?: 'standard' | 'steward'
}

/** One project invitation returned by the account API. */
export interface ProjectInvitation {
  id: string
  projectId: number
  projectName: string
  invitee: { id: number; username: string; displayName: string }
  inviter: { id: number; username: string; displayName: string }
  mode: 'ro' | 'rw'
  status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'
  expiresAt: string | null
  createdAt: string
  respondedAt: string | null
}

/** Authenticated user fields required by collaboration presentation. */
export interface CollaborationUser {
  id: number
  username: string
  displayName: string
  role: string
}

/** Minimal user view for the invitation member picker. */
export interface UserSummary {
  id: number
  username: string
  displayName: string
}

/** Active Gateway scope for the browser page. */
export type CollaborationScope =
  | { kind: 'personal' }
  | {
    kind: 'project'
    projectId: number
    projectName: string
    mode: 'ro' | 'rw'
    canManage?: boolean
    uiThemePolicy?: ProjectThemePolicy
    /** True while the active scope is the reserved steward maintenance space. */
    steward?: boolean
  }

/** Target scope shown while the Gateway prepares the next runtime. */
export type CollaborationScopeTarget =
  ({ kind: 'personal' } | { kind: 'project'; projectId: number; projectName: string })
  & { nodeName?: string }

/** Gateway account context used by the scope selector and create policy. */
export interface CollaborationContext {
  user: CollaborationUser
  scope: CollaborationScope
  projects: ProjectMembership[]
  /** Whether the current account may select the administrator full-access preset. */
  fullAccess?: boolean
  /** Whether this account may use automatic approval review. */
  autoReviewEligible?: boolean
  /** Exact environment verified by this page's authenticated Gateway request. */
  environment?: { id: NonNullable<SessionRuntimeTarget['runtimeId']>; nodeId: NonNullable<SessionRuntimeTarget['nodeId']>; nodeName?: string }
}

/** Project configuration facts consumed by the user-facing project panel. */
export interface ProjectConfiguration {
  project: {
    id: number
    name: string
    origin?: 'admin' | 'user'
    owner?: { id: number; username: string; displayName: string } | null
    themePolicy: ProjectThemePolicy
  }
  canManage: boolean
  capabilities: {
    themePolicy: boolean
    runtimeSettings: boolean
    projectModels: boolean
    members: boolean
    sshTargets: boolean
    filesystem: false
  }
}

/** One organization SSH target with its share state toward the viewed project. */
export interface ProjectSshTarget {
  publicId: number
  name: string
  host: string
  workspace: string
  enabled: boolean
  shared: boolean
}

/** One user who has contributed to a shared root conversation. */
export interface ConversationParticipant {
  userId: number
  displayName: string
  contributionCount: number
  lastContributedAt: number
}

/** Shared root-conversation metadata displayed in the session header. */
export interface ConversationCollaboration {
  sessionId: string
  creatorUserId: number
  creatorDisplayName: string
  visibility: CollaborationVisibility
  participants: ConversationParticipant[]
  updatedAt: number
}

/** Effective access for the requested session and its root conversation. */
export interface ConversationAccess {
  sessionId: string
  rootSessionId: string
  projectId: number
  visibility: CollaborationVisibility
  creatorUserId: number
  mode: 'ro' | 'rw'
  canRead: true
  canWrite: boolean
  canManage: boolean
}

/** Response returned for one session's collaboration header action. */
export interface ConversationDetail {
  access: ConversationAccess
  conversation: ConversationCollaboration | null
}

/** Per-session detail state kept by the collaboration client. */
export type ConversationDetailState =
  | { status: 'loading'; saving: false }
  | { status: 'error'; saving: false; error: 'load-failed' }
  | { status: 'ready'; detail: ConversationDetail; saving: boolean; error?: 'visibility-locked' | 'update-failed' }

/** Stable observable state shared by the collaboration UI entries. */
export interface CollaborationSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** Current-generation account eligibility; retained display data is not authority. */
  contextVerified: boolean
  context?: CollaborationContext
  stagedVisibility: CollaborationVisibility
  scopeBusy: boolean
  /** Scope currently being prepared; present only during a switch request. */
  scopeTarget?: CollaborationScopeTarget
  scopeError?: string
  /** Exact attempted destination, retained for an explicit retry in this document. */
  scopeFailedTarget?: SessionRuntimeTarget
  /** Prepared target offered in a separate tab while this tab retains transient input. */
  scopeOffer?: { runtimeId: string; target: CollaborationScopeTarget }
  conversations: Record<string, ConversationDetailState>
  /** Metadata resolved only for saved shortcut IDs, through current Gateway authorization. */
  preferredEnvironments?: CollaborationEnvironment[]
  environments?: CollaborationEnvironmentPage
  environmentsLoading?: boolean
  environmentsError?: boolean
  favoriteRuntimeIds?: string[]
  recentRuntimeIds?: string[]
  spacePreferencesError?: boolean
  /** Cursor of the last appended page. An explicit first-page refresh replaces loaded metadata. */
  environmentsCursor?: string
}

/** HTTP operations required by the collaboration state owner. */
export interface CollaborationTransport {
  loadContext: (signal: AbortSignal) => Promise<CollaborationContext>
  switchScope: (scope: SessionRuntimeTarget, signal: AbortSignal) => Promise<void | string>
  /** Read one center-owned directory page without connecting to its computers. */
  loadEnvironments?: (cursor: string | undefined, signal: AbortSignal) => Promise<CollaborationEnvironmentPage>
  /** Resolve saved identities without enumerating nodes or starting Runtimes. */
  loadPreferredEnvironments?: (ids: readonly string[], signal: AbortSignal) => Promise<CollaborationEnvironment[]>
  loadConversation: (sessionId: string, signal: AbortSignal) => Promise<ConversationDetail>
  setVisibility: (sessionId: string, visibility: CollaborationVisibility, signal: AbortSignal) => Promise<void>
  /** Load the logical project configuration without exposing host paths. */
  loadProjectConfiguration?: (projectId: number, signal: AbortSignal) => Promise<ProjectConfiguration>
  /** Persist the project UI theme policy after an authorization check. */
  setProjectThemePolicy?: (projectId: number, policy: ProjectThemePolicy, signal: AbortSignal) => Promise<ProjectConfiguration>
  /** Gateway-owned project Provider settings; available to project managers. */
  projectModels?: ProjectModelSettingsTransport
  /** Organization SSH targets with this project's share flags; project managers only. */
  listProjectSshTargets?: (projectId: number, signal: AbortSignal) => Promise<ProjectSshTarget[]>
  /** Share or unshare one organization SSH target with the project; project managers only. */
  shareProjectSshTarget?: (
    projectId: number,
    targetId: number,
    shared: boolean,
    signal: AbortSignal,
  ) => Promise<{ publicId: number; name: string; shared: boolean }>
  /** Optional account project-management operations. */
  createProject?: (name: string, signal: AbortSignal, nodeId?: CollaborationComputerId) => Promise<{ projectId: number }>
  /** Read authorized computers without contacting their Runtimes. */
  listComputers?: (signal: AbortSignal) => Promise<CollaborationComputer[]>
  listInvitations?: (projectId: number | undefined, signal: AbortSignal) => Promise<ProjectInvitation[]>
  inviteMember?: (projectId: number, username: string, mode: 'ro' | 'rw', signal: AbortSignal) => Promise<ProjectInvitation>
  acceptInvitation?: (invitationId: string, signal: AbortSignal) => Promise<void>
  /** List active users for the invitation member picker. */
  listUsers?: (signal: AbortSignal, projectId?: number) => Promise<UserSummary[]>
  /** Count pending invitations where the current user is the invitee. */
  getInvitationCount?: (signal: AbortSignal) => Promise<{ pending: number }>
  reload: (destination?: string) => void
  /** False retains transient input in this tab and offers the prepared environment in a new tab. */
  canNavigate?: () => boolean
}

/** HTTP error retaining the Gateway's machine-readable collaboration code. */
export class CollaborationRequestError extends Error {
  /**
   * @param status - HTTP response status.
   * @param code - optional Gateway error code.
   */
  constructor(readonly status: number, readonly code?: string) {
    super(code ?? `collaboration request failed with status ${status}`)
    this.name = 'CollaborationRequestError'
  }
}

function scopeFailure(cause: unknown): string {
  if (!(cause instanceof CollaborationRequestError)) return 'switch-failed'
  if (cause.status === 401) return 'auth'
  if (cause.status === 403) return 'forbidden'
  if (cause.status === 404) return 'retired'
  switch (cause.code) {
    case 'runtime-management/quota-exceeded': return 'quota'
    case 'runtime-management/provisioning-pending': return 'preparing'
    case 'node-service/busy': return 'busy'
    case 'node-service/unavailable':
    case 'node-service/closed':
    case 'runtime-catalog/remote-unavailable': return 'offline'
    case 'node-service/timeout': return 'timeout'
    default: return 'switch-failed'
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid collaboration response')
  }
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('invalid collaboration response')
  return value
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('invalid collaboration response')
  }
  return value
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('invalid collaboration response')
  return value
}

function mode(value: unknown): 'ro' | 'rw' {
  if (value !== 'ro' && value !== 'rw') throw new Error('invalid collaboration response')
  return value
}

function themePolicy(value: unknown): ProjectThemePolicy {
  if (value !== 'follow-user' && value !== 'light' && value !== 'dark') throw new Error('invalid collaboration response')
  return value
}

function actor(value: unknown): { id: number; username: string; displayName: string } {
  const row = object(value)
  return { id: integer(row.id), username: string(row.username), displayName: string(row.displayName) }
}

function invitationStatus(value: unknown): ProjectInvitation['status'] {
  if (value !== 'pending' && value !== 'accepted' && value !== 'declined'
    && value !== 'revoked' && value !== 'expired') throw new Error('invalid collaboration response')
  return value
}

function nullableString(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw new Error('invalid collaboration response')
  return value
}

function visibility(value: unknown): CollaborationVisibility {
  if (value !== 'project' && value !== 'private') throw new Error('invalid collaboration response')
  return value
}

function project(value: unknown): ProjectMembership {
  const row = object(value)
  if (row.nodeId !== undefined && !uuid(row.nodeId)) throw new Error('invalid collaboration project computer')
  return {
    projectId: integer(row.projectId),
    name: string(row.name),
    path: string(row.path),
    mode: mode(row.mode),
    ...(row.nodeId === undefined ? {} : { nodeId: row.nodeId as CollaborationComputerId }),
    ...(row.nodeName === undefined ? {} : { nodeName: string(row.nodeName) }),
    ...(row.canManage === true ? { canManage: true } : {}),
    ...(row.origin === 'admin' || row.origin === 'user' ? { origin: row.origin } : {}),
    ...(row.owner === null ? { owner: null } : row.owner === undefined ? {} : { owner: actor(row.owner) }),
    ...(row.uiThemePolicy === undefined ? {} : { uiThemePolicy: themePolicy(row.uiThemePolicy) }),
    ...(row.kind === 'steward' ? { kind: 'steward' as const } : {}),
  }
}

function invitation(value: unknown): ProjectInvitation {
  const row = object(value)
  return {
    id: string(row.id),
    projectId: integer(row.projectId),
    projectName: string(row.projectName),
    invitee: actor(row.invitee),
    inviter: actor(row.inviter),
    mode: mode(row.mode),
    status: invitationStatus(row.status),
    expiresAt: nullableString(row.expiresAt),
    createdAt: string(row.createdAt),
    respondedAt: nullableString(row.respondedAt),
  }
}

function createdProject(value: unknown): { projectId: number } {
  const row = object(value)
  return { projectId: integer(row.id) }
}

/**
 * Decode the account-context response at the HTTP trust boundary.
 * @param value - parsed JSON response.
 * @returns validated collaboration context.
 */
export function parseCollaborationContext(value: unknown): CollaborationContext {
  const root = object(value)
  const user = object(root.user)
  const scope = object(root.scope)
  const environment = root.environment === undefined ? undefined : object(root.environment)
  if (environment !== undefined && (!uuid(environment.id) || !uuid(environment.nodeId)
    || environment.nodeName !== undefined && typeof environment.nodeName !== 'string')) throw new Error('invalid collaboration environment')
  if (!Array.isArray(root.projects)) throw new Error('invalid collaboration response')
  const parsedScope: CollaborationScope = scope.kind === 'personal'
    ? { kind: 'personal' }
    : scope.kind === 'project'
      ? {
        kind: 'project',
        projectId: integer(scope.projectId),
        projectName: string(scope.projectName),
        mode: mode(scope.mode),
        ...(scope.canManage === true ? { canManage: true } : {}),
        ...(scope.steward === true ? { steward: true } : {}),
        ...(scope.uiThemePolicy === undefined ? {} : { uiThemePolicy: themePolicy(scope.uiThemePolicy) }),
      }
      : (() => { throw new Error('invalid collaboration response') })()
  return {
    user: {
      id: integer(user.id),
      username: string(user.username),
      displayName: string(user.displayName),
      role: string(user.role),
    },
    scope: parsedScope,
    projects: root.projects.map(project),
    ...(environment === undefined ? {} : { environment: {
      id: environment.id as NonNullable<SessionRuntimeTarget['runtimeId']>,
      nodeId: environment.nodeId as NonNullable<SessionRuntimeTarget['nodeId']>,
      ...(typeof environment.nodeName === 'string' ? { nodeName: environment.nodeName } : {}),
    } }),
    ...(root.fullAccess === undefined ? {} : { fullAccess: boolean(root.fullAccess) }),
    ...(root.autoReviewEligible === undefined ? {} : { autoReviewEligible: boolean(root.autoReviewEligible) }),
  }
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
}

function environmentPage(value: unknown): CollaborationEnvironmentPage {
  const root = object(value)
  if (!Array.isArray(root.items) || root.nextCursor !== null && typeof root.nextCursor !== 'string') throw new Error('invalid environment directory')
  const items = root.items.map((value): CollaborationEnvironment => {
    const row = object(value), owner = object(row.owner), node = object(row.node)
    if (!uuid(row.id) || !uuid(node.id) || typeof node.name !== 'string'
      || owner.kind !== 'personal' && owner.kind !== 'project') throw new Error('invalid environment directory')
    const location = { runtimeId: row.id as NonNullable<SessionRuntimeTarget['runtimeId']>,
      nodeId: node.id as NonNullable<SessionRuntimeTarget['nodeId']>, nodeName: node.name }
    const target: SessionRuntimeTarget = owner.kind === 'personal' ? { kind: 'personal', ...location }
      : { kind: 'project', projectId: integer(owner.id), projectName: string(owner.name), ...location }
    if (node.status !== undefined && node.status !== 'active' && node.status !== 'draining' && node.status !== 'offline'
      || row.provisioning !== undefined && row.provisioning !== 'ready' && row.provisioning !== 'preparing'
      || row.routing !== undefined && row.routing !== 'local' && row.routing !== 'unavailable') throw new Error('invalid environment state')
    return { target, name: string(owner.name), nodeName: node.name, observedState: string(row.observedState),
      ...(node.status === undefined ? {} : { nodeStatus: node.status }),
      ...(row.provisioning === undefined ? {} : { provisioning: row.provisioning }),
      ...(row.routing === undefined ? {} : { routing: row.routing }) }
  })
  return { items, nextCursor: root.nextCursor }
}

/** Decode a project configuration response at the browser trust boundary.
 * @param value - untrusted JSON response.
 * @returns the validated project configuration.
 */
export function parseProjectConfiguration(value: unknown): ProjectConfiguration {
  const root = object(value)
  const projectValue = object(root.project)
  const capabilities = object(root.capabilities)
  if (typeof root.canManage !== 'boolean'
    || capabilities.filesystem !== false
    || typeof capabilities.themePolicy !== 'boolean'
    || typeof capabilities.runtimeSettings !== 'boolean'
    || typeof capabilities.projectModels !== 'boolean'
    || typeof capabilities.members !== 'boolean'
    || typeof capabilities.sshTargets !== 'boolean') {
    throw new Error('invalid project configuration response')
  }
  const origin = projectValue.origin
  if (origin !== undefined && origin !== 'admin' && origin !== 'user') throw new Error('invalid project configuration response')
  const owner = projectValue.owner === undefined || projectValue.owner === null
    ? projectValue.owner
    : actor(projectValue.owner)
  return {
    project: {
      id: integer(projectValue.id),
      name: string(projectValue.name),
      ...(origin === undefined ? {} : { origin }),
      ...(owner === undefined ? {} : { owner }),
      themePolicy: themePolicy(projectValue.themePolicy),
    },
    canManage: root.canManage,
    capabilities: {
      themePolicy: capabilities.themePolicy,
      runtimeSettings: capabilities.runtimeSettings,
      projectModels: capabilities.projectModels,
      members: capabilities.members,
      sshTargets: capabilities.sshTargets,
      filesystem: false,
    },
  }
}

/** Decode the project SSH target list at the browser trust boundary.
 * @param value - untrusted JSON response.
 * @returns the validated project-scoped target rows.
 */
export function parseProjectSshTargets(value: unknown): ProjectSshTarget[] {
  const root = object(value)
  if (!Array.isArray(root.targets)) throw new Error('invalid ssh target response')
  return root.targets.map((row: unknown) => {
    const target = object(row)
    return {
      publicId: integer(target.publicId),
      name: string(target.name),
      host: string(target.host),
      workspace: string(target.workspace),
      enabled: target.enabled === true,
      shared: target.shared === true,
    }
  })
}

function participant(value: unknown): ConversationParticipant {
  const row = object(value)
  return {
    userId: integer(row.userId),
    displayName: string(row.displayName),
    contributionCount: integer(row.contributionCount),
    lastContributedAt: integer(row.lastContributedAt),
  }
}

function conversation(value: unknown): ConversationCollaboration {
  const row = object(value)
  if (!Array.isArray(row.participants)) throw new Error('invalid collaboration response')
  return {
    sessionId: string(row.sessionId),
    creatorUserId: integer(row.creatorUserId),
    creatorDisplayName: string(row.creatorDisplayName),
    visibility: visibility(row.visibility),
    participants: row.participants.map(participant),
    updatedAt: integer(row.updatedAt),
  }
}

/**
 * Decode one conversation collaboration response at the HTTP trust boundary.
 * @param value - parsed JSON response.
 * @returns validated access and root-conversation metadata.
 */
export function parseConversationDetail(value: unknown): ConversationDetail {
  const root = object(value)
  const access = object(root.access)
  if (access.canRead !== true) throw new Error('invalid collaboration response')
  return {
    access: {
      sessionId: string(access.sessionId),
      rootSessionId: string(access.rootSessionId),
      projectId: integer(access.projectId),
      visibility: visibility(access.visibility),
      creatorUserId: integer(access.creatorUserId),
      mode: mode(access.mode),
      canRead: true,
      canWrite: boolean(access.canWrite),
      canManage: boolean(access.canManage),
    },
    conversation: root.conversation === null ? null : conversation(root.conversation),
  }
}

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = object(await readApiResponseJson(response))
    return typeof body.error === 'string' ? body.error : undefined
  } catch (_invalidErrorResponse) {
    return undefined
  }
}

async function jsonRequest<T>(
  fetcher: typeof fetch,
  path: string,
  init: RequestInit,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetcher(path, { credentials: 'same-origin', ...init })
  if (!response.ok) throw new CollaborationRequestError(response.status, await errorCode(response))
  return parse(await readApiResponseJson(response))
}

async function emptyRequest(fetcher: typeof fetch, path: string, init: RequestInit): Promise<void> {
  const response = await fetcher(path, { credentials: 'same-origin', ...init })
  if (!response.ok) throw new CollaborationRequestError(response.status, await errorCode(response))
}

/** Resolve a Session's project from its explicit runtime, retaining standalone legacy callers.
 * @param snapshot - authenticated account metadata.
 * @param sessionId - browser Session identity, or absence for the current-space creation flow.
 * @returns the owning project, or undefined for personal/unverified resources.
 */
export function conversationProject(snapshot: CollaborationSnapshot, sessionId?: string): number | undefined {
  const target = sessionId === undefined ? undefined : parseClientSessionKey(sessionId)?.runtime
  if (target?.kind === 'personal') return undefined
  if (target?.kind === 'project') return snapshot.context?.projects.some(project => project.projectId === target.projectId) === true ? target.projectId : undefined
  return snapshot.context?.scope.kind === 'project' ? snapshot.context.scope.projectId : undefined
}

function conversationUrl(sessionId: string): string {
  const address = parseClientSessionKey(sessionId)
  const path = `/account/api/conversations/${encodeURIComponent(address?.sessionId ?? sessionId)}`
  if (address?.runtime.kind === 'personal') throw new Error('Personal Sessions have no project sharing policy')
  const url = new URL(path, 'http://gateway')
  if (address !== undefined) {
    url.searchParams.set('projectId', String(address.runtime.projectId))
    addressRuntimeUrl(url, address.runtime)
  } else {
    const runtimeId = new URLSearchParams((globalThis as { location?: Pick<Location, 'search'> }).location?.search).get('dshRuntime')
    if (runtimeId !== null) url.searchParams.set('dshRuntime', runtimeId)
  }
  return `${url.pathname}${url.search}`
}

/**
 * Create the browser transport for Gateway account collaboration endpoints.
 * @param options - browser transport overrides and the current input recovery check.
 * @returns fetch-backed collaboration operations and full-page scope reload.
 */
export function createBrowserCollaborationTransport(options: {
  fetch?: typeof fetch
  reload?: (destination?: string) => void
  canNavigate?: () => boolean
  projectModels?: ProjectModelSettingsTransport
} = {}): CollaborationTransport {
  const fetcher = options.fetch ?? globalThis.fetch
  const reload = options.reload ?? ((destination?: string) => {
    if (destination === undefined) window.location.reload()
    else window.location.assign(destination)
  })
  const jsonHeaders = { 'content-type': 'application/json' }
  const projectModels = options.projectModels
  return {
    canNavigate: options.canNavigate ?? (() => true),
    loadContext: (signal) => {
      const runtime = new URLSearchParams((globalThis as { location?: Pick<Location, 'search'> }).location?.search).get('dshRuntime')
      const path = `/account/api/context${runtime === null ? '' : `?dshRuntime=${encodeURIComponent(runtime)}`}`
      return jsonRequest(fetcher, path, { signal }, parseCollaborationContext)
    },
    switchScope: async (scope, signal) => {
      const suffix = scope.runtimeId === undefined ? '' : `?dshRuntime=${encodeURIComponent(scope.runtimeId)}`
      const response = await fetcher(`/account/api/scope${suffix}`, {
        method: 'POST', signal, credentials: 'same-origin', headers: jsonHeaders,
        body: JSON.stringify(scope.kind === 'personal' ? { kind: 'personal' } : { kind: 'project', projectId: scope.projectId }),
      })
      if (!response.ok) throw new CollaborationRequestError(response.status, await errorCode(response))
      const destination = response.headers.get('location')
      if (destination === null) return
      if (!/^\/\?dshRuntime=[0-9a-f-]{36}$/u.test(destination)) throw new Error('invalid scope destination')
      return destination
    },
    loadEnvironments: async (cursor, signal) => {
      const response = await fetcher(`/account/api/runtimes${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { signal, credentials: 'same-origin' })
      if (response.status === 404 || response.status === 501) return { items: [], nextCursor: null }
      if (!response.ok) throw new CollaborationRequestError(response.status, await errorCode(response))
      return environmentPage(await readApiResponseJson(response))
    },
    loadPreferredEnvironments: async (ids, signal) => {
      const items: CollaborationEnvironment[] = []
      for (let offset = 0; offset < ids.length; offset += 32) {
        const selected = ids.slice(offset, offset + 32)
        let cursor: string | null = null
        do {
          const query = new URLSearchParams({ ids: selected.join(',') })
          if (cursor !== null) query.set('cursor', cursor)
          const page = await jsonRequest(fetcher, `/account/api/runtimes?${query}`, { signal }, environmentPage)
          items.push(...page.items)
          cursor = page.nextCursor
        } while (cursor !== null && !signal.aborted)
      }
      return items
    },
    loadConversation: (sessionId, signal) => jsonRequest(
      fetcher,
      conversationUrl(sessionId),
      { signal },
      parseConversationDetail,
    ),
    setVisibility: (sessionId, nextVisibility, signal) => emptyRequest(
      fetcher,
      conversationUrl(sessionId),
      {
        method: 'PATCH', signal, headers: jsonHeaders,
        body: JSON.stringify({ visibility: nextVisibility }),
      },
    ),
    loadProjectConfiguration: (projectId, signal) => jsonRequest(
      fetcher,
      `/account/api/projects/${String(projectId)}/configuration`,
      { signal },
      parseProjectConfiguration,
    ),
    setProjectThemePolicy: (projectId, policy, signal) => jsonRequest(
      fetcher,
      `/account/api/projects/${String(projectId)}/configuration`,
      {
        method: 'PATCH', signal, headers: jsonHeaders,
        body: JSON.stringify({ themePolicy: policy }),
      },
      parseProjectConfiguration,
    ),
    ...(projectModels === undefined ? {} : { projectModels }),
    listProjectSshTargets: (projectId, signal) => jsonRequest(
      fetcher,
      `/account/api/projects/${String(projectId)}/ssh-targets`,
      { signal },
      parseProjectSshTargets,
    ),
    shareProjectSshTarget: (projectId, targetId, shared, signal) => jsonRequest(
      fetcher,
      `/account/api/projects/${String(projectId)}/ssh-targets`,
      {
        method: 'POST', signal, headers: jsonHeaders,
        body: JSON.stringify({ targetId, shared }),
      },
      (value) => {
        const target = object(value)
        return { publicId: integer(target.publicId), name: string(target.name), shared: target.shared === true }
      },
    ),
    createProject: (name, signal, nodeId) => jsonRequest(
      fetcher, `/account/api/projects${nodeId === undefined ? '' : `?dshNode=${encodeURIComponent(nodeId)}`}`, {
        method: 'POST', signal, headers: jsonHeaders, body: JSON.stringify({ name }),
      }, createdProject,
    ),
    listInvitations: (projectId, signal) => jsonRequest(
      fetcher,
      projectId === undefined
        ? '/account/api/invitations'
        : `/account/api/projects/${String(projectId)}/invitations`,
      { signal },
      (value) => {
        if (!Array.isArray(value)) throw new Error('invalid collaboration response')
        return value.map(invitation)
      },
    ),
    inviteMember: (projectId, username, memberMode, signal) => jsonRequest(
      fetcher, `/account/api/projects/${String(projectId)}/invitations`, {
        method: 'POST', signal, headers: jsonHeaders,
        body: JSON.stringify({ username, mode: memberMode }),
      }, invitation,
    ),
    acceptInvitation: (invitationId, signal) => emptyRequest(
      fetcher, `/account/api/invitations/${encodeURIComponent(invitationId)}/accept`, {
        method: 'POST', signal, headers: jsonHeaders,
      },
    ),
    listComputers: async (signal) => {
      const items: CollaborationComputer[] = []
      const seen = new Set<string>()
      let cursor: string | null = null
      do {
        const page: { items: CollaborationComputer[]; nextCursor: string | null } = await jsonRequest(
          fetcher, `/account/api/computers${cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`}`, { signal }, (value) => {
            const row = object(value)
            if (!Array.isArray(row.items) || row.nextCursor !== null && typeof row.nextCursor !== 'string') throw new Error('invalid collaboration response')
            return { items: row.items.map((candidate) => { const entry = object(candidate)
              const id = string(entry.nodeId)
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) throw new Error('invalid computer identity')
              return { nodeId: id as CollaborationComputerId, name: string(entry.name), status: string(entry.status) }
            }), nextCursor: row.nextCursor }
          })
        items.push(...page.items); cursor = page.nextCursor
        if (cursor !== null && seen.has(cursor)) throw new Error('Computer directory repeated a cursor')
        if (cursor !== null) seen.add(cursor)
      } while (cursor !== null && !signal.aborted)
      return items
    },
    listUsers: async (signal, projectId) => {
      const parseUsers = (value: unknown): UserSummary[] => {
        if (!Array.isArray(value)) throw new Error('invalid collaboration response')
        return value.map((row: unknown) => {
          const u = object(row)
          return { id: integer(u.id), username: string(u.username), displayName: string(u.displayName) }
        })
      }
      if (projectId === undefined) return jsonRequest(fetcher, '/account/api/users', { signal }, parseUsers)
      const items: UserSummary[] = []
      const seen = new Set<number>()
      let cursor: number | null = null
      do {
        const page: { items: UserSummary[]; nextCursor: number | null } = await jsonRequest(fetcher,
          `/account/api/projects/${String(projectId)}/invitable-users${cursor === null ? '' : `?cursor=${String(cursor)}`}`, { signal }, (value) => {
            const row = object(value)
            return { items: parseUsers(row.items), nextCursor: row.nextCursor === null ? null : integer(row.nextCursor) }
          })
        items.push(...page.items); cursor = page.nextCursor
        if (cursor !== null && seen.has(cursor)) throw new Error('Invitation directory repeated a cursor')
        if (cursor !== null) seen.add(cursor)
      } while (cursor !== null && !signal.aborted)
      return items
    },
    getInvitationCount: signal => jsonRequest(
      fetcher, '/account/api/invitations/count', { signal },
      (value) => {
        const body = object(value)
        return { pending: integer(body.pending) }
      },
    ),
    reload,
  }
}

function initialSnapshot(): CollaborationSnapshot {
  return {
    status: 'idle',
    contextVerified: false,
    stagedVisibility: 'project',
    scopeBusy: false,
    conversations: {},
  }
}

/** React-free state owner for Gateway project and shared-conversation data. */
export class CollaborationClient {
  private readonly store = createSnapshotStore(initialSnapshot())
  private readonly abortController = new AbortController()
  private readonly conversationLoads = new Map<string, Promise<void>>()
  private readonly conversationRefreshPending = new Set<string>()
  private contextLoad: { promise: Promise<void>; controller: AbortController } | undefined
  private disposed = false
  private environmentLoad: { promise: Promise<void>; controller: AbortController; userId: number } | undefined
  private preferredLoad: AbortController | undefined
  private scopeSwitch: AbortController | undefined
  private lastVisitedSpace: string | undefined

  /**
   * @param transport - Gateway account transport.
   */
  constructor(private readonly transport: CollaborationTransport) {}

  /**
   * Replace or append center directory metadata without connecting to a target computer.
   * @param cursor - continuation to append; omitted to replace loaded metadata from the first page.
   * @returns after the owned read settles; failures retain displayed entries.
   */
  loadEnvironments(cursor?: string): Promise<void> {
    const loadDirectory = this.transport.loadEnvironments
    if (this.disposed || loadDirectory === undefined) return Promise.resolve()
    const snapshot = this.getSnapshot()
    const userId = snapshot.context?.user.id
    if (!snapshot.contextVerified || userId === undefined) return Promise.resolve()
    if (this.environmentLoad !== undefined && this.environmentLoad.userId === userId) return this.environmentLoad.promise
    this.environmentLoad?.controller.abort()
    const controller = new AbortController()
    this.store.update((draft) => { draft.environmentsLoading = true })
    const pending = Promise.resolve().then(() => loadDirectory(cursor, controller.signal)).then((page) => {
      if (this.disposed || controller.signal.aborted || this.getSnapshot().context?.user.id !== userId) return
      this.store.update((draft) => {
        const previous = cursor === undefined ? [] : draft.environments?.items ?? []
        const items = new Map(previous.map(item => [runtimeTargetKey(item.target), item]))
        for (const item of page.items) items.set(runtimeTargetKey(item.target), item)
        draft.environments = { items: [...items.values()], nextCursor: page.nextCursor }
        draft.environmentsError = false
        if (cursor === undefined) delete draft.environmentsCursor
        else draft.environmentsCursor = cursor
      })
      this.refreshSpacePreferences()
    }, () => {
      if (!this.disposed && !controller.signal.aborted) this.store.update((draft) => { draft.environmentsError = true })
    }).finally(() => {
      if (this.environmentLoad?.controller !== controller) return
      this.environmentLoad = undefined
      if (!this.disposed) this.store.update((draft) => { draft.environmentsLoading = false })
    })
    this.environmentLoad = { promise: pending, controller, userId }
    return cursor === undefined ? Promise.all([pending, this.loadPreferredEnvironments(userId)]).then(() => {}) : pending
  }

  private async loadPreferredEnvironments(userId: number): Promise<void> {
    if (this.transport.loadPreferredEnvironments === undefined) return
    this.preferredLoad?.abort()
    const controller = new AbortController()
    this.preferredLoad = controller
    const ids = savedSpaceRuntimeIds(userId)
    try {
      const items = ids.length === 0 ? [] : await this.transport.loadPreferredEnvironments(ids, controller.signal)
      if (this.disposed || controller.signal.aborted || !this.getSnapshot().contextVerified
        || this.getSnapshot().context?.user.id !== userId) return
      this.store.update((draft) => { draft.preferredEnvironments = items; draft.spacePreferencesError = false })
      this.refreshSpacePreferences()
    } catch (cause) {
      if (!controller.signal.aborted && !this.disposed) this.store.update((draft) => {
        draft.spacePreferencesError = true
        if (cause instanceof CollaborationRequestError && (cause.status === 401 || cause.status === 403)) delete draft.preferredEnvironments
      })
    } finally { if (this.preferredLoad === controller) this.preferredLoad = undefined }
  }

  private clearEnvironments(): void {
    this.preferredLoad?.abort()
    this.preferredLoad = undefined
    this.environmentLoad?.controller.abort()
    this.environmentLoad = undefined
    this.scopeSwitch?.abort()
    this.scopeSwitch = undefined
    this.store.update((draft) => {
      delete draft.environments
      delete draft.preferredEnvironments
      delete draft.environmentsCursor
      delete draft.environmentsError
      delete draft.scopeOffer
      delete draft.scopeFailedTarget
      delete draft.scopeTarget
      draft.scopeBusy = false
      delete draft.favoriteRuntimeIds
      delete draft.recentRuntimeIds
      delete draft.spacePreferencesError
      draft.environmentsLoading = false
    })
  }

  private refreshSpacePreferences(): void {
    const snapshot = this.getSnapshot()
    if (!snapshot.contextVerified || snapshot.context === undefined) return
    const ids = [...(snapshot.environments?.items ?? []), ...(snapshot.preferredEnvironments ?? [])]
      .flatMap(item => item.target.runtimeId === undefined ? [] : [item.target.runtimeId])
    if (snapshot.context.environment !== undefined) ids.push(snapshot.context.environment.id)
    const preferences = readSpaceNavigationPreferences(snapshot.context.user.id, ids)
    this.store.update((draft) => {
      draft.favoriteRuntimeIds = preferences.favorites
      draft.recentRuntimeIds = preferences.recent
    })
  }

  /** Toggle the verified current environment's bookmark without changing its routing or permissions. */
  toggleCurrentSpaceFavorite(): void {
    const snapshot = this.getSnapshot()
    const context = snapshot.context
    if (!snapshot.contextVerified || context?.environment === undefined || this.disposed) return
    const saved = toggleSpaceFavorite(context.user.id, context.environment.id)
    this.store.update((draft) => { draft.spacePreferencesError = !saved })
    if (saved) this.refreshSpacePreferences()
  }

  /** Load one project's redacted Provider settings.
   * @param projectId - public project id.
   * @returns the project model settings view.
   */
  loadProjectModelSettings(projectId: number): Promise<ProjectModelSettingsView> {
    if (this.disposed) return Promise.reject(new CollaborationRequestError(499, 'client-disposed'))
    const projectModels = this.transport.projectModels
    if (projectModels === undefined) return Promise.reject(new CollaborationRequestError(503, 'project-model-settings-unavailable'))
    return projectModels.get(projectId, this.abortController.signal)
  }

  /** Return the shared project-model wire face for a project settings surface.
   * @returns the transport, or undefined when the carrier is absent.
   */
  projectModelSettingsTransport(): ProjectModelSettingsTransport | undefined {
    return this.transport.projectModels
  }

  /**
   * Return the stable collaboration snapshot.
   * @returns the current snapshot.
   */
  getSnapshot(): CollaborationSnapshot {
    return this.store.getSnapshot()
  }

  /**
   * Subscribe to snapshot replacements.
   * @param listener - change callback.
   * @returns disposer for the callback.
   */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Load or refresh the authenticated account context.
   * @param force - refresh even when a ready snapshot exists.
   * @returns settlement after the current coalesced request.
   */
  load(force = false): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const pending = this.contextLoad
    if (pending !== undefined && !force) return pending.promise
    // A forced read invalidates the pending one: a caller that needs the
    // post-mutation context must not join a request issued before it.
    pending?.controller.abort()
    const controller = new AbortController()
    // Own the slot before the deferred wire call and the publications below
    // can reenter load() through a subscriber.
    const operation = Promise.resolve()
      .then(() => this.transport.loadContext(controller.signal))
      .then((context) => {
        if (this.disposed || controller.signal.aborted || this.contextLoad?.controller !== controller) return
        if (this.getSnapshot().context?.user.id !== context.user.id) this.clearEnvironments()
        this.store.update((draft) => {
          draft.status = 'ready'
          draft.contextVerified = true
          if (draft.context?.user.id !== context.user.id) draft.conversations = {}
          draft.context = context
          delete draft.scopeError
          draft.conversations = Object.fromEntries(Object.entries(draft.conversations)
            .filter(([id]) => conversationProject(draft, id) !== undefined))
        })
        if (context.environment !== undefined && this.getSnapshot().contextVerified) {
          const visit = `${context.user.id}:${context.environment.id}`
          if (this.lastVisitedSpace !== visit) {
            this.lastVisitedSpace = visit
            recordSpaceVisit(context.user.id, context.environment.id)
          }
          this.refreshSpacePreferences()
        }
      })
      .catch((_contextLoadFailure: unknown) => {
        if (this.disposed || controller.signal.aborted || this.contextLoad?.controller !== controller) return
        this.store.update((draft) => {
          draft.contextVerified = false
          if (draft.status !== 'ready') draft.status = 'unavailable'
        })
      })
      .finally(() => {
        if (this.contextLoad?.controller === controller) this.contextLoad = undefined
      })
    this.contextLoad = { promise: operation, controller }
    this.store.update((draft) => { draft.contextVerified = false })
    if (!force && this.getSnapshot().status !== 'ready') {
      this.store.update((draft) => { draft.status = 'loading' })
    }
    return operation
  }

  /** Revoke account eligibility and pending context reads from an old connection generation. */
  invalidateContext(): void {
    this.contextLoad?.controller.abort()
    this.contextLoad = undefined
    this.clearEnvironments()
    this.store.update((draft) => { draft.contextVerified = false })
  }

  /**
   * Refresh account context, then revalidate every cached project conversation.
   * @returns settlement after the coalesced account and conversation requests.
   */
  async refresh(): Promise<void> {
    await this.load(true)
    if (this.disposed || this.getSnapshot().context?.scope.kind !== 'project') return
    await Promise.all(Object.keys(this.getSnapshot().conversations)
      .map(sessionId => this.loadConversation(sessionId, { force: true })))
  }

  /**
   * Stage the visibility injected into the next project root-session create.
   * @param nextVisibility - project-visible or creator-private.
   */
  stageVisibility(nextVisibility: CollaborationVisibility): void {
    this.store.update((draft) => { draft.stagedVisibility = nextVisibility })
  }

  /**
   * Prepare an exact environment and navigate when browser-owned input is recoverable.
   * @param scope - personal runtime or one accessible project runtime.
   * @returns after preparation settles; protected input keeps the source tab and offers a new tab.
   */
  async switchScope(scope: SessionRuntimeTarget): Promise<void> {
    const snapshot = this.getSnapshot()
    if (this.disposed || snapshot.scopeBusy || !snapshot.contextVerified) return
    const controller = new AbortController()
    this.scopeSwitch = controller
    const isCurrentSwitch = (): boolean => !controller.signal.aborted && this.scopeSwitch === controller
    const target: CollaborationScopeTarget = scope.kind === 'personal'
      ? { kind: 'personal' }
      : {
        kind: 'project',
        projectId: scope.projectId,
        projectName: snapshot.context?.projects.find(project => project.projectId === scope.projectId)?.name ?? '',
      }
    const environment = scope.runtimeId === undefined ? undefined
      : [...(snapshot.environments?.items ?? []), ...(snapshot.preferredEnvironments ?? [])]
        .find(item => item.target.runtimeId === scope.runtimeId)
    if (environment?.nodeName !== undefined) target.nodeName = environment.nodeName
    this.store.update((draft) => {
      draft.scopeBusy = true
      draft.scopeTarget = target
      delete draft.scopeError
      delete draft.scopeFailedTarget
      delete draft.scopeOffer
    })
    try {
      let resolved = scope
      if (scope.kind === 'personal' && scope.runtimeId === undefined && snapshot.context?.environment !== undefined
        && this.transport.loadEnvironments !== undefined) {
        let cursor: string | undefined
        let fallback: SessionRuntimeTarget | undefined
        const seen = new Set<string>()
        do {
          const page = await this.transport.loadEnvironments(cursor, controller.signal)
          fallback ??= page.items.find(item => item.target.kind === 'personal')?.target
          const personal = page.items.find(item => item.target.kind === 'personal' && item.nodeStatus !== 'offline'
            && item.nodeStatus !== 'draining' && item.routing !== 'unavailable' && item.provisioning !== 'preparing')
          if (personal !== undefined) { resolved = personal.target; break }
          if (page.nextCursor === null) {
            if (fallback === undefined) throw new CollaborationRequestError(403, 'runtime-catalog/forbidden')
            resolved = fallback; break
          }
          if (seen.has(page.nextCursor)) throw new Error('Runtime directory repeated a cursor')
          seen.add(page.nextCursor); cursor = page.nextCursor
        } while (isCurrentSwitch())
      }
      const destination = await this.transport.switchScope(resolved, controller.signal)
      if (!isCurrentSwitch()) return
      this.store.update((draft) => {
        draft.scopeBusy = false
        delete draft.scopeTarget
      })
      if (!isCurrentSwitch()) return
      if (!this.getSnapshot().contextVerified) return
      if (this.transport.canNavigate?.() === false) {
        const runtimeId = typeof destination === 'string' ? new URL(destination, 'http://gateway').searchParams.get('dshRuntime') : null
        this.store.update((draft) => {
          if (runtimeId === null) draft.scopeError = 'draft-unsaved'
          else draft.scopeOffer = { runtimeId, target }
        })
        return
      }
      this.transport.reload(typeof destination === 'string' ? destination : undefined)
    } catch (cause) {
      if (!isCurrentSwitch()) return
      this.store.update((draft) => {
        draft.scopeBusy = false
        delete draft.scopeTarget
        draft.scopeError = scopeFailure(cause)
        draft.scopeFailedTarget = scope
      })
    } finally {
      if (this.scopeSwitch === controller) this.scopeSwitch = undefined
    }
  }

  /** Acknowledge a failed switch without changing this tab's environment or draft. */
  dismissScopeError(): void {
    if (this.disposed) return
    this.store.update((draft) => { delete draft.scopeError; delete draft.scopeFailedTarget })
  }

  /** Close the navigation offer without unloading input or stopping either Runtime. */
  dismissScopeOffer(): void {
    if (this.disposed) return
    this.store.update((draft) => { delete draft.scopeOffer })
  }

  /**
   * Create a user-owned project and refresh the account context.
   * @param name - project display name.
   * @param nodeId - explicitly chosen project computer; omission retains the current entry.
   * @returns the newly allocated public project id.
   */
  async createProject(name: string, nodeId?: CollaborationComputerId): Promise<number> {
    if (this.disposed) throw new CollaborationRequestError(499, 'client-disposed')
    const operation = this.transport.createProject
    if (operation === undefined) throw new CollaborationRequestError(503, 'managed-projects-unavailable')
    const result = await operation(name, this.abortController.signal, nodeId)
    if (this.abortController.signal.aborted) throw new CollaborationRequestError(499, 'client-disposed')
    await this.load(true)
    return result.projectId
  }

  /**
   * Load invitations visible to the account, optionally narrowed to a project.
   * @param projectId - optional project to narrow the invitation list.
   * @returns invitations visible to the current account.
   */
  listInvitations(projectId?: number): Promise<ProjectInvitation[]> {
    if (this.disposed) return Promise.resolve([])
    const operation = this.transport.listInvitations
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'invitations-unavailable'))
    return operation(projectId, this.abortController.signal)
  }

  /**
   * Invite one account to a project.
   * @param projectId - project receiving the invitation.
   * @param username - account username to invite.
   * @param memberMode - access mode granted after acceptance.
   * @returns the persisted pending invitation.
   */
  inviteMember(projectId: number, username: string, memberMode: 'ro' | 'rw'): Promise<ProjectInvitation> {
    if (this.disposed) return Promise.reject(new CollaborationRequestError(499, 'client-disposed'))
    const operation = this.transport.inviteMember
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'invitations-unavailable'))
    return operation(projectId, username, memberMode, this.abortController.signal)
  }

  /**
   * Accept one pending invitation and refresh project membership.
   * @param invitationId - invitation identifier to accept.
   * @returns settlement after the membership refresh.
   */
  async acceptInvitation(invitationId: string): Promise<void> {
    if (this.disposed) throw new CollaborationRequestError(499, 'client-disposed')
    const operation = this.transport.acceptInvitation
    if (operation === undefined) throw new CollaborationRequestError(503, 'invitations-unavailable')
    await operation(invitationId, this.abortController.signal)
    if (this.abortController.signal.aborted) return
    await this.load(true)
  }

  /**
   * List eligible users for the invitation member picker.
   * @param projectId - project whose fixed computer and membership determine eligibility.
   * @returns active user summaries.
   */
  listUsers(projectId?: number): Promise<UserSummary[]> {
    if (this.disposed) return Promise.resolve([])
    const operation = this.transport.listUsers
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'users-unavailable'))
    return operation(this.abortController.signal, projectId)
  }

  /** List this account's authorized computer metadata without starting a Runtime.
   * @returns one bounded authorized computer page.
   */
  listComputers(): Promise<CollaborationComputer[]> {
    if (this.disposed) return Promise.resolve([])
    const operation = this.transport.listComputers
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'computer-access/unavailable'))
    return operation(this.abortController.signal)
  }

  /**
   * Count pending invitations where the current user is the invitee.
   * @returns the pending count.
   */
  getInvitationCount(): Promise<{ pending: number }> {
    if (this.disposed) return Promise.resolve({ pending: 0 })
    const operation = this.transport.getInvitationCount
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'invitations-unavailable'))
    return operation(this.abortController.signal)
  }

  /** Load one project's logical configuration for the current account.
   * @param projectId - public project id.
   * @returns the validated project configuration.
   */
  loadProjectConfiguration(projectId: number): Promise<ProjectConfiguration> {
    if (this.disposed) return Promise.reject(new CollaborationRequestError(499, 'client-disposed'))
    const operation = this.transport.loadProjectConfiguration
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'project-configuration-unavailable'))
    return operation(projectId, this.abortController.signal)
  }

  /** Persist one project theme policy and refresh the account context.
   * @param projectId - public project id.
   * @param policy - theme policy to store.
   * @returns the updated project configuration.
   */
  async setProjectThemePolicy(projectId: number, policy: ProjectThemePolicy): Promise<ProjectConfiguration> {
    if (this.disposed) throw new CollaborationRequestError(499, 'client-disposed')
    const operation = this.transport.setProjectThemePolicy
    if (operation === undefined) throw new CollaborationRequestError(503, 'project-configuration-unavailable')
    const value = await operation(projectId, policy, this.abortController.signal)
    await this.load(true)
    return value
  }

  /** List the organization SSH targets with this project's share flags.
   * @param projectId - public project id.
   * @returns the project-scoped target rows.
   */
  listProjectSshTargets(projectId: number): Promise<ProjectSshTarget[]> {
    if (this.disposed) return Promise.reject(new CollaborationRequestError(499, 'client-disposed'))
    const operation = this.transport.listProjectSshTargets
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'ssh-targets-unavailable'))
    return operation(projectId, this.abortController.signal)
  }

  /** Share or unshare one organization SSH target with the project.
   * @param projectId - public project id.
   * @param targetId - public target id.
   * @param shared - the share direction to write.
   * @returns the updated target row.
   */
  shareProjectSshTarget(
    projectId: number,
    targetId: number,
    shared: boolean,
  ): Promise<{ publicId: number; name: string; shared: boolean }> {
    if (this.disposed) return Promise.reject(new CollaborationRequestError(499, 'client-disposed'))
    const operation = this.transport.shareProjectSshTarget
    if (operation === undefined) return Promise.reject(new CollaborationRequestError(503, 'ssh-targets-unavailable'))
    return operation(projectId, targetId, shared, this.abortController.signal)
  }

  /**
   * Load one requested session's effective access and root collaboration data.
   * @param sessionId - requested session, including a root's descendants.
   * @param options - whether a ready cache entry must be revalidated.
   * @returns settlement after the request or a deliberate no-op.
   */
  loadConversation(sessionId: string, options: { force?: boolean } = {}): Promise<void> {
    const snapshot = this.getSnapshot()
    const projectId = conversationProject(snapshot, sessionId)
    if (this.disposed || projectId === undefined) return Promise.resolve()
    const existing = snapshot.conversations[sessionId]
    const force = options.force === true
    const inFlight = this.conversationLoads.get(sessionId)
    if (inFlight !== undefined) {
      if (!force) return Promise.resolve()
      this.conversationRefreshPending.add(sessionId)
      return inFlight
    }
    if (existing?.status === 'ready' && !force) return Promise.resolve()
    if (existing?.status === 'ready' && existing.saving) {
      this.conversationRefreshPending.add(sessionId)
      return Promise.resolve()
    }

    const operation = this.runConversationLoads(sessionId, projectId, force)
      .finally(() => { this.conversationLoads.delete(sessionId) })
    this.conversationLoads.set(sessionId, operation)
    return operation
  }

  /**
   * Revalidate one blank root conversation and compare its authoritative
   * visibility with a prepared Client create request.
   * @param sessionId - reusable blank-session candidate.
   * @param expected - visibility requested for the next root conversation.
   * @returns true only for a settled, matching Gateway response.
   */
  async matchesConversationVisibility(
    sessionId: string,
    expected: CollaborationVisibility,
  ): Promise<boolean> {
    if (this.disposed) return false
    await this.loadConversation(sessionId, { force: true })
    if (this.abortController.signal.aborted) return false
    const state = this.getSnapshot().conversations[sessionId]
    return state?.status === 'ready' && !state.saving
      && state.detail.access.visibility === expected
  }

  private async runConversationLoads(sessionId: string, projectId: number, force: boolean): Promise<void> {
    let refresh = force
    do {
      this.conversationRefreshPending.delete(sessionId)
      const existing = this.getSnapshot().conversations[sessionId]
      if (existing?.status !== 'ready') {
        this.store.update((draft) => {
          draft.conversations[sessionId] = { status: 'loading', saving: false }
        })
      }
      try {
        const detail = await this.transport.loadConversation(sessionId, this.abortController.signal)
        if (this.disposed || conversationProject(this.getSnapshot(), sessionId) !== projectId) return
        if (detail.access.projectId !== projectId) throw new Error('Conversation response belongs to another project')
        this.store.update((draft) => {
          const current = draft.conversations[sessionId]
          const saving = current?.status === 'ready' && current.saving
          draft.conversations[sessionId] = { status: 'ready', detail, saving }
        })
      } catch (_conversationLoadFailure) {
        if (this.disposed || conversationProject(this.getSnapshot(), sessionId) !== projectId) return
        if (this.getSnapshot().conversations[sessionId]?.status !== 'ready') {
          this.store.update((draft) => {
            draft.conversations[sessionId] = { status: 'error', saving: false, error: 'load-failed' }
          })
        }
      }
      refresh = this.conversationRefreshPending.delete(sessionId)
    } while (refresh)
  }

  /**
   * Update a manageable root conversation's visibility and publish the result.
   * @param sessionId - requested session whose root owns visibility.
   * @param nextVisibility - desired root visibility.
   * @returns settlement after the request and snapshot publication.
   */
  async setVisibility(sessionId: string, nextVisibility: CollaborationVisibility): Promise<void> {
    const state = this.getSnapshot().conversations[sessionId]
    if (this.disposed || state?.status !== 'ready'
      || !state.detail.access.canManage || state.saving
      || state.detail.access.visibility === nextVisibility) return
    this.store.update((draft) => {
      draft.conversations[sessionId] = { status: 'ready', detail: state.detail, saving: true }
    })
    try {
      await this.transport.setVisibility(sessionId, nextVisibility, this.abortController.signal)
      if (this.abortController.signal.aborted) return
      this.store.update((draft) => {
        const current = draft.conversations[sessionId]
        if (current?.status !== 'ready') return
        current.saving = false
        current.detail.access.visibility = nextVisibility
        if (current.detail.conversation !== null) current.detail.conversation.visibility = nextVisibility
      })
    } catch (error) {
      if (this.abortController.signal.aborted) return
      this.store.update((draft) => {
        const current = draft.conversations[sessionId]
        if (current?.status !== 'ready') return
        current.saving = false
        current.error = error instanceof CollaborationRequestError && error.code === 'visibility-locked'
          ? 'visibility-locked'
          : 'update-failed'
      })
    } finally {
      if (this.conversationRefreshPending.delete(sessionId)) {
        void this.loadConversation(sessionId, { force: true })
      }
    }
  }

  /** Abort in-flight HTTP operations and suppress later publications. */
  dispose(): void {
    this.preferredLoad?.abort()
    this.contextLoad?.controller.abort()
    this.environmentLoad?.controller.abort()
    this.scopeSwitch?.abort()
    if (this.disposed) return
    this.disposed = true
    this.abortController.abort()
  }
}
