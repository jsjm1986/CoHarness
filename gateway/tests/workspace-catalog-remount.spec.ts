/** Actual PostgreSQL ordering across scoped Workspace publisher replacement. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { GatewayRuntime } from '../../packages/context/gateway-runtime/src/index.ts'
import { publishWorkspaceCatalog } from '../../packages/context/gateway-runtime/src/workspace-catalog.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { PostgresWorkspaceCatalog } from '../src/workspace-catalog.ts'
import { enableFixtureTopology } from './fixtures/topology-fixture.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('Workspace catalog publisher remounts', () => {
  let pool: Pool
  const releases: (() => Promise<unknown>)[] = []
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 3 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    const failures: unknown[] = []
    for (const release of releases.splice(0).reverse()) {
      try { await release() } catch (error: unknown) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Workspace publication fixture cleanup failed')
  })
  afterAll(async () => { await pool?.end() })

  it('keeps the replacement metadata and refuses another account and stale generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-workspace-remount-'))
    releases.push(() => rm(root, { recursive: true, force: true }))
    const slug = `workspace-remount-${randomUUID()}`
    const organization = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Workspace remount') RETURNING id", [slug],
    )).rows[0]!.id
    releases.push(() => removeFixtureOrganization(pool, organization))
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'workspace-host')", [organization])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'workspace-host')
    await enableFixtureTopology(context)
    const users = new PostgresUserService(context, testConfig(root))
    const alice = await users.create({ username: 'alice', password: 'pw-12345678' })
    const bob = await users.create({ username: 'bob', password: 'pw-12345678' })
    const instance = (await pool.query<{ runtime_id: RuntimeId; generation: string }>(`SELECT i.runtime_id,i.generation::text
      FROM harness.instances i JOIN harness.users u ON u.id=i.user_id AND u.organization_id=i.organization_id
      WHERE i.organization_id=$1 AND u.public_id=$2`, [organization, alice.id])).rows[0]!
    const subject: RuntimeCredentialSubject = { organizationId: organization,
      target: { kind: 'user', id: alice.id, runtimeId: instance.runtime_id }, generation: Number(instance.generation) }
    const catalog = new PostgresWorkspaceCatalog(context), ctx = new Context()
    releases.push(() => ctx.fiber.dispose())
    let title = 'Before remount'
    ctx.provide('workspaceRegistry', { list: () => [{ id: 'workspace', path: root, title, sessionIds: [],
      createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' }] } as never)
    const completions: Promise<void>[] = []
    const request = async (_path: string, init: RequestInit): Promise<Response> => {
      const commit = catalog.publish(subject, JSON.parse(init.body as string) as unknown)
      completions.push(commit)
      await commit
      return Response.json({ synchronized: true })
    }
    const mount = () => ctx.inject(['workspaceRegistry'], scope => { publishWorkspaceCatalog(scope, { request } as GatewayRuntime, 1000,
      async () => [{ sessionId: 'ungrouped-personal-root', cwd: root, updatedAt: 1, blank: false, running: false,
        projections: { asOfSeq: 1, values: { title } } }] as never) })
    const original = mount()
    await original.await()
    await Promise.all(completions)
    expect((await catalog.personal(alice))[0]?.items[0]?.title).toBe('Before remount')
    expect((await catalog.personal(alice))[0]?.conversations?.[0]?.title).toBe('Before remount')
    await original.dispose()
    title = 'After remount'
    const replacement = mount()
    await replacement.await()
    await Promise.all(completions)
    expect((await catalog.personal(alice))[0]?.items[0]?.title).toBe('After remount')
    expect((await catalog.personal(alice))[0]?.conversations?.[0]?.sessionId).toBe('ungrouped-personal-root')
    expect((await catalog.personal(bob)).flatMap(item => item.items)).toEqual([])
    await catalog.publish(subject, { revision: 1, items: [] })
    expect((await catalog.personal(alice))[0]?.items).toHaveLength(1)
    await expect(catalog.publish({ ...subject, generation: subject.generation + 1 }, { revision: 3, items: [] }))
      .rejects.toMatchObject({ code: 'forbidden' })
    await pool.query('UPDATE harness.instances SET generation=generation+1 WHERE organization_id=$1 AND runtime_id=$2',
      [organization, instance.runtime_id])
    await catalog.publish({ ...subject, generation: subject.generation + 1 }, { revision: 1, items: [] })
    expect((await catalog.personal(alice))[0]?.items).toEqual([])
    await expect(catalog.publish(subject, { revision: 4, items: [] })).rejects.toMatchObject({ code: 'forbidden' })
  })
})
