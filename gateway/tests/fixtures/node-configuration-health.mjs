/** Keyless Gateway health and native restart ownership through source or compiled entrypoints. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === undefined || mode === 'lib')
assert.ok(process.platform === 'darwin' || process.platform === 'linux')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createGatewayServer }, { AuthService }, { AuditService }, { openDb }, { InstanceManager }, { ProjectService },
  { UserService }, { createNodeConfigurationHost }, { NodeConfigurationStore, readNodeConfiguration },
  { loadConfig }, { NODE_SERVICE_TARGET_HEADER }] = await Promise.all([
  'server', 'auth', 'audit', 'db', 'instances', 'projects', 'users', 'node-config-host', 'node-config-store', 'config', 'node-service-stream',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const originalPath = process.env.PATH, originalDatabase = process.env.HGW_DATABASE_URL
const transcript = []

async function endpoint(marker, release = false) {
  try { return await (await fetch(`${marker.url}/${release ? 'release/' : ''}${marker.token}`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(1000) })).text() }
  catch (error) { if (['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code)) return undefined; throw error }
}
async function bounded(pending, timeoutMs) {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Node configuration acceptance timed out')), timeoutMs) })]) }
  finally { clearTimeout(timer) }
}
async function scenario(hold, verify) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-node-health-replay-')), lifetime = new AbortController(), cleanups = []
  let marker, pending, primaryError
  const pool = new pg.Pool({ connectionString: 'postgres://synthetic.invalid/never-connected' })
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(root, 'fixture.json'), JSON.stringify({ hold: hold ? (process.platform === 'darwin' ? 'kickstart' : 'restart') : 'none', ignoreTerm: true }))
    const binary = join(root, process.platform === 'darwin' ? 'launchctl' : 'systemctl')
    await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL('./systemctl-client.mjs', import.meta.url), 'utf8')}`)
    await chmod(binary, 0o700)
    process.env.PATH = `${root}:${originalPath ?? ''}`
    process.env.HGW_DATABASE_URL = 'postgres://synthetic.invalid/not-a-credential'
    const environment = { HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
      HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
      HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
      HGW_SYSTEMD_COMMAND_TIMEOUT_MS: '5000', HGW_READINESS_TIMEOUT_MS: '100', HGW_UPSTREAM_RESPONSE_LIMIT_BYTES: '512' }
    const cfg = loadConfig(environment), db = openDb(join(root, 'gateway.sqlite'))
    cleanups.push(async () => { db.close() })
    const context = { pool, organizationId: randomUUID(), organizationSlug: 'fixture', nodeId: randomUUID(), nodeName: 'own-node' }
    const authority = { authorize: (_actor, action) => action(), run: (_actor, action) => action(lifetime.signal, async () => '1') }
    const store = new NodeConfigurationStore(context, cfg, environment, authority)
    await store.initialize()
    const record = await readNodeConfiguration(cfg.nodeConfigFile, environment)
    assert.ok(record)
    const host = createNodeConfigurationHost(environment, context, lifetime.signal)
    const users = new UserService(db, cfg), instances = new InstanceManager(db, cfg)
    cleanups.push(() => instances.stopAll())
    const listen = async server => {
      cleanups.push(async () => {
        if (!server.listening) return
        server.closeAllConnections()
        await new Promise((done, fail) => { server.close(error => error ? fail(error) : done()) })
      })
      await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
      return server.address().port
    }
    const gateway = nodeId => createGatewayServer({ cfg, users, instances, auth: new AuthService(db, cfg),
      projects: new ProjectService(db, cfg), audit: new AuditService(db),
      nodeServiceIdentity: { nodeId, organizationId: context.organizationId, authorize: async () => { throw new Error('Health must not enter node control authorization') } },
    })
    const launch = () => { pending = host.restartAndVerify(record).then(() => ({ ok: true }), error => ({ error })); return pending }
    const witness = async () => {
      const deadline = performance.now() + 20_000
      while (marker === undefined) {
        try { marker = JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) }
        catch (error) { if (error.code !== 'ENOENT' || performance.now() >= deadline) throw error; await delay(10) }
      }
      assert.equal(await endpoint(marker), marker.token)
    }
    await verify({ root, lifetime, cfg, context, host, record, gateway, listen, launch, witness,
      closed: async () => assert.equal(await endpoint(marker), undefined) })
  } catch (error) { primaryError = error; throw error }
  finally {
    const failures = [], close = async fn => { try { await fn() } catch (error) { failures.push(error) } }
    lifetime.abort(new Error('Owned node configuration fixture cleanup'))
    if (marker !== undefined) await close(() => endpoint(marker, true))
    await close(async () => { await pending })
    for (const cleanup of cleanups.reverse()) await close(cleanup)
    await close(() => pool.end())
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath
    if (originalDatabase === undefined) delete process.env.HGW_DATABASE_URL; else process.env.HGW_DATABASE_URL = originalDatabase
    await close(() => rm(root, { recursive: true, force: true }))
    if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Node configuration acceptance cleanup failed')
  }
}

await scenario(false, async ({ root, cfg, context, host, record, gateway, listen, launch }) => {
  const foreign = gateway(randomUUID()), own = gateway(context.nodeId)
  let requestedNode
  foreign.prependListener('request', request => { requestedNode = request.headers[NODE_SERVICE_TARGET_HEADER] })
  const foreignPort = await listen(foreign), ownPort = await listen(own)
  const ordinary = await fetch(`http://127.0.0.1:${foreignPort}/healthz`)
  assert.equal(ordinary.status, 200)
  assert.equal((await ordinary.json()).configurationRevision, record.appliedRevision)
  record.applied.HGW_PORT = String(foreignPort)
  assert.equal(await host.isHealthy(record), false)
  assert.equal(requestedNode, context.nodeId)
  transcript.push('A healthy foreign Gateway with the same revision cannot acknowledge this computer.')
  record.applied.HGW_PORT = String(ownPort)
  cfg.configurationRevision = record.appliedRevision + 1
  assert.equal(await host.isHealthy(record), false)
  transcript.push('The correct computer cannot acknowledge a different configuration revision.')
  cfg.configurationRevision = record.appliedRevision
  assert.deepEqual(await launch(), { ok: true })
  const calls = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(calls.length > 0 && calls.every(call => !call.databasePresent && call.locale === 'C'))
  if (process.platform === 'linux') assert.ok(calls.every(call => call.args.includes('--no-ask-password') && call.args.includes('--no-pager')))
  transcript.push('The installed restart client excludes Gateway credentials and joins the matching Gateway revision.')
})
await scenario(true, async ({ lifetime, launch, witness, closed }) => {
  const request = launch()
  await witness(); lifetime.abort(new Error('maintenance lease lost'))
  assert.equal((await bounded(request, 2000)).error?.message, 'gateway-service-restart-failed')
  await closed()
  transcript.push('Lease cancellation closes a SIGTERM-ignoring restart client before reporting failure.')
})
await scenario(true, async ({ launch, witness, closed }) => {
  const request = launch()
  await witness()
  assert.equal((await bounded(request, 7000)).error?.message, 'gateway-service-restart-failed')
  await closed()
  transcript.push('The configured native command deadline closes an uncooperative restart client.')
})
await scenario(false, async ({ record, gateway, listen, launch }) => {
  const wrong = gateway(randomUUID())
  record.applied.HGW_PORT = String(await listen(wrong))
  const now = Date.now
  Date.now = () => 1_700_000_000_000
  try { assert.equal((await bounded(launch(), 2000)).error?.message, 'gateway-did-not-confirm-configured-revision') }
  finally { Date.now = now }
  transcript.push('A frozen wall clock does not extend the readiness deadline or accept another computer.')
})
const actual = transcript.join('\n') + '\n'
assert.equal(actual, await readFile(new URL('../expected/node-configuration-health.expected.md', import.meta.url), 'utf8'))
process.stdout.write(actual)
