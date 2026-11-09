/** Current administrator authority across actual backup commands and registry publication. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('retains administrator authority across backup creation verification and configuration preview', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hgw-backup-admin-replay-'))
  try {
    const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('./fixtures/administrator-backup-work.ts', import.meta.url))], {
      cwd: root, timeout: 90000, killSignal: 'SIGKILL', maxBuffer: 256 * 1024,
      env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json') },
    })
    await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/administrator-backup-work.jsonl', import.meta.url)))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 120000)
