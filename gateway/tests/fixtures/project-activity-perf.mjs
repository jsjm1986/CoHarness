/** One fresh plain-Node sample of the first or subsequent real PostgreSQL activity page. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { performance } from 'node:perf_hooks'
import { createPostgresPool } from '../../lib/postgres/database.js'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) {
  throw new Error('Activity diagnostic child requires a disposable test database')
}
let raw = ''
for await (const chunk of process.stdin) raw += String(chunk)
const input = JSON.parse(raw)
const { PostgresCollaborationService } = await import(input.module)
const pool = createPostgresPool(databaseUrl, { max: 1 })
try {
  const service = new PostgresCollaborationService({ ...input.context, pool })
  const list = options => input.revision === 'current'
    ? service.listActivity(input.memberId, input.runtimeId, input.projectId, options)
    : service.listActivity(input.memberId, input.projectId, options)
  const first = await list({ limit: 50 })
  const options = { limit: 50, ...(input.page === 'next' ? { before: first.nextBefore } : {}) }
  if (input.page === 'next' && options.before === undefined) throw new Error('Activity fixture has no subsequent page')
  let retained
  const run = async () => {
    retained = await list(options)
    if (retained.items.length !== 50) throw new Error('Activity diagnostic did not read fifty rows')
  }
  for (let index = 0; index < 10; index++) await run()
  const samples = []
  for (let sample = 0; sample < 3; sample++) {
    const start = performance.now()
    for (let index = 0; index < 30; index++) await run()
    samples.push((performance.now() - start) / 30)
  }
  if (globalThis.gc === undefined) throw new Error('Activity diagnostic requires --expose-gc')
  globalThis.gc()
  process.stdout.write(JSON.stringify({ revision: input.revision, page: input.page,
    msPerCall: samples.toSorted((a, b) => a - b)[1], peakKiB: process.resourceUsage().maxRSS,
    steadyKiB: process.memoryUsage().rss / 1024, retainedRows: retained.items.length }) + '\n')
} finally { await pool.end() }
