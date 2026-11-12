import type { RuntimeId } from './runtime-catalog.ts'
import type { AuditQueryFilter, AuditRow } from './audit.ts'
import type { GatewayAccountPreferencesService } from './account-preferences.ts'
import type { UserRow } from './auth.ts'
import type {
  CollaborationAction,
  AccountConversationView,
  ConversationAccess,
  ConversationCollaborationView,
  ProjectAuthorityView,
  ProjectReadAuthorityView,
  ProjectScopeView,
} from './collaboration.ts'
import type { InstanceManager } from './instances.ts'
import type {
  ModelSettingsPathOp,
  ModelUsageSubject,
  ModelIntakeSubject,
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
  UserQuotaView,
  RoleQuotaView,
} from './model-governance.ts'
import type {
  EffectiveGrant,
  GrantMode,
  ProjectDetail,
  ProjectInvitation,
  ProjectRow,
  ProjectScopeMetadata,
  ProjectThemePolicy,
  UserProjectMembership,
} from './projects.ts'
import type { PostgresDocumentCatalogService } from './postgres/document-catalog-service.ts'

/** A service result that may come from an in-process store or an asynchronous database. */
export type Awaitable<T> = T | Promise<T>

/** One account with a local assignment summary; multiple or absent Runtimes have no single port. */
export type GatewayUserListRow = UserRow & { port: number | null; instanceState: string; runtimeCount?: number }

/** Authentication operations consumed by the Gateway HTTP server. */
export interface GatewayAuthService {
  login(
    username: string,
    password: string,
    ip: string,
    userAgent: string,
  ): Promise<{ token: string; user: UserRow } | 'invalid' | 'locked'>
  /**
   * Validate current account authority and renew a still-live browser session.
   * @param token - opaque browser session token.
   * @returns current account identity, or null at or after either expiry or after revocation.
   */
  validate(token: string): Awaitable<UserRow | null>
  /**
   * Check an existing stream's login without updating activity or either login deadline.
   * @param token - original login token owned by the Gateway socket registry.
   * @returns current user and existing earliest deadline, or null when ineligible.
   */
  qualifyForStream(token: string): Awaitable<import('./auth.ts').StreamSessionQualification | null>
  revoke(token: string): Awaitable<void>
}

/** Account-scoped browser preferences shared by personal and project pages. */
export type GatewayUserPreferencesService = GatewayAccountPreferencesService

/** User administration; supplied actors require current organization administrator authority in the mutation transaction. Actor omission permits trusted bootstrap or maintenance. */
export interface GatewayUserService {
  count(): Awaitable<number>
  /**
   * Create an account only after administrator admission, before allocating its directories.
   * @param input - validated account fields and initial password.
   * @param actorUserId - authenticated administrator; omitted for trusted bootstrap.
   * @returns the committed account.
   */
  create(input: {
    username: string
    password: string
    role?: 'admin' | 'user'
    displayName?: string
  }, actorUserId?: number): Promise<UserRow>
  list(): Awaitable<GatewayUserListRow[]>
  getById(id: number): Awaitable<UserRow | null>
  /**
   * Confirm a retained account tombstone; omission cannot classify concurrent deletion.
   * @param id - account identifier within this service's organization.
   * @returns true only for an existing deleted account; unknown ids return false.
   */
  isDeleted?(id: number): Awaitable<boolean>
  /** Read one organization account and local assignment summary, or null when absent or deleted. */
  getListedById(id: number): Awaitable<GatewayUserListRow | null>
  /**
   * Atomically apply administrator-editable fields with current actor authority.
   * @param id - target account.
   * @param next - fields to update together.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  patch?(id: number, next: {
    role?: 'admin' | 'user'
    status?: 'active' | 'disabled'
    displayName?: string
    autoReviewEligible?: boolean
  }, actorUserId?: number): Awaitable<void>
  getByUsername(username: string): Awaitable<UserRow | null>
  setStatus(id: number, status: 'active' | 'disabled', actorUserId?: number): Awaitable<void>
  setRole(id: number, role: 'admin' | 'user', actorUserId?: number): Awaitable<void>
  setDisplayName(id: number, name: string, actorUserId?: number): Awaitable<void>
  remove(id: number, actorUserId?: number): Awaitable<boolean>
  resetPassword(id: number, newPassword: string, actorUserId?: number): Promise<void>
  /** Revokes every other session for the user; `keepToken` keeps the caller's own session alive. */
  changeOwnPassword(id: number, newPassword: string, keepToken?: string): Promise<void>
}

/** Project and effective-directory-grant operations consumed by the Gateway. */
export interface GatewayProjectService {
  /**
   * Provision with current administrator authority before directory allocation; actor omission permits trusted internal maintenance.
   * @param input - name, optional import path and creator; supplied actorUserId must match that authenticated creator. Omitting path allocates below the configured administrator project root.
   * @returns the registered administrator project; imported host bytes remain caller-owned.
   */
  reindexNames?(actorUserId: number, names: import('./node-content-project-names.ts').ProjectNameMacAuthority, after?: number, limit?: number): Awaitable<{ indexed: number; next: number | null }>
  create(input: { name: string; path?: string; createdBy: number; actorUserId?: number }, names?: import('./node-content-project-names.ts').ProjectNameMacAuthority): Awaitable<ProjectRow>
  /**
   * Allocate below HGW_USER_PROJECTS_ROOT with current actor authority; omission permits trusted internal maintenance.
   * @param input - name and owner/creator; when actorUserId is supplied, both identities must match that authenticated actor.
   * @returns the registered project with its allocated directory.
   */
  createManaged?(input: { name: string; ownerUserId: number; createdBy?: number; actorUserId?: number }, names?: import('./node-content-project-names.ts').ProjectNameMacAuthority): Awaitable<ProjectRow>
  list(display?: 'directory'): Awaitable<ProjectRow[]>
  getById(id: number, display?: 'directory'): Awaitable<ProjectDetail | null>
  /** Batch detail lookup used by account catalog pages to avoid N+1 queries. */
  getByIds?(ids: readonly number[], display?: 'directory'): Awaitable<ProjectDetail[]>
  /**
   * Read active node-local scope metadata without member lists or counts.
   * @param ids - public project ids already authorized by the caller.
   * @returns Available owner, origin and theme fields for those projects.
   */
  getScopeMetadataByIds?(ids: readonly number[]): Awaitable<ProjectScopeMetadata[]>
  /**
   * Seed the reserved steward space once or return the existing row. The
   * steward project has no member rows; admission comes from the steward
   * qualification lane. Absent where the catalog backend has no steward support.
   */
  ensureSteward?(input: { name: string; path: string; createdBy?: number }): Awaitable<ProjectRow>
  /** Current steward project target for this node, when seeded. */
  stewardProject?(): Awaitable<{ id: number; name: string; path: string } | null>
  /** Reserved kind of a project by internal row id, or null when unknown. */
  kindOfInternal?(internalId: string): Awaitable<import('./projects.ts').ProjectKind | null>
  /** Rename with current manager authority when actorUserId is supplied; omission is trusted internal maintenance. */
  rename(id: number, name: string, actorUserId?: number, names?: import('./node-content-project-names.ts').ProjectNameMacAuthority): Awaitable<void>
  /** Remove with current administrator authority when actorUserId is supplied; omission permits trusted maintenance. Return every removed member id for grant refresh and preserve host files. */
  remove(id: number, actorUserId?: number): Awaitable<number[]>
  /** Override membership with current administrator authority; actor omission permits trusted internal maintenance. */
  setMember(projectId: number, userId: number, mode: GrantMode, actorUserId?: number): Awaitable<void>
  /** Remove membership with current administrator authority; actor omission permits trusted internal maintenance. */
  removeMember(projectId: number, userId: number, actorUserId?: number): Awaitable<void>
  /**
   * Stored membership rows owned by one account, for the user-centric admin view.
   * @param userId - public user id
   * @returns memberships ordered by project name; implicit administrator authority is not included
   */
  membershipsFor?(userId: number): Awaitable<UserProjectMembership[]>
  effectiveGrants(userId: number): Awaitable<EffectiveGrant[]>
  /**
   * Issue a pending invitation with current issuer management authority, active recipient membership and both accounts' permission on the project's fixed computer.
   * @param input - project, authenticated inviter, recipient and requested access mode.
   * @returns the new pending invitation; authorized renewal retires an expired predecessor in the same transaction.
   */
  createInvitation?(input: {
    projectId: number
    inviteeUserId: number
    inviterUserId: number
    mode: GrantMode
  }): Awaitable<ProjectInvitation>
  listInvitations?(userId: number, projectId?: number): Awaitable<ProjectInvitation[]>
  /** List active nonmembers authorized on the project's fixed computer; the cursor is the last public user id. */
  listInvitableUsers?(projectId: number, actorUserId: number, cursor?: number): Awaitable<{
    items: Array<{ id: number; username: string; displayName: string }>
    nextCursor: number | null
  }>
  /**
   * Accept as a current active account with permission on the project's fixed computer in an active organization and project; authority refusal leaves the invitation unconsumed.
   * @param invitationId - stored invitation belonging to the recipient.
   * @param userId - authenticated recipient account, rechecked by the owning write transaction.
   */
  acceptInvitation?(invitationId: string, userId: number): Awaitable<void>
  countPendingInvitations?(userId: number): Awaitable<number>
  /** Update the theme with current manager authority; an omitted actor permits trusted internal maintenance. */
  setThemePolicy?(projectId: number, policy: ProjectThemePolicy, actorUserId?: number): Awaitable<void>
}

/** Project membership and shared-conversation authorization operations. */
export interface GatewayCollaborationService {
  projectsForUser(userId: number): Awaitable<ProjectScopeView[]>
  /**
   * Admit prepared browser project metadata using one current account and project authority read without node I/O.
   * @param userId - server-authenticated account identifier.
   * @param projectId - optional exact project; omission selects the account's current directory.
   * @returns current ownership and management facts with directory computer identifiers; an unqualified account yields no projects.
   */
  projectReadAuthorities?(userId: number, projectId?: number): Awaitable<ProjectReadAuthorityView[]>
  /**
   * Read one mounted project's current membership, management authority and theme policy.
   * @param projectId - project identifier.
   * @param userId - authenticated account identifier.
   * @returns authorized local project facts, or null when current account, computer or project admission is unavailable.
   */
  projectForUser(projectId: number, userId: number): Awaitable<ProjectAuthorityView | null>
  access(userId: number, runtimeId: RuntimeId, sessionId: string, action: CollaborationAction): Awaitable<ConversationAccess>
  listConversations(userId: number, runtimeId: RuntimeId, projectId: number): Awaitable<ConversationCollaborationView[]>
  /** Account-wide, ACL-filtered conversation catalog for the multi-runtime workbench. */
  listAccountConversations?(userId: number): Awaitable<AccountConversationView[]>
  readableSessionIds(userId: number, runtimeId: RuntimeId, projectId: number, sessionIds: readonly string[]): Awaitable<string[]>
  setVisibility(userId: number, runtimeId: RuntimeId, sessionId: string, visibility: 'project' | 'private'): Awaitable<void>
  claimInteraction(
    userId: number,
    runtimeId: RuntimeId,
    sessionId: string,
    kind: 'approval' | 'question',
    interactionId: string,
    outcome: unknown,
    callId?: string,
  ): Awaitable<boolean>
  /** ACL-filtered member-activity rows for one project, newest first, keyset-paginated. */
  listActivity(
    userId: number,
    runtimeId: RuntimeId,
    projectId: number,
    options: { limit: number; before?: string },
  ): Awaitable<ProjectActivityPage>
}

/** One member-visible feed row: a signed message or a claimed question answer. */
export interface ProjectActivityItem {
  readonly kind: 'message' | 'answer'
  readonly sessionId: string
  readonly conversationTitle: string | null
  readonly actorUserId: number
  readonly actorLabel: string
  readonly occurredAt: string
  /** Log anchor for reveal: message event seq, or the answer's tool/result seq. NULL for claims that predate call_id. */
  readonly seq: number | null
  /** Message rows: the member's text. Answer rows: the responder's selected answer summary. */
  readonly text: string
  /** Answer rows only: originating tool-call question text, when the claim carried a callId. */
  readonly questionText?: string
  /** Answer rows only: raw selected-answer payload for client rendering. */
  readonly outcome?: unknown
}

/** Keyset page of activity rows; `nextBefore` resumes after the last returned row. */
export interface ProjectActivityPage {
  readonly items: readonly ProjectActivityItem[]
  readonly nextBefore?: string
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
  query(filter?: AuditQueryFilter): Awaitable<AuditRow[]>
  /** Row count matching the same filter as `query`, for pagination totals. */
  count?(filter?: AuditQueryFilter): Awaitable<number>
}

/** Organization document metadata and audited ownership operations. */
export type GatewayDocumentCatalogService = Pick<
  PostgresDocumentCatalogService,
  'adminList' | 'adminMetrics' | 'detail' | 'transferOwnership' | 'adminDelete'
> & Partial<Pick<PostgresDocumentCatalogService, 'personalHistory' | 'adminListPage' | 'target' | 'adminTrash' | 'adminRestore' | 'adminPurge' | 'purgeDue'>>

/**
 * Model authorization, pricing, quota, and usage operations consumed by the Gateway.
 * Administrative writes retain the current active administrator through commit. Browser adapters supply
 * the authenticated actor; omission permits trusted internal maintenance. Policy projection follows commit.
 */
export interface GatewayModelGovernanceService {
  /** Admit each queued policy write against the current maintenance/data epoch and own it until settlement. */
  projectionWrite?: <T>(operation: () => Promise<T>) => Promise<T>
  /** Monotonic organization policy revision used by lazy runtime projections. */
  configurationRevision?(): Awaitable<number>
  listProviders(): Awaitable<ModelProviderRow[]>
  /**
   * Save an organization Provider and its write-only credential.
   * @param input - validated Provider configuration.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  upsertProvider(input: ModelProviderInput, actorUserId?: number): Awaitable<void>
  listModels(): Awaitable<ModelRow[]>
  /**
   * Save one catalog model, role defaults and price version.
   * @param input - catalog route, availability, role defaults and prices.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  upsertModel(input: Omit<ModelRow, 'adminAllowed' | 'userAllowed'> & {
    adminAllowed?: boolean
    userAllowed?: boolean
  }, actorUserId?: number): Awaitable<void>
  /**
   * Set a nondeleted account's model exception; disabled accounts remain configurable.
   * @param userId - public target account id, retained until commit.
   * @param provider - catalog Provider key.
   * @param model - catalog model key.
   * @param allowed - allow, deny, or null to remove the exception.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  setUserAccess(userId: number, provider: string, model: string, allowed: boolean | null, actorUserId?: number): Awaitable<void>
  userOverrides(userId: number): Awaitable<Array<{ provider: string; model: string; allowed: boolean }>>
  /**
   * Set one active project's model exception.
   * @param projectId - public target project id, retained active until commit.
   * @param provider - catalog Provider key.
   * @param model - catalog model key.
   * @param allowed - allow, deny, or null to remove the exception.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  setProjectAccess(projectId: number, provider: string, model: string, allowed: boolean | null, actorUserId?: number): Awaitable<void>
  /**
   * Replace an active project's model default and clear its exceptions.
   * @param projectId - public target project id, retained active until commit.
   * @param allowed - true to follow available models, or null to clear authorization.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  setAllProjectAccess(projectId: number, allowed: true | null, actorUserId?: number): Awaitable<void>
  projectOverrides(projectId: number): Awaitable<Array<{ provider: string; model: string; allowed: boolean }>>
  /**
   * Resolve current active account and membership privileges after admission; cached request roles confer no model access.
   * @param user - account reference; the store resolves its current role.
   * @returns current authorization and Provider projection; withdrawn account, membership or organization eligibility rejects.
   */
  policyFor(user: UserRow): Awaitable<RuntimeModelPolicy>
  policyForProject(projectId: number): Awaitable<RuntimeModelPolicy>
  resolveOrganizationCredential(subject: ModelUsageSubject, ref: string): Awaitable<string | null>
  describeOrganizationModelSettings(): Awaitable<OrganizationModelSettingsView>
  /**
   * Apply organization Provider edits with an optional revision fence.
   * @param ops - settings path edits.
   * @param expectedRevision - required current revision when supplied.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   * @returns the accepted settings view.
   */
  mutateOrganizationModelSettings(ops: ModelSettingsPathOp[], expectedRevision?: number, actorUserId?: number): Awaitable<OrganizationModelSettingsView>
  describeOrganizationCredentials(refs: string[]): Awaitable<Record<string, OrganizationCredentialView>>
  /**
   * Store an encrypted organization Provider credential.
   * @param ref - owned organization credential reference.
   * @param value - credential plaintext, excluded from browser responses and audit details.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  setOrganizationCredential(ref: string, value: string, actorUserId?: number): Awaitable<void>
  /**
   * Remove an owned organization credential.
   * @param ref - owned organization credential reference.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  unsetOrganizationCredential(ref: string, actorUserId?: number): Awaitable<void>
  /**
   * Authorize credential preparation before an organization model-discovery HTTP request.
   * @param request - draft endpoint, optional explicit key, and server-authenticated actor; actor omission permits trusted preparation.
   * @returns discovered models after the preparation transaction has released its connection.
   */
  discoverOrganizationModels(request: {
    /** Server-authenticated administrator; omission permits trusted credential preparation. */
    actorUserId?: number
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
  }): Awaitable<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>>
  /**
   * Qualify a prepared project model read against current account, project and computer permissions.
   * @param projectId - selected public project identifier on this Gateway's computer.
   * @param actorUserId - server-authenticated browser account, never a request-body actor.
   * @returns whether the currently authorized reader can manage the settings; throws when reading is forbidden.
   */
  authorizeProjectModelRead?(projectId: number, actorUserId: number): Awaitable<boolean>
  /** Project-scoped Provider settings; browser publication also requires authorizeProjectModelRead. */
  describeProjectModelSettings?(projectId: number): Awaitable<ProjectModelSettingsView>
  /** Mutate with current manager authority; an omitted actor permits trusted internal maintenance. */
  mutateProjectModelSettings?(
    projectId: number,
    ops: ModelSettingsPathOp[],
    expectedRevision?: number,
    actorUserId?: number,
  ): Awaitable<ProjectModelSettingsView>
  listProjectProviders?(projectId: number): Awaitable<ProjectModelProviderRow[]>
  describeProjectCredentials?(projectId: number, refs: string[]): Awaitable<Record<string, ProjectCredentialView>>
  /** Store a credential with current manager authority; an omitted actor permits trusted internal maintenance. */
  setProjectCredential?(projectId: number, ref: string, value: string, actorUserId?: number): Awaitable<void>
  /** Remove a credential with current manager authority; an omitted actor permits trusted internal maintenance. */
  unsetProjectCredential?(projectId: number, ref: string, actorUserId?: number): Awaitable<void>
  /** Authorize credential preparation before discovery; an omitted actor permits trusted internal preparation. */
  discoverProjectModels?(request: {
    projectId: number
    /** Authenticated browser manager; absent permits trusted internal credential preparation. */
    actorUserId?: number
    provider?: string
    baseURL?: string
    api?: string
    apiKey?: string
    /**
     * `false` refuses every connection, including redirects, whose dialed
     * address is loopback, private, link-local, or reserved; only Gateway
     * administrators may reach such endpoints.
     */
    allowPrivateNetwork: boolean
  }): Awaitable<Array<{ id: string; name?: string; contextWindow?: number; maxTokens?: number }>>
  /** Resolve either an organization or project-owned reference for a runtime. */
  resolveManagedCredential?(subject: ModelUsageSubject, ref: string): Awaitable<string | null>
  /** Resolve a file projection's exact local assignment before issuing or reusing its reporting credential. */
  resolveIntakeSubject?(subject: ModelIntakeSubject): Awaitable<ModelIntakeSubject>
  issueIntakeToken(subject: ModelIntakeSubject): Awaitable<string>
  subjectForIntakeToken(token: string): Awaitable<ModelIntakeSubject | null>
  /**
   * Save monthly limits for a role, nondeleted account or active project.
   * @param subjectType - quota owner category.
   * @param subjectId - role name or numeric public id; accepted account ids use canonical decimal storage.
   * @param tokenLimit - explicit limit, null for unlimited, or inherit when supported by the owner.
   * @param costLimit - company cost limit in micros, null for unlimited, or inherit when supported by the owner.
   * @param actorUserId - authenticated administrator; omitted for trusted maintenance.
   */
  setQuota(
    subjectType: 'role' | 'user' | 'project',
    subjectId: string,
    tokenLimit: number | null | 'inherit',
    costLimit: number | null | 'inherit',
    actorUserId?: number,
  ): Awaitable<void>
  /**
   * Record owner billing with immutable execution proof from the authenticated reporting identity.
   * @param subject - account/project and optional Runtime from its reporting credential.
   * @param event - usage report; supplied proof must belong to that Runtime when present.
   * @returns insertion status and the number of resulting quota alerts.
   */
  ingest(subject: ModelIntakeSubject, event: UsageEvent): Awaitable<{ inserted: boolean; alerts: number }>
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
  /**
   * Stored per-user quota modes and custom limits.
   * @param userId - public user id
   * @returns per-metric modes; absent rows mean the user fully inherits the role quota
   */
  userQuota?(userId: number): Awaitable<UserQuotaView>
  /**
   * Stored role limits.
   * @param role - quota subject role
   * @returns stored integer limits; absent or null means unlimited
   */
  roleQuota?(role: 'admin' | 'user'): Awaitable<RoleQuotaView>
}

/** Instance lifecycle operations; Admin adapters preserve supplied administrator ids, while omission permits trusted maintenance. */
export type GatewayInstanceService = Pick<
  InstanceManager,
  'beforeStart' | 'beforeUse' | 'portOf' | 'stateOf' | 'stopReasonOf' | 'generationOf' | 'isLive' | 'liveEndpoint' | 'touch' | 'wsRef' | 'ensureRunning' | 'startRequest' | 'reapIdle' | 'reconcile'
  | 'stop' | 'stopAll' | 'withStopped'
> & {
  /** Exact Runtime assignment lookup; omitted only by legacy single-assignment adapters. */
  resolveTarget?: InstanceManager['resolveTarget']
  /** Local Runtime enumeration for owner-wide policy and lifecycle changes. */
  targetsForOwner?: InstanceManager['targetsForOwner']
  /** Persisted per-Runtime local storage, without process startup. */
  storageOf?: InstanceManager['storageOf']
  /** Node-local assignment or retained lifecycle ownership, when provided by the manager. */
  owns?: InstanceManager['owns']
  /** Optional long-request lease supported by the production manager. */
  operationRef?: InstanceManager['operationRef']
  /** Node-local managed Runtime admission observations, when supported by the provider. */
  capacitySnapshot?: () => import('./runtime-capacity.ts').RuntimeCapacitySnapshot
}
