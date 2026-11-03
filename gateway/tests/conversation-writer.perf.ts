/** Measure built attributed-message persistence while preserving current writer authorization. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { runPerformanceChild, writePerformanceReport } from './performance-report.ts'
import { testConfig } from './test-config.ts'

interface Sample {
  revision: 'before' | 'current'
  role: 'user' | 'admin'
  history: number
  msPerCall: number
  peakKiB: number
  steadyKiB: number
  batches: number[]
}

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('Writer diagnostic requires a disposable database')
const reference = process.env.HGW_WRITER_PERF_BASELINE_REF ?? 'HEAD'
const source = (await promisify(execFile)('git', ['show', `${reference}:gateway/src/postgres/conversation-repository.ts`])).stdout
if (!source.includes('FOR SHARE OF u,p')) throw new Error('Writer baseline must identify the combined authorization and row-lock query')
const baseline = fileURLToPath(new URL(`../lib/postgres/.writer-before-${randomUUID()}.js`, import.meta.url))
await writeFile(baseline, ts.transpileModule(source, { fileName: 'conversation-repository.mts', compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
} }).outputText, { flag: 'wx' })
const root = await mkdtemp(join(tmpdir(), 'hgw-writer-perf-')), pool = createPostgresPool(databaseUrl, { max: 1 })
let organizationId: string | undefined
let primaryFailure: { error: unknown } | undefined
try {
  await runMigrations(pool, fileURLToPath(new URL('../deploy/postgres/migrations/', import.meta.url)))
  const slug = `writer-perf-${randomUUID()}`
  organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Writer performance') RETURNING id", [slug])).rows[0]!.id
  await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'perf')", [organizationId])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'perf'), cfg = testConfig(root)
  const users = new PostgresUserService(context, cfg)
  const actors = [await users.create({ username: 'perf-member', password: 'synthetic-writer-password' }),
    await users.create({ username: 'perf-admin', password: 'synthetic-writer-password', role: 'admin' })]
  const project = await new PostgresProjectService(context, cfg).createManaged({ name: 'Writer performance', ownerUserId: actors[0]!.id })
  const projectId = (await pool.query<{ id: string }>('SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [organizationId, project.id])).rows[0]!.id
  const runtimeId = (await new PostgresInstanceRepository(context, cfg.instancePortBase).resolveTarget({ kind: 'project', id: project.id })).runtimeId!
  const samples: Sample[] = []
  for (const actor of actors) {
    const userId = (await pool.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, actor.id])).rows[0]!.id
    for (const history of [64, 4096]) for (let round = 0; round < 3; round++) {
      for (const revision of round % 2 === 0 ? ['before', 'current'] as const : ['current', 'before'] as const) {
        samples.push(await runPerformanceChild<Sample>(fileURLToPath(new URL('./fixtures/conversation-writer-perf.mjs', import.meta.url)), {
          revision, history, actor, userId, project, projectId, organizationId, runtimeId,
          module: pathToFileURL(revision === 'before' ? baseline : fileURLToPath(new URL('../lib/postgres/conversation-repository.js', import.meta.url))).href,
        }))
      }
    }
  }
  writePerformanceReport({ operation: 'one attributed member message durably committed', baselineSourceSha256: createHash('sha256').update(source).digest('hex'),
    node: process.version, platform: process.platform, architecture: process.arch, poolSize: 1, samples,
    scope: 'fresh plain-Node processes; synthetic 64/4096-event history; ten warmups; median of three twenty-append batches; pool/bootstrap/seeding excluded from time; process peak includes setup; one final result retained; no HTTP, model, database-server memory or concurrent writers; no timing budget',
  })
} catch (error) {
  primaryFailure = { error }
} finally {
  const failures: unknown[] = primaryFailure === undefined ? [] : [primaryFailure.error]
  const dispose = async (operation: () => Promise<unknown>): Promise<void> => {
    try { await operation() } catch (error) { failures.push(error) }
  }
  if (organizationId !== undefined) {
    for (const table of ['instances', 'projects', 'memberships', 'users', 'compute_nodes', 'outbox']) {
      await dispose(() => pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId]))
    }
    await dispose(() => pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId]))
  }
  await dispose(() => pool.end())
  await dispose(() => rm(baseline, { force: true }))
  await dispose(() => rm(root, { recursive: true, force: true }))
  if (failures.length > 0) throw new AggregateError(failures, 'Writer diagnostic or cleanup failed')
}
