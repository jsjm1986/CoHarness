import { randomBytes } from 'node:crypto'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { createAdminApiHandler } from './admin-api.ts'
import { applyModelGovernanceToProject, applyModelGovernanceToUser } from './apply-model-governance.ts'
import { loadConfig } from './config.ts'
import { InstanceManager, RuntimeLeaseUnavailableError } from './instances.ts'
import type { RuntimeTarget } from './instances.ts'
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
import { ConversationArchiveService, type ConversationArchiveRuntimeRead } from './postgres/conversation-archive-service.ts'
import { PostgresInstanceRepository } from './postgres/instance-repository.ts'
import { PostgresModelGovernanceService } from './postgres/model-governance-service.ts'
import {
  loadOrganizationModelCredentialKey,
  OrganizationModelCredentialCipher,
} from './organization-model-credentials.ts'
import { PostgresProjectService } from './postgres/project-service.ts'
import { checkPostgresReadiness, resolvePostgresRuntimeContext } from './postgres/runtime-context.ts'
import { PostgresUserService } from './postgres/user-service.ts'
import { loadPrincipalKeys, PRINCIPAL_HEADER } from './principal.ts'
import { readResponseJson, ResponseBodyTooLargeError } from './response-budget.ts'
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
  createGatewayDocumentTransferUploadHandler,
  createGatewayDocumentScopeHandler,
  createGatewayDocumentAdminHandler,
  createDocumentTransferHandler,
} from './document-transfer.ts'
import { createDocumentCatalogHandlers } from './document-catalog.ts'
import { PostgresDocumentCatalogService } from './postgres/document-catalog-service.ts'
import { runtimeDirectoryGrants } from './runtime-directory-grants.ts'
import { createGatewayServer, type GatewayDeps } from './server.ts'
import { createUsageIntakeServer } from './usage-intake.ts'

function archiveReadPayload(value: unknown): ConversationArchiveRuntimeRead {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('runtime archive reader returned invalid JSON')
  }
  const payload = value as { title?: unknown; descendants?: unknown; events?: unknown; hasMore?: unknown }
  if ((payload.title !== undefined && typeof payload.title !== 'string')
    || !Array.isArray(payload.descendants) || !Array.isArray(payload.events) || typeof payload.hasMore !== 'boolean') {
    throw new Error('runtime archive reader returned invalid archive page')
  }
  const descendants = payload.descendants.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('runtime archive reader returned invalid descendant')
    const row = item as { sessionId?: unknown; parentSessionId?: unknown; title?: unknown }
    if (typeof row.sessionId !== 'string' || row.sessionId === ''
      || (row.parentSessionId !== null && typeof row.parentSessionId !== 'string')
      || typeof row.title !== 'string') throw new Error('runtime archive reader returned invalid descendant')
    return { sessionId: row.sessionId, parentSessionId: row.parentSessionId, title: row.title }
  })
  const events = payload.events.map(item => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('runtime archive reader returned invalid event')
    const row = item as { sessionId?: unknown; seq?: unknown; type?: unknown; time?: unknown; data?: unknown }
    if (typeof row.sessionId !== 'string' || row.sessionId === '' || typeof row.type !== 'string' || row.type === ''
      || typeof row.seq !== 'number' || !Number.isSafeInteger(row.seq) || row.seq < 0
      || typeof row.time !== 'number' || !Number.isSafeInteger(row.time) || row.time < 0) {
      throw new Error('runtime archive reader returned invalid event')
    }
    return { sessionId: row.sessionId, seq: row.seq, type: row.type, time: row.time, data: row.data }
  })
  return {
    ...(typeof payload.title === 'string' ? { title: payload.title } : {}),
    descendants,
    events,
    hasMore: payload.hasMore,
  }
}

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
const documentCatalog = new PostgresDocumentCatalogService(context, cfg.archiveRetentionDays)
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
    execStart: cfg.dshCommand,
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
const instances = new InstanceManager(instanceRepository, cfg, launcher, {
  principalPublicKey: principalKeys.publicKeyPem,
})
const archives = new ConversationArchiveService(context, cfg.archiveRetentionDays)
archives.setRuntimeReader(async (runtime, rootSessionId, fromSeq, limit) => {
  let subject: Awaited<ReturnType<PostgresUserService['getById']>> | {
    kind: 'project'; id: number; name: string; path: string
  }
  let projectName: string | undefined
  if (runtime.kind === 'user') {
    subject = await users.getById(runtime.id)
  } else {
    const project = await projects.getById(runtime.id)
    subject = project === null ? null : { kind: 'project', id: project.id, name: project.name, path: project.path }
    projectName = project?.name
  }
  if (subject === null || subject === undefined) return undefined
  const running = await instances.ensureRunning(subject)
  const scope = runtime.kind === 'project'
    ? { kind: 'project' as const, projectId: runtime.id, projectName: projectName ?? `Project ${String(runtime.id)}`, mode: 'ro' as const }
    : { kind: 'personal' as const }
  const assertion = principalKeys.signer.issue({
    user: {
      id: 1,
      username: 'gateway-archive-reader',
      displayName: 'Gateway archive reader',
      role: 'admin',
      status: 'active',
      homePath: '/',
      mustChangePassword: false,
    },
    scope,
    runtime: { kind: runtime.kind, id: runtime.id, generation: running.generation },
    purpose: 'archive-read',
  })
  const authority = `127.0.0.1:${String(running.port)}`
  const target: RuntimeTarget = runtime.kind === 'user'
    ? { kind: 'user', id: runtime.id }
    : { kind: 'project', id: runtime.id }
  let operationLease = false
  try {
    await instances.operationRef?.(target, 1)
    operationLease = instances.operationRef !== undefined
  } catch (error) {
    if (error instanceof RuntimeLeaseUnavailableError) {
      throw new Error('runtime archive reader lost its operation lease; retry the archive request', { cause: error })
    }
    throw error
  }
  try {
    const response = await fetch(
      `http://${authority}/api/internal/archive/read?sessionId=${encodeURIComponent(rootSessionId)}&fromSeq=${String(fromSeq)}&limit=${String(limit)}`,
      { headers: { host: authority, [PRINCIPAL_HEADER]: assertion }, signal: AbortSignal.timeout(cfg.readinessTimeoutMs) },
    )
    if (response.status === 404) return undefined
    let value: unknown
    try { value = await readResponseJson(response, cfg.upstreamResponseLimitBytes) } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) throw new Error('runtime archive reader response is too large')
      throw new Error(`runtime archive reader returned HTTP ${String(response.status)}`)
    }
    if (!response.ok) throw new Error(`runtime archive reader returned HTTP ${String(response.status)}`)
    return archiveReadPayload(value)
  } finally {
    if (operationLease) await Promise.resolve(instances.operationRef?.(target, -1)).catch(() => {})
  }
})
const deps: GatewayDeps = {
  cfg,
  auth,
  users,
  projects,
  audit,
  governance,
  collaboration,
  documents: documentCatalog,
  archives,
  push,
  instances,
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
const documentAdmin = createGatewayDocumentAdminHandler({
  instances: deps.instances,
  users,
  projects,
  collaboration,
  principals: principalKeys.signer,
  audit,
  maxResponseBytes: cfg.upstreamResponseLimitBytes,
})
const server = createGatewayServer(deps, {
  ...proxyHandlers,
  documentTransferList: createGatewayDocumentTransferListHandler({
    instances: deps.instances,
    users,
    projects,
    collaboration,
    principals: principalKeys.signer,
    audit,
    maxResponseBytes: cfg.upstreamResponseLimitBytes,
  }),
  documentTransferUpload: createGatewayDocumentTransferUploadHandler({
    instances: deps.instances,
    users,
    projects,
    collaboration,
    principals: principalKeys.signer,
    audit,
    maxResponseBytes: cfg.upstreamResponseLimitBytes,
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
  }),
  admin: createAdminApiHandler(deps, documentAdmin),
  runtime: createRuntimeApiHandler({
    context,
    instances: instanceRepository,
    conversations,
    collaboration,
    archives,
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
    documentCatalogSync: documentCatalogHandlers.sync,
    documentCatalogAuthorize: documentCatalogHandlers.authorize,
    documentCatalogPurge: documentCatalogHandlers.purge,
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
const archiveRetentionSweep = setInterval(() => {
  void archives.purgeDue().catch(error => {
    console.error('[gateway] archive retention sweep failed:', error)
  })
}, 60 * 60_000)
archiveRetentionSweep.unref()
const documentRetentionSweep = setInterval(() => {
  void Promise.resolve(documentCatalog.purgeDue?.()).catch(error => {
    console.error('[gateway] document retention sweep failed:', error)
  })
}, 60 * 60_000)
documentRetentionSweep.unref()

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
  clearInterval(archiveRetentionSweep)
  clearInterval(documentRetentionSweep)
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
