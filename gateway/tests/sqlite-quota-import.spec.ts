/** Legacy quota keys preserve effective policy through rewrites, account cleanup and PostgreSQL import. @module */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openDb } from '../src/db.ts'
import { ModelGovernanceService } from '../src/model-governance.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { importSqliteControlPlane } from '../src/postgres/sqlite-import.ts'
import { UserService } from '../src/users.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'quota-legacy-'))
  const file = join(root, 'gateway.sqlite'), db = openDb(file)
  const close = async () => { try { db.close() } finally { await rm(root, { recursive: true, force: true }) } }
  try {
    const users = new UserService(db, testConfig(root))
    const admin = await users.create({ username: 'administrator', password: 'pw-12345678', role: 'admin' })
    await users.changeOwnPassword(admin.id, 'pw-12345678')
    const target = await users.create({ username: 'member', password: 'pw-12345678' })
    const governance = new ModelGovernanceService(db)
    governance.setQuota('role', 'user', 50, 90)
    const rows = () => db.prepare('SELECT * FROM model_quotas ORDER BY subject_type,subject_id').all()
    const insert = (id: string, token: number | null, cost: number | null) => db.prepare(`INSERT INTO model_quotas(
      subject_type,subject_id,token_limit,company_cost_micros_limit) VALUES('user',?,?,?)`).run(id, token, cost)
    return { file, db, users, admin, target, governance, rows, insert, close }
  } catch (error) {
    try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Legacy quota setup and cleanup failed') }
    throw error
  }
}

it.each(['rewrite', 'inherit', 'remove'] as const)('retires historical account quota aliases during %s without changing another account', async operation => {
  const f = await fixture()
  try {
    const id = f.target.id
    for (const alias of [String(id).padStart(8, '0'), `${id}e0`, `${id}.0`, `+${id}`, `0x${id.toString(16)}`]) f.insert(alias, 0, null)
    f.insert(String(f.admin.id).padStart(8, '0'), 900, 900)
    if (operation === 'remove') expect(f.users.remove(id, f.admin.id)).toBe(true)
    else f.governance.setQuota('user', String(id), operation === 'inherit' ? 'inherit' : 100, operation === 'inherit' ? 'inherit' : 200, f.admin.id)
    expect(f.db.prepare("SELECT subject_id FROM model_quotas WHERE subject_type='user' ORDER BY subject_id").all()).toEqual([
      { subject_id: String(f.admin.id).padStart(8, '0') }, ...(operation === 'rewrite' ? [{ subject_id: String(id) }] : []),
    ])
  } finally { await f.close() }
})

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('legacy quota import', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 1 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function removeOrganization(organizationId: string): Promise<void> {
    await pool.query('DELETE FROM harness.user_quotas WHERE user_id IN (SELECT id FROM harness.users WHERE organization_id=$1)', [organizationId])
    const tables = (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.columns WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'")).rows
    for (let pass = 0; pass < 12; pass += 1) {
      let blocked = false
      for (const { table_name: table } of tables) {
        try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [organizationId]) }
        catch (error) { if ((error as { code?: string }).code === '23503') blocked = true; else throw error }
      }
      if (!blocked) break
    }
    await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [organizationId])
    await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
  }

  it.each(['canonical-first', 'alias-first', 'alias-only'] as const)('preserves the effective SQLite quota for %s data and reports ignored aliases', async order => {
    const f = await fixture(), slug = `quota-import-${randomUUID()}`
    let organizationId: string | undefined
    let unrelatedAccountId: number | undefined
    try {
      const canonical = () => f.insert(String(f.target.id), 200, 300)
      const alias = () => f.insert(String(f.target.id).padStart(8, '0'), 0, null)
      if (order === 'canonical-first') { canonical(); alias() }
      else if (order === 'alias-first') { alias(); canonical() }
      else alias()
      const before = f.rows(), expected = f.governance.summary({ kind: 'user', id: f.target.id })
      for (let replay = 0; replay < 2; replay += 1) {
        const report = await importSqliteControlPlane(pool, { sqliteFile: f.file, organizationSlug: slug })
        organizationId = report.organizationId
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 6)))
        const target = (await pool.query<{ public_id: string }>('SELECT public_id FROM harness.users WHERE organization_id=$1 AND legacy_id=$2', [organizationId, f.target.id])).rows[0]!
        const subject = { kind: 'user' as const, id: Number(target.public_id) }
        expect(await governance.summary(subject)).toMatchObject({ tokenLimit: expected.tokenLimit, companyCostMicrosLimit: expected.companyCostMicrosLimit })
        expect(await governance.userQuota(subject.id)).toEqual(f.governance.userQuota(f.target.id))
        expect(report).toMatchObject({ skippedQuotaAliases: 1 })
        expect(f.rows()).toEqual(before)
        if (unrelatedAccountId !== undefined) expect(await governance.userQuota(unrelatedAccountId)).toMatchObject({ tokenLimit: 777, companyCostMicrosLimit: 888 })
        if (replay === 0) {
          await governance.setQuota('user', String(subject.id), 999, null)
          unrelatedAccountId = Number((await pool.query<{ public_id: string }>(`INSERT INTO harness.users(
            organization_id,username,display_name,home_path) VALUES($1,'postgres-only','PostgreSQL only','/unused') RETURNING public_id`, [organizationId])).rows[0]!.public_id)
          await governance.setQuota('user', String(unrelatedAccountId), 777, 888)
        }
      }
    } finally {
      try {
        if (organizationId !== undefined) await removeOrganization(organizationId)
      } finally { await f.close() }
    }
  })

  it.each(['canonical-first', 'alias-only'] as const)('replays the real import command for frozen %s quota data', async order => {
    const f = await fixture(), slug = `quota-cli-${randomUUID()}`
    const root = resolve(f.file, '..'), frozen = join(root, 'frozen.sqlite'), urlFile = join(root, 'database-url')
    try {
      if (order === 'canonical-first') f.insert(String(f.target.id), 200, 300)
      f.insert(String(f.target.id).padStart(8, '0'), 0, null)
      await f.db.backup(frozen)
      const bytes = await readFile(frozen), expected = f.governance.summary({ kind: 'user', id: f.target.id })
      await writeFile(urlFile, databaseUrl!, { mode: 0o600 })
      const observations: Array<{ tokenLimit: number | null; companyCostMicrosLimit: number | null; skippedQuotaAliases: number }> = []
      for (let replay = 0; replay < 2; replay += 1) {
        const result = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx/esm'),
          resolve(import.meta.dirname, '../scripts/import-sqlite-to-postgres.ts'), frozen], {
          cwd: root, timeout: 10_000, killSignal: 'SIGKILL', env: { ...process.env,
            NODE_OPTIONS: undefined, NODE_PATH: undefined, DSH_MANAGED_DATA_MANIFEST: undefined,
            DSH_HOME: join(root, '.dsh'), DSH_AGENTS_HOME: join(root, '.agents'),
            TSX_TSCONFIG_PATH: resolve(import.meta.dirname, '../../tsconfig.json'),
            HGW_DATABASE_URL_FILE: urlFile, HGW_ORGANIZATION_SLUG: slug,
            HGW_ORGANIZATION_NAME: 'Quota CLI', HGW_COMPUTE_NODE_NAME: 'local',
          },
        })
        const report = JSON.parse(result.stdout) as { organizationId: string; skippedQuotaAliases: number }
        expect(report).toMatchObject({ skippedQuotaAliases: 1 })
        const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
        expect(report.organizationId).toBe(context.organizationId)
        const target = (await pool.query<{ public_id: string }>('SELECT public_id FROM harness.users WHERE organization_id=$1 AND legacy_id=$2', [context.organizationId, f.target.id])).rows[0]!
        const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 6)))
        const subject = { kind: 'user' as const, id: Number(target.public_id) }, actual = await governance.summary(subject)
        expect(actual).toMatchObject({ tokenLimit: expected.tokenLimit, companyCostMicrosLimit: expected.companyCostMicrosLimit })
        observations.push({ tokenLimit: actual.tokenLimit, companyCostMicrosLimit: actual.companyCostMicrosLimit, skippedQuotaAliases: report.skippedQuotaAliases })
        if (replay === 0) await governance.setQuota('user', String(subject.id), 999, null)
      }
      expect(await readFile(frozen)).toEqual(bytes)
      await expect(`${JSON.stringify({ order, observations, sourceUnchanged: true })}\n`)
        .toMatchFileSnapshot(resolve(import.meta.dirname, `expected/projects/legacy-quota-import-${order}.jsonl`))
    } finally {
      try {
        const own = (await pool.query<{ id: string }>('SELECT id FROM harness.organizations WHERE slug=$1', [slug])).rows[0]
        if (own !== undefined) await removeOrganization(own.id)
      } finally { await f.close() }
    }
  })

  it.each([
    ['1e999', 'invalid SQLite user quota subject'],
    ['00009999', 'missing imported users legacy id'],
  ])('rejects invalid persisted quota subject %s without publishing an organization', async (subject, message) => {
    const f = await fixture(), slug = `quota-invalid-${randomUUID()}`
    try {
      f.insert(subject!, 0, null)
      const before = f.rows()
      await expect(importSqliteControlPlane(pool, { sqliteFile: f.file, organizationSlug: slug })).rejects.toThrow(message)
      expect((await pool.query('SELECT 1 FROM harness.organizations WHERE slug=$1', [slug])).rowCount).toBe(0)
      expect(f.rows()).toEqual(before)
    } finally { await f.close() }
  })
})
