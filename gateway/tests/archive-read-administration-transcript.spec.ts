/** Current administrator archive reads through actual Gateway HTTP and PostgreSQL. @module */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('refuses withdrawn archive reads before data access and after Runtime responses', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const result = await promisify(execFile)(process.execPath, [
    ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./fixtures/archive-read-administration.mjs', import.meta.url)), mode,
    process.env.DSH_GATEWAY_ARTIFACT_ROOT ?? '-',
  ], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: { ...process.env,
    NODE_OPTIONS: undefined, NODE_PATH: undefined,
    TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../tsconfig.run.json') : undefined,
  } })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/archive-read-administration.jsonl'))
}, 130_000)
