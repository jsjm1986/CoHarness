/** The shipped preflight exercises the actual restricted login, not a superuser stand-in. */
import { execFile } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
it.skipIf(databaseUrl === undefined)('checks restricted name privacy without granting authority or retaining transaction settings', async () => {
  const suffix = randomUUID().replaceAll('-', '')
  const database = `hgw_name_privacy_${suffix}_test`, role = `hgw_name_privacy_${suffix}`
  const admin = createPostgresPool(databaseUrl!, { max: 1 })
  const root = await mkdtemp(join(tmpdir(), 'hgw-name-privacy-'))
  let databaseCreated = false, roleCreated = false
  let owner: ReturnType<typeof createPostgresPool> | undefined
  let restricted: ReturnType<typeof createPostgresPool> | undefined
  try {
    await admin.query(`CREATE DATABASE "${database}"`); databaseCreated = true
    const ownerUrl = new URL(databaseUrl!); ownerUrl.pathname = '/' + database
    owner = createPostgresPool(ownerUrl.href, { max: 1 })
    await runMigrations(owner, fileURLToPath(new URL('../deploy/postgres/migrations', import.meta.url)))
    const password = randomBytes(24).toString('hex')
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}'`); roleCreated = true
    await owner.query(`GRANT USAGE ON SCHEMA harness TO "${role}"`)
    await admin.query(`ALTER ROLE "${role}" IN DATABASE "${database}" SET log_parameter_max_length=-1`)
    await admin.query(`ALTER ROLE "${role}" IN DATABASE "${database}" SET log_parameter_max_length_on_error=0`)
    const userUrl = new URL(ownerUrl); userUrl.username = role; userUrl.password = password
    const file = join(root, 'database-url')
    await writeFile(file, userUrl.href + '\n', { mode: 0o600, flag: 'wx' })
    restricted = createPostgresPool(userUrl.href, { max: 1 })
    const settings = async () => (await restricted!.query<{ value: string }>(
      "SELECT current_setting('log_parameter_max_length') value",
    )).rows[0]!.value
    expect(await settings()).toBe('-1')
    const mode = process.env.DSH_EXAMPLE_MODE ?? 'src'
    if (mode !== 'src' && mode !== 'lib') throw new Error('DSH_EXAMPLE_MODE must be src or lib')
    const gateway = resolve(import.meta.dirname, '..')
    const entry = mode === 'lib' ? join(process.env.DSH_GATEWAY_ARTIFACT_ROOT ?? gateway, 'lib/project-name-privacy-main.js')
      : join(gateway, 'src/project-name-privacy-main.ts')
    const transcript: Array<Record<string, unknown>> = []
    async function check(scenario: string, accepted: boolean) {
      let result: { exit: number; stdout: string; stderr: string }
      try {
        const response = await promisify(execFile)(process.execPath, [
          ...(mode === 'src' ? ['--import', import.meta.resolve('tsx/esm')] : []), entry,
        ], { cwd: root, timeout: 15_000, maxBuffer: 32 * 1024, env: { ...process.env,
          NODE_OPTIONS: undefined, NODE_PATH: undefined, HGW_DATABASE_URL: undefined, HGW_DATABASE_URL_FILE: file,
          HGW_NODE_CONFIG_FILE: join(root, 'absent-node-config.json'), HGW_STATE_ROOT: root,
          TSX_TSCONFIG_PATH: mode === 'src' ? join(gateway, 'tsconfig.run.json') : undefined,
        } })
        result = { exit: 0, ...response }
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string; killed?: boolean; signal?: string }
        expect(failure.killed).not.toBe(true)
        expect(failure.signal ?? null).toBeNull()
        expect(failure.code).toBe(1)
        result = { exit: failure.code, stdout: failure.stdout, stderr: failure.stderr }
      }
      if (accepted) {
        expect(JSON.parse(result.stdout)).toEqual({ ready: true, readOnly: true, role, database })
        expect(result.stderr).toBe('')
      } else {
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe('Project-name privacy preflight failed. Check the Gateway database connection and parameter-logging defaults or SET privileges; see gateway/deploy/node-content/README.md.\n')
      }
      transcript.push({ scenario, exit: result.exit, privacyVerified: accepted,
        projectRows: Number((await owner!.query('SELECT count(*) FROM harness.projects')).rows[0].count),
        retainedConnectionParameter: await settings() })
    }
    await check('missing-parameter-permission', false)
    await admin.query(`GRANT SET ON PARAMETER log_parameter_max_length TO "${role}"`)
    await check('transaction-local-parameter-permission', true)
    await admin.query(`REVOKE SET ON PARAMETER log_parameter_max_length FROM "${role}"`)
    await admin.query(`ALTER ROLE "${role}" IN DATABASE "${database}" SET log_parameter_max_length=0`)
    await check('safe-role-database-defaults', true)
    expect((await admin.query(`SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1`, [role])).rows[0])
      .toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolbypassrls: false })
    expect((await owner.query(`SELECT has_table_privilege($1,'harness.projects','INSERT') allowed`, [role])).rows[0].allowed).toBe(false)
    const expected = await readFile(new URL('./expected/project-name-privacy-preflight.jsonl', import.meta.url), 'utf8')
    expect(transcript.map(row => JSON.stringify(row)).join('\n') + '\n').toBe(expected)
  } finally {
    try { await restricted?.end() } finally {
      try { await owner?.end() } finally {
        try { if (databaseCreated) await admin.query(`DROP DATABASE "${database}"`) } finally {
          try {
            if (roleCreated) {
              await admin.query(`REVOKE SET ON PARAMETER log_parameter_max_length FROM "${role}"`)
              await admin.query(`DROP ROLE "${role}"`)
            }
          } finally {
            try { await admin.end() } finally { await rm(root, { recursive: true, force: true }) }
          }
        }
      }
    }
  }
})
