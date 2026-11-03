/** Built progress-read diagnostic comparing exact consumption receipts with the unpatched timestamp watermark. */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
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
  pending: number
  msPerCall: number
  peakKiB: number
  steadyKiB: number
}
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('Progress diagnostic requires a disposable database')
const scale = process.env.HGW_PROGRESS_PERF_SCALE ?? 'large'
if (scale !== 'ordinary' && scale !== 'large') throw new Error('HGW_PROGRESS_PERF_SCALE must be ordinary or large')
const reference = process.env.HGW_PROGRESS_PERF_BASELINE_REF ?? 'HEAD'
const source = (await promisify(execFile)('git', ['show', `${reference}:gateway/src/postgres/progress-service.ts`])).stdout
if (!source.includes('const AFTER_WATERMARK') || source.includes('project_journal_materials')) throw new Error('Progress baseline must identify the unpatched timestamp implementation')
const baseline = fileURLToPath(new URL(`../lib/postgres/.progress-before-${randomUUID()}.js`, import.meta.url))
await writeFile(baseline, ts.transpileModule(source, { fileName: 'progress-service.mts', compilerOptions: {
  target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: true,
} }).outputText, { flag: 'wx' })
const root = await mkdtemp(join(tmpdir(), 'hgw-progress-perf-')), pool = createPostgresPool(databaseUrl, { max: 1 })
try {
  await runMigrations(pool, fileURLToPath(new URL('../deploy/postgres/migrations/', import.meta.url)))
  const slug = `progress-perf-${randomUUID()}`
  await pool.query(`WITH organization AS (INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Progress performance') RETURNING id)
    INSERT INTO harness.compute_nodes(organization_id,name) SELECT id,'perf-node' FROM organization`, [slug])
  const context = await resolvePostgresRuntimeContext(pool, slug, 'perf-node'), cfg = testConfig(root)
  const member = await new PostgresUserService(context, cfg).create({ username: 'perf-member', password: 'synthetic-perf-password' })
  const project = await new PostgresProjectService(context, cfg).createManaged({ name: 'Progress performance', ownerUserId: member.id })
  const ids = (await pool.query<{ user_id: string; project_id: string }>(`SELECT u.id user_id,p.id project_id FROM harness.users u
    JOIN harness.projects p ON p.organization_id=u.organization_id WHERE u.organization_id=$1 AND u.public_id=$2 AND p.public_id=$3`,
  [context.organizationId, member.id, project.id])).rows[0]!
  const runtimeId = (await new PostgresInstanceRepository(context, cfg.instancePortBase).resolveTarget({ kind: 'project', id: project.id })).runtimeId!
  const sessions = new ConversationRepository(pool, { organizationId: context.organizationId, runtimeId }), sessionIds: string[] = [], roots = scale === 'ordinary' ? 4 : 20, perRoot = scale === 'ordinary' ? 50 : 1000
  const time = 1000 * Math.floor((Date.now() - 24 * 60 * 60_000) / 1000)
  for (let index = 0; index < roots; index++) {
    const id = `progress-perf-${randomUUID()}`
    sessionIds.push(id)
    await sessions.create({ id, organizationId: context.organizationId, runtimeId, creatorUserId: ids.user_id,
      projectId: ids.project_id, visibility: 'project', sessionFormatVersion: 0, createdAt: time, cwd: project.path })
    for (let start = 0; start < perRoot; start += 100) await sessions.append(id, randomUUID(), Array.from({ length: Math.min(100, perRoot - start) }, (_, offset) => {
      const seq = start + offset
      return { type: 'user/message', seq, time: time + (index * perRoot + seq) * 1000, surfaceOp: 'append' as const,
        data: { role: 'user', content: [{ type: 'text', text: `Synthetic member update ${index * perRoot + seq}. ` + 'Project progress. '.repeat(6) }],
          source: { kind: 'user', participant: { userId: member.id, username: member.username, displayName: member.displayName,
            role: 'user', scope: { kind: 'project', projectId: project.id, projectName: project.name, mode: 'rw' } } } } }
    }))
  }
  await pool.query('ANALYZE harness.conversation_events'); await pool.query('ANALYZE harness.conversation_search')
  const { pool: _pool, ...identity } = context, samples: Sample[] = []
  for (const pending of [0, 20, roots * perRoot]) {
    const consumed = roots * perRoot - pending
    await pool.query('DELETE FROM harness.project_journal_materials WHERE project_id=$1', [ids.project_id])
    await pool.query(`INSERT INTO harness.project_journal_state(organization_id,project_id) VALUES($1,$2)
      ON CONFLICT(project_id) DO UPDATE SET watermark_ts=NULL,watermark_session=NULL,watermark_seq=NULL,watermark_runtime_namespace=NULL`, [context.organizationId, ids.project_id])
    if (consumed > 0) {
      const last = consumed - 1
      await pool.query(`UPDATE harness.project_journal_state SET watermark_ts=e.occurred_at,watermark_session=e.session_id,watermark_seq=e.seq,watermark_runtime_namespace=e.runtime_namespace
        FROM harness.conversation_events e WHERE project_id=$1 AND e.session_id=$2 AND e.seq=$3`,
      [ids.project_id, sessionIds[Math.floor(last / perRoot)], last % perRoot])
      await pool.query(`INSERT INTO harness.project_journal_materials(organization_id,project_id,runtime_id,session_id,entry_id,receipt)
        SELECT $1,$2,e.runtime_id,e.session_id,'message:'||e.seq::text,pg_catalog.sha256(pg_catalog.convert_to(e.session_id,'UTF8')||pg_catalog.decode('00','hex')||pg_catalog.convert_to('message:'||e.seq::text,'UTF8'))
        FROM harness.conversation_events e JOIN harness.conversation_sessions s ON s.organization_id=e.organization_id AND s.runtime_namespace=e.runtime_namespace AND s.id=e.session_id
        JOIN harness.project_journal_state state ON state.project_id=s.project_id
        WHERE s.project_id=$2 AND (e.occurred_at,e.session_id,e.seq)<=(state.watermark_ts,state.watermark_session,state.watermark_seq)`,
      [context.organizationId, ids.project_id])
    }
    await pool.query('ANALYZE harness.project_journal_materials')
    for (let round = 0; round < 3; round++) for (const revision of round % 2 === 0 ? ['before', 'current'] as const : ['current', 'before'] as const) {
      samples.push(await runPerformanceChild<Sample>(fileURLToPath(new URL('./fixtures/progress-material-perf.mjs', import.meta.url)), {
        context: identity, memberId: member.id, projectId: project.id, pending, revision,
        module: pathToFileURL(revision === 'before' ? baseline : fileURLToPath(new URL('../lib/postgres/progress-service.js', import.meta.url))).href,
      }))
    }
  }
  const median = (values: number[]) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)]!
  writePerformanceReport({ diagnostic: 'built-progress-material-receipts', baseline: { reference, sourceSha256: createHash('sha256').update(source).digest('hex') },
    environment: { node: process.version, platform: process.platform, arch: process.arch,
      postgres: (await pool.query<{ version: string }>("SELECT current_setting('server_version') version")).rows[0]!.version },
    workload: { scale, roots, messages: roots * perRoot, pending: [0, 20, roots * perRoot], poolSize: 1,
      freshProcessesPerVariant: 3, warmup: 10, batchesPerProcess: 3, callsPerBatch: 10, retained: 'One complete ProgressPage; no model route' },
    excludes: ['HTTP transport', 'model route lookup', 'database-server memory', 'concurrent load', 'model inference'], samples,
    medians: [0, 20, roots * perRoot].flatMap(pending => ['before', 'current'].map(revision => {
      const selected = samples.filter(sample => sample.pending === pending && sample.revision === revision)
      return { pending, revision, msPerCall: median(selected.map(sample => sample.msPerCall)), peakKiB: median(selected.map(sample => sample.peakKiB)),
        steadyKiB: median(selected.map(sample => sample.steadyKiB)) }
    })) })
} finally { await pool.end(); await rm(root, { recursive: true, force: true }); await rm(baseline, { force: true }) }
