/** Real Gateway services and shipped Web profile, controlled through fixture-only IPC. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('A disposable test database is required')
const plane = process.env.LOCAL_WEB_PLANE
assert.ok(plane === 'src' || plane === 'lib')
const root = process.env.LOCAL_WEB_ROOT
assert.ok(root)
const directoryCase = process.env.LOCAL_WEB_DIRECTORY_CASE
const documentCase = process.env.LOCAL_WEB_DOCUMENT_CASE
assert.ok(documentCase === undefined || documentCase === 'normal')
assert.ok(directoryCase === undefined || directoryCase === 'readonly' || directoryCase === 'empty' || directoryCase === 'replacement')
const repo = fileURLToPath(new URL('../../../', import.meta.url))
const load = name => import(plane === 'lib' && process.env.LOCAL_WEB_GATEWAY_ARTIFACT !== undefined
  ? pathToFileURL(join(process.env.LOCAL_WEB_GATEWAY_ARTIFACT, `${name}.js`))
  : new URL(`../../${plane}/${name}.${plane === 'src' ? 'ts' : 'js'}`, import.meta.url))
const [{ loadConfig }, { createPostgresPool }, { resolvePostgresRuntimeContext },
  { PostgresUserService }, { PostgresAuthService }, { PostgresProjectService }, { PostgresAuditService },
  { PostgresModelGovernanceService }, { PostgresCollaborationService }, { PostgresInstanceRepository },
  { PostgresConversationStore }, { OrganizationModelCredentialCipher, loadOrganizationModelCredentialKey }, { PostgresAccessMonitor },
  { loadPrincipalKeys }, { NodeResourceBudget }, { InstanceManager }, { LocalLauncher },
  { createGatewayServer }, { createProxyHandlers }, { createRuntimeApiHandler },
  { writeModelGovernanceFile, writeProjectModelGovernanceFile }, { writeRuntimeGrantsFile },
  { createUsageIntakeServer }, { GatewayTunnelAccess }, { PostgresTunnelAccessStore, TunnelCredentialCipher }, { createAdminApiHandler }, { spawnNamedTunnel }] = await Promise.all([
  'config', 'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/auth-service',
  'postgres/project-service', 'postgres/audit-service', 'postgres/model-governance-service',
  'postgres/collaboration-service', 'postgres/instance-repository', 'postgres/conversation-repository',
  'organization-model-credentials', 'access-invalidation', 'principal', 'node-resource-budget', 'instances',
  'launcher', 'server', 'proxy', 'runtime-api', 'apply-model-governance', 'apply-grants', 'usage-intake', 'tunnel-access', 'postgres/tunnel-access-service', 'admin-api', 'tunnel-supervisor',
].map(load))
const [{ PostgresRuntimeCatalog }, { GatewayRuntimeRouter, LocalRuntimeAdapter }] = await Promise.all([
  load('postgres/runtime-catalog'), load('runtime-router'),
])

const cfg = loadConfig({
  HGW_ORGANIZATION_SLUG: process.env.LOCAL_WEB_ORGANIZATION, HGW_COMPUTE_NODE_NAME: 'fixture',
  HGW_PORT: process.env.LOCAL_WEB_PUBLIC_PORT, HGW_INTAKE_PORT: process.env.LOCAL_WEB_INTAKE_PORT,
  HGW_STATE_ROOT: join(root, 'state'), HGW_USERS_ROOT: join(root, 'users'),
  HGW_PROJECT_RUNTIMES_ROOT: join(root, 'project-runtimes'), HGW_PROJECTS_ROOT: join(root, 'projects'),
  HGW_USER_PROJECTS_ROOT: join(root, 'managed-projects'), HGW_DEFAULT_ENV_FILE: '', HGW_DSH_REPO_ROOT: repo,
  ...process.env.LOCAL_WEB_PICKER_AUTO === '1' ? { HGW_GUARD_PATCH: 'off' } : {},
  HGW_INSTANCE_PORT_BASE: Number(process.env.LOCAL_WEB_RUNTIME_PORT) > 1030 ? '1024' : '65530', HGW_READINESS_TIMEOUT_MS: '60000',
})
const runtimePlane = process.env.LOCAL_WEB_RUNTIME_PLANE ?? plane
assert.ok(runtimePlane === 'src' || runtimePlane === 'lib')
cfg.dshCommand = [process.execPath, ...(runtimePlane === 'src' ? ['--import', import.meta.resolve('tsx/esm'), join(repo, 'apps/cli/src/bin.ts')]
  : [join(repo, 'apps/cli/lib/bin.js')]), 'web', '--no-open', '--port', '0']
const pool = createPostgresPool(databaseUrl, { max: 6 })
const context = await resolvePostgresRuntimeContext(pool, cfg.organizationSlug, cfg.computeNodeName)
const users = new PostgresUserService(context, cfg), auth = new PostgresAuthService(context, cfg)
const projects = new PostgresProjectService(context, cfg), audit = new PostgresAuditService(context)
let user = await users.getByUsername('fixture')
if (user === null) {
  user = await users.create({ username: 'fixture', password: 'fixture-password', role: 'admin' })
  await users.changeOwnPassword(user.id, 'fixture-password')
  const peer = await users.create({ username: 'peer', password: 'fixture-password' })
  await users.changeOwnPassword(peer.id, 'fixture-password')
  const project = await projects.create({ name: 'Shared', createdBy: user.id })
  await projects.setMember(project.id, user.id, 'rw'); await projects.setMember(project.id, peer.id, directoryCase === 'readonly' ? 'ro' : 'rw')
}
const personalOwner = directoryCase === 'readonly' || directoryCase === 'replacement' ? await users.getByUsername('peer') : user
assert.ok(personalOwner)
const selectedProject = (await projects.list()).find(project => project.name === 'Shared')
assert.ok(selectedProject)
await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
  SELECT organization_id,$2,id,true FROM harness.users WHERE organization_id=$1
  ON CONFLICT(organization_id,node_id,user_id) DO UPDATE SET enabled=true`, [context.organizationId, context.nodeId])
const keys = loadPrincipalKeys(cfg.principalKeyDir, cfg.organizationSlug, 300000)
const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(loadOrganizationModelCredentialKey(cfg.organizationModelCredentialKeyFile)), 'UTC')
const resources = new NodeResourceBudget(pool, context.organizationId, context.nodeId, { ...cfg.resourceBudget, sampleMs: 20, staleMs: 300000 })
await resources.configure()
await resources.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 64 })
const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
const manager = new InstanceManager(repository, cfg, new LocalLauncher(cfg), { principalPublicKey: keys.publicKeyPem }, resources)
const target = process.env.LOCAL_WEB_SCOPE === 'personal' ? { kind: 'user', id: personalOwner.id } : { kind: 'project', id: selectedProject.id }
await manager.stateOf(target)
const runtimeStorage = await manager.storageOf(target)
let foreignHomePath
if (directoryCase === 'replacement') {
  const storage = await manager.storageOf({ kind: 'user', id: user.id })
  foreignHomePath = storage.homePath
  await mkdir(join(foreignHomePath, 'private-other-account'), { recursive: true })
  await mkdir(join(selectedProject.path, 'permitted-owned'), { recursive: true })
}
await pool.query(`UPDATE harness.instances i SET port=$1
  FROM harness.${target.kind === 'user' ? 'users' : 'projects'} owner
  WHERE owner.id=${target.kind === 'user' ? 'i.user_id' : 'i.project_id'} AND owner.organization_id=i.organization_id
    AND i.organization_id=$2 AND owner.public_id=$3`, [Number(process.env.LOCAL_WEB_RUNTIME_PORT), context.organizationId, target.id])
manager.beforeStart = async runtime => {
  if (runtime.kind === 'user') await writeModelGovernanceFile(cfg, governance, user)
  else await writeProjectModelGovernanceFile(cfg, governance, { kind: 'project', id: selectedProject.id, name: selectedProject.name, path: selectedProject.path })
  writeRuntimeGrantsFile(runtime.dshHome, [{ path: runtime.homePath, mode: 'rw' }])
}
const monitor = new PostgresAccessMonitor(context, 60000); await monitor.synchronize()
let documentBroker
if (documentCase !== undefined) {
  const [{ LocalDocumentBroker }, { createDocumentCatalogHandlers }, { PostgresDocumentCatalogService }] = await Promise.all([
    'documents-local', 'document-catalog', 'postgres/document-catalog-service',
  ].map(load))
  const catalog = createDocumentCatalogHandlers(new PostgresDocumentCatalogService(context, cfg.archiveRetentionDays, context.nodeId), audit)
  documentBroker = new LocalDocumentBroker({ cfg, nodeId: context.nodeId, organizationId: context.organizationId,
    users, projects, collaboration: new PostgresCollaborationService(context, context.nodeId), catalog, accessMonitor: monitor })
  await mkdir(join(runtimeStorage.homePath, 'documents'), { recursive: true })
  await writeFile(join(runtimeStorage.homePath, 'documents', 'provider.txt'), 'managed document bytes')
}
const runtime = createRuntimeApiHandler({ context, instances: repository, conversations: new PostgresConversationStore(pool),
  principals: keys.signer, resourceBudget: resources, accessMonitor: monitor,
  ...documentBroker === undefined ? {} : { documentStore: invocation => documentBroker.serveRuntimeStore(invocation) },
  collaboration: new PostgresCollaborationService(context), governance })
const cloudflareCalls = { creates: 0, tokens: 0, namedStarts: 0, namedAllocations: 0, zoneRequests: 0, zoneAborts: 0 }
const cloudflare = createServer((req, res) => {
  req.resume()
  const path = req.url
  if (path.startsWith('/client/v4/zones?')) {
    cloudflareCalls.zoneRequests++
    if (existsSync(join(root, 'hold-zone-request'))) {
      res.once('close', () => { if (!res.writableFinished) cloudflareCalls.zoneAborts++ })
      return
    }
  }
  let result, status = 200
  if (path.startsWith('/client/v4/zones?')) result = [{ id: 'fixture-zone', name: 'example.com', account: { id: 'fixture-account' } }]
  else if (path.endsWith('/cfd_tunnel') && req.method === 'POST') { cloudflareCalls.creates++; result = { id: 'fixture-tunnel' } }
  else if (path.endsWith('/token')) { cloudflareCalls.tokens++; if (cloudflareCalls.tokens === 1) status = 503; else result = 'synthetic-run-token' }
  else if (path.includes('/dns_records?')) result = []
  else if (path.endsWith('/configurations') || path.endsWith('/dns_records')) result = {}
  else status = 404
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ success: status === 200, errors: status === 200 ? [] : [{ message: 'fixture retry' }], result: result ?? null }))
})
await new Promise(resolve => cloudflare.listen(0, '127.0.0.1', resolve))
const tunnelAccess = new GatewayTunnelAccess({
  store: new PostgresTunnelAccessStore(context), cipher: new TunnelCredentialCipher(loadOrganizationModelCredentialKey(cfg.tunnelCredentialKeyFile)),
  startupTimeoutMs: cfg.tunnelStartupTimeoutMs, closeTimeoutMs: cfg.tunnelCloseTimeoutMs, probeIntervalMs: cfg.tunnelProbeIntervalMs,
  organizationId: context.organizationId, nodeId: context.nodeId, target: `http://127.0.0.1:${cfg.port}`, stateDir: cfg.tunnelStateDir,
  resolveBinary: async () => ({ path: join(root, 'cloudflared-fixture'), version: 'fixture', source: 'env' }),
  spawnNamed: (bin, token, options) => { cloudflareCalls.namedAllocations++; return spawnNamedTunnel(bin, token, options) },
  fetchImpl: (url, init) => { const path = new URL(url); return fetch(`http://127.0.0.1:${cloudflare.address().port}${path.pathname}${path.search}`, init) },
})
const startNamed = tunnelAccess.startNamed.bind(tunnelAccess)
tunnelAccess.startNamed = input => { cloudflareCalls.namedStarts++; return startNamed(input) }
await tunnelAccess.view()
const runtimeCatalog = new PostgresRuntimeCatalog(context, cfg.runtimeCatalog, context.nodeId)
const deps = { cfg, users, auth, projects, audit, instances: manager, governance, accessMonitor: monitor,
  collaboration: new PostgresCollaborationService(context), tunnelAccess, runtimeCatalog }
deps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(deps), { catalog: runtimeCatalog, localNodeId: context.nodeId })
const proxies = createProxyHandlers(deps, keys.signer), server = createGatewayServer(deps, { ...proxies, runtime, admin: createAdminApiHandler(deps) })
if (directoryCase === 'empty') {
  const prepare = manager.beforeStart
  manager.beforeStart = async runtime => {
    await prepare(runtime)
    writeRuntimeGrantsFile(runtime.dshHome, [])
  }
}
if (directoryCase === 'readonly') {
  const prepare = manager.beforeStart
  manager.beforeStart = async runtime => {
    await prepare(runtime)
    const witness = join(root, 'environment-witness.mjs')
    await writeFile(witness, `import { writeFileSync } from 'node:fs'; export const name = 'environment-witness'; export function apply() { writeFileSync(${JSON.stringify(join(runtime.dshHome, 'environment-witness.json'))}, JSON.stringify({ grants: process.env.DSH_DIRECTORY_GRANTS })); }\n`)
    const patch = join(runtime.dshHome, 'cordis.patch.yml')
    await writeFile(patch, await readFile(patch, 'utf8') + `\n- insert:\n    - name: ${JSON.stringify(pathToFileURL(witness).href)}\n`)
  }
}
const intake = createUsageIntakeServer(governance)
await Promise.all([
  new Promise(resolve => server.listen(0, '127.0.0.1', resolve)),
  new Promise(resolve => intake.listen(0, '127.0.0.1', resolve)),
])
const dshHome = runtimeStorage.dshHome
let stopping
async function stop() {
  return stopping ??= (async () => {
    await tunnelAccess.shutdown(); await manager.stopAll(); await documentBroker?.dispose(); await proxies.close()
    for (const listener of [server, intake, cloudflare]) {
      listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve))
    }
    await monitor.close(); await pool.end()
  })()
}
const reply = value => { if (process.connected) process.send(value) }
process.on('message', input => {
  void (async () => {
    assert.ok(input && typeof input === 'object')
    if (input.kind === 'status') {
      reply({ kind: 'status', state: await manager.stateOf(target), generation: await manager.generationOf(target),
        resident: manager.capacitySnapshot().resident, admittedStarts: (await resources.snapshot()).outcomes.runtime_starts_admitted })
    } else if (input.kind === 'stop-runtime') {
      await manager.stop({ ...target, runtimeId: runtimeStorage.runtimeId })
      reply({ kind: 'stop-runtime' })
    } else if (input.kind === 'tunnel-status') {
      reply({ kind: 'tunnel-status', ...cloudflareCalls, view: await tunnelAccess.view() })
    } else if (input.kind === 'reuse-runtime') {
      try {
        const result = await manager.ensureRunning(target.kind === 'user' ? user
          : { kind: 'project', id: selectedProject.id, name: selectedProject.name, path: selectedProject.path })
        reply({ kind: 'reuse-runtime', generation: result.generation })
      } catch (error) { reply({ kind: 'reuse-runtime', code: error.code, reason: error.reason }) }
    } else if (input.kind === 'stop') { await stop(); reply({ kind: 'stopped' }); process.disconnect() }
    else if (input.kind === 'diagnostics') {
      const log = await readFile(join(dshHome, 'logs/runtime.log'), 'utf8')
      reply({ kind: 'diagnostics', text: log.replace(/token=[\w-]+/gu, 'token=[fixture-token]').slice(-12000) })
    } else throw new Error('Unknown Web assembly fixture command')
  })().catch(error => reply({ kind: 'failure', message: String(error) }))
})
process.once('disconnect', () => { void stop().then(() => process.exit(0), () => process.exit(1)) })
reply({ kind: 'ready', backendPort: server.address().port, intakePort: intake.address().port, dshHome,
  userId: personalOwner.id, homePath: runtimeStorage.homePath, projectPath: selectedProject.path,
  projectId: selectedProject.id, scope: target.kind, runtimeId: runtimeStorage.runtimeId, foreignHomePath })
