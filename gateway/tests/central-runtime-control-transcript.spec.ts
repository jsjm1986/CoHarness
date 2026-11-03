/** Reserved Runtime process control through authenticated Gateway HTTP and PostgreSQL. @module */
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

it.skipIf(postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL) === undefined)(
  'controls the reserved Runtime without granting destructive data access', async () => {
    const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
    if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
    const root = await mkdtemp(join(tmpdir(), 'central-runtime-transcript-'))
    try {
      const result = await promisify(execFile)(process.execPath, [
        ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []),
        fileURLToPath(new URL('./fixtures/central-runtime-control.mjs', import.meta.url)), mode,
        ...(mode === 'lib' && process.env.DSH_GATEWAY_ARTIFACT_ROOT !== undefined ? [process.env.DSH_GATEWAY_ARTIFACT_ROOT] : []),
      ], { cwd: root, timeout: 60_000, killSignal: 'SIGKILL', env: {
        ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined, NODE_DISABLE_COMPILE_CACHE: '1',
        DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'), DSH_MANAGED_DATA_MANIFEST: undefined,
        TSX_TSCONFIG_PATH: mode === 'src' ? fileURLToPath(new URL('../tsconfig.run.json', import.meta.url)) : undefined,
      } })
      await expect(result.stdout).toMatchFileSnapshot(fileURLToPath(new URL('./expected/projects/central-runtime-control-postgres.jsonl', import.meta.url)))
    } finally { await rm(root, { recursive: true, force: true }) }
  }, 70_000,
)
