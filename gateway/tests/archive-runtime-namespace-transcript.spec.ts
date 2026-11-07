/** Independent archive identities through authenticated Gateway HTTP and PostgreSQL. @module */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('isolates equal Host Session IDs across computers and Runtime namespaces', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const result = await promisify(execFile)(process.execPath, [
    ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./fixtures/archive-runtime-namespace.mjs', import.meta.url)), mode,
    process.env.DSH_GATEWAY_ARTIFACT_ROOT ?? '-',
  ], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: { ...process.env,
    NODE_OPTIONS: undefined, NODE_PATH: undefined,
    TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../tsconfig.run.json') : undefined,
  } })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/archive-runtime-namespace.jsonl'))
}, 130_000)
