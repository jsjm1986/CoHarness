import { createHash } from 'node:crypto'
import { AccessNodeDrainingError } from './access-invalidation.ts'
import { RESOURCE_ACTIVE_MODEL_CHECK_HEADER, RESOURCE_INGRESS_TIMING_HEADER, isResourceAdmissionRequest } from '@deepseek-ai/dsh-resource-budget/wire'
import { checkDocumentAttachmentTarget } from './node-content-documents-target.ts'
import { NodeContentUnavailable } from './node-content-store.ts'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer, STATUS_CODES } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { UserRow } from './auth.ts'
import {
  AccountPreferencesConflictError,
  AccountPreferencesInputError,
  AccountPreferencesUnavailableError,
  normalizeAccountPreferenceMutation,
} from './account-preferences.ts'
import { CollaborationDeniedError, type ProjectReadAuthorityView, type ProjectScopeView } from './collaboration.ts'
import type { GatewayConfig } from './config.ts'
import type { WriteGateVerdict } from './postgres/maintenance-service.ts'
import { RuntimeStartBlockedError, type ProjectRuntime, type RuntimeSubject } from './instances.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { PrincipalScope } from './principal.ts'
import { forwardRequestMatches, type GatewayForwardClaims, type GatewayForwardSessionCandidate } from './forwarded-principal.ts'
import type { GatewayPushService, PushProvider } from './push-notifications.ts'
import { gateCopy, gateLanguage, loginPage, passwordPage, environmentsPage, waitingPage, runtimeStartFailurePage, type RuntimeStartFailureReason, type RuntimeStartRetry } from './html.ts'
import { RuntimeStartObservations } from './runtime-start-observation.ts'
import { NodeServiceResponseUnknownError } from './node-service-proxy.ts'
import { browserReturnPath } from './browser-return.ts'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './password.ts'
import {
  DOCUMENT_TRANSFER_UPLOADS_PATH,
  DOCUMENT_SCOPE_PATH,
  DocumentLeaseReleaseError,
  DocumentTransferError,
  parseDocumentScopeKey,
  type GatewayDocumentScopeHandler,
  type GatewayDocumentAdminHandler,
  type GatewayDocumentTransferListHandler,
  type GatewayDocumentTransferUploadHandler,
} from './document-transfer.ts'
import type {
  Awaitable,
  GatewayAuditService,
  GatewayAuthService,
  GatewayCollaborationService,
  GatewayDocumentCatalogService,
  GatewayInstanceService,
  GatewayModelGovernanceService,
  GatewayProjectService,
  GatewayUserService,
  GatewayUserPreferencesService,
} from './services.ts'
import type { ConversationArchiveService } from './postgres/conversation-archive-service.ts'
import { SshTargetError } from './postgres/ssh-target-service.ts'
import { NonPublicNetworkTargetError } from './public-network-fetch.ts'
import { isAdminPath, serveAdmin } from './static.ts'
import { ResponseBodyTooLargeError } from './response-budget.ts'
import { removeBootstrapAdminPassword } from './bootstrap-admin.ts'
import type { ProjectConfigurationView } from './project-configuration.ts'
import type { ProjectInvitation, ProjectKind, ProjectThemePolicy } from './projects.ts'
import { applyModelGovernanceToProject, modelPolicyProjectionDiagnostics, scheduleModelGovernanceRefresh } from './apply-model-governance.ts'
import { ProjectModelSettingsConflictError, type ModelSettingsPathOp } from './model-governance.ts'
import type { GatewayWorkbenchCatalogHandler } from './workbench.ts'
import { OperationTimings, recordReadySession, timeOperation, timeResourceBearer } from './operation-timing.ts'
import { GatewayPerformanceObserver, type ReadySessionOutcome, type ReadySessionRoute } from './performance-observer.ts'
import { RuntimeCapacityError } from './runtime-capacity.ts'
import { RuntimeAccountError } from './launcher.ts'
import { RuntimeCatalogError, type RuntimeId, type RuntimeNodeId } from './runtime-catalog.ts'
import { isDelegatablePersonalRead, isExplicitScopeRequest, isExplicitSessionRequest, isImmutableRuntimeAssetRequest, isPersonalExecutionWriteRequest, isReadyRuntimeInteractive, isReadyRuntimeRead, isRuntimeResourceCompletionRequest, isRuntimeStreamControlRequest, pinRuntimeRequestPath, RUNTIME_MODEL_CREDENTIAL_PATH } from './runtime-request-path.ts'
import { sendCompressed } from './http-compression.ts'
import { DocumentCatalogError, parseDocumentOverviewOptions } from './document-catalog.ts'
import { BROWSER_DOCUMENT_OVERVIEW_STREAM } from './browser-documents.ts'
import { ComputerAccessError, type GatewayComputerAccess } from './computer-access.ts'
import { computerAccessApi } from './computer-access-api.ts'
import { DeploymentTopologyError } from './deployment-topology.ts'
import { isCentralRuntimeManagementRequest } from './runtime-management-api.ts'
import { GatewayRuntimeRouter, InvalidRuntimeTargetError, LocalRuntimeAdapter, type RuntimePlacement } from './runtime-router.ts'
import { NodeAccessError, nodeUuidSchema } from './node-access.ts'
import { NODE_CHANNEL_PATH, NodeChannelError } from './node-channel-protocol.ts'
import { NODE_SERVICE_IDENTITY_PATH, NODE_SERVICE_LOCAL_PORT_HEADER, NODE_SERVICE_PROTOCOL_VERSION, NODE_SERVICE_STREAM_PATH, NODE_SERVICE_TARGET_HEADER, NodeServiceError, RELEASE_COMBO_DIGEST_HEADER } from './node-service-stream.ts'
import { WebhookEndpointError } from './postgres/webhook-endpoint-service.ts'
import { PostgresCheckoutQueueFullError, type PostgresPoolAdmissionSnapshot } from './postgres/database.ts'
import { forwardedClientAddress, trustedProxyList } from './login-source.ts'

interface DatabasePoolPerformance {
  total: number
  idle: number
  waiting: number
  maximum: number | null
  admission?: PostgresPoolAdmissionSnapshot | null
}

export interface GatewayDeps {
  /** Installed only when startup found a governance rebuild; ordinary organizations add no admission query. */
  governanceRecovery?: {
    /** Recheck the same imported governance epoch until its administrator releases normal access. */
    admission(): Awaitable<{ operationId: string; bootstrapUserId: number; state: 'review' | 'released' }>
    /** Recheck the bound database generation for recovery administration even after release. */
    verifyAdministration(): Awaitable<void>
  }
  /** Verify the originating database and independently held historical copies after project cutover. */
  sourceRetirement?: Pick<import('./node-content-source-retirement.ts').NodeContentSourceRetirement,'report'|'open'|'finalize'>
  contentMigrations?: Pick<import('./node-content-migration-admin.ts').NodeContentMigrationAdmin,'choices'|'preflight'|'prepare'|'publish'>
  /** Primary-only blind equality identifiers for organization-wide project naming. */
  projectNames?: Pick<import('./primary-project-names.ts').PrimaryProjectNames, 'forRequest' | 'redeem' | 'status' | 'prepare' | 'activate'>
  projectMetadata?: Pick<import('./node-content-projects.ts').NodeProjectMetadata, 'authorizedMetadata'>

  /** One-way migration of an exact personal allocation to its owner index. */
  personalDirectory?: Pick<import('./workspace-catalog.ts').PostgresWorkspaceCatalog, 'promotePersonal'> &
    Partial<Pick<import('./workspace-catalog.ts').PostgresWorkspaceCatalog,'previewPersonal'>>

  /** On-demand, node-local content volume health; no Runtime is started by this check. */
  nodeContent?: Pick<import('./node-content-connection.ts').NodeContentConnection, 'health'>

  /** Organization policy belongs to this browser ingress, independently of selected Runtime placement. */
  topology?: Pick<import('./deployment-topology.ts').PostgresDeploymentTopology, 'read' | 'adminRead' | 'save' | 'preflight' | 'assertNode' | 'candidates'>
  /** Private setup and installed-service actions owned by the handling computer. */
  nodeConnection?: Pick<import('./node-connection.ts').GatewayNodeConnection, 'view' | 'save' | 'start'>
  /** Shared, bounded document-root metadata; reads require no personal Runtime. */
  documentLocations?: Pick<import('./postgres/document-locations.ts').PostgresDocumentLocations, 'page' | 'resolve'>
  documentOverview?: Pick<import('./postgres/document-catalog-service.ts').PostgresDocumentCatalogService, 'overview'>
    & Partial<Pick<import('./postgres/document-catalog-service.ts').PostgresDocumentCatalogService, 'localOverview'>>
  cfg: GatewayConfig
  auth: GatewayAuthService
  /** Current browser session and local computer permission after acquiring a Runtime. */
  revalidateOnComputer?(token:string): Promise<UserRow|null>
  /** Fresh session and project authority for existing event socket renewal. */
  streamPrincipalAuthority?: Pick<GatewayAuthService, 'qualifyForStream'> & Pick<GatewayCollaborationService, 'projectForUser'>
  users: GatewayUserService
  projects: GatewayProjectService
  audit: GatewayAuditService
  instances: GatewayInstanceService
  /** Organization metadata only; directory reads never require a ready execution node. */
  runtimeCatalog?: Pick<import('./postgres/runtime-catalog.ts').PostgresRuntimeCatalog, 'pageForAccount' | 'pageForAdministrator' | 'resolveForAccount'>
    & Partial<Pick<import('./postgres/runtime-catalog.ts').PostgresRuntimeCatalog, 'resolveForAdministrator' | 'pageForAdministratorOwner'>>
  /** Shared allocation policy and receipts with node-local directory preparation. */
  runtimeManagement?: Pick<import('./runtime-management.ts').PostgresRuntimeManagement, 'policy' | 'setPolicy' | 'allocate' | 'allocationReceipt' | 'retire'>
  /** Organization computer grants; legacy standalone adapters without computer records omit this service. */
  computerAccess?: GatewayComputerAccess
  /** Placement and local owner resolution; metadata-only compositions may omit execution routing. */
  runtimeRouter?: Pick<GatewayRuntimeRouter, 'resolve' | 'placement' | 'landing'>
  /** Center-owned node credentials and control-only outbound connection leases. */
  nodeAccess?: Pick<import('./postgres/node-access-service.ts').PostgresNodeAccessService, 'issue' | 'mutate' | 'list' | 'enroll' | 'connect' | 'heartbeat' | 'disconnect' | 'checkRemoval' | 'remove'>
  /** Ordinary-maintenance lease admission bound to this process's write epoch and shutdown state. */
  maintainNodeConnection?: (operation: import('./node-access.ts').NodeControlOperation, token: string, input: unknown) => Promise<import('./node-access.ts').NodeLease | void>
  /** Optional outbound control-channel owner; its supplying lifecycle closes it before the PostgreSQL pool. */
  nodeChannels?: Pick<import('./node-channel.ts').GatewayNodeChannels, 'accept' | 'probe' | 'revoke'>
  /** Binary connections to this center, owned and closed independently of control probes. */
  nodeServices?: Pick<import('./node-service.ts').GatewayNodeServices, 'accept' | 'revoke'> & Partial<Pick<import('./node-service.ts').GatewayNodeServices, 'pauseIdle'>>
  /** Existing node-local Gateway identity and live node-lease verification for the local bridge. */
  nodeServiceIdentity?: {
    nodeId: import('./runtime-catalog.ts').RuntimeNodeId
    organizationId: string
    authorize(token: string, input: unknown): Promise<import('./node-access.ts').NodeServiceIdentityLease>
  }
  /** Authenticated forwarding to another computer's existing Gateway, when explicitly enabled. */
  nodeServiceProxy?: Pick<import('./node-service-proxy.ts').GatewayNodeServiceProxy, 'http' | 'upgrade'> & Partial<Pick<import('./node-service-proxy.ts').GatewayNodeServiceProxy, 'webhook' | 'closeIdle' | 'diagnostics'>>
  /** Shared process diagnostics; its supplying owner disposes it after all observed listeners close. */
  performance?: GatewayPerformanceObserver
  /** Native pool counters, without querying the database or retaining connection details. */
  databasePerformance?: () => DatabasePoolPerformance & { control?: DatabasePoolPerformance; accessListener?: DatabasePoolPerformance }
  /** Durable revocations shared by Gateways using the same organization. */
  accessMonitor?: import('./access-invalidation.ts').GatewayAccessMonitor
  /** Peer-signed forwarded-request assertion verifier; null falls back to session validation. */
  forwardedPrincipal?: (assertion: string) => Promise<import('./forwarded-principal.ts').GatewayForwardClaims | null>
  /** Verify a Session signature with known key bytes whose publication is checked during ready admission. */
  forwardedSessionPrincipal?: (assertion: string) => GatewayForwardSessionCandidate | null
  governance?: GatewayModelGovernanceService
  collaboration?: GatewayCollaborationService
  /** Optional human-facing project progress journal; absent without PostgreSQL. */
  progress?: Pick<import('./postgres/progress-service.ts').PostgresProgressService,
    'progressForUser' | 'generateNow' | 'digestModelSettings' | 'setDigestModel'>
  /** PostgreSQL-backed account preferences; absent in legacy test compositions. */
  userPreferences?: GatewayUserPreferencesService
  /** Optional organization-level document metadata catalog. */
  documents?: GatewayDocumentCatalogService
  /** Optional organization-wide archived conversation index and lifecycle service. */
  archives?: ConversationArchiveService
  /** Optional persistent device registry and multi-provider push delivery service. */
  push?: GatewayPushService
  /** Optional interactive-desktop coordinator; absent where desktop driving is disabled. */
  desktops?: import('./desktop-coordinator.ts').DesktopCoordinator
  desktopAccess?: Pick<import('./desktop-access.ts').DesktopAccess, 'get' | 'set'>
  /** Optional administrator-owned plugin-management qualification store. */
  pluginAccess?: Pick<import('./plugin-access.ts').PluginAccess, 'get' | 'set'>
  /** Optional administrator-owned steward-space qualification store. */
  stewardAccess?: Pick<import('./steward-access.ts').StewardAccess, 'get' | 'set' | 'list'>
  /** Optional administrator-owned shared-memory write qualification store. */
  memoryAccess?: Pick<import('./memory-access.ts').MemoryAccess, 'get' | 'set'>
  pluginManagement?: Pick<import('./plugin-management.ts').GatewayPluginManagement, 'target' | 'invoke' | 'state' | 'saveState' | 'overview' | 'inventory'>
  /** Optional durable plugin desired-state store backing spawn projection and runtime write-back. */
  pluginState?: Pick<import('./plugin-state.ts').PostgresPluginState, 'get' | 'set' | 'readForSubject' | 'publishForSubject' | 'projection' | 'markApplied' | 'applied' | 'observed' | 'project' | 'list'>
  /** Optional durable plugin inventory store backing runtime reports and the administrator overview. */
  pluginInventory?: Pick<import('./plugin-inventory.ts').PostgresPluginInventory, 'report' | 'list'>
  terminalManagement?: Pick<import('./terminal-management.ts').GatewayTerminalManagement, 'list' | 'close'>
  terminalAccess?: Pick<import('./terminal-access.ts').TerminalAccess, 'get' | 'set'>
  sshAccess?: Pick<import('./ssh-access.ts').SshAccess, 'get' | 'set'>
  sshTargets?: Pick<import('./postgres/ssh-target-service.ts').PostgresSshTargetService, 'list' | 'listForProject' | 'create' | 'update' | 'mutate' | 'share' | 'shareAsAdministrator' | 'resolveForRuntime'>
  webhookDeliveries?: Pick<import('./postgres/webhook-delivery-service.ts').PostgresWebhookDeliveryService, 'list'>
  /** Optional administrator-registered webhook endpoint service. */
  webhookEndpoints?: Pick<import('./postgres/webhook-endpoint-service.ts').PostgresWebhookEndpointService, 'list' | 'create' | 'update' | 'mutate'> & Partial<Pick<import('./postgres/webhook-endpoint-service.ts').PostgresWebhookEndpointService, 'placement'>>
  /** Optional public-access tunnel (cloudflared) orchestration for this node. */
  tunnelAccess?: Pick<import('./tunnel-access.ts').GatewayTunnelAccess, 'view' | 'install' | 'startQuick' | 'startNamed' | 'stop' | 'clear'>
  /** Optional public provider ingress and administrator redispatch orchestrator. */
  webhookIntake?: Pick<import('./webhook-intake.ts').GatewayWebhookIntake, 'handle' | 'redispatch'>
  /** Maintenance windows, writer convergence, and restore fencing for shared PostgreSQL. */
  maintenance?: Pick<import('./postgres/maintenance-service.ts').PostgresMaintenanceService,
    'state' | 'administration' | 'enterMaintenance' | 'exitMaintenance' | 'setNodeStatus' | 'listOperations' | 'requestRestore' | 'logOperation'>
  /** Current-node configuration with identity and revision checks. */
  nodeConfiguration?: Pick<import('./node-config-store.ts').NodeConfigurationStore, 'view' | 'save' | 'requestApply'>
  /** Deployment backup registry. */
  backups?: Pick<import('./postgres/backup-service.ts').PostgresBackupService, 'list' | 'get' | 'record' | 'setVerified'>
  /** Administrator-owned remote-desktop endpoints, grants, and audit view. */
  remoteDesktop?: Pick<import('./remote-desktop-service.ts').RemoteDesktopService,
    'endpoints' | 'saveEndpoints' | 'listGrants' | 'createGrant' | 'setLevel' | 'revoke' | 'audit'>
  /** Backup execution context for administrator-driven dumps. */
  backupWork?: GatewayBackupWork
  /** Packaged-versus-applied migration diff for the deployment page. */
  migrationPlan?: () => Promise<import('./postgres/database.ts').MigrationPlan>
  /**
   * Mutating-request gate consulted after authentication. Returns 'open'
   * while serving, 'maintenance' during a window, and 'stale-epoch' when this
   * process predates a completed restore. Absent leaves every write open.
   */
  maintenanceGate?: () => Promise<import('./postgres/maintenance-service.ts').WriteGateVerdict>
  /** Fresh maintenance and write-epoch check for node and Runtime stream control. */
  leaseControlGate?: GatewayDeps['maintenanceGate']
  /**
   * Mark one mutating request as an in-flight writer until its handler
   * settles, even if its client disconnects. Called at gate admission — before the gate verdict is read — so
   * the node's reported writer count covers work already past the gate, not
   * just requests still waiting on it. Applied only to gateway-local write
   * paths: proxied `/api` calls hold no deployment write themselves (their
   * effects reach the store through `/internal/runtime/*` and the usage
   * intake, both separately counted), so a long-lived streaming response
   * would otherwise pin the quiesce ledger open indefinitely. Absent
   * disables inflight accounting.
   */
  writerSpan?: () => (() => void)
  readiness?: (signal?: AbortSignal) => Awaitable<void>
  /**
   * Optional center-local server for the release's built web frontend dist.
   * When present, byte-deterministic `/assets/*` and `/favicon.svg` requests
   * are answered from the center's own release files — identical bytes to
   * what any same-release Runtime would serve — instead of pinning a Runtime
   * and proxying the owning node. Absent keeps Referer-pinned forwarding for
   * every asset path.
   */
  releaseAssets?: Pick<import('./release-assets.ts').ReleaseAssets, 'serve'>
    & Partial<Pick<import('./release-assets.ts').ReleaseAssets, 'serveDeferredIndex'>>
}

/** Backup execution wiring shared by the admin backup routes. */
export type GatewayBackupWork = Pick<import('./postgres/deployment-backups.ts').PostgresDeploymentBackups, 'create' | 'verify' | 'previewNodeConfiguration'>

export const SESSION_COOKIE = 'hgw_session'
export const SCOPE_COOKIE = 'hgw_scope'

class GovernanceAdmissionUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Governance recovery admission could not be verified', { cause })
  }
}

/** A browser's previously observed account is a refusal condition, never an identity grant. */
function browserPrincipalMatches(req: IncomingMessage, user: UserRow): boolean {
  const expected = req.headers['x-dsh-expected-principal-id']
  const query = new URL(req.url ?? '/', 'http://x').searchParams.getAll('dshPrincipal')
  const current = String(user.id)
  return (expected === undefined || expected === current) && (query.length === 0 || query.length === 1 && query[0] === current)
}

function assertPlacementComputer(placement: RuntimePlacement, selected: string | null,
  forwarded: IncomingMessage['headers'][string], localNode: string | undefined): void {
  const owner = placement.environment?.node.id
  if (selected !== null && selected !== owner) throw new NodeServiceError(400, 'node-service/invalid-target')
  if (forwarded !== undefined && forwarded !== owner || localNode !== undefined && placement.local && localNode !== owner) {
    throw new NodeServiceError(409, 'node-service/mismatch')
  }
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim())
  }
  return map
}

/**
 * Retain the browser token through the absolute lifetime; database validation enforces sliding idle expiry.
 * @param token - issued session token, or an empty value when clearing.
 * @param cfg - validated session lifetimes and cookie security policy.
 * @param clear - true emits immediate expiry; false rounds absolute retention up to whole seconds.
 * @returns the HttpOnly session Set-Cookie value.
 */
export function sessionCookie(token: string, cfg: GatewayConfig, clear = false): string {
  const maxAge = clear ? 0 : Math.ceil(cfg.sessionAbsoluteTtlMs / 1000)
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
    + (cfg.secureCookies ? '; Secure' : '')
}

/**
 * Retain the selected scope through the browser login's absolute lifetime.
 * @param scope - selection whose access is rechecked on subsequent requests.
 * @param cfg - validated absolute lifetime and cookie security policy.
 * @returns an HttpOnly selection cookie with lifetime rounded up to whole seconds.
 */
export function scopeCookie(scope: 'personal' | `project:${number}`, cfg: GatewayConfig): string {
  return `${SCOPE_COOKIE}=${scope}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.ceil(cfg.sessionAbsoluteTtlMs / 1000)}`
    + (cfg.secureCookies ? '; Secure' : '')
}

function wantsHtml(req: IncomingMessage): boolean {
  return (req.headers.accept ?? '').includes('text/html')
}

class BodyTooLargeError extends Error {}

async function readBody(req: IncomingMessage, limit = 1024 * 1024): Promise<string> {
  const declared = req.headers['content-length']
  if (typeof declared === 'string') {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      req.resume()
      throw new BodyTooLargeError('body too large')
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  try {
    for await (const chunk of req) {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk as Buffer).byteLength
      size += bytes
      if (size > limit) {
        req.resume()
        throw new BodyTooLargeError('body too large')
      }
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
    }
  } catch (error) {
    req.resume()
    throw error
  }
  return Buffer.concat(chunks).toString()
}

function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type })
  res.end(body)
}

function runtimeStartProblem(error: unknown): { status: number; reason: RuntimeStartFailureReason; retryable: boolean } | undefined {
  if (error instanceof RuntimeCapacityError || error instanceof PostgresCheckoutQueueFullError) {
    return { status: 503, reason: 'busy', retryable: true }
  }
  if (error instanceof RuntimeAccountError) return { status: error.status, reason: 'account', retryable: false }
  if (error instanceof BodyTooLargeError || error instanceof InvalidRuntimeTargetError) return { status: error instanceof BodyTooLargeError ? 413 : 400, reason: 'invalid', retryable: false }
  if (error instanceof RuntimeStartBlockedError) return { status: error.code === 'INSTANCE_STOPPED' ? 409 : 503, reason: 'changed', retryable: false }
  if (error instanceof CollaborationDeniedError) return { status: error.code === 'conversation-not-found' ? 404 : 403, reason: 'denied', retryable: false }
  if (error instanceof RuntimeCatalogError || error instanceof NodeAccessError || error instanceof NodeServiceError
    || error instanceof NodeChannelError || error instanceof ComputerAccessError || error instanceof DeploymentTopologyError) {
    return { status: error.status, reason: error.status === 401 || error.status === 403 ? 'denied'
      : error.status === 400 ? 'invalid' : error.status === 409 ? 'changed' : 'unavailable', retryable: error.status >= 500 }
  }
  return undefined
}

function requestAbort(req: IncomingMessage, res: ServerResponse): {
  signal: AbortSignal
  cancel: (reason: unknown) => void
  dispose: () => void
} {
  const controller = new AbortController()
  const onRequestAbort = (): void => { if (!controller.signal.aborted) controller.abort(new Error('document request aborted')) }
  const onResponseClose = (): void => { if (!res.writableEnded) onRequestAbort() }
  req.once('aborted', onRequestAbort)
  res.once('close', onResponseClose)
  return {
    signal: controller.signal,
    cancel: reason => { controller.abort(reason) },
    dispose: () => {
      req.removeListener('aborted', onRequestAbort)
      res.removeListener('close', onResponseClose)
    },
  }
}

/** Retain browser document revocation through input, response and runtime-lease cleanup. */
function watchDocumentAccess(
  deps: GatewayDeps, res: ServerResponse, abort: ReturnType<typeof requestAbort>, user: UserRow,
  scope: ReturnType<typeof parseDocumentScopeKey>,
) {
  let complete!: (value: undefined) => void
  const completion = new Promise<undefined>(resolve => { complete = resolve })
  let checkingAuthority = false
  let handling = false
  let cleanupFailure: DocumentLeaseReleaseError | undefined
  const unsubscribe = deps.accessMonitor?.subscribe(async subject => {
    if (!checkingAuthority && !handling) return
    if (subject.userId !== undefined && subject.userId !== user.id) return
    if (subject.projectId !== undefined && (scope.kind !== 'project' || scope.projectId !== subject.projectId)) return
    abort.cancel(new DocumentTransferError('COLLABORATION_FORBIDDEN', 403, 'Document access was revoked.'))
    res.destroy()
    // Admission can itself be awaiting this monitor's catch-up.
    if (handling) {
      await completion
      if (cleanupFailure !== undefined) throw cleanupFailure
    }
  })
  const requireMonitor = (): void => {
    if (deps.accessMonitor?.available === false) throw new DocumentTransferError('COLLABORATION_UNAVAILABLE', 503, 'Document access monitoring is unavailable.')
  }
  return {
    signal: abort.signal,
    async admit(token: string): Promise<UserRow | null> {
      await deps.accessMonitor?.synchronize()
      abort.signal.throwIfAborted()
      requireMonitor()
      checkingAuthority = true
      const current = await deps.auth.validate(token)
      if (current === null || current.id !== user.id || current.mustChangePassword) return null
      await deps.accessMonitor?.synchronize()
      abort.signal.throwIfAborted()
      requireMonitor()
      handling = true
      return current
    },
    finish(failure?: DocumentLeaseReleaseError): void {
      cleanupFailure = failure
      // Failed lease release remains attached to future catch-up attempts.
      if (failure === undefined) unsubscribe?.()
      abort.dispose()
      complete(undefined)
    },
  }
}

/**
 * Wait for writable capacity or a closed response without leaving the losing
 * event listener behind.  A plain `Promise.race([once(...)])` retains one
 * listener for every backpressured response until the other event eventually
 * fires; long-lived downloads then trigger EventEmitter listener warnings.
 */
async function waitForResponseWritable(res: ServerResponse): Promise<'drain' | 'close'> {
  if (res.destroyed || res.writableEnded) return 'close'
  return new Promise<'drain' | 'close'>(resolve => {
    let settled = false
    const finish = (event: 'drain' | 'close'): void => {
      if (settled) return
      settled = true
      res.removeListener('drain', onDrain)
      res.removeListener('close', onClose)
      resolve(event)
    }
    const onDrain = (): void => { finish('drain') }
    const onClose = (): void => { finish('close') }
    res.once('drain', onDrain)
    res.once('close', onClose)
    // The response can close between the state check above and listener
    // installation. Re-check after registration so that waiters never wedge.
    if (res.destroyed || res.writableEnded) finish('close')
  })
}

async function sendGatewayResponse(res: ServerResponse, response: Response, limit: number): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    await response.body?.cancel()
    return
  }
  const declared = response.headers.get('content-length')
  if (declared !== null) {
    const length = Number(declared)
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) {
      await response.body?.cancel()
      send(res, 502, JSON.stringify({ error: { code: 'UPSTREAM_RESPONSE_TOO_LARGE', message: 'The runtime response is too large.' } }), 'application/json')
      return
    }
  }
  const headers: Record<string, string> = {
    'content-type': response.headers.get('content-type') ?? 'application/json; charset=utf-8',
    'cache-control': response.headers.get('cache-control') ?? 'no-store',
  }
  for (const name of ['content-length', 'content-disposition', 'x-content-type-options', 'content-security-policy']) {
    const value = response.headers.get(name)
    if (value !== null) headers[name] = value
  }
  res.writeHead(response.status, headers)
  if (response.body === null) {
    res.end()
    return
  }
  const reader = response.body.getReader()
  let releaseFailure: DocumentLeaseReleaseError | undefined
  let cancellation: Promise<void> | undefined
  const cancel = (): Promise<void> => cancellation ??= reader.cancel().catch((error: unknown) => {
    // Upstream abort/read failures have already closed the response. A lease
    // failure is independent and must reach the access monitor's acknowledgment.
    if (error instanceof DocumentLeaseReleaseError) releaseFailure = error
  })
  const cancelOnClose = (): void => { void cancel() }
  res.once('close', cancelOnClose)
  try {
    let total = 0
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (res.destroyed || res.writableEnded) break
      total += next.value.byteLength
      if (total > limit) {
        await cancel()
        if (!res.destroyed) res.destroy(new ResponseBodyTooLargeError(limit))
        break
      }
      if (!res.write(next.value) && await waitForResponseWritable(res) === 'close') break
      if (res.destroyed) break
    }
    if (!res.writableEnded) res.end()
  } catch (error) {
    if (error instanceof DocumentLeaseReleaseError) releaseFailure = error
    if (!res.destroyed) res.destroy(error as Error)
  } finally {
    res.removeListener('close', cancelOnClose)
    await cancel()
    reader.releaseLock()
  }
  if (releaseFailure !== undefined) throw releaseFailure
}

function isScopedUploadDataPath(method: string | undefined, pathname: string): boolean {
  return (method === 'PUT' && /\/chunks\/[0-9]+$/u.test(pathname))
    || (method === 'GET' && /^\/api\/documents\/transfer\/uploads\/[0-9a-f-]{36}$/u.test(pathname))
}

function scopedDocumentOperation(pathname: string, method: string | undefined): import('./document-transfer.ts').GatewayDocumentScopeOperation | undefined {
  if (pathname === DOCUMENT_SCOPE_PATH) {
    if (method === 'GET') return 'list'
    if (method === 'DELETE') return 'delete'
  }
  if (pathname === `${DOCUMENT_SCOPE_PATH}/directories` && method === 'GET') return 'directories'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/content` && (method === 'GET' || method === 'HEAD')) return 'content'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/trash` && (method === 'GET' || method === 'POST')) return 'trash'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/restore` && method === 'POST') return 'restore'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/purge` && method === 'DELETE') return 'purge'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/folders` && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) return 'folders'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/move` && method === 'POST') return 'move'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/overview` && method === 'GET') return 'overview'
  if (pathname === `${DOCUMENT_SCOPE_PATH}/history` && method === 'GET') return 'history'
  return undefined
}

function sendAdminGate(res: ServerResponse, pathname: string, error: string): void {
  if (pathname.startsWith('/admin/api')) {
    send(res, 403, JSON.stringify({ error }), 'application/json')
    return
  }
  send(res, 403, error, 'text/plain')
}

// Byte-deterministic paths: the URL alone names the same bytes on every
// Runtime. Keep the asset regex aligned with IMMUTABLE_ASSET_PATH in
// packages/host/frontend-static; the chunk form mirrors the modules package's
// CLIENT_CHUNK route contract.
const SHARED_ASSET_PATH = /^\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/u
const SHARED_PLUGIN_CHUNK_PATH = /^\/plugins\/.+\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js(?:\.map)?$/u

/**
 * Whether one Referer-selected path is byte-deterministic across Runtimes and
 * can be forwarded without a visible runtime pin.
 * @param pathname - decoded request pathname.
 * @param url - the full request URL (query identifies the content revision).
 * @returns true for content-hashed `/assets/*` and `/plugins/*` URLs carrying
 * a content-addressed revision; runtime-specific or unrevisioned paths stay on
 * the pin redirect.
 */
function shareableImmutableRequest(pathname: string, url: URL): boolean {
  if (SHARED_ASSET_PATH.test(pathname)) return true
  // `/plugins/events`, `/favicon.svg`, and revision-less plugin URLs are not
  // byte-deterministic; the combo `??` marker and `rev` parameter name bytes.
  if (pathname === '/plugins/combo.js') return url.search.startsWith('??') && url.searchParams.has('rev')
  if (SHARED_PLUGIN_CHUNK_PATH.test(pathname)) return url.searchParams.has('rev')
  return false
}

function redirect(res: ServerResponse, location: string, cookies: string[] = []): void {
  res.writeHead(302, { location, ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) })
  res.end()
}

function csrfOk(req: IncomingMessage, cfg: GatewayConfig, pathname: string): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return true
  const origin = req.headers.origin
  if (origin !== undefined) return cfg.publicOrigins.includes(origin)
  return pathname.startsWith('/api')
}

function jsonObject(body: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** Decode path-addressed settings edits at the Gateway HTTP boundary. */
function projectSettingsOps(value: unknown): ModelSettingsPathOp[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const result: ModelSettingsPathOp[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined
    const row = entry as Record<string, unknown>
    if (!Array.isArray(row.path) || row.path.some(segment => typeof segment !== 'string'
      || segment.length === 0 || segment === '__proto__' || segment === 'prototype' || segment === 'constructor')) return undefined
    if (row.op === 'set' && Object.hasOwn(row, 'value')) {
      result.push({ op: 'set', path: row.path as string[], value: row.value })
    } else if (row.op === 'unset' && !Object.hasOwn(row, 'value')) {
      result.push({ op: 'unset', path: row.path as string[] })
    } else return undefined
  }
  return result
}

class ReadPublicationUnavailableError extends Error {
  constructor(kind: 'project' | 'invitation' | 'usage', cause: unknown) { super(`${kind}-read-authority-unavailable`, { cause }) }
}

/** Read the browser account's project directory, including current ownership and theme policy. */
async function accountContextProjects(deps: GatewayDeps, user: UserRow): Promise<ProjectScopeView[]> {
  const scopes = await deps.collaboration?.projectsForUser(user.id, 'account-context') ?? []
  const ids = scopes.filter(scope => scope.owner === undefined || scope.origin === undefined || scope.uiThemePolicy === undefined)
    .map(scope => scope.projectId)
  const details = ids.length === 0 ? [] : deps.projects.getScopeMetadataByIds !== undefined
    ? await deps.projects.getScopeMetadataByIds(ids)
    : deps.projects.getByIds === undefined
      ? await deps.projects.list()
      : await deps.projects.getByIds(ids)
  const byId = new Map(details.map(project => [project.id, project]))
  return Promise.all(scopes.map(async ({ canManage: granted, ...scope }) => {
    const detail = byId.get(scope.projectId)
    const owner = detail?.owner !== undefined ? detail.owner
      : scope.owner !== undefined ? scope.owner : (await deps.projects.getById(scope.projectId))?.owner
    const canManage = granted ?? (user.role === 'admin' || owner?.id === user.id)
    return {
      ...scope,
      ...(canManage ? { canManage: true } : {}),
      ...(detail?.origin === undefined ? {} : { origin: detail.origin }),
      ...(detail?.owner === undefined ? {} : { owner: detail.owner }),
      ...(detail?.uiThemePolicy === undefined ? {} : { uiThemePolicy: detail.uiThemePolicy }),
    }
  }))
}

/** Authority lookup failures withhold prepared records and database diagnostics. */
async function readPublicationAuthority<T>(kind: 'project' | 'invitation' | 'usage', read: () => Awaitable<T>): Promise<T> {
  try { return await read() }
  catch (cause) {
    if (cause instanceof CollaborationDeniedError) throw cause
    throw new ReadPublicationUnavailableError(kind, cause)
  }
}

/**
 * Replace a project model-discovery failure with a fixed code for callers that
 * are not Gateway administrators, so upstream URLs, status lines, and response
 * bodies are never echoed to them. Authorization failures keep their mapping.
 */
function withheldDiscoveryError(error: unknown): string | undefined {
  if (error instanceof CollaborationDeniedError || error instanceof ReadPublicationUnavailableError) return undefined
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof NonPublicNetworkTargetError) return 'model-discovery-target-not-public'
  }
  return 'model-discovery-failed'
}

function accountProjectError(error: unknown): { status: number; error: string } {
  if (error instanceof ReadPublicationUnavailableError) return { status: 503, error: error.message }
  if (error instanceof BodyTooLargeError) {
    return { status: 413, error: 'request-too-large' }
  }
  if (error instanceof CollaborationDeniedError) {
    return { status: error.code === 'conversation-not-found' ? 404 : 403, error: error.code }
  }
  if (error instanceof Error) {
    const status = error.message === 'invitation-already-pending' || error.message === 'invitation-already-member'
      || error.message.startsWith('settings-conflict:') ? 409
      : error.message === 'invitation-not-found' || error.message === 'project-not-found' ? 404
        : error.message === 'invitation-forbidden' ? 403
          : error.message === 'invitation-expired' ? 410
            : error.message === 'invitation-not-pending' ? 409
              : error.message === 'owner-protected' || error.message === 'owner-must-be-rw' || error.message === 'user-disabled' ? 409
                : error.message.startsWith('duplicate ') ? 409
                  : error.message.startsWith('unknown project') ? 404 : 400
    return { status, error: error.message.startsWith('settings-conflict:') ? 'settings-conflict' : error.message }
  }
  return { status: 400, error: String(error) }
}

/** Project database writes remain successful while a file projection retries. */
async function applyProjectGovernanceBestEffort(
  deps: Pick<GatewayDeps, 'cfg' | 'governance' | 'projects' | 'users'>,
  projectId: number,
): Promise<void> {
  try {
    await applyModelGovernanceToProject(deps, projectId)
  } catch (error: unknown) {
    console.error('[gateway] project model policy projection deferred:', error)
    scheduleModelGovernanceRefresh(deps)
  }
}

export interface GatewayRequestContext {
  user: UserRow
  scope: PrincipalScope
  runtime: RuntimeSubject
  /** Explicit stable environment identity; process generation is resolved by the local lifecycle owner. */
  environment?: { id: import('./runtime-catalog.ts').RuntimeId; nodeId: import('./runtime-catalog.ts').RuntimeNodeId; nodeName?: string }
  /** Verified organization access revision already synchronized by the forwarding primary. */
  forwardedAccessRevision?: bigint
}

export type ProxyHandler = (req: IncomingMessage, res: ServerResponse, context: GatewayRequestContext) => Promise<void>

/** Exact personal event target resolved by the authenticated entry route. */
export interface ReadyEventSelection {
  actor: UserRow
  sessionToken: string
  runtimeId: RuntimeId
  nodeId: RuntimeNodeId
  entryNodeId?: RuntimeNodeId
  forwarded?: GatewayForwardSessionCandidate
}

/**
 * Admit an already running personal event connection with one current Runtime qualification.
 * @param req - original browser upgrade.
 * @param socket - browser transport, adopted only when the handler accepts it.
 * @param head - bytes after the upgrade headers.
 * @param selection - authenticated browser session and exact personal allocation.
 * @returns true if the handler owns the upgrade, or false for general Runtime preparation.
 */
export type ReadyEventHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, selection: ReadyEventSelection) => Promise<boolean>

/**
 * Upgrade after general Runtime preparation.
 * @param req - original browser upgrade.
 * @param socket - browser transport.
 * @param head - bytes after the upgrade headers.
 * @param context - authenticated account and resolved Runtime scope.
 * @returns after adopting or closing the transport.
 */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer, context: GatewayRequestContext) => Promise<void>

type ReadySessionObservation = (route: ReadySessionRoute, outcome: ReadySessionOutcome) => void

/**
 * Dispatch an exact Session operation or a qualified Runtime read against the supervised generation.
 * @param req - original request.
 * @param res - response owned by the handler after it accepts the request.
 * @param selection - authenticated browser session and exact local target.
 * @returns true if the handler owns the response, or false if normal routing must continue.
 */
export type ReadySessionHandler = (req: IncomingMessage, res: ServerResponse, selection: {
  actor: UserRow
  sessionToken: string
  runtimeId: RuntimeId
  nodeId: RuntimeNodeId
  target: RuntimePlacement['target']
  entryNodeId?: RuntimeNodeId
  forwarded?: GatewayForwardSessionCandidate
  managedPersonalRead?: true
  /** Observe the forwarding decision before the response settles. */
  observe?: ReadySessionObservation
}) => Promise<boolean>

function exactSessionSelectors(selection: URLSearchParams): { runtimeId: RuntimeId; target: RuntimePlacement['target'] } | undefined {
  const targets = selection.getAll('dshTarget'), runtimes = selection.getAll('dshRuntime')
  const target = targets[0] ?? '', project = /^project:([1-9][0-9]*)$/u.exec(target)
  if (runtimes.length !== 1 || !nodeUuidSchema.safeParse(runtimes[0]).success || targets.length !== 1
    || target !== 'personal' && (!project || !Number.isSafeInteger(Number(project[1])))) return undefined
  return { runtimeId: runtimes[0] as RuntimeId, target: target as RuntimePlacement['target'] }
}

function forwardedSessionMatches(forward: GatewayForwardClaims,
  selection: { runtimeId: RuntimeId; nodeId: RuntimeNodeId; target: RuntimePlacement['target'] }): boolean {
  return forward.selection?.runtimeId === selection.runtimeId && forward.selection.target === selection.target
    && forward.context?.environment.id === selection.runtimeId && forward.context.environment.nodeId === selection.nodeId
}

/** Invalidate already admitted runtime traffic after a committed access change. */
export type GatewayAccessInvalidation = (subject: import('./access-invalidation.ts').AccessInvalidationSubject) => void

/** Admission for a bounded personal execution request with a recognized bearer. */
interface PersonalExecutionWriteAdmission {
  readonly subject: RuntimeCredentialSubject
  /** The bearer requires fresh authorization before a general write or a failure response. */
  readonly fromCandidate: boolean
  /**
   * Retain a writer span and check the local stop gate or the shared maintenance gate.
   * @param sqlFenced - the exact write checks authority and maintenance in its own SQL statement.
   * @returns false after sending a write refusal.
   */
  admit(sqlFenced: boolean): Promise<boolean>
}

/** Buffered runtime control dispatcher with an optional authenticated stream entry. */
export interface GatewayRuntimeHandler {
  /**
   * @param req - authenticated runtime request with its bounded body already consumed.
   * @param res - response owned when this dispatcher returns true.
   * @param pathname - parsed request pathname.
   * @param body - bounded control payload, empty for GET and HEAD.
   * @param executionWrite - admission for exact personal execution or a model credential lookup.
   * @param controlSubject - exact Runtime identity preauthenticated for renewal or completion, with a final ownership check in the dispatcher.
   * @returns whether this dispatcher owns the response.
   */
  (req: IncomingMessage, res: ServerResponse, pathname: string, body: string, executionWrite?: PersonalExecutionWriteAdmission,
    controlSubject?: RuntimeCredentialSubject): Promise<boolean>
  /**
   * Identify a request whose parsed payload can select a transaction that checks its own authority.
   * @param subject - recognized Runtime identity to be checked for the exact write.
   * @param pathname - parsed request pathname.
   * @param method - HTTP method.
   * @param activeModelCheck - whether the provider requested an exact active model confirmation.
   * @returns whether the dispatcher will choose and apply the write gate before dispatch.
   */
  defersPersonalExecutionWrite?(subject: RuntimeCredentialSubject, pathname: string, method: string | undefined,
    activeModelCheck?: boolean): boolean
  /**
   * Handle raw bytes before buffered control admission; authenticate each operation before using them.
   * @param req - runtime-token-authenticated request with its body untouched.
   * @param res - response retained through body delivery and cleanup.
   * @param pathname - parsed request pathname.
   * @param writeGate - check before each mutating operation; retains its writer span until the response settles.
   * @returns true when handled, or false with the body untouched; read operations do not acquire a writer span.
   */
  stream?(req: IncomingMessage, res: ServerResponse, pathname: string, writeGate: () => Promise<WriteGateVerdict>): Promise<boolean>
}

export interface GatewayHandlers {
  /** Restricted recovery actions, authenticated here before any selected-node routing. */
  governanceRecovery?: Pick<import('./governance-rebuild-gateway.ts').GovernanceRebuildGateway, 'admin'>
  /** Authorized policies and opaque peer repositories for this ingress. */
  peerBackups?: Pick<import('./peer-backup-gateway.ts').PeerBackupGateway, 'admin' | 'internal'>
  /** Runtime-qualified node index. */
  workbenchRows?: ReturnType<typeof import('./workbench-rows.ts').workbenchRows>
  /** Drafts on the exact serving node, independent of Runtime process liveness. */
  nodeDrafts?: import('./node-drafts.ts').NodeDraftStorage

  /** Runtime-independent document plans, copy and directory operations through the center. */
  browserDocuments?: ReturnType<typeof import('./browser-documents.ts').createBrowserDocumentHandler>

  /** Stops affected HTTP responses and WebSockets; new requests authorize normally. */
  invalidateAccess?: GatewayAccessInvalidation
  proxy?: ProxyHandler
  /** False leaves the body untouched for ordinary Runtime selection and preparation. */
  readySession?: ReadySessionHandler
  readyEvent?: ReadyEventHandler
  upgrade?: UpgradeHandler
  /** Exact immutable resources retain no execution activity and never recover a Runtime. */
  runtimeAssets?: Pick<import('./runtime-assets.ts').RuntimeAssets, 'handle'>
    & Partial<Pick<import('./runtime-assets.ts').RuntimeAssets, 'diagnostics'>>
  /** Account catalog including personal runtime metadata and ACL-filtered projects. */
  workbenchCatalog?: GatewayWorkbenchCatalogHandler
  /** Gateway-owned alternate-scope document listing; never expose runtime URLs. */
  documentTransferList?: GatewayDocumentTransferListHandler
  /** Gateway-owned target-scope resumable upload proxy. */
  documentTransferUpload?: GatewayDocumentTransferUploadHandler
  /** Gateway-owned full document operations for an explicitly selected scope. */
  documentScope?: GatewayDocumentScopeHandler
  /** Gateway-owned administrator lifecycle operations for catalog rows. */
  documentAdmin?: GatewayDocumentAdminHandler
  admin?: (req: IncomingMessage, res: ServerResponse, user: UserRow, pathname: string, body: string) => Promise<boolean>
  /**
   * Authenticate a loopback runtime request before its body is read. The
   * production composition supplies the runtime-token verifier; keeping this
   * callback at the HTTP boundary prevents unauthenticated callers from
   * forcing a 64 MiB allocation before the runtime handler can reject them.
   */
  runtimeAuthorize?: (req: IncomingMessage) => Awaitable<boolean | 'shutdown-storage' | RuntimeCredentialSubject>
  /** Previously verified coordinates for an exact personal write with its own SQL authority check. */
  runtimePersonalExecutionCandidate?: (req: IncomingMessage) => RuntimeCredentialSubject | null
  /** Previously verified personal or project coordinates for the model credential endpoint alone. */
  runtimeModelCredentialCandidate?: (req: IncomingMessage) => RuntimeCredentialSubject | null
  /** Process-local shutdown gate for a write that checks the shared epoch in its own transaction. */
  runtimePersonalExecutionStopGate?: () => WriteGateVerdict
  /** Deployment maintenance and write-epoch checks for one authenticated planned-stop checkpoint. */
  runtimeShutdownStorageWriteGate?: () => Promise<WriteGateVerdict>
  /** Check the write epoch before accepting an authenticated resource completion in maintenance. */
  runtimeResourceCompletionWriteGate?: () => Promise<WriteGateVerdict>
  runtime?: GatewayRuntimeHandler
  /** Override `serveAdmin` root (tests); default `gateway/public/admin`. */
  adminRoot?: string
}

export function createGatewayServer(deps: GatewayDeps, handlers: GatewayHandlers = {}): Server {
  const { cfg, auth, users, audit } = deps
  const trustedProxies = trustedProxyList(cfg.trustedProxies)
  const clientIp = (req: IncomingMessage): string =>
    forwardedClientAddress(req.socket.remoteAddress ?? '', req.headers['x-forwarded-for'], trustedProxies)
  const runtimeRouter = deps.runtimeRouter ?? new GatewayRuntimeRouter(new LocalRuntimeAdapter(deps))
  const runtimeStartForms = new WeakMap<IncomingMessage, RuntimeStartRetry | null>()
  const runtimeStartObservations = new RuntimeStartObservations(cfg.readinessTimeoutMs + cfg.runtimeCapacity.maxQueueWaitMs)
  const recoveryAdmission = async () => {
    try { return await deps.governanceRecovery?.admission() }
    catch (error) { throw new GovernanceAdmissionUnavailableError(error) }
  }

  const sendStartFailure = (req: IncomingMessage, res: ServerResponse, problem: { status: number; reason: RuntimeStartFailureReason; retryable: boolean }, retry: RuntimeStartRetry | null): void => {
    res.setHeader('cache-control', 'no-store')
    if (problem.retryable) res.setHeader('retry-after', String(Math.max(1, Math.ceil(cfg.runtimeCapacity.maxQueueWaitMs / 1000))))
    send(res, problem.status, runtimeStartFailurePage(problem.reason, problem.retryable ? retry : null, gateLanguage(req.headers.cookie)))
  }

  const HEALTH_READINESS_TIMEOUT_MS = 5_000
  const HEALTH_READINESS_CACHE_MS = 1_000
  const HEALTH_READINESS_FAILURE_BACKOFF_MS = 1_000
  let readinessInFlight: Promise<void> | undefined
  let readinessCachedUntil = 0
  let readinessFailureUntil = 0
  let readinessFailure: Error | undefined

  /** Share a short readiness probe across concurrent health checks. */
  const checkReadiness = async (): Promise<void> => {
    if (deps.readiness === undefined) return
    const now = Date.now()
    if (readinessCachedUntil > now) return
    if (readinessFailure !== undefined && readinessFailureUntil > now) throw readinessFailure
    if (readinessInFlight !== undefined) return readinessInFlight
    const controller = new AbortController()
    const readinessTimeoutMs = Math.min(cfg.readinessTimeoutMs, HEALTH_READINESS_TIMEOUT_MS)
    const operation = Promise.resolve().then(() => deps.readiness?.(controller.signal))
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Gateway readiness probe timed out'))
        const error = new Error('Gateway readiness probe timed out')
        error.name = 'TimeoutError'
        reject(error)
      }, readinessTimeoutMs)
      timer.unref?.()
    })
    const probe = Promise.race([operation, timeout]).then(() => {
      readinessFailure = undefined
      readinessFailureUntil = 0
      readinessCachedUntil = Date.now() + HEALTH_READINESS_CACHE_MS
    }).catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error))
      readinessFailure = failure
      readinessFailureUntil = Date.now() + HEALTH_READINESS_FAILURE_BACKOFF_MS
      throw failure
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
      if (readinessInFlight === probe) readinessInFlight = undefined
    })
    readinessInFlight = probe
    return probe
  }

  const auditForwardedAccount = (req: IncomingMessage, path: string, claims: GatewayForwardClaims): void => {
    if (path.startsWith('/api/') || isImmutableRuntimeAssetRequest(req.method, req.url ?? '/')) return
    void Promise.resolve(audit.write({ userId: claims.user.id, action: 'auth.forwarded',
      methodPath: `${req.method ?? ''} ${path}`, ip: clientIp(req),
      detail: JSON.stringify({ issuerNode: claims.issuerNode, nonce: claims.nonce }) }))
      .catch((error: unknown) => { console.error('[gateway] audit write failed:', error) })
  }

  const currentUser = async (req: IncomingMessage): Promise<{ token: string; user: UserRow;
      forward?: import('./forwarded-principal.ts').GatewayForwardClaims } | null> => {
    // A peer-signed assertion proves the forwarding Gateway already validated
    // this session. The target header is only a routing marker — clients can
    // set it — so assertion acceptance rests on signature verification and the
    // nonce ledger in deps.forwardedPrincipal, not on the header itself.
    const forward = req.headers['x-dsh-gateway-forward']
    const arrivedForThisNode = req.headers[NODE_SERVICE_TARGET_HEADER] !== undefined
      && req.headers[NODE_SERVICE_TARGET_HEADER] === deps.nodeServiceIdentity?.nodeId
    const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (typeof forward === 'string' && arrivedForThisNode && deps.forwardedPrincipal !== undefined) {
      const claims = await deps.forwardedPrincipal(forward)
      // The assertion is bound to one request line and the forwarded session:
      // without a cookie, or with a rewritten method/path, the claims are not
      // a stand-in for session validation and the ordinary path runs instead.
      const path = new URL(req.url ?? '/', 'http://gateway').pathname
      if (claims !== null && forwardRequestMatches(claims, { method: req.method, path, sessionToken: token })) {
        auditForwardedAccount(req, path, claims)
        return { token: token ?? '', user: claims.user, forward: claims }
      }
    }
    if (token === undefined) return null
    const requestPath = new URL(req.url ?? '/', 'http://gateway').pathname
    if (req.method === 'GET' && requestPath === '/account/api/node-document-overview') {
      const qualified = await timeOperation('authorize', async () => auth.qualifyForStream(token))
      return qualified === null ? null : { token, user: qualified.user }
    }
    const user = await timeOperation('authorize',async()=>auth.validate(token))
    return user === null ? null : { token, user }
  }

  const signedPersonalForward = (req: IncomingMessage, pathname: string, selection: {
    runtimeId: RuntimeId; nodeId: RuntimeNodeId; target: 'personal'
  }, observe?: ReadySessionObservation): {
    sessionToken: string; forwarded: GatewayForwardSessionCandidate
  } | undefined => {
    const assertion = req.headers['x-dsh-gateway-forward']
    if (req.headers[NODE_SERVICE_TARGET_HEADER] !== selection.nodeId || typeof assertion !== 'string') return undefined
    const forwarded = deps.forwardedSessionPrincipal?.(assertion)
    const sessionToken = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
    if (forwarded == null || sessionToken === undefined || !browserPrincipalMatches(req, forwarded.claims.user)
      || !forwardRequestMatches(forwarded.claims, { method: req.method, path: pathname, sessionToken })
      || !forwardedSessionMatches(forwarded.claims, selection)) {
      observe?.('forwarded', 'fallbackCandidate')
      return undefined
    }
    return { sessionToken, forwarded }
  }

  /** Parse the selector target exactly as the destination router would; no query. */
  const parsedTarget = (raw: string | null | undefined): 'personal' | `project:${number}` =>
    raw !== undefined && raw !== null && /^project:[1-9][0-9]*$/u.test(raw) ? raw as `project:${number}` : 'personal'

  const requestContext = async (req: IncomingMessage, user: UserRow, checked?:RuntimePlacement,
    forward?: import('./forwarded-principal.ts').GatewayForwardClaims) => {
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const runtimeId = query.get('dshRuntime'), target = query.get('dshTarget')
    const scopeCookie = parseCookies(req.headers.cookie).get(SCOPE_COOKIE)
    // A bound assertion supplies the placement the issuer already authorized;
    // it is adopted only when this request's parsed selectors equal the signed
    // selectors exactly and the claimed environment lands on this node. The
    // destination still resolves scope and node-local runtime storage itself.
    const claimed = forward?.context, effectiveTarget = target ?? parsedTarget(scopeCookie)
    const forwardedAccessRevision = forward?.accessRevision === undefined ? undefined : BigInt(forward.accessRevision)
    const attach = (resolved: Awaited<ReturnType<typeof runtimeRouter.resolve>>) => forwardedAccessRevision === undefined
      ? resolved : { ...resolved, context: { ...resolved.context, forwardedAccessRevision } }
    if (claimed !== undefined && forward?.selection !== undefined
      && (forward.selection.runtimeId ?? null) === runtimeId
      && (forward.selection.target ?? null) === effectiveTarget
      && claimed.environment.nodeId === deps.nodeServiceIdentity?.nodeId) {
      const claimedTarget = forward.selection.target as 'personal' | `project:${number}`
      return attach(await runtimeRouter.resolve(user, { runtimeId, target: claimedTarget, scopeCookie },
        { target: claimedTarget, local: true, resetScope: false,
          environment: { id: claimed.environment.id,
            node: { id: claimed.environment.nodeId, name: claimed.environment.nodeName } } as RuntimePlacement['environment'] }))
    }
    return attach(await runtimeRouter.resolve(user, { runtimeId, target, scopeCookie }, checked))
  }

  const conversationRuntime = (context: GatewayRequestContext): import('./runtime-catalog.ts').RuntimeId => {
    const runtimeId = context.environment?.id ?? context.runtime.runtimeId
    if (runtimeId === undefined) throw new RuntimeCatalogError(503, 'runtime-catalog/unavailable')
    return runtimeId
  }

  const writerReleases = new WeakMap<ServerResponse, () => void>()
  const performanceObserver = deps.performance ?? new GatewayPerformanceObserver({
    enabled: cfg.performanceEnabled,
    eventLoopResolutionMs: cfg.performanceEventLoopResolutionMs,
  })
  const observeReadySession = cfg.performanceEnabled ? {
    observe(route: ReadySessionRoute, outcome: ReadySessionOutcome) {
      performanceObserver.recordReadySession(route, outcome)
      recordReadySession(route, outcome)
    },
  } : undefined
  const unclaimedLoopback = new Map<string, { socket: Socket; forget: () => void }>()
  const nodeReadBridges = new WeakMap<Socket, RuntimeNodeId>()
  const bridgeCoordinate = (socket: Socket, port: number | undefined = socket.remotePort): string | undefined => {
    const address = socket.remoteAddress
    if (port === undefined || address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return undefined
    return `${socket.localAddress}:${String(socket.localPort)}:${address}:${String(port)}`
  }
  const forgetUnclaimedBridge = (socket: Socket): void => {
    const key = bridgeCoordinate(socket)
    const candidate = key === undefined ? undefined : unclaimedLoopback.get(key)
    if (candidate?.socket === socket) candidate.forget()
  }
  const operationTimings=new OperationTimings(cfg.performanceEnabled?cfg.performanceOperationSamples:0)
  const server = createServer((req, res) => {
    forgetUnclaimedBridge(req.socket)
    // Baseline response headers for every route. `writeHead` on relayed
    // responses can still override them when the upstream supplied its own.
    // CSP ships as Report-Only: the SPA, admin pages with inline scripts,
    // iframe previews, and noVNC need observed data before an enforcing policy.
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('x-frame-options', 'SAMEORIGIN')
    res.setHeader('referrer-policy', 'strict-origin-when-cross-origin')
    res.setHeader('content-security-policy-report-only',
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'")
    performanceObserver.observeResponse(res, (req.url ?? '').startsWith('/internal/runtime/') ? 'internal' : 'http')
    void operationTimings.run(req,res,()=>handle(req,res)).catch((error: unknown) => {
      if (!res.writableEnded && res.headersSent) {
        res.destroy()
      } else if (!res.writableEnded && !res.destroyed) {
        if (error instanceof GovernanceAdmissionUnavailableError) {
          req.resume(); res.setHeader('cache-control', 'no-store')
          send(res, 503, '{"error":"peer-backup/governance-admission-unavailable"}', 'application/json')
        } else if (runtimeStartForms.has(req)) {
          sendStartFailure(req, res, runtimeStartProblem(error) ?? { status: 500, reason: 'unknown', retryable: false }, runtimeStartForms.get(req) ?? null)
        } else if (error instanceof BodyTooLargeError) {
          send(res, 413, JSON.stringify({ error: 'request-too-large' }), 'application/json')
        } else if (error instanceof WebhookEndpointError) {
          send(res, error.status, JSON.stringify({ error: error.status === 404 ? 'not-found' : error.message }), 'application/json')
        } else if (error instanceof PostgresCheckoutQueueFullError) {
          res.setHeader('cache-control', 'no-store')
          res.setHeader('retry-after', String(Math.max(1, Math.ceil(cfg.databaseConnectionTimeoutMs / 1000))))
          send(res, 503, JSON.stringify({ error: {
            code: error.code,
            message: 'The server is at its database capacity. Try again later.',
          } }), 'application/json')
        } else if (error instanceof AccessNodeDrainingError || error instanceof RuntimeCatalogError || error instanceof NodeAccessError || error instanceof NodeServiceError || error instanceof NodeChannelError || error instanceof ComputerAccessError || error instanceof DeploymentTopologyError) {
          res.setHeader('cache-control', 'no-store')
          send(res, error.status, JSON.stringify({ error: error.code }), 'application/json')
        } else if (error instanceof RuntimeAccountError) {
          res.setHeader('cache-control', 'no-store')
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else if (error instanceof RuntimeCapacityError) {
          res.setHeader('cache-control', 'no-store')
          res.setHeader('retry-after', String(Math.max(1, Math.ceil(cfg.runtimeCapacity.maxQueueWaitMs / 1000))))
          send(res, 503, JSON.stringify({ error: {
            code: error.code,
            message: 'The server is at its runtime capacity. Try again after another runtime is released.',
          } }), 'application/json')
        } else if (error instanceof RuntimeStartBlockedError) {
          send(res, error.code === 'INSTANCE_STOPPED' ? 409 : 503, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else if (error instanceof InvalidRuntimeTargetError) {
          send(res, 400, JSON.stringify({ error: error.message }), 'application/json')
        } else if (error instanceof DocumentTransferError) {
          send(res,error.status,JSON.stringify({error:error.code}), 'application/json')
        } else if (error instanceof NodeContentUnavailable) {
          send(res, error.status, JSON.stringify({ error: error.code }), 'application/json')
        } else if (error instanceof CollaborationDeniedError) {
          send(res, error.code === 'conversation-not-found' ? 404 : 403,
            JSON.stringify({ error: error.code }), 'application/json')
        } else if ((req.url ?? '').startsWith('/internal/runtime/') || (req.url ?? '').startsWith('/internal/nodes/')) {
          // Runtime consumers require JSON even when an unexpected exception
          // escapes a route. Keep stack details in the server log only; paths,
          // SQL errors, and provider diagnostics are not browser copy.
          send(res, 500, JSON.stringify({
            error: 'runtime-internal',
            code: 'internal',
            message: 'The runtime could not complete this request.',
          }), 'application/json')
        } else {
          send(res, 500, 'internal error', 'text/plain')
        }
      }
      if (!(error instanceof AccessNodeDrainingError) && !(error instanceof BodyTooLargeError) && !(error instanceof RuntimeCapacityError) && !(error instanceof RuntimeCatalogError) && !(error instanceof NodeAccessError)
        && !(error instanceof NodeServiceError) && !(error instanceof NodeChannelError) && !(error instanceof ComputerAccessError) && !(error instanceof DeploymentTopologyError) && !(error instanceof WebhookEndpointError) && !(error instanceof PostgresCheckoutQueueFullError)) console.error('[gateway] request failed:', error)
    }).finally(() => { writerReleases.get(res)?.(); writerReleases.delete(res) })
  })
  if (cfg.nodeService.preparedReadDelegation === true) server.on('connection', (socket) => {
    const key = bridgeCoordinate(socket)
    if (key === undefined) return
    const forget = (): void => {
      if (unclaimedLoopback.get(key) === candidate) unclaimedLoopback.delete(key)
      socket.removeListener('close', forget)
    }
    const candidate = { socket, forget }
    unclaimedLoopback.set(key, candidate)
    socket.once('close', forget)
  })
  // Idle keep-alive connections must outlive the front proxy's origin pool
  // (cloudflared 90s default): a shorter timeout lets the proxy reuse a socket
  // the server is already closing, which surfaces as EOF/502. Node requires
  // headersTimeout to exceed keepAliveTimeout.
  server.keepAliveTimeout = cfg.keepAliveTimeoutMs
  server.headersTimeout = cfg.keepAliveTimeoutMs + 5_000
  const nodeIdentityCache = new Map<string, { lease: import('./node-access.ts').NodeServiceIdentityLease; expiresAtMs: number }>()
  const nodeIdentityInFlight = new Map<string, { epoch: number; promise: Promise<import('./node-access.ts').NodeServiceIdentityLease> }>()
  let nodeIdentityCacheEpoch = 0
  const monitorCaughtUp = (): boolean => deps.accessMonitor !== undefined
    && (deps.accessMonitor.currentRevision !== undefined ? deps.accessMonitor.currentRevision() !== undefined : deps.accessMonitor.available)
  const clearNodeIdentityCache = (): void => {
    nodeIdentityCacheEpoch += 1
    nodeIdentityCache.clear()
  }
  const unsubscribeNodeIdentityCache = deps.accessMonitor?.subscribe(subject => {
    if (subject.userId === undefined && subject.projectId === undefined
      && (subject.nodeId === undefined || subject.nodeId === deps.nodeServiceIdentity?.nodeId)) {
      clearNodeIdentityCache()
    }
  })
  server.once('close', () => {
    unsubscribeNodeIdentityCache?.()
    clearNodeIdentityCache()
    if (deps.performance === undefined) performanceObserver.dispose()
  })

  /**
   * Maintenance-mode write gate: mutating requests consult the shared
   * PostgreSQL verdict once authenticated. Reads, session lifecycle, health
   * probes, and the deployment control surface itself stay open so operators
   * can observe and close the window.
   */
  const writeVerdict = async (
    req: IncomingMessage, res: ServerResponse, pathname: string, explicitWrite = false, trackWriter = true,
    gate: (() => Awaitable<WriteGateVerdict>) | undefined = deps.maintenanceGate,
  ): Promise<WriteGateVerdict> => {
    if (gate === undefined) return 'open'
    if (!explicitWrite && (req.method === 'GET' || req.method === 'HEAD')) return 'open'
    if (!explicitWrite && (pathname === '/login' || pathname === '/logout' || pathname === '/account/password'
      || pathname.startsWith('/admin/api/deployment') || pathname.startsWith('/admin/api/backups'))) return 'open'
    if (trackWriter && pathname !== '/api' && !pathname.startsWith('/api/') && !writerReleases.has(res)) {
      const release = deps.writerSpan?.()
      if (release !== undefined) writerReleases.set(res, release)
    }
    const verdict = await gate()
    if (verdict === 'open') return 'open'
    if (verdict === 'maintenance' && req.method === 'POST'
      && (/^\/admin\/api\/(users|projects)\/\d+\/instance\/stop$/u.test(pathname)
        || /^\/admin\/api\/runtimes\/[^/]+\/stop$/u.test(pathname))) return 'open'
    return verdict
  }
  const writesOpen = async (req: IncomingMessage, res: ServerResponse, pathname: string, explicitWrite = false,
    gate: (() => Awaitable<WriteGateVerdict>) | undefined = deps.maintenanceGate): Promise<boolean> => {
    const verdict = await writeVerdict(req, res, pathname, explicitWrite, true, gate)
    if (verdict === 'open') return true
    if (runtimeStartForms.has(req)) sendStartFailure(req, res, { status: 503, reason: 'changed', retryable: false }, null)
    else send(res, 503, JSON.stringify({ error: verdict }), 'application/json')
    return false
  }

  let nodeControlsInFlight = 0
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url ?? '/', 'http://x')
    const pathname = requestUrl.pathname
    if (req.method === 'POST' && pathname === '/account/runtime/start' || pathname === '/account/runtime/wait') runtimeStartForms.set(req, null)
    if (deps.nodeServiceIdentity !== undefined) res.setHeader(NODE_SERVICE_TARGET_HEADER, deps.nodeServiceIdentity.nodeId)
    const requestedNode = req.headers[NODE_SERVICE_TARGET_HEADER]
    if (requestedNode !== undefined && requestedNode !== deps.nodeServiceIdentity?.nodeId) {
      req.resume(); throw new NodeServiceError(409, 'node-service/mismatch')
    }

    if (pathname === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(204); res.end(); return
    }
    if (pathname === '/healthz/live') {
      send(res, 200, JSON.stringify({ ok: true, release: cfg.releaseId, configurationRevision: cfg.configurationRevision }), 'application/json')
      return
    }

    if (pathname === '/healthz' || pathname === '/healthz/ready') {
      try {
        await checkReadiness()
        send(res, 200, JSON.stringify({ ok: true, release: cfg.releaseId, configurationRevision: cfg.configurationRevision }), 'application/json')
      } catch {
        send(res, 503, JSON.stringify({ ok: false, release: cfg.releaseId }), 'application/json')
      }
      return
    }

    const recovery = await recoveryAdmission()
    const recoveryRestricted = recovery?.state === 'review'
    const recoveryApi = pathname === '/admin/api/governance-recovery' || pathname.startsWith('/admin/api/governance-recovery/')
    const localRecoveryPage = pathname === '/admin/governance-recovery/local'
    const recoveryPage = pathname === '/admin/governance-recovery' || localRecoveryPage
    if (recoveryRestricted) {
      const read = req.method === 'GET' || req.method === 'HEAD'
      const allowed = recoveryApi
        || (read && (pathname === '/' || pathname === '/admin' || pathname === '/admin/governance-recovery' || pathname.startsWith('/admin/assets/')))
        || ((req.method === 'GET' || req.method === 'POST') && (pathname === '/login' || pathname === '/account/password'))
        || (req.method === 'POST' && pathname === '/logout')
      if (!allowed) {
        req.resume(); res.setHeader('cache-control', 'no-store')
        send(res, 503, '{"error":"governance-recovery-required","recoveryPath":"/admin/governance-recovery"}', 'application/json')
        return
      }
    }
    if ((recoveryRestricted || recoveryApi || recoveryPage) && ['dshNode', 'dshRuntime', 'dshTarget'].some(key => requestUrl.searchParams.has(key))) {
      req.resume(); send(res, 409, '{"error":"governance-recovery-local-entry-required"}', 'application/json'); return
    }

    if (pathname === NODE_SERVICE_IDENTITY_PATH) {
      req.resume(); res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return }
      if (deps.nodeServiceIdentity === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
      if (nodeControlsInFlight >= cfg.nodeAccess.maxInFlight) throw new NodeAccessError(503, 'node-access/busy')
      const bearer = req.headers.authorization
      if (typeof bearer !== 'string' || !bearer.startsWith('Bearer ')) throw new NodeAccessError(401, 'node-access/unauthorized')
      const port = req.headers[NODE_SERVICE_LOCAL_PORT_HEADER]
      const coordinate = cfg.nodeService.preparedReadDelegation === true && typeof port === 'string'
        && /^[1-9][0-9]{0,4}$/u.test(port) && Number(port) <= 65535 ? bridgeCoordinate(req.socket, Number(port)) : undefined
      const bridge = coordinate === undefined ? undefined : unclaimedLoopback.get(coordinate)
      nodeControlsInFlight += 1
      try {
        const token = bearer.slice(7)
        const connectionHeader = req.headers['x-dsh-node-connection']
        const epochHeader = req.headers['x-dsh-node-epoch']
        const canCache = monitorCaughtUp() && cfg.nodeServiceIdentityCacheMs > 0
          && typeof connectionHeader === 'string' && typeof epochHeader === 'string'
        const cacheKey = canCache
          ? `${createHash('sha256').update(token).digest('hex')}:${connectionHeader}:${epochHeader}`
          : undefined
        const now = Date.now()
        let lease: import('./node-access.ts').NodeServiceIdentityLease
        const cached = cacheKey === undefined ? undefined : nodeIdentityCache.get(cacheKey)
        if (cached !== undefined && cached.expiresAtMs > now && monitorCaughtUp()) {
          lease = cached.lease
        } else {
          if (cacheKey !== undefined) nodeIdentityCache.delete(cacheKey)
          const existing = cacheKey === undefined ? undefined : nodeIdentityInFlight.get(cacheKey)
          if (existing !== undefined && existing.epoch === nodeIdentityCacheEpoch) {
            lease = await existing.promise
          } else {
            const flightEpoch = nodeIdentityCacheEpoch
            const promise = deps.nodeServiceIdentity.authorize(token, {
              connectionId: connectionHeader, epoch: epochHeader,
            })
            if (cacheKey !== undefined) nodeIdentityInFlight.set(cacheKey, { epoch: flightEpoch, promise })
            try {
              lease = await promise
            } finally {
              if (cacheKey !== undefined && nodeIdentityInFlight.get(cacheKey)?.promise === promise) {
                nodeIdentityInFlight.delete(cacheKey)
              }
            }
            if (cacheKey !== undefined && flightEpoch === nodeIdentityCacheEpoch && monitorCaughtUp()) {
              const leaseExpiresMs = Date.parse(lease.expiresAt)
              const expiresAtMs = Math.min(
                Date.now() + cfg.nodeServiceIdentityCacheMs,
                Number.isFinite(leaseExpiresMs) ? leaseExpiresMs : Date.now() + cfg.nodeServiceIdentityCacheMs,
              )
              if (expiresAtMs > Date.now()) {
                if (nodeIdentityCache.size >= 64) {
                  const oldest = nodeIdentityCache.keys().next().value
                  if (oldest !== undefined) nodeIdentityCache.delete(oldest)
                }
                nodeIdentityCache.set(cacheKey, { lease, expiresAtMs })
              }
            }
          }
        }
        if (lease.nodeId !== deps.nodeServiceIdentity.nodeId || lease.organizationId !== deps.nodeServiceIdentity.organizationId) {
          throw new NodeServiceError(409, 'node-service/mismatch')
        }
        await checkReadiness()
        const primary = lease.managedPrimary
        if (coordinate !== undefined && bridge !== undefined && primary !== undefined
          && deps.accessMonitor?.currentRevision?.() === primary.accessRevision
          && !bridge.socket.destroyed && unclaimedLoopback.get(coordinate) === bridge) {
          bridge.forget()
          nodeReadBridges.set(bridge.socket, primary.nodeId)
        }
        send(res, 200, JSON.stringify({ protocolVersion: NODE_SERVICE_PROTOCOL_VERSION, organizationId: lease.organizationId,
          nodeId: lease.nodeId, release: cfg.releaseId ?? null }), 'application/json')
      } finally { nodeControlsInFlight -= 1 }
      return
    }

    if (pathname.startsWith('/internal/peer-backups/')) {
      if (handlers.peerBackups !== undefined && await handlers.peerBackups.internal(req, res)) return
      req.resume()
      send(res, 404, '{"error":"peer-backup/not-found"}', 'application/json')
      return
    }

    if (pathname.startsWith('/internal/nodes/')) {
      res.setHeader('cache-control', 'no-store')
      if (!['/internal/nodes/enroll', '/internal/nodes/connect', '/internal/nodes/heartbeat', '/internal/nodes/disconnect'].includes(pathname)) {
        req.resume(); send(res, 404, '{"error":"not-found"}', 'application/json'); return
      }
      if (req.method !== 'POST') {
        req.resume(); res.setHeader('allow', 'POST'); send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return
      }
      if (deps.nodeAccess === undefined) { req.resume(); throw new NodeAccessError(503, 'node-access/unavailable') }
      const authorization = req.headers.authorization
      if (authorization === undefined || !/^Bearer [A-Za-z0-9_-]+$/u.test(authorization)) {
        req.resume(); throw new NodeAccessError(401, 'node-access/unauthorized')
      }
      const token = authorization.slice('Bearer '.length)
      const input = jsonObject(await readBody(req, 4096))
      if (input === null) throw new NodeAccessError(400, 'node-access/invalid-request')
      if (nodeControlsInFlight >= cfg.nodeAccess.maxInFlight) {
        res.setHeader('retry-after', String(Math.max(1, Math.ceil(cfg.nodeAccess.heartbeatMs / 1000))))
        throw new NodeAccessError(503, 'node-access/busy')
      }
      nodeControlsInFlight += 1
      try {
        if (pathname === '/internal/nodes/enroll') {
          if (!await writesOpen(req, res, pathname)) return
          send(res, 200, JSON.stringify(await deps.nodeAccess.enroll(token, input)), 'application/json')
          return
        }
        // Ordinary-maintenance leases do not acknowledge or contribute business writers.
        const verdict = await writeVerdict(req, res, pathname, false, false, deps.leaseControlGate)
        const operation = pathname === '/internal/nodes/connect' ? 'connect'
          : pathname === '/internal/nodes/heartbeat' ? 'heartbeat' : 'disconnect'
        if (verdict !== 'open' && (verdict !== 'maintenance' || deps.maintainNodeConnection === undefined)) {
          send(res, 503, JSON.stringify({ error: verdict }), 'application/json'); return
        }
        if (verdict === 'open' && operation === 'connect') {
          // Serving connect can promote pending attachment. Its transaction also excludes maintenance entry.
          const release = deps.writerSpan?.()
          if (release !== undefined) writerReleases.set(res, release)
        }
        const result = verdict === 'maintenance'
          ? await deps.maintainNodeConnection!(operation, token, input)
          : await deps.nodeAccess[operation](token, input)
        send(res, operation === 'disconnect' ? 204 : 200, result === undefined ? '' : JSON.stringify(result), 'application/json')
      } finally { nodeControlsInFlight -= 1 }
      return
    }

    if (pathname.startsWith('/internal/runtime/')) {
      let authorized: boolean | 'shutdown-storage' | RuntimeCredentialSubject = false
      const stopGate = handlers.runtimePersonalExecutionStopGate
      const activeModelCheck = req.headers[RESOURCE_ACTIVE_MODEL_CHECK_HEADER] === '1'
      const findCandidate = pathname === RUNTIME_MODEL_CREDENTIAL_PATH
        ? handlers.runtimeModelCredentialCandidate ?? handlers.runtimePersonalExecutionCandidate
        : handlers.runtimePersonalExecutionCandidate
      const candidate = stopGate !== undefined && isPersonalExecutionWriteRequest(pathname, req.method, activeModelCheck)
        ? findCandidate?.(req) : undefined
      const fromCandidate = candidate != null && handlers.runtime?.defersPersonalExecutionWrite?.(candidate, pathname, req.method, activeModelCheck) === true
      const measureIngress = cfg.performanceEnabled && handlers.runtimeAuthorize !== undefined && isResourceAdmissionRequest(pathname, req.method)
      const authorizationStarted = measureIngress ? performance.now() : 0
      if (fromCandidate) authorized = candidate
      else if (handlers.runtimeAuthorize !== undefined) {
        const authenticate = handlers.runtimeAuthorize
        try {
          authorized = await (measureIngress ? timeResourceBearer(() => authenticate(req)) : authenticate(req))
        } catch {
          req.resume()
          send(res, 503, '{"error":"runtime-authorization-unavailable"}', 'application/json')
          return
        }
        if (!authorized) {
          // Drain the request so keep-alive clients cannot strand the socket,
          // but never buffer the attacker-controlled body first.
          req.resume()
          send(res, 401, '{"error":"invalid-runtime-token"}', 'application/json')
          return
        }
      } else if (req.headers.authorization === undefined) {
        // Test/legacy compositions may omit a verifier callback. They still
        // receive the cheap header gate; production wires the callback above
        // for cryptographic validation before body admission.
        req.resume()
        send(res, 401, '{"error":"invalid-runtime-token"}', 'application/json')
        return
      }
      const authorizationMs = measureIngress ? performance.now() - authorizationStarted : 0
      if (handlers.runtime?.stream !== undefined
        && await handlers.runtime.stream(req, res, pathname, () => writeVerdict(req, res, pathname, true))) return
      const streamControl = isRuntimeStreamControlRequest(pathname, req.method)
      const resourceCompletion = isRuntimeResourceCompletionRequest(pathname, req.method)
      const rechecksControlSubject = (streamControl && req.method === 'POST') || resourceCompletion
      const controlSubject = typeof authorized === 'object' && rechecksControlSubject ? authorized : undefined
      const gate = authorized === 'shutdown-storage' ? handlers.runtimeShutdownStorageWriteGate
        : resourceCompletion && controlSubject !== undefined ? handlers.runtimeResourceCompletionWriteGate
        : streamControl ? deps.leaseControlGate : undefined
      const admitWrite = async (selectedGate: (() => Awaitable<WriteGateVerdict>) | undefined): Promise<boolean> => {
        if (!measureIngress) return writesOpen(req, res, pathname, false, selectedGate)
        const started = performance.now()
        const open = await timeOperation('resourceWriteAdmission', () => writesOpen(req, res, pathname, false, selectedGate))
        if (open) {
          const writeMs = performance.now() - started
          res.setHeader(RESOURCE_INGRESS_TIMING_HEADER, JSON.stringify([authorizationMs, writeMs].map(ms => Math.round(ms * 100) / 100)))
        }
        return open
      }
      const executionWrite: PersonalExecutionWriteAdmission | undefined = typeof authorized === 'object' && stopGate !== undefined
        && handlers.runtime?.defersPersonalExecutionWrite?.(authorized, pathname, req.method, activeModelCheck) === true
        ? { subject: authorized, fromCandidate, admit: sqlFenced => admitWrite(sqlFenced ? stopGate : gate) }
        : undefined
      if (executionWrite === undefined && !await admitWrite(gate)) { req.resume(); return }
      let body = ''
      try {
        body = req.method === 'GET' || req.method === 'HEAD'
          ? ''
          : await readBody(req, cfg.runtimeApiBodyLimitBytes)
      } catch (error: unknown) {
        if (!(error instanceof BodyTooLargeError)) throw error
        send(res, 413, '{"error":"runtime-request-too-large"}', 'application/json')
        return
      }
      if (handlers.runtime !== undefined && await handlers.runtime(req, res, pathname, body, executionWrite, controlSubject)) return
      send(res, 404, '{"error":"not-found"}', 'application/json')
      return
    }

    // Provider ingress authenticates by signature, not cookie or Origin.
    if (pathname.startsWith('/webhook/')) {
      if (deps.webhookIntake === undefined || !/^\/webhook\/[1-9][0-9]*$/u.test(pathname)) {
        req.resume()
        send(res, 404, '{"error":"not-found"}', 'application/json')
        return
      }
      if (!await writesOpen(req, res, pathname)) { req.resume(); return }
      if (req.method === 'POST' && deps.nodeServiceIdentity !== undefined && deps.webhookEndpoints?.placement !== undefined) {
        const node = await deps.webhookEndpoints.placement(Number(pathname.slice('/webhook/'.length)))
        if (node !== deps.nodeServiceIdentity?.nodeId) {
          if (deps.nodeServiceProxy?.webhook === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
          if (await deps.nodeServiceProxy.webhook(req, res, node)) return
        }
      }
      await deps.webhookIntake.handle(req, res)
      return
    }

    if (!csrfOk(req, cfg, pathname)) { sendAdminGate(res, pathname, 'origin not allowed'); return }

    if (pathname === '/login') {
      const returnQuery = new URL(req.url ?? '/login', 'http://gateway.invalid').searchParams
      const gateT = gateCopy(gateLanguage(req.headers.cookie))
      if (req.method === 'GET') { send(res, 200, loginPage('', gateLanguage(req.headers.cookie), recoveryRestricted ? '/admin/governance-recovery' : browserReturnPath(returnQuery.get('returnTo')))); return }
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const username = form.get('username') ?? ''
        const returnTo = recoveryRestricted ? '/admin/governance-recovery' : browserReturnPath(form.get('returnTo') ?? returnQuery.get('returnTo'))
        const result = await auth.login(username, form.get('password') ?? '', clientIp(req), req.headers['user-agent'] ?? '')
        if (result === 'locked') { await audit.write({ action: 'login.locked', ip: clientIp(req), detail: JSON.stringify({ username }) }); send(res, 429, loginPage(gateT('loginLocked'), gateLanguage(req.headers.cookie), returnTo)); return }
        if (result === 'invalid') { await audit.write({ action: 'login.failed', ip: clientIp(req), detail: JSON.stringify({ username }) }); send(res, 401, loginPage(gateT('loginInvalid'), gateLanguage(req.headers.cookie), returnTo)); return }
        if (recoveryRestricted && (result.user.id !== recovery.bootstrapUserId || result.user.role !== 'admin')) {
          await auth.revoke(result.token)
          await audit.write({ userId: result.user.id, action: 'login.failed', ip: clientIp(req),
            detail: JSON.stringify({ reason: 'governance-recovery-bootstrap-required' }) })
          send(res, 401, loginPage(gateT('loginInvalid'), gateLanguage(req.headers.cookie), returnTo))
          return
        }
        await audit.write({ userId: result.user.id, action: 'login', ip: clientIp(req) })
        redirect(res, returnTo, [sessionCookie(result.token, cfg)])
        return
      }
    }

    const explicitSession = isExplicitSessionRequest(req.method, pathname)
    const expectedPrincipal = req.headers['x-dsh-expected-principal-id']
    const runtimeRead = typeof expectedPrincipal === 'string' && isReadyRuntimeRead(req.method, requestUrl)
    const readyInteractive = typeof expectedPrincipal === 'string' && isReadyRuntimeInteractive(req.method, pathname)
    const sessionSelectors = explicitSession || runtimeRead || readyInteractive ? exactSessionSelectors(requestUrl.searchParams) : undefined
    const localNode = deps.nodeServiceIdentity?.nodeId
    const sessionNode = requestUrl.searchParams.get('dshNode')
    const readySession = sessionSelectors === undefined || localNode === undefined || recoveryRestricted
      || sessionNode !== null && sessionNode !== localNode || requestUrl.searchParams.getAll('dshNode').length > 1
      || req.headers['x-dsh-prepare-continuation'] !== undefined ? undefined
      : { ...sessionSelectors, nodeId: localNode, ...observeReadySession }
    const delegatableRead = isDelegatablePersonalRead(req.method, requestUrl, typeof expectedPrincipal === 'string', req.headers.accept)
    let skipOrdinaryReadySession = false
    if (readySession?.target === 'personal' && (req.method === 'POST' || delegatableRead) && handlers.readySession !== undefined) {
      const candidate = signedPersonalForward(req, pathname, { ...readySession, target: 'personal' }, readySession.observe)
      if (candidate !== undefined) {
        const claims = candidate.forwarded.claims
        const managedPersonalRead = delegatableRead && claims.context?.personalRead !== undefined
          && claims.user.status === 'active' && !claims.user.mustChangePassword && nodeReadBridges.get(req.socket) === claims.issuerNode
        if (readyInteractive && claims.user.mustChangePassword) {
          // Preserve password-change enforcement before admitting interactive RPCs.
        } else if (req.method !== 'POST' && !managedPersonalRead) readySession.observe?.('forwarded', 'fallbackDelegation')
        else {
          if (!managedPersonalRead) skipOrdinaryReadySession = true
          if (await handlers.readySession(req, res, {
            ...readySession, ...candidate, actor: claims.user, ...(managedPersonalRead ? { managedPersonalRead: true } : {}),
          })) {
            auditForwardedAccount(req, pathname, claims)
            return
          }
        }
      }
    }

    const session = await currentUser(req)
    if (session === null) {
      if (wantsHtml(req)) { const returnTo = browserReturnPath(req.url); redirect(res, returnTo === '/' ? '/login' : `/login?returnTo=${encodeURIComponent(returnTo)}`); return }
      send(res, 401, '{"error":"unauthorized"}', 'application/json')
      return
    }
    if (recoveryRestricted && (session.user.id !== recovery.bootstrapUserId || session.user.role !== 'admin')) {
      req.resume(); send(res, 403, '{"error":"governance-recovery-bootstrap-required"}', 'application/json'); return
    }
    if (runtimeRead || pathname === '/api' || pathname.startsWith('/api/') || pathname.startsWith('/account/api/')) {
      res.setHeader('x-dsh-principal-id', String(session.user.id))
      if (!browserPrincipalMatches(req, session.user)) {
        req.resume()
        send(res, 409, JSON.stringify({ error: 'account-changed' }), 'application/json')
        return
      }
    }
    const { token, user, forward } = session
    if (forward === undefined) delete req.headers[RELEASE_COMBO_DIGEST_HEADER]
    if (!skipOrdinaryReadySession && readySession !== undefined && (!(runtimeRead || readyInteractive) || !user.mustChangePassword)
      && (forward === undefined || forwardedSessionMatches(forward, readySession))
      && await handlers.readySession?.(req, res, { ...readySession, actor: user, sessionToken: token,
        ...(forward === undefined ? {} : { entryNodeId: forward.issuerNode }) })) return
    const nodeAccessWrite = req.method === 'POST' && (pathname === '/admin/api/deployment/nodes/enrollments'
      || pathname.startsWith('/admin/api/deployment/nodes/access/') || pathname.startsWith('/admin/api/deployment/project-names/')
      || pathname.startsWith('/admin/api/deployment/project-content-migrations/'))
    // Recovery transactions validate the imported epoch and revision while the
    // cluster remains restoring; ordinary maintenance exemptions do not apply.
    if (!(recoveryRestricted && recoveryApi) && !await writesOpen(req, res, pathname, nodeAccessWrite)) return
    if (explicitSession && sessionSelectors === undefined) { send(res, 400, '{"error":"invalid-prepare-target"}', 'application/json'); return }

    if (pathname === '/logout' && req.method === 'POST') {
      await auth.revoke(token)
      handlers.invalidateAccess?.({ userId: user.id })
      await audit.write({ userId: user.id, action: 'logout', ip: clientIp(req) })
      redirect(res, '/login', [sessionCookie('', cfg, true)])
      return
    }

    if (user.mustChangePassword && pathname !== '/account/password') {
      if (wantsHtml(req)) { const returnTo = browserReturnPath(req.url); redirect(res, returnTo === '/' ? '/account/password' : `/account/password?returnTo=${encodeURIComponent(returnTo)}`); return }
      send(res, 403, '{"error":"password-change-required"}', 'application/json')
      return
    }

    if (recoveryRestricted && (pathname === '/' || pathname === '/admin')) {
      redirect(res, '/admin/governance-recovery'); return
    }
    if (recoveryApi) {
      if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
      try { await deps.governanceRecovery?.verifyAdministration() }
      catch (error) { throw new GovernanceAdmissionUnavailableError(error) }
      const abort = requestAbort(req, res)
      try {
        if (handlers.governanceRecovery !== undefined && await handlers.governanceRecovery.admin(req, res, user.id,
          { directLocal: forward === undefined, signal: abort.signal })) return
        req.resume(); send(res, 404, '{"error":"governance-recovery-unavailable"}', 'application/json')
      } finally { abort.dispose() }
      return
    }
    if (recoveryPage || recoveryRestricted && pathname.startsWith('/admin/assets/')) {
      if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
      if (localRecoveryPage && recovery?.state !== 'released') {
        send(res, 404, '{"error":"governance-recovery-unavailable"}', 'application/json'); return
      }
      if (localRecoveryPage && forward !== undefined) {
        send(res, 409, '{"error":"governance-recovery-local-entry-required"}', 'application/json'); return
      }
      if (!serveAdmin(req, res, pathname, handlers.adminRoot)) send(res, 404, 'not found', 'text/plain')
      return
    }

    if (pathname === '/account/api/project-name-proof') {
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'POST' || deps.projectNames === undefined) { send(res, 404, '', 'application/json'); return }
      const raw = await readBody(req, 4096)
      let parsed: unknown
      try { parsed = JSON.parse(raw) } catch { send(res, 400, '{"error":"invalid-name-request"}', 'application/json'); return }
      const proof = await deps.projectNames.redeem(parsed,user)
      send(res, 200, JSON.stringify(proof), 'application/json')
      return
    }

    if (pathname === '/account/api/deployment/context' || pathname === '/admin/api/deployment/topology'
      || pathname === '/admin/api/deployment/topology/preflight' || pathname === '/admin/api/deployment/topology/candidates') {
      res.setHeader('cache-control', 'no-store')
      if (deps.topology === undefined) { send(res, 501, '{"error":"deployment/unavailable"}', 'application/json'); return }
      if (pathname === '/account/api/deployment/context') {
        if (req.method !== 'GET') { send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return }
        const context = await deps.topology.read()
        if (context.legacyMigrationRequired) throw new DeploymentTopologyError(409, 'deployment/legacy-initialization-required')
        send(res, 200, JSON.stringify(context), 'application/json')
      } else {
        if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
        if (req.method === 'GET') send(res, 200, JSON.stringify(pathname.endsWith('/preflight')
          ? await deps.topology.preflight(user) : pathname.endsWith('/candidates')
            ? await deps.topology.candidates(user, new URL(req.url!, 'http://gateway').searchParams.get('cursor') ?? undefined) : await deps.topology.adminRead(user)), 'application/json')
        else if (req.method === 'PUT' && pathname === '/admin/api/deployment/topology') {
          const result = await deps.topology.save(user, jsonObject(await readBody(req)), clientIp(req))
          clearNodeIdentityCache()
          send(res, 200, JSON.stringify(result), 'application/json')
        } else send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
      }
      return
    }

    if (await computerAccessApi(deps.computerAccess, req, res, user, () => readBody(req))) return

    if (pathname === '/account/api/document-locations') {
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return }
      if (deps.documentLocations === undefined) { send(res, 501, '{"error":"document-locations-unavailable"}', 'application/json'); return }
      const query = new URL(req.url ?? '/', 'http://gateway').searchParams
      try { await sendCompressed(req, res, 200, JSON.stringify(await deps.documentLocations.page(user.id, {
        ...(query.has('cursor') ? { cursor: query.get('cursor')! } : {}),
        ...(query.has('limit') ? { limit: query.get('limit')! } : {}),
      })), 'application/json') } catch (error) {
        if (!(error instanceof DocumentCatalogError)) throw error
        send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
      }
      return
    }
    if (pathname === '/account/api/documents/overview' || pathname.startsWith('/account/api/documents/transfer/')) {
      res.setHeader('cache-control', 'no-store')
      const abort = new AbortController()
      const onAbort = (): void => { if (!res.writableEnded) abort.abort(new Error('Document request closed.')) }
      req.once('aborted', onAbort); res.once('close', onAbort)
      try {
        const operation = pathname.slice('/account/api/documents/transfer/'.length)
        const read = pathname.endsWith('/overview') || operation === 'capabilities'
        if (req.method !== (read ? 'GET' : 'POST')) { send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return }
        if (pathname.endsWith('/overview')) {
          res.setHeader('vary', 'accept')
          const query = new URL(req.url ?? '/', 'http://gateway').searchParams
          const options = parseDocumentOverviewOptions({ query: query.get('q') ?? undefined, type: query.get('type') ?? undefined,
            sort: query.get('sort') ?? undefined, cursor: query.get('cursor') ?? undefined,
            limit: query.has('limit') ? Number(query.get('limit')) : undefined })
          let result: unknown
          if (handlers.browserDocuments !== undefined) {
            const stream = req.headers.accept === BROWSER_DOCUMENT_OVERVIEW_STREAM && forward === undefined ? {
              response: res,
              authorize: async () => {
                const current = await auth.validate(token)
                return current?.id === user.id && !current.mustChangePassword
              },
            } : undefined
            result = await handlers.browserDocuments(req,user,'overview',options,abort.signal,stream)
          }
          else if (deps.documentOverview !== undefined) result = await deps.documentOverview.overview(user.id, options, true)
          else { send(res, 501, '{"error":"documents-unavailable"}', 'application/json'); return }
          if (!abort.signal.aborted && !res.headersSent) await sendCompressed(req, res, 200, JSON.stringify(result), 'application/json')
        } else {
          if (handlers.browserDocuments === undefined) { send(res, 501, '{"error":"documents-unavailable"}', 'application/json'); return }
          let payload: unknown
          if (!read) {
            try { payload = JSON.parse(await readBody(req, cfg.runtimeApiBodyLimitBytes)) as unknown }
            catch (error) { if (error instanceof BodyTooLargeError) throw error; throw new DocumentTransferError('INVALID_DOCUMENT_TRANSFER', 400, 'Invalid document request JSON.') }
          }
          const result = await handlers.browserDocuments(req, user, operation, payload, abort.signal)
          if (!abort.signal.aborted) await sendCompressed(req, res, 200, JSON.stringify(result), 'application/json')
        }
      } catch (error) {
        if (abort.signal.aborted || res.destroyed) return
        if (res.headersSent) { res.destroy(); return }
        if (error instanceof DocumentCatalogError || error instanceof DocumentTransferError) send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        else if (error instanceof BodyTooLargeError) send(res, 413, '{"error":"request-too-large"}', 'application/json')
        else { console.error('[gateway] browser document operation failed:', error); send(res, 503, '{"error":{"code":"DOCUMENT_TRANSFER_UNAVAILABLE","message":"Document service is temporarily unavailable."}}', 'application/json') }
      } finally { req.removeListener('aborted', onAbort); res.removeListener('close', onAbort) }
      return
    }
    if (pathname === '/account/api/workbench/context') {
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return }
      const query = new URL(req.url ?? pathname, 'http://gateway').searchParams
      const runtimeId = query.get('dshRuntime'), target = query.get('dshTarget'), nodeId = query.get('dshNode')
      if (query.getAll('dshRuntime').length !== 1 || !nodeUuidSchema.safeParse(runtimeId).success
        || query.getAll('dshTarget').length !== 1 || target === null
        || target !== 'personal' && !/^project:[1-9][0-9]*$/u.test(target)
        || query.getAll('dshNode').length > 1 || nodeId !== null && !nodeUuidSchema.safeParse(nodeId).success) {
        throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-id')
      }
      const { environment } = await runtimeRouter.placement(user, { runtimeId, target, scopeCookie: undefined })
      if (environment === undefined) throw new RuntimeCatalogError(503, 'runtime-catalog/unavailable')
      if (nodeId !== null && nodeId !== environment.node.id) throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
      await deps.topology?.assertNode(environment.node.id)
      const projects = await deps.collaboration?.projectsForUser(user.id) ?? []
      await sendCompressed(req, res, 200, JSON.stringify({ user: { id: user.id, displayName: user.displayName },
        environment: { id: environment.id, nodeId: environment.node.id }, projects }), 'application/json')
      return
    }
    if (pathname === '/account/runtime/wait') {
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') { res.setHeader('allow', 'GET'); sendStartFailure(req, res, { status: 405, reason: 'invalid', retryable: false }, null); return }
      const query = new URL(req.url ?? pathname, 'http://gateway').searchParams
      const observation = query.getAll('observation').length === 1 ? runtimeStartObservations.read(query.get('observation'), user.id) : null
      if (observation === null || query.size !== 1) {
        sendStartFailure(req, res, { status: 400, reason: 'invalid', retryable: false }, null); return
      }
      if (deps.runtimeCatalog === undefined) throw new RuntimeCatalogError(503, 'runtime-catalog/unavailable')
      const page = await deps.runtimeCatalog.pageForAccount(user, { ids: observation.runtimeId })
      const environment = page.items.find(item => item.id === observation.runtimeId)
      if (environment === undefined) throw new RuntimeCatalogError(403, 'runtime-catalog/forbidden')
      const target = environment.owner.kind === 'personal' ? 'personal' : `project:${environment.owner.id}`
      if (environment.node.id !== observation.nodeId || target !== observation.target) throw new RuntimeCatalogError(409, 'runtime-catalog/target-mismatch')
      await deps.topology?.assertNode(environment.node.id)
      if (observation.expiresAt <= Date.now()) {
        sendStartFailure(req, res, { status: 504, reason: 'pending', retryable: false }, null); return
      }
      if (environment.node.status !== 'active') {
        sendStartFailure(req, res, { status: 503, reason: 'unavailable', retryable: false }, null); return
      }
      if (environment.observedState === 'ready') {
        redirect(res, '/?' + new URLSearchParams({ dshRuntime: environment.id, dshNode: environment.node.id, dshTarget: target }))
        return
      }
      if (environment.observedState !== 'starting') {
        sendStartFailure(req, res, { status: 409, reason: 'changed', retryable: false }, null); return
      }
      send(res, 200, waitingPage(gateLanguage(req.headers.cookie), 'observe'))
      return
    }
    if (pathname === '/account/api/runtimes' || pathname === '/admin/api/runtimes') {
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
        return
      }
      if (deps.runtimeCatalog === undefined) { send(res, 503, '{"error":"runtime-catalog/unavailable"}', 'application/json'); return }
      const query = new URL(req.url ?? pathname, 'http://gateway').searchParams
      const cursor = query.get('cursor'), limit = query.get('limit'), ids = query.get('ids'), projectId = query.get('projectId')
      if (projectId !== null && (pathname !== '/account/api/runtimes' || query.getAll('projectId').length !== 1)) {
        throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-id')
      }
      const options = { ...(cursor === null ? {} : { cursor }), ...(limit === null ? {} : { limit }),
        ...(ids === null ? {} : { ids }), ...(projectId === null ? {} : { projectId }) }
      const result = pathname === '/account/api/runtimes'
        ? await deps.runtimeCatalog.pageForAccount(user, options)
        : await deps.runtimeCatalog.pageForAdministrator(user, options)
      await sendCompressed(req, res, 200, JSON.stringify(result), 'application/json')
      return
    }

    if (isCentralRuntimeManagementRequest(pathname, req.method ?? 'GET')) {
      if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
      if (handlers.admin === undefined) { send(res, 503, '{"error":"runtime-management/unavailable"}', 'application/json'); return }
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req)
      await handlers.admin(req, res, user, pathname, body)
      return
    }
    // Release-bundled files are identical on every computer running this
    // release: answer them from the center's own dist without selecting a
    // Runtime, so unpinned asset URLs share one browser cache entry and never
    // traverse a remote node hop. `/plugins/*` stays runtime-owned: combo and
    // chunk bodies are synthesized per Runtime composition, `/plugins/events`
    // is a live channel, and the Referer block below still pins any asset
    // path this release's dist does not hold.
    if (deps.releaseAssets !== undefined && (pathname.startsWith('/assets/') || pathname === '/favicon.svg')
      && await deps.releaseAssets.serve(req, res, pathname)) return
    if (handlers.runtimeAssets !== undefined && await handlers.runtimeAssets.handle(req, res, user, forward?.issuerNode)) return
    let selectedUrl = new URL(req.url ?? '/', 'http://gateway')
    let selection = selectedUrl.searchParams
    if ((pathname.startsWith('/assets/') || pathname.startsWith('/plugins/') || pathname === '/favicon.svg') && deps.runtimeCatalog !== undefined && !selection.has('dshRuntime') && req.headers.referer !== undefined) {
      const referer = new URL(req.headers.referer, 'http://gateway')
      const id = referer.searchParams.get('dshRuntime')
      if (id !== null && (cfg.publicOrigins.includes(referer.origin) || referer.host === req.headers.host)) {
        await deps.runtimeCatalog?.resolveForAccount(user, id)
        if ((req.method === 'GET' || req.method === 'HEAD') && shareableImmutableRequest(pathname, selectedUrl)) {
          // The URL names the same bytes on every Runtime: forward under the
          // Referer's runtime and keep the browser-visible URL unpinned, so
          // browser and CDN caches share it across runtimes. The normal
          // selected-runtime pipeline below forwards remote or serves local.
          req.url = pinRuntimeRequestPath(req.url ?? '/', id as import('./runtime-catalog.ts').RuntimeId)
          selectedUrl = new URL(req.url, 'http://gateway')
          selection = selectedUrl.searchParams
        } else {
          redirect(res, pinRuntimeRequestPath(req.url ?? '/', id as import('./runtime-catalog.ts').RuntimeId))
          return
        }
      }
    }
    if (pathname === '/' && req.method === 'GET' && deps.runtimeCatalog !== undefined && !selection.has('dshRuntime')) {
      let choice = selection.has('environments')
      if (!choice) {
        try {
          const requested = { runtimeId: null, target: selection.get('dshTarget'), scopeCookie: parseCookies(req.headers.cookie).get(SCOPE_COOKIE) }
          const placement = selection.has('dshNode') ? await runtimeRouter.placement(user, requested) : await runtimeRouter.landing(user, requested)
          if (placement.environment !== undefined) {
            selection.set('dshRuntime', placement.environment.id)
            redirect(res, `/?${selection}`)
            return
          }
        } catch (error) {
          if (!(error instanceof RuntimeCatalogError) || ![404, 409].includes(error.status)) throw error
          choice = true
        }
      }
      if (choice) {
        send(res, 200, environmentsPage(await deps.runtimeCatalog.pageForAccount(user, {
          ...(selection.has('cursor') ? { cursor: selection.get('cursor')! } : {}),
        }), gateLanguage(req.headers.cookie), (await deps.topology?.read())?.mode === 'multi'), 'text/html')
        return
      }
    }
    if (pathname === '/' && req.method === 'GET' && (selection.get('dshBootstrap') === '1' || selection.get('dshBootstrap') === 'full')) {
      res.setHeader('x-dsh-principal-id', String(user.id))
      if (!browserPrincipalMatches(req, user)) {
        send(res, 409, '{"error":"account-changed"}', 'application/json')
        return
      }
    }
    if (pathname === '/' && req.method === 'GET' && wantsHtml(req) && !recoveryRestricted
      && requestedNode === undefined && !selection.has('dshBootstrap')
      && selection.getAll('dshRuntime').length === 1 && selection.getAll('dshTarget').length <= 1
      && selection.getAll('dshNode').length <= 1 && deps.releaseAssets?.serveDeferredIndex !== undefined
      && deps.runtimeCatalog !== undefined && deps.nodeServiceProxy !== undefined
      && deps.topology !== undefined && (await deps.topology.read()).role === 'primary') {
      await deps.accessMonitor?.synchronize()
      const runtimeId = selection.get('dshRuntime')!
      if (!nodeUuidSchema.safeParse(runtimeId).success) throw new RuntimeCatalogError(400, 'runtime-catalog/invalid-id')
      const environment = (await deps.runtimeCatalog.pageForAccount(user, { ids: runtimeId, limit: '1' })).items[0]
      if (environment?.id !== runtimeId) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
      if (environment.node.id !== deps.nodeServiceIdentity?.nodeId) {
        if (selection.has('dshNode') && selection.get('dshNode') !== environment.node.id) throw new NodeServiceError(400, 'node-service/invalid-target')
        const scope = environment.owner.kind === 'personal' ? 'personal' : `project:${environment.owner.id}` as const
        if (selection.has('dshTarget') && selection.get('dshTarget') !== scope) throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
        await deps.topology.assertNode(environment.node.id)
        if (await deps.releaseAssets.serveDeferredIndex(res, {
          principalId: user.id, runtimeId: environment.id, nodeId: environment.node.id, nodeName: environment.node.name,
          scope, language: gateLanguage(req.headers.cookie),
        })) return
      }
    }
    const explicitScope = isExplicitScopeRequest(req.method, selectedUrl)
    const selectedNode = selection.get('dshNode')
    let localNodeDirectlyAdmitted = false
    if (selectedNode !== null) {
      const nodeProjectCreation = pathname === '/account/api/projects' && req.method === 'POST'
      const nodeMetadata = (pathname === '/account/api/project-metadata' || pathname === '/account/api/node-document-overview') && req.method === 'GET'
      if (selection.getAll('dshNode').length !== 1 || (nodeMetadata && (selection.has('dshRuntime') || selection.has('dshTarget')))) throw new NodeServiceError(400, 'node-service/invalid-target')
      if (!nodeUuidSchema.safeParse(selectedNode).success) throw new NodeServiceError(400, 'node-service/invalid-target')
      await deps.topology?.assertNode(selectedNode)
      if (!selection.has('dshRuntime') && !pathname.startsWith('/api/documents') && !nodeProjectCreation && !nodeMetadata
        && (!pathname.startsWith('/admin/api/') || user.role !== 'admin')) throw new NodeServiceError(403, 'node-service/invalid-target')
      if (!explicitSession && !explicitScope && selectedNode !== deps.nodeServiceIdentity?.nodeId && deps.nodeServiceProxy === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
      if ((pathname.startsWith('/api/documents') || nodeProjectCreation || nodeMetadata) && selectedNode === deps.nodeServiceIdentity?.nodeId) {
        await deps.computerAccess?.authorize(user.id)
      }
      if (selectedNode === deps.nodeServiceIdentity?.nodeId && !selection.has('dshRuntime')
        && (pathname.startsWith('/api/documents') || nodeProjectCreation || nodeMetadata
          || (pathname.startsWith('/admin/api/') && !/^\/admin\/api\/runtimes\/[^/]+\/(?:start|stop|restart|retire|personal-directory\/promote)$/u.test(pathname)))) {
        localNodeDirectlyAdmitted = true
      }
    }
    let admittedPlacement:RuntimePlacement|undefined
    const remember = explicitSession ? (placement:RuntimePlacement)=>{admittedPlacement=placement} : undefined
    if (!localNodeDirectlyAdmitted && !(pathname === '/account/runtime/start' && req.method === 'POST') && !recoveryRestricted && deps.nodeServiceProxy !== undefined && await deps.nodeServiceProxy.http(req, res, user,undefined,remember)) return
    if (deps.nodeServiceProxy === undefined && selection.has('dshRuntime') && !pathname.startsWith('/admin/api/')) {
      const placement = await runtimeRouter.placement(user, { runtimeId: selection.get('dshRuntime'), target: selection.get('dshTarget'),
        scopeCookie: parseCookies(req.headers.cookie).get(SCOPE_COOKIE) })
      if (explicitSession || explicitScope) {
        assertPlacementComputer(placement, selectedNode, requestedNode, deps.nodeServiceIdentity?.nodeId)
      }
      if (!placement.local) throw new RuntimeCatalogError(503, 'runtime-catalog/remote-unavailable')
      remember?.(placement)
    }

    if (pathname === '/admin/api/performance/operations') {
      if (user.role!=='admin') { sendAdminGate(res,pathname,'forbidden');return }
      res.setHeader('cache-control','no-store')
      if (req.method!=='GET') {send(res,405,'{"error":"method-not-allowed"}','application/json');return}
      const id=selection.get('id')
      if (id!==null && !nodeUuidSchema.safeParse(id).success) {send(res,400,'{"error":"invalid-operation-id"}','application/json');return}
      await sendCompressed(req, res, 200, JSON.stringify({ operations: operationTimings.samples(id ?? undefined) }), 'application/json')
      return
    }
    if (pathname === '/admin/api/performance') {
      if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
        return
      }
      await sendCompressed(req, res, 200, JSON.stringify({
        ...performanceObserver.snapshot(deps.instances.capacitySnapshot?.() ?? null),
        databasePool: deps.databasePerformance?.() ?? null,
        modelPolicyProjection: modelPolicyProjectionDiagnostics(deps),
        nodeForwarding: deps.nodeServiceProxy?.diagnostics?.() ?? null,
        runtimeAssets: handlers.runtimeAssets?.diagnostics?.() ?? null,
      }), 'application/json')
      return
    }

    if (pathname === '/account/api/usage' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store')
      if (deps.governance === undefined) { send(res, 503, '{"error":"usage-unavailable"}', 'application/json'); return }
      const month = selection.get('month') ?? undefined
      if (month !== undefined && !/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) {
        send(res, 400, '{"error":"invalid-month"}', 'application/json'); return
      }
      const resolvedUsage = await requestContext(req, user, undefined, forward)
      if (resolvedUsage.resetScope) res.setHeader('set-cookie', scopeCookie('personal', cfg))
      const projectId = resolvedUsage.context.scope.kind === 'project' ? resolvedUsage.context.scope.projectId : undefined
      const selectedNodeId = resolvedUsage.context.environment?.nodeId
      const subject = projectId !== undefined
        ? { kind: 'project' as const, id: projectId }
        : { kind: 'user' as const, id: user.id }
      try {
        const summary = await readPublicationAuthority('usage', () => deps.governance!.summary(subject, month))
        if (projectId !== undefined) {
          if (deps.collaboration?.projectReadAuthorities === undefined) {
            send(res, 501, '{"error":"usage-read-authority-unavailable"}', 'application/json'); return
          }
          const authorities = await readPublicationAuthority('usage', () => deps.collaboration!.projectReadAuthorities!(user.id, projectId))
          if (!authorities.some(authority => authority.projectId === projectId
            && (selectedNodeId === undefined || authority.nodeId === selectedNodeId))) throw new CollaborationDeniedError('forbidden')
        }
        const current = await readPublicationAuthority('usage', () => auth.validate(token))
        if (current === null || current.id !== user.id || current.mustChangePassword) throw new CollaborationDeniedError('forbidden')
        send(res, 200, JSON.stringify(summary), 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    if (pathname === '/account/password') {
      const returnQuery = new URL(req.url ?? '/account/password', 'http://gateway.invalid').searchParams
      const gateLang = gateLanguage(req.headers.cookie)
      if (req.method === 'GET') { send(res, 200, passwordPage('', gateLang, recoveryRestricted ? '/admin/governance-recovery' : browserReturnPath(returnQuery.get('returnTo')))); return }
      if (req.method === 'POST') {
        const form = new URLSearchParams(await readBody(req))
        const password = form.get('password') ?? ''
        const returnTo = recoveryRestricted ? '/admin/governance-recovery' : browserReturnPath(form.get('returnTo') ?? returnQuery.get('returnTo'))
        if (password.length < MIN_PASSWORD_LENGTH) { send(res, 400, passwordPage(gateCopy(gateLang)('passwordTooShort', { min: String(MIN_PASSWORD_LENGTH) }), gateLang, returnTo)); return }
        if (password.length > MAX_PASSWORD_LENGTH) { send(res, 400, passwordPage(gateCopy(gateLang)('passwordTooLong', { max: String(MAX_PASSWORD_LENGTH) }), gateLang, returnTo)); return }
        await users.changeOwnPassword(user.id, password, token)
        handlers.invalidateAccess?.({ userId: user.id })
        await removeBootstrapAdminPassword(cfg.bootstrapAdminPasswordFile).catch((error: unknown) => {
          // Password change remains successful; operators can remove a stale
          // one-time file after the warning if the filesystem rejected it.
          console.error('[gateway] bootstrap password file cleanup failed:', error)
        })
        await audit.write({ userId: user.id, action: 'password.changed', ip: clientIp(req) })
        redirect(res, returnTo)
        return
      }
    }

    if (pathname === '/account/api/push-devices' && req.method === 'POST') {
      if (deps.push === undefined) {
        send(res, 503, '{"error":"push-unavailable"}', 'application/json')
        return
      }
      const input = jsonObject(await readBody(req))
      const token = stringField(input?.token)
      const platform = input?.platform
      const provider = input?.provider === undefined ? 'fcm' : input.provider
      const deviceId = input?.deviceId === undefined ? undefined : stringField(input.deviceId)
      const appVersion = input?.appVersion === undefined ? undefined : stringField(input.appVersion)
      if (token === undefined || token.length > 4096 || platform !== 'android'
        || (provider !== 'fcm' && provider !== 'jpush' && provider !== 'unifiedpush')
        || (input?.deviceId !== undefined && deviceId === undefined)
        || (input?.appVersion !== undefined && appVersion === undefined)) {
        send(res, 400, '{"error":"invalid-push-device"}', 'application/json')
        return
      }
      const device = await deps.push.registerDevice(user.id, {
        token,
        platform,
        provider: provider as PushProvider,
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(appVersion === undefined ? {} : { appVersion }),
      })
      send(res, 201, JSON.stringify(device), 'application/json')
      return
    }

    if (pathname === '/account/api/push-devices' && req.method === 'GET') {
      if (deps.push === undefined) {
        send(res, 503, '{"error":"push-unavailable"}', 'application/json')
        return
      }
      send(res, 200, JSON.stringify(await deps.push.listDevices(user.id)), 'application/json')
      return
    }

    if (pathname === '/account/api/push-receipts' && req.method === 'POST') {
      if (deps.push === undefined) {
        send(res, 503, '{"error":"push-unavailable"}', 'application/json')
        return
      }
      const input = jsonObject(await readBody(req))
      const token = stringField(input?.token)
      const provider = input?.provider
      const sessionId = stringField(input?.sessionId)
      const runtimeId = input?.runtimeId
      const eventSeq = input?.eventSeq
      const kind = input?.kind
      if (token === undefined || token.length > 4096
        || (provider !== 'fcm' && provider !== 'jpush' && provider !== 'unifiedpush')
        || sessionId === undefined || sessionId.length > 512
        || runtimeId !== undefined && !nodeUuidSchema.safeParse(runtimeId).success
        || typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq) || eventSeq < 0
        || (kind !== 'arrived' && kind !== 'opened')) {
        send(res, 400, '{"error":"invalid-push-receipt"}', 'application/json')
        return
      }
      const outcome = await deps.push.recordReceipt(user.id, {
        provider, token, sessionId, eventSeq, kind,
        ...(runtimeId === undefined ? {} : { runtimeId: runtimeId as RuntimeId }),
      })
      if (outcome === 'missing') {
        send(res, 404, '{"error":"push-receipt-target-missing"}', 'application/json')
        return
      }
      send(res, 200, '{"recorded":true}', 'application/json')
      return
    }

    const pushDeviceRoute = pathname.match(/^\/account\/api\/push-devices\/([^/]+)$/)
    if (pushDeviceRoute !== null && req.method === 'DELETE') {
      if (deps.push === undefined) {
        send(res, 503, '{"error":"push-unavailable"}', 'application/json')
        return
      }
      let deviceId: string
      try {
        deviceId = decodeURIComponent(pushDeviceRoute[1] ?? '')
      } catch {
        send(res, 400, '{"error":"invalid-push-device-id"}', 'application/json')
        return
      }
      if (!/^[0-9a-f-]{36}$/iu.test(deviceId)) {
        send(res, 400, '{"error":"invalid-push-device-id"}', 'application/json')
        return
      }
      const removed = await deps.push.removeDevice(user.id, deviceId)
      if (!removed) {
        send(res, 404, '{"error":"push-device-not-found"}', 'application/json')
        return
      }
      res.writeHead(204)
      res.end()
      return
    }

    if ((pathname === '/account/api/scope' || pathname === '/account/runtime/start') && req.method === 'POST') {
      const htmlStart = pathname === '/account/runtime/start'
      const finish = (scope: 'personal' | `project:${number}`, runtimeId?: import('./runtime-catalog.ts').RuntimeId): void => {
        const destination = runtimeId === undefined ? '/' : `/?dshRuntime=${encodeURIComponent(runtimeId)}`
        if (htmlStart) redirect(res, destination, runtimeId === undefined ? [scopeCookie(scope, cfg)] : [])
        else { res.writeHead(204, runtimeId === undefined ? { 'set-cookie': scopeCookie(scope, cfg) } : { location: destination }); res.end() }
      }
      let requested: unknown
      let body: string
      try {
        body = await readBody(req)
        const form = htmlStart ? new URLSearchParams(body) : undefined
        requested = form === undefined ? JSON.parse(body)
          : { kind: form.get('kind'), projectId: Number(form.get('projectId')) }
      } catch {
        if (htmlStart) sendStartFailure(req, res, { status: 400, reason: 'invalid', retryable: false }, null)
        else send(res, 400, '{"error":"invalid-json"}', 'application/json')
        return
      }
      if (typeof requested !== 'object' || requested === null || Array.isArray(requested)) {
        if (htmlStart) sendStartFailure(req, res, { status: 400, reason: 'invalid', retryable: false }, null)
        else send(res, 400, '{"error":"invalid-scope"}', 'application/json')
        return
      }
      const value = requested as { kind?: unknown; projectId?: unknown }
      if (value.kind !== 'personal' && (value.kind !== 'project' || typeof value.projectId !== 'number'
        || !Number.isSafeInteger(value.projectId) || value.projectId <= 0)) {
        if (htmlStart) sendStartFailure(req, res, { status: 400, reason: 'invalid', retryable: false }, null)
        else send(res, 400, '{"error":"invalid-scope"}', 'application/json')
        return
      }
      const scopeQuery = new URL(req.url ?? '/', 'http://gateway').searchParams
      const requestedTarget = value.kind === 'personal' ? 'personal' : `project:${String(value.projectId)}`
      if (htmlStart) {
        const action = '/account/runtime/start' + new URL(req.url ?? '/', 'http://gateway').search
        runtimeStartForms.set(req, value.kind === 'personal'
          ? { action, kind: 'personal' }
          : { action, kind: 'project', projectId: value.projectId as number })
      }
      if (scopeQuery.has('dshTarget') && scopeQuery.get('dshTarget') !== requestedTarget) throw new RuntimeCatalogError(400, 'runtime-catalog/target-mismatch')
      const placement = await runtimeRouter.placement(user, {
        runtimeId: scopeQuery.get('dshRuntime'), target: requestedTarget, scopeCookie: undefined,
      })
      if (explicitScope) assertPlacementComputer(placement, selectedNode, requestedNode, deps.nodeServiceIdentity?.nodeId)
      if (placement.environment !== undefined) await deps.topology?.assertNode(placement.environment.node.id)
      if (!placement.local) {
        if (deps.nodeServiceProxy === undefined || placement.environment === undefined) throw new RuntimeCatalogError(503, 'runtime-catalog/remote-unavailable')
        const forwarded = new URL(req.url ?? '/', 'http://gateway')
        forwarded.searchParams.set('dshRuntime', placement.environment.id)
        forwarded.searchParams.set('dshNode', placement.environment.node.id)
        forwarded.searchParams.set('dshTarget', placement.target)
        req.url = forwarded.pathname + forwarded.search
        if (htmlStart) runtimeStartForms.set(req, value.kind === 'personal'
          ? { action: req.url, kind: 'personal' }
          : { action: req.url, kind: 'project', projectId: value.projectId as number })
        try {
          if (!await deps.nodeServiceProxy.http(req, res, user, { body, runtimeId: placement.environment.id })) {
            throw new RuntimeCatalogError(503, 'runtime-catalog/remote-unavailable')
          }
        } catch (error) {
          if (!htmlStart || !(error instanceof NodeServiceResponseUnknownError) || res.headersSent || res.destroyed) throw error
          res.writeHead(303, { 'cache-control': 'no-store', location: runtimeStartObservations.issue(user.id, placement.environment, placement.target) })
          res.end()
        }
        return
      }
      if (value.kind === 'personal') {
        await deps.instances.ensureRunning({ ...user, ...(placement.environment === undefined ? {} : { runtimeId: placement.environment.id }) }, 'explicit')
        finish('personal', placement.environment?.id)
        return
      }
      const projectId = value.projectId as number
      const project = await deps.collaboration?.projectForUser(projectId, user.id)
      if (project === undefined || project === null) {
        if (htmlStart) sendStartFailure(req, res, { status: 403, reason: 'denied', retryable: false }, null)
        else send(res, 403, '{"error":"not-member"}', 'application/json')
        return
      }
      await deps.instances.ensureRunning({
        kind: 'project',
        id: projectId,
        name: project.name,
        path: project.path,
        ...(placement.environment === undefined ? {} : { runtimeId: placement.environment.id }),
        steward: project.kind === 'steward',
      }, 'explicit')
      finish(`project:${projectId}`, placement.environment?.id)
      return
    }

    let contextFlight: ReturnType<typeof requestContext> | undefined
    const selectedContext = () => contextFlight ??= requestContext(req, user,admittedPlacement, forward).then(resolved => {
      if (resolved.resetScope) res.setHeader('set-cookie', scopeCookie('personal', cfg))
      return resolved
    })

    if (pathname.startsWith('/account/api/drafts/')) {
      res.setHeader('cache-control', 'no-store')
      const draftId = pathname.slice('/account/api/drafts/'.length)
      const requestedRuntime = selection.get('dshRuntime')
      const target = selection.get('dshTarget')
      const sessionId = selection.get('sessionId') ?? ''
      if (!nodeUuidSchema.safeParse(draftId).success || selection.getAll('dshRuntime').length !== 1
        || !nodeUuidSchema.safeParse(requestedRuntime).success || selection.getAll('dshTarget').length !== 1 || target === null
        || selection.getAll('sessionId').length > 1 || (selection.has('sessionId') && sessionId === '')
        || sessionId.length > 512 || sessionId.includes('\0')) {
        send(res, 400, '{"error":"invalid-draft-target"}', 'application/json'); return
      }
      if (!handlers.nodeDrafts || !deps.nodeServiceIdentity) { send(res, 503, '{"error":"drafts-unavailable"}', 'application/json'); return }
      let operation: import('./node-drafts.ts').NodeDraftOperation = { kind: 'read' }
      if (selection.has('revision')) {
        const value = selection.get('revision')!
        if (req.method !== 'GET' || selection.getAll('revision').length !== 1 || !/^(?:0|[1-9]\d*)$/u.test(value) || !Number.isSafeInteger(Number(value))) {
          send(res, 400, '{"error":"invalid-draft-revision"}', 'application/json'); return
        }
        operation = { kind: 'read', revision: Number(value) }
      }
      if (req.method === 'PUT' || req.method === 'DELETE') {
        const raw = await readBody(req)
        let body: unknown
        try { body = JSON.parse(raw) } catch { body = null }
        const draftText = req.method === 'DELETE' ? '' : typeof body === 'object' && body !== null && 'text' in body ? body.text : undefined
        if (typeof body !== 'object' || body === null || !('revision' in body) || typeof body.revision !== 'number'
          || !Number.isSafeInteger(body.revision) || body.revision < 0 || body.revision >= Number.MAX_SAFE_INTEGER
          || typeof draftText !== 'string') {
          send(res, 400, '{"error":"invalid-draft"}', 'application/json'); return
        }
        operation = { kind: 'save', value: { revision: body.revision, text: draftText } }
      } else if (req.method !== 'GET') { res.setHeader('allow', 'GET, PUT, DELETE'); send(res, 405, '', 'application/json'); return }
      const identity=deps.nodeServiceIdentity
      const authorize=async()=>{
        const fresh=forward!==undefined?user:await auth.validate(token)
        if (!fresh || fresh.id!==user.id || fresh.mustChangePassword) throw new CollaborationDeniedError('forbidden')
        const resolved=(await requestContext(req,fresh,undefined,forward)).context
        const environment=resolved.environment,scope=resolved.scope
        if (!environment || environment.id!==requestedRuntime || environment.nodeId!==identity.nodeId ||
          target!==(scope.kind==='personal'?'personal':`project:${scope.projectId}`)) throw new RuntimeCatalogError(400,'runtime-catalog/target-mismatch')
        if(scope.kind==='project') {
          if(operation.kind==='save' && scope.mode!=='rw') throw new CollaborationDeniedError('forbidden')
          if(sessionId && !handlers.nodeDrafts?.applyAuthenticated) {
            if(!deps.collaboration) throw new CollaborationDeniedError('forbidden')
            await deps.collaboration.access(fresh.id,environment.id,sessionId,operation.kind==='read'?'read':'write')
          }
        }
        return environment
      }
      await deps.accessMonitor?.synchronize()
      const environment=await authorize()
      const key={organizationId:identity.organizationId,nodeId:environment.nodeId,userId:user.id,runtimeId:environment.id,target,sessionId,draftId}
      const result=handlers.nodeDrafts.applyAuthenticated
        ? await handlers.nodeDrafts.applyAuthenticated(key,operation,createHash('sha256').update(token).digest())
        : await handlers.nodeDrafts.apply(key,operation)
      if(!handlers.nodeDrafts.applyAuthenticated&&operation.kind==='read') await authorize()
      res.setHeader('x-dsh-runtime-id', environment.id)
      send(res, result.status, JSON.stringify(result.status === 200 ? result.value : { error: result.status === 410 ? 'draft-version-unavailable' : 'draft-revision-conflict' }), 'application/json')
      return
    }

    const scopedUploadRequest = pathname === DOCUMENT_TRANSFER_UPLOADS_PATH
      || pathname.startsWith(`${DOCUMENT_TRANSFER_UPLOADS_PATH}/`)
    if (scopedUploadRequest && handlers.documentTransferUpload !== undefined) {
      const requestUrl = new URL(req.url ?? '/', 'http://gateway')
      const isChunk = /\/chunks\/[0-9]+$/u.test(pathname)
      const isSession = /^\/api\/documents\/transfer\/uploads\/[0-9a-f-]{36}$/u.test(pathname)
      const isComplete = /\/complete$/u.test(pathname)
      const allowed = pathname === DOCUMENT_TRANSFER_UPLOADS_PATH
        ? req.method === 'POST'
        : isChunk
          ? req.method === 'PUT'
          : isComplete
            ? req.method === 'POST'
            : isSession && (req.method === 'GET' || req.method === 'DELETE')
      if (!allowed) {
        send(res, 405, JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }), 'application/json')
        return
      }
      let scope
      try {
        scope = parseDocumentScopeKey(requestUrl.searchParams.get('scope'), requestUrl.searchParams.get('dshRuntime') ?? undefined, requestUrl.searchParams.get('dshNode') ?? undefined)
      } catch (error: unknown) {
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else {
          send(res, 400, JSON.stringify({ error: { code: 'INVALID_DOCUMENT_TRANSFER', message: 'Invalid document upload scope.' } }), 'application/json')
        }
        return
      }
      const abort = requestAbort(req, res)
      const access = watchDocumentAccess(deps, res, abort, user, scope)
      let cleanupFailure: DocumentLeaseReleaseError | undefined
      if (!isScopedUploadDataPath(req.method, pathname)) {
        res.once('finish', () => {
          // Successful data-plane traffic is transport noise; only failures are audit-worthy.
          if (res.statusCode < 400) return
          void Promise.resolve(audit.write({
            userId: user.id,
            action: 'api',
            methodPath: `${req.method} ${pathname}`,
            status: res.statusCode,
            ip: clientIp(req),
          })).catch(error => { console.error('[gateway] API audit write failed:', error) })
        })
      }
      try {
        const actor = await access.admit(token)
        if (actor === null) {
          send(res, 401, '{"error":"unauthorized"}', 'application/json')
          return
        }
        const response = await handlers.documentTransferUpload({
          user: actor,
          request: req,
          pathname,
          scope,
          signal: access.signal,
        })
        if (access.signal.aborted || res.destroyed || res.writableEnded) await response.body?.cancel(access.signal.reason)
        else await sendGatewayResponse(res, response, cfg.upstreamResponseLimitBytes)
      } catch (error: unknown) {
        if (error instanceof DocumentLeaseReleaseError) {
          cleanupFailure = error
          console.error('[gateway] document lease cleanup failed:', error)
        }
        if (access.signal.aborted || res.destroyed || res.writableEnded) return
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
          return
        }
        send(res, 503, JSON.stringify({ error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE', message: 'Target document runtime is unavailable.' } }), 'application/json')
      } finally {
        access.finish(cleanupFailure)
      }
      return
    }

    const scopedOperation = handlers.documentScope === undefined
      ? undefined
      : scopedDocumentOperation(pathname, req.method)
    if (scopedOperation !== undefined && handlers.documentScope !== undefined) {
      const requestUrl = new URL(req.url ?? '/', 'http://gateway')
      let scope: ReturnType<typeof parseDocumentScopeKey>
      try {
        scope = parseDocumentScopeKey(requestUrl.searchParams.get('scope'), requestUrl.searchParams.get('dshRuntime') ?? undefined, requestUrl.searchParams.get('dshNode') ?? undefined)
      } catch (error: unknown) {
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else {
          send(res, 400, JSON.stringify({ error: { code: 'INVALID_DOCUMENT_TRANSFER', message: 'Invalid document scope.' } }), 'application/json')
        }
        return
      }
      const abort = requestAbort(req, res)
      const access = scopedOperation === 'content' ? watchDocumentAccess(deps, res, abort, user, scope) : undefined
      let cleanupFailure: DocumentLeaseReleaseError | undefined
      const signal = access?.signal ?? abort.signal
      res.once('finish', () => {
        // Successful data-plane traffic is transport noise; only failures are audit-worthy.
        if (res.statusCode < 400) return
        void Promise.resolve(audit.write({
          userId: user.id,
          action: 'api',
          methodPath: `${req.method} ${pathname}`,
          status: res.statusCode,
          ip: clientIp(req),
        })).catch(error => { console.error('[gateway] API audit write failed:', error) })
      })
      try {
        let actor = user
        if (access !== undefined) {
          const current = await access.admit(token)
          if (current === null) {
            send(res, 401, '{"error":"unauthorized"}', 'application/json')
            return
          }
          actor = current
        }
        const response = await handlers.documentScope({
          user: actor,
          request: req,
          response: res,
          pathname,
          operation: scopedOperation,
          scope,
          signal,
        })
        // A locally served content stream writes directly into `res` and
        // resolves undefined; JSON routes still travel through the sender.
        if (response !== undefined) {
          if (signal.aborted || res.destroyed || res.writableEnded) await response.body?.cancel(signal.reason)
          else await sendGatewayResponse(res, response, cfg.upstreamResponseLimitBytes)
        }
      } catch (error: unknown) {
        if (error instanceof DocumentLeaseReleaseError) {
          cleanupFailure = error
          console.error('[gateway] document lease cleanup failed:', error)
        }
        if (signal.aborted || res.destroyed || res.writableEnded) return
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
        } else {
          send(res, 503, JSON.stringify({ error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE', message: 'Document scope is temporarily unavailable.' } }), 'application/json')
        }
      } finally {
        if (access === undefined) abort.dispose()
        else access.finish(cleanupFailure)
      }
      return
    }

    if (pathname === '/api/documents/transfer/list' && req.method === 'POST'
      && handlers.documentTransferList !== undefined) {
      let payload: unknown
      try {
        payload = JSON.parse(await readBody(req, cfg.runtimeApiBodyLimitBytes)) as unknown
      } catch (error: unknown) {
        if (error instanceof BodyTooLargeError) {
          send(res, 413, JSON.stringify({ error: { code: 'DOCUMENT_TRANSFER_TOO_LARGE', message: 'Document scope listing request is too large.' } }), 'application/json')
        } else {
          send(res, 400, JSON.stringify({ error: { code: 'INVALID_DOCUMENT_TRANSFER', message: 'Invalid document scope listing JSON.' } }), 'application/json')
        }
        return
      }
      const abort = new AbortController()
      const onRequestAbort = (): void => { if (!abort.signal.aborted) abort.abort(new Error('document request aborted')) }
      const onResponseClose = (): void => { if (!res.writableEnded) onRequestAbort() }
      req.once('aborted', onRequestAbort)
      res.once('close', onResponseClose)
      res.once('finish', () => {
        // Successful data-plane traffic is transport noise; only failures are audit-worthy.
        if (res.statusCode < 400) return
        void Promise.resolve(audit.write({
          userId: user.id,
          action: 'api',
          methodPath: `${req.method} ${pathname}`,
          status: res.statusCode,
          ip: clientIp(req),
        })).catch(error => { console.error('[gateway] API audit write failed:', error) })
      })
      res.setHeader('cache-control', 'no-store')
      try {
        const result = await handlers.documentTransferList({ user, payload, signal: abort.signal })
        if (!abort.signal.aborted && !res.writableEnded) send(res, 200, JSON.stringify(result), 'application/json')
      } catch (error: unknown) {
        if (abort.signal.aborted || res.writableEnded) return
        if (error instanceof DocumentTransferError) {
          send(res, error.status, JSON.stringify({ error: { code: error.code, message: error.message } }), 'application/json')
          return
        }
        console.error('[gateway] document scope listing failed:', error)
        send(res, 503, JSON.stringify({
          error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE', message: 'Document scope listing is temporarily unavailable.' },
        }), 'application/json')
      } finally {
        req.removeListener('aborted', onRequestAbort)
        res.removeListener('close', onResponseClose)
      }
      return
    }

    if (pathname === '/account/api/context' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store')
      const resolved = await selectedContext()
      const projects = await accountContextProjects(deps, user)
      const activeProjectId = resolved.context.scope.kind === 'project'
        ? resolved.context.scope.projectId
        : undefined
      const activeProject = activeProjectId === undefined
        ? undefined
        : projects.find(project => project.projectId === activeProjectId)
      const activeScope = activeProject === undefined
        ? resolved.context.scope
        : {
          ...resolved.context.scope,
          canManage: activeProject.canManage === true,
          ...(activeProject.kind === 'steward' ? { steward: true } : {}),
          ...(activeProject.uiThemePolicy === undefined ? {} : { uiThemePolicy: activeProject.uiThemePolicy }),
        }
      await sendCompressed(req, res, 200, JSON.stringify({
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
        },
        scope: activeScope,
        ...(resolved.context.environment === undefined ? {} : { environment: resolved.context.environment }),
        projects,
        // The shared project runtime remains confined to its project path;
        // this flag only advertises the administrator-only preset choice.
        fullAccess: user.role === 'admin',
        autoReviewEligible: user.autoReviewEligible,
      }), 'application/json')
      return
    }

    if (pathname === '/account/api/node-document-overview') {
      res.setHeader('cache-control', 'no-store')
      if (req.method !== 'GET') { send(res,405,'{"error":"method-not-allowed"}','application/json'); return }
      if (selectedNode === null || selectedNode !== deps.nodeServiceIdentity?.nodeId) throw new NodeServiceError(400,'node-service/invalid-target')
      if (!deps.documentOverview?.localOverview) { send(res,503,'{"error":"node-content/unavailable"}','application/json'); return }
      const abort = requestAbort(req, res)
      try {
        const options = parseDocumentOverviewOptions({ query: selection.get('q') ?? undefined, type: selection.get('type') ?? undefined,
          sort: selection.get('sort') ?? undefined })
        const offset = selection.get('offset'), limit = selection.get('limit')
        if (!/^(?:0|[1-9][0-9]*)$/u.test(offset ?? '') || !/^[1-9][0-9]*$/u.test(limit ?? '')) {
          throw new DocumentCatalogError('INVALID_DOCUMENT_METADATA',400,'Invalid document page.')
        }
        const page = await deps.documentOverview.localOverview(user.id,options,Number(offset),Number(limit),abort.signal)
        if (!abort.signal.aborted) await sendCompressed(req, res, 200, JSON.stringify(page), 'application/json')
      } catch (error) {
        if (abort.signal.aborted) return
        if (!(error instanceof DocumentCatalogError)) throw error
        send(res,error.status,JSON.stringify({error:{code:error.code,message:error.message}}),'application/json')
      } finally { abort.dispose() }
      return
    }
    if ((pathname === '/account/api/project-metadata' || pathname === '/admin/api/project-metadata') && req.method === 'GET') {
      res.setHeader('cache-control','no-store')
      const adminView = pathname.startsWith('/admin/')
      if (adminView && user.role !== 'admin') { sendAdminGate(res,pathname,'forbidden'); return }
      const ids = (selection.get('ids') ?? '').split(',')
      if (selection.getAll('dshNode').length !== 1 || selection.get('dshNode') !== deps.nodeServiceIdentity?.nodeId
        || ids.length > 32 || !ids.every(value => /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)))) {
        send(res,400,'{"error":"invalid-project-selection"}','application/json'); return
      }
      if (deps.projectMetadata === undefined) { send(res,503,'{"error":"node-content/unavailable"}','application/json'); return }
      await sendCompressed(req, res, 200, JSON.stringify({ items: await deps.projectMetadata.authorizedMetadata(user.id, adminView ? 'admin' : 'account', ids.map(Number)) }), 'application/json')
      return
    }
    if (pathname === '/account/api/workbench/rows' && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store')
      if (handlers.workbenchRows === undefined) { send(res, 503, '{"error":"workbench-rows-unavailable"}', 'application/json'); return }
      const owner = (await selectedContext()).context
      const draftStore=handlers.nodeDrafts,identity=deps.nodeServiceIdentity,environment=owner.environment
      const reservedSession=draftStore?.reservedSessionAuthenticated&&identity&&environment
        ? (sessionId:string)=>draftStore.reservedSessionAuthenticated!({organizationId:identity.organizationId,
          nodeId:environment.nodeId,userId:user.id,runtimeId:environment.id,
          target:owner.scope.kind==='personal'?'personal':`project:${owner.scope.projectId}`,sessionId},createHash('sha256').update(token).digest())
        : undefined
      const page = selection.has('documentSession')
        ? await checkDocumentAttachmentTarget(handlers.workbenchRows,owner,selection,undefined,reservedSession)
        : await handlers.workbenchRows(owner,selection)
      res.setHeader('x-dsh-runtime-id', page.runtimeId)
      await sendCompressed(req, res, 200, JSON.stringify(page), 'application/json')
      return
    }

    if (pathname === '/account/api/workbench/catalog' && req.method === 'GET') {
      const placement = await runtimeRouter.placement(user, { runtimeId: selection.get('dshRuntime'), target: selection.get('dshTarget'),
        scopeCookie: parseCookies(req.headers.cookie).get(SCOPE_COOKIE) })
      let environment: GatewayRequestContext['environment']
      let activeRuntime: { kind: 'personal' } | { kind: 'project'; projectId: number }
      if (placement.environment === undefined) {
        const resolved = await selectedContext()
        environment = resolved.context.environment
        activeRuntime = resolved.context.scope.kind === 'personal'
          ? { kind: 'personal' } : { kind: 'project', projectId: resolved.context.scope.projectId }
      } else {
        const selected = placement.environment
        environment = { id: selected.id, nodeId: selected.node.id, nodeName: selected.node.name }
        activeRuntime = selected.owner.kind === 'personal'
          ? { kind: 'personal' } : { kind: 'project', projectId: selected.owner.id }
        if (placement.resetScope) res.setHeader('set-cookie', scopeCookie('personal', cfg))
      }
      if (deps.collaboration?.listAccountConversations === undefined) {
        send(res, 501, JSON.stringify({ error: 'workbench-catalog-unsupported' }), 'application/json')
        return
      }
      res.setHeader('cache-control', 'no-store')
      const abort = requestAbort(req, res)
      const catalogAbort = new AbortController()
      const catalogSignal = AbortSignal.any([abort.signal, catalogAbort.signal])
      let scopes: Awaited<ReturnType<NonNullable<typeof deps.collaboration>['projectsForUser']>>
      let catalog: Awaited<ReturnType<GatewayWorkbenchCatalogHandler>>
      try {
        [scopes, catalog] = await Promise.all([
          deps.collaboration.projectsForUser(user.id),
          handlers.workbenchCatalog === undefined
            ? Promise.resolve(deps.collaboration.listAccountConversations(user.id)).then(items => ({ items, personalComplete: false }))
            : handlers.workbenchCatalog(user, catalogSignal, { kind: activeRuntime.kind,
              ...(environment === undefined ? {} : { runtimeId: environment.id }) }),
        ])
      } finally {
        catalogAbort.abort()
        abort.dispose()
      }
      await sendCompressed(req, res, 200, JSON.stringify({
        personal: { id: user.id, name: user.displayName || user.username },
        activeRuntime: { ...activeRuntime, ...(environment === undefined ? {} : {
          runtimeId: environment.id, nodeId: environment.nodeId,
          ...(environment.nodeName === undefined ? {} : { nodeName: environment.nodeName }),
        }) },
        ...(environment === undefined ? {} : { environment }),
        projects: scopes,
        items: catalog.items,
        personalComplete: catalog.personalComplete,
        ...(catalog.personalWorkspaces === undefined ? {} : { personalWorkspaces: catalog.personalWorkspaces }),
      }), 'application/json')
      return
    }

    if (pathname === '/account/api/preferences') {
      if (deps.userPreferences === undefined) {
        // Older/embedded hosts do not own account storage. A 501 lets the
        // browser scope intentionally fall back to the Host settings file;
        // 503 is reserved for a configured service that is temporarily down.
        send(res, 501, JSON.stringify({ error: 'account-preferences-unsupported' }), 'application/json')
        return
      }
      try {
        if (req.method === 'GET') {
          const value = await deps.userPreferences.describe(user)
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        if (req.method === 'PATCH') {
          const mutation = normalizeAccountPreferenceMutation(jsonObject(await readBody(req)))
          const value = await deps.userPreferences.mutate(user, mutation)
          await audit.write({
            userId: user.id,
            action: 'account-preference.updated',
            detail: JSON.stringify({ namespace: mutation.namespace, field: mutation.field, operation: mutation.operation }),
            ip: clientIp(req),
          })
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
      } catch (error: unknown) {
        if (error instanceof AccountPreferencesConflictError) {
          send(res, 409, JSON.stringify({ error: error.code, expected: error.expected, actual: error.actual }), 'application/json')
          return
        }
        if (error instanceof AccountPreferencesInputError) {
          send(res, 400, JSON.stringify({ error: error.code, message: error.message }), 'application/json')
          return
        }
        if (error instanceof AccountPreferencesUnavailableError) {
          console.error('[gateway] account preferences unavailable:', error)
          res.setHeader('cache-control', 'no-store')
          send(res, 503, JSON.stringify({ error: error.code, message: error.message }), 'application/json')
          return
        }
        throw error
      }
      return
    }

    const projectConfiguration = /^\/account\/api\/projects\/(\d+)\/configuration$/.exec(pathname)
    if (projectConfiguration !== null) {
      res.setHeader('cache-control', 'no-store')
      const projectId = Number(projectConfiguration[1])
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        send(res, 400, JSON.stringify({ error: 'invalid-project-id' }), 'application/json')
        return
      }
      if (deps.collaboration === undefined) {
        send(res, 503, JSON.stringify({ error: 'project-configuration-unavailable' }), 'application/json')
        return
      }
      const authority = await deps.collaboration.projectForUser(projectId, user.id)
      if (authority === null) {
        send(res, 403, JSON.stringify({ error: 'not-member' }), 'application/json')
        return
      }
      const selectedNodeId = authority.nodeId
      const project = await deps.projects.getById(projectId)
      if (project === null) {
        send(res, 404, JSON.stringify({ error: 'project-not-found' }), 'application/json')
        return
      }
      const metadataNodeId = project.nodeId
      const canManage = authority.canManage
      const capabilities = (managed: boolean, kind: ProjectKind | undefined): ProjectConfigurationView['capabilities'] => ({
        themePolicy: deps.projects.setThemePolicy !== undefined && managed,
        runtimeSettings: managed,
        projectModels: managed && deps.governance?.describeProjectModelSettings !== undefined
          && deps.governance.mutateProjectModelSettings !== undefined,
        members: managed && kind !== 'steward',
        sshTargets: managed && deps.sshTargets?.listForProject !== undefined,
        filesystem: false,
      })
      try {
        if (req.method === 'GET') {
          if (deps.collaboration.projectReadAuthorities === undefined) {
            send(res, 501, '{"error":"project-read-authority-unavailable"}', 'application/json'); return
          }
          const current = (await readPublicationAuthority('project', () => deps.collaboration!.projectReadAuthorities!(user.id, projectId)))
            .find(current => current.nodeId === selectedNodeId
              && (metadataNodeId === undefined || current.nodeId === metadataNodeId))
          if (current === undefined) throw new CollaborationDeniedError('forbidden')
          const value: ProjectConfigurationView = {
            project: {
              id: project.id,
              name: project.name,
              ...(project.origin === undefined ? {} : { origin: project.origin }),
              owner: current.owner,
              themePolicy: current.uiThemePolicy,
            },
            canManage: current.canManage,
            capabilities: capabilities(current.canManage, current.kind),
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        if (req.method === 'PATCH') {
          if (!canManage) {
            send(res, 403, JSON.stringify({ error: 'forbidden' }), 'application/json')
            return
          }
          if (deps.projects.setThemePolicy === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-configuration-unsupported' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          const policy = input?.themePolicy
          if (policy !== 'follow-user' && policy !== 'light' && policy !== 'dark') {
            send(res, 400, JSON.stringify({ error: 'invalid-project-theme-policy' }), 'application/json')
            return
          }
          await deps.projects.setThemePolicy(projectId, policy as ProjectThemePolicy, user.id)
          await audit.write({
            userId: user.id,
            action: 'projects.configuration.theme-policy',
            detail: JSON.stringify({ projectId, themePolicy: policy }),
            ip: clientIp(req),
          })
          const next = await deps.projects.getById(projectId)
          if (next === null) throw new Error('project disappeared after configuration update')
          const value: ProjectConfigurationView = {
            project: {
              id: next.id,
              name: next.name,
              ...(next.origin === undefined ? {} : { origin: next.origin }),
              ...(next.owner === undefined ? {} : { owner: next.owner }),
              themePolicy: next.uiThemePolicy ?? policy as ProjectThemePolicy,
            },
            canManage,
            capabilities: capabilities(canManage, next.kind),
          }
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify(value))
          return
        }
        send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
      } catch (error: unknown) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    // Self-service SSH target sharing: project managers list the organization
    // catalog with this project's share flags and toggle shares without an
    // administrator round-trip. Authority is revalidated inside the service's
    // transaction, so the route's role is transport plus audit.
    const projectSshTargets = /^\/account\/api\/projects\/(\d+)\/ssh-targets$/.exec(pathname)
    if (projectSshTargets !== null) {
      res.setHeader('cache-control', 'no-store')
      const projectId = Number(projectSshTargets[1])
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        send(res, 400, JSON.stringify({ error: 'invalid-project-id' }), 'application/json')
        return
      }
      if (deps.sshTargets === undefined || deps.sshTargets.listForProject === undefined) {
        send(res, 503, JSON.stringify({ error: 'ssh-targets-unavailable' }), 'application/json')
        return
      }
      try {
        if (req.method === 'GET') {
          const targets = await deps.sshTargets.listForProject(user.id, projectId)
          await sendCompressed(req, res, 200, JSON.stringify({ targets }), 'application/json')
          return
        }
        if (req.method === 'POST') {
          const input = jsonObject(await readBody(req))
          const target = await deps.sshTargets.share(user.id, {
            targetId: input?.targetId, projectId, shared: input?.shared,
          })
          await audit.write({
            userId: user.id,
            action: 'projects.ssh-targets.share',
            detail: JSON.stringify({ projectId, targetId: input?.targetId, shared: input?.shared === true }),
            ip: clientIp(req),
          })
          send(res, 200, JSON.stringify({
            publicId: target.publicId, name: target.name,
            shared: target.sharedProjects.includes(projectId),
          }), 'application/json')
          return
        }
        send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
      } catch (error: unknown) {
        if (error instanceof SshTargetError) {
          send(res, error.status, JSON.stringify({ error: error.message }), 'application/json')
          return
        }
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    // Project Provider settings deliberately use a Gateway-owned API instead
    // of the runtime's local settings document. This keeps encrypted keys and
    // the shared policy projection authoritative across every member device.
    const projectModelSettings = /^\/account\/api\/projects\/(\d+)\/model-settings(?:\/(credentials|discover))?$/.exec(pathname)
    if (projectModelSettings !== null) {
      res.setHeader('cache-control', 'no-store')
      const projectId = Number(projectModelSettings[1])
      const suffix = projectModelSettings[2]
      if (!Number.isSafeInteger(projectId) || projectId <= 0) {
        send(res, 400, JSON.stringify({ error: 'invalid-project-model-settings-request' }), 'application/json')
        return
      }
      if (deps.collaboration === undefined) {
        send(res, 503, JSON.stringify({ error: 'project-model-settings-unavailable' }), 'application/json')
        return
      }
      if (deps.governance === undefined || deps.governance.authorizeProjectModelRead === undefined) {
        send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
        return
      }
      const authority = await deps.collaboration.projectForUser(projectId, user.id)
      if (authority === null) {
        send(res, 403, JSON.stringify({ error: 'not-member' }), 'application/json')
        return
      }
      const detail = await deps.projects.getById(projectId)
      if (detail === null) {
        send(res, 404, JSON.stringify({ error: 'project-not-found' }), 'application/json')
        return
      }
      const canManage = user.role === 'admin' || authority.administrator || detail.owner?.id === user.id
      try {
        if (suffix === 'discover') {
          if (deps.governance.discoverProjectModels === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
            return
          }
          if (req.method !== 'POST' || !canManage) {
            send(res, canManage ? 405 : 403, JSON.stringify({ error: canManage ? 'method-not-allowed' : 'forbidden' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          let models: Awaited<ReturnType<typeof deps.governance.discoverProjectModels>>
          try {
            models = await deps.governance.discoverProjectModels({
              projectId,
              actorUserId: user.id,
              ...stringField(input?.provider) === undefined ? {} : { provider: stringField(input?.provider) },
              ...stringField(input?.baseURL) === undefined ? {} : { baseURL: stringField(input?.baseURL) },
              ...stringField(input?.api) === undefined ? {} : { api: stringField(input?.api) },
              ...stringField(input?.apiKey) === undefined ? {} : { apiKey: stringField(input?.apiKey) },
              allowPrivateNetwork: user.role === 'admin',
            })
          } catch (error: unknown) {
            const withheld = user.role === 'admin' ? undefined : withheldDiscoveryError(error)
            if (withheld === undefined) throw error
            send(res, 400, JSON.stringify({ error: withheld }), 'application/json')
            return
          }
          if (!await deps.governance.authorizeProjectModelRead(projectId, user.id)) {
            throw new CollaborationDeniedError('forbidden')
          }
          await sendCompressed(req, res, 200, JSON.stringify({ models }), 'application/json')
          return
        }
        if (suffix === 'credentials') {
          if (req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://gateway').searchParams
            const refs = query.getAll('refs').flatMap(value => value.split(',')).map(value => value.trim()).filter(value => value !== '')
            if (deps.governance.describeProjectCredentials === undefined) {
              send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
              return
            }
            const described = await deps.governance.describeProjectCredentials(projectId, [...new Set(refs)])
            const currentCanManage = await deps.governance.authorizeProjectModelRead(projectId, user.id)
            send(res, 200, JSON.stringify({
              credentials: Object.fromEntries(Object.entries(described).map(([ref, value]) => [
                ref, { ...value, writable: currentCanManage && value.writable },
              ])),
            }), 'application/json')
            return
          }
          if (!canManage) {
            send(res, 403, JSON.stringify({ error: 'forbidden' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          const ref = stringField(input?.ref)
          if (ref === undefined) {
            send(res, 400, JSON.stringify({ error: 'ref-required' }), 'application/json')
            return
          }
          if (req.method === 'PUT') {
            const value = typeof input?.value === 'string' ? input.value : undefined
            if (deps.governance.setProjectCredential === undefined) {
              send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
              return
            }
            if (value === undefined || value.trim() === '') {
              send(res, 400, JSON.stringify({ error: 'credential-required' }), 'application/json')
              return
            }
            await deps.governance.setProjectCredential(projectId, ref, value, user.id)
            await applyProjectGovernanceBestEffort(deps, projectId)
            await audit.write({ userId: user.id, action: 'projects.model-credential.set', detail: JSON.stringify({ projectId, ref }), ip: clientIp(req) })
            res.writeHead(204); res.end()
            return
          }
          if (req.method === 'DELETE') {
            if (deps.governance.unsetProjectCredential === undefined) {
              send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
              return
            }
            await deps.governance.unsetProjectCredential(projectId, ref, user.id)
            await applyProjectGovernanceBestEffort(deps, projectId)
            await audit.write({ userId: user.id, action: 'projects.model-credential.unset', detail: JSON.stringify({ projectId, ref }), ip: clientIp(req) })
            res.writeHead(204); res.end()
            return
          }
          send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
          return
        }
        if (req.method === 'GET') {
          if (deps.governance.describeProjectModelSettings === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
            return
          }
          const view = await deps.governance.describeProjectModelSettings(projectId)
          const currentCanManage = await deps.governance.authorizeProjectModelRead(projectId, user.id)
          if (currentCanManage) {
            send(res, 200, JSON.stringify(view), 'application/json')
          } else {
            send(res, 200, JSON.stringify({
              ...view,
              writable: false,
              namespaces: view.namespaces.map(namespace => ({
                ...namespace, writable: false, writableReason: 'project' as const,
              })),
            }), 'application/json')
          }
          return
        }
        if (req.method === 'PUT' || req.method === 'PATCH') {
          if (!canManage) {
            send(res, 403, JSON.stringify({ error: 'forbidden' }), 'application/json')
            return
          }
          if (deps.governance.mutateProjectModelSettings === undefined) {
            send(res, 501, JSON.stringify({ error: 'project-model-settings-unsupported' }), 'application/json')
            return
          }
          const input = jsonObject(await readBody(req))
          const ops = projectSettingsOps(input?.ops)
          const expectedRevision = input?.expectedRevision
          if (ops === undefined || (expectedRevision !== undefined
            && (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
            send(res, 400, JSON.stringify({ error: 'invalid-project-model-settings' }), 'application/json')
            return
          }
          const view = await deps.governance.mutateProjectModelSettings(projectId, ops, expectedRevision as number | undefined, user.id)
          await applyProjectGovernanceBestEffort(deps, projectId)
          await audit.write({ userId: user.id, action: 'projects.model-settings.mutate', detail: JSON.stringify({ projectId, opCount: ops.length }), ip: clientIp(req) })
          send(res, 200, JSON.stringify(view), 'application/json')
          return
        }
        send(res, 405, JSON.stringify({ error: 'method-not-allowed' }), 'application/json')
      } catch (error: unknown) {
        if (error instanceof ProjectModelSettingsConflictError) {
          send(res, 409, JSON.stringify({ error: error.code, expected: error.expected, actual: error.actual }), 'application/json')
          return
        }
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    const documentOwnership = /^\/account\/api\/documents\/([^/]+)\/ownership$/.exec(pathname)
    if (documentOwnership !== null && req.method === 'POST') {
      if (deps.documents === undefined) { send(res, 503, '{"error":"document-catalog-unavailable"}', 'application/json'); return }
      let catalogId: string
      try { catalogId = decodeURIComponent(documentOwnership[1] ?? '') } catch { send(res, 400, '{"error":"invalid-document-id"}', 'application/json'); return }
      const input = jsonObject(await readBody(req))
      const ownerUserId = input?.ownerUserId
      if (!/^[0-9a-f-]{36}$/iu.test(catalogId) || typeof ownerUserId !== 'number'
        || !Number.isSafeInteger(ownerUserId) || ownerUserId <= 0) {
        send(res, 400, '{"error":"invalid-ownership-request"}', 'application/json'); return
      }
      try {
        await deps.documents.transferOwnership(user.id, catalogId, ownerUserId)
        await audit.write({ userId: user.id, action: 'documents.ownership-transfer', detail: JSON.stringify({ catalogId, ownerUserId }), ip: clientIp(req) })
        res.writeHead(204); res.end()
      } catch (error) {
        const status = error instanceof Error && 'status' in error && typeof (error as { status?: unknown }).status === 'number'
          ? (error as { status: number }).status : 400
        send(res, status, JSON.stringify({ error: error instanceof Error && 'code' in error ? (error as { code: string }).code : 'ownership-failed' }), 'application/json')
      }
      return
    }

    if (pathname === '/account/api/users' && req.method === 'GET') {
      const all = await users.list()
      const active = all.filter(u => u.status === 'active').map(u => ({
        id: u.id, username: u.username, displayName: u.displayName,
      }))
      await sendCompressed(req, res, 200, JSON.stringify(active), 'application/json')
      return
    }

    if (pathname === '/account/api/projects') {
      try {
        if (req.method === 'GET') {
          const collaboration = deps.collaboration
          if (collaboration === undefined) { send(res, 200, '[]', 'application/json'); return }
          if (collaboration.projectReadAuthorities === undefined) {
            send(res, 501, '{"error":"project-read-authority-unavailable"}', 'application/json'); return
          }
          const scopes = await collaboration.projectsForUser(user.id)
          const selectedNodes = new Map(scopes.map(scope => [scope.projectId, scope.nodeId]))
          const details = deps.projects.getByIds === undefined
            ? await Promise.all(scopes.map(scope => deps.projects.getById(scope.projectId)))
            : await deps.projects.getByIds(scopes.map(scope => scope.projectId), 'directory')
          const prepared = details.map(project => project === null ? null : { project, nodeId: project.nodeId })
          const authorities = await readPublicationAuthority('project', () => collaboration.projectReadAuthorities!(user.id))
          if (authorities.length === 0) {
            const fresh = await readPublicationAuthority('project', () => auth.validate(token))
            if (fresh === null || fresh.id !== user.id || fresh.mustChangePassword) throw new CollaborationDeniedError('forbidden')
          }
          const current = new Map(authorities.map(authority => [authority.projectId, authority]))
          await sendCompressed(req, res, 200, JSON.stringify(prepared.flatMap(item => {
            if (item === null) return []
            const { project, nodeId } = item
            const authority = current.get(project.id)
            return authority === undefined || authority.nodeId !== selectedNodes.get(project.id)
              || nodeId !== undefined && nodeId !== authority.nodeId ? [] : [{
              ...project,
              owner: authority.owner,
              uiThemePolicy: authority.uiThemePolicy,
              canManage: authority.canManage,
            }]
          })), 'application/json')
          return
        }
        if (req.method === 'POST') {
          const input = jsonObject(await readBody(req))
          const name = stringField(input?.name)
          if (name === undefined) { send(res, 400, '{"error":"name required"}', 'application/json'); return }
          if (deps.projects.createManaged === undefined) {
            send(res, 503, '{"error":"managed-projects-unavailable"}', 'application/json'); return
          }
          const project = await deps.projects.createManaged({ name, ownerUserId: user.id, actorUserId: user.id }, deps.projectNames?.forRequest(req,user))
          await audit.write({ userId: user.id, action: 'projects.create', detail: JSON.stringify({ id: project.id, origin: 'user' }), ip: clientIp(req) })
          send(res, 201, JSON.stringify(project), 'application/json')
          return
        }
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    if ((pathname === '/account/api/invitations' || pathname === '/account/api/invitations/count') && req.method === 'GET') {
      res.setHeader('cache-control', 'no-store')
      const count = pathname.endsWith('/count')
      if (count ? deps.projects.countPendingInvitations === undefined : deps.projects.listInvitations === undefined) {
        send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return
      }
      try {
        const prepared = await readPublicationAuthority('invitation', async () => count
          ? { kind: 'count' as const, pending: await deps.projects.countPendingInvitations!(user.id) }
          : { kind: 'list' as const, items: await deps.projects.listInvitations!(user.id) })
        const participant = (invitation: ProjectInvitation): boolean => invitation.invitee.id === user.id || invitation.inviter.id === user.id
        let authorities: ProjectReadAuthorityView[] = []
        if (prepared.kind === 'list' && prepared.items.some(invitation => !participant(invitation))) {
          if (deps.collaboration?.projectReadAuthorities === undefined) {
            send(res, 501, '{"error":"invitation-read-authority-unavailable"}', 'application/json'); return
          }
          authorities = await readPublicationAuthority('invitation', () => deps.collaboration!.projectReadAuthorities!(user.id))
        }
        const current = await readPublicationAuthority('invitation', () => auth.validate(token))
        if (current === null || current.id !== user.id || current.mustChangePassword) throw new CollaborationDeniedError('forbidden')
        const managed = new Set(authorities.filter(authority => authority.canManage
          && (!authority.administrator || current.role === 'admin' || authority.owner?.id === user.id)).map(authority => authority.projectId))
        send(res, 200, JSON.stringify(prepared.kind === 'count' ? { pending: prepared.pending }
          : prepared.items.filter(invitation => participant(invitation) || managed.has(invitation.projectId))), 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    const invitationAccept = pathname.match(/^\/account\/api\/invitations\/([^/]+)\/accept$/)
    if (invitationAccept !== null && req.method === 'POST') {
      if (deps.projects.acceptInvitation === undefined) {
        send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return
      }
      try {
        await deps.projects.acceptInvitation(decodeURIComponent(invitationAccept[1] ?? ''), user.id)
        await audit.write({ userId: user.id, action: 'projects.invitation.accept', ip: clientIp(req) })
        res.writeHead(204); res.end()
      } catch (error) {
        if (error instanceof URIError) {
          send(res, 400, JSON.stringify({ error: 'invalid-invitation-id' }), 'application/json')
          return
        }
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    const accountProjectPath = pathname.match(/^\/account\/api\/projects\/(\d+)(?:\/(invitations|invitable-users))?$/)
    if (accountProjectPath !== null) {
      const projectId = Number(accountProjectPath[1])
      const isInvitationPath = accountProjectPath[2] === 'invitations'
      try {
        const project = await deps.projects.getById(projectId)
        if (project === null) { send(res, 404, '{"error":"project-not-found"}', 'application/json'); return }
        const metadataNodeId = project.nodeId
        const authority = await deps.collaboration?.projectForUser(projectId, user.id)
        if (authority === null || authority === undefined) { send(res, 403, '{"error":"not-member"}', 'application/json'); return }
        const selectedNodeId = metadataNodeId ?? authority.nodeId
        const canManage = authority.canManage
        if (accountProjectPath[2] === 'invitable-users') {
          if (req.method !== 'GET') { send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return }
          if (!canManage) { send(res, 403, '{"error":"forbidden"}', 'application/json'); return }
          if (deps.projects.listInvitableUsers === undefined) { send(res, 503, '{"error":"users-unavailable"}', 'application/json'); return }
          const cursor = selection.get('cursor')
          if (cursor !== null && !/^[1-9][0-9]*$/u.test(cursor)) { send(res, 400, '{"error":"invalid-user-cursor"}', 'application/json'); return }
          await sendCompressed(req, res, 200, JSON.stringify(await deps.projects.listInvitableUsers(projectId, user.id,
            cursor === null ? undefined : Number(cursor))), 'application/json'); return
        }
        if (isInvitationPath) {
          if (req.method === 'GET') {
            if (deps.projects.listInvitations === undefined) { send(res, 503, '{"error":"invitations-unavailable"}', 'application/json'); return }
            const invitations = await deps.projects.listInvitations(user.id, projectId)
            if (deps.collaboration?.projectReadAuthorities === undefined) {
              send(res, 501, '{"error":"project-read-authority-unavailable"}', 'application/json'); return
            }
            const current = (await readPublicationAuthority('project', () => deps.collaboration!.projectReadAuthorities!(user.id, projectId)))
              .find(current => current.nodeId === selectedNodeId)
            if (current === undefined) throw new CollaborationDeniedError('forbidden')
            await sendCompressed(req, res, 200, JSON.stringify(current.canManage ? invitations : invitations.filter(invitation =>
              invitation.invitee.id === user.id || invitation.inviter.id === user.id)), 'application/json'); return
          }
          if (req.method === 'POST') {
            if (!canManage || deps.projects.createInvitation === undefined) { send(res, 403, '{"error":"forbidden"}', 'application/json'); return }
            const input = jsonObject(await readBody(req))
            const username = stringField(input?.username)
            const mode = input?.mode === 'ro' || input?.mode === 'rw' ? input.mode : undefined
            if (username === undefined || mode === undefined) { send(res, 400, '{"error":"username and mode required"}', 'application/json'); return }
            const invitee = await users.getByUsername(username)
            if (invitee === null) { send(res, 404, '{"error":"user-not-found"}', 'application/json'); return }
            if (invitee.id === user.id) { send(res, 400, '{"error":"cannot-invite-self"}', 'application/json'); return }
            const invitation = await deps.projects.createInvitation({ projectId, inviteeUserId: invitee.id, inviterUserId: user.id, mode })
            await audit.write({ userId: user.id, action: 'projects.invitation.create', detail: JSON.stringify({ projectId, inviteeUserId: invitee.id, mode }), ip: clientIp(req) })
            send(res, 201, JSON.stringify(invitation), 'application/json'); return
          }
          send(res, 405, '{"error":"method-not-allowed"}', 'application/json'); return
        }
        if (req.method === 'GET') {
          if (deps.collaboration?.projectReadAuthorities === undefined) {
            send(res, 501, '{"error":"project-read-authority-unavailable"}', 'application/json'); return
          }
          const current = (await readPublicationAuthority('project', () => deps.collaboration!.projectReadAuthorities!(user.id, projectId)))
            .find(current => current.nodeId === selectedNodeId)
          if (current === undefined) throw new CollaborationDeniedError('forbidden')
          await sendCompressed(req, res, 200, JSON.stringify({ ...project,
            owner: current.owner,
            uiThemePolicy: current.uiThemePolicy, canManage: current.canManage,
          }), 'application/json'); return
        }
        if (req.method === 'PATCH') {
          if (!canManage) { send(res, 403, '{"error":"forbidden"}', 'application/json'); return }
          const name = stringField(jsonObject(await readBody(req))?.name)
          if (name === undefined) { send(res, 400, '{"error":"name required"}', 'application/json'); return }
          await deps.projects.rename(projectId, name, user.id, deps.projectNames?.forRequest(req,user))
          await audit.write({ userId: user.id, action: 'projects.rename', detail: JSON.stringify({ projectId }), ip: clientIp(req) })
          res.writeHead(204); res.end(); return
        }
        send(res, 405, '{"error":"method-not-allowed"}', 'application/json')
      } catch (error) {
        const mapped = accountProjectError(error)
        send(res, mapped.status, JSON.stringify({ error: mapped.error }), 'application/json')
      }
      return
    }

    if (pathname === '/account/api/conversations' && req.method === 'GET') {
      const resolved = await selectedContext()
      if (resolved.context.scope.kind !== 'project' || deps.collaboration === undefined) {
        send(res, 400, '{"error":"project-scope-required"}', 'application/json')
        return
      }
      await sendCompressed(req, res, 200, JSON.stringify({
        items: await deps.collaboration.listConversations(user.id, conversationRuntime(resolved.context), resolved.context.scope.projectId),
      }), 'application/json')
      return
    }

    if (pathname === '/account/api/activity' && req.method === 'GET') {
      const resolved = await selectedContext()
      if (resolved.context.scope.kind !== 'project' || deps.collaboration === undefined) {
        send(res, 400, '{"error":"project-scope-required"}', 'application/json')
        return
      }
      const params = new URL(req.url ?? '/', 'http://x').searchParams
      const limitValue = params.get('limit')
      const limit = limitValue === null ? 50 : Number(limitValue)
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        send(res, 400, '{"error":"invalid-limit"}', 'application/json')
        return
      }
      const before = params.get('before') ?? undefined
      const memberValue = params.get('member')
      const member = memberValue === null ? undefined : Number(memberValue)
      if (member !== undefined && (!Number.isSafeInteger(member) || member <= 0 || String(member) !== memberValue || params.getAll('member').length !== 1)) {
        send(res, 400, '{"error":"invalid-member"}', 'application/json')
        return
      }
      try {
        await sendCompressed(req, res, 200, JSON.stringify(await deps.collaboration.listActivity(
          user.id, conversationRuntime(resolved.context), resolved.context.scope.projectId, { limit, before, member })), 'application/json')
      } catch (error) {
        if (error instanceof CollaborationDeniedError) {
          send(res, error.code === 'not-member' ? 403 : 404, JSON.stringify({ error: error.code }), 'application/json')
          return
        }
        throw error
      }
      return
    }

    if (pathname === '/account/api/progress' && req.method === 'GET') {
      const resolved = await selectedContext()
      if (resolved.context.scope.kind !== 'project' || deps.progress === undefined) {
        send(res, 400, '{"error":"project-scope-required"}', 'application/json')
        return
      }
      try {
        await sendCompressed(req, res, 200, JSON.stringify(await deps.progress.progressForUser(
          resolved.context.scope.projectId, user.id)), 'application/json')
      } catch (error) {
        if (error instanceof CollaborationDeniedError) {
          send(res, error.code === 'not-member' ? 403 : 404, JSON.stringify({ error: error.code }), 'application/json')
          return
        }
        throw error
      }
      return
    }

    if (pathname === '/account/api/progress/generate' && req.method === 'POST') {
      const resolved = await selectedContext()
      if (resolved.context.scope.kind !== 'project' || deps.progress === undefined) {
        send(res, 400, '{"error":"project-scope-required"}', 'application/json')
        return
      }
      try {
        await sendCompressed(req, res, 200, JSON.stringify(await deps.progress.generateNow(
          resolved.context.scope.projectId, user.id)), 'application/json')
      } catch (error) {
        if (error instanceof CollaborationDeniedError) {
          send(res, error.code === 'not-member' ? 403 : 404, JSON.stringify({ error: error.code }), 'application/json')
          return
        }
        throw error
      }
      return
    }

    const conversationRoute = pathname.match(/^\/account\/api\/conversations\/([^/]+)$/)
    if (conversationRoute !== null && deps.collaboration !== undefined) {
      try {
        const resolved = await selectedContext()
        if (resolved.context.scope.kind !== 'project') throw new CollaborationDeniedError('conversation-not-found')
        const runtimeId = conversationRuntime(resolved.context)
        const sessionId = decodeURIComponent(conversationRoute[1] ?? '')
        const projectValue = new URL(req.url ?? '/', 'http://x').searchParams.get('projectId')
        const requestedProject = projectValue === null ? undefined : Number(projectValue)
        if (requestedProject !== undefined && (!Number.isSafeInteger(requestedProject) || requestedProject <= 0 || String(requestedProject) !== projectValue)) {
          send(res, 400, '{"error":"invalid-project-id"}', 'application/json'); return
        }
        if (req.method === 'GET') {
          const access = await deps.collaboration.access(user.id, runtimeId, sessionId, 'read')
          if (access.projectId !== resolved.context.scope.projectId || (requestedProject !== undefined && access.projectId !== requestedProject)) {
            send(res, 404, '{"error":"conversation-not-found"}', 'application/json'); return
          }
          const items = await deps.collaboration.listConversations(user.id, runtimeId, access.projectId)
          await sendCompressed(req, res, 200, JSON.stringify({ access, conversation: items.find(item => item.sessionId === access.rootSessionId) ?? null }), 'application/json')
          return
        }
        if (req.method === 'PATCH') {
          const body = JSON.parse(await readBody(req)) as { visibility?: unknown }
          if (body.visibility !== 'project' && body.visibility !== 'private') {
            send(res, 400, '{"error":"invalid-visibility"}', 'application/json')
            return
          }
          const access = await deps.collaboration.access(user.id, runtimeId, sessionId, 'read')
          if (access.projectId !== resolved.context.scope.projectId || (requestedProject !== undefined && access.projectId !== requestedProject)) {
            send(res, 404, '{"error":"conversation-not-found"}', 'application/json'); return
          }
          await deps.collaboration.setVisibility(user.id, runtimeId, sessionId, body.visibility)
          handlers.invalidateAccess?.({ projectId: access.projectId })
          await audit.write({ userId: user.id, action: 'conversation.visibility',
            detail: JSON.stringify({ sessionId, visibility: body.visibility, projectId: access.projectId }),
            ip: clientIp(req) })
          res.writeHead(204)
          res.end()
          return
        }
      } catch (error) {
        if (error instanceof CollaborationDeniedError) {
          const status = error.code === 'conversation-not-found' ? 404
            : error.code === 'visibility-locked' ? 409 : 403
          send(res, status, JSON.stringify({ error: error.code }), 'application/json')
          return
        }
        if (error instanceof SyntaxError) {
          send(res, 400, '{"error":"invalid-json"}', 'application/json')
          return
        }
        if (error instanceof URIError) {
          send(res, 400, '{"error":"invalid-session-id"}', 'application/json')
          return
        }
        throw error
      }
    }

    if (isAdminPath(pathname)) {
      if (user.role !== 'admin') { sendAdminGate(res, pathname, 'forbidden'); return }
      if (pathname.startsWith('/admin/api/peer-backups')) {
        if (handlers.peerBackups !== undefined && await handlers.peerBackups.admin(req, res, user.id)) return
        req.resume()
        send(res, 404, '{"error":"peer-backup/not-found"}', 'application/json')
        return
      }
      const projectSettingsRedirect = /^\/admin\/projects\/(\d+)\/settings$/.exec(pathname)
      if (projectSettingsRedirect !== null && req.method === 'GET') {
        const projectId = Number(projectSettingsRedirect[1])
        const placement = Number.isSafeInteger(projectId) && projectId > 0
          ? await runtimeRouter.placement(user, { target: `project:${projectId}`, runtimeId: selection.get('dshRuntime'), scopeCookie: undefined }) : undefined
        if (placement !== undefined && !placement.local) {
          if (placement.environment === undefined || deps.nodeServiceProxy === undefined) throw new RuntimeCatalogError(503, 'runtime-catalog/remote-unavailable')
          if (!await deps.nodeServiceProxy.http(req, res, user, { body: '', runtimeId: placement.environment.id })) throw new RuntimeCatalogError(503, 'runtime-catalog/remote-unavailable')
          return
        }
        const project = Number.isSafeInteger(projectId) && projectId > 0
          ? await deps.projects.getById(projectId)
          : null
        if (project === null) {
          send(res, 404, 'not found', 'text/plain')
          return
        }
        await deps.instances.ensureRunning({ kind: 'project', id: project.id, name: project.name, path: project.path, steward: project.kind === 'steward',
          ...(placement?.environment === undefined ? {} : { runtimeId: placement.environment.id }) }, 'passive', user.id)
        if (placement?.environment === undefined) redirect(res, '/', [scopeCookie(`project:${project.id}`, cfg)])
        else redirect(res, `/?dshRuntime=${encodeURIComponent(placement.environment.id)}`)
        return
      }
      const body = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req)
      if (handlers.admin !== undefined && await handlers.admin(req, res, user, pathname, body)) return
      if (serveAdmin(req, res, pathname, handlers.adminRoot)) return
      send(res, 404, 'not found', 'text/plain')
      return
    }

    if (handlers.proxy !== undefined) { await handlers.proxy(req, res, (await selectedContext()).context); return }
    send(res, 503, '{"error":"proxy-not-configured"}', 'application/json')
  }

  server.on('upgrade', (req, socket, head) => {
    forgetUnclaimedBridge(req.socket)
    const settlePerformance = performanceObserver.beginRequest('websocket')
    let upgradeStatus = 400
    socket.once('close', (hadError: boolean) => { settlePerformance(upgradeStatus, hadError) })
    // The handler owns this socket until a channel or proxy adopts it, and the
    // authorization window awaits a database round-trip: a peer reset in that
    // window would otherwise reach 'error' with no listener and take down the
    // process. The 'close' listener above still records the failed upgrade.
    socket.on('error', () => {})
    const finish = async (): Promise<void> => {
      const requestUrl = new URL(req.url ?? '/', 'http://gateway')
      const { pathname } = requestUrl
      if ((await recoveryAdmission())?.state === 'review') {
        upgradeStatus = 503
        const body = '{"error":"governance-recovery-required"}'
        socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        return
      }
      if (pathname === NODE_CHANNEL_PATH) {
        if (deps.nodeChannels === undefined) throw new NodeChannelError(503, 'node-channel/unavailable')
        await deps.nodeChannels.accept(req, socket, head)
        upgradeStatus = 101
        return
      }
      if (pathname.startsWith(NODE_SERVICE_STREAM_PATH)) {
        if (deps.nodeServices === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
        await deps.nodeServices.accept(req, socket, head)
        upgradeStatus = 101
        return
      }
      const requestedNode = req.headers[NODE_SERVICE_TARGET_HEADER]
      if (requestedNode !== undefined && requestedNode !== deps.nodeServiceIdentity?.nodeId) throw new NodeServiceError(409, 'node-service/mismatch')
      const origin = req.headers.origin
      if (origin !== undefined && !cfg.publicOrigins.includes(origin)) { upgradeStatus = 403; socket.destroy(); return }
      if (handlers.upgrade === undefined || !pathname.startsWith('/api')) { socket.destroy(); return }
      const nodeId = deps.nodeServiceIdentity?.nodeId
      const event = pathname === '/api/events.mux' || pathname === '/api/events.host'
      const selection = event ? exactSessionSelectors(requestUrl.searchParams) : undefined
      const nodes = requestUrl.searchParams.getAll('dshNode')
      const exactEvent = nodeId !== undefined && selection?.target === 'personal' && nodes.length <= 1
        && (nodes[0] === undefined || nodes[0] === nodeId) ? { runtimeId: selection.runtimeId, nodeId, target: 'personal' as const } : undefined
      const candidate = exactEvent === undefined || handlers.readyEvent === undefined
        ? undefined : signedPersonalForward(req, pathname, exactEvent)
      if (candidate !== undefined && exactEvent !== undefined) {
        upgradeStatus = 101
        if (await handlers.readyEvent?.(req, socket, head, { ...exactEvent, ...candidate, actor: candidate.forwarded.claims.user })) return
        if (socket.destroyed) return
      }
      const session = await currentUser(req)
      if (session === null || session.user.mustChangePassword) { upgradeStatus = 401; socket.destroy(); return }
      if (!browserPrincipalMatches(req, session.user)) {
        upgradeStatus = 409
        const body = JSON.stringify({ error: 'account-changed' })
        socket.end(`HTTP/1.1 409 Conflict\r\nConnection: close\r\nx-dsh-principal-id: ${session.user.id}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        return
      }
      const readyEvent = candidate === undefined && exactEvent !== undefined
        && (session.forward === undefined || forwardedSessionMatches(session.forward, exactEvent))
        ? { ...exactEvent, entryNodeId: session.forward?.issuerNode,
            actor: session.user, sessionToken: session.token } : undefined
      upgradeStatus = 101
      if (readyEvent !== undefined && await handlers.readyEvent?.(req, socket, head, readyEvent)) return
      if (socket.destroyed) return
      if (deps.nodeServiceProxy !== undefined && await deps.nodeServiceProxy.upgrade(req, socket, head, session.user)) return
      const resolved = await requestContext(req, session.user, undefined, session.forward)
      await handlers.upgrade(req, socket, head, resolved.context)
    }
    void finish().catch((error: unknown) => {
      if (error instanceof GovernanceAdmissionUnavailableError) {
        upgradeStatus = 503
        const body = '{"error":"peer-backup/governance-admission-unavailable"}'
        if (!socket.destroyed) socket.end(`HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
        console.error('[gateway] governance recovery admission failed:', error)
      } else if (error instanceof RuntimeCatalogError || error instanceof InvalidRuntimeTargetError || error instanceof CollaborationDeniedError
        || error instanceof NodeChannelError || error instanceof NodeAccessError || error instanceof NodeServiceError || error instanceof ComputerAccessError || error instanceof DeploymentTopologyError) {
        const status = error instanceof RuntimeCatalogError || error instanceof NodeChannelError || error instanceof NodeAccessError || error instanceof NodeServiceError || error instanceof ComputerAccessError || error instanceof DeploymentTopologyError
          ? error.status : error instanceof InvalidRuntimeTargetError ? 400 : 403
        const body = JSON.stringify({ error: error instanceof InvalidRuntimeTargetError ? error.message : error.code })
        upgradeStatus = status
        if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      } else { upgradeStatus = 503; socket.destroy() }
    })
  })

  return server
}
