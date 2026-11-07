/** Account fonts use authenticated storage across actual Gateway node contexts. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('persists account fonts across computer contexts and refuses a revoked account', async () => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
  const root = await mkdtemp(join(tmpdir(), 'account-font-replay-'))
  try {
    const result = await promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('./fixtures/account-fonts.mjs', import.meta.url)), mode,
      ...(mode === 'lib' && process.env.DSH_GATEWAY_ARTIFACT_ROOT !== undefined ? [process.env.DSH_GATEWAY_ARTIFACT_ROOT] : []),
    ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: {
      ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
      DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), TMPDIR: root,
      DSH_MANAGED_DATA_MANIFEST: undefined, TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../tsconfig.run.json'),
    } })
    await expect(result.stdout).toMatchFileSnapshot(resolve(import.meta.dirname, 'expected/projects/account-fonts.jsonl'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 70_000)
