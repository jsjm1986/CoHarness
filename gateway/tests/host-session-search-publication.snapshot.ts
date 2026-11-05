/** Replay a managed Host using the source launcher and disposable PostgreSQL. @module */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

it.skipIf(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL) === undefined)('publishes only current readable sessions from the managed Host', async () => {
  const result = await promisify(execFile)(process.execPath, [
    '--import', import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./fixtures/host-session-search-publication.mjs', import.meta.url)),
  ], { timeout: 45_000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024, env: { ...process.env,
    NODE_OPTIONS: undefined, NODE_PATH: undefined,
    TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../../tsconfig.base.json'),
  } })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/host-session-search-publication.jsonl'))
}, 50_000)
