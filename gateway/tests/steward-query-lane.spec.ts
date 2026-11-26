import { describe, expect, it, vi } from 'vitest'
import { StewardQueryService } from '../src/postgres/steward-query.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { fixtureQueryPool } from './postgres-query-fixture.ts'

describe('StewardQueryService lane screening (unit)', () => {
  const subject = {
    organizationId: 'org-1',
    projectInternalId: 'project-1',
    runtimeId: '00000000-0000-4000-8000-000000000001' as RuntimeId,
    generation: 1,
  }

  function service() {
    const context: PostgresRuntimeContext = {
      organizationId: 'org-1',
      organizationSlug: 'fixture',
      nodeId: 'node-1',
      nodeName: 'fixture',
      pool: fixtureQueryPool(() => []),
    }
    const statements = fixtureQueryPool(() => [])
    const connect = vi.spyOn(statements, 'connect').mockImplementation(async () => {
      throw new Error('statement pool must not be acquired for denied queries')
    })
    return { service: new StewardQueryService(context, true, statements), connect }
  }

  it.each([
    "SELECT '/* ', pg_sleep(1), ' */'",
    "SELECT '--' || chr(10), pg_read_file('/etc/passwd')",
    "SELECT '$$', pg_terminate_backend(1), '$$'",
    "SELECT E'\\'', pg_sleep(1), ''",
    'SELECT pg_catalog."pg_sleep"(1)',
    'SELECT U&"pg_\\0073leep"(1)',
  ])('refuses read-lane deny-list bypass %s before acquiring a statement connection', async (sql) => {
    const { service: queries, connect } = service()
    await expect(queries.query(subject, { sql, dryRun: false, rowLimit: 10 }))
      .rejects.toMatchObject({ status: 403, code: 'steward-statement-forbidden' })
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([
    'EXPLAIN ANALYZE UPDATE harness.projects SET name = name WHERE false',
    'EXPLAIN (ANALYZE) DELETE FROM harness.projects WHERE false',
    'WITH RECURSIVE t(n) AS (VALUES (1)) SEARCH DEPTH FIRST BY n SET ord, d AS (DELETE FROM harness.projects WHERE false RETURNING id) SELECT * FROM d',
    'WITH RECURSIVE t(n) AS (VALUES (1)) CYCLE n SET is_cycle USING path DELETE FROM harness.projects WHERE false',
  ])('requires write approval for %s before acquiring a statement connection', async (sql) => {
    const { service: queries, connect } = service()
    await expect(queries.query(subject, { sql, dryRun: false, rowLimit: 10 }))
      .rejects.toMatchObject({ status: 403, code: 'steward-approval-required' })
    expect(connect).not.toHaveBeenCalled()
  })
})
