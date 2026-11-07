/** Real PostgreSQL destructive ownership across independent coordinators and stale SQL snapshots. */
import { randomBytes, randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { InstanceManager, type RuntimeStopOperationId, type RuntimeTarget } from '../src/instances.ts'
import { NodeResourceBudget, type GatewayResourceOwner } from '../src/node-resource-budget.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

describePg('process-owned destructive Runtime operations', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 6 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-runtime-stop-lease-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const slug = `stop-lease-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Stop ownership') RETURNING id`, [slug])).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
      VALUES($1,'actor','Actor',$2) RETURNING id,public_id`, [organizationId, root])).rows[0]!
    await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, user.id])
    await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'fixture',false)", [user.id])
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
      [organizationId, context.nodeId, user.id])
    const project = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(organization_id,name)
      VALUES($1,'Protected project') RETURNING id,public_id`, [organizationId])).rows[0]!
    await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
      VALUES($1,$2,$3,$4,$4)`, [organizationId, project.id, context.nodeId, root])
    const cfg = loadConfig({ HGW_STATE_ROOT: join(root, 'state'), HGW_USERS_ROOT: join(root, 'users') })
    const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
    await repository.initialize()
    const target: RuntimeTarget = { kind: 'project', id: Number(project.public_id) }
    const budget = new NodeResourceBudget(pool, organizationId, context.nodeId, cfg.resourceBudget)
    const directory = join(root, 'gateway-owners'), processOwner = await GatewayModelBudget.open(budget, directory)
    cleanups.push(() => processOwner.close())
    const owner = await processOwner.withOwnership(async owner => owner)
    const operationId = () => randomUUID() as RuntimeStopOperationId
    const count = async () => (await pool.query(`SELECT 1 FROM harness.runtime_destructive_operations
      WHERE organization_id=$1`, [organizationId])).rowCount
    return { root, context, cfg, repository, target, budget, directory, processOwner, owner, operationId, count, user, project }
  }

  it('blocks generation, ready publication and placement after another coordinator publishes stopped', async () => {
    const f = await fixture(), operation = f.operationId()
    const lease = await f.repository.acquireStopLease(f.target, operation, f.owner, Number(f.user.public_id))
    expect(lease.wasStopped).toBe(true)
    await f.repository.markStopped(f.target, lease.generation)
    const other = new PostgresInstanceRepository(f.context, f.cfg.instancePortBase)
    await expect(other.beginStart(f.target, Date.now(), randomBytes(32), 'explicit')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    for (const change of ["observed_state='ready'", 'generation=generation+1', 'assigned_node_id=$3::uuid']) {
      const node = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id",
        [f.context.organizationId, `other-${randomUUID()}`])).rows[0]!.id
      await expect(pool.query(`UPDATE harness.instances SET ${change} WHERE organization_id=$1 AND runtime_id=$2`,
        [f.context.organizationId, lease.runtimeId, ...(change.includes('$3') ? [node] : [])]))
        .rejects.toMatchObject({ code: '55000', constraint: 'runtime_destructive_operation' })
    }
    await f.repository.releaseStopLease(f.operationId(), f.owner)
    await f.repository.releaseStopLease(operation, { ...f.owner, generation: f.owner.generation + 1 })
    expect(await f.count()).toBe(1)
    await f.repository.releaseStopLease(operation, f.owner)
    expect(await f.count()).toBe(0)
    expect(await other.beginStart(f.target, Date.now(), randomBytes(32), 'explicit')).toBe(lease.generation + 1)
  })

  it('retains the environment operation after assignment deletion and blocks replacement assignment for that owner', async () => {
    const f = await fixture(), operation = f.operationId()
    const lease = await f.repository.acquireStopLease(f.target, operation, f.owner)
    await pool.query('DELETE FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2', [f.context.organizationId, lease.runtimeId])
    expect(await f.count()).toBe(1)
    expect((await pool.query<{ retired: boolean }>('SELECT retired_at IS NOT NULL retired FROM harness.runtime_environments WHERE id=$1',
      [lease.runtimeId])).rows[0]!.retired).toBe(true)
    const insert = () => pool.query(`INSERT INTO harness.instances(organization_id,project_id,assigned_node_id,port)
      VALUES($1,$2,$3,$4)`, [f.context.organizationId, f.project.id, f.context.nodeId, f.cfg.instancePortBase + 8])
    await expect(insert()).rejects.toMatchObject({ code: '55000', constraint: 'runtime_destructive_operation' })
    await f.repository.releaseStopLease(operation, f.owner)
    await insert()
    expect((await pool.query<{ runtime_id: string }>('SELECT runtime_id FROM harness.instances WHERE organization_id=$1 AND project_id=$2',
      [f.context.organizationId, f.project.id])).rows[0]!.runtime_id).not.toBe(lease.runtimeId)
  })

  it('rechecks a pending operation inside an UPDATE whose statement snapshot predates the operation', async () => {
    const f = await fixture(), applicationName = `stale-start-${randomUUID()}`
    const contenderPool = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
    cleanups.push(() => contenderPool.end())
    const blocker = await pool.connect(), operation = f.operationId()
    let restarting: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      const row = (await blocker.query<{ runtime_id: string; generation: string }>(`SELECT runtime_id,generation::text FROM harness.instances
        WHERE organization_id=$1 AND project_id=$2 FOR UPDATE`, [f.context.organizationId, f.project.id])).rows[0]!
      const other = new PostgresInstanceRepository({ ...f.context, pool: contenderPool }, f.cfg.instancePortBase)
      restarting = other.beginStart(f.target, Date.now(), randomBytes(32), 'explicit').catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE application_name=$1 AND wait_event_type='Lock'`, [applicationName])).rowCount).toBe(1)
      await blocker.query(`INSERT INTO harness.runtime_destructive_operations
        (organization_id,runtime_id,node_id,generation,operation_id,gateway_owner_id,gateway_generation) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [f.context.organizationId, row.runtime_id, f.context.nodeId, row.generation, operation, f.owner.ownerId, f.owner.generation])
      await blocker.query("UPDATE harness.instances SET observed_state='stopping' WHERE runtime_id=$1", [row.runtime_id])
      await blocker.query("UPDATE harness.instances SET observed_state='stopped' WHERE runtime_id=$1", [row.runtime_id])
      await blocker.query('COMMIT')
      expect(await restarting).toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
      expect(await f.repository.generationOf(f.target)).toBe(Number(row.generation))
      expect(await f.repository.stateOf(f.target)).toBe('stopped')
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await restarting
    }
  })

  it('joins administrative callbacks without taking model credits before retiring the kernel owner', async () => {
    const f = await fixture()
    let entered!: () => void, release!: () => void
    const pending = new Promise<void>(resolve => { entered = resolve }), finish = new Promise<void>(resolve => { release = resolve })
    const operation = f.operationId()
    const task = f.processOwner.withOwnership(async owner => {
      await f.repository.acquireStopLease(f.target, operation, owner)
      entered(); await finish
    })
    cleanups.push(async () => { release(); await task })
    await pending
    const closing = f.processOwner.close()
    let completed = false; void closing.then(() => { completed = true })
    const other = await GatewayModelBudget.open(f.budget, f.directory)
    cleanups.push(() => other.close())
    expect(completed).toBe(false)
    expect(await f.count()).toBe(1)
    expect(await f.budget.gateways()).toHaveLength(2)
    expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 0, queued: 0 })
    await expect(f.processOwner.withOwnership(async () => undefined)).rejects.toThrow('ownership is closed')
    release(); await task; await closing
    expect(await f.count()).toBe(0)
    expect(await f.repository.stateOf(f.target)).toBe('stopping')
  })

  it.for(['missing', 'closed'] as const)('refuses destructive dispatch with a %s process owner before changing assignment state', async state => {
    const f = await fixture()
    const manager = new InstanceManager(f.repository, f.cfg, undefined, undefined, undefined, state === 'missing' ? undefined : f.processOwner)
    cleanups.push(() => manager.stopAll())
    if (state === 'closed') await f.processOwner.close()
    const operation = vi.fn(async () => undefined)
    await expect(manager.withStopped(f.target, operation)).rejects.toMatchObject({ code: 'INSTANCE_STOP_FAILED' })
    expect(operation).not.toHaveBeenCalled()
    expect(await f.repository.stateOf(f.target)).toBe('stopped')
    expect(await f.count()).toBe(0)
  })

  it('keeps an acquisition with a lost acknowledgement fenced until the proved process owner retires', async () => {
    const f = await fixture(), acquire = f.repository.acquireStopLease.bind(f.repository)
    vi.spyOn(f.repository, 'acquireStopLease').mockImplementationOnce(async (...args) => {
      await acquire(...args); throw new Error('Lost committed operation acknowledgement')
    })
    const manager = new InstanceManager(f.repository, f.cfg, undefined, undefined, undefined, f.processOwner)
    cleanups.push(() => manager.stopAll())
    const operation = vi.fn(async () => undefined)
    await expect(manager.withStopped(f.target, operation)).rejects.toMatchObject({ code: 'INSTANCE_STOP_FAILED' })
    expect(operation).not.toHaveBeenCalled()
    expect(await f.count()).toBe(1)
    await f.processOwner.close()
    expect(await f.count()).toBe(0)
    expect(await f.repository.stateOf(f.target)).toBe('stopping')
  })

  it.for(['committed', 'failed'] as const)('retains a failed release after %s data work and reports both failures when present', async kind => {
    const f = await fixture(), releaseFailure = new Error('Operation release unavailable'), dataFailure = new Error('Data write refused')
    vi.spyOn(f.repository, 'releaseStopLease').mockRejectedValueOnce(releaseFailure)
    const manager = new InstanceManager(f.repository, f.cfg, {
      instancesOutliveGateway: false,
      start: async () => { throw new Error('Destructive fixture cannot start a process') },
      attach: () => { throw new Error('A cold assignment cannot attach a process') },
    }, undefined, undefined, f.processOwner)
    cleanups.push(() => manager.stopAll())
    let called = false
    const result = await manager.withStopped(f.target, async () => {
      called = true
      if (kind === 'failed') throw dataFailure
      return 'committed'
    }).catch((error: unknown) => error)
    expect(called).toBe(true)
    if (kind === 'failed') expect(result).toMatchObject({ errors: [dataFailure, releaseFailure] })
    else expect(result).toMatchObject({ code: 'INSTANCE_STOP_FAILED', cause: releaseFailure })
    expect(await f.repository.stateOf(f.target)).toBe('stopped')
    expect(await f.count()).toBe(1)
    await expect(f.repository.beginStart(f.target, Date.now(), randomBytes(32), 'explicit')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
    await f.processOwner.close()
    expect(await f.count()).toBe(0)
    expect(await f.repository.beginStart(f.target, Date.now(), randomBytes(32), 'explicit')).toBe(2)
  })

  it('recovers a SIGKILLed operation only after its matching kernel witness is released', async () => {
    const f = await fixture()
    const child = fork(resolve(import.meta.dirname, 'fixtures/runtime-stop-owner.ts'), [], {
      execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, HGW_TEST_DATABASE_URL: databaseUrl,
        TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') },
    })
    let exited!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => { exited = resolve })
    let processError: Error | undefined, stderr = '', childOwnerId: GatewayResourceOwner['ownerId'] | undefined, listening = false
    child.once('error', error => { processError = error })
    child.once('exit', (code, signal) => { exited({ code, signal }) })
    child.stderr!.on('data', (value: Buffer) => { stderr += value.toString() })
    child.on('message', value => {
      if (typeof value !== 'object' || value === null || !('kind' in value)) return
      if (value.kind === 'listening') listening = true
      if (value.kind === 'held' && 'ownerId' in value && typeof value.ownerId === 'string') childOwnerId = value.ownerId as GatewayResourceOwner['ownerId']
    })
    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (processError === undefined) await closed
    })
    await expect.poll(() => { if (processError !== undefined) throw processError; return listening || stderr }, { timeout: 10_000 }).toBe(true)
    child.send({ context: { organizationId: f.context.organizationId, organizationSlug: f.context.organizationSlug,
      nodeId: f.context.nodeId, nodeName: f.context.nodeName }, config: f.cfg.resourceBudget, directory: f.directory,
    projectId: f.target.id, portBase: f.cfg.instancePortBase })
    await expect.poll(() => { if (stderr !== '') throw new Error(stderr); return childOwnerId !== undefined }, { timeout: 10_000 }).toBe(true)
    const observer = await GatewayModelBudget.open(f.budget, f.directory)
    cleanups.push(() => observer.close())
    expect(await f.count()).toBe(1)
    expect((await f.budget.gateways()).some(owner => owner.ownerId === childOwnerId)).toBe(true)
    await observer.close()
    child.kill('SIGKILL')
    expect(await closed).toEqual({ code: null, signal: 'SIGKILL' })
    const recovered = await GatewayModelBudget.open(f.budget, f.directory)
    cleanups.push(() => recovered.close())
    expect(await f.count()).toBe(0)
    expect((await f.budget.gateways()).some(owner => owner.ownerId === childOwnerId)).toBe(false)
    expect(await f.repository.stateOf(f.target)).toBe('stopping')
    await expect(f.repository.beginStart(f.target, Date.now(), randomBytes(32), 'explicit')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
  })

  it.for(['role', 'organization'] as const)('rechecks control authority after a concurrent %s withdrawal commits', async kind => {
    const f = await fixture(), applicationName = `control-withdrawal-${randomUUID()}`
    const contenderPool = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
    cleanups.push(() => contenderPool.end())
    const contender = new PostgresInstanceRepository({ ...f.context, pool: contenderPool }, f.cfg.instancePortBase)
    const blocker = await pool.connect()
    let stopping: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      if (kind === 'role') await blocker.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [f.context.organizationId, f.user.id])
      else await blocker.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
      stopping = contender.acquireStopLease(f.target, f.operationId(), f.owner, Number(f.user.public_id), 1, 'control').catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName])).rowCount).toBe(1)
      await blocker.query('COMMIT')
      expect(await stopping).toMatchObject({ code: 'forbidden' })
      expect(await f.count()).toBe(0)
      expect(await f.repository.stateOf(f.target)).toBe('stopped')
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await stopping
    }
  })

  it.for((['control', 'destructive'] as const).flatMap(purpose =>
    (['role', 'account', 'membership', 'organization'] as const).map(kind => ({ purpose, kind }))))('refuses revoked $kind authority for $purpose before reserving a stop operation', async ({ purpose, kind }) => {
    const f = await fixture()
    if (kind === 'role') await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1", [f.context.organizationId])
    else if (kind === 'account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.user.id])
    else if (kind === 'membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1", [f.context.organizationId])
    else await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
    await expect(f.repository.acquireStopLease(f.target, f.operationId(), f.owner, Number(f.user.public_id), 1, purpose)).rejects.toMatchObject({ code: 'forbidden' })
    expect(await f.count()).toBe(0)
    expect(await f.repository.stateOf(f.target)).toBe('stopped')
  })
})
