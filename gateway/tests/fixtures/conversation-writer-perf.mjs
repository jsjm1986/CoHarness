/** One fresh plain-Node attributed append sample; its caller owns the private organization. */
import { postgresTestDatabaseUrl } from '../postgres-test-database.mjs'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { createPostgresPool } from '../../lib/postgres/database.js'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (databaseUrl === undefined) throw new Error('Writer child requires a disposable database')
let raw = ''
for await (const chunk of process.stdin) raw += String(chunk)
const input = JSON.parse(raw), { ConversationRepository } = await import(input.module)
const pool = createPostgresPool(databaseUrl, { max: 1 }), repository = new ConversationRepository(pool, { organizationId: input.organizationId, runtimeId: input.runtimeId }), sessionId = randomUUID()
let sequence = 0, retained
let primaryFailure
const message = () => ({ type: 'user/message', surfaceOp: 'append', seq: sequence++, time: 1_700_000_000_000 + sequence,
  data: { role: 'user', content: [{ type: 'text', text: 'Synthetic project collaboration update. '.repeat(6) }],
    source: { kind: 'user', participant: { userId: input.actor.id, username: input.actor.username, displayName: input.actor.displayName,
      role: input.actor.role, scope: { kind: 'project', projectId: input.project.id, projectName: input.project.name, mode: 'rw' } } } } })
try {
  await repository.create({ id: sessionId, organizationId: input.organizationId, runtimeId: input.runtimeId, creatorUserId: input.userId,
    projectId: input.projectId, visibility: 'project', sessionFormatVersion: 0, createdAt: 1_700_000_000_000 })
  for (let offset = 0; offset < input.history; offset += 64) {
    await repository.append(sessionId, randomUUID(), Array.from({ length: Math.min(64, input.history - offset) }, message))
  }
  const run = async () => {
    retained = await repository.append(sessionId, randomUUID(), [message()])
    if (retained !== 'inserted') throw new Error('Writer diagnostic did not commit a new batch')
  }
  for (let index = 0; index < 10; index++) await run()
  const batches = []
  for (let batch = 0; batch < 3; batch++) {
    const start = performance.now()
    for (let index = 0; index < 20; index++) await run()
    batches.push((performance.now() - start) / 20)
  }
  const row = (await pool.query('SELECT event_count::text,next_seq::text FROM harness.conversation_sessions WHERE id=$1', [sessionId])).rows[0]
  if (row?.event_count !== String(input.history + 70) || row.next_seq !== String(sequence)) throw new Error('Writer diagnostic lost an attributed event')
  if (globalThis.gc === undefined) throw new Error('Writer diagnostic requires --expose-gc')
  globalThis.gc()
  process.stdout.write(JSON.stringify({ revision: input.revision, role: input.actor.role, history: input.history,
    batches, msPerCall: batches.toSorted((a, b) => a - b)[1], peakKiB: process.resourceUsage().maxRSS,
    steadyKiB: process.memoryUsage().rss / 1024, retained }) + '\n')
} catch (error) {
  primaryFailure = { error }
} finally {
  const failures = primaryFailure === undefined ? [] : [primaryFailure.error]
  try { await repository.removeTree(input.organizationId, sessionId) } catch (error) { failures.push(error) }
  try { await pool.end() } catch (error) { failures.push(error) }
  // oxlint-disable-next-line no-unsafe-finally -- Combine the scenario failure with cleanup failures.
  if (failures.length > 0) throw new AggregateError(failures, 'Writer sample or cleanup failed')
}
