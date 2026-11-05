/** Real Admin archive reads and mixed-store cleanup on bounded governance and physical content pools. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'

const [mode = 'src', artifactRoot] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === undefined || mode === 'lib')
const base = artifactRoot === undefined ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const load = name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))
const [{ createPostgresPool, runMigrations, transaction }, { resolvePostgresRuntimeContext }, { PostgresUserService },
  { PostgresProjectService }, { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository },
  { InstanceManager }, { createGatewayServer }, { createAdminApiHandler }, { loadConfig }, { NodeContentStore },
  { migrateNodeContent }, { NodeArchiveRouter }, { ConversationRepository }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config', 'node-content-store',
  'node-content-migrations', 'node-archive-router', 'postgres/conversation-repository',
].map(load))
const selected = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
assert.ok(selected && process.env.HGW_TEST_NODE_CONTENT_PGDATA)
const root = await mkdtemp(join(process.env.DSH_ARCHIVE_FIXTURE_ROOT ?? tmpdir(), 'hgw-archive-pool-')), databases = []
const administration = createPostgresPool(selected, { max: 1 })
let pool, content, parallel, gateway, manager, pending, release
const only = process.env.DSH_ARCHIVE_POOL_SCENARIO
const scenario = async (name, work) => {
  if (only !== undefined && only !== name) return
  const row = await work()
  process.stdout.write(`${JSON.stringify({ scenario: name, ...row })}\n`)
}
try {
  const controlUrl = new URL(selected), contentUrl = new URL(selected)
  for (const [url, kind] of [[controlUrl, 'control'], [contentUrl, 'content']]) {
    const name = `hgw_archive_${kind}_${randomUUID().replaceAll('-', '')}_test`
    await administration.query(`CREATE DATABASE "${name}"`); databases.push(name); url.pathname = `/${name}`
  }
  pool = createPostgresPool(controlUrl.href, { max: 1, connectionTimeoutMillis: 5000 })
  content = createPostgresPool(contentUrl.href, { max: 3 })
  parallel = createPostgresPool(controlUrl.href, { max: 3, connectionTimeoutMillis: 5000 })
  const migrations = process.env.DSH_ARCHIVE_GATEWAY_ROOT ?? fileURLToPath(new URL('../../', import.meta.url))
  await runMigrations(pool, join(migrations, 'deploy/postgres/migrations'))
  const slug = randomUUID(), organization = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Archive pool') RETURNING id", [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'archive-node')", [organization])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'archive-node')
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
    HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
    HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '' })
  const users = new PostgresUserService(context, cfg)
  const actor = await users.create({ username: 'archive-admin', password: 'synthetic-password', role: 'admin' })
  await users.create({ username: 'keeper-admin', password: 'synthetic-password', role: 'admin' })
  await users.changeOwnPassword(actor.id, 'synthetic-password')
  const account = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organization, actor.id])).rows[0].id
  const personal = (await pool.query('SELECT runtime_id FROM harness.instances WHERE organization_id=$1 AND user_id=$2', [organization, account])).rows[0].runtime_id
  const options = { pool: content, organizationId: organization, nodeId: context.nodeId, volumeId: randomUUID(),
    dataDirectory: process.env.HGW_TEST_NODE_CONTENT_PGDATA, proofTimeoutMs: 5000 }
  await mkdir(join(options.dataDirectory, 'harness-node-content-proofs'), { recursive: true, mode: 0o700 })
  await migrateNodeContent(options, join(migrations, 'deploy/node-content/migrations'))
  const store = await NodeContentStore.open(options), archives = new NodeArchiveRouter(context, 30, store)
  manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg,
    { instancesOutliveGateway: false, start: async () => { throw new Error('Archive admission must not start a Runtime') } })
  const deps = { cfg, users, projects: new PostgresProjectService(context, cfg), auth: new PostgresAuthService(context, cfg),
    audit: new PostgresAuditService(context), instances: manager, archives }
  gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
  const origin = `http://127.0.0.1:${gateway.address().port}`; cfg.publicOrigins.push(origin)
  const login = async () => {
    const response = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin,
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'synthetic-password' }) })
    await response.arrayBuffer(); assert.equal(response.status, 302)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); return cookie
  }
  let cookie = await login()
  const request = async (suffix = '', body) => {
    const response = await fetch(`${origin}/admin/api/archives/${body === undefined ? 'records' : 'empty-drafts/trash'}${suffix}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    })
    return { status: response.status, value: await response.json() }
  }
  await scenario('legacy-empty', async () => {
    const result = await request(); assert.equal(result.status, 200); assert.deepEqual(result.value, [])
    return { status: result.status, rows: result.value.length }
  })
  const binding = await transaction(pool, async tx => {
    const project = (await tx.query('INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id,public_id', [organization, randomUUID(), account])).rows[0]
    await tx.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)', [organization, project.id, context.nodeId, `/opaque/${project.id}`])
    const runtime = (await tx.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,47300) RETURNING runtime_id', [organization, project.id, context.nodeId])).rows[0].runtime_id
    const b = await store.stageProject(tx, { projectId: project.id, runtimeId: runtime, name: 'Archive workspace', rootPath: root })
    // This corpus publishes only the Session/archive allocation; production publication checks every enabled project domain.
    await content.query("UPDATE node_content.spaces SET publication_state='published' WHERE organization_id=$1 AND runtime_id=$2", [organization, runtime])
    await tx.query('INSERT INTO harness.project_content_placement(organization_id,project_id,node_id,runtime_id,volume_id,writer_epoch) VALUES($1,$2,$3,$4,$5,$6)', [organization, project.id, context.nodeId, runtime, b.volumeId, b.writerEpoch])
    return { ...b, publicId: Number(project.public_id) }
  })
  await scenario('published-empty', async () => {
    const result = await request(); assert.equal(result.status, 200); assert.deepEqual(result.value, [])
    return { status: result.status, rows: result.value.length }
  })
  for (const [title, time, local] of [['shared-new', 4000, false], ['node-new', 3000, true], ['shared-old', 2000, false], ['node-old', 1000, true]]) {
    await (local ? content : pool).query(`INSERT INTO ${local ? 'node_content' : 'harness'}.conversation_archive_records
      (organization_id,node_id,runtime_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,title,message_count,archived_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$4,1,to_timestamp($9))`, [organization, context.nodeId,
      local ? binding.runtimeId : personal, title, local ? 'project' : 'user', local ? binding.publicId : actor.id, local ? binding.projectId : null, account, time])
  }
  for (const [name, query, titles] of [
    ['mixed-page', '?limit=2&offset=1', ['node-new', 'shared-old']],
    ['project-filter', `?projectId=${binding.publicId}`, ['node-new', 'node-old']],
    ['creator-filter', `?userId=${actor.id}`, ['shared-new', 'node-new', 'shared-old', 'node-old']],
  ]) await scenario(name, async () => {
    const result = await request(query); assert.equal(result.status, 200); assert.deepEqual(result.value.map(row => row.title), titles)
    return { status: result.status, titles: result.value.map(row => row.title) }
  })
  await scenario('parallel-page', async () => {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers(); let reads = 0
    const reader = { read: store.read.bind(store), write: store.write.bind(store), readVolume: work => store.readVolume(async db => {
      if (++reads === 3) entered.resolve(); await gate.promise; return work(db)
    }) }
    deps.archives = new NodeArchiveRouter({ ...context, pool: parallel }, 30, reader)
    const requests = [request(), request(), request()]; release = () => gate.resolve()
    pending = Promise.allSettled(requests)
    try {
      await entered.promise; assert.equal(parallel.totalCount, 3); assert.equal(parallel.idleCount, 0); release()
      const values = await Promise.all(requests)
      assert.deepEqual(values.map(row => row.status), [200, 200, 200]); assert.ok(values.every(row => row.value.length === 4))
      return { statuses: values.map(row => row.status), rowsPerRequest: 4, governanceConnections: parallel.totalCount }
    } finally { release(); await pending; pending = undefined; deps.archives = archives }
  })
  for (const change of ['role', 'password']) await scenario(`late-${change}`, async () => {
    const entered = Promise.withResolvers(), gate = Promise.withResolvers(), original = archives.adminList.bind(archives)
    archives.adminList = async (...args) => { const rows = await original(...args); entered.resolve(); await gate.promise; return rows }
    release = () => gate.resolve(); pending = request()
    try {
      await entered.promise
      if (change === 'role') await users.setRole(actor.id, 'user')
      else await users.resetPassword(actor.id, 'replacement-password')
      release(); const denied = await pending; assert.equal(denied.status, 403); assert.ok(!Array.isArray(denied.value))
      return { status: denied.status, archiveRowsDisclosed: false }
    } finally {
      release(); await pending; pending = undefined; archives.adminList = original
      await users.setRole(actor.id, 'admin'); await users.changeOwnPassword(actor.id, 'synthetic-password'); cookie = await login()
    }
  })
  const shared = new ConversationRepository(pool, { organizationId: organization, runtimeId: personal })
  const blank = async (id, local) => {
    if (!local) await shared.create({ organizationId: organization, runtimeId: personal, id, creatorUserId: account,
      sessionFormatVersion: 1, createdAt: 1000, visibility: 'personal', draft: true })
    else await content.query(`INSERT INTO node_content.conversation_sessions
      (organization_id,runtime_id,id,creator_user_id,project_id,root_session_id,visibility,session_format_version,created_at,updated_at,draft)
      VALUES($1,$2,$3,$4,$5,$3,'private',1,to_timestamp(1),to_timestamp(1),true)`, [organization, binding.runtimeId, id, account, binding.projectId])
    return { rootSessionId: id, runtimeId: local ? binding.runtimeId : personal }
  }
  for (const mixed of [false, true]) await scenario(mixed ? 'mixed-drafts' : 'shared-draft', async () => {
    const sessions = [await blank(randomUUID(), false), ...(mixed ? [await blank(randomUUID(), true)] : [])]
    const result = await request('', { sessions, cutoff: Date.now() - 3600000 }); assert.equal(result.status, 200, JSON.stringify(result.value))
    assert.deepEqual(result.value.trashed, mixed ? [sessions[1], sessions[0]] : sessions)
    const states = []
    for (const item of sessions) states.push((await (item.runtimeId === personal ? pool : content).query(`SELECT state,record_kind FROM
      ${item.runtimeId === personal ? 'harness' : 'node_content'}.conversation_archive_records WHERE organization_id=$1 AND runtime_id=$2 AND root_session_id=$3`,
    [organization, item.runtimeId, item.rootSessionId])).rows[0])
    assert.ok(states.every(row => row.state === 'trash' && row.record_kind === 'empty-draft'))
    return { status: result.status, trashed: result.value.trashed.length, bothStoresRecorded: mixed }
  })
  for (const change of ['role', 'password']) await scenario(`batch-early-${change}`, async () => {
    const sessions = [await blank(randomUUID(), false), await blank(randomUUID(), true)]
    const entered = Promise.withResolvers(), gate = Promise.withResolvers(), original = archives.trashEmptyDrafts.bind(archives)
    archives.trashEmptyDrafts = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
    release = () => gate.resolve(); pending = request('', { sessions, cutoff: Date.now() - 3600000 })
    try {
      await entered.promise
      if (change === 'role') await users.setRole(actor.id, 'user')
      else await users.resetPassword(actor.id, 'replacement-password')
      release(); const denied = await pending; assert.equal(denied.status, 403)
      for (const item of sessions) assert.equal((await (item.runtimeId === personal ? pool : content).query(`SELECT FROM
        ${item.runtimeId === personal ? 'harness' : 'node_content'}.conversation_archive_records WHERE organization_id=$1 AND runtime_id=$2 AND root_session_id=$3`,
      [organization, item.runtimeId, item.rootSessionId])).rowCount, 0)
      return { status: denied.status, archivesChanged: false }
    } finally {
      release(); await pending; pending = undefined; archives.trashEmptyDrafts = original
      await users.setRole(actor.id, 'admin'); await users.changeOwnPassword(actor.id, 'synthetic-password'); cookie = await login()
    }
  })
  await scenario('trusted-page', async () => {
    const rows = await archives.adminList({}); assert.equal(rows.length, 4)
    return { rows: rows.length, governancePoolMaximum: 1 }
  })
  const historyFailures = []
  for (const state of ['active', 'disabled', 'deleted', 'disabled-membership', 'missing-membership']) await scenario(`historical-creator-${state}`, async () => {
    const creator = await users.create({ username: `historical-${state}`, password: 'synthetic-password' })
    const identity = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organization, creator.id])).rows[0].id
    const runtime = (await pool.query('SELECT runtime_id FROM harness.instances WHERE organization_id=$1 AND user_id=$2', [organization, identity])).rows[0].runtime_id
    await deps.projects.setMember(binding.publicId, creator.id, 'rw', actor.id)
    for (const local of [false, true]) await (local ? content : pool).query(`INSERT INTO ${local ? 'node_content' : 'harness'}.conversation_archive_records
      (organization_id,node_id,runtime_id,root_session_id,runtime_kind,runtime_public_id,project_id,creator_user_id,title,message_count,archived_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$4,1,to_timestamp(5000))`, [organization, context.nodeId,
      local ? binding.runtimeId : runtime, `${local ? 'node' : 'shared'}-historical-${state}`, local ? 'project' : 'user',
      local ? binding.publicId : creator.id, local ? binding.projectId : null, identity])
    if (state === 'disabled') await users.setStatus(creator.id, 'disabled', actor.id)
    if (state === 'deleted') assert.equal(await users.remove(creator.id, actor.id), true)
    if (state === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [organization, identity])
    if (state === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE organization_id=$1 AND user_id=$2', [organization, identity])
    const result = await request(`?userId=${creator.id}`)
    const titles = result.value.map(row => row.title).sort()
    const expected = [`node-historical-${state}`, `shared-historical-${state}`]
    const labelsRetained = result.value.every(row => row.creator?.id === creator.id)
    const preserved = (await pool.query('SELECT count(*)::int n FROM harness.conversation_archive_records WHERE organization_id=$1 AND creator_user_id=$2', [organization, identity])).rows[0].n === 1
      && (await content.query('SELECT count(*)::int n FROM node_content.conversation_archive_records WHERE organization_id=$1 AND creator_user_id=$2', [organization, identity])).rows[0].n === 1
    if (result.status !== 200 || JSON.stringify(titles) !== JSON.stringify(expected) || !labelsRetained || !preserved) historyFailures.push(state)
    return { status: result.status, titles, labelsRetained, historyPreserved: preserved }
  })
  await scenario('missing-creator-filter', async () => {
    const result = await request('?userId=9007199254740991')
    assert.equal(result.status, 200); assert.deepEqual(result.value, [])
    return { status: result.status, rows: result.value.length }
  })
  assert.deepEqual(historyFailures, [])
} finally {
  release?.(); await pending?.catch(() => {})
  if (gateway !== undefined) { gateway.closeAllConnections(); await new Promise(done => gateway.close(done)) }
  await manager?.stopAll(); await Promise.all([pool?.end(), content?.end(), parallel?.end()])
  try { for (const name of databases.reverse()) await administration.query(`DROP DATABASE "${name}" WITH (FORCE)`) }
  finally { await administration.end(); await rm(root, { recursive: true, force: true }) }
}
