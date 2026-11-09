/** Authenticated maintenance administration against real PostgreSQL, without applying a backup. */
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
  { createAdminApiHandler }, { loadConfig }, { PostgresMaintenanceService }, { PostgresBackupService }] = await Promise.all([
  'postgres/database', 'postgres/runtime-context', 'postgres/user-service', 'postgres/project-service', 'postgres/auth-service',
  'postgres/audit-service', 'postgres/instance-repository', 'instances', 'server', 'admin-api', 'config', 'postgres/maintenance-service', 'postgres/backup-service',
].map(name => import(new URL(`${name}.${mode === 'src' ? 'ts' : 'js'}`, base))))
const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL); assert.ok(url)
const pool = createPostgresPool(url, { max: 2, application_name: `maintenance-http-${randomUUID()}` })
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
  const { current: schemaVersion } = await runMigrations(pool, process.env.DSH_AUDIT_MAINTENANCE_MIGRATIONS ?? fileURLToPath(new URL('../../deploy/postgres/migrations', import.meta.url)))
  for (const operation of ['read', 'enter', 'exit', 'node-status', 'restore']) {
    for (const change of ['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current', ...(operation === 'restore' ? ['unverified-backup'] : [])]) {
      const root = await mkdtemp(join(tmpdir(), 'maintenance-http-')), organizations = []
      let gateway, manager, pending, release, primaryError
      try {
        const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_STATE_ROOT: join(root, 'state'),
          HGW_PROJECTS_ROOT: join(root, 'projects'), HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
          HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes'), HGW_SYSTEMD_UNIT_DIR: join(root, 'units'), HGW_DEFAULT_ENV_FILE: '',
          HGW_DSH_REPO_ROOT: fileURLToPath(new URL('../../../', import.meta.url)) })
        const slug = `maintenance-${randomUUID()}`
        const organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Maintenance HTTP') RETURNING id", [slug])).rows[0].id
        organizations.push(organizationId)
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        cfg.organizationSlug = slug; cfg.computeNodeName = 'local'
        const users = new PostgresUserService(context, cfg), projects = new PostgresProjectService(context, cfg), audit = new PostgresAuditService(context)
        const actor = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
        await users.changeOwnPassword(actor.id, 'pw-12345678')
        const otherAdministrator = await users.create({ username: 'other-administrator', password: 'pw-12345678', role: 'admin' })
        const internal = (await pool.query('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0].id
        await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organizationId])
        const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs), backups = new PostgresBackupService(context)
        if (operation === 'exit') await maintenance.enterMaintenance(null, 'existing window')
        let backup
        if (operation === 'restore') {
          backup = await backups.record({ path: join(root, 'accepted.dump'), migrationVersion: schemaVersion, writeEpoch: 1n,
            sizeBytes: 128, sha256: 'a'.repeat(64), managedSnapshot: { version: 1, roots: [], directories: [], absent: [], files: [] }, actor: actor.id })
          await backups.setVerified(backup.id, true)
        }
        const baseline = (await pool.query('SELECT count(*)::integer count FROM harness.deployment_operations WHERE organization_id=$1', [organizationId])).rows[0].count
        let entered, queued = true
        const observed = new Promise(done => { entered = done }), gate = new Promise(done => { release = done })
        const method = operation === 'read' ? typeof maintenance.administration === 'function' ? 'administration' : 'state'
          : operation === 'enter' ? 'enterMaintenance' : operation === 'exit' ? 'exitMaintenance' : operation === 'node-status' ? 'setNodeStatus' : 'requestRestore'
        const original = maintenance[method].bind(maintenance)
        maintenance[method] = async (...args) => { if (queued) { queued = false; entered(); await gate } return original(...args) }
        manager = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg); await manager.stopAll()
        const deps = { cfg, users, projects, audit, maintenance, backups, instances: manager, auth: new PostgresAuthService(context, cfg) }
        gateway = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
        await new Promise((done, fail) => { gateway.once('error', fail); gateway.listen(0, '127.0.0.1', done) })
        cfg.port = gateway.address().port
        const origin = `http://127.0.0.1:${cfg.port}`; cfg.publicOrigins.push(origin)
        const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: actor.username, password: 'pw-12345678' }) })
        await login.arrayBuffer(); assert.equal(login.status, 302)
        const cookie = login.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie)
        const path = operation === 'read' ? '/admin/api/deployment' : operation === 'restore' ? '/admin/api/deployment/restore'
          : operation === 'node-status' ? '/admin/api/deployment/nodes/status' : '/admin/api/deployment/maintenance'
        const payload = { actorUserId: otherAdministrator.id, action: operation, reason: 'requested window', nodeId: context.nodeId, status: 'draining', backupId: backup?.id }
        pending = fetch(`${origin}${path}`, { method: operation === 'read' ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, ...(operation === 'read' ? {} : { body: JSON.stringify(payload) }) })
          .then(async response => ({ status: response.status, value: await response.json() }))
        await Promise.race([observed, pending.then(response => { throw new Error(`Maintenance request bypassed the observer: ${operation}/${change} status ${response.status}`) })])
        if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [internal])
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [internal])
        if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [internal])
        if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [internal])
        if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [internal])
        if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        if (change === 'unverified-backup') await backups.setVerified(backup.id, false, 'withdrawn verification')
        release()
        const response = await pending
        const control = (await pool.query('SELECT mode,maintenance_epoch::text FROM harness.cluster_control WHERE organization_id=$1', [organizationId])).rows[0]
        const node = (await pool.query('SELECT status FROM harness.compute_nodes WHERE id=$1', [context.nodeId])).rows[0]
        const operations = (await pool.query(`SELECT o.kind,o.status,(SELECT public_id FROM harness.users WHERE id=o.created_by) actor
          FROM harness.deployment_operations o WHERE organization_id=$1 ORDER BY created_at,id`, [organizationId])).rows
        const action = operation === 'read' ? undefined : operation === 'restore' ? 'admin.deployment.restore.request'
          : operation === 'node-status' ? 'admin.deployment.nodes.status' : `admin.deployment.maintenance.${operation}`
        const successful = action === undefined ? [] : await audit.query({ action })
        console.log(JSON.stringify({ operation, change, status: response.status, error: response.value.error ?? null,
          acceptedMode: response.value.mode ?? null, acceptedNodeStatus: operation === 'node-status' ? response.value.status ?? null : null,
          acceptedRestoreStatus: operation === 'restore' ? response.value.status ?? null : null,
          storedMode: control.mode, storedEpoch: control.maintenance_epoch, storedNodeStatus: node.status,
          addedOperations: operations.length - baseline, restorePending: operations.filter(row => row.kind === 'restore' && row.status === 'pending').length,
          restoreActor: operation !== 'restore' || operations.length === baseline ? null : Number(operations.at(-1).actor) === actor.id ? 'current-admin' : 'foreign',
          successfulAudits: successful.length }))
      } catch (error) { primaryError = error; throw error }
      finally {
        const errors = [], close = async fn => { try { await fn() } catch (error) { errors.push(error) } }
        release?.(); await close(async () => { await pending })
        if (gateway?.listening) await close(() => new Promise((done, fail) => { gateway.closeAllConnections(); gateway.close(error => error ? fail(error) : done()) }))
        if (manager !== undefined) await close(() => manager.stopAll())
        for (const id of organizations.reverse()) await close(() => removeOrganization(id))
        await close(() => rm(root, { recursive: true, force: true }))
        if (errors.length > 0) throw new AggregateError(primaryError === undefined ? errors : [primaryError, ...errors], 'Maintenance HTTP cleanup failed')
      }
    }
  }
} finally { await pool.end() }
