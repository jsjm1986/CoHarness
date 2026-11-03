/** Current node configuration retains administrator and leased-connection ownership. @module */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { nodeConfigurationAuthority } from '../src/postgres/node-configuration-authority.ts'
import { NodeConfigurationStore, readNodeConfiguration, type NodeConfigurationMutationAuthority } from '../src/node-config-store.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig, testEnvironment } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL node configuration administrator authority', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_NODE_CONFIGURATION_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), 'node-configuration-pg-'))
    let organizationId: PostgresRuntimeContext['organizationId'] | undefined, configurationPool: Pool | undefined
    const close = async (): Promise<void> => {
      const results = await Promise.allSettled([rm(dir, { recursive: true, force: true }), configurationPool?.end(),
        ...(organizationId === undefined ? [] : [removeFixtureOrganization(pool, organizationId)])])
      const errors: unknown[] = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
      if (errors.length > 0) throw new AggregateError(errors, 'Node configuration fixture cleanup failed')
    }
    try {
      const slug = `node-configuration-${randomUUID()}`
      organizationId = (await pool.query<{ id: PostgresRuntimeContext['organizationId'] }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Node configuration') RETURNING id", [slug])).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      await pool.query('INSERT INTO harness.cluster_control(organization_id) VALUES($1)', [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const actor = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'administrator','Administrator','/unused') RETURNING id,public_id`, [organizationId])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, actor.id])
      configurationPool = createPostgresPool(databaseUrl!, { max: 1, connectionTimeoutMillis: 1000 })
      const environment = testEnvironment(dir, { HGW_STATE_ROOT: dir, HGW_ORGANIZATION_SLUG: slug, HGW_COMPUTE_NODE_NAME: 'local' }), cfg = testConfig(dir, environment)
      const authority = nodeConfigurationAuthority({ ...context, pool: configurationPool }), actorId = Number(actor.public_id)
      const create = (owner: NodeConfigurationMutationAuthority) => new NodeConfigurationStore(context, cfg, environment, owner)
      const store = create(authority)
      await store.initialize()
      return { context, actor, actorId, configurationPool, cfg, environment, authority, create, store,
        async [Symbol.asyncDispose]() { await close() } }
    } catch (error) {
      try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Node configuration setup and cleanup failed') }
      throw error
    }
  }

  it('refuses foreign administrator identities through every configuration executor', async () => {
    await using f = await fixture(), other = await fixture()
    const before = await f.store.view(f.actorId)
    await expect(f.store.view(other.actorId)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.store.save(f.context, 0, { ...before.desired, HGW_PORT: '9301' }, other.actorId)).rejects.toMatchObject({ code: 'forbidden' })
    await f.store.save(f.context, 0, { ...before.desired, HGW_PORT: '9301' }, f.actorId)
    await expect(f.store.requestApply(f.context, 1, other.actorId)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await f.store.view(f.actorId)).operation).toBeNull()
  })

  it('captures the current write epoch with one available database connection', async () => {
    await using f = await fixture()
    const before = await f.store.view(f.actorId)
    await f.store.save(f.context, 0, { ...before.desired, HGW_PORT: '9301' }, f.actorId)
    await pool.query('UPDATE harness.cluster_control SET write_epoch=write_epoch+1 WHERE organization_id=$1', [f.context.organizationId])
    const epoch = (await pool.query<{ write_epoch: string }>('SELECT write_epoch::text FROM harness.cluster_control WHERE organization_id=$1', [f.context.organizationId])).rows[0]!.write_epoch
    expect((await f.store.requestApply(f.context, 1, f.actorId)).operation).toMatchObject({ actor: f.actorId, status: 'pending', writeEpoch: epoch })
  })

  it('retains initiating administrator eligibility until accepted publication commits', async () => {
    await using f = await fixture()
    const before = await f.store.view(f.actorId), pid = (await f.configurationPool.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid
    let entered!: () => void, release!: () => void, pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, settled = false
    const observed = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const controlled: NodeConfigurationMutationAuthority = { ...f.authority,
      run: (actor, operation) => f.authority.run(actor, async (...args) => { entered(); await gate; return operation(...args) }) }
    const store = f.create(controlled), name = `node-configuration-revoke-${randomUUID()}`
    const revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: name, lock_timeout: 15000 })
    try {
      pending = store.save(f.context, 0, { ...before.desired, HGW_PORT: '9301' }, f.actorId).catch((error: unknown) => error)
      await Promise.race([observed, pending.then(() => { throw new Error('Save bypassed the retained administrator observer') })])
      revoked = revoker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.id])
        .then(value => { settled = true; return value }, (error: unknown) => { settled = true; return error })
      await expect.poll(async () => settled || (await pool.query<{ blocked: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2::int=ANY(pg_blocking_pids(pid))) blocked', [name, pid])).rows[0]!.blocked).toBe(true)
      expect(settled).toBe(false)
      release(); expect(await pending).toMatchObject({ revision: 1 }); expect(await revoked).not.toBeInstanceOf(Error)
      await expect(f.store.view(f.actorId)).rejects.toMatchObject({ code: 'forbidden' })
    } finally { release(); await Promise.all([pending, revoked]); await revoker.end() }
  })

  it('does not publish a prepared file after its leased database backend is terminated', async () => {
    await using f = await fixture()
    const before = await f.store.view(f.actorId), pid = (await f.configurationPool.query<{ pid: number }>('SELECT pg_backend_pid() pid')).rows[0]!.pid
    let entered!: () => void, release!: () => void, pending: Promise<unknown> | undefined, signal: AbortSignal | undefined
    const observed = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const controlled: NodeConfigurationMutationAuthority = { ...f.authority,
      run: (actor, operation) => f.authority.run(actor, async (...args) => { signal = args[0]; entered(); await gate; return operation(...args) }) }
    try {
      pending = f.create(controlled).save(f.context, 0, { ...before.desired, HGW_PORT: '9301' }, f.actorId).catch((error: unknown) => error)
      await Promise.race([observed, pending.then(() => { throw new Error('Save bypassed the leased backend observer') })])
      expect((await pool.query<{ terminated: boolean }>('SELECT pg_terminate_backend($1,5000) terminated', [pid])).rows[0]!.terminated).toBe(true)
      await expect.poll(() => signal?.aborted).toBe(true)
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.id])
      release(); expect(await pending).toMatchObject({ status: 503, message: 'node-configuration-unavailable' })
      expect((await readNodeConfiguration(f.cfg.nodeConfigFile, f.environment))!.revision).toBe(0)
    } finally { release(); await pending }
  })
})
