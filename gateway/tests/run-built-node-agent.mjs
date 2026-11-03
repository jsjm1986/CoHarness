/** Plain-Node node-agent verification against the real authenticated Gateway and PostgreSQL fixture. */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

if (postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL) === undefined) throw new Error('HGW_TEST_DATABASE_URL must select a disposable test database')
await access(new URL('../lib/node-agent-main.js', import.meta.url))
const require = createRequire(import.meta.url)
const vitest = resolvePath(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const child = spawn(process.execPath, [vitest, 'run', 'tests/node-access-postgres.spec.ts', '-t', 'runs independent outbound node processes|recovers an interrupted'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: 'inherit', env: { ...process.env, HGW_TEST_NODE_AGENT_BUILT: '1' },
})
const result = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => { resolve({ code, signal }) })
})
if (result.signal !== null) throw new Error('Built node-agent test process ended by signal')
process.exitCode = result.code ?? 1
