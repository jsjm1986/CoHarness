/** Node-owned project digest generation through real PostgreSQL, resource admission and model HTTP. @module */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('runs each project digest on its fixed computer with independent request and usage evidence', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const result = await promisify(execFile)(process.execPath, [
    ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./fixtures/progress-node-affinity.mjs', import.meta.url)),
  ], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: {
    ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
    TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../tsconfig.run.json') : undefined,
    DSH_PROGRESS_NODE_GATEWAY_ROOT: mode === 'src' ? undefined : process.env.DSH_GATEWAY_ARTIFACT_ROOT ?? resolve(import.meta.dirname, '../lib'),
  } })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/progress-node-affinity.jsonl'))
}, 130_000)
