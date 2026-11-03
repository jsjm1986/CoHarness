/** Model authorization reads current account facts after configuration-lock waits. @module */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UserRow } from '../src/auth.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('current account model policy', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it.each(['demotion', 'promotion', 'disabled-account', 'deleted-account', 'disabled-membership',
    'missing-membership', 'disabled-organization', 'current-admin'] as const)(
    'resolves %s after a real configuration lock wait', async change => {
      const root = await mkdtemp(join(tmpdir(), 'hgw-model-account-'))
      const applicationName = `model-account-${randomUUID()}`
      const reader = createPostgresPool(databaseUrl!, { max: 1, application_name: applicationName })
      const blocker = await pool.connect()
      let pending: Promise<unknown> | undefined
      try {
        const slug = `model-account-${randomUUID()}`
        const organizationId = (await pool.query<{ id: string }>(
          "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Model policy account') RETURNING id", [slug],
        )).rows[0]!.id
        await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
        const context = await resolvePostgresRuntimeContext(reader, slug, 'local')
        const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
          organization_id,username,display_name,home_path) VALUES($1,'policy-owner','Policy owner',$2) RETURNING id,public_id`,
        [organizationId, root])).rows[0]!
        const role = change === 'promotion' ? 'user' : 'admin'
        await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
          [organizationId, row.id, role === 'admin' ? 'admin' : 'member'])
        const user: UserRow = { id: Number(row.public_id), username: 'policy-owner', displayName: 'Policy owner', homePath: root,
          role, status: 'active', mustChangePassword: false, autoReviewEligible: false }
        const governance = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 7)), 'UTC')
        const provider = { provider: 'org-policy', displayName: 'Policy', driver: 'pi-ai' as const,
          protocol: 'openai-completions' as const, baseURL: 'https://models.example.test/v1', authMode: 'none' as const }
        await governance.upsertProvider({ ...provider, status: 'draft' })
        await governance.upsertModel({ provider: 'org-policy', model: 'chat', displayName: 'Chat', enabled: true,
          adminAllowed: true, userAllowed: false, inputMicrosPerMillion: 0, outputMicrosPerMillion: 0,
          cacheReadMicrosPerMillion: 0, cacheWriteMicrosPerMillion: 0 })
        await governance.upsertProvider({ ...provider, status: 'enabled' })
        await blocker.query('BEGIN')
        await blocker.query('SELECT id FROM harness.organizations WHERE id=$1 FOR UPDATE', [organizationId])
        pending = governance.policyFor(user).catch((error: unknown) => error)
        await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') waiting", [applicationName],
        )).rows[0]!.waiting).toBe(true)
        if (change === 'demotion' || change === 'promotion') await blocker.query('UPDATE harness.memberships SET role=$1 WHERE user_id=$2', [change === 'promotion' ? 'admin' : 'member', row.id])
        else if (change === 'disabled-account') await blocker.query("UPDATE harness.users SET status='disabled' WHERE id=$1", [row.id])
        else if (change === 'deleted-account') await blocker.query('UPDATE harness.users SET deleted_at=now() WHERE id=$1', [row.id])
        else if (change === 'disabled-membership') await blocker.query("UPDATE harness.memberships SET status='disabled' WHERE user_id=$1", [row.id])
        else if (change === 'missing-membership') await blocker.query('DELETE FROM harness.memberships WHERE user_id=$1', [row.id])
        else if (change === 'disabled-organization') await blocker.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [organizationId])
        await blocker.query('COMMIT')
        const result = await pending
        if (change === 'demotion' || change === 'promotion' || change === 'current-admin') {
          expect(result).toMatchObject({ defaultAllowed: false, models: [{ provider: 'org-policy', model: 'chat', allowed: change !== 'demotion' }] })
        } else expect(result).toMatchObject({ code: 'forbidden' })
      } finally {
        await blocker.query('ROLLBACK'); blocker.release()
        await pending; await reader.end(); await rm(root, { recursive: true, force: true })
      }
    },
  )
})
