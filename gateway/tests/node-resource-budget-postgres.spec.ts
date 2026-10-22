/** Real PostgreSQL reservations across independently owned Runtime generations and Gateway coordinators. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { NodeResourceBudget, type NodeResourceBudgetConfig, type NodeResourceRequest } from '../src/node-resource-budget.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import type { RuntimeCredentialSubject } from '../src/runtime-api.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
if (databaseUrl !== undefined && !/(_test|_accept|_acceptance)(\?.*)?$/.test(databaseUrl)) throw new Error('resource budget tests require a disposable PostgreSQL database')
const describePg = databaseUrl === undefined ? describe.skip : describe
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

describePg('durable node resource budget', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 8 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture(overrides: Partial<NodeResourceBudgetConfig> = {}) {
    const root = await mkdtemp(join(tmpdir(), 'hgw-node-resources-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const slug = 'resources-' + randomUUID()
    const organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Resource budget') RETURNING id", [slug],
    )).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const users: Array<{ uuid: string; id: number }> = []
    for (const name of ['alice', 'bob']) {
      const value = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(organization_id,username,display_name,home_path)
        VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id`, [organizationId, name, root])).rows[0]!
      users.push({ uuid: value.id, id: Number(value.public_id) })
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, value.id])
    }
    const projects: Array<{ uuid: string; id: number }> = []
    for (const name of ['one', 'two']) {
      const value = (await pool.query<{ id: string; public_id: string }>(
        'INSERT INTO harness.projects(organization_id,name) VALUES($1,$2) RETURNING id,public_id', [organizationId, name],
      )).rows[0]!
      projects.push({ uuid: value.id, id: Number(value.public_id) })
      await pool.query('INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path) VALUES($1,$2,$3,$4,$4)',
        [organizationId, value.id, context.nodeId, join(root, name)])
    }
    const repository = new PostgresInstanceRepository(context, 48000)
    await repository.initialize(true)
    await pool.query("UPDATE harness.instances SET observed_state='ready',desired_state='running' WHERE organization_id=$1", [organizationId])
    const config: NodeResourceBudgetConfig = {
      sampleMs: 500, staleMs: 2_000, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
      maxQueued: 16, maxQueuedPerUser: 8,
      maxQueuedPerProject: 8, maxQueuedBytes: 64 * 1024, maxWaitMs: 30_000, ...overrides,
    }
    const budget = new NodeResourceBudget(pool, organizationId, context.nodeId, config)
    const subjects: RuntimeCredentialSubject[] = [
      ...users.map(user => ({ organizationId, target: { kind: 'user' as const, id: user.id }, generation: 1, userInternalId: user.uuid })),
      ...projects.map(project => ({ organizationId, target: { kind: 'project' as const, id: project.id }, generation: 1, projectInternalId: project.uuid })),
    ]
    for (const subject of subjects) await budget.register(subject)
    const request = (subjectIndex: number, sequence: number, actorIndex = subjectIndex < 2 ? subjectIndex : 0, kind: NodeResourceRequest['kind'] = 'model'): NodeResourceRequest => ({
      sequence, kind, actorId: users[actorIndex]!.id, projectId: subjects[subjectIndex]!.target.kind === 'project' ? subjects[subjectIndex]!.target.id : 0,
    })
    return { budget, context, subjects, users, projects, request, config }
  }

  it('keeps one active budget across Runtime processes and a reconstructed Gateway coordinator', async () => {
    const f = await fixture()
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'active' })
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'queued' })
    const restarted = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, f.config)
    expect((await restarted.snapshot()).kinds.model).toMatchObject({ active: 1, queued: 1 })
    await restarted.finish(f.subjects[0]!, 1, 'uncertain')
    expect((await restarted.snapshot()).kinds.model).toMatchObject({ active: 1, uncertain: 1, queued: 1 })
    expect(await restarted.status(f.subjects[1]!, 1)).toEqual({ state: 'queued' })
    await f.budget.finish(f.subjects[0]!, 1, 'quiescent')
    expect(await restarted.status(f.subjects[1]!, 1)).toEqual({ state: 'active' })
  })

  it('rotates users before projects, so extra projects cannot buy another user turn', async () => {
    const f = await fixture()
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[2]!, f.request(2, 1))
    await f.budget.request(f.subjects[3]!, f.request(3, 1))
    await f.budget.request(f.subjects[1]!, f.request(1, 1))
    await f.budget.request(f.subjects[2]!, f.request(2, 2))
    await f.budget.finish(f.subjects[0]!, 1, 'quiescent')
    expect(await f.budget.status(f.subjects[2]!, 1)).toEqual({ state: 'active' })
    await f.budget.finish(f.subjects[2]!, 1, 'quiescent')
    expect(await f.budget.status(f.subjects[1]!, 1)).toEqual({ state: 'active' })
    await f.budget.finish(f.subjects[1]!, 1, 'quiescent')
    expect(await f.budget.status(f.subjects[3]!, 1)).toEqual({ state: 'active' })
    expect(await f.budget.status(f.subjects[2]!, 2)).toEqual({ state: 'queued' })
  })

  it('fences delayed registrations after cancellation without retaining completed rows', async () => {
    const f = await fixture()
    await f.budget.finish(f.subjects[0]!, 1, 'not-started')
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'closed' })
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 2))).toEqual({ state: 'active' })
    await f.budget.finish(f.subjects[0]!, 2, 'quiescent')
    await f.budget.finish(f.subjects[0]!, 2, 'quiescent')
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 2))).toEqual({ state: 'closed' })
    expect((await f.budget.snapshot()).kinds.model.active).toBe(0)
  })

  it('replays one request and rejects changed metadata or a skipped sequence', async () => {
    const f = await fixture()
    const request = f.request(0, 1)
    await f.budget.request(f.subjects[0]!, request)
    expect(await f.budget.request(f.subjects[0]!, request)).toEqual({ state: 'active' })
    await expect(f.budget.request(f.subjects[0]!, { ...request, kind: 'process' })).rejects.toMatchObject({ status: 409 })
    await expect(f.budget.request(f.subjects[0]!, f.request(0, 3))).rejects.toMatchObject({ status: 409 })
    expect((await f.budget.snapshot()).outcomes.admitted).toBe(1)
  })

  it('bounds retained requests and consumes refused sequences without permitting a replay', async () => {
    const f = await fixture({ maxQueued: 1, maxQueuedPerUser: 1, maxQueuedPerProject: 1 })
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[0]!, f.request(0, 2))
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'refused', reason: 'queue-full' })
    await f.budget.finish(f.subjects[0]!, 1, 'quiescent')
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 1))).toEqual({ state: 'closed' })
    expect(await f.budget.request(f.subjects[1]!, f.request(1, 2))).toEqual({ state: 'queued' })
  })

  it('counts complete UTF-8 request metadata against the waiting byte limit', async () => {
    const f = await fixture({ maxQueuedBytes: 1 })
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    expect(await f.budget.request(f.subjects[1]!, { ...f.request(1, 1), sessionId: '多字节' })).toEqual({ state: 'refused', reason: 'queue-bytes' })
    expect((await f.budget.snapshot()).kinds.model.queuedBytes).toBe(0)
  })

  it('expires only waiting work, retaining an active reservation beyond its former deadline', async () => {
    const f = await fixture()
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[1]!, f.request(1, 1))
    await pool.query("UPDATE harness.node_resource_requests SET deadline='-infinity' WHERE organization_id=$1", [f.context.organizationId])
    expect(await f.budget.status(f.subjects[1]!, 1)).toEqual({ state: 'closed' })
    expect(await f.budget.status(f.subjects[0]!, 1)).toEqual({ state: 'active' })
    expect((await f.budget.snapshot()).outcomes.timed_out).toBe(1)
  })

  it('blocks new reservations while an existing Runtime has no accounting provider', async () => {
    const f = await fixture()
    await pool.query("DELETE FROM harness.node_resource_runtimes WHERE organization_id=$1 AND runtime_kind='user' AND runtime_public_id=$2", [f.context.organizationId, f.subjects[1]!.target.id])
    expect(await f.budget.request(f.subjects[0]!, f.request(0, 1))).toEqual({ state: 'queued' })
    expect((await f.budget.snapshot()).unregisteredRuntimes).toBe(1)
    await f.budget.register(f.subjects[1]!)
    expect(await f.budget.status(f.subjects[0]!, 1)).toEqual({ state: 'active' })
  })

  it('reclaims only a confirmed stopped generation and refuses stale late requests', async () => {
    const f = await fixture()
    await f.budget.request(f.subjects[0]!, f.request(0, 1))
    await f.budget.request(f.subjects[1]!, f.request(1, 1))
    await pool.query("UPDATE harness.instances SET observed_state='stopped' WHERE organization_id=$1 AND user_id=$2", [f.context.organizationId, f.users[0]!.uuid])
    await f.budget.stopped(f.subjects[0]!.target, 1)
    expect(await f.budget.status(f.subjects[1]!, 1)).toEqual({ state: 'active' })
    await expect(f.budget.request(f.subjects[0]!, f.request(0, 2))).rejects.toMatchObject({ status: 409 })
  })

  it('holds the same active ceiling through concurrent Gateway coordinators', async () => {
    const f = await fixture({ maxQueuedPerUser: 2, maxQueuedPerProject: 2 })
    const other = new NodeResourceBudget(pool, f.context.organizationId, f.context.nodeId, f.config)
    const offered = await Promise.all(f.subjects.map((subject, index) => (index % 2 ? other : f.budget).request(subject, f.request(index, 1))))
    expect(offered.filter(item => item.state === 'active')).toHaveLength(2)
    expect(offered.filter(item => item.state === 'queued')).toHaveLength(2)
    expect((await f.budget.snapshot()).kinds.model).toMatchObject({ active: 2, queued: 2 })
  })
})
