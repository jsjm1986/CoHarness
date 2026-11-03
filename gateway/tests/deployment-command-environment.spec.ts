/** Actual maintenance children receive database credentials without Gateway or Runtime secrets. */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each(['configured', 'absent'] as const)('limits maintenance inheritance with %s PostgreSQL credentials', async (credentials) => {
  const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
  if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib.')
  const root = await mkdtemp(join(tmpdir(), 'hgw-maintenance-child-'))
  try {
    const result = await execute(process.execPath, [
      ...mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : [],
      fileURLToPath(new URL('./fixtures/deployment-command-environment.mjs', import.meta.url)), mode, root,
      process.env.HGW_TEST_GATEWAY_ARTIFACT ?? '', credentials,
    ], { timeout: 20_000, maxBuffer: 64 * 1024, env: {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      HGW_AUDIT_FIXTURE_SECRET: 'synthetic-gateway-secret', DSH_AUDIT_FIXTURE_SECRET: 'synthetic-runtime-secret',
      AUDIT_FIXTURE_API_KEY: 'synthetic-provider-key', PGDATABASE: 'fixture-db',
      ...credentials === 'configured' ? {
        PGPASSWORD: 'synthetic-database-password', PGPASSFILE: join(root, 'synthetic-pgpass'), PGSSLKEY: join(root, 'synthetic-pgsslkey'),
      } : {},
    } })
    expect(result.stdout).toBe(await readFile(new URL('./expected/deployment-command-environment.jsonl', import.meta.url), 'utf8'))
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)
