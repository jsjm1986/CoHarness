/** Real authenticated Gateway and PostgreSQL SSH target administration without SSH transport or inference. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
  { createAdminApiHandler }, { loadConfig }, { PostgresSshTargetService }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config', 'postgres/ssh-target-service',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const poolName = `ssh-administration-http-${randomUUID()}`
const pool = createPostgresPool(url, { max: 1, application_name: poolName })
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
const fields = { name: 'builder', host: 'ssh-builder', node: '/usr/bin/node', helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64), workspace: '/srv/workspaces' }

try {
  await runMigrations(pool, process.env.DSH_AUDIT_SSH_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  for (const operation of ['read', 'create', 'update', 'enable', 'disable', 'remove', 'share', 'unshare', 'project-read', 'project-share']) {
    for (const change of operation.startsWith('project-') ? ['disabled-organization', 'retired-owner', 'current-owner', 'current-admin'] : ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current']) {
      const root = await mkdtemp(join(tmpdir(), 'ssh-administration-http-')), organizations = []
      let gateway, manager, pending, release, primaryError
      try {
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
          HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
        const slug = `ssh-target-${randomUUID()}`
        const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'SSH administration HTTP') RETURNING id", [slug])).rows[0].id
        organizations.push(organizationId)
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg), audit = new PostgresAuditService(context)
        const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        const project = (await pool.query(`INSERT INTO harness.projects(organization_id,name,owner_user_id)
          VALUES($1,'SSH project',$2) RETURNING id,public_id`, [organizationId, internal])).rows[0]
        const sshTargets = new PostgresSshTargetService(context)
        const target = await sshTargets.create(actor.id, fields)
        if (operation === 'enable') await pool.query('UPDATE harness.ssh_targets SET enabled=false WHERE organization_id=$1', [organizationId])
        if (operation === 'unshare') await sshTargets.share(actor.id, { targetId: target.publicId, projectId: Number(project.public_id), shared: true })
        let entered, queued = true
        const observed = new Promise(done => { entered = done }), gate = new Promise(done => { release = done })
        const method = operation === 'project-read' ? 'listForProject' : operation === 'project-share' ? 'share' : operation === 'read' ? 'list' : ['enable','disable','remove'].includes(operation) ? 'mutate'
          : ['share','unshare'].includes(operation) ? (typeof sshTargets.shareAsAdministrator === 'function' ? 'shareAsAdministrator' : 'share') : operation
        const original = sshTargets[method].bind(sshTargets)
        sshTargets[method] = async (...args) => { if (queued) { queued = false; entered(); await gate } return original(...args) }
        manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg); await manager.stopAll()
        const deps = { cfg, users, projects, audit, sshTargets, instances: manager, auth: new PostgresAuthService(context, cfg) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
        cfg.port = gateway.address().port
        const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
        const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await login.arrayBuffer(); assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
        const input = operation === 'create' ? { ...fields, name: 'second' }
          : operation === 'update' ? { targetId: target.publicId, revision: target.revision, fields: { ...fields, host: 'changed-host' } }
          : ['share','unshare','project-share'].includes(operation) ? { targetId: target.publicId, projectId: Number(project.public_id), shared: operation !== 'unshare' }
          : { targetId: target.publicId, revision: target.revision, action: operation }
        const suffix = ['enable','disable','remove'].includes(operation) ? '/mutate' : ['share','unshare'].includes(operation) ? '/share' : `/${operation}`
        const endpoint = operation.startsWith('project-') ? `/account/api/projects/${project.public_id}/ssh-targets` : `/admin/api/ssh-targets${['read','create'].includes(operation) ? '' : suffix}`
        const read = operation === 'read' || operation === 'project-read'
        pending = fetch(`${origin}${endpoint}`, { method: read ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, ...(read ? {} : { body: JSON.stringify(input) }) })
          .then(async response => ({ status: response.status, value: await response.json() }))
        await Promise.race([observed, pending.then(response => { throw new Error(`SSH request bypassed the admission observer: ${operation}/${change} status ${response.status}`) })])
        if (change === 'current-owner' || change === 'retired-owner') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'retired-owner') await pool.query('UPDATE harness.projects SET owner_user_id=NULL WHERE id=$1', [project.id])
        if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        release()
        const response = await pending
        const state = (await pool.query(`SELECT name,host,enabled,revision::text FROM harness.ssh_targets WHERE organization_id=$1 ORDER BY name`, [organizationId])).rows
        const shares = (await pool.query('SELECT count(*)::int count FROM harness.ssh_target_shares WHERE organization_id=$1', [organizationId])).rows[0].count
        const successes = await audit.query({ action: operation.startsWith('project-') ? 'projects.ssh-targets.share' : `admin.ssh-targets.${['enable','disable','remove'].includes(operation) ? 'mutate' : operation === 'unshare' ? 'share' : operation}` })
        console.log(JSON.stringify({ operation, change, status: response.status, error: response.value.error ?? null,
          exposedTargets: response.value.targets?.map(row => row.name) ?? [], state, shares, successfulAudit: successes.length }))
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
        release?.()
        await close(async () => { await pending })
        if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
        if (manager !== undefined) await close(() => manager.stopAll())
        for (const id of organizations.reverse()) await close(() => removeOrganization(id))
        await close(() => rm(root, { recursive: true, force: true }))
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'SSH administration HTTP cleanup failed')
      }
    }
  }
} finally { await pool.end() }
