/** Recovered owner uncertainty reaches the actual administrative HTTP response. @module */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

it.skipIf(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL) === undefined)('reports unavailable restored ownership without an empty terminal inventory or released occupation', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const result = await promisify(execFile)(process.execPath, [
    ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
    fileURLToPath(new URL('./fixtures/recovered-owner-liveness.mjs', import.meta.url)), mode, process.env.DSH_GATEWAY_ARTIFACT_ROOT ?? '-',
  ], { timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: { ...process.env,
    NODE_OPTIONS: undefined, NODE_PATH: undefined,
    TSX_TSCONFIG_PATH: mode === 'src' ? resolve(import.meta.dirname, '../tsconfig.run.json') : undefined,
  } })
  await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/recovered-owner-liveness.jsonl'))
}, 130_000)
