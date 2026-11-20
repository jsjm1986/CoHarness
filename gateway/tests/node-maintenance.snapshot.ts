/** Keyless transcript assembled from the real Gateway, PostgreSQL authority and HTTP clients. */
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { nodeMaintenanceTranscript } from './node-maintenance-fixture.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const url = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(url === undefined)('keeps managed node maintenance control available while refusing business execution', async () => {
  const pool = createPostgresPool(url!, { max: 6 })
  try {
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    const transcript = await nodeMaintenanceTranscript(pool)
    const expected = fileURLToPath(new URL('./snapshots/node-maintenance/flow.expected.md', import.meta.url))
    if (process.env.DSH_SNAPSHOT === 'refresh') { await mkdir(dirname(expected), { recursive: true }); await writeFile(expected, transcript) }
    expect(transcript).toBe(await readFile(expected, 'utf8'))
  } finally { await pool.end() }
})
