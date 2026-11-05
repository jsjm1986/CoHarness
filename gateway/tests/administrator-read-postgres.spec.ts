/** Admin JSON publication refuses eligibility withdrawn after data preparation. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('rechecks administrator qualification before prepared JSON reads and metadata headers are published', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-admin-read-replay-'))
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('./fixtures/administrator-read.mjs', import.meta.url)), 'src'], {
      cwd: root, timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 512 * 1024,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
        DSH_ADMIN_READ_SMOKE: undefined, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') },
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/administrator-read.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120000)
