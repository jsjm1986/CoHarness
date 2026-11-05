import { enableFixtureTopology } from './topology-fixture.mjs'
/** Ordinary-Node Gateway with the shipped Web profile and existing local process owner. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect, createServer as createRelay } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('A disposable test database is required')
const root = process.env.NODE_SERVICE_FIXTURE_ROOT, slug = process.env.NODE_SERVICE_FIXTURE_ORGANIZATION
const nodeName = process.env.NODE_SERVICE_FIXTURE_NODE
assert.ok(root && slug && nodeName)
const load = name => import(new URL(`../../lib/${name}.js`, import.meta.url))
const [
  { loadConfig }, { createPostgresPool }, { resolvePostgresRuntimeContext },
  { PostgresUserService }, { PostgresAuthService }, { PostgresProjectService }, { PostgresAuditService },
  { PostgresCollaborationService }, { PostgresInstanceRepository }, { PostgresRuntimeCatalog },
  { PostgresNodeAccessService }, { InstanceManager }, { LocalLauncher }, { PostgresAccessMonitor, scopeAccessMonitor },
  { NodeResourceBudget }, { createGatewayServer, scopeCookie }, { createProxyHandlers }, { createRuntimeApiHandler },
  { PostgresConversationStore }, { loadPrincipalKeys }, { PostgresModelGovernanceService },
  { OrganizationModelCredentialCipher, loadOrganizationModelCredentialKey }, { createUsageIntakeServer },
  { GatewayNodeChannels }, { GatewayNodeServices }, { GatewayNodeServiceProxy },
  { GatewayRuntimeRouter, LocalRuntimeAdapter }, { createAdminApiHandler }, { PostgresComputerAccess }, { PostgresRuntimeManagement }, { GatewayModelBudget },
  { DesktopAccess }, { MemoryAccess }, { PluginAccess }, { PostgresPluginState }, { SshAccess }, { StewardAccess }, { TerminalAccess },
  { GatewayPluginManagement }, { GatewayTerminalManagement },
  { LocalDocumentBroker }, { createDocumentCatalogHandlers }, { PostgresDocumentCatalogService }, { PostgresDocumentLocations },
  { createGatewayDocumentScopeHandler, createGatewayDocumentTransferUploadHandler }, { createBrowserDocumentHandler },
  { PostgresWebhookEndpointService, WebhookSecretCipher }, { PostgresWebhookDeliveryService }, { GatewayWebhookIntake },
  { PostgresDeploymentTopology },
  { PostgresMaintenanceService, ensureControl }, { PostgresBackupService },
  { NodeConfigurationStore }, { nodeConfigurationAuthority }, { GatewayNodeConnection },
  { PostgresWorkspaceCatalog }, { createGatewayWorkbenchCatalogHandler },
] = await Promise.all([
  'config', 'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/auth-service',
  'postgres/project-service', 'postgres/audit-service', 'postgres/collaboration-service', 'postgres/instance-repository',
  'postgres/runtime-catalog', 'postgres/node-access-service', 'instances', 'launcher', 'access-invalidation',
  'node-resource-budget', 'server', 'proxy', 'runtime-api', 'postgres/conversation-repository', 'principal',
  'postgres/model-governance-service', 'organization-model-credentials', 'usage-intake', 'node-channel', 'node-service',
  'node-service-proxy', 'runtime-router', 'admin-api', 'computer-access', 'runtime-management', 'gateway-model-budget',
  'desktop-access', 'memory-access', 'plugin-access', 'plugin-state', 'ssh-access', 'steward-access', 'terminal-access',
  'plugin-management', 'terminal-management', 'documents-local', 'document-catalog', 'postgres/document-catalog-service', 'postgres/document-locations',
  'document-transfer', 'browser-documents', 'postgres/webhook-endpoint-service', 'postgres/webhook-delivery-service', 'webhook-intake', 'deployment-topology',
  'postgres/maintenance-service', 'postgres/backup-service', 'node-config-store', 'postgres/node-configuration-authority', 'node-connection',
  'workspace-catalog', 'workbench',
].map(load))

const cfg = loadConfig({
  HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: nodeName,
  ...(process.env.HGW_TEST_VERSIONED_OPERATIONS?{HGW_ORGANIZATION_MODEL_CREDENTIAL_KEY_FILE:join(root,'..','fixture-organization-model.key')}:{}),
  HGW_STATE_ROOT: join(root, 'state'), HGW_USERS_ROOT: join(root, 'users'),
  HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
  HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_DEFAULT_ENV_FILE: '',
  HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)), HGW_READINESS_TIMEOUT_MS: '60000',
  // Lifecycle replies follow process readiness, so their transport budget must cover that wait.
  HGW_NODE_SERVICE_CONNECT_TIMEOUT_MS: '65000',
  HGW_UPSTREAM_TIMEOUT_MS: '65000',
  ...(nodeName === 'center' ? {} : { HGW_RUNTIME_BROWSER_READY_TIMEOUT_MS: '120000', HGW_RUNTIME_BROWSER_STREAM_TIMEOUT_MS: '60000', HGW_RUNTIME_BROWSER_RPC_TIMEOUT_MS: '120000' }),
  HGW_NODE_SERVICE_FORWARDING: 'on', HGW_NODE_AGENT_HEARTBEAT_MS: '100', HGW_NODE_AGENT_LEASE_MS: '30000',
})
await mkdir(root, { recursive: true })
const modelFixture = createHttpServer((req, res) => {
  req.resume(); res.setHeader('content-type', 'application/json')
  if (req.method === 'GET') res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'fixture' }] }))
  else if(process.env.HGW_TEST_VERSIONED_OPERATIONS && (req.url?.endsWith('/chat/completions') || req.url?.endsWith('/messages'))){
    if(req.headers.authorization!=='Bearer private-fixture-model-access'){res.writeHead(401);res.end('{}');return}
    res.setHeader('content-type','text/event-stream')
    if(req.url.endsWith('/messages')){
      const events=[{type:'message_start',message:{id:'test',role:'assistant',model:'fixture-chat',usage:{input_tokens:12,output_tokens:0},content:[]}},
        {type:'content_block_start',index:0,content_block:{type:'text',text:''}},
        {type:'content_block_delta',index:0,delta:{type:'text_delta',text:'controlled-node-response'}},{type:'content_block_stop',index:0},
        {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},{type:'message_stop'}]
      res.end(events.map(e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n').join(''))
    } else {
      const chunk=(delta,finish_reason)=>({id:'fixture-reply',object:'chat.completion.chunk',created:1,model:'fixture-chat',choices:[{index:0,delta,finish_reason}]})
      res.end([chunk({role:'assistant',content:'controlled-node-response'},null),chunk({},'stop')].map(e=>'data: '+JSON.stringify(e)+'\n\n').join('')+'data: [DONE]\n\n')
    }
  }
  else { res.writeHead(503); res.end(JSON.stringify({ error: { message: 'Inference is not part of this metadata fixture' } })) }
})
await new Promise(resolve => modelFixture.listen(0, '127.0.0.1', resolve))
// Fixture credential directories are excluded from administrator project imports.
await mkdir(join(root, 'credentials'), { recursive: true, mode: 0o700 })
cfg.defaultEnvFile = join(root, 'credentials', 'fixture-model.env')
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${modelFixture.address().port}`
await writeFile(cfg.defaultEnvFile, 'DEEPSEEK_API_KEY=fixture-only\n', { mode: 0o600 })
cfg.dshCommand = [process.execPath, fileURLToPath(new URL('../../../apps/cli/lib/bin.js', import.meta.url)), 'web', '--no-open', '--port', '0']
const pool = createPostgresPool(databaseUrl, { max: 6 })
const context = await resolvePostgresRuntimeContext(pool, slug, nodeName)
if (nodeName === 'center') await enableFixtureTopology(context)
const users = new PostgresUserService(context, cfg), auth = new PostgresAuthService(context, cfg)
const projects = new PostgresProjectService(context, cfg, context.nodeId), audit = new PostgresAuditService(context)
const username = nodeName === 'center' ? 'center-owner' : 'remote-owner'
let user = await users.getByUsername(username)
if (user === null) {
  user = await users.create({ username, password: 'node-service-fixture-password', role: 'admin' })
  await users.changeOwnPassword(user.id, 'node-service-fixture-password')
}
const keys = loadPrincipalKeys(cfg.principalKeyDir, cfg.organizationSlug, cfg.principalAssertionTtlMs)
const governance = new PostgresModelGovernanceService(context,
  new OrganizationModelCredentialCipher(loadOrganizationModelCredentialKey(cfg.organizationModelCredentialKeyFile)), 'UTC')
if (nodeName === 'center') {
  const provider = { provider: 'org-topology', displayName: 'Topology fixture', driver: 'pi-ai', protocol: 'openai-completions',
    baseURL: process.env.DEEPSEEK_BASE_URL, authMode: process.env.HGW_TEST_VERSIONED_OPERATIONS?'api-key':'none' }
  await governance.upsertProvider({ ...provider, status: 'draft',...(process.env.HGW_TEST_VERSIONED_OPERATIONS?{credential:'private-fixture-model-access'}:{}) })
  await governance.upsertModel({ provider: provider.provider, model: 'fixture-chat', displayName: 'Fixture Chat', enabled: true,
    adminAllowed: true, userAllowed: true, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
    cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
  await governance.upsertProvider({ ...provider, status: 'enabled' })
}
const resources = new NodeResourceBudget(pool, context.organizationId, context.nodeId, { ...cfg.resourceBudget, sampleMs: 20, staleMs: 300000 })
await resources.configure()
await resources.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 64 })
const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
const processOwner = await GatewayModelBudget.open(resources, join(root, 'gateway-owners'))
const launcher = new LocalLauncher(cfg), credentials = new Map()
const startNative = launcher.start.bind(launcher)
launcher.start = async input => {
  const issued = JSON.parse(input.gatewayCredential)
  const captured = credentials.get(issued.runtime.runtimeId) ?? []
  captured.push({ generation: input.generation, token: issued.token })
  credentials.set(issued.runtime.runtimeId, captured)
  return startNative(input)
}
const manager = new InstanceManager(repository, cfg, launcher, { principalPublicKey: keys.publicKeyPem }, resources, processOwner)
const primaryTarget = await manager.resolveTarget({ kind: 'user', id: user.id })
await manager.stateOf(primaryTarget)
const relaySockets = new Set()
const runtimeRelays = new Set()
async function relayFor(runtimeId, ownerUserId = user.id) {
const target = await manager.resolveTarget({ kind: 'user', id: ownerUserId, ...(runtimeId === undefined ? {} : { runtimeId }) })
const { dshHome: runtimeHome } = await manager.storageOf(target)
const runtimeRelay = createRelay(downstream => {
  relaySockets.add(downstream); downstream.once('close', () => relaySockets.delete(downstream))
  void (async () => {
    let log
    try { log = await readFile(join(runtimeHome, 'logs/runtime.log'), 'utf8') }
    catch (error) { if (error.code === 'ENOENT') { downstream.destroy(); return }; throw error }
    const port = [...log.matchAll(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/gu)].at(-1)?.[1]
    if (port === undefined) { downstream.destroy(); return }
    const upstream = connect({ host: '127.0.0.1', port: Number(port) })
    relaySockets.add(upstream); upstream.once('close', () => { relaySockets.delete(upstream); downstream.destroy() })
    upstream.on('error', () => downstream.destroy()); downstream.on('error', () => upstream.destroy())
    downstream.once('close', () => upstream.destroy()); downstream.pipe(upstream).pipe(downstream)
  })().catch(() => downstream.destroy())
})
await new Promise(resolve => runtimeRelay.listen(0, '127.0.0.1', resolve))
runtimeRelays.add(runtimeRelay)
await pool.query(`UPDATE harness.instances SET port=$3 WHERE organization_id=$1 AND runtime_id=$2 AND assigned_node_id=$4`,
  [context.organizationId, target.runtimeId, runtimeRelay.address().port, context.nodeId])
}
await relayFor(primaryTarget.runtimeId)
const monitor = new PostgresAccessMonitor(context, 60000); await monitor.synchronize()
const localMonitor = scopeAccessMonitor(monitor, context.nodeId)
const catalog = new PostgresRuntimeCatalog(context, cfg.runtimeCatalog, context.nodeId)
const access = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
const channels = new GatewayNodeChannels(access, cfg.nodeChannel)
const services = new GatewayNodeServices(access, channels, cfg.nodeService, null)
const computerAccess = new PostgresComputerAccess(context, cfg.runtimeCatalog, context.nodeId)
const topology = new PostgresDeploymentTopology(context, { legacyForwarding: false, refreshAfterMs: 30000,
  pageSize: cfg.runtimeCatalog.pageSize, maxBytes: cfg.runtimeCatalog.maxBytes, allowedOrigins: cfg.publicOrigins })
await ensureControl(pool, context.organizationId)
const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
await maintenance.heartbeat(0n, 0)
const nodeEnvironment = { HGW_STATE_ROOT: cfg.stateRoot, HGW_NODE_CONNECTION_FILE: cfg.nodeConnectionFile }
const nodeAuthority = nodeConfigurationAuthority(context)
const nodeConfiguration = new NodeConfigurationStore(context, cfg, nodeEnvironment, nodeAuthority)
const remote = new GatewayNodeServiceProxy({ assertNode: id => topology.assertNode(id), localNodeId: context.nodeId,
  resolveForAccount: (actor, id) => catalog.resolveForAccount(actor, id),
  resolveForAdministrator: (actor, id) => catalog.resolveForAdministrator(actor, id),
  resolvePlacement: (actor, selection) => runtimeRouter.placement(actor, selection),
  resetScopeCookie: () => scopeCookie('personal', cfg),
  authorizeAccountNode: (actor, id) => computerAccess.authorize(actor.id, id),
  authorizeAdministratorNode: (actor, id) => access.authorizeAdministratorNode(actor, id),
}, services, cfg.upstreamTimeoutMs, cfg.nodeService, monitor)
const collaboration = new PostgresCollaborationService(context, context.nodeId)
const webhookEndpoints = new PostgresWebhookEndpointService(context, new WebhookSecretCipher(Buffer.alloc(32, 42)))
const webhookDeliveries = new PostgresWebhookDeliveryService(context)
const runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter({ projects, collaboration, instances: manager }), { localNodeId: context.nodeId, catalog })
const pluginState = new PostgresPluginState(context)
const documentCatalog = new PostgresDocumentCatalogService(context, cfg.archiveRetentionDays, context.nodeId)
const deps = { cfg, topology, users, auth, projects, audit, governance, collaboration, instances: manager, accessMonitor: localMonitor,
  maintenance, backups: new PostgresBackupService(context), nodeConfiguration,
  nodeConnection: new GatewayNodeConnection(context, cfg, nodeEnvironment, nodeAuthority, topology),
  computerAccess, documentLocations: new PostgresDocumentLocations(context, cfg.runtimeCatalog, context.nodeId),
  documentOverview: documentCatalog, documents: documentCatalog,
  runtimeManagement: new PostgresRuntimeManagement(context, cfg),
  desktopAccess: new DesktopAccess(context), memoryAccess: new MemoryAccess(context), pluginAccess: new PluginAccess(context),
  sshAccess: new SshAccess(context), stewardAccess: new StewardAccess(context), terminalAccess: new TerminalAccess(context), pluginState,
  pluginManagement: new GatewayPluginManagement({ users, projects, instances: manager, cfg, pluginState }, keys.signer, context.nodeId),
  terminalManagement: new GatewayTerminalManagement({ users, projects, instances: manager, cfg }, keys.signer, context.nodeId),
  webhookEndpoints, webhookDeliveries,
  webhookIntake: new GatewayWebhookIntake({ cfg, users, instances: manager, collaboration }, webhookEndpoints, webhookDeliveries, keys.signer),
  runtimeCatalog: catalog, nodeAccess: access, nodeChannels: channels, nodeServices: services, nodeServiceProxy: remote,
  runtimeRouter,
  nodeServiceIdentity: { nodeId: context.nodeId, organizationId: context.organizationId, authorize: (token, input) => access.authorizeChannel(token, input) },
}
const documentCatalogHandlers = createDocumentCatalogHandlers(documentCatalog, audit)
const localDocuments = new LocalDocumentBroker({ cfg, nodeId: context.nodeId, computerAccess, users, projects, collaboration,
  organizationId: context.organizationId, catalog: documentCatalogHandlers, accessMonitor: localMonitor })
const documentDeps = { instances: manager, users, projects, collaboration, principals: keys.signer, audit, catalog: documentCatalog,
  maxResponseBytes: cfg.upstreamResponseLimitBytes, upstreamTimeoutMs: cfg.upstreamTimeoutMs, local: localDocuments }
const local = createProxyHandlers(deps, keys.signer)
const runtime = createRuntimeApiHandler({ documentStore: input => localDocuments.serveRuntimeStore(input),
  workspaceCatalog: new PostgresWorkspaceCatalog(context),
  documentCatalogSync: input => localDocuments.reconcileRuntimeCatalog(input),
  documentCatalogAuthorize: documentCatalogHandlers.authorize, documentCatalogOverview: documentCatalogHandlers.overview, documentCatalogHistory: documentCatalogHandlers.history, context, instances: repository, conversations: new PostgresConversationStore(pool),
  principals: keys.signer, resourceBudget: resources, accessMonitor: localMonitor, collaboration, governance })
const server = createGatewayServer(deps, { ...local, runtime,
  workbenchCatalog: createGatewayWorkbenchCatalogHandler({ instances: manager, collaboration, principals: keys.signer,
    workspaceCatalog: new PostgresWorkspaceCatalog(context, context.nodeId), maxResponseBytes: cfg.upstreamResponseLimitBytes,
    upstreamTimeoutMs: cfg.upstreamTimeoutMs }),
  documentScope: createGatewayDocumentScopeHandler(documentDeps), documentTransferUpload: createGatewayDocumentTransferUploadHandler(documentDeps),
  browserDocuments: createBrowserDocumentHandler({ transfer: documentDeps, locations: deps.documentLocations, organizationId: context.organizationId,
    origin: cfg.publicOrigins[0], responseLimit: cfg.upstreamResponseLimitBytes }), admin: createAdminApiHandler(deps),
  runtimeAuthorize: async req => {
    const token = req.headers.authorization?.slice('Bearer '.length)
    return token !== undefined && await repository.authenticateRuntimeToken(token) !== null
  },
})
const intake = createUsageIntakeServer(governance)
await Promise.all([
  new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
  new Promise(resolve => intake.listen(0, '127.0.0.1', resolve)),
])
cfg.port = server.address().port; cfg.intakePort = intake.address().port
const base = `http://127.0.0.1:${cfg.port}`
cfg.publicOrigins.push(base)
await nodeConfiguration.initialize()
if (nodeName === 'center') await pool.query('UPDATE harness.deployment_topology SET primary_origin=$2,revision=revision+1 WHERE organization_id=$1 AND enabled AND primary_node_id=$3', [context.organizationId, base, context.nodeId])
let stopping
async function stop() {
  return stopping ??= (async () => {
    await remote.close(); await services.close(); await channels.close()
    await local.close(); await manager.stopAll(); await processOwner.close(); await monitor.close()
    for (const socket of relaySockets) socket.destroy()
    for (const listener of [server, intake, modelFixture, ...runtimeRelays]) {
      listener.closeAllConnections?.(); await new Promise(resolve => listener.close(resolve))
    }
    await localDocuments.dispose()
    await pool.end()
  })()
}
const reply = value => { if (process.connected) process.send(value) }
const directoryPolicy = { launcher: cfg.launcher, roots: cfg.projectPathRoots }
process.on('message', input => {
  void (async () => {
    if (input.kind === 'origins') { cfg.publicOrigins.push(...input.values); reply({ kind: 'origins' }) }
    else if (input.kind === 'directory-policy') {
      cfg.launcher = input.systemd ? 'systemd' : directoryPolicy.launcher
      cfg.projectPathRoots = input.systemd ? [root] : directoryPolicy.roots
      const owner = await repository.owner({ kind: 'project', id: input.projectId })
      reply({ kind: 'directory-policy', origin: owner?.projectOrigin })
    }
    else if (input.kind === 'relay') { await relayFor(input.runtimeId, input.userId); reply({ kind: 'relay' }) }
    else if (input.kind === 'credential-status') {
      const issued = await Promise.all((credentials.get(input.runtimeId) ?? []).map(async value => ({
        generation: value.generation, accepted: await repository.authenticateRuntimeToken(value.token) !== null,
      })))
      reply({ kind: 'credential-status', issued })
    }
    else if (input.kind === 'quiesce') { await manager.stopAll(); reply({ kind: 'quiesce' }) }
    else if (input.kind === 'status') reply({ kind: 'status', resident: manager.capacitySnapshot().resident, state: await manager.stateOf(primaryTarget) })
    else if (input.kind === 'stop') { await stop(); reply({ kind: 'stopped' }); process.disconnect() }
    else throw new Error('Unknown node service fixture command')
  })().catch(error => reply({ kind: 'failure', message: String(error) }))
})
process.once('disconnect', () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
process.once('SIGTERM', () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
reply({ kind: 'ready', base, nodeId: context.nodeId, userId: user.id, username })
