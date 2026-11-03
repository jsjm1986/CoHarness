/** Current archive mutation authority through authenticated Gateway HTTP and PostgreSQL. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.mjs'

const [mode, artifactRoot = '-', selectedAction = 'all', selectedChange = 'all'] = process.argv.slice(2)
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
  const actions = ['trash', 'restore', 'purge', 'settle', 'empty-draft']
  const changes = ['current', 'role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization']
  assert.ok(selectedAction === 'all' || actions.includes(selectedAction))
  assert.ok(selectedChange === 'all' || changes.includes(selectedChange))
  for (const action of selectedAction === 'all' ? actions : [selectedAction]) for (const change of selectedChange === 'all' ? changes : [selectedChange]) {
    const root = await mkdtemp(join(tmpdir(), 'archive-authority-http-'))
    let organizationId, gateway, manager, pending, release, primaryError
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
      const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
      const owner = await users.create({ username: 'archive-owner', password: 'pw-12345678', role: 'admin' })
      await users.changeOwnPassword(actor.id, 'pw-12345678')
      const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
      manager = new InstanceManager(repository, cfg); await manager.stateOf(owner.id)
      const archives = new ConversationArchiveService(context), rootSessionId = `archive-${randomUUID()}`
      const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
      const sessionRuntimeId = (await repository.resolveTarget({ kind: 'user', id: owner.id })).runtimeId
        if (action === 'empty-draft') {
        const creator = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, owner.id])).rows[0].id
        await new ConversationRepository(pool, { organizationId, runtimeId: sessionRuntimeId }).create({ id: rootSessionId, organizationId, runtimeId: sessionRuntimeId, creatorUserId: creator, sessionFormatVersion: 1,
          createdAt: Date.now() - 7_200_000, visibility: 'personal', draft: true })
        await pool.query("UPDATE harness.conversation_sessions SET updated_at=now()-interval '2 hours' WHERE organization_id=$1 AND id=$2", [organizationId, rootSessionId])
      }
      const archiveId = await archives.syncSnapshot({ runtime: { kind: 'user', id: owner.id }, rootSessionId, creatorUserId: owner.id,
        title: 'Owner archive', syncRevision: 1 })
      if (action === 'empty-draft') await pool.query("UPDATE harness.conversation_archive_records SET restored_at=now()-interval '2 hours' WHERE archive_id=$1", [archiveId])
      if (action === 'restore') await archives.setState(archiveId, 'trash', actor.id)
      if (action === 'settle') await archives.purge(archiveId, actor.id)
      const snapshot = async () => ({
        record: (await pool.query('SELECT state,sync_revision::text,sync_state FROM harness.conversation_archive_records WHERE organization_id=$1 AND root_session_id=$2', [organizationId, rootSessionId])).rows[0],
        commands: (await pool.query('SELECT action,status,desired_revision::text FROM harness.conversation_archive_commands WHERE organization_id=$1 AND archive_id=$2 ORDER BY id', [organizationId, archiveId])).rows,
      })
      const before = await snapshot(), entered = Promise.withResolvers(), gate = Promise.withResolvers()
      release = () => { gate.resolve() }
      const method = action === 'empty-draft' ? 'trashEmptyDrafts' : action === 'purge' || action === 'settle' ? action : 'setState'
      const original = archives[method].bind(archives)
      archives[method] = async (...args) => { entered.resolve(); await gate.promise; return original(...args) }
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
      pending = fetch(`${origin}${action === 'empty-draft' ? '/admin/api/archives/empty-drafts/trash' : '/admin/api/archives/records/actions'}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(action === 'empty-draft' ? { sessions: [{ rootSessionId, runtimeId: sessionRuntimeId }] } : { archiveIds: [archiveId] }), actorUserId: owner.id }) })
        .then(async response => ({ status: response.status, value: await response.json() }))
      await Promise.race([entered.promise, pending.then(response => { throw new Error(`Archive request bypassed the mutation wait: ${response.status}`) })])
      if (change === 'role') await users.setRole(actor.id, 'user', owner.id)
      if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
      if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
      if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
      if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
      if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
      release()
      const response = await pending, after = await snapshot(), accepted = action === 'empty-draft'
        ? response.status === 200 && response.value.trashed?.some(item => item.rootSessionId === rootSessionId && item.runtimeId === sessionRuntimeId) : response.value.results?.[0]?.ok === true
      process.stdout.write(JSON.stringify({ action, change, status: response.status, accepted,
        unchanged: JSON.stringify(before) === JSON.stringify(after), state: after.record.state, commands: after.commands.length }) + '\n')
      if (change === 'current') {
        assert.equal(accepted, true)
        assert.equal(after.record.state, action === 'restore' || action === 'purge' ? 'archived' : action === 'settle' ? 'purged' : 'trash')
        assert.equal(after.commands.length, action === 'restore' ? 2 : 1)
      }
      else { assert.equal(accepted, false, 'A demoted administrator cannot mutate another account archive'); assert.deepEqual(after, before) }
    } catch (error) { primaryError = error; throw error }
    finally {
      const errors = [], close = async operation => { try { await operation() } catch (error) { errors.push(error) } }
      release?.(); await close(async () => { await pending })
      if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
      if (manager !== undefined) await close(() => manager.stopAll())
      if (organizationId !== undefined) await close(() => removeFixtureOrganization(pool, organizationId))
      await close(() => rm(root, { recursive: true, force: true }))
      // oxlint-disable-next-line no-unsafe-finally -- Preserve the primary failure together with cleanup failures.
      if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Archive authority cleanup failed')
    }
  }
} finally { await pool.end() }
