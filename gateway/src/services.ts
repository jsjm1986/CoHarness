import type { AuditRow } from './audit.ts'
import type { GatewayAccountPreferencesService } from './account-preferences.ts'
import type { UserRow } from './auth.ts'
import type {
  CollaborationAction,
  ConversationAccess,
  ConversationCollaborationView,
  ProjectAuthorityView,
  ProjectScopeView,
} from './collaboration.ts'
import type { InstanceManager } from './instances.ts'
import type {
  ModelSettingsPathOp,
  ModelUsageSubject,
  ModelRegistrationEvent,
  ModelRegistrationFilter,
  ModelRegistrationReport,
  ModelProviderInput,
  ModelProviderRow,
  ModelRow,
  OrganizationCredentialView,
  OrganizationModelSettingsView,
  RuntimeModelPolicy,
  UsageContributorReport,
  UsageEvent,
  UsageHealth,
  UsageOverview,
  UsageSummary,
  ProjectQuotaView,
  ProjectCredentialView,
  ProjectModelProviderRow,
  ProjectModelSettingsView,
} from './model-governance.ts'
import type {
  EffectiveGrant,
  GrantMode,
  ProjectDetail,
  ProjectInvitation,
  ProjectRow,
  ProjectThemePolicy,
} from './projects.ts'
import type { PostgresDocumentCatalogService } from './postgres/document-catalog-service.ts'

/** A service result that may come from an in-process store or an asynchronous database. */
export type Awaitable<T> = T | Promise<T>

/** Authentication operations consumed by the Gateway HTTP server. */
export interface GatewayAuthService {
  login(
    username: string,
    password: string,
    ip: string,
    userAgent: string,
  ): Promise<{ token: string; user: UserRow } | 'invalid' | 'locked'>
  validate(token: string): Awaitable<UserRow | null>
  revoke(token: string): Awaitable<void>
}

/** Account-scoped browser preferences shared by personal and project pages. */
export type GatewayUserPreferencesService = GatewayAccountPreferencesService

/** User administration operations consumed by the Gateway. */
export interface GatewayUserService {
  count(): Awaitable<number>
  create(input: {
    username: string
    password: string
    role?: 'admin' | 'user'
    displayName?: string
  }): Promise<UserRow>
  list(): Awaitable<Array<UserRow & { port: number; instanceState: string }>>
  getById(id: number): Awaitable<UserRow | null>
  /** Atomically apply the administrator-editable user fields when supported. */
  patch?(id: number, next: {
    role?: 'admin' | 'user'
    status?: 'active' | 'disabled'
    displayName?: string
  }): Awaitable<void>
  getByUsername(username: string): Awaitable<UserRow | null>
  setStatus(id: number, status: 'active' | 'disabled'): Awaitable<void>
  setRole(id: number, role: 'admin' | 'user'): Awaitable<void>
  setDisplayName(id: number, name: string): Awaitable<void>
  remove(id: number): Awaitable<boolean>
  resetPassword(id: number, newPassword: string): Promise<void>
  changeOwnPassword(id: number, newPassword: string): Promise<void>
}

/** Project and effective-directory-grant operations consumed by the Gateway. */
export interface GatewayProjectService {
  /** `path` is omitted for managed creation below the configured project root. */
  create(input: { name: string; path?: string; createdBy: number }): Awaitable<ProjectRow>
  /** Allocate a new project directory below the configured managed root. */
  createManaged?(input: { name: string; ownerUserId: number; createdBy?: number }): Awaitable<ProjectRow>
  list(): Awaitable<ProjectRow[]>
  getById(id: number): Awaitable<ProjectDetail | null>
  /** Batch detail lookup used by account catalog pages to avoid N+1 queries. */
  getByIds?(ids: readonly number[]): Awaitable<ProjectDetail[]>
  rename(id: number, name: string): Awaitable<void>
  remove(id: number): Awaitable<number[]>
  setMember(projectId: number, userId: number, mode: GrantMode): Awaitable<void>
  removeMember(projectId: number, userId: number): Awaitable<void>
  effectiveGrants(userId: number): Awaitable<EffectiveGrant[]>
  createInvitation?(input: {
    projectId: number
    inviteeUserId: number
    inviterUserId: number
    mode: GrantMode
  }): Awaitable<ProjectInvitation>
  listInvitations?(userId: number, projectId?: number): Awaitable<ProjectInvitation[]>
  acceptInvitation?(invitationId: string, userId: number): Awaitable<void>
  countPendingInvitations?(userId: number): Awaitable<number>
  /** Update the explicit project UI theme policy when the provider supports it. */
  setThemePolicy?(projectId: number, policy: ProjectThemePolicy): Awaitable<void>
}

/** Project membership and shared-conversation authorization operations. */
export interface GatewayCollaborationService {
  projectsForUser(userId: number): Awaitable<ProjectScopeView[]>
  projectForUser(projectId: number, userId: number): Awaitable<ProjectAuthorityView | null>
  access(userId: number, sessionId: string, action: CollaborationAction): Awaitable<ConversationAccess>
  listConversations(userId: number, projectId: number): Awaitable<ConversationCollaborationView[]>
  readableSessionIds(userId: number, projectId: number, sessionIds: readonly string[]): Awaitable<string[]>
  setVisibility(userId: number, sessionId: string, visibility: 'project' | 'private'): Awaitable<void>
  claimInteraction(
    userId: number,
    sessionId: string,
    kind: 'approval' | 'question',
    interactionId: string,
    outcome: unknown,
  ): Awaitable<boolean>
}

/** Audit operations consumed by request handlers and policy application. */
export interface GatewayAuditService {
  write(entry: {
    userId?: number
    action: string
    methodPath?: string
    status?: number
    ip?: string
    detail?: string
  }): Awaitable<void>
  query(filter?: {
    userId?: number
    action?: string
    actionPrefix?: string
    fromMs?: number
    toMs?: number
    offset?: number
    limit?: number
  }): Awaitable<AuditRow[]>
}

/** Organization document metadata and audited ownership operations. */
export type GatewayDocumentCatalogService = Pick<
  PostgresDocumentCatalogService,
  'adminList' | 'adminMetrics' | 'detail' | 'transferOwnership' | 'adminDelete'
> & Partial<Pick<PostgresDocumentCatalogService, 'adminListPage' | 'target' | 'adminTrash' | 'adminRestore' | 'adminPurge' | 'purgeDue'>>

/** Model authorization, pricing, quota, and usage operations consumed by the Gateway. */
export interface GatewayModelGovernanceService {
  /** Monotonic organization policy revision used by lazy runtime projections. */
  configurationRevision?(): Awaitable<number>
  listProviders(): Awaitable<ModelProviderRow[]>
  upsertProvider(input: ModelProviderInput): Awaitable<void>
  listModels(): Awaitable<ModelRow[]>
  upsertModel(input: Omit<ModelRow, 'adminAllowed' | 'userAllowed'> & {
    adminAllowed?: boolean
    userAllowed?: boolean
  }): Awaitable<void>
  setUserAccess(userId: number, provider: string, model: string, allowed: boolean | null): Awaitable<void>
  userOverrides(userId: number): Awaitable<Array<{ provider: string; model: string; allowed: boolean }>>
  setProjectAccess(projectId: number, provider: string, model: string, allowed: boolean | null): Awaitable<void>
  setAllProjectAccess(projectId: number, allowed: true | null): Awaitable<void>
  projectOverrides(projectId: number): Awaitable<Array<{ provider: string; model: string; allowed: boolean }>>
  policyFor(user: UserRow): Awaitable<RuntimeModelPolicy>
  policyForProject(projectId: number): Awaitable<RuntimeModelPolicy>
  resolveOrganizationCredential(subject: ModelUsageSubject, ref: string): Awaitable<string | null>
  describeOrganizationModelSettings(): Awaitable<OrganizationModelSettingsView>
  mutateOrganizationModelSettings(ops: ModelSettingsPathOp[], expectedRevision?: number): Awaitable<OrganizationModelSettingsView>
  describeOrganizationCredentials(refs: string[]): Awaitable<Record<string, OrganizationCredentialView>>
  setOrganizationCredential(ref: string, value: string): Awaitable<void>
  unsetOrganizationCredential(ref: string): Awaitable<void>
  discoverOrganizationModels(request: {
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }): Awaitable<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>>
  /** Project-scoped Provider settings used by the user-facing project UI. */
  describeProjectModelSettings?(projectId: number): Awaitable<ProjectModelSettingsView>
  mutateProjectModelSettings?(
    projectId: number,
    ops: ModelSettingsPathOp[],
    expectedRevision?: number,
  ): Awaitable<ProjectModelSettingsView>
  listProjectProviders?(projectId: number): Awaitable<ProjectModelProviderRow[]>
  describeProjectCredentials?(projectId: number, refs: string[]): Awaitable<Record<string, ProjectCredentialView>>
  setProjectCredential?(projectId: number, ref: string, value: string): Awaitable<void>
  unsetProjectCredential?(projectId: number, ref: string): Awaitable<void>
  discoverProjectModels?(request: {
    projectId: number
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }): Awaitable<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>>
  /** Resolve either an organization or project-owned reference for a runtime. */
  resolveManagedCredential?(subject: ModelUsageSubject, ref: string): Awaitable<string | null>
  issueIntakeToken(subject: ModelUsageSubject): Awaitable<string>
  subjectForIntakeToken(token: string): Awaitable<ModelUsageSubject | null>
  setQuota(
    subjectType: 'role' | 'user' | 'project',
    subjectId: string,
    tokenLimit: number | null | 'inherit',
    costLimit: number | null | 'inherit',
  ): Awaitable<void>
  ingest(subject: ModelUsageSubject, event: UsageEvent): Awaitable<{ inserted: boolean; alerts: number }>
  ingestRegistration(subject: ModelUsageSubject, event: ModelRegistrationEvent): Awaitable<{ inserted: boolean }>
  registrationReport(filter?: ModelRegistrationFilter): Awaitable<ModelRegistrationReport>
  summary(subject: ModelUsageSubject, month?: string): Awaitable<UsageSummary>
  /** Optional PostgreSQL activity views; SQLite keeps the legacy summary surface. */
  usageOverview?(month?: string): Awaitable<UsageOverview>
  usageContributors?(month?: string, projectId?: number): Awaitable<UsageContributorReport>
  usageHealth?(month?: string): Awaitable<UsageHealth>
  /**
   * Stored project quota source and the limits currently in force for that source.
   * @param projectId - public project id
   * @returns inherit with ordinary-member limits when no project quota row exists; otherwise the stored independent limits
   */
  projectQuota(projectId: number): Awaitable<ProjectQuotaView>
}

/** Instance lifecycle operations used by HTTP, proxy, and policy handlers. */
export type GatewayInstanceService = Pick<
  InstanceManager,
  'beforeStart' | 'beforeUse' | 'portOf' | 'stateOf' | 'generationOf' | 'isLive' | 'touch' | 'wsRef' | 'ensureRunning' | 'reapIdle'
  | 'stop' | 'stopAll' | 'withStopped'
> & {
  /** Optional long-request lease supported by the production manager. */
  operationRef?: InstanceManager['operationRef']
}
