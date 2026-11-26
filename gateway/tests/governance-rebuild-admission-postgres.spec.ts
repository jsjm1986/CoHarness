/** A rebuilt PostgreSQL organization uses normal HTTP authentication while its recovery generation stays fenced. */
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { GovernanceRebuildAdmission } from '../src/governance-rebuild-admission.ts'
import { GovernanceRebuildGateway } from '../src/governance-rebuild-gateway.ts'
import { importGovernanceRebuild } from '../src/governance-rebuild-import.ts'
import { InstanceManager } from '../src/instances.ts'
import { PeerGovernanceRebuildExporter } from '../src/peer-governance-rebuild-export.ts'
import { readGovernanceRebuildPackage } from '../src/peer-governance-rebuild-validation.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer } from '../src/server.ts'
import { disasterRecoveryFixture } from './peer-backup-disaster-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(databaseUrl === undefined)('binds the normal authenticated recovery entry to its import and rechecks its epoch after cached release', async () => {
  const pool = createPostgresPool(databaseUrl!), roots: string[] = []
  const database = 'governance_admission_' + randomUUID().replaceAll('-', '')
  const migrations = resolve(import.meta.dirname, '../deploy/postgres/migrations')
  let target: ReturnType<typeof createPostgresPool> | undefined, server: Server | undefined, created = false
  try {
    await runMigrations(pool, migrations)
    const f = await disasterRecoveryFixture(pool, roots, true), root = await realpath(roots[0]!)
    const ordinaryRead = vi.spyOn(pool, 'query')
    expect(await GovernanceRebuildAdmission.open(f.context, 1n)).toBeUndefined()
    expect(ordinaryRead).toHaveBeenCalledOnce()
    ordinaryRead.mockRestore()
    await pool.query('UPDATE harness.deployment_topology SET revision=1 WHERE organization_id=$1', [f.org])
    const bootstrap = (await pool.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [f.org, f.adminId])).rows[0]!.id
    const directory = join(root, 'payload'), limits = { maxRows: 4000, maxBytes: 6 << 20 }, signal = AbortSignal.timeout(60000)
    await mkdir(directory, { mode: 0o700 })
    await new PeerGovernanceRebuildExporter(pool, limits).capture({ organizationId: f.org, sourceNodeId: f.context.nodeId,
      targetNodeId: f.target, policyId: randomUUID(), scopeId: f.org, revision: 1 }, directory, signal)
    const data = await readGovernanceRebuildPackage(directory, limits, signal)
    await pool.query('CREATE DATABASE ' + database); created = true
    const destination = new URL(databaseUrl!); destination.pathname = '/' + database
    target = createPostgresPool(destination.href, { max: 2 })
    await runMigrations(target, migrations)
    const operation = randomUUID(), targetNode = randomUUID(), password = 'fresh-admission-fixture-password'
    await importGovernanceRebuild(target, data, { operationId: operation, pointId: randomUUID(), targetNodeId: targetNode,
      targetNodeName: 'Replacement', bootstrapUserId: bootstrap, bootstrapPassword: password, isolationMethod: 'power-off',
      evidenceReference: 'fixture confirmed source power off', acknowledgeDataLoss: true }, migrations, signal)
    const context = await resolvePostgresRuntimeContext(target, f.context.organizationSlug, 'Replacement')
    const maintenance = new PostgresMaintenanceService(context, 30000), epoch = await maintenance.currentWriteEpoch()
    const gate = await GovernanceRebuildAdmission.open(context, epoch)
    if (!gate) throw new Error('rebuilt organization must install its admission guard')
    expect(await gate.admission()).toEqual({ operationId: operation, bootstrapUserId: f.adminId, state: 'review' })
    await expect(target.query('UPDATE harness.governance_rebuild_operations SET target_node_id=$2 WHERE id=$1', [operation, f.target]))
      .rejects.toMatchObject({ code: '23514' })
    const cfg = testConfig(root), users = new PostgresUserService(context, cfg)
    const service = new GovernanceRebuildGateway({ context, config: cfg, limits, pageSize: 100,
      assertStopped: async () => { throw new Error('account review must not inspect a Runtime') },
      prepareProfile: async () => { throw new Error('account review must not prepare a Runtime') } })
    server = createGatewayServer({ cfg, users, auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
      projects: new PostgresProjectService(context, cfg), instances: new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg),
      governanceRecovery: gate, maintenanceGate: async () => (await maintenance.writeGate(epoch)).verdict }, { governanceRecovery: service })
    const listening = server
    await new Promise<void>(resolve => listening.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, endpoint = '/admin/api/governance-recovery'
    cfg.publicOrigins.push(base)
    const login = await fetch(base + '/login', { method: 'POST', redirect: 'manual', headers: { origin: base },
      body: new URLSearchParams({ username: 'admin', password, returnTo: '/' }) })
    expect(login.status).toBe(302)
    expect(login.headers.get('location')).toBe('/admin/governance-recovery')
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const request = (path: string, input?: unknown) => fetch(base + path, { redirect: 'manual',
      method: input === undefined ? 'GET' : 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) })
    expect((await request('/admin/api/deployment/topology')).status).toBe(503)
    const status = await request(endpoint)
    expect(status.status).toBe(200)
    const current = await status.json() as { revision: string; unrestoredDomains: string[] }
    const released = await request(`${endpoint}/${operation}/release`, { confirm: operation, revision: current.revision,
      acknowledgeUnrestoredDomains: current.unrestoredDomains })
    expect(released.status).toBe(200)
    expect(await gate.admission()).toMatchObject({ state: 'released' })
    const query = vi.spyOn(target, 'query')
    for (let i = 0; i < 5; i++) expect(await gate.admission()).toMatchObject({ state: 'released' })
    expect(query).not.toHaveBeenCalled()
    query.mockRestore()
    expect((await target.query('SELECT count(*)::int n FROM harness.computer_use_permissions WHERE enabled')).rows[0].n).toBe(0)
    expect((await target.query('SELECT count(*)::int n FROM harness.node_agents WHERE credential_hash IS NOT NULL OR connection_id IS NOT NULL')).rows[0].n).toBe(0)
    expect((await target.query('SELECT harness.recovery_execution_allowed($1,$2,$3) allowed', [f.org, f.runtimeId, f.context.nodeId])).rows[0].allowed).toBe(false)
    await target.query('UPDATE harness.cluster_control SET write_epoch=write_epoch+1 WHERE organization_id=$1', [f.org])
    await expect(gate.verifyAdministration()).rejects.toMatchObject({ status: 503, code: 'peer-backup/governance-admission-unavailable' })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const staleRead = await request(endpoint)
      expect(staleRead.status).toBe(503)
      expect(await staleRead.json()).toEqual({ error: 'peer-backup/governance-admission-unavailable' })
      const staleWrite = await request(`${endpoint}/${operation}/release`, { confirm: operation, revision: '2', acknowledgeUnrestoredDomains: current.unrestoredDomains })
      expect(staleWrite.status).toBe(503)
      expect(await staleWrite.json()).toEqual({ error: 'stale-epoch' })
    } finally { log.mockRestore() }
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve())) }
    await target?.end()
    if (created) await pool.query('DROP DATABASE ' + database)
    await pool.end(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  }
})
