/** Account mutation authorization through real authenticated Gateway HTTP and both service providers. */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
for (const backend of ['sqlite', 'postgres'] as const) {
  it.skipIf(backend === 'postgres' && databaseUrl === undefined)(`retains current account administration authority with ${backend}`, async () => {
    const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
    if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
    const root = await mkdtemp(join(tmpdir(), 'account-authority-assembly-'))
    try {
      const result = await promisify(execFile)(process.execPath, [
        ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
        fileURLToPath(new URL('./fixtures/user-administration.mjs', import.meta.url)), mode, backend,
      ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: {
        ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined,
        DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_MANAGED_DATA_MANIFEST: undefined,
        TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../../tsconfig.json', import.meta.url)) : undefined,
      } })
      await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL(`./expected/projects/user-administration-${backend}.jsonl`, import.meta.url)))
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 70_000)
}
