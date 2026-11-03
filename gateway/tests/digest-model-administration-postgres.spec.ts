/** Digest route selection retains tenant, administrator and writer ownership. @module */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresProgressService } from '../src/postgres/progress-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL digest model administration', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, process.env.DSH_AUDIT_DIGEST_MIGRATIONS ?? resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })
  async function fixture() {
    const slug = `digest-administration-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Digest administration') RETURNING id", [slug])).rows[0]!.id
    try {
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const actor = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,'administrator','Administrator','/unused') RETURNING id,public_id`, [organizationId])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')", [organizationId, actor.id])
      const provider = (await pool.query<{ id: string }>(`INSERT INTO harness.model_providers(organization_id,provider_key,display_name,protocol,base_url,auth_mode,status)
        VALUES($1,'org-shared','Fixture provider','openai-completions','https://provider.invalid/v1','none','enabled') RETURNING id`, [organizationId])).rows[0]!.id
      for (const model of ['own-model', 'space model']) await pool.query(`INSERT INTO harness.model_catalog(organization_id,provider_key,model_key,display_name,provider_id)
        VALUES($1,'org-shared',$2,$2,$3)`, [organizationId, model, provider])
      const create = (source: Pool) => new PostgresProgressService({ ...context, pool: source }, { collaboration: new PostgresCollaborationService(context) })
      const service = create(pool), actorId = Number(actor.public_id)
      return { context, actor, actorId, provider, service, create, close: async () => { await service.close(); await removeFixtureOrganization(pool, organizationId) } }
    } catch (error) {
      try { await removeFixtureOrganization(pool, organizationId) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Digest setup and cleanup failed') }
      throw error
    }
  }

  it('keeps direct executor reads and writes restricted to the current administrator', async () => {
    const f = await fixture()
    try {
      await pool.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.id])
      await expect(f.service.digestModelSettings(f.actorId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.setDigestModel('org-shared/own-model', f.actorId)).rejects.toMatchObject({ code: 'forbidden' })
      await expect(f.service.setDigestModel(null, f.actorId)).rejects.toMatchObject({ code: 'forbidden' })
      expect((await pool.query('SELECT digest_model FROM harness.organizations WHERE id=$1', [f.context.organizationId])).rows[0]!.digest_model).toBeNull()
    } finally { await f.close() }
  })

  it('does not borrow another organization administrator or expose its catalog', async () => {
    const f = await fixture(), other = await fixture()
    try {
      await pool.query("UPDATE harness.model_catalog SET model_key='foreign-model' WHERE organization_id=$1 AND model_key='own-model'", [other.context.organizationId])
      await expect(f.service.digestModelSettings(other.actorId)).rejects.toMatchObject({ code: 'forbidden' })
      expect((await f.service.digestModelSettings(f.actorId)).candidates).toEqual([
        { provider: 'org-shared', model: 'own-model' }, { provider: 'org-shared', model: 'space model' },
      ])
      await expect(f.service.setDigestModel('org-shared/foreign-model', f.actorId)).rejects.toThrow('digest-model-unavailable')
      expect(await f.service.setDigestModel('org-shared/space model', f.actorId)).toMatchObject({ model: 'org-shared/space model' })
    } finally { await f.close(); await other.close() }
  })

  it.each(['model', 'provider'] as const)('rechecks %s eligibility after a configuration writer commits', async kind => {
    const f = await fixture(), held = await pool.connect(), name = `digest-target-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: name }), service = f.create(reader)
    let pending: Promise<unknown> | undefined
    try {
      await held.query('BEGIN'); await held.query('SELECT id FROM harness.organizations WHERE id=$1 FOR NO KEY UPDATE', [f.context.organizationId])
      await held.query(kind === 'model' ? "UPDATE harness.model_catalog SET enabled=false WHERE organization_id=$1 AND model_key='own-model'"
        : "UPDATE harness.model_providers SET status='disabled' WHERE organization_id=$1 AND provider_key='org-shared'", [f.context.organizationId])
      pending = service.setDigestModel('org-shared/own-model', f.actorId).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [name])).rows[0]!.waiting).toBe(true)
      await held.query('COMMIT')
      expect(await pending).toMatchObject({ message: 'digest-model-unavailable' })
      expect((await pool.query('SELECT digest_model FROM harness.organizations WHERE id=$1', [f.context.organizationId])).rows[0]!.digest_model).toBeNull()
    } finally { await held.query('ROLLBACK'); held.release(); await pending; await service.close(); await reader.end(); await f.close() }
  })

  it('serializes organization writers and returns each accepted view before a successor clears it', async () => {
    const f = await fixture(), firstName = `digest-first-${randomUUID()}`, secondName = `digest-second-${randomUUID()}`
    const firstPool = createPostgresPool(databaseUrl!, { max: 1, application_name: firstName }), secondPool = createPostgresPool(databaseUrl!, { max: 1, application_name: secondName })
    const firstService = f.create(firstPool), secondService = f.create(secondPool), held = await pool.connect()
    let first: Promise<unknown> | undefined, second: Promise<unknown> | undefined
    try {
      await held.query('BEGIN'); await held.query("SELECT id FROM harness.model_catalog WHERE organization_id=$1 AND model_key='own-model' FOR UPDATE", [f.context.organizationId])
      first = firstService.setDigestModel('org-shared/own-model', f.actorId).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [firstName])).rows[0]!.waiting).toBe(true)
      second = secondService.setDigestModel(null, f.actorId).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity later JOIN pg_stat_activity first ON first.application_name=$1
        WHERE later.application_name=$2 AND first.pid=ANY(pg_blocking_pids(later.pid))) blocked`, [firstName, secondName])).rows[0]!.blocked).toBe(true)
      await held.query('COMMIT')
      expect(await first).toMatchObject({ model: 'org-shared/own-model' }); expect(await second).toMatchObject({ model: null })
      expect((await f.service.digestModelSettings(f.actorId)).model).toBeNull()
    } finally { await held.query('ROLLBACK'); held.release(); await Promise.all([first, second]); await firstService.close(); await secondService.close(); await firstPool.end(); await secondPool.end(); await f.close() }
  })

  it('retains the initiating administrator until an accepted pin commits', async () => {
    const f = await fixture(), name = `digest-retained-${randomUUID()}`, revokeName = `digest-revoke-${randomUUID()}`
    const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: name }), revoker = createPostgresPool(databaseUrl!, { max: 1, application_name: revokeName }), service = f.create(reader), held = await pool.connect()
    let pending: Promise<unknown> | undefined, revoked: Promise<unknown> | undefined, revokeSettled = false
    try {
      await held.query('BEGIN'); await held.query("SELECT id FROM harness.model_catalog WHERE organization_id=$1 AND model_key='own-model' FOR UPDATE", [f.context.organizationId])
      pending = service.setDigestModel('org-shared/own-model', f.actorId).catch((error: unknown) => error)
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [name])).rows[0]!.waiting).toBe(true)
      revoked = revoker.query("UPDATE harness.memberships SET role='member' WHERE user_id=$1", [f.actor.id])
        .then(value => { revokeSettled = true; return value }, (error: unknown) => { revokeSettled = true; return error })
      await expect.poll(async () => revokeSettled || (await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity revoked JOIN pg_stat_activity pin ON pin.application_name=$1
        WHERE revoked.application_name=$2 AND pin.pid=ANY(pg_blocking_pids(revoked.pid))) blocked`, [name, revokeName])).rows[0]!.blocked).toBe(true)
      expect(revokeSettled).toBe(false)
      await held.query('COMMIT'); expect(await pending).toMatchObject({ model: 'org-shared/own-model' }); expect(await revoked).not.toBeInstanceOf(Error)
      await expect(service.digestModelSettings(f.actorId)).rejects.toMatchObject({ code: 'forbidden' })
    } finally { await held.query('ROLLBACK'); held.release(); await Promise.all([pending, revoked]); await service.close(); await reader.end(); await revoker.end(); await f.close() }
  })
})
