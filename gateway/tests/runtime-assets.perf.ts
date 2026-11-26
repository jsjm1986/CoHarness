/** Local built-Gateway resource diagnostic; controlled Runtime bytes exclude model and browser rendering. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { runPerformanceChild, writePerformanceReport } from './performance-report.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

interface Sample {
  variant: 'ordinary' | 'resource'
  scope: 'personal' | 'project'
  headersMs: number[]
  completeMs: number[]
  settledMs: number[]
  sqlStatements: number
  activityChanged: boolean
  peakKiB: number
  steadyKiB: number
}
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('Runtime resource diagnostic requires a disposable database')
const root = await mkdtemp(join(tmpdir(), 'hgw-resource-perf-'))
const pool = createPostgresPool(databaseUrl, { max: 2 })
let organizationId: string | undefined
try {
  await runMigrations(pool, fileURLToPath(new URL('../deploy/postgres/migrations', import.meta.url)))
  const slug = `resource-perf-${randomUUID()}`
  organizationId = (await pool.query<{ id: string }>(
    "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Resource diagnostic') RETURNING id", [slug],
  )).rows[0]!.id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'diagnostic')", [organizationId])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'diagnostic')
  const cfg = testConfig(root, { HGW_ORGANIZATION_SLUG: slug })
  cfg.dshRepoRoot = root
  const users = new PostgresUserService(context, cfg)
  const user = await users.create({ username: 'fixture', password: 'fixture-password' })
  await users.changeOwnPassword(user.id, 'fixture-password')
  const projects = new PostgresProjectService(context, cfg)
  const project = await projects.createManaged({ name: 'Resource diagnostic', ownerUserId: user.id })
  const catalog = new PostgresRuntimeCatalog(context, cfg.runtimeCatalog)
  const personal = await catalog.resolveForOwner(user, { kind: 'personal', id: user.id })
  const shared = await catalog.resolveForOwner(user, { kind: 'project', id: project.id })
  const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
  const resources = new NodeResourceBudget(pool, organizationId, context.nodeId, cfg.resourceBudget)
  for (const [kind, id, runtimeId] of [['user', user.id, personal.id], ['project', project.id, shared.id]] as const) {
    const target = { kind, id, runtimeId }
    const generation = await repository.beginStart(target, Date.now(), createHash('sha256').update(randomUUID()).digest(), 'explicit', undefined, true, 'diagnostic')
    await repository.markReady(target, generation)
    await resources.register({ organizationId, target, generation })
  }
  const signedIn = await new PostgresAuthService(context, cfg).login(user.username, 'fixture-password', '127.0.0.1', 'resource diagnostic')
  if (typeof signedIn === 'string') throw new Error('Resource diagnostic login failed')
  const { pool: _pool, ...identity } = context
  const samples: Sample[] = []
  for (const scope of ['personal', 'project'] as const) for (let round = 0; round < 3; round++) {
    const order = round % 2 === 0 ? ['ordinary', 'resource'] as const : ['resource', 'ordinary'] as const
    for (const variant of order) samples.push(await runPerformanceChild<Sample>(
      fileURLToPath(new URL('./fixtures/runtime-assets-perf.mjs', import.meta.url)), {
        context: identity, cfg, token: signedIn.token, user, scope, variant,
        target: scope === 'personal' ? { kind: 'user', id: user.id, runtimeId: personal.id }
          : { kind: 'project', id: project.id, runtimeId: shared.id },
      }))
  }
  const percentile = (values: number[], fraction: number): number => values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!
  writePerformanceReport({ diagnostic: 'built-runtime-resource-http',
    environment: { node: process.version, platform: process.platform, architecture: process.arch,
      postgres: (await pool.query<{ version: string }>("SELECT current_setting('server_version') version")).rows[0]!.version },
    workload: { bytes: 262144, warmup: 10, timedRequestsPerProcess: 50, countedRequestsPerProcess: 50, processesPerVariantAndScope: 3,
      transport: 'loopback HTTP and local PostgreSQL; no injected delay', maxDatabaseConnections: 4 },
    baseline: 'Same built Gateway without RuntimeAssets installed; ordinary proxy, activity admission and response cleanup stay intact.',
    endpoint: 'Headers and complete verified bytes; settled adds owned proxy/reference cleanup. Peak includes setup; steady RSS follows GC with Gateway and fixed response retained.',
    excludes: ['real supervisor IPC (controlled live process handle)', 'browser rendering', 'model inference', 'WAN RTT', 'database-server memory', 'concurrent load'],
    samples,
    summaries: ['personal', 'project'].flatMap(scope => ['ordinary', 'resource'].map(variant => {
      const selected = samples.filter(sample => sample.scope === scope && sample.variant === variant)
      return { scope, variant, completeMedianMs: percentile(selected.flatMap(sample => sample.completeMs), 0.5),
        completeP95Ms: percentile(selected.flatMap(sample => sample.completeMs), 0.95),
        settledP95Ms: percentile(selected.flatMap(sample => sample.settledMs), 0.95),
        sqlStatements: selected.map(sample => sample.sqlStatements),
        peakKiB: percentile(selected.map(sample => sample.peakKiB), 0.5), steadyKiB: percentile(selected.map(sample => sample.steadyKiB), 0.5) }
    })) })
} finally {
  try { if (organizationId !== undefined) await removeFixtureOrganization(pool, organizationId) }
  finally { await pool.end(); await rm(root, { recursive: true, force: true }) }
}
