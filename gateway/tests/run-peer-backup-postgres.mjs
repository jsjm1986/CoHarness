/** The restore guard DDL needs a private database, even when the caller supplies a shared test cluster. */
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const original = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
if (!original) throw new Error('HGW_TEST_DATABASE_URL must point to a disposable test database')
const root = resolve(import.meta.dirname, '..'),
  parent = new Pool({ connectionString: original, max: 1 })
const name = 'hgw_peer_' + randomUUID().replaceAll('-', '') + '_test'
const url = new URL(original)
url.pathname = '/' + name
let created = false
try {
  await parent.query('CREATE DATABASE "' + name + '"')
  created = true
  const child = spawn(
    process.execPath,
    [resolve(root, '../node_modules/vitest/vitest.mjs'), 'run', 'tests/peer-backup-postgres.spec.ts', '--maxWorkers=1'],
    {
      cwd: root,
      env: { ...process.env, HGW_TEST_DATABASE_URL: url.href },
      stdio: 'inherit',
    },
  )
  const code = await new Promise((ok, fail) => {
    child.once('error', fail)
    child.once('close', ok)
  })
  if (code !== 0) process.exitCode = 1
} finally {
  if (created) await parent.query('DROP DATABASE "' + name + '"')
  await parent.end()
}
