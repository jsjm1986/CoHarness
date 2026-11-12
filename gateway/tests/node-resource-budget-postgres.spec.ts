/** Real PostgreSQL reservations across independently owned Runtime generations and Gateway coordinators. */
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import type { ResourceOperationId } from '@deepseek-ai/dsh-resource-budget/types'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { GatewayModelBudget } from '../src/gateway-model-budget.ts'
import { loadConfig } from '../src/config.ts'
import { InstanceManager, INSTANCE_PROFILE } from '../src/instances.ts'
import { computeLaunchStamps } from '../src/launch-stamp.ts'
import type { UserRow } from '../src/auth.ts'
import { PostgresProgressUsage } from '../src/postgres/progress-usage.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { NodeResourceBudget, type NodeResourceBudgetConfig, type NodeResourceRequest } from '../src/node-resource-budget.ts'
import { createPostgresPool, runMigrations, transaction } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

/** A launch stamp the fence accepts under this config; variants differ but membership is what `liveEndpoint` checks. */
const mintedLaunchStamp = (cfg: Parameters<typeof computeLaunchStamps>[0]): string =>
  [...computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stamps][0]!
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

describePg('durable node resource budget', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 8 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture(overrides: Partial<NodeResourceBudgetConfig> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'hgw-node-resources-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const slug = 'resources-' + randomUUID()
    const organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Resource budget') RETURNING id", [slug],
    )).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const users: Array<{ uuid: string; id: number }> = []
    for (const name of ['alice', 'bob']) {
      const value = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id`, [organizationId, name, root])).rows[0]!
      users.push({ uuid: value.id, id: Number(value.public_id) })
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, value.id])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
        [organizationId, context.nodeId, value.id])
    }
    const projects: Array<{ uuid: string; id: number }> = []
    for (const name of ['one', 'two']) {
      const value = (await pool.query<{ id: string; public_id: string }>(
        'INSERT INTO harness.projects(organization_id,name) VALUES($1,$2) RETURNING id,public_id', [organizationId, name],
      )).rows[0]!
      projects.push({ uuid: value.id, id: Number(value.public_id) })
      await pool.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',
        [organizationId, value.id, context.nodeId, join(root, name)])
    }
    const repository = new PostgresInstanceRepository(context, 48000)
    await repository.initialize()
    await pool.query("UPDATE harness.instances SET observed_state='ready',desired_state='running' WHERE organization_id=$1", [organizationId])
    const config: NodeResourceBudgetConfig = {
      sampleMs: 500, staleMs: 2_000, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
      maxQueued: 16, maxQueuedPerUser: 8,
      maxQueuedPerProject: 8, maxQueuedBytes: 64 * 1024, maxWaitMs: 30_000, ...overrides,
    }
    const budget = new NodeResourceBudget(pool, organizationId, context.nodeId, config)
    const grant = (credits: number) => pool.query(
      "UPDATE harness.node_resource_state SET credits=credits+$3,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2",
      [organizationId, context.nodeId, credits],
    )
    const subjects: RuntimeCredentialSubject[] = [
      ...users.map(user => ({ organizationId, target: { kind: 'user' as const, id: user.id }, generation: 1, userInternalId: user.uuid })),
      ...projects.map(project => ({ organizationId, target: { kind: 'project' as const, id: project.id }, generation: 1, projectInternalId: project.uuid })),
    ]
    for (const subject of subjects) await budget.register(subject)
    const requestIds = new Map<string, ResourceOperationId>()
    const request = (subjectIndex: number, sequence: number, actorIndex = subjectIndex < 2 ? subjectIndex : 0, kind: NodeResourceRequest['kind'] = 'model'): NodeResourceRequest => {
      const key = `${subjectIndex}:${sequence}`
      let requestId = requestIds.get(key)
      if (requestId === undefined) { requestId = randomUUID() as ResourceOperationId; requestIds.set(key, requestId) }
      return {
        requestId, sequence, kind, actorId: users[actorIndex]!.id,
        projectId: subjects[subjectIndex]!.target.kind === 'project' ? subjects[subjectIndex]!.target.id : 0,
      }
    }
    return { budget, context, subjects, users, projects, request, config, grant, repository, root }
  }

  it.each([0, 2].flatMap(index => (['queued', 'active', 'uncertain'] as const).map(state => ({ index, state }))))
  ('refuses automatic idle stop while a $state operation retains Runtime $index', async ({ index, state }) => {
    const f = await fixture()
    const subject = f.subjects[index]!
    const operation = f.request(index, 1)
    if (state !== 'queued') await f.grant(1)
    expect(await f.budget.request(subject, operation)).toEqual({ state: state === 'queued' ? 'queued' : 'active' })
    if (state === 'uncertain') await f.budget.finish(subject, operation, 'uncertain')
    await f.repository.touch(subject.target, 0)
    expect(await f.repository.markIdleStopping(subject.target, subject.generation, Date.now())).toBe(false)
    expect(await f.repository.stateOf(subject.target)).toBe('ready')
    await f.budget.finish(subject, operation, state === 'queued' ? 'not-started' : 'quiescent')
    expect(await f.repository.markIdleStopping(subject.target, subject.generation, Date.now())).toBe(true)
    expect(await f.repository.stateOf(subject.target)).toBe('stopping')
  })

  it('keeps another Runtime resource intact during automatic idle stop', async () => {
    const f = await fixture()
    const other = f.subjects[1]!
    await f.grant(1)
    expect(await f.budget.request(other, f.request(1, 1))).toEqual({ state: 'active' })
    const idle = f.subjects[0]!
    await f.repository.touch(idle.target, 0)
    expect(await f.repository.markIdleStopping(idle.target, idle.generation, Date.now())).toBe(true)
    expect(await f.repository.stateOf(other.target)).toBe('ready')
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    await f.budget.finish(other, f.request(1, 1), 'quiescent')
  })

  it('rechecks activity and generation inside the automatic idle claim', async () => {
    const f = await fixture()
    const subject = f.subjects[0]!
    const cutoff = Date.now()
    await f.repository.touch(subject.target, cutoff + 1)
    expect(await f.repository.markIdleStopping(subject.target, subject.generation, cutoff)).toBe(false)
    await f.repository.touch(subject.target, 0)
    expect(await f.repository.markIdleStopping(subject.target, subject.generation + 1, cutoff)).toBe(false)
    expect(await f.repository.stateOf(subject.target)).toBe('ready')
  })

  it('serializes automatic idle stop against a simultaneous resource admission', async () => {
    const f = await fixture()
    const subject = f.subjects[0]!
    await f.repository.touch(subject.target, 0)
    const entered = new Set<object>()
    const observed = new Proxy(pool, { get(actualPool, key) {
      if (key === 'connect') return async () => {
        const client = await actualPool.connect()
        return new Proxy(client, { get(actual, property) {
          if (property === 'query') return async (sql: string, values?: readonly unknown[]) => {
            if (sql.includes('harness.node_resource_state') || sql.includes('harness.lock_node_resources')) entered.add(actual)
            return actual.query(sql, values === undefined ? undefined : [...values])
          }
          const value: unknown = Reflect.get(actual, property, actual)
          return typeof value === 'function' ? value.bind(actual) : value
        } })
      }
      const value: unknown = Reflect.get(actualPool, key, actualPool)
      return typeof value === 'function' ? value.bind(actualPool) : value
    } })
    const repository = new PostgresInstanceRepository({ ...f.context, pool: observed }, 48000)
    const budget = new NodeResourceBudget(observed, f.context.organizationId, f.context.nodeId, f.config)
    const operation = f.request(0, 1)
    type Admission = Awaited<ReturnType<NodeResourceBudget['request']>>
    let settlement: Promise<[PromiseSettledResult<boolean>, PromiseSettledResult<Admission>]> | undefined
    let results: Awaited<typeof settlement>
    try {
      await transaction(pool, async barrier => {
        await barrier.query('SELECT 1 FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2 FOR UPDATE',
          [f.context.organizationId, f.context.nodeId])
        settlement = Promise.allSettled([
          repository.markIdleStopping(subject.target, subject.generation, Date.now()),
          budget.request(subject, operation),
        ])
        await expect.poll(() => entered.size).toBe(2)
      })
    } finally { results = await settlement }
    if (results === undefined) throw new Error('Idle admission race did not start')
    const [stopped, admitted] = results
    expect(stopped.status).toBe('fulfilled')
    if (stopped.status === 'fulfilled' && stopped.value) {
      expect(admitted.status).toBe('rejected')
      expect(await repository.stateOf(subject.target)).toBe('stopping')
    } else {
      expect(admitted).toMatchObject({ status: 'fulfilled', value: { state: 'queued' } })
      expect(await repository.stateOf(subject.target)).toBe('ready')
      await budget.finish(subject, operation, 'not-started')
    }
  })

  /** Slow observation delivery belongs to one private connection pool; each delay counts once. */
  async function slowDispatch(f: Awaited<ReturnType<typeof fixture>>) {
    const observerPool = createPostgresPool(databaseUrl!, { max: 1 })
    cleanups.push(() => observerPool.end())
    let calls = 0
    const instrumented = new Proxy(observerPool, { get(actualPool, key) {
      if (key === 'query') return async (sql: string, values?: readonly unknown[]) => {
        if (sql === 'SELECT harness.observe_node_resources($1,$2,$3::jsonb,$4,$5::jsonb)') {
          calls++
          await new Promise(resolve => setTimeout(resolve, 150))
        }
        return actualPool.query(sql, values === undefined ? undefined : [...values])
      }
      const value: unknown = Reflect.get(actualPool, key, actualPool)
      return typeof value === 'function' ? value.bind(actualPool) : value
    } })
    return { budget: new NodeResourceBudget(instrumented, f.context.organizationId, f.context.nodeId, f.config),
      calls: () => calls }
  }

  /** Expiry commits on the owned client before the server-local scheduling call. */
  async function expiredBeforeDispatch(f: Awaited<ReturnType<typeof fixture>>) {
    const observerPool = createPostgresPool(databaseUrl!, { max: 1 })
    cleanups.push(() => observerPool.end())
    let calls = 0
    const instrumented = new Proxy(observerPool, { get(actualPool, key) {
      if (key === 'connect') return async () => {
        const client = await actualPool.connect()
        return new Proxy(client, { get(actual, property) {
          if (property === 'query') return async (sql: string, values?: readonly unknown[]) => {
            if (sql === 'SELECT harness.schedule_node_resources($1,$2)') {
              await actual.query(`UPDATE harness.node_resource_state SET valid_until=clock_timestamp()
                WHERE organization_id=$1 AND node_id=$2`, [f.context.organizationId, f.context.nodeId])
              calls++
            }
            return actual.query(sql, values === undefined ? undefined : [...values])
          }
          const value: unknown = Reflect.get(actual, property, actual)
          return typeof value === 'function' ? value.bind(actual) : value
        } })
      }
      const value: unknown = Reflect.get(actualPool, key, actualPool)
      return typeof value === 'function' ? value.bind(actualPool) : value
    } })
    return { budget: new NodeResourceBudget(instrumented, f.context.organizationId, f.context.nodeId, f.config),
      calls: () => calls }
  }

  async function prepareStart(f: Awaited<ReturnType<typeof fixture>>, index: number) {
    const previous = f.subjects[index]!
    await f.repository.markStopped(previous.target, previous.generation)
    const generation = await f.repository.beginStart(previous.target, Date.now(), Buffer.alloc(32, index + 1), 'explicit')
    return { ...previous, generation }
  }

  async function allocationState(f: Awaited<ReturnType<typeof fixture>>, subject: RuntimeCredentialSubject): Promise<string> {
    const result = await pool.query<{ allocation_state: string }>(`SELECT i.allocation_state FROM harness.instances i
      LEFT JOIN harness.users u ON u.id=i.user_id LEFT JOIN harness.projects p ON p.id=i.project_id
      WHERE i.organization_id=$1 AND i.assigned_node_id=$2
        AND CASE WHEN i.user_id IS NULL THEN 'project' ELSE 'user' END=$3
        AND COALESCE(u.public_id,p.public_id)=$4 AND i.generation=$5`,
    [f.context.organizationId, f.context.nodeId, subject.target.kind, subject.target.id, subject.generation])
    return result.rows[0]!.allocation_state
  }

  async function heldRequest(f: Awaited<ReturnType<typeof fixture>>) {
    const ownerPool = createPostgresPool(databaseUrl!, { max: 1 })
    cleanups.push(() => ownerPool.end())
    let release!: () => void, acquired!: (pid: number) => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const held = new Promise<number>(resolve => { acquired = resolve })
    let armed = true
    const instrumented = new Proxy(ownerPool, { get(actualPool, key) {
      if (key === 'connect') return async () => {
        const client = await actualPool.connect()
        return new Proxy(client, { get(actual, property) {
          if (property === 'query') return async (sql: string, values?: readonly unknown[]) => {
            const result = await actual.query(sql, values === undefined ? undefined : [...values])
            if (armed && sql.includes('FOR SHARE OF i') && result.rowCount === 1) {
              armed = false
              acquired((actual as typeof actual & { processID: number }).processID)
              await gate
            }
            return result
          }
          const value: unknown = Reflect.get(actual, property, actual)
          return typeof value === 'function' ? value.bind(actual) : value
        } })
      }
      const value: unknown = Reflect.get(actualPool, key, actualPool)
      return typeof value === 'function' ? value.bind(actualPool) : value
    } })
    await f.grant(1)
    const budget = new NodeResourceBudget(instrumented, f.context.organizationId, f.context.nodeId, f.config)
    const operation = f.request(0, 1, 0, 'process')
    const request = budget.request(f.subjects[0]!, operation)
    const settled = request.then(() => undefined, () => undefined)
    cleanups.push(async () => { release(); await settled })
    const pid = await held
    return { pid, request, operation, release }
  }

  it('waits beyond the pool lock timeout for one resource request before admitting activity and a fresh observation', async () => {
    const f = await fixture({ staleMs: 10_000 })
    const held = await heldRequest(f)
    const waitingPool = createPostgresPool(databaseUrl!, { max: 2, lock_timeout: 40, statement_timeout: 5000 })
    cleanups.push(() => waitingPool.end())
    const repository = new PostgresInstanceRepository({ ...f.context, pool: waitingPool }, 48000)
    const budget = new NodeResourceBudget(waitingPool, f.context.organizationId, f.context.nodeId, f.config)
    let finished = 0
    const lease = repository.admitLease(f.subjects[0]!.target, Date.now(), f.subjects[0]!.generation).finally(() => { finished += 1 })
    const observation = budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 2 })
      .finally(() => { finished += 1 })
    const joined = Promise.allSettled([lease, observation])
    cleanups.push(async () => { held.release(); await joined })
    await expect(f.repository.admitLease(f.subjects[1]!.target, Date.now(), f.subjects[1]!.generation)).resolves.toBe(true)
    await expect.poll(async () => Number((await pool.query<{ count: string }>(`SELECT count(*)::text count FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))
        AND clock_timestamp()-query_start>interval '150 milliseconds'`, [held.pid])).rows[0]!.count), { timeout: 3000 }).toBe(2)
    expect(finished).toBe(0)
    held.release()
    await expect(held.request).resolves.toEqual({ state: 'active' })
    await expect(lease).resolves.toBe(true)
    await expect(observation).resolves.toBeUndefined()
    await f.budget.finish(f.subjects[0]!, held.operation, 'quiescent')
    expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
  })

  it('refuses statement-bound contention without retaining activity or changing the original resource operation', async () => {
    const f = await fixture(), held = await heldRequest(f)
    const waitingPool = createPostgresPool(databaseUrl!, { max: 3, lock_timeout: 20, statement_timeout: 100 })
    cleanups.push(() => waitingPool.end())
    const repository = new PostgresInstanceRepository({ ...f.context, pool: waitingPool }, 48000)
    const budget = new NodeResourceBudget(waitingPool, f.context.organizationId, f.context.nodeId, f.config)
    const before = (await pool.query<{ at: string }>('SELECT last_activity_at::text at FROM harness.instances WHERE organization_id=$1 AND user_id=$2',
      [f.context.organizationId, f.users[0]!.uuid])).rows[0]!.at
    await expect(repository.admitLease(f.subjects[0]!.target, Date.now(), f.subjects[0]!.generation))
      .rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', cause: { code: '57014' } })
    await expect(repository.touch(f.subjects[0]!.target, Date.now()))
      .rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE', cause: { code: '57014' } })
    await expect(budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 2 }))
      .rejects.toMatchObject({ status: 503, reason: 'database-busy', cause: { code: '57014' } })
    expect((await pool.query<{ at: string }>('SELECT last_activity_at::text at FROM harness.instances WHERE organization_id=$1 AND user_id=$2',
      [f.context.organizationId, f.users[0]!.uuid])).rows[0]!.at).toBe(before)
    held.release()
    await expect(held.request).resolves.toEqual({ state: 'active' })
    expect((await f.budget.snapshot()).kinds.process.active).toBe(1)
    await f.budget.finish(f.subjects[0]!, held.operation, 'quiescent')
  })

  it.each(['generation', 'computer', 'membership'] as const)('rechecks %s eligibility after waiting for an instance writer', async change => {
    const f = await fixture()
    const holder = await pool.connect()
    cleanups.push(async () => { await holder.query('ROLLBACK'); holder.release() })
    await holder.query('BEGIN')
    await holder.query('SELECT 1 FROM harness.instances WHERE organization_id=$1 AND user_id=$2 FOR UPDATE',
      [f.context.organizationId, f.users[0]!.uuid])
    const waitingPool = createPostgresPool(databaseUrl!, { max: 1, lock_timeout: 20, statement_timeout: 5000 })
    cleanups.push(() => waitingPool.end())
    const repository = new PostgresInstanceRepository({ ...f.context, pool: waitingPool }, 48000)
    const lease = repository.admitLease(f.subjects[0]!.target, Date.now(), f.subjects[0]!.generation)
    const settled = lease.then(() => undefined, () => undefined)
    cleanups.push(async () => { await holder.query('ROLLBACK'); await settled })
    const pid = (holder as typeof holder & { processID: number }).processID
    await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
      WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, [pid])).rowCount).toBe(1)
    switch (change) {
      case 'generation':
        await holder.query('UPDATE harness.instances SET generation=generation+1 WHERE organization_id=$1 AND user_id=$2', [f.context.organizationId, f.users[0]!.uuid])
        break
      case 'computer':
        await holder.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',
          [f.context.organizationId, f.context.nodeId, f.users[0]!.uuid])
        break
      case 'membership':
        await holder.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1 AND user_id=$2", [f.context.organizationId, f.users[0]!.uuid])
        break
    }
    await holder.query('COMMIT')
    await expect(lease).resolves.toBe(false)
  })

  it('restores lock waiting after commit and retains the pool bound when statement waiting is unlimited', async () => {
    for (const statement_timeout of [5000, 0]) {
      const waitingPool = createPostgresPool(databaseUrl!, { max: 1, lock_timeout: 40, statement_timeout })
      cleanups.push(() => waitingPool.end())
      expect(await transaction(waitingPool, async client => (await client.query<{ setting: string }>("SELECT current_setting('lock_timeout') setting")).rows[0]!.setting,
        undefined, { lockWait: 'statement' })).toBe(statement_timeout === 0 ? '40ms' : '5s')
      expect((await waitingPool.query<{ setting: string }>("SELECT current_setting('lock_timeout') setting")).rows[0]!.setting).toBe('40ms')
    }
  })

  it('preserves integrity failures without retaining activity and accepts an omitted generation for an eligible assignment', async () => {
    const f = await fixture(), target = f.subjects[0]!.target
    await expect(f.repository.admitLease(target, Date.now())).resolves.toBe(true)
    const name = `activity_failure_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION harness.${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.organization_id::text=TG_ARGV[0] THEN RAISE EXCEPTION 'activity write refused' USING ERRCODE='23514'; END IF;
        RETURN NEW;
      END $$`)
    cleanups.push(async () => {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON harness.instances`)
      await pool.query(`DROP FUNCTION harness.${name}()`)
    })
    await pool.query(`CREATE TRIGGER ${name} BEFORE UPDATE ON harness.instances
      FOR EACH ROW EXECUTE FUNCTION harness.${name}('${f.context.organizationId}')`)
    const before = (await pool.query<{ at: string }>('SELECT last_activity_at::text at FROM harness.instances WHERE organization_id=$1 AND user_id=$2',
      [f.context.organizationId, f.users[0]!.uuid])).rows[0]!.at
    await expect(f.repository.admitLease(target, Date.now())).rejects.toMatchObject({ code: '23514' })
    expect((await pool.query<{ at: string }>('SELECT last_activity_at::text at FROM harness.instances WHERE organization_id=$1 AND user_id=$2',
      [f.context.organizationId, f.users[0]!.uuid])).rows[0]!.at).toBe(before)
  })

  it('retains a committed resource whose acknowledgement is lost without replaying its operation', async () => {
    const f = await fixture()
    await f.grant(1)
    const ownerPool = createPostgresPool(databaseUrl!, { max: 1 })
    cleanups.push(() => ownerPool.end())
    let commits = 0
    const proxy = new Proxy(ownerPool, { get(actualPool, key) {
      if (key === 'connect') return async () => {
        const client = await actualPool.connect()
        return new Proxy(client, { get(actual, property) {
          if (property === 'query') return async (sql: string, values?: readonly unknown[]) => {
            const response = await actual.query(sql, values === undefined ? undefined : [...values])
            if (sql === 'COMMIT') { commits += 1; throw Object.assign(new Error('acknowledgement lost'), { code: 'ECONNRESET' }) }
            return response
          }
          const value: unknown = Reflect.get(actual, property, actual)
          return typeof value === 'function' ? value.bind(actual) : value
        } })
      }
      const value: unknown = Reflect.get(actualPool, key, actualPool)
      return typeof value === 'function' ? value.bind(actualPool) : value
    } })
    const budget = new NodeResourceBudget(proxy, f.context.organizationId, f.context.nodeId, f.config)
    const operation = f.request(0, 1, 0, 'process')
    await expect(budget.request(f.subjects[0]!, operation)).rejects.toMatchObject({ code: 'ECONNRESET' })
    expect(commits).toBe(1)
    expect((await f.budget.snapshot()).kinds.process.active).toBe(1)
    await expect(f.budget.request(f.subjects[0]!, operation)).resolves.toEqual({ state: 'active' })
    await f.budget.finish(f.subjects[0]!, operation, 'quiescent')
    expect((await f.budget.snapshot()).kinds.process.active).toBe(0)
  })

  it('waits for a fresh host sample before admitting a Runtime and spends the shared credit', async () => {
    const f = await fixture({ sampleMs: 10, staleMs: 10_000, maxWaitMs: 10_000 })
    const subject = await prepareStart(f, 0)
    const cancel = new AbortController()
    const pending = f.budget.admitRuntimeStart(subject.target, subject.generation, cancel.signal)
    cleanups.push(async () => { cancel.abort(); await pending.catch(() => {}) })
    await expect.poll(() => allocationState(f, subject)).toBe('waiting')
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(0)
    await f.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
    await pending
    expect(await allocationState(f, subject)).toBe('possible')
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(1)
    await f.budget.register(subject)
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'queued' })
  })

  it.each(['account', 'project', 'computer', 'unknown'] as const)('honors the explicit Runtime identity instead of a %s reference', async (reference) => {
    const f = await fixture()
    const subject = await prepareStart(f, 0)
    const target = await f.repository.resolveTarget(subject.target)
    let foreign = reference === 'unknown' ? randomUUID() as typeof target.runtimeId
      : (await f.repository.resolveTarget(f.subjects[reference === 'account' ? 1 : 2]!.target)).runtimeId
    if (reference === 'computer') {
      const node = (await pool.query<{ id: string }>("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'other') RETURNING id",
        [f.context.organizationId])).rows[0]!.id
      await pool.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)',
        [f.context.organizationId, node, f.users[0]!.uuid, f.root])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
        [f.context.organizationId, node, f.users[0]!.uuid])
      foreign = (await pool.query<{ runtime_id: NonNullable<typeof target.runtimeId> }>(`INSERT INTO harness.instances
        (organization_id,user_id,assigned_node_id,port,storage_layout) VALUES($1,$2,$3,48000,'isolated') RETURNING runtime_id`,
      [f.context.organizationId, f.users[0]!.uuid, node])).rows[0]!.runtime_id
    }
    await f.grant(1)
    await expect(f.budget.admitRuntimeStart({ ...target, runtimeId: foreign }, subject.generation, new AbortController().signal))
      .rejects.toMatchObject({ reason: 'stale-generation' })
    expect(await allocationState(f, subject)).toBe('not-started')
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(0)
    await f.budget.admitRuntimeStart(target, subject.generation, new AbortController().signal)
    expect(await allocationState(f, subject)).toBe('possible')
  })

  it('does not renew pressure observations that expire while waiting for the node lock', async () => {
    const f = await fixture({ sampleMs: 10, staleMs: 50 })
    const applicationName = `pressure-lock-${randomUUID()}`
    const observerPool = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
    const observer = new NodeResourceBudget(observerPool, f.context.organizationId, f.context.nodeId, f.config)
    const blocker = await pool.connect()
    let observing: Promise<unknown> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT 1 FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2 FOR UPDATE',
        [f.context.organizationId, f.context.nodeId])
      const sample = { capturedAt: performance.now(), cpu: 0, memory: 'normal' as const, eventLoopMs: 0, parallelism: 1 }
      observing = observer.observe(sample).then(() => undefined, (error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [applicationName],
      )).rows[0]!.waiting).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 120))
      await blocker.query('COMMIT')
      await expect(observing).resolves.toBeUndefined()
      expect((await pool.query<{ credits: number }>(
        'SELECT credits FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2',
        [f.context.organizationId, f.context.nodeId],
      )).rows[0]!.credits).toBe(0)
    } finally {
      await blocker.query('ROLLBACK')
      blocker.release()
      await observing
      await observerPool.end()
    }
  })

  it('publishes only the remaining pressure validity after capture', async () => {
    const f = await fixture({ sampleMs: 10 })
    const sample = { capturedAt: performance.now() - 1500, cpu: 0, memory: 'normal' as const, eventLoopMs: 0, parallelism: 1 }
    await f.budget.observe(sample)
    const state = (await pool.query<{ remaining: number; age: number }>(`SELECT
      EXTRACT(EPOCH FROM valid_until-clock_timestamp())*1000 remaining,
      EXTRACT(EPOCH FROM clock_timestamp()-sampled_at)*1000 age
      FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2`,
    [f.context.organizationId, f.context.nodeId])).rows[0]!
    expect(Number(state.remaining)).toBeLessThanOrEqual(500)
    expect(Number(state.age)).toBeGreaterThanOrEqual(1500)
  })

  it('preserves a newer pressure observation when an older capture finishes later', async () => {
    const f = await fixture({ sampleMs: 10 })
    await pool.query(`UPDATE harness.node_resource_state SET credits=0,pressure='{"memory":"warning"}'::jsonb,
      sampled_at=clock_timestamp()-interval '100 milliseconds',sampled_before=clock_timestamp()-interval '100 milliseconds',valid_until=clock_timestamp()+interval '1 second'
      WHERE organization_id=$1 AND node_id=$2`, [f.context.organizationId, f.context.nodeId])
    await f.budget.observe({ capturedAt: performance.now() - 200, cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
    expect((await pool.query<{ credits: number; pressure: unknown }>(
      'SELECT credits,pressure FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2',
      [f.context.organizationId, f.context.nodeId],
    )).rows[0]).toEqual({ credits: 0, pressure: { memory: 'warning' } })
  })

  it('preserves a newer warning when an older healthy capture follows a delayed observation delivery', async () => {
    const f = await fixture({ sampleMs: 10, staleMs: 10_000 })
    const delayed = await slowDispatch(f)
    const older = { capturedAt: performance.now(), cpu: 0, memory: 'normal' as const, eventLoopMs: 0, parallelism: 1 }
    await delayed.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'warning', eventLoopMs: 0, parallelism: 1 })
    expect(delayed.calls()).toBeGreaterThan(0)
    await f.budget.observe(older)
    expect((await pool.query<{ credits: number; pressure: { memory: string } }>(
      'SELECT credits,pressure FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2',
      [f.context.organizationId, f.context.nodeId],
    )).rows[0]).toMatchObject({ credits: 0, pressure: { memory: 'warning' } })
  })

  it('applies a fresh warning immediately inside the observation cadence', async () => {
    const f = await fixture({ sampleMs: 60_000, staleMs: 120_000 })
    await f.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 8 })
    await f.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'warning', eventLoopMs: 0, parallelism: 8 })
    expect((await pool.query<{ credits: number }>('SELECT credits FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2',
      [f.context.organizationId, f.context.nodeId])).rows[0]!.credits).toBe(0)
  })

  it('refuses a queued model when pressure expires before server-local dispatch', async () => {
    const f = await fixture(), operation = f.request(0, 1)
    expect(await f.budget.request(f.subjects[0]!, operation)).toEqual({ state: 'queued' })
    await f.grant(1)
    const delayed = await expiredBeforeDispatch(f)
    expect(await delayed.budget.status(f.subjects[0]!, operation)).toEqual({ state: 'queued' })
    expect(await delayed.calls()).toBeGreaterThan(0)
    expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 0, queued: 1 })
  })

  it.each(['missing-upper', 'inverted'] as const)('rejects %s persisted capture bounds', async kind => {
    const f = await fixture()
    await expect(pool.query(`UPDATE harness.node_resource_state SET sampled_at=clock_timestamp(),
      sampled_before=CASE WHEN $3='inverted' THEN clock_timestamp()-interval '1 second' ELSE NULL END
      WHERE organization_id=$1 AND node_id=$2`, [f.context.organizationId, f.context.nodeId, kind])).rejects.toMatchObject({ code: '23514' })
  })

  it('retains the newer ordering witness and warning horizon after a delayed older warning', async () => {
    const f = await fixture({ sampleMs: 10, staleMs: 10_000 })
    const capturedAt = performance.now()
    await pool.query(`UPDATE harness.node_resource_state SET pressure='{"memory":"warning"}'::jsonb,credits=0,
      sampled_at=clock_timestamp(),sampled_before=clock_timestamp(),valid_until=clock_timestamp()+interval '10 seconds'
      WHERE organization_id=$1 AND node_id=$2`, [f.context.organizationId, f.context.nodeId])
    const stored = async () => (await pool.query<{ sampled_before: string; valid_until: string }>(
      'SELECT sampled_before::text,valid_until::text FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2',
      [f.context.organizationId, f.context.nodeId],
    )).rows[0]!
    const previous = await stored()
    await f.budget.observe({ capturedAt: capturedAt - 100, cpu: 0, memory: 'warning', eventLoopMs: 0, parallelism: 1 })
    expect(await stored()).toEqual(previous)
    await f.budget.observe({ capturedAt: capturedAt - 50, cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
    expect((await pool.query<{ credits: number }>('SELECT credits FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2',
      [f.context.organizationId, f.context.nodeId])).rows[0]!.credits).toBe(0)
  })

  it('admits a proven newer healthy capture after a warning', async () => {
    const f = await fixture({ sampleMs: 10, staleMs: 10_000 })
    await pool.query(`UPDATE harness.node_resource_state SET pressure='{"memory":"warning"}'::jsonb,credits=0,
      sampled_at=clock_timestamp()-interval '1 second',sampled_before=clock_timestamp()-interval '1 second',valid_until=clock_timestamp()+interval '9 seconds'
      WHERE organization_id=$1 AND node_id=$2`, [f.context.organizationId, f.context.nodeId])
    await f.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'active' })
  })

  it('shares one Runtime start credit across independent coordinators without preparation deadlock', async () => {
    const f = await fixture({ sampleMs: 10, staleMs: 10_000, maxWaitMs: 10_000 })
    const subjects = await Promise.all([prepareStart(f, 0), prepareStart(f, 1)])
    const other = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, f.config)
    const cancel = new AbortController()
    const pending = subjects.map((subject, index) => (index === 0 ? f.budget : other)
      .admitRuntimeStart(subject.target, subject.generation, cancel.signal).then(() => index))
    cleanups.push(async () => { cancel.abort(); await Promise.allSettled(pending) })
    await expect.poll(() => Promise.all(subjects.map(subject => allocationState(f, subject)))).toEqual(['waiting', 'waiting'])
    await f.grant(1)
    const winner = await Promise.race(pending)
    expect(await allocationState(f, subjects[winner]!)).toBe('possible')
    expect(await allocationState(f, subjects[1 - winner]!)).toBe('waiting')
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(1)
    await other.register(subjects[winner]!)
    await f.grant(1)
    await Promise.all(pending)
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(2)
  })

  it('admits allocation only once per generation and rejects unknown durable allocation states', async () => {
    const f = await fixture()
    const subject = await prepareStart(f, 0)
    await f.grant(1)
    await f.budget.admitRuntimeStart(subject.target, subject.generation, new AbortController().signal)
    await expect(f.budget.admitRuntimeStart(subject.target, subject.generation, new AbortController().signal))
      .rejects.toMatchObject({ reason: 'stale-generation' })
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(1)
    await expect(pool.query("UPDATE harness.instances SET allocation_state='complete' WHERE organization_id=$1", [f.context.organizationId]))
      .rejects.toMatchObject({ code: '23514' })
    expect(await allocationState(f, subject)).toBe('possible')
  })

  it('cancels a pressure-waiting Runtime before allocation and rejects stopped generations', async () => {
    const f = await fixture({ sampleMs: 10, staleMs: 10_000 })
    const subject = await prepareStart(f, 0)
    const cancel = new AbortController()
    const pending = f.budget.admitRuntimeStart(subject.target, subject.generation, cancel.signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'INSTANCE_CAPACITY', reason: 'cancelled' })
    cleanups.push(async () => { cancel.abort(); await pending.catch(() => {}) })
    await expect.poll(() => allocationState(f, subject)).toBe('waiting')
    cancel.abort()
    await refused
    expect(await allocationState(f, subject)).toBe('waiting')
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(0)
    await f.repository.markStopping(subject.target, subject.generation)
    await f.grant(1)
    await expect(f.budget.admitRuntimeStart(subject.target, subject.generation, new AbortController().signal))
      .rejects.toMatchObject({ reason: 'stale-generation' })
  })

  it('expires a Runtime pressure wait without allocating', async () => {
    const f = await fixture({ sampleMs: 10, maxWaitMs: 50 })
    const subject = await prepareStart(f, 0)
    await expect(f.budget.admitRuntimeStart(subject.target, subject.generation, new AbortController().signal))
      .rejects.toMatchObject({ code: 'INSTANCE_CAPACITY', reason: 'timeout' })
    expect(['not-started', 'waiting']).toContain(await allocationState(f, subject))
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(0)
  })

  it.each(['stale', 'memory-warning'] as const)('refuses Runtime allocation under %s pressure', async (condition) => {
    const f = await fixture({ sampleMs: 10, staleMs: 10_000 })
    const subject = await prepareStart(f, 0)
    if (condition === 'stale') {
      await f.grant(1)
      await pool.query("UPDATE harness.node_resource_state SET valid_until=clock_timestamp()-interval '1 second' WHERE organization_id=$1 AND node_id=$2",
        [f.context.organizationId, f.context.nodeId])
    } else {
      await f.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'warning', eventLoopMs: 0, parallelism: 8 })
    }
    const cancel = new AbortController()
    const pending = f.budget.admitRuntimeStart(subject.target, subject.generation, cancel.signal)
    const refused = expect(pending).rejects.toMatchObject({ code: 'INSTANCE_CAPACITY', reason: 'cancelled' })
    cleanups.push(async () => { cancel.abort(); await pending.catch(() => {}) })
    await expect.poll(() => allocationState(f, subject)).toBe('waiting')
    expect((await f.budget.snapshot()).outcomes.runtime_starts_admitted).toBe(0)
    cancel.abort()
    await refused
  })

  it('invalidates unused pressure credits when the committed deployment policy changes', async () => {
    const f = await fixture()
    await f.budget.observe({ capturedAt: performance.now(), cpu: 0.3, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
    const stricter = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, { ...f.config, cpuTarget: 0.2 })
    await stricter.configure()
    const state = await pool.query<{ credits: number; valid_until: Date | null }>(
      'SELECT credits,valid_until FROM harness.node_resource_state WHERE organization_id=$1 AND node_id=$2',
      [f.context.organizationId, f.context.nodeId])
    expect(state.rows[0]).toEqual({ credits: 0, valid_until: null })
  })

  it('keeps one active budget across Runtime processes and a reconstructed Gateway coordinator', async () => {
    const f = await fixture()
    await f.grant(1)
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'active' })
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'queued' })
    const restarted = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, f.config)
    expect((await restarted.snapshot()).kinds.model).toMatchObject({ active: 1, queued: 1 })
    await restarted.finish(f.subjects[0]!, f.request(0, 1), 'uncertain')
    expect((await restarted.snapshot()).kinds.model).toMatchObject({ active: 1, uncertain: 1, queued: 1 })
    expect(await restarted.status(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'queued' })
    await f.budget.finish(f.subjects[0]!, f.request(0, 1), 'quiescent')
    await f.grant(1)
    expect(await restarted.status(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'active' })
  })

  it('returns the committed node policy when another coordinator changes the deployment limits', async () => {
    const f = await fixture()
    const policy = { ...f.config, maxWaitMs: 12_000 }
    await new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, policy).configure()
    expect(await f.budget.register(f.subjects[0]!)).toEqual({ nextSequence: 1, policy })
  })

  it('applies the committed Linux memory reserve to observations from an older coordinator', async () => {
    const f = await fixture()
    await new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId,
      { ...f.config, linuxMemoryReserveRatio: 0.2 }).configure()
    await f.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 8, memoryAvailableRatio: 0.15 })
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'queued' })
  })

  it('rotates users before projects, so extra projects cannot buy another user turn', async () => {
    const f = await fixture()
    await f.grant(1)
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[2]!, f.request(2, 1))
    await f.budget.request(f.subjects[3]!, f.request(3, 1))
    await f.budget.request(f.subjects[1]!, f.request(1, 1))
    await f.budget.request(f.subjects[2]!, f.request(2, 2))
    await f.budget.finish(f.subjects[0]!, f.request(0, 1), 'quiescent')
    await f.grant(1)
    expect(await f.budget.status(f.subjects[2]!, f.request(2, 1))).toEqual({ state: 'active' })
    await f.budget.finish(f.subjects[2]!, f.request(2, 1), 'quiescent')
    await f.grant(1)
    expect(await f.budget.status(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'active' })
    await f.budget.finish(f.subjects[1]!, f.request(1, 1), 'quiescent')
    await f.grant(1)
    expect(await f.budget.status(f.subjects[3]!, f.request(3, 1))).toEqual({ state: 'active' })
    expect(await f.budget.status(f.subjects[2]!, f.request(2, 2))).toEqual({ state: 'queued' })
  })

  it('fences delayed registrations after cancellation without retaining completed rows', async () => {
    const f = await fixture()
    await f.budget.finish(f.subjects[0]!, f.request(0, 1), 'not-started')
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'closed' })
    await f.grant(1)
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 2))).toEqual({ state: 'active' })
    await f.budget.finish(f.subjects[0]!, f.request(0, 2), 'quiescent')
    await f.budget.finish(f.subjects[0]!, f.request(0, 2), 'quiescent')
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 2))).toEqual({ state: 'closed' })
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it('replays one request and rejects changed metadata or a skipped sequence', async () => {
    const f = await fixture()
    const request = f.request(0, 1)
    await f.grant(1)
    await f.budget.request(f.subjects[0]!, request)
    expect(await f.budget.request(f.subjects[0]!, request)).toEqual({ state: 'active' })
    await expect(f.budget.request(f.subjects[0]!, { ...request, kind: 'process' })).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.request(f.subjects[0]!, f.request(0, 3))).rejects.toMatchObject({ status: 409 })
    expect((await f.budget.snapshot()).outcomes.admitted).toBe(1)
  })

  it('does not share a reservation between distinct operations reusing one registration sequence', async () => {
    const f = await fixture()
    const subject = f.subjects[0]!
    const retiring = await f.budget.register(subject)
    const replacement = await f.budget.register(subject)
    expect(retiring.nextSequence).toBe(replacement.nextSequence)
    const first = { ...f.request(0, retiring.nextSequence), requestId: randomUUID() as ResourceOperationId }
    const second = { ...f.request(0, replacement.nextSequence), requestId: randomUUID() as ResourceOperationId }
    await f.grant(1)
    expect(await f.budget.request(subject, first)).toEqual({ state: 'active' })
    expect(await f.budget.statuses(subject, [first])).toEqual([{ state: 'active' }])
    await expect(f.budget.request(subject, second)).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.status(subject, second)).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.statuses(subject, [first, second])).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.finish(subject, second, 'not-started')).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.finish(subject, second, 'uncertain')).rejects.toMatchObject({ status: 409 })
    expect(await f.budget.request(subject, first)).toEqual({ state: 'active' })
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    await expect(f.budget.request(subject, { ...first, sequence: 2 })).rejects.toMatchObject({ status: 409 })
    await f.budget.finish(subject, first, 'quiescent')
    expect(await f.budget.statuses(subject, [first, second])).toEqual([{ state: 'closed' }, { state: 'closed' }])
  })

  it('keeps reservations without an operation owner until the Runtime is confirmed stopped', async () => {
    const f = await fixture()
    const subject = f.subjects[0]!
    const operation = f.request(0, 1)
    await f.grant(1)
    await f.budget.request(subject, operation)
    await pool.query('UPDATE harness.node_resource_requests SET operation_id=NULL WHERE organization_id=$1', [f.context.organizationId])
    await expect(f.budget.status(subject, operation)).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.statuses(subject, [operation])).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.finish(subject, operation, 'quiescent')).rejects.toMatchObject({ status: 409 })
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    await pool.query("UPDATE harness.instances SET observed_state='stopped' WHERE organization_id=$1 AND user_id=$2", [f.context.organizationId, f.users[0]!.uuid])
    await f.budget.stopped(subject.target, subject.generation)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it('preserves another Runtime occupation when a higher generation of the same account stops', async () => {
    const f = await fixture(), original = f.subjects[0]!
    const target = await f.repository.resolveTarget(original.target)
    await pool.query(`UPDATE harness.instances SET generation=5,desired_state='running',observed_state='starting'
      WHERE runtime_id=$1`, [target.runtimeId])
    await f.repository.markReady(target, 5)
    const subject = { ...original, target, generation: 5 }
    await f.budget.register(subject)
    await f.grant(1)
    expect(await f.budget.request(subject, f.request(0, 1))).toEqual({ state: 'active' })
    const retired = randomUUID()
    await pool.query(`INSERT INTO harness.runtime_environments(id,organization_id,owner_kind,owner_id,node_id,retired_at)
      VALUES($1,$2,'user',$3,$4,clock_timestamp())`, [retired, f.context.organizationId, f.users[0]!.uuid, f.context.nodeId])
    await pool.query(`INSERT INTO harness.node_resource_runtimes
      (organization_id,node_id,runtime_kind,runtime_public_id,generation,last_sequence,runtime_id)
      VALUES($1,$2,'user',$3,2,1,$4)`, [f.context.organizationId, f.context.nodeId, target.id, retired])
    await pool.query(`INSERT INTO harness.node_resource_requests SELECT restored.* FROM harness.node_resource_requests request
      CROSS JOIN LATERAL jsonb_populate_record(NULL::harness.node_resource_requests,
        to_jsonb(request)||jsonb_build_object('generation',2,'operation_id',$2::text,'state','uncertain')) restored
      WHERE request.organization_id=$1 AND request.runtime_kind='user' AND request.runtime_public_id=$3 AND request.generation=5`,
    [f.context.organizationId, randomUUID(), target.id])
    await f.repository.markStopped(target, 5)
    await f.budget.stopped(target, 5)
    expect((await pool.query(`SELECT request.generation::integer,request.state,runtime.runtime_id
      FROM harness.node_resource_requests request JOIN harness.node_resource_runtimes runtime
      USING(organization_id,node_id,runtime_kind,runtime_public_id,generation)
      WHERE request.organization_id=$1`, [f.context.organizationId])).rows)
      .toEqual([{ generation: 2, state: 'uncertain', runtime_id: retired }])
  })

  it('cancels queued work after computer authority is lost while retaining active occupation for cleanup', async () => {
    const f = await fixture(), active = f.request(0, 1), queued = f.request(1, 1)
    await f.grant(1)
    expect(await f.budget.request(f.subjects[0]!, active)).toEqual({ state: 'active' })
    expect(await f.budget.request(f.subjects[1]!, queued)).toEqual({ state: 'queued' })
    await pool.query("UPDATE harness.compute_nodes SET status='offline' WHERE id=$1", [f.context.nodeId])
    await f.grant(10)
    await f.budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 8 })
    expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 1, queued: 0, uncertain: 0 })
    await expect(f.budget.request(f.subjects[1]!, f.request(1, 2))).rejects.toMatchObject({ reason: 'stale-generation' })
    await f.budget.finish(f.subjects[0]!, active, 'uncertain')
    expect((await f.budget.snapshot()).kinds.model.uncertain).toBe(1)
    await f.budget.finish(f.subjects[0]!, active, 'quiescent')
    expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 0, queued: 0, uncertain: 0 })
  })

  it.each(['registered', 'unregistered'] as const)('wakes other work while retaining a quiescent %s assignment through destructive work', async registration => {
    const f = await fixture(), stopped = f.subjects[0]!, next = f.subjects[1]!
    await f.grant(1)
    const active = f.request(0, 1), queued = f.request(1, 1)
    expect(await f.budget.request(stopped, active)).toEqual({ state: 'active' })
    expect(await f.budget.request(next, queued)).toEqual({ state: 'queued' })
    if (registration === 'unregistered') {
      await pool.query(`DELETE FROM harness.node_resource_requests WHERE organization_id=$1 AND runtime_kind='user' AND runtime_public_id=$2`,
        [f.context.organizationId, stopped.target.id])
      await pool.query(`DELETE FROM harness.node_resource_runtimes WHERE organization_id=$1 AND runtime_kind='user' AND runtime_public_id=$2`,
        [f.context.organizationId, stopped.target.id])
    }
    await f.repository.markStopping(stopped.target, stopped.generation)
    await f.grant(1)
    await f.budget.stopped(stopped.target, stopped.generation, 'retain')
    const state = await pool.query<{ state: string }>(`SELECT state FROM harness.node_resource_requests
      WHERE organization_id=$1 AND runtime_kind='user' AND runtime_public_id=$2`, [f.context.organizationId, next.target.id])
    expect(state.rows[0]?.state).toBe('active')
    expect((await f.budget.snapshot()).unregisteredRuntimes).toBe(0)
    await expect(f.budget.request(stopped, f.request(0, 2))).rejects.toMatchObject({ reason: 'stale-generation' })
    expect(await f.repository.stateOf(stopped.target)).toBe('stopping')
    await f.repository.markStopped(stopped.target, stopped.generation)
    await f.budget.stopped(stopped.target, stopped.generation)
    expect((await pool.query(`SELECT 1 FROM harness.node_resource_runtimes
      WHERE organization_id=$1 AND runtime_kind='user' AND runtime_public_id=$2`, [f.context.organizationId, stopped.target.id])).rowCount).toBe(0)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
  })

  it('bounds retained requests and consumes refused sequences without permitting a replay', async () => {
    const f = await fixture({ maxQueued: 1, maxQueuedPerUser: 1, maxQueuedPerProject: 1 })
    await f.grant(1)
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[0]!, f.request(0, 2))
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'refused', reason: 'queue-full' })
    await f.budget.finish(f.subjects[0]!, f.request(0, 1), 'quiescent')
    await f.grant(1)
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'closed' })
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 2))).toEqual({ state: 'queued' })
  })

  it('counts complete UTF-8 request metadata against the waiting byte limit', async () => {
    const f = await fixture({ maxQueuedBytes: 1 })
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    expect(await f.budget.request(f.subjects[1]!, { ...f.request(1, 1), sessionId: '多字节' })).toEqual({ state: 'refused', reason: 'queue-bytes' })
    expect((await f.budget.snapshot()).kinds.model.queuedBytes).toBe(0)
  })

  it('expires only waiting work, retaining an active reservation beyond its former deadline', async () => {
    const f = await fixture()
    await f.grant(1)
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[1]!, f.request(1, 1))
    await pool.query("UPDATE harness.node_resource_requests SET deadline='-infinity' WHERE organization_id=$1", [f.context.organizationId])
    expect(await f.budget.status(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'closed' })
    expect(await f.budget.status(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'active' })
    expect((await f.budget.snapshot()).outcomes.timed_out).toBe(1)
  })

  it('blocks new reservations while an existing Runtime has no accounting provider', async () => {
    const f = await fixture()
    await pool.query("DELETE FROM harness.node_resource_runtimes WHERE organization_id=$1 AND runtime_kind='user' AND runtime_public_id=$2", [f.context.organizationId, f.subjects[1]!.target.id])
    await f.grant(1)
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'queued' })
    expect((await f.budget.snapshot()).unregisteredRuntimes).toBe(1)
    await f.budget.register(f.subjects[1]!)
    expect(await f.budget.status(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'active' })
  })

  it('reclaims only a confirmed stopped generation and refuses stale late requests', async () => {
    const f = await fixture()
    await f.grant(1)
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[1]!, f.request(1, 1))
    await pool.query("UPDATE harness.instances SET observed_state='stopped' WHERE organization_id=$1 AND user_id=$2", [f.context.organizationId, f.users[0]!.uuid])
    await f.budget.stopped(f.subjects[0]!.target, 1)
    await f.grant(1)
    expect(await f.budget.status(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'active' })
    await expect(f.budget.request(f.subjects[0]!, f.request(0, 2))).rejects.toMatchObject({ status: 409 })
  })

  it.for(['failed-start', 'dead-ready'] as const)('wakes queued work when %s cleanup publishes the assignment stopped', async kind => {
    const f = await fixture(), target = f.subjects[0]!.target
    const cfg = loadConfig({ HGW_USERS_ROOT: join(f.root, 'users'), HGW_STATE_ROOT: join(f.root, 'state'),
      ...(kind === 'failed-start' ? { HGW_MODEL_GOVERNANCE_PACKAGE: join(f.root, 'absent-governance-package') } : {}) })
    const actor: UserRow = { id: target.id, username: 'alice', displayName: 'alice', role: 'user', status: 'active',
      homePath: f.root, mustChangePassword: false, autoReviewEligible: false }
    if (kind === 'failed-start') {
      await f.repository.markStopped(target, 1)
      await f.budget.stopped(target, 1)
    } else {
      // A stamp the fence accepts keeps this survivor on the dead-process cleanup path under test.
      await pool.query('UPDATE harness.instances SET launch_stamp=$1 WHERE organization_id=$2 AND user_id=$3',
        [mintedLaunchStamp(cfg), f.context.organizationId, f.users[0]!.uuid])
    }
    const queued = f.request(1, 1)
    expect(await f.budget.request(f.subjects[1]!, queued)).toEqual({ state: 'queued' })
    await f.grant(1)
    const granted = async () => (await pool.query<{ state: string }>(`SELECT state FROM harness.node_resource_requests
      WHERE organization_id=$1 AND node_id=$2 AND operation_id=$3`,
    [f.context.organizationId, f.context.nodeId, queued.requestId])).rows[0]?.state === 'active'
    let wokeBeforeNextStart = false
    if (kind === 'dead-ready') vi.spyOn(f.repository, 'beginStart').mockImplementationOnce(async () => {
      wokeBeforeNextStart = await granted()
      throw new Error('Next start intentionally refused after observing old cleanup')
    })
    const manager = new InstanceManager(f.repository, cfg, {
      instancesOutliveGateway: false,
      start: async () => { throw new Error('Cleanup fixture must not allocate a Runtime') },
      attach: () => ({ hasExited: () => true, isAlive: async () => false, terminate: async () => {} }),
    }, { principalPublicKey: '' }, f.budget)
    cleanups.push(() => manager.stopAll())
    await expect(manager.ensureRunning(actor, 'explicit')).rejects.toThrow(kind === 'failed-start' ? 'model-governance package is incomplete' : 'Next start intentionally refused')
    if (kind === 'dead-ready') expect(wokeBeforeNextStart).toBe(true)
    expect(await granted()).toBe(true)
    expect(await f.repository.stateOf(target)).toBe('stopped')
    expect((await f.budget.snapshot()).unregisteredRuntimes).toBe(0)
    expect((await pool.query(`SELECT 1 FROM harness.node_resource_runtimes WHERE organization_id=$1 AND node_id=$2
      AND runtime_kind='user' AND runtime_public_id=$3`, [f.context.organizationId, f.context.nodeId, target.id])).rowCount).toBe(0)
  })

  it('paces concurrent admissions through the shared credit ledger across Gateway coordinators', async () => {
    const f = await fixture({ maxQueuedPerUser: 2, maxQueuedPerProject: 2 })
    const other = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, f.config)
    await f.grant(2)
    const offered = await Promise.all(f.subjects.map((subject, index) => (index % 2 ? other : f.budget).request(subject, f.request(index, 1))))
    expect(offered.filter(item => item.state === 'active')).toHaveLength(2)
    expect(offered.filter(item => item.state === 'queued')).toHaveLength(2)
    expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 2, queued: 2 })
  })

  it('queues Gateway inference behind existing Runtime work and retains running callbacks during shutdown', async () => {
    const f = await fixture({ sampleMs: 10 })
    const directory = join(f.root, 'gateway-locks')
    const owner = await GatewayModelBudget.open(f.budget, directory)
    cleanups.push(() => owner.close())
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    let finish: () => void = () => {}
    const complete = new Promise<void>(resolve => { finish = resolve })
    let running: AbortSignal | undefined
    const result = owner.run({ actorId: f.users[1]!.id, projectId: f.projects[0]!.id, signal: new AbortController().signal }, async signal => {
      running = signal
      await complete
      return 'finished'
    })
    cleanups.push(async () => { finish(); await result.catch(() => undefined) })
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(2)
    await f.grant(1)
    expect(await f.budget.status(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'active' })
    expect(running).toBeUndefined()
    await f.budget.finish(f.subjects[0]!, f.request(0, 1), 'quiescent')
    await f.grant(1)
    await expect.poll(() => running !== undefined).toBe(true)
    const closing = owner.close()
    await expect.poll(() => running?.aborted).toBe(true)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    const other = await GatewayModelBudget.open(f.budget, directory)
    cleanups.push(() => other.close())
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    finish()
    expect(await result).toBe('finished')
    await closing
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it('cancels queued Gateway inference without dispatching and keeps subsequent serial registration usable', async () => {
    const f = await fixture({ sampleMs: 10 })
    const owner = await GatewayModelBudget.open(f.budget, join(f.root, 'locks'))
    cleanups.push(() => owner.close())
    const controller = new AbortController(), execute = vi.fn(async () => 'unexpected')
    const result = owner.run({ actorId: 0, projectId: f.projects[0]!.id, signal: controller.signal }, execute)
    const rejected = expect(result).rejects.toThrow()
    await expect.poll(async () => (await f.budget.snapshot()).kinds.model.queued).toBe(1)
    controller.abort()
    await rejected
    expect(execute).not.toHaveBeenCalled()
    expect((await f.budget.snapshot()).kinds.model.queued).toBe(0)
    await f.grant(1)
    expect(await owner.run({ actorId: 0, projectId: f.projects[0]!.id, signal: new AbortController().signal }, async () => 'next')).toBe('next')
  })

  it('does not recover an active Gateway owner through a replacement lock inode', async () => {
    const f = await fixture({ sampleMs: 10 }), directory = join(f.root, 'locks')
    const owner = await GatewayModelBudget.open(f.budget, directory)
    cleanups.push(() => owner.close())
    const name = (await readdir(directory))[0]!, path = join(directory, name), moved = path + '.moved'
    await rename(path, moved)
    await writeFile(path, '')
    try {
      const other = await GatewayModelBudget.open(f.budget, directory)
      cleanups.push(() => other.close())
      expect(await f.budget.gateways()).toHaveLength(2)
    } finally {
      await rm(path)
      await rename(moved, path)
    }
  })

  it('fences a committed registration whose acknowledgement was lost before allowing the next sequence', async () => {
    const f = await fixture({ sampleMs: 10 })
    const owner = await GatewayModelBudget.open(f.budget, join(f.root, 'locks'))
    cleanups.push(() => owner.close())
    const original = f.budget.request.bind(f.budget)
    vi.spyOn(f.budget, 'request').mockImplementationOnce(async (subject, request) => {
      await original(subject, request)
      throw new Error('lost registration acknowledgement')
    })
    const execute = vi.fn(async () => 'unused')
    await expect(owner.run({ actorId: 0, projectId: f.projects[0]!.id, signal: new AbortController().signal }, execute)).rejects.toThrow('lost registration')
    expect(execute).not.toHaveBeenCalled()
    expect((await f.budget.snapshot()).kinds.model.queued).toBe(0)
    await f.grant(1)
    expect(await owner.run({ actorId: 0, projectId: f.projects[0]!.id, signal: new AbortController().signal }, async () => 'next')).toBe('next')
  })

  it('retains failed completion accounting and retries it before closing its kernel owner', async () => {
    const f = await fixture({ sampleMs: 10 }), directory = join(f.root, 'locks')
    const owner = await GatewayModelBudget.open(f.budget, directory)
    cleanups.push(() => owner.close())
    await f.grant(1)
    vi.spyOn(f.budget, 'finish').mockRejectedValueOnce(new Error('completion acknowledgement unavailable'))
    await expect(owner.run({ actorId: 0, projectId: f.projects[0]!.id, signal: new AbortController().signal }, async () => 'complete'))
      .rejects.toThrow('completion acknowledgement unavailable')
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    const other = await GatewayModelBudget.open(f.budget, directory)
    cleanups.push(() => other.close())
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    await Promise.all([owner.close(), owner.close()])
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it('recovers a SIGKILLed Gateway only through its released kernel lock and replays interrupted usage once', async () => {
    const f = await fixture({ sampleMs: 10 }), directory = join(f.root, 'locks')
    let received = false, disconnected = false
    const upstream = createServer((req, res) => {
      req.resume()
      received = true
      res.writeHead(200, { 'content-type': 'application/json' }); res.flushHeaders()
      res.once('close', () => { disconnected = true })
    })
    await new Promise<void>(ready => upstream.listen(0, '127.0.0.1', ready))
    cleanups.push(async () => { upstream.closeAllConnections(); await new Promise<void>(ready => upstream.close(() => { ready() })) })
    const child = fork(resolve(import.meta.dirname, 'fixtures/gateway-model-owner.ts'), [], {
      execArgv: ['--import', 'tsx/esm'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: process.env.PATH, HGW_TEST_DATABASE_URL: databaseUrl,
        TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') },
    })
    let stderr = '', processFailure: Error | undefined
    const messages: string[] = []
    child.stderr!.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096) })
    child.on('error', error => { processFailure = error })
    child.on('message', value => {
      if (value !== null && typeof value === 'object' && 'kind' in value && typeof value.kind === 'string') messages.push(value.kind)
    })
    const closed = new Promise<void>(ready => child.once('close', () => { ready() }))
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed })
    const observed = (kind: string): boolean => {
      if (processFailure !== undefined) throw processFailure
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Model owner child exited: ${stderr}`)
      return messages.includes(kind)
    }
    await expect.poll(() => observed('listening'), { timeout: 10_000 }).toBe(true)
    child.send({ context: { ...f.context, pool: undefined }, config: f.config, directory,
      projectId: f.projects[0]!.id, internalProjectId: f.projects[0]!.uuid,
      url: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/chat/completions` })
    await expect.poll(() => observed('ready'), { timeout: 10_000 }).toBe(true)
    await f.grant(1)
    child.send({ kind: 'run' })
    await expect.poll(() => received, { timeout: 10_000 }).toBe(true)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    const other = await GatewayModelBudget.open(f.budget, directory)
    cleanups.push(() => other.close())
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    const governance = new PostgresModelGovernanceService(f.context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 35)))
    const usage = new PostgresProgressUsage(f.context, governance, 8)
    await usage.flush()
    expect((await governance.summary({ kind: 'project', id: f.projects[0]!.id })).calls).toBe(0)
    child.kill('SIGKILL'); await closed
    await expect.poll(() => disconnected).toBe(true)
    expect((await f.budget.snapshot()).kinds.model.active).toBe(1)
    const recovered = await GatewayModelBudget.open(f.budget, directory)
    cleanups.push(() => recovered.close())
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
    await usage.flush(); await usage.flush()
    expect(await governance.summary({ kind: 'project', id: f.projects[0]!.id })).toMatchObject({ calls: 1, missingUsageCalls: 1, totalTokens: 0 })
  })
})
