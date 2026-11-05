/** The runnable Gateway transcript checks fan-out revocation and ordinary member copies. */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)

it.skipIf(databaseUrl === undefined)('retains current administrator authority through browser fan-out requests', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  const result = await promisify(execFile)(process.execPath, [
    ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
    fileURLToPath(new URL('./fixtures/browser-document-fanout.mjs', import.meta.url)), mode,
    process.env.HGW_TEST_GATEWAY_ARTIFACT ?? '',
  ], { env: { ...process.env, TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)) },
    timeout: 90000, maxBuffer: 128 * 1024 })
  expect(result.stdout).toBe(await readFile(new URL('./expected/browser-document-fanout.jsonl', import.meta.url), 'utf8'))
}, 100000)
