/** Real project transactions, directory ownership, and bounded connection use. */
import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Pool, QueryResultRow } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { InstanceManager } from '../src/instances.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { connectFromPool, createPostgresPool, runMigrations, type Queryable } from '../src/postgres/database.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { testConfig } from './test-config.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
if (databaseUrl !== undefined && !/(_test|_accept|_acceptance)(\?.*)?$/.test(databaseUrl)) {
  throw new Error('HGW_TEST_DATABASE_URL must select a disposable test database ending in _test, _accept, or _acceptance')
}
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL project creation and mutations', () => {
  let pool: Pool
  const roots: string[] = []
  const scopedPools: Pool[] = []

  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!)
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(scopedPools.splice(0).map(scoped => scoped.end()))
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-project-transactions-'))
    roots.push(root)
    const slug = `projects-${randomUUID()}`
    const organization = await pool.query<{ id: string }>(`INSERT INTO harness.organizations(slug,display_name)
      VALUES($1,'Project transactions') RETURNING id`, [slug])
    await pool.query(`INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'test-node')`, [organization.rows[0]!.id])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'test-node')
    const people: number[] = []
    for (const username of ['creator', 'member']) {
      const user = await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
        organization_id,username,display_name,home_path
      ) VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id::text`, [context.organizationId, username, join(root, 'users', username, 'home')])
      await pool.query(`INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'admin')`,
        [context.organizationId, user.rows[0]!.id])
      people.push(Number(user.rows[0]!.public_id))
    }
    const imports = join(root, 'imports')
    await mkdir(imports)
    const cfg = testConfig(root, { HGW_PROJECT_PATH_ROOTS: imports })
    return { root, imports, cfg, context, creator: people[0]!, member: people[1]!, service: new PostgresProjectService(context, cfg) }
  }

  it('preserves committed project files when the response detail cannot be read', async () => {
    const { context, creator, service } = await fixture()
    vi.spyOn(service, 'getById').mockImplementation(async (id) => {
      const mounted = await pool.query<{ local_path: string }>(`SELECT pm.local_path
        FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id
        WHERE p.organization_id=$1 AND p.public_id=$2`, [context.organizationId, id])
      await writeFile(join(mounted.rows[0]!.local_path, 'committed.txt'), 'committed project content')
      throw new Error('post-commit-detail-unavailable')
    })
    await expect(service.createManaged({ name: 'Committed', ownerUserId: creator })).rejects.toThrow('post-commit-detail-unavailable')
    const mounted = await pool.query<{ local_path: string }>(`SELECT pm.local_path
      FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id
      WHERE p.organization_id=$1 AND p.name='Committed'`, [context.organizationId])
    expect(mounted.rowCount).toBe(1)
    expect(await readFile(join(mounted.rows[0]!.local_path, 'committed.txt'), 'utf8')).toBe('committed project content')
  })

  it('removes only the new managed directory when an insert rolls back', async () => {
    const { cfg, context, creator, service } = await fixture()
    const retained = await service.createManaged({ name: 'Retained', ownerUserId: creator })
    await writeFile(join(retained.path, 'retained.txt'), 'retained')
    await expect(service.createManaged({ name: 'Retained', ownerUserId: creator })).rejects.toThrow('duplicate project name')
    expect(await readdir(cfg.userProjectsRoot)).toEqual([basename(retained.path)])
    expect(await readFile(join(retained.path, 'retained.txt'), 'utf8')).toBe('retained')
    const projects = await pool.query('SELECT id FROM harness.projects WHERE organization_id=$1', [context.organizationId])
    expect(projects.rowCount).toBe(1)
  })

  it('preserves project files when the commit succeeds without an acknowledgement', async () => {
    const { cfg, context, creator } = await fixture()
    const faultPool = createPostgresPool(databaseUrl!, { max: 1 })
    scopedPools.push(faultPool)
    const failure = new Error('commit-acknowledgement-unavailable')
    faultPool.on('connect', (client) => {
      const queryable: Queryable = client
      const query: Queryable['query'] = queryable.query.bind(queryable)
      vi.spyOn(queryable, 'query').mockImplementation(async <R extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
        const result = await query<R>(text, values)
        if (text === 'COMMIT') {
          const [directory] = await readdir(cfg.userProjectsRoot)
          await writeFile(join(cfg.userProjectsRoot, directory!, 'committed.txt'), 'committed without acknowledgement')
          throw failure
        }
        return result
      })
    })
    const service = new PostgresProjectService({ ...context, pool: faultPool }, cfg)
    await expect(service.createManaged({ name: 'Unacknowledged', ownerUserId: creator })).rejects.toBe(failure)
    const mounted = await pool.query<{ local_path: string }>(`SELECT pm.local_path
      FROM harness.project_mounts pm JOIN harness.projects p ON p.id=pm.project_id
      WHERE p.organization_id=$1 AND p.name='Unacknowledged'`, [context.organizationId])
    expect(mounted.rowCount).toBe(1)
    expect(await readFile(join(mounted.rows[0]!.local_path, 'committed.txt'), 'utf8')).toBe('committed without acknowledgement')
  })

  it('serializes overlapping directory imports before checking existing mounts', async () => {
    const { cfg, context, imports } = await fixture()
    await mkdir(join(imports, 'parent', 'child'), { recursive: true })
    const applicationName = `project-race-${randomUUID()}`
    const racingPool = createPostgresPool(databaseUrl!, { max: 2, application_name: applicationName, lock_timeout: 15_000 })
    scopedPools.push(racingPool)
    const service = new PostgresProjectService({ ...context, pool: racingPool }, cfg)
    const users = new PostgresUserService(context, cfg)
    const administrator = await users.create({ username: 'api-admin', password: 'pw-12345678', role: 'admin' })
    await users.changeOwnPassword(administrator.id, 'pw-12345678')
    const deps: GatewayDeps = { cfg, users, projects: service,
      auth: new PostgresAuthService(context, cfg), audit: new PostgresAuditService(context),
      instances: new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg) }
    await deps.instances.stateOf({ kind: 'user', id: administrator.id })
    const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
    try {
      await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
      const base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
      cfg.publicOrigins.push(base)
      const login = await fetch(`${base}/login`, {
        method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'api-admin', password: 'pw-12345678' }),
      })
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
      expect(cookie).not.toBe('')
      await login.body?.cancel()
      const blocker = await connectFromPool(pool)
      const lock = `gateway-port:${context.nodeId}`
      await blocker.query('SELECT pg_advisory_lock(hashtext($1))', [lock])
      const requests = Promise.all(['parent', 'parent/child'].map(async (path) => {
        const response = await fetch(`${base}/admin/api/projects`, {
          method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' },
          body: JSON.stringify({ name: path === 'parent' ? 'Parent' : 'Child', path: resolve(imports, path) }),
        })
        return { status: response.status, body: await response.json() as { error?: string } }
      }))
      void requests.catch(() => {})
      try {
        // Both HTTP requests must reach the node lock before either can publish a mount.
        await expect.poll(async () => {
          const waiting = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM pg_locks l
            JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.datname=current_database()
            AND a.application_name=$1 AND l.locktype='advisory' AND NOT l.granted`, [applicationName])
          return Number(waiting.rows[0]!.n)
        }, { timeout: 10_000 }).toBe(2)
      } finally {
        try { await blocker.query('SELECT pg_advisory_unlock(hashtext($1))', [lock]) }
        finally { blocker.release(); await requests }
      }
      const responses = await requests
      expect(responses.map(response => response.status).sort()).toEqual([200, 409])
      const rejected = responses.find(response => response.status === 409)
      expect(rejected?.body).toMatchObject({ error: 'project-path-overlap' })
      const mounts = await pool.query<{ canonical_path: string }>('SELECT canonical_path FROM harness.project_mounts WHERE organization_id=$1', [context.organizationId])
      expect(mounts.rows).toHaveLength(1)
      expect([await realpath(join(imports, 'parent')), await realpath(join(imports, 'parent', 'child'))]).toContain(mounts.rows[0]!.canonical_path)
      const transcript = ['# Concurrent administrator project imports', '',
        `accepted=${String(responses.filter(response => response.status === 200).length)}`,
        `rejected=${String(responses.filter(response => response.status === 409).length)}`,
        `rejectionStatus=${String(rejected?.status)}`, `error=${rejected?.body.error ?? '<none>'}`,
        `registeredMounts=${String(mounts.rowCount)}`, '',
      ].join('\n')
      await expect(transcript).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/project-transactions/concurrent-import.expected.md'))
    } finally {
      await new Promise<void>(closed => server.close(() => { closed() }))
      await deps.instances.stopAll()
    }
  })

  it.each(['setMember', 'removeMember', 'remove'] as const)('runs %s with one transaction connection', async (operation) => {
    const { cfg, context, creator, member, service } = await fixture()
    const project = await service.createManaged({ name: 'One connection', ownerUserId: creator })
    await service.setMember(project.id, member, 'ro')
    const limitedPool = createPostgresPool(databaseUrl!, { max: 1, connectionTimeoutMillis: 1_000 })
    scopedPools.push(limitedPool)
    const limited = new PostgresProjectService({ ...context, pool: limitedPool }, cfg)
    if (operation === 'setMember') {
      await limited.setMember(project.id, member, 'rw')
      expect((await service.getById(project.id))?.members.find(row => row.userId === member)?.mode).toBe('rw')
    } else if (operation === 'removeMember') {
      await limited.removeMember(project.id, member)
      expect((await service.getById(project.id))?.members.some(row => row.userId === member)).toBe(false)
    } else {
      expect(await limited.remove(project.id)).toContain(member)
      expect(await service.getById(project.id)).toBeNull()
    }
    expect(await readdir(project.path)).toEqual([])
  })
})
