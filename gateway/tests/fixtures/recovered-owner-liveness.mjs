/** Restored assignments retain occupation when real local-owner recovery cannot establish liveness. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot = '-'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const load = name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService },
  { PostgresProjectService }, { PostgresInstanceRepository }, { PostgresAuthService }, { PostgresAuditService },
  { InstanceManager, INSTANCE_PROFILE }, { LocalLauncher }, { loadConfig }, { createGatewayServer }, { createAdminApiHandler },
  { GatewayTerminalManagement }, { GatewayPrincipalSigner }, { computeLaunchStamps }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service',
  'postgres/instance-repository', 'postgres/auth-service', 'postgres/audit-service', 'instances', 'launcher',
  'config', 'server', 'admin-api', 'terminal-management', 'principal', 'launch-stamp',
].map(load))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const administration = createPostgresPool(databaseUrl, { max: 1 }), database = `recovered_owner_${randomUUID().replaceAll('-', '')}_test`
let created = false, pool, root, server
const failures = []
try {
  await administration.query(`CREATE DATABASE ${database}`); created = true
  const url = new URL(databaseUrl); url.pathname = `/${database}`; pool = createPostgresPool(url.toString(), { max: 2 })
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations/', import.meta.url)))
  root = await mkdtemp(join(tmpdir(), 'recovered-owner-liveness-'))
  const slug = `recovered-owner-${randomUUID()}`, name = 'local'
  const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Recovered owner') RETURNING id", [slug])).rows[0].id
  await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
  const context = await resolvePostgresRuntimeContext(pool, slug, name)
  const cfg = loadConfig({ HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE: name,
    HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'), HGW_PROJECTS_ROOT: join(root, 'projects'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'),
    HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '', HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
  cfg.computeNodeName = name
  const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
  const actor = await users.create({ username: 'operator', password: 'pw-12345678' })
  await users.changeOwnPassword(actor.id, 'pw-12345678')
  await pool.query("UPDATE harness.memberships member SET role='admin' FROM harness.users u WHERE u.id=member.user_id AND u.organization_id=member.organization_id AND u.organization_id=$1 AND u.public_id=$2", [organizationId, actor.id])
  const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
  await repository.initialize()
  const target = await repository.resolveTarget({ kind: 'user', id: actor.id })
  const tokenHash = createHash('sha256').update(randomUUID()).digest()
  const launchStamp = [...computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stamps][0]
  const generation = await repository.beginStart(target, Date.now(), tokenHash, 'passive', undefined, true, launchStamp)
  await repository.markReady(target, generation)
  const instances = new InstanceManager(repository, cfg, new LocalLauncher(cfg))
  const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, slug, 60_000)
  const deps = { cfg, users, projects, instances, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
    terminalManagement: new GatewayTerminalManagement({ cfg, users, projects, instances }, signer, context.nodeId) }
  server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  const origin = `http://127.0.0.1:${server.address().port}`; cfg.publicOrigins.push(origin)
  const signedIn = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'operator', password: 'pw-12345678' }) })
  await signedIn.arrayBuffer(); assert.equal(signedIn.status, 302)
  const cookie = signedIn.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
  for (const phase of ['attachment', 'probe']) {
    await pool.query('UPDATE harness.instances SET runtime_token_hash=$3 WHERE organization_id=$1 AND runtime_id=$2', [organizationId, target.runtimeId, phase === 'attachment' ? null : tokenHash])
    const response = await fetch(`${origin}/admin/api/terminals?kind=user&id=${actor.id}`, { headers: { cookie } })
    const result = await response.json()
    assert.equal(response.status, 503, JSON.stringify(result)); assert.equal(result.code, 'INSTANCE_UNAVAILABLE')
    assert.equal(result.error, 'Runtime supervision is unavailable. Retry after its state is confirmed.')
    assert.equal(await repository.stateOf(target), 'ready'); assert.equal(await repository.generationOf(target), generation)
    assert.equal(instances.capacitySnapshot().resident, 1)
    console.log(JSON.stringify({ scenario: `recovered-owner-${phase}`, status: response.status, code: result.code, generationRetained: true, state: 'ready', resident: 1 }))
  }
  // This read-only manager launches no process; the restored assignment retains its independent owner.
} catch (error) { failures.push(error) } finally {
  const close = async action => { try { await action() } catch (error) { failures.push(error) } }
  if (server?.listening) await close(() => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) }))
  if (pool !== undefined) await close(() => pool.end())
  if (created) await close(() => administration.query(`DROP DATABASE ${database}`))
  await close(() => administration.end())
  if (root !== undefined) await close(() => rm(root, { recursive: true, force: true }))
}
if (failures.length > 0) throw new AggregateError(failures, 'Recovered owner HTTP verification or cleanup failed')
