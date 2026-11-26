/** Maintenance preserves authenticated control transport without reopening business admission. */
import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresNodeAccessService } from '../src/postgres/node-access-service.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { nodeMaintenanceFixture, nodeMaintenanceTranscript } from './node-maintenance-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
describe.skipIf(url === undefined)('Managed node maintenance control', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(url!, { max: 6 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('retains HTTP control leases and quiescence while business writes stay refused', async () => {
    expect(await nodeMaintenanceTranscript(pool)).toContain('zero launches; Runtime records unchanged')
  })

  it('refuses lease renewal after the serving write epoch changes during its wait', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('epoch-fenced')
    const lease = node.lease!
    const name = 'epoch-heartbeat-' + randomUUID()
    const reserve = createPostgresPool(url!, { max: 1, application_name: name })
    const authority = new PostgresNodeAccessService(f.context, f.cfg.nodeAccess, f.cfg.runtimeCatalog, reserve, f.baseline)
    const locker = await pool.connect()
    let locked = false, refused: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      locked = true
      await locker.query('UPDATE harness.cluster_control SET write_epoch=write_epoch+1 WHERE organization_id=$1', [f.org])
      refused = expect(authority.heartbeat(node.token, { connectionId: node.connectionId, epoch: lease.epoch }))
        .rejects.toMatchObject({ status: 503, code: 'node-access/unavailable' })
      void refused.catch(() => { /* Observe this assertion after the control-row lock is released. */ })
      await expect.poll(async () => (await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [name],
      )).rowCount).toBe(1)
      await locker.query('COMMIT')
      locked = false
      await refused
      const durable = await pool.query<{ lease_expires_at: Date }>(
        'SELECT lease_expires_at FROM harness.node_agents WHERE organization_id=$1 AND node_id=$2', [f.org, node.ticket.nodeId],
      )
      expect(durable.rows[0]?.lease_expires_at.toISOString()).toBe(lease.expiresAt)
    } finally {
      try { if (locked) await locker.query('ROLLBACK') } finally { locker.release() }
      try { await refused } finally { await reserve.end() }
    }
  })

  it('counts serving attachment promotion and holds maintenance entry until its HTTP connection transaction commits', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('pending', false), name = 'serving-connect-' + randomUUID(), enterName = 'maintenance-enter-' + randomUUID()
    const worker = createPostgresPool(url!, { max: 1, application_name: name }), entrant = createPostgresPool(url!, { max: 1, application_name: enterName })
    f.deps.nodeAccess = new PostgresNodeAccessService({ ...f.context, pool: worker }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
    const control = new PostgresMaintenanceService({ ...f.context, pool: entrant }, 60_000), blocker = await pool.connect()
    const barrier = 'maintenance_commit_' + randomUUID().replaceAll('-', '')
    let connecting: ReturnType<typeof f.request> | undefined, entering: Promise<unknown> | undefined
    try {
      // Constraint DDL locks the shared table; serialize only this fixture's DDL lifetime across test processes.
      await blocker.query("SELECT pg_advisory_lock(hashtextextended('harness-tests:node-maintenance-commit-barrier',0))")
      // A fixture-only deferred constraint pauses the real COMMIT after the production control lock is acquired.
      await pool.query(`CREATE FUNCTION harness.${barrier}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.organization_id='${f.org}'::uuid THEN PERFORM pg_advisory_xact_lock(hashtextextended('${barrier}',0)); END IF;
        RETURN NEW; END $$`)
      await pool.query(`CREATE CONSTRAINT TRIGGER ${barrier} AFTER INSERT OR UPDATE ON harness.node_agents
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION harness.${barrier}()`)
      await blocker.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [barrier])
      const admissions = f.writerAdmissions()
      connecting = f.request('/internal/nodes/connect', { connectionId: node.connectionId }, node.token)
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [name])).rowCount).toBe(1)
      expect(f.writes()).toBe(1); expect(f.writerAdmissions()).toBe(admissions + 1)
      await f.maintenance.heartbeat(0n, f.writes())
      expect((await f.maintenance.state()).writersQuiesced).toBe(false)
      entering = control.enterMaintenance(f.admin.id).catch(error => error)
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity e JOIN pg_stat_activity c ON c.pid=ANY(pg_blocking_pids(e.pid))
        WHERE e.application_name=$1 AND c.application_name=$2`, [enterName, name])).rowCount).toBe(1)
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [barrier])
      expect((await connecting).status).toBe(200)
      expect(await entering).toMatchObject({ mode: 'maintenance' })
      expect(f.writes()).toBe(0)
      await f.maintenance.heartbeat(1n, f.writes())
      expect((await f.maintenance.state()).writersQuiesced).toBe(true)
      const lease = (await connecting).body
      const after = f.writerAdmissions()
      expect((await f.request('/internal/nodes/connect', { connectionId: node.connectionId }, node.token)).status).toBe(200)
      expect((await f.request('/internal/nodes/heartbeat', { connectionId: node.connectionId, epoch: lease.epoch }, node.token)).status).toBe(200)
      expect(f.writerAdmissions()).toBe(after)
      expect((await f.maintenance.state()).writersQuiesced).toBe(true)
    } finally {
      await blocker.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [barrier])
      await Promise.all([connecting, entering]); await Promise.all([worker.end(), entrant.end()])
      try {
        await pool.query(`DROP TRIGGER IF EXISTS ${barrier} ON harness.node_agents`)
        await pool.query(`DROP FUNCTION IF EXISTS harness.${barrier}()`)
      } finally {
        await blocker.query("SELECT pg_advisory_unlock(hashtextextended('harness-tests:node-maintenance-commit-barrier',0))")
        blocker.release()
      }
    }
  })

  it('refuses a cached serving connect when maintenance committed before its attachment transaction', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('pending', false), gate = f.deps.maintenanceGate!
    let observed!: () => void, resume!: () => void
    const read = new Promise<void>(resolve => { observed = resolve }), proceed = new Promise<void>(resolve => { resume = resolve })
    f.deps.maintenanceGate = async () => { const verdict = await gate(); observed(); await proceed; return verdict }
    const before = (await pool.query('SELECT * FROM harness.node_agents WHERE organization_id=$1', [f.org])).rows
    const topology = (await pool.query('SELECT revision FROM harness.deployment_topology WHERE organization_id=$1', [f.org])).rows
    const connecting = f.request('/internal/nodes/connect', { connectionId: node.connectionId }, node.token)
    try {
      await read
      await f.enter()
      expect((await f.maintenance.state()).writersQuiesced).toBe(true)
      resume()
      expect((await connecting).status).toBe(503)
      expect((await pool.query('SELECT * FROM harness.node_agents WHERE organization_id=$1', [f.org])).rows).toEqual(before)
      expect((await pool.query('SELECT revision FROM harness.deployment_topology WHERE organization_id=$1', [f.org])).rows).toEqual(topology)
      expect(f.writes()).toBe(0)
      expect((await f.maintenance.state()).writersQuiesced).toBe(true)
    } finally { resume(); await connecting; f.deps.maintenanceGate = gate }
  })

  it('rolls back attachment and access invalidation when maintenance commits after the fresh serving read', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('pending', false), name = 'late-connect-' + randomUUID()
    const worker = createPostgresPool(url!, { max: 1, application_name: name }), blocker = await pool.connect()
    f.deps.nodeAccess = new PostgresNodeAccessService({ ...f.context, pool: worker }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
    const before = (await pool.query('SELECT * FROM harness.node_agents WHERE organization_id=$1', [f.org])).rows
    const topology = (await pool.query('SELECT revision FROM harness.deployment_topology WHERE organization_id=$1', [f.org])).rows
    const organization = (await pool.query('SELECT * FROM harness.organizations WHERE id=$1', [f.org])).rows
    let connecting: ReturnType<typeof f.request> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT 1 FROM harness.node_agents WHERE organization_id=$1 FOR UPDATE', [f.org])
      connecting = f.request('/internal/nodes/connect', { connectionId: node.connectionId }, node.token)
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [name])).rowCount).toBe(1)
      expect(f.writes()).toBe(1)
      await f.enter()
      expect((await f.maintenance.state()).writersQuiesced).toBe(false)
      await blocker.query('COMMIT')
      expect((await connecting).status).toBe(503)
      expect((await pool.query('SELECT * FROM harness.node_agents WHERE organization_id=$1', [f.org])).rows).toEqual(before)
      expect((await pool.query('SELECT revision FROM harness.deployment_topology WHERE organization_id=$1', [f.org])).rows).toEqual(topology)
      expect((await pool.query('SELECT * FROM harness.organizations WHERE id=$1', [f.org])).rows).toEqual(organization)
      expect(f.writes()).toBe(0)
      await f.maintenance.heartbeat(1n, f.writes())
      expect((await f.maintenance.state()).writersQuiesced).toBe(true)
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await connecting; await worker.end() }
  })

  it('preserves a running generation and refuses its authenticated new execution input', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('managed'), token = randomUUID()
    const target = { kind: 'user' as const, id: f.admin.id }
    const generation = await f.repository.beginStart(target, Date.now(), createHash('sha256').update(token).digest())
    await f.repository.markReady(target, generation)
    try {
      expect(await f.repository.authenticateRuntimeToken(token)).not.toBeNull()
      const before = (await pool.query('SELECT * FROM harness.instances WHERE organization_id=$1', [f.org])).rows
      await f.enter()
      expect((await f.request('/internal/nodes/heartbeat', { connectionId: node.connectionId, epoch: node.lease!.epoch }, node.token)).status).toBe(200)
      expect((await f.maintenance.state()).writersQuiesced).toBe(false)
      expect(await f.request('/internal/runtime/execution/input', { sessionId: 'existing-session', text: 'must not execute' }, token))
        .toEqual({ status: 503, body: { error: 'maintenance' } })
      expect((await pool.query('SELECT * FROM harness.instances WHERE organization_id=$1', [f.org])).rows).toEqual(before)
      expect(f.starts()).toBe(0)
    } finally {
      // This fixture registered a process identity only; no operating-system process was launched.
      await pool.query("UPDATE harness.instances SET desired_state='stopped',observed_state='stopped' WHERE organization_id=$1", [f.org])
    }
  })

  it.each(['connect', 'heartbeat', 'disconnect'] as const)('refuses %s for shutdown, restoring and stale write epochs without changing the lease', async operation => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('managed')
    const request = operation === 'connect' ? { connectionId: node.connectionId }
      : { connectionId: node.connectionId, epoch: node.lease!.epoch }
    const rows = async () => (await pool.query('SELECT * FROM harness.node_agents WHERE organization_id=$1', [f.org])).rows
    const before = await rows()
    // The ordinary-maintenance executor must not serve as a general bypass when the database is serving.
    await expect(f.nodes.maintainConnection(operation, node.token, request, f.baseline)).rejects.toMatchObject({ status: 503 })
    await f.enter()
    await pool.query("UPDATE harness.cluster_control SET mode='restoring' WHERE organization_id=$1", [f.org])
    expect((await f.request('/internal/nodes/' + operation, request, node.token)).status).toBe(503)
    await pool.query("UPDATE harness.cluster_control SET mode='maintenance',write_epoch=write_epoch+1 WHERE organization_id=$1", [f.org])
    expect(await f.request('/internal/nodes/' + operation, request, node.token)).toEqual({ status: 503, body: { error: 'stale-epoch' } })
    await expect(f.nodes.maintainConnection(operation, node.token, request, f.baseline)).rejects.toMatchObject({ status: 503 })
    await pool.query('UPDATE harness.cluster_control SET write_epoch=$2 WHERE organization_id=$1', [f.org, String(f.baseline)])
    f.shutdown()
    expect((await f.request('/internal/nodes/' + operation, request, node.token)).status).toBe(503)
    expect(await rows()).toEqual(before)
  })

  it('preserves expired-heartbeat and conflicting-connection refusals', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('managed')
    await f.enter()
    expect((await f.request('/internal/nodes/connect', { connectionId: randomUUID() }, node.token)).status).toBe(409)
    await pool.query("UPDATE harness.node_agents SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE organization_id=$1", [f.org])
    expect((await f.request('/internal/nodes/heartbeat', { connectionId: node.connectionId, epoch: node.lease!.epoch }, node.token)).status).toBe(409)
    const connected = await f.request('/internal/nodes/connect', { connectionId: randomUUID() }, node.token)
    expect(connected.status).toBe(200)
    expect(BigInt(connected.body.epoch)).toBe(BigInt(node.lease!.epoch) + 1n)
  })

  it.each(['revoke', 'detach', 'disabled-organization', 'other-primary', 'pending'] as const)('retains %s authorization refusal', async change => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('managed', change !== 'pending')
    await f.enter()
    if (change === 'revoke' || change === 'detach') await f.nodes.mutate(f.admin, node.ticket.nodeId, { action: change, revision: 1 })
    if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.org])
    const service = change === 'other-primary' ? new PostgresNodeAccessService({ ...f.context, nodeId: node.ticket.nodeId }, f.cfg.nodeAccess, f.cfg.runtimeCatalog) : f.nodes
    await expect(service.maintainConnection('connect', node.token, { connectionId: randomUUID() }, f.baseline)).rejects.toMatchObject({
      status: change === 'pending' ? 503 : change === 'detach' || change === 'other-primary' ? 409 : 401,
    })
    expect((await pool.query('SELECT attachment_state FROM harness.node_agents WHERE organization_id=$1', [f.org])).rows[0]!.attachment_state)
      .toBe(change === 'pending' ? 'pending' : change === 'detach' ? 'detached' : 'managed')
  })

  it('retains the maintenance row lock while waiting for node authority and serializes restore after lease commit', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('managed')
    await f.enter()
    const name = 'control-' + randomUUID(), restoreName = 'restore-' + randomUUID()
    const worker = createPostgresPool(url!, { max: 1, application_name: name })
    const restorer = createPostgresPool(url!, { max: 1, application_name: restoreName })
    const blocker = await pool.connect()
    let pending: Promise<unknown> | undefined, restoring: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT 1 FROM harness.node_agents WHERE organization_id=$1 FOR UPDATE', [f.org])
      const service = new PostgresNodeAccessService({ ...f.context, pool: worker }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
      pending = service.maintainConnection('heartbeat', node.token, { connectionId: node.connectionId, epoch: node.lease!.epoch }, f.baseline).catch(error => error)
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [name])).rowCount).toBe(1)
      restoring = restorer.query("UPDATE harness.cluster_control SET mode='restoring',write_epoch=write_epoch+1 WHERE organization_id=$1", [f.org]).catch(error => error)
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity r JOIN pg_stat_activity w ON w.pid=ANY(pg_blocking_pids(r.pid))
        WHERE r.application_name=$1 AND w.application_name=$2`, [restoreName, name])).rowCount).toBe(1)
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ nodeId: node.ticket.nodeId, epoch: node.lease!.epoch })
      expect(await restoring).not.toBeInstanceOf(Error)
      await expect(service.maintainConnection('heartbeat', node.token, { connectionId: node.connectionId, epoch: node.lease!.epoch }, f.baseline)).rejects.toMatchObject({ status: 503 })
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await Promise.all([pending, restoring]); await Promise.all([worker.end(), restorer.end()])
    }
  })

  it('refuses a credential revoked while maintenance renewal waits for the node lock', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('managed')
    await f.enter()
    const name = 'revoked-control-' + randomUUID(), worker = createPostgresPool(url!, { max: 1, application_name: name })
    const blocker = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('UPDATE harness.node_agents SET revoked_at=clock_timestamp() WHERE organization_id=$1', [f.org])
      pending = new PostgresNodeAccessService({ ...f.context, pool: worker }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
        .maintainConnection('heartbeat', node.token, { connectionId: node.connectionId, epoch: node.lease!.epoch }, f.baseline).catch(error => error)
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [name])).rowCount).toBe(1)
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ status: 401, code: 'node-access/unauthorized' })
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await pending; await worker.end() }
  })

  it('refuses governance recovery review even with an existing managed credential', async () => {
    await using f = await nodeMaintenanceFixture(pool)
    const node = await f.node('managed')
    await f.enter()
    const operation = randomUUID()
    try {
      await pool.query(`INSERT INTO harness.governance_rebuild_operations(id,organization_id,source_node_id,target_node_id,point_id,
        manifest_digest,schema_digest,source_watermark,source_topology_revision,recovery_epoch,bootstrap_user_id,isolation_method,evidence_reference,unrestored_domains)
        SELECT $1,$2,$3,$4,$5,$6,$6,1,1,1,id,'power-off','fixture isolation','[]' FROM harness.users WHERE organization_id=$2 AND public_id=$7`,
      [operation, f.org, node.ticket.nodeId, f.context.nodeId, randomUUID(), 'a'.repeat(64), f.admin.id])
      for (const action of ['connect', 'heartbeat', 'disconnect'] as const) {
        const input = action === 'connect' ? { connectionId: node.connectionId } : { connectionId: node.connectionId, epoch: node.lease!.epoch }
        expect((await f.request('/internal/nodes/' + action, input, node.token)).status).toBe(503)
      }
      const name = 'governance-control-' + randomUUID(), worker = createPostgresPool(url!, { max: 1, application_name: name })
      const reviewer = await pool.connect()
      let pending: Promise<unknown> | undefined
      try {
        await reviewer.query('BEGIN')
        await reviewer.query("SET LOCAL statement_timeout='5s'")
        await reviewer.query(`UPDATE harness.governance_rebuild_operations SET state='released',released_at=clock_timestamp()
          WHERE id=$1`, [operation])
        pending = new PostgresNodeAccessService({ ...f.context, pool: worker }, f.cfg.nodeAccess, f.cfg.runtimeCatalog)
          .maintainConnection('connect', node.token, { connectionId: node.connectionId }, f.baseline).catch(error => error)
        await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [name])).rowCount).toBe(1)
        // Governance review owns its operation before changing cluster mode. Control admission must use that order.
        await reviewer.query("UPDATE harness.cluster_control SET mode='serving' WHERE organization_id=$1", [f.org])
        await reviewer.query('COMMIT')
        expect(await pending).toMatchObject({ status: 503 })
      } finally { await reviewer.query('ROLLBACK'); reviewer.release(); await pending; await worker.end() }
    } finally {
      // Only this fixture's immutable receipt is removed; production recovery evidence remains immutable.
      const cleanup = await pool.connect()
      try { await cleanup.query('BEGIN'); await cleanup.query("SET LOCAL session_replication_role='replica'"); await cleanup.query('DELETE FROM harness.governance_rebuild_operations WHERE id=$1 AND organization_id=$2', [operation, f.org]); await cleanup.query('COMMIT') }
      finally { await cleanup.query('ROLLBACK'); cleanup.release() }
    }
  })
})
