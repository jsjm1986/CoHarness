/** Administrator model writes retain current authority and consistent lock ordering. @module */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { GatewayModelGovernanceService } from '../src/services.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
const provider = { provider: 'org-administration', displayName: 'Original', driver: 'pi-ai' as const,
  protocol: 'openai-completions' as const, baseURL: 'https://model.example.test/v1', authMode: 'api-key' as const, status: 'draft' as const }
const model = { provider: provider.provider, model: 'chat', displayName: 'Original', enabled: true,
  adminAllowed: true, userAllowed: false, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
  cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 }

describePg('PostgreSQL administrator model authority', () => {
  let pool: Pool
  let foreign: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_MODEL_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
    foreign = await fixture()
  })
  afterAll(async () => { try { await foreign?.close() } finally { await pool?.end() } })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'model-administration-'))
    const slug = `model-administration-${randomUUID()}`
    let organizationId: string | undefined
    const close = async () => {
      try {
        if (organizationId !== undefined) {
          await pool.query('DELETE FROM harness.model_prices WHERE model_id IN (SELECT id FROM harness.model_catalog WHERE organization_id=$1)', [organizationId])
          await pool.query('DELETE FROM harness.user_quotas WHERE user_id IN (SELECT id FROM harness.users WHERE organization_id=$1)', [organizationId])
          await pool.query('DELETE FROM harness.project_quotas WHERE project_id IN (SELECT id FROM harness.projects WHERE organization_id=$1)', [organizationId])
          const tables = (await pool.query<{ table_name: string }>(`SELECT table_name FROM information_schema.columns
            WHERE table_schema='harness' AND column_name='organization_id' AND table_name<>'organizations'`)).rows
          for (let pass = 0; pass < 12; pass += 1) {
            let blocked = false
            for (const { table_name: table } of tables) {
              try { await pool.query(`DELETE FROM harness."${table.replaceAll('"', '""')}" WHERE organization_id=$1`, [organizationId]) }
              catch (error) {
                if ((error as { code?: string }).code === '23503') blocked = true
                else throw error
              }
            }
            if (!blocked) break
          }
          await pool.query('DELETE FROM harness.outbox WHERE organization_id=$1', [organizationId])
          await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    }
    try {
      organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Model administration') RETURNING id", [slug])).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const users: Array<{ uuid: string; id: number }> = []
      for (const username of ['administrator', 'member']) {
        const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
          VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id`, [organizationId, username, root])).rows[0]!
        await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
          [organizationId, row.id, username === 'administrator' ? 'admin' : 'member'])
        users.push({ uuid: row.id, id: Number(row.public_id) })
      }
      const project = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.projects(organization_id,name) VALUES($1,'Model project') RETURNING id,public_id", [organizationId])).rows[0]!
      const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 9)))
      await governance.upsertProvider({ ...provider, credential: 'fixture-initial-secret' })
      await governance.upsertModel(model)
      await governance.upsertProvider({ ...provider, status: 'enabled' })
      const credential = (await governance.listProviders())[0]!.credentialRef!
      await governance.setUserAccess(users[1]!.id, provider.provider, model.model, false)
      await governance.setProjectAccess(Number(project.public_id), provider.provider, model.model, false)
      const state = async () => {
        const rows = await Promise.all([
          pool.query('SELECT model_configuration_revision FROM harness.organizations WHERE id=$1', [organizationId]),
          ...['model_providers', 'model_catalog', 'model_role_access', 'model_user_access', 'model_project_access',
            'organization_model_credentials', 'role_quotas'].map(table => pool.query(
            `SELECT to_jsonb(t) record FROM harness.${table} t WHERE organization_id=$1 ORDER BY to_jsonb(t)::text`, [organizationId])),
          pool.query('SELECT id,model_access_default_allowed FROM harness.projects WHERE organization_id=$1 ORDER BY id', [organizationId]),
          pool.query(`SELECT to_jsonb(q) record FROM harness.user_quotas q JOIN harness.users u ON u.id=q.user_id
            WHERE u.organization_id=$1 ORDER BY to_jsonb(q)::text`, [organizationId]),
          pool.query(`SELECT to_jsonb(q) record FROM harness.project_quotas q JOIN harness.projects p ON p.id=q.project_id
            WHERE p.organization_id=$1 ORDER BY to_jsonb(q)::text`, [organizationId]),
        ])
        return createHash('sha256').update(JSON.stringify(rows.map(result => result.rows))).digest('hex')
      }
      return { root, context, governance, credential, actor: users[0]!, member: users[1]!, project: { uuid: project.id, id: Number(project.public_id) }, state, close }
    } catch (error) {
      try { await close() } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Model administration fixture setup and cleanup failed') }
      throw error
    }
  }

  function operations(f: Awaited<ReturnType<typeof fixture>>, service: GatewayModelGovernanceService, actor = f.actor.id) {
    return {
      provider: () => service.upsertProvider({ ...provider, status: 'enabled', displayName: 'Updated' }, actor),
      model: () => service.upsertModel({ ...model, displayName: 'Updated' }, actor),
      settings: () => service.mutateOrganizationModelSettings([{ op: 'set', path: ['providers', provider.provider, 'displayName'], value: 'Updated' }], undefined, actor),
      'credential-set': () => service.setOrganizationCredential(f.credential, 'fixture-updated-secret', actor),
      'credential-unset': () => service.unsetOrganizationCredential(f.credential, actor),
      'user-access': () => service.setUserAccess(f.member.id, provider.provider, model.model, true, actor),
      'project-access': () => service.setProjectAccess(f.project.id, provider.provider, model.model, true, actor),
      'project-access-all': () => service.setAllProjectAccess(f.project.id, true, actor),
      'role-quota': () => service.setQuota('role', 'user', 0, 1000, actor),
      'user-quota': () => service.setQuota('user', String(f.member.id), 0, 1000, actor),
      'project-quota': () => service.setQuota('project', String(f.project.id), 0, 1000, actor),
    }
  }

  for (const operation of ['provider', 'model', 'settings', 'credential-set', 'credential-unset', 'user-access', 'project-access',
    'project-access-all', 'role-quota', 'user-quota', 'project-quota'] as const) {
    it.each(['role', 'disabled-account', 'deleted-account', 'disabled-membership', 'missing-membership', 'disabled-organization',
      'other-organization', 'current'] as const)(`retains current administrator authority for ${operation} after configuration admission: %s`, async change => {
      const f = await fixture(), name = `model-administrator-${randomUUID()}`
      const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: name })
      const service = new PostgresModelGovernanceService({ ...f.context, pool: reader }, new OrganizationModelCredentialCipher(Buffer.alloc(32, 9)))
      const blocker = await pool.connect()
      let pending: Promise<unknown> | undefined
      try {
        const before = await f.state()
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.organizations WHERE id=$1 FOR UPDATE', [f.context.organizationId])
        pending = Promise.resolve(operations(f, service, change === 'other-organization' ? foreign.actor.id : f.actor.id)[operation]()).catch((error: unknown) => error)
        await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [name],
        )).rows[0]!.waiting, { timeout: 10_000 }).toBe(true)
        if (change === 'role') await blocker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.uuid])
        else if (change === 'disabled-account') await blocker.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.actor.uuid])
        else if (change === 'deleted-account') await blocker.query('UPDATE harness.users SET deleted_at=clock_timestamp() WHERE id=$1', [f.actor.uuid])
        else if (change === 'disabled-membership') await blocker.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [f.actor.uuid])
        else if (change === 'missing-membership') await blocker.query('DELETE FROM harness.memberships WHERE user_id=$1', [f.actor.uuid])
        else if (change === 'disabled-organization') await blocker.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.context.organizationId])
        await blocker.query('COMMIT')
        const result = await pending
        if (change === 'current') {
          expect(result).not.toBeInstanceOf(Error)
          expect(await f.state()).not.toBe(before)
        } else {
          expect(result).toMatchObject({ code: 'forbidden' })
          expect(await f.state()).toBe(before)
        }
      } finally {
        try { await blocker.query('ROLLBACK') } finally { blocker.release() }
        await pending; await reader.end(); await f.close()
      }
    })
  }

  it.each(['project-access', 'project-access-all', 'project-quota'] as const)('refuses %s for an already archived project', async operation => {
    const f = await fixture()
    try {
      const before = await f.state()
      await pool.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [f.project.uuid])
      await expect(Promise.resolve(operations(f, f.governance)[operation]())).rejects.toThrow(`unknown project ${String(f.project.id)}`)
      expect(await f.state()).toBe(before)
    } finally { await f.close() }
  })

  it.each(['project-access', 'project-access-all', 'project-quota'] as const)('refuses %s after its project is archived during a row wait', async operation => {
    const f = await fixture(), name = `model-project-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: name })
    const service = new PostgresModelGovernanceService({ ...f.context, pool: reader }, new OrganizationModelCredentialCipher(Buffer.alloc(32, 9)))
    const blocker = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      const before = await f.state()
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM harness.projects WHERE organization_id=$1 AND id=$2 FOR UPDATE', [f.context.organizationId, f.project.uuid])
      pending = Promise.resolve(operations(f, service)[operation]()).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [name],
      )).rows[0]!.waiting, { timeout: 10_000 }).toBe(true)
      await blocker.query("UPDATE harness.projects SET status='archived' WHERE id=$1", [f.project.uuid])
      await blocker.query('COMMIT')
      expect(await pending).toBeInstanceOf(Error)
      expect(await f.state()).toBe(before)
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await pending; await reader.end(); await f.close()
    }
  })

  it('preserves independent account quota modes on a single transaction connection', async () => {
    const f = await fixture(), reader = createPostgresPool(databaseUrl!, { max: 1 })
    const service = new PostgresModelGovernanceService({ ...f.context, pool: reader }, new OrganizationModelCredentialCipher(Buffer.alloc(32, 9)))
    try {
      await service.setQuota('role', 'user', 50, 90, f.actor.id)
      for (const token of ['inherit', null, 0] as const) {
        for (const cost of ['inherit', null, 0] as const) {
          await service.setQuota('user', String(f.member.id).padStart(8, '0'), token, cost, f.actor.id)
          expect(await service.userQuota(f.member.id)).toEqual({
            tokenMode: token === 'inherit' ? 'inherit' : token === null ? 'unlimited' : 'custom',
            tokenLimit: typeof token === 'number' ? token : null,
            companyCostMode: cost === 'inherit' ? 'inherit' : cost === null ? 'unlimited' : 'custom',
            companyCostMicrosLimit: typeof cost === 'number' ? cost : null,
          })
          expect(await service.summary({ kind: 'user', id: f.member.id })).toMatchObject({
            tokenLimit: token === 'inherit' ? 50 : token,
            companyCostMicrosLimit: cost === 'inherit' ? 90 : cost,
          })
        }
      }
      await service.setQuota('user', String(f.member.id), 'inherit', 'inherit', f.actor.id)
      expect((await pool.query('SELECT 1 FROM harness.user_quotas WHERE user_id=$1', [f.member.uuid])).rowCount).toBe(0)
    } finally { await reader.end(); await f.close() }
  })

  it('retains disabled-account configuration and rolls back invalid role or partial project inheritance', async () => {
    const f = await fixture()
    try {
      await pool.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [f.member.uuid])
      await f.governance.setUserAccess(f.member.id, provider.provider, model.model, true, f.actor.id)
      await f.governance.setQuota('user', String(f.member.id), 0, null, f.actor.id)
      expect(await f.governance.userQuota(f.member.id)).toMatchObject({ tokenMode: 'custom', tokenLimit: 0, companyCostMode: 'unlimited' })
      await f.governance.setQuota('project', String(f.project.id), 0, 90, f.actor.id)
      const before = await f.state()
      await expect(f.governance.setQuota('project', String(f.project.id), 'inherit', 0, f.actor.id)).rejects.toThrow('both inherit or both be explicit')
      await expect(f.governance.setQuota('role', 'user', 'inherit', 0, f.actor.id)).rejects.toThrow('role quotas cannot inherit')
      expect(await f.state()).toBe(before)
    } finally { await f.close() }
  })

  it('serializes provider updates with organization editor saves without a lock-order deadlock', async () => {
    const f = await fixture(), key = randomUUID(), trigger = `model_write_${randomUUID().replaceAll('-', '')}`
    const firstName = `model-upsert-${randomUUID()}`, secondName = `model-editor-${randomUUID()}`
    const firstPool = createPostgresPool(databaseUrl!, { max: 1, application_name: firstName })
    const secondPool = createPostgresPool(databaseUrl!, { max: 1, application_name: secondName })
    const first = new PostgresModelGovernanceService({ ...f.context, pool: firstPool }, new OrganizationModelCredentialCipher(Buffer.alloc(32, 9)))
    const second = new PostgresModelGovernanceService({ ...f.context, pool: secondPool }, new OrganizationModelCredentialCipher(Buffer.alloc(32, 9)))
    const blocker = await pool.connect()
    let one: Promise<unknown> | undefined, two: Promise<unknown> | undefined
    try {
      await pool.query(`CREATE FUNCTION harness.${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtext(TG_ARGV[0])); RETURN NEW; END $$`)
      await pool.query(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON harness.model_providers
        FOR EACH ROW WHEN (NEW.organization_id='${f.context.organizationId}'::uuid) EXECUTE FUNCTION harness.${trigger}('${key}')`)
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key])
      const initial = await f.governance.configurationRevision()
      one = first.upsertProvider({ ...provider, status: 'enabled', displayName: 'First' }).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory') waiting", [firstName],
      )).rows[0]!.waiting, { timeout: 10_000 }).toBe(true)
      two = second.mutateOrganizationModelSettings([{ op: 'set', path: ['providers', provider.provider, 'displayName'], value: 'Second' }]).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
        JOIN pg_stat_activity b ON b.application_name=$1 WHERE a.application_name=$2 AND b.pid=ANY(pg_blocking_pids(a.pid))) waiting`,
      [firstName, secondName])).rows[0]!.waiting, { timeout: 10_000 }).toBe(true)
      await blocker.query('COMMIT')
      expect(await one).not.toBeInstanceOf(Error)
      expect(await two).not.toBeInstanceOf(Error)
      expect(await f.governance.configurationRevision()).toBe(initial + 2)
      expect((await f.governance.listProviders())[0]?.displayName).toBe('Second')
    } finally {
      try { await blocker.query('ROLLBACK') } finally { blocker.release() }
      await Promise.all([one, two])
      await pool.query(`DROP TRIGGER IF EXISTS ${trigger} ON harness.model_providers`)
      await pool.query(`DROP FUNCTION IF EXISTS harness.${trigger}()`)
      await firstPool.end(); await secondPool.end(); await f.close()
    }
  })
})
