/** A fresh plain-Node progress-page sample with one complete result retained through GC. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { performance } from 'node:perf_hooks'
import { createPostgresPool } from '../../lib/postgres/database.js'
import { PostgresCollaborationService } from '../../lib/postgres/collaboration-service.js'
const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('Progress diagnostic child requires a disposable database')
let raw = ''
for await (const chunk of process.stdin) raw += String(chunk)
const input = JSON.parse(raw), { PostgresProgressService } = await import(input.module)
const pool = createPostgresPool(databaseUrl, { max: 1 })
try {
  const context = { ...input.context, pool }, service = new PostgresProgressService(context, { collaboration: new PostgresCollaborationService(context) })
  let retained
  const run = async () => {
    retained = await service.progressForUser(input.projectId, input.memberId)
    if (retained.status.pending !== input.pending) throw new Error(`Progress fixture count differs: ${retained.status.pending} instead of ${input.pending}`)
  }
  for (let index = 0; index < 10; index++) await run()
  const samples = []
  for (let batch = 0; batch < 3; batch++) {
    const start = performance.now()
    for (let index = 0; index < 10; index++) await run()
    samples.push((performance.now() - start) / 10)
  }
  if (globalThis.gc === undefined) throw new Error('Progress diagnostic requires --expose-gc')
  globalThis.gc()
  process.stdout.write(JSON.stringify({ revision: input.revision, pending: input.pending, msPerCall: samples.toSorted((a, b) => a - b)[1],
    peakKiB: process.resourceUsage().maxRSS, steadyKiB: process.memoryUsage().rss / 1024, retainedPending: retained.status.pending }) + '\n')
} finally { await pool.end() }
