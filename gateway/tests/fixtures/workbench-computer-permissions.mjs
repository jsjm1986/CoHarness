/** Authenticated account catalog through production routing with an unavailable personal Runtime. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode, artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
  { loadConfig }, { PostgresRuntimeManagement }, { PostgresRuntimeCatalog }, { PostgresCollaborationService }, { PostgresConversationStore },
  { GatewayRuntimeRouter, LocalRuntimeAdapter }, { GatewayPrincipalSigner }, { createGatewayWorkbenchCatalogHandler }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'config', 'runtime-management', 'postgres/runtime-catalog',
  'postgres/collaboration-service', 'postgres/conversation-repository', 'runtime-router', 'principal', 'workbench',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const { PersonalNodeIndex } = await import(new URL(`personal-index.${mode === 'src' ? 'ts' : 'js'}`, base))
const { workbenchRows } = await import(new URL(`workbench-rows.${mode === 'src' ? 'ts' : 'js'}`, base))
const { PostgresWorkspaceCatalog } = await import(new URL(`workspace-catalog.${mode === 'src' ? 'ts' : 'js'}`, base))
const pool = createPostgresPool(url, { max: 4, application_name: `workbench-computers-${randomUUID()}` })
const root = await mkdtemp(join(tmpdir(), 'workbench-computers-'))
let organizationId, gateway, manager, personalIndex, primaryError
async function removeOrganization(id) {
  const tables = (await pool.query("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
  for (let pass = 0; pass < 12; pass += 1) {
    let blocked = false
    for (const { table_name: table } of tables) {
      try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [id]) }
      catch (error) { if (error.code === '23503') blocked = true; else throw error }
    }
    if (!blocked) break
  }
  await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [id]); await pool.query('DELETE FROM harness.organizations WHERE id=$1', [id])
}

try {
  await runMigrations(pool, process.env.DSH_AUDIT_WORKBENCH_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const slug = `workbench-${randomUUID()}`
  organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Workbench computers') RETURNING id", [slug])).rows[0].id
  for (const name of ['computer-a', 'computer-b']) await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
  const a = await resolvePostgresRuntimeContext(pool, slug, 'computer-a'), b = await resolvePostgresRuntimeContext(pool, slug, 'computer-b')
  const configuration = name => loadConfig({ HGW_USERS_ROOT: join(root, name, 'users'), HGW_STATE_ROOT: join(root, name, 'state'),
    HGW_PROJECTS_ROOT: join(root, name, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, name, 'user-projects'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, name, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, name, 'units'), HGW_DEFAULT_ENV_FILE: '',
    HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: name, HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
  const cfgA = configuration('computer-a'), cfg = configuration('computer-b'), usersA = new PostgresUserService(a, cfgA)
  const admin = await usersA.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
  const user = await usersA.create({ username: 'executor', password: 'pw-12345678' })
  const stranger = await usersA.create({ username: 'stranger', password: 'pw-12345678' })
  const repositoryA = new PostgresInstanceRepository(a, cfgA.instancePortBase), repositoryB = new PostgresInstanceRepository(b, cfg.instancePortBase)
  const primary = (await repositoryA.targetsForOwner({ kind: 'user', id: user.id }))[0]; assert.ok(primary?.runtimeId)
  const second = await new PostgresRuntimeManagement(a, cfgA).allocate(admin, user.id, { requestId: randomUUID() })
  const userUuid = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, user.id])).rows[0].id
  const strangerUuid = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, stranger.id])).rows[0].id
  for (const uuid of [userUuid, strangerUuid]) await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, b.nodeId, uuid])
  const remote = await new PostgresRuntimeManagement(b, cfg).allocate(admin, user.id, { requestId: randomUUID() })
  const strangerRemote = await new PostgresRuntimeManagement(b, cfg).allocate(admin, stranger.id, { requestId: randomUUID() })
  const store = new PostgresConversationStore(pool), labels = new Map()
  for (const [label, runtimeId, owner] of [['a-primary', primary.runtimeId, userUuid], ['a-secondary', second.runtimeId, userUuid],
    ['b-primary', remote.runtimeId, userUuid], ['stranger-b', strangerRemote.runtimeId, strangerUuid]]) {
    const id = randomUUID(); labels.set(id, label)
    await store.forRuntime({ organizationId, runtimeId }).create({ id, organizationId, runtimeId, creatorUserId: owner, visibility: 'personal',
      sessionFormatVersion: 3, createdAt: Date.now(), title: `${label} private title`, cwd: `/fixture/${label}` })
  }
  const users = new PostgresUserService(b, cfg), projects = new PostgresProjectService(b, cfg), collaboration = new PostgresCollaborationService(b)
  await users.changeOwnPassword(user.id, 'pw-12345678'); await users.changeOwnPassword(stranger.id, 'pw-12345678')
  manager = new InstanceManager(repositoryB, cfg)
  let unavailableReads = 0
  manager.ensureRunning = async () => { unavailableReads += 1; throw new Error('Controlled unavailable personal Runtime') }
  const catalog = new PostgresRuntimeCatalog(b, cfg.runtimeCatalog)
  const deps = { cfg, users, projects, collaboration, instances: manager, runtimeCatalog: catalog,
    runtimeRouter: new GatewayRuntimeRouter(new LocalRuntimeAdapter({ projects, collaboration, instances: manager }), { catalog, localNodeId: b.nodeId }),
    auth: new PostgresAuthService(b, cfg), audit: new PostgresAuditService(b) }
  const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, slug, 60_000)
  let workbenchCatalog = createGatewayWorkbenchCatalogHandler({ instances: manager, collaboration, principals,
    maxResponseBytes: cfg.upstreamResponseLimitBytes, upstreamTimeoutMs: cfg.upstreamTimeoutMs })
  personalIndex = new PersonalNodeIndex(root)
  const localCatalog = new PostgresWorkspaceCatalog(b,b.nodeId,personalIndex)
  gateway = createGatewayServer(deps, { workbenchRows: workbenchRows(b, localCatalog, collaboration, cfg.runtimeCatalog), workbenchCatalog: (...args) => workbenchCatalog(...args) })
  await new Promise((ready, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', ready) })
  cfg.port = gateway.address().port
  const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
  async function login(person) {
    const response = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual',
      headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: person.username, password: 'pw-12345678' }) })
    await response.arrayBuffer(); assert.equal(response.status, 302)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); return cookie
  }
  const cookie = await login(user), strangerCookie = await login(stranger)
  async function observe(stage, currentCookie, selectedRuntime) {
    const before = unavailableReads
    const response = await fetch(`${origin}/account/api/workbench/catalog?dshRuntime=${selectedRuntime}`, { headers: { cookie: currentCookie } })
    const value = await response.json()
    console.log(JSON.stringify({ stage, status: response.status, personalComplete: value.personalComplete ?? null,
      unavailableRuntimeObserved: unavailableReads > before, selectedComputer: value.environment?.nodeId === b.nodeId ? 'computer-b' : null,
      items: (value.items ?? []).map(row => ({ label: labels.get(row.sessionId) ?? 'foreign', title: row.title ?? null, cwd: row.cwd ?? null }))
        .sort((left, right) => left.label.localeCompare(right.label) || (left.title ?? '').localeCompare(right.title ?? '')) }))
  }
  await observe('both-computers-granted', cookie, remote.runtimeId)
  await observe('stranger-before-revocation', strangerCookie, strangerRemote.runtimeId)
  await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND user_id=$2 AND node_id=$3', [organizationId, userUuid, a.nodeId])
  await observe('source-computer-revoked', cookie, remote.runtimeId)
  await observe('stranger-after-revocation', strangerCookie, strangerRemote.runtimeId)
  const before = (await pool.query('SELECT runtime_id,generation,observed_state FROM harness.instances WHERE organization_id=$1 ORDER BY runtime_id', [organizationId])).rows
  labels.set('cache-only-root', 'cached-only')
  for (const [label, runtimeId, owner, context] of [['a-primary', primary.runtimeId, user.id, a], ['a-secondary', second.runtimeId, user.id, a],
    ['b-primary', remote.runtimeId, user.id, b], ['stranger-b', strangerRemote.runtimeId, stranger.id, b]]) {
    const assignment = before.find(row => row.runtime_id === runtimeId)
    await new PostgresWorkspaceCatalog(context).publish({ organizationId, target: { kind: 'user', id: owner, runtimeId },
      generation: Number(assignment.generation) }, { revision: 1, items: [], conversations: [{ sessionId: 'cache-only-root',
      title: `cached-${label} title`, cwd: `/cached/${label}`, updatedAt: 1, blank: false }] })
  }
  const cached = new PostgresWorkspaceCatalog(b)
  workbenchCatalog = createGatewayWorkbenchCatalogHandler({ instances: manager, collaboration, principals, workspaceCatalog: cached,
    maxResponseBytes: cfg.upstreamResponseLimitBytes, upstreamTimeoutMs: cfg.upstreamTimeoutMs })
  await pool.query('UPDATE harness.computer_use_permissions SET enabled=true WHERE organization_id=$1 AND user_id=$2 AND node_id=$3', [organizationId, userUuid, a.nodeId])
  await observe('cached-both-computers-stopped', cookie, remote.runtimeId)
  const roots = await workbenchCatalog(user, new AbortController().signal)
  assert.equal(new Set(roots.items.filter(row => row.sessionId === 'cache-only-root').map(row => row.runtime.runtimeId)).size, 3)
  await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND user_id=$2 AND node_id=$3', [organizationId, userUuid, a.nodeId])
  await observe('cached-source-computer-revoked', cookie, remote.runtimeId)
  await observe('cached-independent-account', strangerCookie, strangerRemote.runtimeId)
  const rowsUrl = new URL(`/account/api/workbench/rows?dshTarget=personal&limit=1&dshRuntime=${remote.runtimeId}`,origin)
  const readPage = (url, session) => fetch(url, { headers: { cookie: session } })
  const first = await readPage(rowsUrl, cookie); assert.equal(first.status, 200)
  assert.equal(first.headers.get('x-dsh-runtime-id'), remote.runtimeId)
  const page1 = await first.json(); assert.ok(page1.nextCursor); assert.equal(page1.items.length, 1)
  rowsUrl.searchParams.set('cursor', page1.nextCursor)
  const next = await readPage(rowsUrl, cookie); assert.equal(next.status, 200)
  const page2 = await next.json(); assert.equal(page2.items.length, 1); assert.equal(page2.nextCursor,null)
  assert.deepEqual(new Set([...page1.items, ...page2.items].map(row => row.title)), new Set(['b-primary private title','cached-b-primary title']))
  rowsUrl.searchParams.set('q','irrelevant')
  assert.equal((await readPage(rowsUrl, cookie)).status, 400)
  rowsUrl.searchParams.delete('cursor'); rowsUrl.searchParams.delete('q')
  assert.equal((await readPage(rowsUrl, strangerCookie)).status, 404)
  console.log(JSON.stringify({ stage: 'exact-owner-pagination', pages: 2, indexedAndLegacy: true, mismatchedCursorRejected: true, foreignRuntimeRefused: true }))
  await assert.rejects(localCatalog.promotePersonal(admin.id,remote.runtimeId),/complete current directory publication/)
  const existingSession=[...labels].find(([,label])=>label==='b-primary')[0]
  const source={organizationId,target:{kind:'user',id:user.id,runtimeId:remote.runtimeId},generation:Number(before.find(r=>r.runtime_id===remote.runtimeId).generation)}
  const items=[{workspaceId:'box',path:'/owner/work',title:'Box',createdAt:'2026-11-04T00:00:00.000Z',updatedAt:'2026-11-04T00:00:00.000Z',sessionIds:[existingSession]}]
  const conversations=[{sessionId:existingSession,title:'indexed history',updatedAt:2,blank:false}]
  await localCatalog.publish(source,{revision:2,items,conversations})
  await localCatalog.promotePersonal(admin.id,remote.runtimeId)
  await localCatalog.publish(source,{revision:3,items,conversations:[...conversations,{sessionId:'new-local-entry',title:'only on node',updatedAt:3,blank:false}]})
  const page=await readPage(rowsUrl,cookie); assert.equal(page.status,200); assert.equal((await page.json()).items[0].title,'only on node')
  const overview = new URL(rowsUrl)
  overview.searchParams.set('kind','workspaces'); overview.searchParams.set('include','conversations')
  const combined = await readPage(overview,cookie); assert.equal(combined.status,200)
  const body = await combined.json()
  assert.deepEqual(body.workspaces.map(row=>row.title),['Box'])
  assert.equal(body.conversationPage.runtimeId,remote.runtimeId)
  assert.deepEqual(body.conversationPage.items.map(row=>row.title),['only on node'])
  assert.ok(body.conversationPage.nextCursor)
  assert.equal((await readPage(overview,strangerCookie)).status,404)
  const invalid = new URL(overview); invalid.searchParams.set('cursor',body.conversationPage.nextCursor)
  assert.equal((await readPage(invalid,cookie)).status,400)
  const shared=await pool.query('SELECT revision::text,conversations::text FROM harness.runtime_workspace_catalog WHERE runtime_id=$1',[remote.runtimeId])
  assert.equal(shared.rows[0].revision,'2'); assert.ok(!shared.rows[0].conversations.includes('only on node'))
  await assert.rejects(pool.query('UPDATE harness.runtime_workspace_catalog SET revision=4 WHERE runtime_id=$1',[remote.runtimeId]),/owned by its computer/)
  await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND user_id=$2 AND node_id=$3',[organizationId,userUuid,b.nodeId])
  assert.ok([403,404].includes((await readPage(rowsUrl,cookie)).status))
  assert.ok([403,404].includes((await readPage(overview,cookie)).status))
  console.log(JSON.stringify({stage:'passive-personal-overview',requests:1,independentCursors:true,foreignOwnerRefused:true,revokedOwnerRefused:true}))
  console.log(JSON.stringify({stage:'promoted-personal-directory',incompleteBlocked:true,ownerRead:true,centralNewTitles:0,oldPublisherRefused:true,revoked:true}))
  assert.deepEqual((await pool.query('SELECT runtime_id,generation,observed_state FROM harness.instances WHERE organization_id=$1 ORDER BY runtime_id', [organizationId])).rows, before)
} catch (error) { primaryError = error; throw error }
finally {
  const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
  if (gateway?.listening) await close(() => new Promise((ready, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : ready()) }))
  if (personalIndex !== undefined) await close(() => personalIndex.close())
  if (manager !== undefined) await close(() => manager.stopAll())
  if (organizationId !== undefined) await close(() => removeOrganization(organizationId))
  await close(() => pool.end()); await close(() => rm(root, { recursive: true, force: true }))
  // oxlint-disable-next-line no-unsafe-finally -- Combine the scenario failure with cleanup failures.
  if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Workbench computer fixture cleanup failed')
}
