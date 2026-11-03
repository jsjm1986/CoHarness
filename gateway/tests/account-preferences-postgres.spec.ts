/** Account preferences retain current organization/account eligibility through transactional work. @module */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { PostgresAccountPreferencesService } from '../src/postgres/account-preferences-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL account preference authority', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_ACCOUNT_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'account-preference-authority-')), slug = `account-preference-${randomUUID()}`
    let organizationId: string | undefined
    const close = async () => {
      try {
        if (organizationId !== undefined) {
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
      } finally { await rm(root, { recursive: true, force: true }) }
    }
    try {
      organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Account preference') RETURNING id", [slug])).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local'), cfg = testConfig(root)
      const row = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.users(organization_id,username,display_name,home_path) VALUES($1,'member','Member',$2) RETURNING id,public_id", [organizationId, root])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, row.id])
      const user: UserRow = { id: Number(row.public_id), username: 'member', displayName: 'Member', homePath: root, role: 'user', status: 'active', mustChangePassword: false, autoReviewEligible: false }
      const state = () => pool.query('SELECT to_jsonb(p) record FROM harness.user_preferences p WHERE organization_id=$1', [organizationId]).then(result => result.rows)
      return { root, cfg, context, user, internal: row.id, state, close }
    } catch (error) {
      try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Account preference setup and cleanup failed') }
      throw error
    }
  }

  for (const operation of ['describe', 'mutate'] as const) {
    it.each(['disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization', 'current'] as const)(`${operation} checks current authority after checkout: %s`, async change => {
      const f = await fixture(), reader = createPostgresPool(databaseUrl!, { max: 1 })
      const service = new PostgresAccountPreferencesService({ ...f.context, pool: reader }, f.cfg)
      const held = await reader.connect()
      let pending: Promise<unknown> | undefined, released = false
      try {
        pending = (operation === 'describe' ? service.describe(f.user) : service.mutate(f.user, { namespace: 'ui-theme', field: 'preference', operation: 'set', value: 'dark' })).catch((error: unknown) => error)
        await expect.poll(() => reader.waitingCount).toBe(1)
        if (change === 'disabled-account') await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.internal])
        else if (change === 'deleted-account') await pool.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [f.internal])
        else if (change === 'disabled-membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [f.internal])
        else if (change === 'missing-membership') await pool.query('DELETE FROM harness.memberships WHERE user_id=$1', [f.internal])
        else if (change === 'disabled-organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
        held.release(); released = true
        const result = await pending
        if (change === 'current') { expect(result).toMatchObject({ revision: operation === 'describe' ? 0 : 1 }); expect(await f.state()).toHaveLength(1) }
        else { expect(result).toMatchObject({ code: 'forbidden' }); expect(await f.state()).toEqual([]) }
      } finally {
        if (!released) held.release()
        await pending; await reader.end(); await f.close()
      }
    })
  }

  it.skipIf(process.platform === 'win32')('does not initialize preferences after a POSIX legacy read failure, and retries the repaired source', async () => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    const directory = join(f.cfg.usersRoot, f.user.username, 'dsh'), file = join(directory, 'settings.yaml')
    try {
      await mkdir(directory, { recursive: true }); await symlink('settings.yaml', file)
      await expect(service.describe(f.user)).rejects.toMatchObject({ code: 'account-preferences-unavailable' })
      expect(await f.state()).toEqual([])
      await rm(file); await writeFile(file, 'ui-theme:\n  preference: dark\n')
      expect(await service.describe(f.user)).toMatchObject({ revision: 1, migrated: true, values: { 'ui-theme': { preference: 'dark' } } })
    } finally { await f.close() }
  })

  it.each(['describe', 'mutate'] as const)('retains the accepted account until %s commits after a preference-row wait', async operation => {
    const f = await fixture(), readerName = `preference-reader-${randomUUID()}`, revokeName = `preference-revoke-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: readerName })
    const revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName })
    const service = new PostgresAccountPreferencesService({ ...f.context, pool: reader }, f.cfg), blocker = await pool.connect()
    let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, revokeSettled = false
    try {
      await pool.query('INSERT INTO harness.user_preferences(organization_id,user_id) VALUES($1,$2)', [f.context.organizationId, f.internal])
      await blocker.query('BEGIN')
      await blocker.query('SELECT user_id FROM harness.user_preferences WHERE user_id=$1 FOR UPDATE', [f.internal])
      pending = (operation === 'describe' ? service.describe(f.user) : service.mutate(f.user, { namespace: 'ui-theme', field: 'preference', operation: 'set', value: 'dark' })).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [readerName])).rows[0]!.waiting).toBe(true)
      revoked = revoker.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.internal]).then(value => { revokeSettled = true; return value }, (error: unknown) => { revokeSettled = true; return error })
      await expect.poll(async () => revokeSettled || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity r JOIN pg_stat_activity p ON p.application_name=$1
        WHERE r.application_name=$2 AND p.pid=ANY(pg_blocking_pids(r.pid))) blocked`, [readerName, revokeName])).rows[0]!.blocked).toBe(true)
      expect(revokeSettled).toBe(false)
      await blocker.query('COMMIT')
      expect(await pending).toMatchObject({ revision: operation === 'describe' ? 0 : 1 })
      expect(await revoked).not.toBeInstanceOf(Error)
      expect((await pool.query('SELECT status FROM harness.users WHERE id=$1', [f.internal])).rows[0]?.status).toBe('disabled')
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await Promise.all([pending, revoked]); await reader.end(); await revoker.end(); await f.close()
    }
  })

  it('keeps independent account data and fences concurrent first writes with the same revision', async () => {
    const f = await fixture(), other = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    try {
      await expect(service.describe(other.user)).rejects.toMatchObject({ code: 'forbidden' })
      const changes = await Promise.allSettled(['dark', 'light'].map(value => service.mutate(f.user, { namespace: 'ui-theme', field: 'preference', operation: 'set', value, expectedRevision: 0 })))
      expect(changes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
      expect(changes.filter(row => row.status === 'rejected').map(row => row.reason)).toEqual([expect.objectContaining({ code: 'account-preferences-conflict' })])
      expect(await service.describe(f.user)).toMatchObject({ revision: 1 })
      expect(await other.state()).toEqual([])
    } finally { await f.close(); await other.close() }
  })

  it.each(['missing', 'malformed'] as const)('initializes defaults for an intentionally %s legacy document', async kind => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    try {
      if (kind === 'malformed') {
        const directory = join(f.cfg.usersRoot, f.user.username, 'dsh')
        await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'settings.yaml'), 'ui-theme: [broken')
      }
      expect(await service.describe(f.user)).toMatchObject({ revision: 0, migrated: false, values: { 'ui-theme': { preference: 'system' } } })
    } finally { await f.close() }
  })

  const fontCases = [
    ['fontSize', 18, 14], ['codeFontSize', 15, 11], ['terminalFontSize', 16, 13],
    ['textFontFamily', '"Noto Sans", sans-serif', ''], ['codeFontFamily', '"Fira Code", monospace', ''],
    ['terminalFontFamily', '"JetBrains Mono", monospace', ''],
  ] as const

  it('omits malformed legacy font values while committing default account fonts once', async () => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    const directory = join(f.cfg.usersRoot, f.user.username, 'dsh')
    try {
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'settings.yaml'), 'ui-theme:\n  fontSize: 23\n  codeFontSize: 10.5\n  terminalFontSize: "18"\n  textFontFamily: false\n  codeFontFamily: []\n  terminalFontFamily: null\n')
      expect(await service.describe(f.user)).toMatchObject({ revision: 0, migrated: false,
        values: { 'ui-theme': { fontSize: 14, codeFontSize: 11, terminalFontSize: 13, textFontFamily: '', codeFontFamily: '', terminalFontFamily: '' } }, overrides: { 'ui-theme': {} } })
      expect((await f.state())[0].record.theme_fonts_migrated_at).not.toBeNull()
    } finally { await f.close() }
  })

  it.each(fontCases)('persists and resets %s across service instances without sharing another account', async (field, value, fallback) => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    try {
      const second = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'second','Second',$2) RETURNING id,public_id`, [f.context.organizationId, join(f.root, 'second')])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [f.context.organizationId, second.id])
      const other = { ...f.user, id: Number(second.public_id), username: 'second' }
      const set = await service.mutate(f.user, { namespace: 'ui-theme', field, operation: 'set', value, expectedRevision: 0 })
      expect(set).toMatchObject({ revision: 1, values: { 'ui-theme': { [field]: value } }, overrides: { 'ui-theme': { [field]: value } } })
      const anotherGateway = new PostgresAccountPreferencesService(f.context, f.cfg)
      expect((await anotherGateway.describe(f.user)).values['ui-theme'][field]).toBe(value)
      expect((await anotherGateway.describe(other)).values['ui-theme'][field]).toBe(fallback)
      const reset = await anotherGateway.mutate(f.user, { namespace: 'ui-theme', field, operation: 'unset', expectedRevision: 1 })
      expect(reset.values['ui-theme'][field]).toBe(fallback)
      expect(reset.overrides['ui-theme']).not.toHaveProperty(field)
      expect(reset.revision).toBe(2)
    } finally { await f.close() }
  })

  it('imports six personal fonts once and retains their reset after the old file changes', async () => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    const directory = join(f.cfg.usersRoot, f.user.username, 'dsh'), file = join(directory, 'settings.yaml')
    const raw = 'ui-theme:\n  preference: dark\n  fontSize: 18\n  codeFontSize: 15\n  terminalFontSize: 16\n  textFontFamily: Noto Sans\n  codeFontFamily: Fira Code\n  terminalFontFamily: JetBrains Mono\n'
    try {
      await mkdir(directory, { recursive: true }); await writeFile(file, raw)
      const first = await service.describe(f.user)
      expect(first).toMatchObject({ revision: 1, migrated: true, overrides: { 'ui-theme': {
        preference: 'dark', fontSize: 18, codeFontSize: 15, terminalFontSize: 16,
        textFontFamily: 'Noto Sans', codeFontFamily: 'Fira Code', terminalFontFamily: 'JetBrains Mono',
      } } })
      expect(await readFile(file, 'utf8')).toBe(raw)
      await service.mutate(f.user, { namespace: 'ui-theme', field: 'fontSize', operation: 'unset', expectedRevision: 1 })
      await writeFile(file, raw.replace('fontSize: 18', 'fontSize: 22'))
      const next = await new PostgresAccountPreferencesService(f.context, f.cfg).describe(f.user)
      expect(next).toMatchObject({ revision: 2, values: { 'ui-theme': { fontSize: 14, codeFontSize: 15, preference: 'dark' } } })
      expect(next.overrides['ui-theme']).not.toHaveProperty('fontSize')
    } finally { await f.close() }
  })

  it('imports absent fonts for an existing account without replacing explicit appearance or built-in fonts', async () => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    const directory = join(f.cfg.usersRoot, f.user.username, 'dsh'), file = join(directory, 'settings.yaml')
    try {
      await pool.query(`INSERT INTO harness.user_preferences(organization_id,user_id,theme_preference,font_size,text_font_family,revision)
        VALUES($1,$2,'dark',19,'',5)`, [f.context.organizationId, f.internal])
      await mkdir(directory, { recursive: true }); await writeFile(file, 'ui-theme:\n  preference: light\n  fontSize: 17\n  codeFontSize: 15\n  terminalFontSize: 16\n  textFontFamily: Old Text\n  codeFontFamily: Old Code\n  terminalFontFamily: Old Terminal\n')
      const view = await service.describe(f.user)
      expect(view).toMatchObject({ revision: 6, values: { 'ui-theme': {
        preference: 'dark', fontSize: 19, codeFontSize: 15, terminalFontSize: 16,
        textFontFamily: '', codeFontFamily: 'Old Code', terminalFontFamily: 'Old Terminal',
      } } })
      expect(view.overrides['ui-theme']).toHaveProperty('textFontFamily', '')
      expect(await service.describe(f.user)).toMatchObject({ revision: 6 })
    } finally { await f.close() }
  })

  it.skipIf(process.platform === 'win32')('keeps six explicit account fonts without reading an unavailable legacy file', async () => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    const directory = join(f.cfg.usersRoot, f.user.username, 'dsh'), file = join(directory, 'settings.yaml')
    try {
      await pool.query(`INSERT INTO harness.user_preferences(organization_id,user_id,font_size,code_font_size,terminal_font_size,
        text_font_family,code_font_family,terminal_font_family,revision) VALUES($1,$2,19,14,17,'','','',5)`, [f.context.organizationId, f.internal])
      await mkdir(directory, { recursive: true }); await symlink('settings.yaml', file)
      expect(await service.describe(f.user)).toMatchObject({ revision: 5, values: { 'ui-theme': { fontSize: 19, codeFontSize: 14, terminalFontSize: 17 } } })
      expect((await f.state())[0].record.theme_fonts_migrated_at).not.toBeNull()
    } finally { await f.close() }
  })

  it.skipIf(process.platform === 'win32')('does not mark existing fonts imported after a legacy read failure, and retries the repaired file', async () => {
    const f = await fixture(), service = new PostgresAccountPreferencesService(f.context, f.cfg)
    const directory = join(f.cfg.usersRoot, f.user.username, 'dsh'), file = join(directory, 'settings.yaml')
    try {
      await pool.query("INSERT INTO harness.user_preferences(organization_id,user_id,theme_preference,revision) VALUES($1,$2,'dark',4)", [f.context.organizationId, f.internal])
      await mkdir(directory, { recursive: true }); await symlink('settings.yaml', file)
      await expect(service.describe(f.user)).rejects.toMatchObject({ code: 'account-preferences-unavailable' })
      expect((await f.state())[0].record).toMatchObject({ revision: 4, theme_fonts_migrated_at: null, font_size: null })
      await rm(file); await writeFile(file, 'ui-theme:\n  fontSize: 20\n')
      expect(await service.describe(f.user)).toMatchObject({ revision: 5, values: { 'ui-theme': { preference: 'dark', fontSize: 20 } } })
    } finally { await f.close() }
  })
})
