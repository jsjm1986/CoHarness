/** Current archive read authority through authenticated Gateway HTTP and PostgreSQL. */
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'

const [mode, artifactRoot = '-', selectedAction = 'all', selectedChange = 'all', selectedPhase = 'all'] = process.argv.slice(2)
assert.ok(mode === 'src' || mode === 'lib')
assert.ok(artifactRoot === '-' || mode === 'lib')
const base = artifactRoot === '-' ? new URL(`../../${mode}/`, import.meta.url) : pathToFileURL(`${resolve(artifactRoot)}/`)
const [{ createPostgresPool, runMigrations }, { resolvePostgresRuntimeContext }, { PostgresUserService }, { PostgresProjectService },
  { PostgresAuthService }, { PostgresAuditService }, { PostgresInstanceRepository }, { InstanceManager }, { createGatewayServer },
  { createAdminApiHandler }, { loadConfig }, { ConversationArchiveService }, { ConversationRepository }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config', 'postgres/conversation-archive-service', 'postgres/conversation-repository',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const pool = createPostgresPool(url, { max: 3, application_name: `archive-http-${randomUUID()}` })
try {
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  const actions = ['list', 'preview', 'status', 'detail', 'export', 'export-fallback']
  const changes = ['current', 'role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization']
  assert.ok(selectedAction === 'all' || actions.includes(selectedAction))
  assert.ok(selectedChange === 'all' || changes.includes(selectedChange))
  assert.ok(['all', 'before-data', 'runtime-read', 'runtime-offline', 'queued-start'].includes(selectedPhase))
  let scenarios = 0
  for (const action of selectedAction === 'all' ? actions : [selectedAction]) for (const change of selectedChange === 'all' ? changes : [selectedChange]) {
    for (const phase of selectedPhase === 'all' ? (['detail', 'export', 'export-fallback'].includes(action) ? (action === 'detail' ? ['before-data', 'runtime-read', 'runtime-offline', 'queued-start'] : ['before-data', 'runtime-read', 'runtime-offline']) : ['before-data']) : [selectedPhase]) {
      if (!['detail', 'export', 'export-fallback'].includes(action) && phase !== 'before-data') continue
      if (phase === 'queued-start' && (action !== 'detail' || change === 'current')) continue
      scenarios += 1
      const root = await mkdtemp(join(tmpdir(), 'archive-authority-http-'))
      let organizationId, gateway, manager, pending, release, primaryError, readerPool, runtimeServer, runtimeTarget, runtimeGeneration, repository
      let actorBound = null, generationBound = null, retainedDatabaseClient = false, launchAttempts = 0
      try {
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
          HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
        const slug = `archive-authority-${randomUUID()}`
        organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Archive authority') RETURNING id", [slug])).rows[0].id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        cfg.organizationSlug = slug
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg)
        const owner = await users.create({ username: 'archive-owner', password: 'pw-12345678', role: 'admin' })
        const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        await users.changeOwnPassword(owner.id, 'pw-12345678')
        repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
        manager = phase === 'queued-start' ? new InstanceManager(repository, cfg, { launch: async () => { launchAttempts += 1; throw new Error('Withdrawn archive reader attempted Runtime dispatch') } }) : new InstanceManager(repository, cfg)
        await manager.stateOf(owner.id)
        readerPool = createPostgresPool(url, { max: 1, application_name: `archive-reader-${randomUUID()}` })
        const archives = new ConversationArchiveService({ ...context, pool: readerPool }), rootSessionId = `archive-${randomUUID()}`
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        const sessionRuntimeId = (await repository.resolveTarget({ kind: 'user', id: owner.id })).runtimeId
        if (action === 'preview') {
          const creator = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, owner.id])).rows[0].id
          await new ConversationRepository(pool, { organizationId, runtimeId: sessionRuntimeId }).create({ id: rootSessionId, organizationId, runtimeId: sessionRuntimeId, creatorUserId: creator, sessionFormatVersion: 1,
            createdAt: Date.now() - 7_200_000, visibility: 'personal', draft: true })
          await pool.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND id=$2", [organizationId, rootSessionId])
        }
        const archiveId = action === 'preview' ? undefined : await archives.syncSnapshot({ messageCount: 1, runtime: { kind: 'user', id: owner.id }, rootSessionId, creatorUserId: owner.id,
          title: 'Owner archive', syncRevision: 1 })
        if (action === 'restore') await archives.setState(archiveId, 'trash', actor.id)
        if (action === 'settle') await archives.purge(archiveId, actor.id)
        const snapshot = async () => ({
          record: (await pool.query('SELECT state,sync_revision::text,sync_state FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2', [organizationId, rootSessionId])).rows[0],
          commands: (await pool.query('SELECT action,status,desired_revision::text FROM harness.conversation_archive_commands WHERE organization_id=$1 AND archive_id=$2 ORDER BY id', [organizationId, archiveId])).rows,
        })
        const before = await snapshot(), entered = Promise.withResolvers(), gate = Promise.withResolvers()
        release = () => { gate.resolve() }
        const method = action === 'list' ? 'adminList' : action === 'preview' ? 'previewEmptyDrafts'
          : action === 'status' ? 'status' : action === 'detail' || action === 'export-fallback' ? 'detail' : 'exportDetail'
        if (action === 'export-fallback') archives.exportDetail = undefined
        if (phase === 'before-data') {
          const original = archives[method].bind(archives)
          archives[method] = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
        } else {
          const [{ createArchiveRuntimeReader }, { GatewayPrincipalSigner, PRINCIPAL_HEADER }] = await Promise.all([
            import(new URL(`archive-runtime-reader.${mode === 'src' ? 'ts' : 'js'}`, base)),
            import(new URL(`principal.${mode === 'src' ? 'ts' : 'js'}`, base)),
          ])
          const keys = generateKeyPairSync('ed25519'), principals = new GatewayPrincipalSigner(keys.privateKey, slug, 60_000)
          runtimeTarget = await repository.resolveTarget({ kind: 'user', id: owner.id })
          if (phase === 'queued-start') {
            const authorize = repository.authorizeAdministrator.bind(repository)
            repository.authorizeAdministrator = async id => { actorBound = id === actor.id; entered.resolve(); await gate.promise; return authorize(id) }
          } else {
            runtimeGeneration = await repository.beginStart(runtimeTarget, Date.now(), createHash('sha256').update(randomUUID()).digest())
            await repository.markReady(runtimeTarget, runtimeGeneration)
            runtimeServer = createServer((req, res) => {
              void (async () => {
                const claims = principals.verify(req.headers[PRINCIPAL_HEADER])
                actorBound = claims.user.id === actor.id && claims.purpose === 'archive-read'
                generationBound = claims.runtime.runtimeId === runtimeTarget.runtimeId && claims.runtime.generation === runtimeGeneration
                assert.equal(actorBound, true)
                assert.equal(generationBound, true)
                entered.resolve(); await gate.promise
                if (phase === 'runtime-offline') { res.destroy(); return }
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ title: 'Owner archive', descendants: [{ sessionId: rootSessionId, parentSessionId: null, title: 'Owner archive' }],
                  events: [{ sessionId: rootSessionId, seq: 0, type: 'user/message', time: 1000, data: { content: 'Private owner content' } }], hasMore: false }))
              })().catch(error => { res.destroy(error) })
            })
            await new Promise((done, fail) => { runtimeServer.once('error', fail); runtimeServer.listen(0, '127.0.0.1', done) })
            manager.ensureRunning = async (subject, intent, administratorUserId) => {
              assert.equal(subject.runtimeId, runtimeTarget.runtimeId)
              assert.equal(intent, 'passive'); assert.equal(administratorUserId, actor.id)
              await repository.authorizeAdministrator(administratorUserId)
              return { port: runtimeServer.address().port, generation: runtimeGeneration, runtimeId: runtimeTarget.runtimeId }
            }
          }
          archives.setRuntimeReader(createArchiveRuntimeReader({ cfg, users, projects, instances: manager, principals,
            authorizeAdministrator: id => repository.authorizeAdministrator(id) }))
        }
        const deps = { cfg, users, projects, archives, audit: new PostgresAuditService(context), instances: manager,
          auth: new PostgresAuthService(context, cfg) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
        cfg.port = gateway.address().port
        const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
        const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await login.arrayBuffer(); assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
        const path = action === 'list' ? '/admin/api/archives/records' : action === 'preview' ? '/admin/api/archives/empty-drafts/preview'
          : `/admin/api/archives/records/${archiveId}${action === 'status' ? '/status' : action.startsWith('export') ? '/export' : ''}`
        pending = fetch(`${origin}${path}`, { headers: { origin, cookie } }).then(async response => ({ status: response.status, value: await response.json() }))
        await Promise.race([entered.promise, pending.then(response => { throw new Error(`Archive request bypassed the read wait: ${response.status}`) })])
        retainedDatabaseClient = readerPool.totalCount - readerPool.idleCount !== 0
        assert.equal(retainedDatabaseClient, false, 'An external Runtime wait must not retain the archive pool client')
        if (change === 'role') await users.setRole(actor.id, 'user', owner.id)
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        release()
        const response = await pending, after = await snapshot()
        const accepted = response.status === 200 && (action === 'list' ? response.value.some(row => row.rootSessionId === rootSessionId)
          : action === 'preview' ? response.value.candidates.some(row => row.rootSessionId === rootSessionId)
            : action === 'status' ? response.value.rootSessionId === rootSessionId : response.value.record?.rootSessionId === rootSessionId)
        const privatePayload = JSON.stringify(response.value).includes(rootSessionId)
        process.stdout.write(JSON.stringify({ action, phase, change, status: response.status, accepted, privatePayload,
          unchanged: JSON.stringify(before) === JSON.stringify(after), actorBound, generationBound, retainedDatabaseClient,
          coldStartDispatched: phase === 'queued-start' ? launchAttempts !== 0 : null }) + '\n')
        assert.equal(accepted, change === 'current', 'Withdrawn administrator must not receive another account archive')
        assert.equal(privatePayload, change === 'current')
        assert.equal(response.status, change === 'current' ? 200 : 403)
        assert.deepEqual(after, before)
        if (phase === 'queued-start') { assert.equal(launchAttempts, 0); assert.equal(await repository.stateOf(runtimeTarget), 'stopped') }
        if (change === 'current' && phase === 'runtime-read') assert.equal(response.value.events[0]?.data.content, 'Private owner content')
        if (change === 'current' && phase === 'runtime-offline') assert.equal(response.value.record.syncState, 'unavailable')
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors = [], close = async operation => { try { await operation() } catch (error) { errors.push(error) } }
        release?.(); await close(async () => { await pending })
        if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
        if (runtimeServer?.listening) await close(() => new Promise((done, fail) => { runtimeServer.closeAllConnections(); runtimeServer.close(error => error ? fail(error) : done()) }))
        if (runtimeTarget !== undefined && runtimeGeneration !== undefined) await close(() => repository.markStopped(runtimeTarget, runtimeGeneration))
        if (manager !== undefined) await close(() => manager.stopAll())
        if (readerPool !== undefined) await close(() => readerPool.end())
        if (organizationId !== undefined) await close(() => removeFixtureOrganization(pool, organizationId))
        await close(() => rm(root, { recursive: true, force: true }))
        // oxlint-disable-next-line no-unsafe-finally -- Preserve the primary failure together with cleanup failures.
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Archive authority cleanup failed')
      }
    }
  }
  assert.ok(scenarios > 0, 'No archive read scenario was selected')
} finally { await pool.end() }
