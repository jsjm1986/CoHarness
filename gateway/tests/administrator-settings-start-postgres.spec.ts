/** Project-settings navigation through real browser authentication and native Runtime startup. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
// Linux account provisioning and native Windows supervision require separate acceptance.
it.skipIf(databaseUrl === undefined || process.platform !== 'darwin')('retains the initiating administrator and passive startup policy when opening project settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-settings-replay-'))
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('./fixtures/administrator-settings-start.ts', import.meta.url)), 'src'], {
      cwd: root, timeout: 60000, killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') },
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/administrator-settings-start.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 90000)
