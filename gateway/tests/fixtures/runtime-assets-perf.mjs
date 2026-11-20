/** One fresh built HTTP resource sample; only the Runtime body and supervised process handle are controlled. */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { PostgresAccessMonitor } from '../../lib/access-invalidation.js'
import { InstanceManager, INSTANCE_PROFILE } from '../../lib/instances.js'
import { computeLaunchStamps } from '../../lib/launch-stamp.js'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../../lib/principal.js'
import { createProxyHandlers } from '../../lib/proxy.js'
import { RuntimeAssets } from '../../lib/runtime-assets.js'
import { PostgresRuntimeAssetAdmission } from '../../lib/runtime-asset-admission.js'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../../lib/runtime-router.js'
import { createGatewayServer } from '../../lib/server.js'
import { PostgresAuthService } from '../../lib/postgres/auth-service.js'
import { PostgresAuditService } from '../../lib/postgres/audit-service.js'
import { PostgresCollaborationService } from '../../lib/postgres/collaboration-service.js'
import { createPostgresPool } from '../../lib/postgres/database.js'
import { PostgresInstanceRepository } from '../../lib/postgres/instance-repository.js'
import { PostgresProjectService } from '../../lib/postgres/project-service.js'
import { PostgresRuntimeCatalog } from '../../lib/postgres/runtime-catalog.js'
import { PostgresUserService } from '../../lib/postgres/user-service.js'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('Resource diagnostic child requires a disposable database')
let raw = ''
for await (const chunk of process.stdin) raw += String(chunk)
const input = JSON.parse(raw)
const pool = createPostgresPool(databaseUrl, { max: 4 })
const clients = new Set()
pool.on('connect', client => { clients.add(client) })
const context = { ...input.context, pool }
const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, input.context.organizationSlug, 30_000)
const payload = Buffer.alloc(262144, 'a')
const upstream = createServer((req, res) => {
  req.resume()
  const claims = signer.verify(req.headers[PRINCIPAL_HEADER])
  assert.equal(claims.runtime.runtimeId, input.target.runtimeId)
  assert.equal(claims.purpose, input.variant === 'resource' ? 'runtime-asset' : undefined)
  res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': payload.length, 'cache-control': 'private, max-age=31536000, immutable' })
  res.end(payload)
})
const listen = async server => {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${server.address().port}`
}
const close = async server => {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
let monitor, instances, proxies, assets, server
try {
  const upstreamOrigin = await listen(upstream)
  const repository = new PostgresInstanceRepository(context, input.cfg.instancePortBase)
  const stamp = [...computeLaunchStamps(input.cfg, '', INSTANCE_PROFILE).stamps][0]
  await pool.query('UPDATE harness.instances SET port=$2,launch_stamp=$3 WHERE runtime_id=$1', [input.target.runtimeId, Number(new URL(upstreamOrigin).port), stamp])
  instances = new InstanceManager(repository, input.cfg, { instancesOutliveGateway: true,
    attach: () => ({ hasExited: () => false, isAlive: async () => true, terminate: async () => {} }),
    start: async () => { throw new Error('Warm resource diagnostic cannot start a Runtime') } })
  monitor = new PostgresAccessMonitor(context, 60_000)
  await monitor.synchronize()
  assert.ok(await instances.liveEndpoint(input.target), 'Controlled ready endpoint must pass its recorded launch stamp')
  const users = new PostgresUserService(context, input.cfg), projects = new PostgresProjectService(context, input.cfg)
  const runtimeCatalog = new PostgresRuntimeCatalog(context, input.cfg.runtimeCatalog, context.nodeId)
  const deps = { cfg: input.cfg, auth: new PostgresAuthService(context, input.cfg), users, projects,
    audit: new PostgresAuditService(context), instances, runtimeCatalog, accessMonitor: monitor,
    collaboration: new PostgresCollaborationService(context) }
  deps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(deps), { catalog: runtimeCatalog, localNodeId: context.nodeId })
  proxies = createProxyHandlers(deps, signer)
  const work = new Set()
  let runtimeAssets
  if (input.variant === 'resource') {
    assets = new RuntimeAssets({ cfg: input.cfg, localNodeId: context.nodeId,
      admission: new PostgresRuntimeAssetAdmission(context), instances, monitor, signer })
    runtimeAssets = { handle: async (...args) => {
      const pending = assets.handle(...args)
      work.add(pending)
      try { return await pending } finally { work.delete(pending) }
    } }
  }
  server = createGatewayServer(deps, { ...proxies, ...(runtimeAssets === undefined ? {} : { runtimeAssets }),
    proxy: async (req, res, current) => {
      const pending = proxies.proxy(req, res, current)
      work.add(pending)
      try { await pending } finally { work.delete(pending) }
    } })
  const origin = await listen(server)
  input.cfg.publicOrigins.push(origin)
  const path = `${origin}/plugins/combo.js??fixture/client.js&rev=012345abcdef&dshRuntime=${input.target.runtimeId}`
  const headersMs = [], completeMs = [], settledMs = []
  const run = async measured => {
    const start = performance.now()
    const response = await fetch(path, { headers: { cookie: `hgw_session=${input.token}` } })
    const headersAt = performance.now() - start
    const body = Buffer.from(await response.arrayBuffer())
    assert.equal(response.status, 200, body.toString('utf8', 0, 200))
    assert.ok(body.equals(payload))
    const completeAt = performance.now() - start
    await Promise.all([...work])
    if (measured) { headersMs.push(headersAt); completeMs.push(completeAt); settledMs.push(performance.now() - start) }
  }
  for (let index = 0; index < 10; index++) await run(false)
  const before = (await pool.query('SELECT last_activity_at::text activity FROM harness.instances WHERE runtime_id=$1', [input.target.runtimeId])).rows[0].activity
  for (let index = 0; index < 50; index++) await run(true)
  const originals = [...clients].map(client => [client, client.query])
  let sqlStatements = 0
  for (const [client, query] of originals) client.query = function (...args) { sqlStatements += 1; return Reflect.apply(query, this, args) }
  try { for (let index = 0; index < 50; index++) await run(false) }
  finally { for (const [client, query] of originals) client.query = query }
  const after = (await pool.query('SELECT last_activity_at::text activity FROM harness.instances WHERE runtime_id=$1', [input.target.runtimeId])).rows[0].activity
  assert.equal(before !== after, input.variant === 'ordinary')
  assert.ok(globalThis.gc)
  globalThis.gc()
  process.stdout.write(JSON.stringify({ variant: input.variant, scope: input.scope, headersMs, completeMs, settledMs, sqlStatements,
    activityChanged: before !== after, peakKiB: process.resourceUsage().maxRSS, steadyKiB: process.memoryUsage().rss / 1024 }) + '\n')
} finally {
  await assets?.close()
  await proxies?.close()
  if (server !== undefined) await close(server)
  await close(upstream)
  await monitor?.close()
  await instances?.stopAll()
  await pool.end()
}
