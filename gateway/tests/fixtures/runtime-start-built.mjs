/** Plain Node acceptance for compiled Gateway admission and assignment initialization. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const artifact = pathToFileURL(resolve(process.argv[2] ?? fileURLToPath(new URL('../../lib/', import.meta.url))) + sep)
const [{ NodeResourceBudget }, { createPostgresPool, runMigrations }, { PostgresInstanceRepository }, { resolvePostgresRuntimeContext }] =
  await Promise.all(['node-resource-budget.js', 'postgres/database.js', 'postgres/instance-repository.js', 'postgres/runtime-context.js']
    .map(path => import(new URL(path, artifact))))

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) {
  throw new Error('HGW_TEST_DATABASE_URL must select a disposable test database')
}
const pool = createPostgresPool(databaseUrl, { max: 1 })
const cancellation = new AbortController()
const completions = []
let organizationId

try {
  await runMigrations(pool, fileURLToPath(new URL('../../deploy/postgres/migrations/', import.meta.url)))
  const slug = `built-start-${randomUUID()}`
  organizationId = (await pool.query("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Built admission') RETURNING id", [slug])).rows[0].id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
  const user = (await pool.query("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'alice','Alice',$2) RETURNING id,public_id", [organizationId, process.cwd()])).rows[0]
  await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, user.id])
  const other = (await pool.query("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'bob','Bob',$2) RETURNING id,public_id", [organizationId, process.cwd()])).rows[0]
  await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, other.id])
  for (const account of [user, other]) {
    await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
      [organizationId, context.nodeId, account.id])
  }
  const repository = new PostgresInstanceRepository(context, 48000)
  await repository.initialize()
  const target = await repository.resolveTarget({ kind: 'user', id: Number(user.public_id) })
  const budget = new NodeResourceBudget(pool, organizationId, context.nodeId, {
    sampleMs: 10, staleMs: 60_000, cpuTarget: 0.85, eventLoopTargetMs: 100,
    linuxMemoryReserveRatio: 0.1, maxQueued: 16, maxQueuedPerUser: 8,
    maxQueuedPerProject: 8, maxQueuedBytes: 65_536, maxWaitMs: 60_000,
  })
  await budget.configure()

  async function state(generation) {
    return (await pool.query('SELECT allocation_state FROM harness.instances WHERE organization_id=$1 AND user_id=$2 AND generation=$3',
      [organizationId, user.id, generation])).rows[0]?.allocation_state
  }

  async function waitForPressure(generation, observed) {
    const deadline = Date.now() + 30_000
    for (;;) {
      const current = await state(generation)
      if (current === 'waiting') return
      assert.notEqual(current, 'possible', 'allocation must wait for a fresh pressure credit')
      const result = await Promise.race([observed, delay(10).then(() => undefined)])
      if (result !== undefined) throw new Error('admission ended before the pressure wait', { cause: result.error })
      assert.ok(Date.now() < deadline, 'Runtime pressure wait did not become observable')
    }
  }

  function start(generation) {
    const observed = budget.admitRuntimeStart(target, generation, cancellation.signal).then(
      () => ({ admitted: true }), error => ({ admitted: false, error }),
    )
    completions.push(observed)
    return observed
  }

  const firstGeneration = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit')
  const otherTarget = await repository.resolveTarget({ kind: 'user', id: Number(other.public_id) })
  await pool.query("UPDATE harness.node_resource_state SET credits=1,valid_until='infinity' WHERE organization_id=$1 AND node_id=$2",
    [organizationId, context.nodeId])
  for (const runtimeId of [otherTarget.runtimeId, randomUUID()]) {
    await assert.rejects(budget.admitRuntimeStart({ ...target, runtimeId }, firstGeneration, cancellation.signal),
      error => error.reason === 'stale-generation')
    assert.equal(await state(firstGeneration), 'not-started')
    assert.equal((await budget.snapshot()).outcomes.runtime_starts_admitted, 0)
  }
  await pool.query('UPDATE harness.node_resource_state SET credits=0,valid_until=NULL WHERE organization_id=$1 AND node_id=$2',
    [organizationId, context.nodeId])
  const first = start(firstGeneration)
  await waitForPressure(firstGeneration, first)
  await budget.observe({ capturedAt: performance.now(), cpu: 0, memory: 'normal', eventLoopMs: 0, parallelism: 1 })
  assert.deepEqual(await first, { admitted: true })
  assert.equal(await state(firstGeneration), 'possible')
  await repository.markReady(target, firstGeneration)
  await new PostgresInstanceRepository(context, 48000).initialize()
  assert.equal(await repository.stateOf(target), 'ready')
  assert.equal(await repository.generationOf(target), firstGeneration)
  await repository.markStopped(target, firstGeneration)

  const secondGeneration = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 2), 'explicit')
  const second = start(secondGeneration)
  await waitForPressure(secondGeneration, second)
  cancellation.abort()
  const cancelled = await second
  assert.equal(cancelled.admitted, false)
  assert.equal(cancelled.error.reason, 'cancelled')
  assert.equal(await state(secondGeneration), 'waiting')
  assert.equal((await budget.snapshot()).outcomes.runtime_starts_admitted, 1)
  const result = { freshPressureRequired: true, sharedCreditSpent: true, cancellationBeforeAllocation: true,
    activeAssignmentPreserved: true, explicitRuntimeIdentityRequired: true }
  assert.deepEqual(result, JSON.parse(await readFile(new URL('../expected/runtime-start-built.json', import.meta.url), 'utf8')))
  console.log(JSON.stringify(result))
} finally {
  cancellation.abort()
  await Promise.allSettled(completions)
  try {
    if (organizationId !== undefined) {
      for (const table of ['node_resource_requests', 'node_resource_runtimes', 'node_resource_state', 'instances', 'memberships', 'users', 'outbox', 'compute_nodes']) {
        await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
      }
      await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
    }
  } finally { await pool.end() }
}
