import { GatewayNodeConnection } from './node-connection.ts'
import { PostgresDeploymentTopology } from './deployment-topology.ts'
import { createBrowserDocumentHandler } from './browser-documents.ts'
import { nodeConfigurationAuthority } from './postgres/node-configuration-authority.ts'
import { PostgresNodeAccessService } from './postgres/node-access-service.ts'
import { GatewayNodeChannels } from './node-channel.ts'
import { GatewayNodeServices } from './node-service.ts'
import { GatewayNodeServiceProxy } from './node-service-proxy.ts'
import { forwardIssuerOf, verifyGatewayForward } from './forwarded-principal.ts'
import { NodeResourceBudget } from './node-resource-budget.ts'
import { NodeResourcePressure } from './node-resource-pressure.ts'
import { GatewayModelBudget } from './gateway-model-budget.ts'
import { nodeControlPaths } from './node-control-paths.ts'
import { loadManagedNodeEnvironment, NodeConfigurationStore } from './node-config-store.ts'
import { DesktopAccess } from './desktop-access.ts'
import { MemoryAccess } from './memory-access.ts'
import { PluginAccess } from './plugin-access.ts'
import { PostgresPluginState } from './plugin-state.ts'
import { SshAccess } from './ssh-access.ts'
import { StewardAccess } from './steward-access.ts'
import { TerminalAccess } from './terminal-access.ts'
import { GatewayTunnelAccess } from './tunnel-access.ts'
import { PostgresTunnelAccessStore, TunnelCredentialCipher } from './postgres/tunnel-access-service.ts'
import { GatewayPluginManagement } from './plugin-management.ts'
import { GatewayTerminalManagement } from './terminal-management.ts'
import { randomBytes } from 'node:crypto'
import { DOCUMENT_STORE_UNAVAILABLE_CODE, UserDocError } from '@deepseek-ai/dsh-userdoc'
import { prepareStewardWorktree } from './steward-worktree.ts'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { createAdminApiHandler } from './admin-api.ts'
import { PostgresAccountPreferencesService } from './postgres/account-preferences-service.ts'
import { refreshModelGovernance, scheduleModelGovernanceRefresh } from './apply-model-governance.ts'
import { loadConfig } from './config.ts'
import { InstanceManager, RuntimeLeaseUnavailableError, RuntimeStartBlockedError } from './instances.ts'
import type { RuntimeSubject, RuntimeTarget } from './instances.ts'
import { selectLauncher } from './launcher.ts'
import { PostgresAuditService } from './postgres/audit-service.ts'
import { PostgresAuthService } from './postgres/auth-service.ts'
import { PostgresRuntimeCatalog } from './postgres/runtime-catalog.ts'
import { PostgresComputerAccess } from './computer-access.ts'
import { PostgresRuntimeManagement } from './runtime-management.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from './runtime-router.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import { PostgresCollaborationService } from './postgres/collaboration-service.ts'
import { PostgresProgressService } from './postgres/progress-service.ts'
import { PostgresProgressUsage } from './postgres/progress-usage.ts'
import {
  createPostgresPool,
  databaseUrlFromFile,
  errorCodeForDiagnostics,
  poolAdmissionSnapshot,
  runMigrations,
  withDatabaseStartupRetry,
} from './postgres/database.ts'
import { PostgresConversationStore } from './postgres/conversation-repository.ts'
import { DesktopCoordinator } from './desktop-coordinator.ts'
import { NodeArchiveRouter } from './node-archive-router.ts'
import { createArchiveRuntimeReader } from './archive-runtime-reader.ts'
import { PostgresDesktopCoordinatorRepository } from './postgres/desktop-coordinator-repository.ts'
import { PostgresInstanceRepository } from './postgres/instance-repository.ts'
import { PostgresModelGovernanceService } from './postgres/model-governance-service.ts'
import {
  loadOrganizationModelCredentialKey,
  OrganizationModelCredentialCipher,
} from './organization-model-credentials.ts'
import { PostgresProjectService } from './postgres/project-service.ts'
import { StewardQueryService } from './postgres/steward-query.ts'
import { checkPostgresReadiness, resolvePostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { PostgresSshTargetService } from './postgres/ssh-target-service.ts'
import { PostgresMaintenanceService, type WriteGateVerdict } from './postgres/maintenance-service.ts'
import { PostgresBackupService } from './postgres/backup-service.ts'
import { RemoteDesktopService } from './remote-desktop-service.ts'
import { remoteDesktopAdministration } from './postgres/remote-desktop-administration.ts'
import { createDeploymentCommands } from './deployment-commands.ts'
import { PostgresDeploymentBackups } from './postgres/deployment-backups.ts'
import { migrationPlan } from './postgres/database.ts'
import { PostgresUserService } from './postgres/user-service.ts'
import { PostgresWebhookDeliveryService } from './postgres/webhook-delivery-service.ts'
import { PostgresWebhookEndpointService, WebhookSecretCipher } from './postgres/webhook-endpoint-service.ts'
import { GatewayWebhookIntake } from './webhook-intake.ts'
import { loadPrincipalKeys, PRINCIPAL_HEADER } from './principal.ts'
import { createProxyHandlers } from './proxy.ts'
import { NodePrincipalDirectory } from './postgres/node-principal-directory.ts'
import { PostgresAccessMonitor, scopeAccessMonitor } from './access-invalidation.ts'
import { createPostgresPushService } from './push-notifications.ts'
import { createRuntimeApiHandler } from './runtime-api.ts'
import { readBootSignature, runtimeBootSignature, writeBootSignature } from './boot-signature.ts'
import { PrimaryProjectNames } from './primary-project-names.ts'
import { NodeContentDocuments } from './node-content-documents.ts'
import { NodeDocumentAuthority } from './node-content-documents-authority.ts'
import { NodeContentMigrationAdmin } from './node-content-migration-admin.ts'
import { NodeContentSourceRetirement } from './node-content-source-retirement.ts'
import { NodeContentPublication } from './node-content-publication.ts'
import { nodeCorePublicationChecks } from './node-content-core-publication.ts'
import { createNodePluginProofs } from './node-content-plugin-proofs.ts'
import { NativePeerProjectSnapshots } from './peer-native-project-snapshots.ts'
import { PeerPersonalFiles } from './peer-backup-personal-files.ts'
import { NodeProjectFiles } from './node-content-files.ts'
import { GatewayExecutionIdentity } from './execution-identity.ts'
import { NodeProjectMetadata } from './node-content-projects.ts'
import { NodeContentConnection } from './node-content-connection.ts'
import { PeerBackupRelay } from './peer-backup-relay.ts'
import { createPeerBackupGateway } from './peer-backup-gateway.ts'
import { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import { projectNodeDrafts } from './project-node-drafts.ts'
import { NodePrivateSqliteHost } from './node-private-sqlite-host.ts'
import { PersonalNodeIndex } from './personal-index.ts'
import { LocalNodeDrafts } from './node-drafts.ts'
import { workbenchRows } from './workbench-rows.ts'
import { createGatewayWorkbenchCatalogHandler } from './workbench.ts'
import { PostgresWorkspaceCatalog } from './workspace-catalog.ts'
import {
  createDocumentTransferCapabilitiesHandler,
  createDocumentTransferDirectoriesHandler,
  createDocumentTransferDirectoryCreateHandler,
  createDocumentTransferCommitHandler,
  createDocumentTransferPlanHandler,
  createDocumentTransferListHandler,
  createGatewayDocumentTransferListHandler,
  createGatewayDocumentTransferUploadHandler,
  createGatewayDocumentScopeHandler,
  createGatewayDocumentAdminHandler,
  createDocumentTransferHandler,
} from './document-transfer.ts'
import { createDocumentCatalogHandlers } from './document-catalog.ts'
import { LocalDocumentBroker } from './documents-local.ts'
import { PostgresDocumentCatalogService } from './postgres/document-catalog-service.ts'
import { PostgresDocumentLocations } from './postgres/document-locations.ts'
import { runtimeDirectoryGrants } from './runtime-directory-grants.ts'
import { createGatewayServer, scopeCookie, type GatewayDeps } from './server.ts'
import { ReleaseAssets } from './release-assets.ts'
import { GatewayPerformanceObserver } from './performance-observer.ts'
import { createUsageIntakeServer } from './usage-intake.ts'
import { removeBootstrapAdminPassword, writeBootstrapAdminPassword } from './bootstrap-admin.ts'
import type { GatewayModelGovernanceService } from './services.ts'


const effectiveEnvironment = await loadManagedNodeEnvironment(process.env)
/** Consumed nonces of accepted forwarded assertions: nonce → expiresAt. */
const forwardNonceLedger = new Map<string, number>()
const cfg = loadConfig(effectiveEnvironment)
if (cfg.releaseId !== undefined) console.log(`[gateway] release ${cfg.releaseId}`)
const databaseUrl = await databaseUrlFromFile(effectiveEnvironment)
const pool = createPostgresPool(databaseUrl, {
  max: cfg.databaseMaxConnections,
  min: cfg.databaseMinConnections,
  maxCheckoutQueue: cfg.databaseMaxCheckoutQueue,
  connectionTimeoutMillis: cfg.databaseConnectionTimeoutMs,
})
if (cfg.databaseMinConnections > 0) {
  void Promise.all(Array.from({ length: cfg.databaseMinConnections },
    async () => { (await pool.connect()).release() }))
    .catch((error: unknown) => { console.error('[gateway] PostgreSQL pool warm-up failed:', error) })
}
const startupAbort = new AbortController()
const onStartupSignal = (): void => { startupAbort.abort() }
process.once('SIGINT', onStartupSignal)
process.once('SIGTERM', onStartupSignal)
const context = await (async () => {
  try {
    return await withDatabaseStartupRetry(async () => {
      await runMigrations(pool, join(import.meta.dirname, '../deploy/postgres/migrations'))
      return resolvePostgresRuntimeContext(pool, cfg.organizationSlug, cfg.computeNodeName)
    }, {
      initialDelayMs: cfg.databaseStartupRetryInitialMs,
      maxDelayMs: cfg.databaseStartupRetryMaxMs,
      signal: startupAbort.signal,
      onRetry: (error, delayMs) => {
        console.error(
          `[gateway] PostgreSQL unavailable during startup (${errorCodeForDiagnostics(error)}); retrying in ${String(delayMs)}ms`,
        )
      },
    })
  } catch (error) {
    await pool.end().catch(() => { /* preserve the startup failure or signal outcome */ })
    if (startupAbort.signal.aborted) process.exit(0)
    // Do not rethrow into a supervisor restart loop: the release parks with a
    // degraded health surface so operators get one logged failure plus a
    // reachable diagnostic endpoint instead of unbounded respawns.
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`[gateway] startup failed permanently; parking with degraded health: ${reason}`)
    const { createServer } = await import('node:http')
    const degraded = createServer((_req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        ok: false,
        release: cfg.releaseId,
        configurationRevision: cfg.configurationRevision,
        startupFailed: true,
        detail: reason.slice(0, 300),
      }))
    })
    degraded.on('error', (listenError: unknown) => {
      console.error(`[gateway] degraded health listener failed: ${String(listenError)}`)
    })
    degraded.listen(cfg.port, '127.0.0.1', () => {
      console.error(`[gateway] degraded health listener on http://127.0.0.1:${String(cfg.port)}`)
    })
    // The startup signal handlers only abort the aborted startup attempt;
    // a parked process still answers termination requests.
    const leaveParked = (): void => process.exit(0)
    process.once('SIGINT', leaveParked)
    process.once('SIGTERM', leaveParked)
    // A referenced interval keeps the event loop alive even when the port
    // cannot be bound; a pending promise alone does not hold a process open.
    setInterval(() => {}, 3_600_000)
    // Never resolves: keeps the narrowed PostgresRuntimeContext type while
    // the process stays parked.
    return await new Promise<PostgresRuntimeContext>(() => { /* parked */ })
  } finally {
    process.removeListener('SIGINT', onStartupSignal)
    process.removeListener('SIGTERM', onStartupSignal)
  }
})()
const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
// Every cached dependency belongs to the data generation observed before loading it.
const baselineWriteEpoch = await maintenance.currentWriteEpoch()
async function assertCurrentDataEpoch(): Promise<void> {
  if (await maintenance.currentWriteEpoch() !== baselineWriteEpoch) {
    throw new Error('PostgreSQL write epoch advanced past this process; restart onto the restored snapshot')
  }
}
const auth = new PostgresAuthService(context, cfg)
const users = new PostgresUserService(context, cfg)
const userPreferences = new PostgresAccountPreferencesService(context, cfg)
const contentVolume = new NodeContentConnection(cfg, context)
const nodeProjects = new NodeProjectMetadata(context, contentVolume)
const nodeFiles = new NodeProjectFiles(cfg,context,contentVolume,createNodePluginProofs(effectiveEnvironment.HGW_NODE_PLUGIN_PROOFS_FILE,cfg.runtimeRequestTimeoutMs))
const executionIdentity = new GatewayExecutionIdentity(context.pool,context.nodeId,contentVolume)
const projects = new PostgresProjectService(context, cfg, context.nodeId, {metadata:nodeProjects,
  ...(cfg.nodeContent ? {requirePhysical:true,publication:()=>publication,ready:()=>contentVolume.ready()} : {})})
const audit = new PostgresAuditService(context)
const governance: GatewayModelGovernanceService = new PostgresModelGovernanceService(
  context,
  new OrganizationModelCredentialCipher(
    loadOrganizationModelCredentialKey(cfg.organizationModelCredentialKeyFile),
  ),
  cfg.usageTimeZone, contentVolume,
)
const collaboration = new PostgresCollaborationService(context, context.nodeId as RuntimeNodeId, contentVolume, nodeProjects)
const documentLocations = new PostgresDocumentLocations(context, cfg.runtimeCatalog, context.nodeId as import('./runtime-catalog.ts').RuntimeNodeId)
const personalDocumentGate=cfg.nodeContent?new PeerProjectFileGate(cfg.stateRoot,'personal-document-handoff'):undefined
const nodeDocuments:NodeContentDocuments = new NodeContentDocuments(new NodeDocumentAuthority(context,documentLocations,contentVolume),input=>localDocuments.inspectPublicationRoot(input),
  personalDocumentGate?{gate:personalDocumentGate,inspect:(user,maxRows,cursor)=>localDocuments.inspectPersonalHistory(user,maxRows,cursor)}:undefined)
const documentCatalog = new PostgresDocumentCatalogService(context, cfg.archiveRetentionDays, context.nodeId as RuntimeNodeId, nodeDocuments)
const documentCatalogHandlers = createDocumentCatalogHandlers(documentCatalog, audit)
const push = createPostgresPushService(context, cfg)
const principalKeys = loadPrincipalKeys(cfg.principalKeyDir, cfg.organizationSlug, cfg.principalAssertionTtlMs)
// Peer gateways verify forwarded-request assertions against this published key.
await pool.query('UPDATE harness.compute_nodes SET principal_public_key=$3 WHERE organization_id=$1 AND id=$2',
  [context.organizationId, context.nodeId, principalKeys.publicKeyPem])
const instanceRepository = new PostgresInstanceRepository(context, cfg.instancePortBase, nodeProjects, nodeFiles, cfg.runtimeTokenCacheMs)
const conversations = new PostgresConversationStore(pool, contentVolume)
// Launcher is local child-process (dev) unless HGW_LAUNCHER=systemd (Linux prod);
// the systemd options factory is only evaluated in the systemd case.
const launcher = selectLauncher(cfg, () => ({
  systemd: {
    usersRoot: cfg.usersRoot,
    projectRuntimesRoot: cfg.projectRuntimesRoot,
    projectPathRoots: cfg.projectPathRoots,
    execStart: cfg.dshCommand,
    gatewayDir: cfg.gatewayDir,
    inaccessiblePaths: [
      cfg.runtimeCredentialDir,
      cfg.principalKeyDir,
      cfg.organizationModelCredentialKeyFile,
      cfg.webhookSecretKeyFile,
      cfg.tunnelCredentialKeyFile,
      cfg.bootstrapAdminPasswordFile,
    ],
    memoryMax: cfg.memoryMax,
    cpuQuota: cfg.cpuQuota,
  },
  credentialDir: cfg.runtimeCredentialDir,
  unitDir: cfg.systemdUnitDir,
  commandTimeoutMs: cfg.systemdCommandTimeoutMs,
  grantsProvider: async (runtime) => {
    if (runtime.kind === 'project') return []
    const user = await users.getById(runtime.ownerId)
    if (user === null) return []
    return (await runtimeDirectoryGrants(user, projects)).map(({ path, mode }) => ({ path, mode }))
  },
}))
const resourceBudget = new NodeResourceBudget(pool, context.organizationId, context.nodeId, cfg.resourceBudget)
await resourceBudget.configure()
const gatewayModelBudget = await GatewayModelBudget.open(resourceBudget, join(nodeControlPaths(cfg.stateRoot).gatewayModels, context.nodeId))
const accessMonitor = new PostgresAccessMonitor(context, cfg.accessInvalidationPollMs)
const localAccessMonitor = scopeAccessMonitor(accessMonitor, context.nodeId as RuntimeNodeId)
const principalDirectory = new NodePrincipalDirectory(context, cfg.runtimeTokenCacheMs)
localAccessMonitor.subscribe(() => {
  instanceRepository.invalidateRuntimeTokenCache()
})
// Issuer-key entries are keyed by *foreign* nodes: a revocation on another
// node emits that node's id, which the scoped monitor would filter out.
accessMonitor.subscribe(() => {
  principalDirectory.invalidate()
})
const progress = new PostgresProgressService(context, { nodeContent: contentVolume, collaboration, governance, budget: gatewayModelBudget, accessMonitor: localAccessMonitor,
  usage: new PostgresProgressUsage(context, governance, cfg.progress.usageReplayBatchSize, assertCurrentDataEpoch, contentVolume),
  trackWrite: operation => trackWriter(operation), assertDataEpoch: assertCurrentDataEpoch,
  beforeDispatch: async () => {
    await assertCurrentDataEpoch()
    if (await maintenanceGate() !== 'open') throw new Error('Project progress is paused for maintenance')
  },
}, cfg.progress)
const instances = new InstanceManager(instanceRepository, cfg, launcher, {
  principalPublicKey: principalKeys.publicKeyPem,
}, resourceBudget, gatewayModelBudget)
const desktops = new DesktopCoordinator(new PostgresDesktopCoordinatorRepository(context), instances, cfg.desktop, audit)
await desktops.initialize()
const archives = new NodeArchiveRouter(context, cfg.archiveRetentionDays,contentVolume)
archives.setRuntimeReader(createArchiveRuntimeReader({ cfg, users, projects, instances, principals: principalKeys.signer,
  authorizeAdministrator: id => instanceRepository.authorizeAdministrator(id) }))

const nodeConfiguration = new NodeConfigurationStore(context, cfg, effectiveEnvironment, nodeConfigurationAuthority(context))
await nodeConfiguration.initialize()
const backups = new PostgresBackupService(context)
const deploymentCommands = createDeploymentCommands(cfg.pgDumpCommand, cfg.pgRestoreCommand, cfg.psqlCommand,
  { command: cfg.pgConnectionCommand, timeoutMs: cfg.pgConnectionTimeoutMs })

const MAINTENANCE_GATE_CACHE_MS = 300
let stoppingWriters = false
let gateCache: { at: number; verdict: WriteGateVerdict } | undefined
let observedMaintenanceEpoch = 0n
const refreshMaintenanceGate = async (): Promise<WriteGateVerdict> => {
  if (stoppingWriters) return 'maintenance'
  const gate = await maintenance.writeGate(baselineWriteEpoch)
  observedMaintenanceEpoch = gate.maintenanceEpoch
  gateCache = { at: Date.now(), verdict: gate.verdict }
  return gate.verdict
}
const maintenanceGate = async (): Promise<WriteGateVerdict> => {
  if (stoppingWriters) return 'maintenance'
  if (gateCache !== undefined && Date.now() - gateCache.at < MAINTENANCE_GATE_CACHE_MS) return gateCache.verdict
  return refreshMaintenanceGate()
}
// Mutating HTTP requests count from gate admission until their handler settles;
// periodic sweeps count for their whole run. Proxied /api requests are
// exempt: they mutate runtime-owned state, not the control plane a backup
// dumps, and client-held streams must never block quiesce. The heartbeat
// publishes the total so the applier's quiesce waits for work already past
// the gate, not just for new admissions to stop.
let writersInFlight = 0
const writerWaiters = new Set<() => void>()
const releaseWriter = (): void => {
  writersInFlight -= 1
  if (writersInFlight === 0) {
    for (const resolve of writerWaiters) resolve()
    writerWaiters.clear()
  }
}
const waitForWriters = (): Promise<void> => writersInFlight === 0
  ? Promise.resolve() : new Promise(resolve => { writerWaiters.add(resolve) })
const trackWriter = <T>(operation: () => Promise<T>): Promise<T> => {
  writersInFlight += 1
  return Promise.resolve()
    .then(operation)
    .finally(releaseWriter)
}
instances.startAdmission = operation => trackWriter(async () => {
  const verdict = await refreshMaintenanceGate()
  if (verdict !== 'open') throw new RuntimeStartBlockedError(verdict)
  return operation()
})
const writerSpan = (): (() => void) => {
  writersInFlight += 1
  return releaseWriter
}
const admitWriter = <T>(operation: () => Promise<T>): Promise<T> => trackWriter(async () => {
  const verdict = await refreshMaintenanceGate()
  if (verdict !== 'open') throw new RuntimeStartBlockedError(verdict)
  return operation()
})
governance.projectionWrite = admitWriter
let heartbeatInFlight: Promise<void> | undefined
let heartbeatVerdict: WriteGateVerdict | undefined
let onWritesReopened = (): void => {}
// The heartbeat acknowledges only the epoch the write gate has already
// enforced, so the applier never reads a quiesce this node has not applied.
const heartbeatTimer = setInterval(() => {
  if (heartbeatInFlight !== undefined) return
  heartbeatInFlight = (async () => {
    const previous = heartbeatVerdict
    const verdict = await refreshMaintenanceGate()
    await maintenance.heartbeat(observedMaintenanceEpoch, writersInFlight)
    heartbeatVerdict = verdict
    if (previous !== 'open' && verdict === 'open') onWritesReopened()
  })().catch((error: unknown) => {
    console.error('[gateway] maintenance heartbeat failed:', error)
  }).finally(() => { heartbeatInFlight = undefined })
}, cfg.nodeHeartbeatMs)
heartbeatTimer.unref()
const webhookDeliveries = new PostgresWebhookDeliveryService(context)
const webhookEndpoints = new PostgresWebhookEndpointService(context,
  new WebhookSecretCipher(loadOrganizationModelCredentialKey(cfg.webhookSecretKeyFile)))
const tunnelAccess = new GatewayTunnelAccess({
  store: new PostgresTunnelAccessStore(context),
  cipher: new TunnelCredentialCipher(loadOrganizationModelCredentialKey(cfg.tunnelCredentialKeyFile)),
  organizationId: context.organizationId,
  nodeId: context.nodeId,
  target: `http://127.0.0.1:${String(cfg.port)}`,
  stateDir: cfg.tunnelStateDir,
  startupTimeoutMs: cfg.tunnelStartupTimeoutMs,
  closeTimeoutMs: cfg.tunnelCloseTimeoutMs,
  probeIntervalMs: cfg.tunnelProbeIntervalMs,
  envBinaryPath: cfg.cloudflaredBin,
})
const pluginState = new PostgresPluginState(context, contentVolume, nodeFiles)
// Statements run on their own small pool: a session-state escape (deny-listed
// functions, advisory locks, listeners) can then never reach a connection the
// rest of the Gateway shares; journals still write through the main pool.
const stewardStatementPool = createPostgresPool(databaseUrl, {
  max: 4,
  maxCheckoutQueue: cfg.databaseMaxCheckoutQueue,
  connectionTimeoutMillis: cfg.databaseConnectionTimeoutMs,
  application_name: 'dsh-steward-query',
})
const stewardQuery = new StewardQueryService(context, cfg.steward.enabled, stewardStatementPool)
const performanceObserver = new GatewayPerformanceObserver({
  enabled: cfg.performanceEnabled,
  eventLoopResolutionMs: cfg.performanceEventLoopResolutionMs,
})
const runtimeCatalog = new PostgresRuntimeCatalog(context, cfg.runtimeCatalog, context.nodeId as import('./runtime-catalog.ts').RuntimeNodeId)
const nodeAccess = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
const nodeChannels = new GatewayNodeChannels(nodeAccess, cfg.nodeChannel)
const nodeServices = new GatewayNodeServices(nodeAccess, nodeChannels, cfg.nodeService, cfg.releaseId ?? null)
const computerAccess = new PostgresComputerAccess(context, cfg.runtimeCatalog, context.nodeId as import('./runtime-catalog.ts').RuntimeNodeId)
const topology = new PostgresDeploymentTopology(context, { legacyForwarding: cfg.nodeService.forwarding,
  refreshAfterMs: cfg.deploymentContextRefreshMs, pageSize: cfg.runtimeCatalog.pageSize, maxBytes: cfg.runtimeCatalog.maxBytes,
  allowedOrigins: cfg.publicOrigins })
const nodeServiceProxy = new GatewayNodeServiceProxy({
  assertNode: id => topology.assertNode(id),
  localNodeId: context.nodeId as RuntimeNodeId,
  resolveForAccount: (actor, id) => runtimeCatalog.resolveForAccount(actor, id),
  resolveForAdministrator: (actor, id) => runtimeCatalog.resolveForAdministrator(actor, id),
  resolvePlacement: (actor, selection) => runtimeRouter.placement(actor, selection),
  resetScopeCookie: () => scopeCookie('personal', cfg),
  authorizeAdministratorNode: (actor, id) => nodeAccess.authorizeAdministratorNode(actor, id),
  authorizeAccountNode: (actor, id) => computerAccess.authorize(actor.id, id),
}, nodeServices, cfg.upstreamTimeoutMs, cfg.nodeService, accessMonitor,
async (target, user, request) => {
  // Attach the placement this Gateway already authorized so the destination
  // can adopt it as a checked placement; scope and runtime storage are
  // node-local data the destination resolves itself.
  const environment = target.environment
  return principalKeys.signer.issueForward({
    issuerNode: context.nodeId, audienceNode: target.nodeId, user,
    selection: { runtimeId: target.runtimeId ?? null, target: target.resolvedTarget ?? null },
    ...(environment === undefined || target.resolvedTarget === undefined
      ? {} : { context: { environment: { id: environment.id, nodeId: environment.node.id, nodeName: environment.node.name } } }),
    request,
  })
})
const runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter({ collaboration, instances }), {
  catalog: runtimeCatalog, localNodeId: context.nodeId as RuntimeNodeId,
})
const nodeSqlite=new NodePrivateSqliteHost(cfg.stateRoot,cfg.runtimeRequestTimeoutMs)
const personalIndex = new PersonalNodeIndex(cfg.stateRoot,nodeSqlite)
const workspaceCatalog = new PostgresWorkspaceCatalog(context, context.nodeId as RuntimeNodeId, personalIndex, contentVolume)
const deps: GatewayDeps = {
  revalidateOnComputer:token=>auth.validateOnComputer(token),
  projectMetadata: nodeProjects,
  projectNames: new PrimaryProjectNames(context, () => topology.read(), cfg.projectNameKeyFile, cfg.upstreamTimeoutMs),
  personalDirectory: workspaceCatalog,
  nodeContent: contentVolume,
  topology,
  nodeConnection: new GatewayNodeConnection(context, cfg, effectiveEnvironment, nodeConfigurationAuthority(context), topology),
  documentLocations,
  documentOverview: documentCatalog,
  computerAccess,
  runtimeManagement: new PostgresRuntimeManagement(context, cfg),
  runtimeCatalog,
  nodeChannels,
  nodeServices,
  nodeServiceProxy,
  nodeServiceIdentity: {
    nodeId: context.nodeId as RuntimeNodeId, organizationId: context.organizationId,
    authorize: (token, input) => nodeAccess.authorizeChannel(token, input),
  },
  forwardedPrincipal: async assertion => {
    // Any failure here — malformed assertion, directory outage, bad issuer —
    // resolves to null so the request falls back to ordinary session
    // validation; a broken forward path must not become a 500.
    try {
      const issuerNode = forwardIssuerOf(assertion)
      const issuerKey = issuerNode === null ? null : await principalDirectory.issuerKey(issuerNode)
      const claims = issuerKey === null ? null
        : verifyGatewayForward(assertion, issuerKey, {
          audienceNode: context.nodeId as RuntimeNodeId, organization: cfg.organizationSlug })
      if (claims === null) return null
      // A captured assertion stays replayable within its TTL unless the nonce
      // is consumed; the ledger is bounded by assertion expiry and each issued
      // assertion mints a fresh nonce, so a duplicate is replay evidence.
      const now = Date.now()
      for (const [nonce, expiry] of forwardNonceLedger) if (expiry <= now) forwardNonceLedger.delete(nonce)
      if (forwardNonceLedger.has(claims.nonce)) return null
      // Clamp retained expiry to the issued lifetime and bound the map: a
      // hostile issuer could mint far-future expiresAt claims and grow the
      // ledger unboundedly. Clearing under pressure only widens the replay
      // window for assertions still inside their TTL.
      if (forwardNonceLedger.size >= 4096) forwardNonceLedger.clear()
      forwardNonceLedger.set(claims.nonce, Math.min(claims.expiresAt, now + cfg.principalAssertionTtlMs))
      return claims
    } catch {
      return null
    }
  },
  runtimeRouter,
  performance: performanceObserver,
  cfg,
  auth,
  users,
  userPreferences,
  projects,
  audit,
  governance,
  collaboration,
  progress,
  documents: documentCatalog,
  archives,
  push,
  instances,
  desktops,
  desktopAccess: new DesktopAccess(context),
  pluginAccess: new PluginAccess(context),
  terminalAccess: new TerminalAccess(context),
  sshAccess: new SshAccess(context),
  stewardAccess: new StewardAccess(context),
  memoryAccess: new MemoryAccess(context),
  sshTargets: new PostgresSshTargetService(context),
  pluginManagement: new GatewayPluginManagement({ users, projects, instances, cfg, pluginState }, principalKeys.signer, context.nodeId),
  pluginState,
  terminalManagement: new GatewayTerminalManagement({ users, projects, instances, cfg }, principalKeys.signer, context.nodeId),
  webhookDeliveries,
  webhookEndpoints,
  tunnelAccess,
  webhookIntake: new GatewayWebhookIntake({ cfg, users, instances, collaboration },
    webhookEndpoints, webhookDeliveries, principalKeys.signer),
  accessMonitor: localAccessMonitor,
  maintenance,
  nodeConfiguration,
  nodeAccess,
  backups,
  remoteDesktop: new RemoteDesktopService(cfg.remoteDesktopDir, remoteDesktopAdministration(context)),
  backupWork: new PostgresDeploymentBackups(context, cfg, databaseUrl, deploymentCommands, effectiveEnvironment),
  migrationPlan: () => migrationPlan(pool, cfg.deployMigrationsDir),
  maintenanceGate,
  writerSpan,
  releaseAssets: ReleaseAssets.forConfig(cfg),
  databasePerformance: () => ({
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
    maximum: pool.options.max ?? null,
    admission: poolAdmissionSnapshot(pool),
  }),
  readiness: async (signal) => {
    await checkPostgresReadiness(context, signal)
    await accessMonitor.synchronize()
    signal?.throwIfAborted()
    await assertCurrentDataEpoch()
  },
}

await assertCurrentDataEpoch()
const reopenModelGovernance = (): void => { scheduleModelGovernanceRefresh(deps) }
onWritesReopened = reopenModelGovernance
try {
  await admitWriter(async () => {
    if (await deps.users.count() === 0) {
      const password = randomBytes(12).toString('base64url')
      await writeBootstrapAdminPassword(cfg.bootstrapAdminPasswordFile, password)
      try {
        await deps.users.create({ username: 'admin', password, role: 'admin' })
      } catch (error: unknown) {
        await removeBootstrapAdminPassword(cfg.bootstrapAdminPasswordFile).catch(() => {
          // Preserve the user-creation failure; a stale file is surfaced on the
          // next bootstrap attempt instead of hiding the original database error.
        })
        throw error
      }
      console.log(`[gateway] bootstrap admin created — username: admin; password written to owner-only file ${cfg.bootstrapAdminPasswordFile}`)
      console.log('[gateway] 首次登录后会强制修改密码。')
    }
  })
  // Reconcile every projection on Gateway startup so a surviving runtime and a
  // never-started account receive the same current organization default. The
  // operation is idempotent and does not alter authorization rows.
  await refreshModelGovernance(deps)
} catch (error) {
  // A maintenance restart serves the control UI without creating accounts,
  // credentials or policy files. Projections resume after maintenance ends.
  if (!(error instanceof RuntimeStartBlockedError) || error.reason !== 'maintenance') throw error
}

const proxyHandlers = createProxyHandlers(deps, principalKeys.signer)
await accessMonitor.synchronize()
// Browser document operations run against each scope's filesystem root so a
// panel read never starts a runtime; chat/agent work still launches one.
const recoveryFileGate=cfg.nodeContent && effectiveEnvironment.HGW_PEER_BACKUP_CONFIG_FILE ? new PeerProjectFileGate(cfg.stateRoot) : undefined
const localDocuments:LocalDocumentBroker = new LocalDocumentBroker({
  projectFileAdmission:recoveryFileGate,personalFileAdmission:personalDocumentGate,
  cfg,
  nodeId: context.nodeId as RuntimeNodeId,
  computerAccess: deps.computerAccess,
  users,
  projects,
  collaboration,
  organizationId: context.organizationId,
  catalog: documentCatalogHandlers,
  accessMonitor: localAccessMonitor,
  writes: {
    retain: trackWriter,
    admit: async (operation) => {
      try {
        await admitWriter(operation)
      } catch (error) {
        if (error instanceof RuntimeStartBlockedError) {
          throw new UserDocError('Document storage is unavailable during maintenance or after a database restore.',
            DOCUMENT_STORE_UNAVAILABLE_CODE, { cause: error })
        }
        throw error
      }
    },
  },
})
const documentAdmin = createGatewayDocumentAdminHandler({
  instances: deps.instances,
  users,
  projects,
  collaboration,
  principals: principalKeys.signer,
  audit,
  maxResponseBytes: cfg.upstreamResponseLimitBytes,
  local: localDocuments,
})
const localDrafts = new LocalNodeDrafts(cfg.stateRoot,nodeSqlite,cfg.draftHistory)
const draftStore = projectNodeDrafts(context, localDrafts, contentVolume,cfg.draftHistory)
const publication:NodeContentPublication = new NodeContentPublication({
  ...nodeCorePublicationChecks({conversations,collaboration,execution:executionIdentity,progress,plugins:pluginState,files:nodeFiles}),
  workspace:input=>workspaceCatalog.verifyNodeContent(input),
  documents:input=>nodeDocuments.verifyNodeContent(input),
  drafts:input=>draftStore.verifyNodeContent(input),
  archive:input=>archives.verifyNodeContent(input,'archive'),
  search:input=>archives.verifyNodeContent(input,'search'),
})
deps.contentMigrations = new NodeContentMigrationAdmin(context,()=>contentVolume.ready(),instances,publication)
deps.sourceRetirement = new NodeContentSourceRetirement(context,()=>contentVolume.ready())
const peerBackupRelay = new PeerBackupRelay(nodeServices, cfg.nodeService, cfg.upstreamTimeoutMs, accessMonitor)
const peerFileSource=effectiveEnvironment.HGW_PEER_PROJECT_SNAPSHOTS_FILE
const peerFiles=peerFileSource?new NativePeerProjectSnapshots(peerFileSource,cfg.runtimeRequestTimeoutMs,context,contentVolume,nodeFiles,
  input=>localDocuments.snapshotProjectDocumentRoots({organizationId:context.organizationId,nodeId:context.nodeId,projectPublicId:input.projectId,
    rootId:input.rootId,origin:input.origin,projectPath:input.workspace,cursor:input.cursor})):undefined
const peerBackups = await createPeerBackupGateway({ context, stateRoot: cfg.stateRoot, invalidate: id => peerBackupRelay.invalidate(id), configFile: effectiveEnvironment.HGW_PEER_BACKUP_CONFIG_FILE,
  ...(effectiveEnvironment.HGW_PEER_PERSONAL_SNAPSHOTS_FILE ? { personalFiles:new PeerPersonalFiles(context.pool,cfg.usersRoot,
    effectiveEnvironment.HGW_PEER_PERSONAL_SNAPSHOTS_FILE,cfg.runtimeRequestTimeoutMs,
    (owner,root,cursor,rows)=>localDocuments.snapshotPersonalDocumentRoots(owner,root,cursor,rows)) } : {}),
  nodeContent: contentVolume, files:peerFiles, forward: peerBackupRelay.forward,
  recovery:recoveryFileGate?{config:cfg,volume:contentVolume,instances,fileGate:recoveryFileGate}:undefined,
  reservedRoots: [cfg.stateRoot, cfg.usersRoot, cfg.projectsRoot, cfg.userProjectsRoot, cfg.projectRuntimesRoot, cfg.backupDir, ...cfg.projectPathRoots] })
const server = createGatewayServer(deps, {
  peerBackups,
  workbenchRows: workbenchRows(context, workspaceCatalog, collaboration, cfg.runtimeCatalog, contentVolume),
  nodeDrafts: draftStore,
  browserDocuments: createBrowserDocumentHandler({ locations: documentLocations, organizationId: context.organizationId,
    overview: documentCatalog, overviewConcurrency: cfg.nodeService.maxConnections, overviewDeadlineMs: cfg.documentOverviewDeadlineMs,
    origin: cfg.publicOrigins[0]!, responseLimit: cfg.upstreamResponseLimitBytes,
    transfer: { instances: deps.instances, users, projects, collaboration, principals: principalKeys.signer, audit, catalog: documentCatalog,
      maxResponseBytes: cfg.upstreamResponseLimitBytes, upstreamTimeoutMs: cfg.upstreamTimeoutMs } }),
  ...proxyHandlers,
  workbenchCatalog: createGatewayWorkbenchCatalogHandler({
    workspaceCatalog,
    instances,
    collaboration,
    principals: principalKeys.signer,
    maxResponseBytes: cfg.upstreamResponseLimitBytes,
    upstreamTimeoutMs: cfg.upstreamTimeoutMs,
  }),
  // Authenticate loopback runtime calls before the Gateway starts buffering
  // their body. The runtime handler repeats the check at dispatch time; this
  // early probe is deliberately narrow and exists to turn unauthenticated
  // large-body requests into a cheap 401 instead of a 64 MiB allocation.
  runtimeAuthorize: async (req) => {
    const value = req.headers.authorization
    if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false
    const token = value.slice('Bearer '.length)
    if (token === '') return false
    try {
      return await instanceRepository.authenticateRuntimeToken(token) !== null
    } catch {
      return false
    }
  },
  documentTransferList: createGatewayDocumentTransferListHandler({
    instances: deps.instances,
    users,
    projects,
    collaboration,
    principals: principalKeys.signer,
    audit,
    maxResponseBytes: cfg.upstreamResponseLimitBytes,
    local: localDocuments,
  }),
  documentTransferUpload: createGatewayDocumentTransferUploadHandler({
    instances: deps.instances,
    users,
    projects,
    collaboration,
    principals: principalKeys.signer,
    audit,
    maxResponseBytes: cfg.upstreamResponseLimitBytes,
    local: localDocuments,
  }),
  documentScope: createGatewayDocumentScopeHandler({
    instances: deps.instances,
    users,
    projects,
    collaboration,
    principals: principalKeys.signer,
    audit,
    maxResponseBytes: cfg.upstreamResponseLimitBytes,
    upstreamTimeoutMs: cfg.upstreamTimeoutMs,
    local: localDocuments,
  }),
  admin: createAdminApiHandler(deps, documentAdmin, proxyHandlers.invalidateAccess),
  runtime: createRuntimeApiHandler({
    executionIdentity,
    nodeContent: contentVolume,
    workspaceCatalog,
    renewStreamPrincipals: proxyHandlers.streamPrincipals?.renew.bind(proxyHandlers.streamPrincipals),
    documentStore: invocation => localDocuments.serveRuntimeStore(invocation),
    accessMonitor: localAccessMonitor,
    executionWatchHeartbeatMs: cfg.executionWatchHeartbeatMs,
    executionWatchAuthorizationTimeoutMs: cfg.upstreamTimeoutMs,
    context,
    instances: instanceRepository,
    resourceBudget,
    conversations,
    collaboration,
    archives,
    principals: principalKeys.signer,
    governance,
    pluginState: deps.pluginState,
    stewardQuery,
    push,
    documentTransfer: createDocumentTransferHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      maxResponseBytes: cfg.upstreamResponseLimitBytes,
      catalog: documentCatalog,
    }),
    documentTransferCommit: createDocumentTransferCommitHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      maxResponseBytes: cfg.upstreamResponseLimitBytes,
      catalog: documentCatalog,
    }),
    documentTransferRetry: createDocumentTransferHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      maxResponseBytes: cfg.upstreamResponseLimitBytes,
      catalog: documentCatalog,
    }),
    documentTransferPlan: createDocumentTransferPlanHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      maxResponseBytes: cfg.upstreamResponseLimitBytes,
      catalog: documentCatalog,
    }),
    documentTransferCapabilities: createDocumentTransferCapabilitiesHandler({ collaboration }),
    documentTransferList: createDocumentTransferListHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      maxResponseBytes: cfg.upstreamResponseLimitBytes,
      local: localDocuments,
    }),
    documentTransferDirectories: createDocumentTransferDirectoriesHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      maxResponseBytes: cfg.upstreamResponseLimitBytes,
    }),
    documentTransferDirectoryCreate: createDocumentTransferDirectoryCreateHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      maxResponseBytes: cfg.upstreamResponseLimitBytes,
    }),
    documentCatalogSync: input => localDocuments.reconcileRuntimeCatalog(input),
    documentCatalogAuthorize: documentCatalogHandlers.authorize,
    documentCatalogPurge: input => localDocuments.reconcileRuntimeCatalog(input, true),
    documentCatalogOverview: documentCatalogHandlers.overview,
    documentCatalogHistory: documentCatalogHandlers.history,
    desktops,
    sshTargets: deps.sshTargets,
  }),
})
// A launch signature change (release, runtime entry, supervisor or toolchain)
// retires survivors before serving requests; an unchanged signature keeps them
// reattachable, so same-build restarts cost no cold start. Missing or
// unreadable records drain — the conservative direction for upgrades.
{
  const signature = await runtimeBootSignature(cfg)
  const prior = await readBootSignature(cfg.stateRoot)
  if (JSON.stringify(prior) !== JSON.stringify(signature)) {
    try {
      await instances.drainSurvivors('shutdown')
      if (prior !== undefined) console.log('[gateway] drained Runtime survivors after launch signature change')
    } catch (error) {
      console.error('[gateway] Runtime survivor drain after launch signature change failed:', error)
    }
  }
  await writeBootSignature(cfg.stateRoot, signature)
}
// Bind loopback only: the gateway is reached through the TLS entry (Cloudflare
// tunnel / Nginx) that connects to 127.0.0.1, never directly over the LAN.
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[gateway] listening on http://127.0.0.1:${cfg.port}`)
})

const intake = createUsageIntakeServer(governance, audit, {
  open: async () => (await maintenanceGate()) === 'open',
  track: trackWriter,
}, performanceObserver)
intake.listen(cfg.intakePort, '127.0.0.1', () => {
  console.log(`[gateway] usage intake listening on http://127.0.0.1:${cfg.intakePort}`)
})

// The tunnel must re-launch after a restart while its desired flag stays
// 'running'; resume runs after the listener is up so the target port is serving.
void tunnelAccess.resume()

interface SingleFlightTask {
  run: () => void
  wait: () => Promise<void>
}

/** Keep periodic maintenance from overlapping itself during a slow database sweep. */
function singleFlightTask(label: string, operation: () => Promise<void>): SingleFlightTask {
  let inFlight: Promise<void> | undefined
  const run = (): void => {
    if (inFlight !== undefined) return
    const current = Promise.resolve()
      .then(operation)
      .catch(error => { console.error(`[gateway] ${label} failed:`, error) })
      .finally(() => {
        if (inFlight === current) inFlight = undefined
      })
    inFlight = current
  }
  return {
    run,
    wait: () => inFlight ?? Promise.resolve(),
  }
}

// Periodic writers fence with HTTP writers: the gate keeps a sweep from
// starting under maintenance, and the in-flight count keeps a running sweep
// on the quiesce ledger until it drains.
const fencedTask = (label: string, operation: () => Promise<void>): SingleFlightTask =>
  singleFlightTask(label, () => trackWriter(async () => {
    if (await maintenanceGate() !== 'open') return
    await operation()
  }))

const resourcePressure = new NodeResourcePressure(cfg.resourceBudget,
  sample => trackWriter(async () => {
    if (await maintenanceGate() === 'open') await resourceBudget.observe(sample)
  }),
  error => { console.error('[gateway] resource pressure sample failed:', error) },
  () => heartbeatVerdict === undefined || heartbeatVerdict === 'open')
resourcePressure.start()

/**
 * Seed the reserved steward space and ensure its resident runtime. A crash
 * is healed by the supervisor's restart policy (systemd `Restart=always`);
 * an explicit administrator stop stays stopped until a gateway boot or an
 * explicit start — no periodic revive fights a deliberate halt. The local
 * supervisor preserves a live Runtime across Gateway failure and does not
 * restart a crashed Runtime. The fenced run retries when a boot-time
 * maintenance window closes.
 */
const stewardPreparation = new AbortController()
const ensureStewardSpace = async (): Promise<void> => {
  if (!cfg.steward.enabled || projects.ensureSteward === undefined) return
  await prepareStewardWorktree(cfg.steward, stewardPreparation.signal)
  stewardPreparation.signal.throwIfAborted()
  const steward = await projects.ensureSteward({ name: cfg.steward.projectName, path: cfg.steward.workspacePath })
  stewardPreparation.signal.throwIfAborted()
  await instances.ensureRunning({ kind: 'project', id: steward.id, name: steward.name, path: steward.path, steward: true }, 'explicit')
}
const stewardEnsure = fencedTask('steward space', ensureStewardSpace)
// Both reopen effects must run: assigning a bare closure would discard the
// model-governance refresh registered earlier.
onWritesReopened = () => { reopenModelGovernance(); stewardEnsure.run() }
stewardEnsure.run()

const reaperTask = fencedTask('idle reaper', async () => {
  await deps.instances.reapIdle()
})
const archiveRetentionTask = fencedTask('archive retention sweep', async () => {
  await archives.purgeDue()
})
const documentRetentionTask = fencedTask('document retention sweep', async () => {
  await documentCatalog.purgeDue?.()
})
const desktopSweepTask = fencedTask('desktop grant sweep', async () => {
  await desktops.sweep()
})
const progressSweepTask = fencedTask('project progress digest', async () => {
  await progress.sweep()
})
const reaper = setInterval(reaperTask.run, 60_000)
const archiveRetentionSweep = setInterval(archiveRetentionTask.run, 60 * 60_000)
const documentRetentionSweep = setInterval(documentRetentionTask.run, 60 * 60_000)
const desktopSweep = setInterval(desktopSweepTask.run, Math.max(1_000, cfg.desktop.grantTtlMs / 2))
const progressSweep = setInterval(progressSweepTask.run, cfg.progress.sweepMs)
reaper.unref()
archiveRetentionSweep.unref()
documentRetentionSweep.unref()
desktopSweep.unref()
progressSweep.unref()

const CONNECTION_DRAIN_MS = 3000
const SHUTDOWN_TIMEOUT_MS = 10_000

function closeListeningServer(target: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { target.closeAllConnections() }, CONNECTION_DRAIN_MS)
    timer.unref()
    target.close(error => {
      clearTimeout(timer)
      if (error === undefined) resolve()
      else reject(error)
    })
  })
}

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  stoppingWriters = true
  instances.beginShutdown()
  stewardPreparation.abort(new Error('Gateway is stopping steward workspace preparation'))
  clearInterval(heartbeatTimer)
  const forced = setTimeout(() => {
    console.error(`[gateway] forced shutdown after ${String(SHUTDOWN_TIMEOUT_MS)}ms (${signal})`)
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  clearInterval(reaper)
  clearInterval(archiveRetentionSweep)
  clearInterval(documentRetentionSweep)
  clearInterval(desktopSweep)
  clearInterval(progressSweep)
  const failures: unknown[] = []
  const settle = async (operations: readonly (() => unknown)[]): Promise<void> => {
    const results = await Promise.allSettled(operations.map(operation => Promise.resolve().then(operation)))
    for (const result of results) {
      if (result.status === 'rejected') failures.push(result.reason)
    }
  }
  await settle([() => peerBackups.close()])
  await settle([
    () => peerBackupRelay.close(),
    () => nodeServiceProxy?.close(),
    () => progress.close(), () => gatewayModelBudget.close(), () => resourcePressure.dispose(), () => tunnelAccess.shutdown(), () => nodeChannels.close(),
    () => nodeServices.close(),
  ])
  await settle([
    () => reaperTask.wait(),
    () => archiveRetentionTask.wait(),
    () => documentRetentionTask.wait(),
    () => desktopSweepTask.wait(),
    () => progressSweepTask.wait(),
  ])
  await settle([() => proxyHandlers.close()])
  await settle([() => localDocuments.dispose()])
  await settle([() => accessMonitor.close()])
  await settle([() => closeListeningServer(server), () => closeListeningServer(intake)])
  await settle([() => waitForWriters()])
  await settle([() => localDrafts.close(), () => personalIndex.close()])
  await settle([() => heartbeatInFlight])
  await settle([() => deps.instances.stopAll(!cfg.drainRuntimesOnShutdown)])
  await settle([() => pool.end(), () => contentVolume.close()])
  await settle([() => performanceObserver.dispose()])
  clearTimeout(forced)
  if (failures.length > 0) console.error('[gateway] shutdown failed:', new AggregateError(failures, 'Gateway shutdown failed'))
  process.exit(failures.length > 0 ? 1 : 0)
}
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })
