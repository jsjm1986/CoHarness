/** Built first/next activity-page diagnostic against an explicitly identified unpatched Git source. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { ConversationRepository } from '../src/postgres/conversation-repository.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { runPerformanceChild, writePerformanceReport } from './performance-report.ts'
import { testConfig } from './test-config.ts'

interface Sample {
  revision: 'before' | 'current'
  page: 'first' | 'next'
  msPerCall: number
  peakKiB: number
  steadyKiB: number
}
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) {
  throw new Error('Activity diagnostic requires a disposable test database')
}
const reference = process.env.HGW_ACTIVITY_PERF_BASELINE_REF ?? 'HEAD'
const source = (await promisify(execFile)('git', ['show', `${reference}:gateway/src/postgres/collaboration-service.ts`])).stdout
if (!source.includes('ORDER BY f.ts DESC,f.session_id,f.seq DESC LIMIT $7') || source.includes('cursor_ts')) {
  throw new Error('HGW_ACTIVITY_PERF_BASELINE_REF must identify the unpatched activity implementation')
}
const baseline = fileURLToPath(new URL(`../lib/postgres/.activity-before-${randomUUID()}.js`, import.meta.url))
const compiled = ts.transpileModule(source, { fileName: 'collaboration-service.mts', compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
} }).outputText
await writeFile(baseline, compiled, { flag: 'wx' })
const root = await mkdtemp(join(tmpdir(), 'hgw-activity-perf-'))
const pool = createPostgresPool(databaseUrl, { max: 1 })
try {
  await runMigrations(pool, fileURLToPath(new URL('../deploy/postgres/migrations/', import.meta.url)))
  const slug = `activity-perf-${randomUUID()}`
  await pool.query(`WITH organization AS (
    INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Activity performance') RETURNING id
  ) INSERT INTO harness.compute_nodes(organization_id,name) SELECT id,'perf-node' FROM organization`, [slug])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'perf-node')
  const cfg = testConfig(root)
  const member = await new PostgresUserService(context, cfg).create({ username: 'perf-member', password: 'coharness-perf-password' })
  const project = await new PostgresProjectService(context, cfg).createManaged({ name: 'Activity performance', ownerUserId: member.id })
  const ids = (await pool.query<{ user_id: string; project_id: string }>(`SELECT u.id user_id,p.id project_id
    FROM harness.users u JOIN harness.projects p ON p.organization_id=u.organization_id
    WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`, [context.organizationId, member.id, project.id])).rows[0]!
  const runtimeId = (await new PostgresInstanceRepository(context, cfg.instancePortBase).resolveTarget({ kind: 'project', id: project.id })).runtimeId!
  const sessions = new ConversationRepository(pool, { organizationId: context.organizationId, runtimeId }), collaboration = new PostgresCollaborationService(context)
  const time = Date.parse('2026-10-20T00:00:00Z'), sessionIds: string[] = []
  for (let index = 0; index < 4; index++) {
    const sessionId = `activity-perf-${randomUUID()}`
    sessionIds.push(sessionId)
    await sessions.create({ id: sessionId, organizationId: context.organizationId, runtimeId, creatorUserId: ids.user_id,
      projectId: ids.project_id, visibility: 'project', sessionFormatVersion: 0, createdAt: time, cwd: project.path })
    await sessions.append(sessionId, randomUUID(), Array.from({ length: 25 }, (_, seq) => ({
      type: 'user/message', seq, time: time + (index * 25 + seq) * 2, surfaceOp: 'append',
      data: { role: 'user', content: [{ type: 'text', text: `Member update ${index * 25 + seq}: ` + 'Shared project progress. '.repeat(12) }],
        source: { kind: 'user', participant: { userId: member.id, username: member.username, displayName: member.displayName,
          role: 'user', scope: { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' } } } },
    })))
  }
  for (let index = 0; index < 100; index++) {
    const claim = `activity-perf-${randomUUID()}`
    await collaboration.claimInteraction(member.id, runtimeId, sessionIds[index % 4]!, 'question', claim, { answers: [{ selected: [`Choice ${index}`] }] })
    await pool.query(`UPDATE harness.conversation_interaction_responses
      SET responded_at=to_timestamp($3/1000.0) WHERE organization_id=$1 AND interaction_id=$2`,
    [context.organizationId, claim, time + index * 2 + 1])
  }
  const { pool: _pool, ...identity } = context
  const samples: Sample[] = []
  for (const page of ['first', 'next'] as const) for (let round = 0; round < 3; round++) {
    const order = round % 2 === 0 ? ['before', 'current'] as const : ['current', 'before'] as const
    for (const revision of order) samples.push(await runPerformanceChild<Sample>(
      fileURLToPath(new URL('./fixtures/project-activity-perf.mjs', import.meta.url)), {
        context: identity, memberId: member.id, projectId: project.id, runtimeId, page, revision,
        module: pathToFileURL(revision === 'before' ? baseline
          : fileURLToPath(new URL('../lib/postgres/collaboration-service.js', import.meta.url))).href,
      }))
  }
  const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
  writePerformanceReport({ diagnostic: 'built-project-activity', execution: 'Plain Node child, emitted production methods',
    baseline: { reference, sourceSha256: createHash('sha256').update(source).digest('hex') },
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      postgres: (await pool.query<{ version: string }>("SELECT current_setting('server_version') version")).rows[0]!.version },
    workload: { roots: 4, messages: 100, answers: 100, messageTextRepeats: 12, pageRows: 50, poolSize: 1,
      freshProcessesPerVariant: 3, warmup: 10, batchesPerProcess: 3, callsPerBatch: 30 },
    excludes: ['HTTP transport', 'database-server memory', 'concurrent load', 'remote services'], samples,
    medians: ['first', 'next'].flatMap(page => ['before', 'current'].map(revision => {
      const selected = samples.filter(sample => sample.page === page && sample.revision === revision)
      return { page, revision, msPerCall: median(selected.map(sample => sample.msPerCall)),
        peakKiB: median(selected.map(sample => sample.peakKiB)), steadyKiB: median(selected.map(sample => sample.steadyKiB)) }
    })) })
} finally { await pool.end(); await rm(root, { recursive: true, force: true }); await rm(baseline, { force: true }) }
