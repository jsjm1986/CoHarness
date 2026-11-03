/** Current account privileges across resident and node-pressure admission waits. @module */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { InstanceManager } from '../src/instances.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL personal Runtime policy', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-personal-policy-'))
    const slug = `personal-policy-${randomUUID()}`
    let organizationId: string | undefined
    const close = async () => {
      try {
        if (organizationId !== undefined) {
          for (const table of ['node_resource_requests', 'node_resource_runtimes', 'node_resource_state',
            'instances', 'runtime_environments', 'project_members', 'project_mounts', 'projects', 'memberships', 'users', 'outbox', 'compute_nodes']) {
            await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
          }
          await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    }
    try {
      organizationId = (await pool.query<{ id: string }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Personal policy') RETURNING id", [slug],
      )).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const cfg = testConfig(root, { HGW_RUNTIME_MAX_RESIDENT: '1', HGW_RUNTIME_MAX_STARTING: '1' })
      const users: Array<{ uuid: string; user: UserRow }> = []
      for (const username of ['holder', 'waiting-admin']) {
        const homePath = join(root, username)
        const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
          organization_id,username,display_name,home_path) VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id`,
        [organizationId, username, homePath])).rows[0]!
        await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, row.id])
        await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
          [organizationId, context.nodeId, row.id])
        users.push({ uuid: row.id, user: { id: Number(row.public_id), username, homePath, displayName: username,
          role: 'admin', status: 'active', mustChangePassword: false, autoReviewEligible: false } })
      }
      const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
      await repository.initialize()
      return { root, context, cfg, repository, holder: users[0]!, waiting: users[1]!, close }
    } catch (error) {
      try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Personal policy fixture setup and cleanup failed') }
      throw error
    }
  }

  it('resolves current privileges and excludes another organization', async () => {
    const f = await fixture(), other = await fixture()
    try {
      const target = await f.repository.resolveTarget({ kind: 'user', id: f.waiting.user.id })
      expect(await f.repository.personalPolicy(f.waiting.user.id)).toEqual({
        id: f.waiting.user.id, username: f.waiting.user.username, homePath: f.waiting.user.homePath,
        role: 'admin', status: 'active', runtimeId: target.runtimeId, storageLayout: 'legacy',
      })
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.waiting.uuid])
      expect(await f.repository.personalPolicy(f.waiting.user.id)).toMatchObject({ role: 'user' })
      expect(await f.repository.personalPolicy(other.waiting.user.id)).toBeNull()
    } finally { await other.close(); await f.close() }
  })

  for (const action of ['start', 'stop', 'policy'] as const) {
    it.each(['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership',
      'disabled-organization', 'current', 'owner-role'] as const)(`retains current administrator admission for ${action} after an organization wait: %s`, async change => {
      const f = await fixture()
      const applicationName = `runtime-administrator-${randomUUID()}`
      const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
      const controlled = new PostgresInstanceRepository({ ...f.context, pool: reader }, f.cfg.instancePortBase)
      const blocker = await pool.connect()
      const target = { kind: 'user' as const, id: f.waiting.user.id }
      let pending: Promise<unknown> | undefined
      try {
        const previousGeneration = await f.repository.generationOf(target)
        const generation = action === 'stop' ? await f.repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit') : 0
        await blocker.query('BEGIN')
        await blocker.query('SELECT 1 FROM harness.organizations WHERE id=$1 FOR UPDATE', [f.context.organizationId])
        pending = (action === 'start'
          ? controlled.beginStart(target, Date.now(), Buffer.alloc(32, 2), 'explicit', f.holder.user.id)
          : action === 'stop' ? controlled.markControlStopping(target, generation, 'manual', f.holder.user.id)
            : controlled.personalPolicy(target.id, f.holder.user.id)).catch((error: unknown) => error)
        await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [applicationName],
        )).rows[0]!.waiting).toBe(true)
        if (change === 'role') await blocker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.holder.uuid])
        else if (change === 'owner-role') await blocker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.waiting.uuid])
        else if (change === 'disabled-account') await blocker.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.holder.uuid])
        else if (change === 'deleted-account') await blocker.query("UPDATE harness.users SET status='disabled',deleted_at=now() WHERE id=$1", [f.holder.uuid])
        else if (change === 'disabled-membership') await blocker.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [f.holder.uuid])
        else if (change === 'missing-membership') await blocker.query('DELETE FROM harness.memberships WHERE user_id=$1', [f.holder.uuid])
        else if (change === 'disabled-organization') await blocker.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
        await blocker.query('COMMIT')
        const result = await pending
        if (change === 'current' || change === 'owner-role') {
          if (action === 'policy') expect(result).toMatchObject({ id: target.id, role: change === 'owner-role' ? 'user' : 'admin' })
          else expect(result).toBe(action === 'start' ? previousGeneration + 1 : true)
          expect(await f.repository.stateOf(target)).toBe(action === 'start' ? 'starting' : action === 'stop' ? 'stopping' : 'stopped')
        } else {
          expect(result).toMatchObject({ code: 'forbidden' })
          expect(await f.repository.stateOf(target)).toBe(action === 'stop' ? 'starting' : 'stopped')
          expect(await f.repository.generationOf(target)).toBe(action === 'stop' ? generation : previousGeneration)
        }
      } finally {
        await blocker.query('ROLLBACK'); blocker.release(); await pending
        await reader.end(); await f.close()
      }
    })
  }

  it('permits current administrator lifecycle control of a reserved project while refusing destructive work', async () => {
    const f = await fixture()
    try {
      const project = (await pool.query<{ id: string; public_id: string }>(
        "INSERT INTO harness.projects(organization_id,name,kind) VALUES($1,'Reserved control','steward') RETURNING id,public_id", [f.context.organizationId],
      )).rows[0]!
      await pool.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',
        [f.context.organizationId, project.id, f.context.nodeId, f.root])
      await f.repository.initialize()
      const target = { kind: 'project' as const, id: Number(project.public_id) }
      const generation = await f.repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit', f.holder.user.id)
      expect(await f.repository.markControlStopping(target, generation, 'manual', f.holder.user.id)).toBe(true)
      await expect(f.repository.markStopping(target, generation, 'manual', f.holder.user.id)).rejects.toMatchObject({ code: 'forbidden' })
      await pool.query('INSERT INTO harness.steward_access_policies(organization_id,user_id,enabled,revision,node_id) VALUES($1,$2,true,1,(SELECT id FROM harness.compute_nodes WHERE organization_id=$1))',
        [f.context.organizationId, f.holder.uuid])
      await expect(f.repository.markStopping(target, generation, 'manual', f.holder.user.id)).rejects.toMatchObject({ code: 'steward-reserved' })
    } finally { await f.close() }
  })

  it('refuses an administrator revoked while node-pressure admission waits', async () => {
    const f = await fixture()
    let manager: InstanceManager | undefined, pending: Promise<unknown> | undefined
    try {
      const budget = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, {
        ...f.cfg.resourceBudget, sampleMs: 10, staleMs: 10_000, maxWaitMs: 10_000,
      })
      await budget.configure()
      let allocations = 0
      manager = new InstanceManager(f.repository, f.cfg, {
        instancesOutliveGateway: false, start: async runtime => {
          await runtime.beforeAllocation?.(); allocations += 1
          throw new Error('Revoked administration cannot allocate a Runtime')
        },
      }, { principalPublicKey: '' }, budget)
      pending = manager.ensureRunning(f.waiting.user, 'explicit', f.holder.user.id).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ allocation_state: string }>(
        'SELECT allocation_state FROM harness.instances WHERE user_id=$1', [f.waiting.uuid],
      )).rows[0]!.allocation_state).toBe('waiting')
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.holder.uuid])
      await budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
      expect(await pending).toMatchObject({ code: 'forbidden' })
      expect(allocations).toBe(0)
      expect(await manager.stateOf(f.waiting.user.id)).toBe('stopped')
      expect(manager.capacitySnapshot().resident).toBe(0)
    } finally { await manager?.stopAll(); await pending; await f.close() }
  })

  it.each(['disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership',
    'disabled-organization', 'different-node', 'missing-assignment'] as const)('withdraws launch policy after %s', async reason => {
    const f = await fixture()
    try {
      if (reason === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.waiting.uuid])
      else if (reason === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [f.waiting.uuid])
      else if (reason === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [f.waiting.uuid])
      else if (reason === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [f.waiting.uuid])
      else if (reason === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      else if (reason === 'missing-assignment') await pool.query('DELETE FROM harness.instances WHERE user_id=$1', [f.waiting.uuid])
      else {
        const remote = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'remote') RETURNING id", [f.context.organizationId])).rows[0]!.id
        await pool.query(`INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
          VALUES($1,$2,$3,$4)`, [f.context.organizationId, remote, f.waiting.uuid, join(f.root, 'remote-home')])
        await pool.query('UPDATE harness.instances SET assigned_node_id=$1 WHERE user_id=$2', [remote, f.waiting.uuid])
      }
      expect(await f.repository.personalPolicy(f.waiting.user.id)).toBeNull()
    } finally { await f.close() }
  })

  it.each(['admin', 'user'] as const)('uses the current %s role after a resident-capacity wait', async currentRole => {
    const f = await fixture()
    let manager: InstanceManager | undefined, pending: Promise<unknown> | undefined
    try {
      const holder = { kind: 'user' as const, id: f.holder.user.id }
      const generation = await f.repository.beginStart(holder, Date.now(), Buffer.alloc(32, 1), 'explicit')
      await f.repository.markReady(holder, generation)
      manager = new InstanceManager(f.repository, f.cfg, {
        instancesOutliveGateway: false,
        start: async () => { throw new Error('The policy observation precedes process allocation') },
        attach: () => ({ hasExited: () => false, terminate: async () => {} }),
      })
      let policy: { role: string | undefined; privileged: boolean | undefined } | undefined
      const observed = new Error('Current launch policy observed')
      manager.beforeStart = runtime => { policy = { role: runtime.user?.role, privileged: runtime.privileged }; throw observed }
      const stale = { ...f.waiting.user, role: currentRole === 'admin' ? 'user' as const : 'admin' as const }
      pending = manager.ensureRunning(stale, 'explicit').catch((error: unknown) => error)
      await expect.poll(() => manager!.capacitySnapshot().queued).toBe(1)
      await pool.query('UPDATE harness.memberships SET role=$1 WHERE user_id=$2', [currentRole === 'admin' ? 'admin' : 'member', f.waiting.uuid])
      await manager.stop(holder)
      expect(await pending).toBe(observed)
      expect(policy).toEqual({ role: currentRole, privileged: currentRole === 'admin' })
      const patch = await readFile(join(f.cfg.usersRoot, stale.username, 'dsh', 'cordis.patch.yml'), 'utf8')
      expect(patch.includes('danger-full-access:')).toBe(currentRole === 'admin')
    } finally { await manager?.stopAll(); await pending; await f.close() }
  })

  it.each(['role', 'disabled-membership', 'home', 'username'] as const)('rejects %s changes while node-pressure admission waits', async change => {
    const f = await fixture()
    let manager: InstanceManager | undefined, pending: Promise<unknown> | undefined
    try {
      const budget = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, {
        ...f.cfg.resourceBudget, sampleMs: 10, staleMs: 10_000, maxWaitMs: 10_000,
      })
      await budget.configure()
      let allocations = 0
      manager = new InstanceManager(f.repository, f.cfg, {
        instancesOutliveGateway: false,
        start: async runtime => {
          await runtime.beforeAllocation?.(); allocations += 1
          throw new Error('The withdrawn policy must not reach process allocation')
        },
      }, { principalPublicKey: '' }, budget)
      pending = manager.ensureRunning(f.waiting.user, 'explicit').catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ allocation_state: string }>(
        'SELECT allocation_state FROM harness.instances WHERE user_id=$1', [f.waiting.uuid],
      )).rows[0]!.allocation_state).toBe('waiting')
      if (change === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.waiting.uuid])
      else if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [f.waiting.uuid])
      else if (change === 'home') await pool.query('UPDATE harness.node_user_accounts SET home_path=$1 WHERE user_id=$2 AND node_id=$3',
        [join(f.root, 'replacement-home'), f.waiting.uuid, f.context.nodeId])
      else await pool.query("UPDATE harness.users SET username='renamed-owner' WHERE id=$1", [f.waiting.uuid])
      await budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
      expect(await pending).toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
      expect(allocations).toBe(0)
      expect(await manager.stateOf(f.waiting.user.id)).toBe('stopped')
      expect(manager.capacitySnapshot().resident).toBe(0)
    } finally { await manager?.stopAll(); await pending; await f.close() }
  })

  it('refreshes a warm role and refuses a withdrawn organization membership', async () => {
    const f = await fixture()
    let manager: InstanceManager | undefined
    try {
      const target = { kind: 'user' as const, id: f.waiting.user.id }
      const generation = await f.repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit')
      await f.repository.markReady(target, generation)
      manager = new InstanceManager(f.repository, f.cfg, {
        instancesOutliveGateway: false, start: async () => { throw new Error('A live Runtime does not start again') },
        attach: () => ({ hasExited: () => false, terminate: async () => {} }),
      })
      await manager.ensureRunning(f.waiting.user)
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.waiting.uuid])
      const seen: string[] = []
      manager.beforeUse = subject => { if ('username' in subject) seen.push(subject.role) }
      expect(await manager.ensureRunning(f.waiting.user)).toMatchObject({ generation })
      expect(seen).toEqual(['user'])
      await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [f.waiting.uuid])
      await expect(manager.ensureRunning(f.waiting.user)).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
      expect(seen).toEqual(['user'])
    } finally { await manager?.stopAll(); await f.close() }
  })
})
