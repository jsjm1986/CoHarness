/** Account usage publication through a real Gateway and PostgreSQL-backed runtime directory. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const database = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(database === undefined)('withholds revoked usage and preserves selected personal or project billing ownership', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'account-usage-replay-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
      fileURLToPath(new URL('./fixtures/account-usage-read.mjs', import.meta.url)), mode,
      ...(mode === 'lib' && process.env.DSH_GATEWAY_ARTIFACT_ROOT !== undefined ? [process.env.DSH_GATEWAY_ARTIFACT_ROOT] : []),
    ], { cwd: root, timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024, env: {
      ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, DEEPSEEK_API_KEY: undefined, OPENAI_API_KEY: undefined,
      DSH_USAGE_READ_FIXTURE_ROOT: root,
      TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)) : undefined,
    } })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/projects/account-usage-read.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 110000)
