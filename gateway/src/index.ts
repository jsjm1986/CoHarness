import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { createAdminApiHandler } from './admin-api.ts'
import { applyModelGovernanceToProject, applyModelGovernanceToUser } from './apply-model-governance.ts'
import { loadConfig } from './config.ts'
import { InstanceManager } from './instances.ts'
import { selectLauncher } from './launcher.ts'
import { PostgresAuditService } from './postgres/audit-service.ts'
import { PostgresAuthService } from './postgres/auth-service.ts'
import { PostgresCollaborationService } from './postgres/collaboration-service.ts'
import {
  createPostgresPool,
  databaseUrlFromFile,
  errorCodeForDiagnostics,
  runMigrations,
  withDatabaseStartupRetry,
} from './postgres/database.ts'
import { ConversationRepository } from './postgres/conversation-repository.ts'
import { PostgresInstanceRepository } from './postgres/instance-repository.ts'
import { PostgresModelGovernanceService } from './postgres/model-governance-service.ts'
import {
  loadOrganizationModelCredentialKey,
  OrganizationModelCredentialCipher,
} from './organization-model-credentials.ts'
import { PostgresProjectService } from './postgres/project-service.ts'
import { checkPostgresReadiness, resolvePostgresRuntimeContext } from './postgres/runtime-context.ts'
import { PostgresUserService } from './postgres/user-service.ts'
import { loadPrincipalKeys } from './principal.ts'
import { createProxyHandlers } from './proxy.ts'
import { createPostgresPushService } from './push-notifications.ts'
import { createRuntimeApiHandler } from './runtime-api.ts'
import {
  createDocumentTransferCapabilitiesHandler,
  createDocumentTransferDirectoriesHandler,
  createDocumentTransferDirectoryCreateHandler,
  createDocumentTransferCommitHandler,
  createDocumentTransferPlanHandler,
  createDocumentTransferListHandler,
  createGatewayDocumentTransferListHandler,
  createDocumentTransferHandler,
} from './document-transfer.ts'
import { createDocumentCatalogHandlers } from './document-catalog.ts'
import { PostgresDocumentCatalogService } from './postgres/document-catalog-service.ts'
import { runtimeDirectoryGrants } from './runtime-directory-grants.ts'
import { createGatewayServer, type GatewayDeps } from './server.ts'
import { createUsageIntakeServer } from './usage-intake.ts'

const cfg = loadConfig()
if (cfg.releaseId !== undefined) console.log(`[gateway] release ${cfg.releaseId}`)
const pool = createPostgresPool(await databaseUrlFromFile())
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
    throw error
  } finally {
    process.removeListener('SIGINT', onStartupSignal)
    process.removeListener('SIGTERM', onStartupSignal)
  }
})()
const auth = new PostgresAuthService(context, cfg)
const users = new PostgresUserService(context, cfg)
const projects = new PostgresProjectService(context, cfg)
const audit = new PostgresAuditService(context)
const governance = new PostgresModelGovernanceService(
  context,
  new OrganizationModelCredentialCipher(
    loadOrganizationModelCredentialKey(cfg.organizationModelCredentialKeyFile),
  ),
  cfg.usageTimeZone,
)
const collaboration = new PostgresCollaborationService(context)
const documentCatalog = new PostgresDocumentCatalogService(context)
const documentCatalogHandlers = createDocumentCatalogHandlers(documentCatalog, audit)
const push = createPostgresPushService(context, cfg)
const principalKeys = loadPrincipalKeys(cfg.principalKeyDir, cfg.organizationSlug, cfg.principalAssertionTtlMs)
const instanceRepository = new PostgresInstanceRepository(context, cfg.instancePortBase)
const conversations = new ConversationRepository(pool)
// Launcher is local child-process (dev) unless HGW_LAUNCHER=systemd (Linux prod);
// the systemd options factory is only evaluated in the systemd case.
const launcher = selectLauncher(cfg, () => ({
  systemd: {
    usersRoot: cfg.usersRoot,
    projectRuntimesRoot: cfg.projectRuntimesRoot,
    projectPathRoots: cfg.projectPathRoots,
    execStart: cfg.dshCommand.join(' '),
    gatewayDir: cfg.gatewayDir,
    memoryMax: cfg.memoryMax,
    cpuQuota: cfg.cpuQuota,
  },
  credentialDir: cfg.runtimeCredentialDir,
  unitDir: cfg.systemdUnitDir,
  grantsProvider: async (runtime) => {
    if (runtime.kind === 'project') return []
    const user = await users.getById(runtime.ownerId)
    if (user === null) return []
    return (await runtimeDirectoryGrants(user, projects)).map(({ path, mode }) => ({ path, mode }))
  },
}))
const deps: GatewayDeps = {
  cfg,
  auth,
  users,
  projects,
  audit,
  governance,
  collaboration,
  documents: documentCatalog,
  push,
  instances: new InstanceManager(instanceRepository, cfg, launcher, {
    principalPublicKey: principalKeys.publicKeyPem,
  }),
  readiness: () => checkPostgresReadiness(context),
}

if (await deps.users.count() === 0) {
  const password = randomBytes(12).toString('base64url')
  await deps.users.create({ username: 'admin', password, role: 'admin' })
  console.log(`[gateway] bootstrap admin created — username: admin  password: ${password}`)
  console.log('[gateway] 首次登录后会强制修改密码。')
}

// Reconcile every projection on Gateway startup so a surviving runtime and a
// never-started account receive the same current organization default. The
// operation is idempotent and does not alter authorization rows.
for (const target of await deps.users.list()) await applyModelGovernanceToUser(deps, target.id)
for (const project of await deps.projects.list()) await applyModelGovernanceToProject(deps, project.id)

const proxyHandlers = createProxyHandlers(deps, principalKeys.signer)
const server = createGatewayServer(deps, {
  ...proxyHandlers,
  documentTransferList: createGatewayDocumentTransferListHandler({
    instances: deps.instances,
    users,
    projects,
    collaboration,
    principals: principalKeys.signer,
    audit,
  }),
  admin: createAdminApiHandler(deps),
  runtime: createRuntimeApiHandler({
    context,
    instances: instanceRepository,
    conversations,
    collaboration,
    principals: principalKeys.signer,
    governance,
    push,
    documentTransfer: createDocumentTransferHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      catalog: documentCatalog,
    }),
    documentTransferCommit: createDocumentTransferCommitHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      catalog: documentCatalog,
    }),
    documentTransferRetry: createDocumentTransferHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
      catalog: documentCatalog,
    }),
    documentTransferPlan: createDocumentTransferPlanHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
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
    }),
    documentTransferDirectories: createDocumentTransferDirectoriesHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
    }),
    documentTransferDirectoryCreate: createDocumentTransferDirectoryCreateHandler({
      instances: deps.instances,
      users,
      projects,
      collaboration,
      principals: principalKeys.signer,
      audit,
    }),
    documentCatalogSync: documentCatalogHandlers.sync,
    documentCatalogAuthorize: documentCatalogHandlers.authorize,
    documentCatalogOverview: documentCatalogHandlers.overview,
    documentCatalogHistory: documentCatalogHandlers.history,
  }),
})
// Bind loopback only: the gateway is reached through the TLS entry (Cloudflare
// tunnel / Nginx) that connects to 127.0.0.1, never directly over the LAN.
server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`[gateway] listening on http://127.0.0.1:${cfg.port}`)
})
const intake = createUsageIntakeServer(governance, audit)
intake.listen(cfg.intakePort, '127.0.0.1', () => {
  console.log(`[gateway] usage intake listening on http://127.0.0.1:${cfg.intakePort}`)
})

const reaper = setInterval(() => {
  void Promise.resolve(deps.instances.reapIdle()).catch(error => {
    console.error('[gateway] idle reaper failed:', error)
  })
}, 60_000)

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
  const forced = setTimeout(() => {
    console.error(`[gateway] forced shutdown after ${String(SHUTDOWN_TIMEOUT_MS)}ms (${signal})`)
    process.exit(1)
  }, SHUTDOWN_TIMEOUT_MS)
  forced.unref()
  clearInterval(reaper)
  try {
    proxyHandlers.close()
    await Promise.all([closeListeningServer(server), closeListeningServer(intake)])
    await deps.instances.stopAll()
    await pool.end()
    clearTimeout(forced)
    process.exit(0)
  } catch (error) {
    console.error('[gateway] shutdown failed:', error)
    process.exit(1)
  }
}
process.once('SIGINT', () => { void shutdown('SIGINT') })
process.once('SIGTERM', () => { void shutdown('SIGTERM') })
