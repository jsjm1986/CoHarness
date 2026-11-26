/** Release admission keeps accepted work alive through real HTTP and local supervision. @module */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

it.skipIf(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL) === undefined)('retains accepted process work and reports the pending upgrade through Admin HTTP', async () => {
  const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
    fileURLToPath(new URL('./fixtures/runtime-upgrade-continuity.mjs', import.meta.url)), 'src'], {
    timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
    env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') },
  })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/runtime-upgrade-continuity.jsonl'))
}, 150_000)
