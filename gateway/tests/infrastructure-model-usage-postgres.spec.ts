/** Runtime model maintenance charges its project without inventing a contributor. */
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresModelGovernanceService } from '../src/postgres/model-governance-service.ts'
import { OrganizationModelCredentialCipher } from '../src/organization-model-credentials.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe
describePg('infrastructure model usage', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 2 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('accepts traced infrastructure usage and idempotent project billing without an activity actor', async () => {
    const slug = `infrastructure-usage-${randomUUID()}`
    const organization = (await pool.query<{ id: string }>("INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Infrastructure usage') RETURNING id", [slug])).rows[0]!.id
    try {
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organization])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const project = (await pool.query<{ id: string; public_id: string }>("INSERT INTO harness.projects(organization_id,name) VALUES($1,'Project') RETURNING id,public_id", [organization])).rows[0]!
      const service = new PostgresModelGovernanceService(context, new OrganizationModelCredentialCipher(Buffer.alloc(32, 17)))
      const subject = { kind: 'project' as const, id: Number(project.public_id) }
      const event = { eventId: randomUUID(), occurredAt: Date.now(), provider: 'runtime-title-fixture', model: 'title-model',
        purpose: 'session-title', sessionId: randomUUID(), credentialSource: 'organization', credentialClass: 'company' as const,
        status: 'succeeded' as const, usage: { inputTokens: 10, outputTokens: 3 } }
      await expect(service.ingest(subject, event)).resolves.toMatchObject({ inserted: true })
      await expect(service.ingest(subject, event)).resolves.toMatchObject({ inserted: false })
      const rows = await pool.query<{ project_id: string; actor_user_id: string | null }>('SELECT project_id,actor_user_id FROM harness.model_usage WHERE organization_id=$1', [organization])
      expect(rows.rows).toEqual([{ project_id: project.id, actor_user_id: null }])
      expect(await service.summary(subject)).toMatchObject({ calls: 1, totalTokens: 13 })
      const contributors = await service.usageContributors(undefined, subject.id)
      expect(contributors.rows).toEqual([])
      expect(contributors.unattributed).toMatchObject({ calls: 1, totalTokens: 13 })
    } finally {
      await removeFixtureOrganization(pool, organization)
    }
  })
})
