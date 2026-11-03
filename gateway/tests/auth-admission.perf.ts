/** Built authentication diagnostic over a disposable PostgreSQL database; excluded from CI benchmarks. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GatewayConfig } from '../src/config.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { runPerformanceChild, writePerformanceReport } from './performance-report.ts'
import { testConfig } from './test-config.ts'

type Revision = 'before' | 'current'
type Operation = 'login' | 'validate'
interface Input {
  context: Omit<PostgresRuntimeContext, 'pool'>
  config: GatewayConfig
  token: string
}
interface Sample {
  revision: Revision
  operation: Operation
  msPerCall: number
  peakKiB: number
  steadyKiB: number
}
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) {
  throw new Error('Authentication diagnostic requires a disposable test database')
}
const median = (values: number[]) => values.toSorted((left, right) => left - right)[Math.floor(values.length / 2)]!

async function child(input: Input, revision: Revision, operation: Operation): Promise<Sample> {
  return runPerformanceChild<Sample>(fileURLToPath(new URL('./fixtures/auth-admission-perf.mjs', import.meta.url)),
    { ...input, revision, operation })
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'hgw-auth-perf-'))
  const pool = createPostgresPool(databaseUrl!, { max: 1 })
  try {
    await runMigrations(pool, fileURLToPath(new URL('../deploy/postgres/migrations/', import.meta.url)))
    const slug = `auth-perf-${randomUUID()}`
    await pool.query(`WITH organization AS (
      INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Auth performance') RETURNING id
    ) INSERT INTO harness.compute_nodes(organization_id,name) SELECT id,'perf-node' FROM organization`, [slug])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'perf-node')
    const config = testConfig(root)
    await new PostgresUserService(context, config).create({ username: 'perf-member', password: 'coharness-perf-password' })
    const { PostgresAuthService } = await import('../src/postgres/auth-service.ts')
    const signedIn = await new PostgresAuthService(context, config).login('perf-member', 'coharness-perf-password', '127.0.0.1', 'diagnostic')
    if (typeof signedIn === 'string') throw new Error('Authentication diagnostic setup failed')
    const { pool: _pool, ...identity } = context
    const input = { context: identity, config, token: signedIn.token }
    const samples: Sample[] = []
    for (const operation of ['validate', 'login'] as const) {
      for (let round = 0; round < 3; round++) {
        const revisions: Revision[] = round % 2 === 0 ? ['before', 'current'] : ['current', 'before']
        for (const revision of revisions) samples.push(await child(input, revision, operation))
      }
    }
    writePerformanceReport({ diagnostic: 'built-auth-admission', execution: 'Emitted production methods under plain Node; source launcher only prepares the fixture and report', environment: {
      node: process.version, platform: process.platform, arch: process.arch,
      postgres: (await pool.query<{ version: string }>("SELECT current_setting('server_version') version")).rows[0]!.version,
    }, workload: { freshProcessesPerVariant: 3, batchesPerProcess: 3, warmup: 10, cookieCallsPerBatch: 200, loginCallsPerBatch: 20,
      databasePoolSize: 1, transport: 'loopback TCP', identity: 'one active organization and member' },
    baseline: 'Same emitted production module with only organization checks and database canonicalization removed; no runtime measurement hooks',
    excludes: ['HTTP transport', 'database-server memory', 'concurrent load', 'remote services'], samples,
    medians: ['validate', 'login'].flatMap(operation => ['before', 'current'].map(revision => {
      const selected = samples.filter(sample => sample.operation === operation && sample.revision === revision)
      return { operation, revision, msPerCall: median(selected.map(sample => sample.msPerCall)),
        peakKiB: median(selected.map(sample => sample.peakKiB)), steadyKiB: median(selected.map(sample => sample.steadyKiB)) }
    })) })
  } finally { await pool.end(); await rm(root, { recursive: true, force: true }) }
}

await main()
