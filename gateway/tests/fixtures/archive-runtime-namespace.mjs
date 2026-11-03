/** Same Host Session IDs remain independent through real Gateway/Admin HTTP on two computer identities. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'

const [mode, artifactRoot = '-'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib'); assert.ok(artifactRoot === '-' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresInstanceRepository },
  { PostgresConversationStore }, { PostgresCollaborationService }, { GatewayPrincipalSigner, PRINCIPAL_HEADER },
  { createRuntimeApiHandler }, { ConversationArchiveService }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { InstanceManager }, { createGatewayServer }, { createAdminApiHandler },
  { loadConfig }, { hashPassword }, { createArchiveRuntimeReader }, { PostgresNodeAccessService }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/instance-repository', 'postgres/conversation-repository',
  'postgres/collaboration-service', 'principal', 'runtime-api', 'postgres/conversation-archive-service', 'postgres/user-service',
  'postgres/project-service', 'postgres/auth-service', 'postgres/audit-service', 'instances', 'server', 'admin-api', 'config', 'password', 'archive-runtime-reader', 'postgres/node-access-service',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(databaseUrl)
const pool = createPostgresPool(databaseUrl, { max: 4, application_name: `archive-namespace-${randomUUID()}` })
const root = await mkdtemp(join(tmpdir(), 'archive-runtime-namespace-')), servers = [], managers = [], logicalRuntimes = [], organizations = []
let primaryError
const show = (label, details) => console.log(JSON.stringify({ label, ...details }))
const listen = async server => {
  servers.push(server)
  await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done) })
  return `http://127.0.0.1:${server.address().port}`
}
try {
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const slug = `archive-namespace-${randomUUID()}`
  const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Archive namespace') RETURNING id", [slug])).rows[0].id
  organizations.push(organizationId)
  const user = (await pool.query(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
    VALUES($1,'actor','Actor',$2) RETURNING id,public_id`, [organizationId, join(root, 'actor')])).rows[0]
  const actorId = Number(user.public_id)
  await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, user.id])
  await pool.query('INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,$2,false)', [user.id, await hashPassword('pw-12345678')])
  const keys = generateKeyPairSync('ed25519'), principals = new GatewayPrincipalSigner(keys.privateKey, slug, 60_000)
  const computers = []
  const hostId = `same-host-session-${randomUUID()}`
  for (const [index, name] of ['computer-a', 'computer-b'].entries()) {
    await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
    const context = await resolvePostgresRuntimeContext(pool, slug, name)
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)', [organizationId, context.nodeId, user.id])
    await pool.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)', [organizationId, context.nodeId, user.id, join(root, name, 'actor')])
    const instances = new PostgresInstanceRepository(context, 48_000); await instances.initialize()
    if (index === 1) await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
      VALUES($1,$2,$3,48000,'isolated')`, [organizationId, user.id, context.nodeId])
    const target = await instances.resolveTarget({ kind: 'user', id: actorId }), token = randomUUID()
    const generation = await instances.beginStart(target, Date.now(), createHash('sha256').update(token).digest()); await instances.markReady(target, generation)
    logicalRuntimes.push({ instances, target, generation })
    const cfg = loadConfig({ HGW_ORGANIZATION_SLUG: slug, HGW_USERS_ROOT: join(root, name, 'users'), HGW_STATE_ROOT: join(root, name, 'state'),
      HGW_PROJECTS_ROOT: join(root, name, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, name, 'user-projects'), HGW_PROJECT_RUNTIMES_ROOT: join(root, name, 'runtimes'),
      HGW_SYSTEMD_UNIT_DIR: join(root, name, 'units'), HGW_DEFAULT_ENV_FILE: '', HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
    cfg.computeNodeName = name; cfg.nodeService.forwarding = true
    const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
    const nodeAccess = new PostgresNodeAccessService(context, cfg.nodeAccess, cfg.runtimeCatalog)
    const manager = new InstanceManager(instances, cfg, { instancesOutliveGateway: true, launch: async () => { throw new Error('Archive fixture cannot launch an OS Runtime') } }); managers.push(manager)
    const store = new PostgresConversationStore(pool), archives = new ConversationArchiveService(context), conversations = store.forRuntime({ organizationId, runtimeId: target.runtimeId }), collaboration = new PostgresCollaborationService(context)
    let reads = 0
    const payloadServer = createServer((req, res) => {
      try {
        const claims = principals.verify(req.headers[PRINCIPAL_HEADER]), url = new URL(req.url, 'http://runtime')
        assert.equal(claims.user.id, actorId); assert.equal(claims.purpose, 'archive-read')
        assert.equal(claims.runtime.runtimeId, target.runtimeId); assert.equal(claims.runtime.generation, generation)
        assert.equal(url.pathname, '/api/internal/archive/read'); assert.equal(url.searchParams.get('sessionId'), hostId)
        reads += 1
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ title: `Archive ${name}`, descendants: [{ sessionId: hostId, parentSessionId: null, title: name }],
          events: [{ sessionId: hostId, seq: 0, type: 'user/message', time: 1000, data: { content: `Private ${name}` } }], hasMore: false }))
      } catch (error) { res.destroy(error) }
    })
    await listen(payloadServer)
    manager.ensureRunning = async (subject, intent, administratorUserId) => {
      assert.equal(subject.runtimeId, target.runtimeId); assert.equal(intent, 'passive'); assert.equal(administratorUserId, actorId)
      await instances.authorizeAdministrator(administratorUserId)
      return { port: payloadServer.address().port, runtimeId: target.runtimeId, generation }
    }
    archives.setRuntimeReader(createArchiveRuntimeReader({ cfg, users, projects, instances: manager, principals, authorizeAdministrator: id => instances.authorizeAdministrator(id) }))
    const deps = { cfg, users, projects, archives, nodeAccess, nodeServiceIdentity: { nodeId: context.nodeId, organizationId, authorize: async () => { throw new Error('Archive fixture accepts no inbound node-service connections') } }, audit: new PostgresAuditService(context), auth: new PostgresAuthService(context, cfg), instances: manager }
    const runtime = createRuntimeApiHandler({ context, instances, archives, conversations: store, collaboration, principals, governance: { resolveOrganizationCredential: async () => null } })
    const gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps), runtime,
      runtimeAuthorize: async req => (await instances.authenticateRuntimeToken(req.headers.authorization?.slice(7) ?? '')) !== null,
      ...(process.env.DSH_ARCHIVE_BROWSER_ROOT === undefined ? {} : { adminRoot: process.env.DSH_ARCHIVE_BROWSER_ROOT }) })
    const origin = await listen(gateway); cfg.publicOrigins.push(origin)
    const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'actor', password: 'pw-12345678' }) })
    await login.arrayBuffer(); assert.equal(login.status, 302)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
    const call = async (path, body, credential = token) => {
      const response = await fetch(`${origin}/internal/runtime/archive/${path}`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    const admin = async (path = '', body) => {
      const response = await fetch(`${origin}/admin/api/archives/records${path}`, { headers: { cookie, origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
      return { status: response.status, body: await response.json() }
    }
    computers.push({ target, token, generation, name, context, call, admin, archives, conversations, store, collaboration, projects, users, instances, origin, cookie, reads: () => reads })
  }
  const [a, b] = computers
  const snapshot = (label, revision = 1) => ({ revision, archivedSessionIds: [hostId], sessions: [{ sessionId: hostId, header: { createdAt: 1000 }, title: label, messageCount: 1 }],
    search: [{ sessionId: hostId, seq: 0, role: 'user', content: `Indexed ${label}`, occurredAt: 1000 }] })
  const received = await Promise.all(computers.map(computer => computer.call('snapshot', snapshot(computer.name))))
  assert.deepEqual(received.map(row => row.status), [200, 200])
  const rows = await Promise.all(computers.map(async computer => { const result = await computer.admin(); assert.equal(result.status, 200); assert.equal(result.body.length, 1); return result.body[0] }))
  const [first, second] = rows; assert.notEqual(first.archiveId, second.archiveId); assert.equal(first.rootSessionId, second.rootSessionId)
  assert.equal(first.runtime.runtimeId, a.target.runtimeId); assert.equal(second.runtime.runtimeId, b.target.runtimeId)
  show('independent-same-host-identities', { accepted: received.map(row => row.status), distinctArchiveIds: true, originalHostIds: true })
  for (const [index, computer] of computers.entries()) {
    const own = rows[index], other = rows[1-index]
    assert.equal((await computer.admin(`?q=${computer.name}`)).body[0].archiveId, own.archiveId)
    assert.deepEqual((await computer.admin(`?q=${computers[1-index].name}`)).body, [])
    const detail = await computer.admin(`/${own.archiveId}`), exported = await computer.admin(`/${own.archiveId}/export`)
    for (const result of [detail, exported]) { assert.equal(result.status, 200); assert.equal(result.body.record.archiveId, own.archiveId); assert.equal(result.body.events[0].data.content, `Private ${computer.name}`) }
    assert.equal((await computer.admin(`/${other.archiveId}/status`)).status, 404)
    assert.equal((await computer.admin(`/${other.archiveId}`)).status, 404)
    assert.equal((await computer.admin(`/${other.archiveId}/export`)).status, 404)
    assert.equal((await computer.admin('/actions', { action: 'purge', archiveIds: [other.archiveId] })).body.results[0].ok, false)
  }
  show('bounded-local-admin-reads', { ownBodies: true, ownExports: true, foreignComputerReads: 404, foreignComputerMutation: false, rpcIdentityChecked: true })
  const httpHostId = `equal-http-root-${randomUUID()}`, httpBatchId = randomUUID()
  const sessionCall = async (computer, path, body, credential = computer.token) => {
    const response = await fetch(`${computer.origin}/internal/runtime/session/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json', ...(computer.principal === undefined ? {} : { [PRINCIPAL_HEADER]: computer.principal }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text) }
  }
  const eventsFor = computer => [
    { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
    { seq: 1, type: 'user/message', time: 1001, surfaceOp: 'append', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `HTTP body ${computer.name}` }] } },
  ]
  const httpComputers = []
  for (const computer of computers) {
    const project = (await pool.query('INSERT INTO harness.projects(organization_id,name,created_by,owner_user_id) VALUES($1,$2,$3,$3) RETURNING id,public_id', [organizationId, `http-${computer.name}`, user.id])).rows[0]
    const projectId = Number(project.public_id), path = join(root, computer.name, 'http-project')
    await pool.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)', [organizationId, project.id, computer.context.nodeId, path])
    await pool.query("INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,'rw')", [organizationId, project.id, user.id])
    await pool.query('INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port) VALUES($1,$2,$3,49900)', [organizationId, project.id, computer.context.nodeId])
    const target = await computer.instances.resolveTarget({ kind: 'project', id: projectId }), token = randomUUID()
    const generation = await computer.instances.beginStart(target, Date.now(), createHash('sha256').update(token).digest()); await computer.instances.markReady(target, generation)
    logicalRuntimes.push({ instances: computer.instances, target, generation })
    const principal = principals.issue({ user: await computer.users.getById(actorId), scope: { kind: 'project', projectId, projectName: `http-${computer.name}`, mode: 'rw' }, runtime: { ...target, generation } })
    const httpComputer = { ...computer, token, target, generation, principal }; httpComputers.push(httpComputer)
    const creation = await sessionCall(httpComputer, 'create', { header: { id: httpHostId, version: 1, createdAt: 1000, cwd: path }, visibility: 'project' })
    assert.equal(creation.status, 200, JSON.stringify(creation.body))
    const input = { sessionId: httpHostId, batchId: httpBatchId, creationAuthorization: creation.body.authorization, events: eventsFor(computer) }
    const appended = await sessionCall(httpComputer, 'append', input)
    assert.equal(appended.status, 200, JSON.stringify(appended.body))
    assert.equal((await sessionCall(httpComputer, 'append', { sessionId: httpHostId, batchId: httpBatchId, events: eventsFor(computer) })).body.result, 'duplicate')
    const loaded = await sessionCall(httpComputer, `load?sessionId=${encodeURIComponent(httpHostId)}`)
    assert.equal(loaded.status, 200); assert.deepEqual(loaded.body.events, eventsFor(computer)); assert.equal(loaded.body.header.id, httpHostId)
  }
  const [httpA, httpB] = httpComputers
  const ownPage = await sessionCall(httpA, `page?sessionId=${encodeURIComponent(httpHostId)}&maxEvents=1`)
  assert.equal(ownPage.status, 200); assert.ok(ownPage.body.nextCursor)
  assert.equal((await sessionCall(httpB, `page?sessionId=${encodeURIComponent(httpHostId)}&cursor=${encodeURIComponent(ownPage.body.nextCursor)}`)).status, 400)
  assert.equal((await sessionCall(httpB, `load?sessionId=${encodeURIComponent(httpHostId)}`, undefined, httpA.token)).status, 401)
  assert.equal((await sessionCall(httpA, 'remove', { sessionId: httpHostId })).status, 200)
  assert.equal((await sessionCall(httpA, `load?sessionId=${encodeURIComponent(httpHostId)}`)).status, 404)
  assert.deepEqual((await sessionCall(httpB, `load?sessionId=${encodeURIComponent(httpHostId)}`)).body.events, eventsFor(httpB))
  show('authenticated-session-http-namespace', { independentWriters: 2, originalHostIds: true, independentBatchReplay: true, foreignCursor: 400, foreignToken: 401, siblingBodySurvivesDelete: true })
  // Stored fallback bodies retain the archive's exact Runtime identity.
  await a.conversations.create({ id: hostId, organizationId, runtimeId: a.target.runtimeId, creatorUserId: user.id, visibility: 'personal', sessionFormatVersion: 1, createdAt: 1000, title: 'Stored A' })
  await a.conversations.append(hostId, randomUUID(), [{ seq: 0, type: 'user/message', time: 1000, data: { content: 'PG private A' }, surfaceOp: 'append' }])
  const contentPath = join(root, 'a-content.bin'); await writeFile(contentPath, 'Only A owns this file')
  await pool.query(`INSERT INTO harness.content_files(organization_id,runtime_id,owner_user_id,session_id,kind,local_path,sha256,byte_length,media_type)
    VALUES($1,$6,$2,$3,'attachment',$4,$5,21,'application/octet-stream')`, [organizationId, user.id, hostId, contentPath, 'a'.repeat(64), a.target.runtimeId])
  const plainA = new ConversationArchiveService(a.context), plainB = new ConversationArchiveService(b.context)
  assert.equal((await plainA.detail(first.archiveId)).events.length, 1)
  assert.equal((await plainB.detail(second.archiveId)).events.length, 0)
  assert.equal((await plainB.status(second.archiveId)).childCount, 0)
  assert.deepEqual(await plainB.adminList({ query: 'PG private A' }), [])
  show('fallback-session-namespace', { owningEvents: 1, otherRuntimeEvents: 0, otherRuntimeSearchHits: 0 })
  const trash = await a.admin('/actions', { action: 'trash', archiveIds: [first.archiveId], idempotencyKey: 'trash-a' }); assert.equal(trash.body.results[0].ok, true)
  assert.equal((await b.admin(`/${second.archiveId}/status`)).body.state, 'archived')
  assert.equal((await b.call('snapshot', snapshot(b.name))).body.commands.length, 0)
  const commandA = (await a.call('snapshot', snapshot(a.name))).body.commands[0]; assert.equal(commandA.rootSessionId, hostId)
  assert.equal((await b.call('ack', { commandId: commandA.id, revision: 2 })).status, 409)
  assert.equal((await a.call('ack', { commandId: commandA.id, revision: 2 })).status, 200)
  const purge = await b.admin('/actions', { action: 'purge', archiveIds: [second.archiveId], idempotencyKey: 'purge-b' }); assert.equal(purge.body.results[0].ok, true)
  const commandB = (await b.call('snapshot', snapshot(b.name))).body.commands[0]
  assert.equal((await a.call('ack', { commandId: commandB.id, revision: 2 })).status, 409)
  assert.equal((await b.call('ack', { commandId: commandB.id, revision: 2 })).status, 200)
  assert.equal((await b.admin(`/${second.archiveId}/status`)).body.state, 'purged')
  assert.ok(await a.conversations.load(hostId))
  assert.equal((await pool.query('SELECT runtime_id FROM harness.conversation_sessions WHERE id=$1', [hostId])).rows[0].runtime_id, a.target.runtimeId)
  assert.equal((await stat(contentPath)).isFile(), true)
  assert.equal((await pool.query('SELECT count(*)::int count FROM harness.conversation_archive_file_cleanup WHERE archive_id=$1', [second.archiveId])).rows[0].count, 0)
  show('command-and-purge-isolation', { hostCommandsPreserved: true, wrongRuntimeAck: 409, otherRuntimeState: 'trash', otherRuntimeDataRetained: true, otherRuntimeFileRetained: true })
  const tombstone = await b.call('snapshot', snapshot('replayed-b', 9)); assert.equal(tombstone.status, 200); assert.equal(tombstone.body.commands[0].action, 'purge')
  assert.equal((await b.admin(`/${second.archiveId}/status`)).body.archiveId, second.archiveId)
  assert.equal((await pool.query('SELECT count(*)::int count FROM harness.conversation_archive_search WHERE archive_id=$1', [second.archiveId])).rows[0].count, 0)
  const crossToken = await b.call('snapshot', snapshot('forged'), a.token); assert.equal(crossToken.status, 401)
  for (const ids of [[hostId], [first.archiveId, first.archiveId.toUpperCase()]]) assert.equal((await a.admin('/actions', { action: 'trash', archiveIds: ids })).status, 400)
  const legacy = await fetch(`${a.origin}/admin/api/archives/${hostId}`, { headers: { cookie: a.cookie } }); await legacy.arrayBuffer(); assert.equal(legacy.status, 410)
  show('replay-and-wire-refusals', { stableTombstone: true, tombstoneSearchRows: 0, foreignCredential: 401, malformedOrDuplicateIds: 400, legacyRootRoute: 410 })
  // A same-account Runtime on one computer must also receive a distinct archive identity.
  const sibling = (await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48001,'isolated') RETURNING runtime_id`, [organizationId, user.id, a.context.nodeId])).rows[0].runtime_id
  const siblingId = await plainA.syncSnapshot({ rootSessionId: hostId, runtime: { kind: 'user', id: actorId, runtimeId: sibling }, creatorUserId: actorId, syncRevision: 1, messageCount: 1 })
  assert.notEqual(siblingId, first.archiveId); assert.equal((await plainA.detail(siblingId)).events.length, 0)
  const siblingConversations = a.store.forRuntime({ organizationId, runtimeId: sibling })
  assert.equal((await siblingConversations.reserveDraft({ organizationId, runtimeId: sibling, scopeKey: 'sibling-draft', draftId: 'new-sibling', sessionId: 'unused-local-draft', userId: user.id, cwd: root, visibility: 'personal' })).created, true)
  await assert.rejects(siblingConversations.reserveDraft({ organizationId, runtimeId: sibling, scopeKey: 'sibling-draft', draftId: 'foreign-existing', sessionId: hostId, userId: user.id, cwd: root, visibility: 'personal' }), /archived or unavailable/)
  show('sibling-runtime-namespace', { distinctArchiveId: true, borrowedEvents: 0, foreignExistingDraft: 'refused' })
  // Restore A and prove a sibling tombstone cannot hide A from the recent-conversation query.
  await a.admin('/actions', { action: 'restore', archiveIds: [first.archiveId] })
  const restore = (await a.call('snapshot', snapshot(a.name))).body.commands[0]; assert.equal(restore.action, 'restore')
  assert.equal((await a.call('ack', { commandId: restore.id, revision: 3 })).status, 200)
  await plainA.purge(siblingId, actorId); await plainA.settle(siblingId, actorId)
  const recent = await a.collaboration.listAccountConversations(actorId)
  assert.equal(recent.some(row => row.sessionId === hostId), true)
  show('recent-conversation-namespace', { owningRestoredRootVisible: true, siblingTombstoneIndependent: true })
  if (process.env.DSH_ARCHIVE_BROWSER_ROOT !== undefined) {
    assert.ok(process.send)
    const browserRuntime = (await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48002,'isolated') RETURNING runtime_id`, [organizationId, user.id, a.context.nodeId])).rows[0].runtime_id
    const browserId = await plainA.syncSnapshot({ rootSessionId: hostId, runtime: { kind: 'user', id: actorId, runtimeId: browserRuntime }, creatorUserId: actorId, title: 'same-host-copy', syncRevision: 1, messageCount: 1 })
    const browserDraft = `browser-same-blank-${randomUUID()}`
    const browserConversations = a.store.forRuntime({ organizationId, runtimeId: browserRuntime })
    for (const [runtimeId, repository] of [[a.target.runtimeId, a.conversations], [browserRuntime, browserConversations]]) {
      await repository.create({ id: browserDraft, organizationId, runtimeId, creatorUserId: user.id, visibility: 'personal', sessionFormatVersion: 1, createdAt: 1000, draft: true })
    }
    await pool.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND id=$2", [organizationId, browserDraft])
    process.send({ kind: 'ready', origin: a.origin, cookie: a.cookie, archiveId: first.archiveId, siblingId: browserId, hostId, browserDraft, firstDraftRuntime: a.target.runtimeId, secondDraftRuntime: browserRuntime })
    await new Promise((done, fail) => { process.once('message', message => message === 'finish' ? done() : fail(new Error('Unexpected browser message'))); process.once('disconnect', () => fail(new Error('Browser driver disconnected'))) })
    assert.equal((await plainA.status(first.archiveId)).state, 'archived')
    assert.equal((await plainA.status(browserId)).state, 'trash')
    const commands = await plainA.syncRuntimeSnapshot({ runtime: { kind: 'user', id: actorId, runtimeId: browserRuntime }, revision: 1, archivedSessionIds: [], sessions: [] })
    const expectedCommands = [{ rootSessionId: hostId, action: 'trash' }, { rootSessionId: browserDraft, action: 'trash' }]
    assert.deepEqual(commands.map(row => ({ rootSessionId: row.rootSessionId, action: row.action })).sort((x, y) => x.rootSessionId.localeCompare(y.rootSessionId)), expectedCommands.sort((x, y) => x.rootSessionId.localeCompare(y.rootSessionId)))
    const browserArchives = (await pool.query('SELECT runtime_id,state FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2', [organizationId, browserDraft])).rows
    assert.deepEqual(browserArchives, [{ runtime_id: browserRuntime, state: 'trash' }])
    process.disconnect()
  }

  const draftRoot = `lifecycle-draft-${randomUUID()}`
  await a.conversations.create({ id: draftRoot, organizationId, runtimeId: a.target.runtimeId, creatorUserId: user.id, visibility: 'personal', sessionFormatVersion: 1, createdAt: 1000, draft: true })
  const draftPrincipal = principals.issue({ user: await a.users.getById(actorId), scope: { kind: 'personal' }, runtime: { ...a.target, generation: a.generation } })
  const reserve = async sessionId => {
    const response = await fetch(`${a.origin}/internal/runtime/session/draft/reserve`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, [PRINCIPAL_HEADER]: draftPrincipal, 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, draftId: draftRoot, cwd: root, visibility: 'personal' }) })
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await reserve(draftRoot)).status, 200)
  const retry = await reserve(randomUUID()); assert.equal(retry.status, 200); assert.equal(retry.body.sessionId, draftRoot)
  const draftArchive = await a.archives.syncSnapshot({ rootSessionId: draftRoot, runtime: { kind: 'user', id: actorId, runtimeId: a.target.runtimeId }, creatorUserId: actorId, syncRevision: 1, messageCount: 0 })
  assert.equal((await reserve(randomUUID())).status, 400)
  await a.conversations.releaseDraftForSession(organizationId, draftRoot)
  await pool.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND runtime_id=$2 AND id=$3", [organizationId, a.target.runtimeId, draftRoot])
  const previewDraft = async () => {
    const response = await fetch(`${a.origin}/admin/api/archives/empty-drafts/preview?ageMs=3600000`, { headers: { cookie: a.cookie } })
    assert.equal(response.status, 200)
    return (await response.json()).candidates.some(row => row.rootSessionId === draftRoot)
  }
  assert.equal(await previewDraft(), false)
  assert.equal((await a.admin('/actions', { action: 'restore', archiveIds: [draftArchive] })).body.results[0].ok, true)
  assert.equal(await previewDraft(), false)
  show('blank-draft-archive-lifecycle', { canonicalRetry: true, archivedReservation: 400, archivedCleanupCandidate: false, recentlyRestoredCleanupCandidate: false })


  const maintenanceRoot = `same-blank-root-${randomUUID()}`
  const maintenancePair = runtimeId => ({ rootSessionId: maintenanceRoot, runtimeId })
  for (const [runtimeId, repository] of [[a.target.runtimeId, a.conversations], [sibling, siblingConversations]]) {
    await repository.create({ id: maintenanceRoot, organizationId, runtimeId, creatorUserId: user.id, visibility: 'personal', sessionFormatVersion: 1, createdAt: 1000, draft: true })
  }
  await pool.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND id=$2", [organizationId, maintenanceRoot])
  const maintenance = async body => {
    const response = await fetch(`${a.origin}/admin/api/archives/empty-drafts/${body === undefined ? 'preview?ageMs=3600000' : 'trash'}`, { headers: { cookie: a.cookie, origin: a.origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) })
    return { status: response.status, body: await response.json() }
  }
  const inspected = await maintenance(); assert.equal(inspected.status, 200)
  const selected = inspected.body.candidates.filter(row => row.rootSessionId === maintenanceRoot)
  assert.equal(selected.length, 2)
  assert.deepEqual(new Set(selected.map(row => row.runtime.runtimeId)), new Set([a.target.runtimeId, sibling]))
  for (const sessions of [[{ rootSessionId: maintenanceRoot }], [maintenancePair(a.target.runtimeId), maintenancePair(a.target.runtimeId.toUpperCase())]]) {
    assert.equal((await maintenance({ sessions, cutoff: inspected.body.cutoff })).status, 400)
  }
  const foreign = await maintenance({ sessions: [maintenancePair(b.target.runtimeId)], cutoff: inspected.body.cutoff })
  assert.equal(foreign.status, 200); assert.deepEqual(foreign.body.trashed, [])
  const moved = await maintenance({ sessions: [maintenancePair(a.target.runtimeId)], cutoff: inspected.body.cutoff })
  assert.equal(moved.status, 200); assert.deepEqual(moved.body.trashed, [maintenancePair(a.target.runtimeId)])
  const archivedPairs = (await a.admin('?state=all&kind=all')).body.filter(row => row.rootSessionId === maintenanceRoot)
  assert.deepEqual(archivedPairs.map(row => ({ runtimeId: row.runtime.runtimeId, state: row.state })), [{ runtimeId: a.target.runtimeId, state: 'trash' }])
  const reserveMaintenance = runtimeId => ({ organizationId, runtimeId, scopeKey: 'maintenance-check', draftId: 'maintenance-check', sessionId: maintenanceRoot, userId: user.id, cwd: root, visibility: 'personal' })
  await assert.rejects(a.conversations.reserveDraft(reserveMaintenance(a.target.runtimeId)), /archived or unavailable/)
  assert.equal((await siblingConversations.reserveDraft(reserveMaintenance(sibling))).created, true)
  await siblingConversations.releaseDraftForSession(organizationId, maintenanceRoot)
  assert.equal((await siblingConversations.readHeader(maintenanceRoot)).id, maintenanceRoot)
  const remaining = (await maintenance()).body.candidates.filter(row => row.rootSessionId === maintenanceRoot)
  assert.equal(remaining.length, 1); assert.equal(remaining[0].runtime.runtimeId, sibling)
  show('runtime-qualified-empty-maintenance', { sameHostCandidates: 2, unqualifiedOrDuplicate: 400, foreignComputerTrashed: 0, exactSelectedPairTrashed: 1, siblingDraftRetained: true })

  const nulText='HTTP\u0000owned %_\\尾巴'
  const nulEvents=[
    {seq:2,type:'turn/start',time:1002,data:{turn:2,scopeKey:'http\u0000scope'}},
    {seq:3,type:'user/message',time:1003,surfaceOp:'append',data:{source:{kind:'user',participant:{userId:actorId,displayName:'HTTP Actor'}},content:[{type:'text',text:nulText}]}},
    {seq:4,type:'assistant/message',time:1004,surfaceOp:'append',data:{message:{content:[{type:'text',text:'HTTP assistant\u0000tail'}]}}},
    {seq:5,type:'tool/result',time:1005,surfaceOp:'append',data:{message:{content:[{type:'tool-result',content:[{type:'text',text:'HTTP tool\u0000tail'}]}]}}},
  ]
  const nulAppend=await sessionCall(httpB,'append',{sessionId:httpHostId,batchId:randomUUID(),events:nulEvents})
  assert.equal(nulAppend.status,200,JSON.stringify(nulAppend.body))
  assert.deepEqual((await sessionCall(httpB,`load?sessionId=${encodeURIComponent(httpHostId)}`)).body.events,[...eventsFor(httpB),...nulEvents])
  const history=await sessionCall(httpB,`index?sessionId=${encodeURIComponent(httpHostId)}`)
  assert.equal(history.status,200);assert.equal(history.body.items[1].prompt,nulText);assert.equal(history.body.items[1].response,'HTTP assistant\u0000tail')
  const nulArchiveRoot=randomUUID()
  const synchronized=await b.call('snapshot',{revision:100,archivedSessionIds:[nulArchiveRoot],sessions:[{sessionId:nulArchiveRoot,header:{createdAt:1000},messageCount:1}],search:[{sessionId:nulArchiveRoot,seq:0,role:'user',content:nulText,occurredAt:1000}]})
  assert.equal(synchronized.status,200,JSON.stringify(synchronized.body))
  const nulFilter=await b.admin('?q=%00')
  assert.equal(nulFilter.status,200);assert.equal(nulFilter.body.find(row=>row.rootSessionId===nulArchiveRoot)?.contentPreview,nulText)
  assert.equal((await a.admin('?q=%00')).body.some(row=>row.rootSessionId===nulArchiveRoot),false)
  assert.equal((await b.admin('?q='+encodeURIComponent('\\u0000'))).body.some(row=>row.rootSessionId===nulArchiveRoot),false)
  show('nul-text-through-runtime-http',{append:200,indexedRoles:3,originalEventText:true,historyPreviewsOriginal:true,archiveSync:200,literalNulFilter:200,encodedEscapeDoesNotMatch:true,foreignComputerArchiveVisible:false})

} catch (error) { primaryError = error; throw error }
finally {
  const failures = [], close = async action => { try { await action() } catch (error) { failures.push(error) } }
  for (const server of servers.reverse()) if (server.listening) await close(() => new Promise((done, fail) => { server.closeAllConnections(); server.close(error => error ? fail(error) : done()) }))
  for (const { instances, target, generation } of logicalRuntimes.reverse()) await close(async () => { assert.equal(await instances.markStopped(target, generation), true) })
  for (const manager of managers.reverse()) await close(() => manager.stopAll())
  for (const organizationId of organizations.reverse()) await close(() => removeFixtureOrganization(pool, organizationId))
  await close(() => pool.end()); await close(() => rm(root, { recursive: true, force: true }))
  // oxlint-disable-next-line no-unsafe-finally -- Preserve the request failure together with teardown failures.
  if (failures.length > 0) throw new AggregateError(primaryError === undefined ? failures : [primaryError, ...failures], 'Archive namespace fixture cleanup failed')
}
