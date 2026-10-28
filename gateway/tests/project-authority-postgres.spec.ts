/** Fresh project management/theme reads without materializing member rosters. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool, QueryResultRow } from 'pg'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { InstanceManager } from '../src/instances.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { createPostgresPool, runMigrations, type Queryable } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createGatewayServer, SESSION_COOKIE } from '../src/server.ts'
import { testConfig } from './test-config.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
if (databaseUrl !== undefined && !/(_test|_accept|_acceptance)(\?.*)?$/.test(databaseUrl)) {
  throw new Error('HGW_TEST_DATABASE_URL must select a disposable test database ending in _test, _accept, or _acceptance')
}
const describePg = databaseUrl === undefined ? describe.skip : describe
const roles = ['owner', 'writer', 'reader', 'administrator', 'outsider'] as const
type Role = typeof roles[number]

describePg('fresh PostgreSQL project authority', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 2 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function fixture(memberCount = 4) {
    const root = await mkdtemp(join(tmpdir(), 'hgw-project-authority-'))
    const slug = 'authority-' + randomUUID()
    let organizationId: string | undefined
    let server: ReturnType<typeof createGatewayServer> | undefined
    let instances: InstanceManager | undefined
    onTestFinished(async () => {
      vi.restoreAllMocks()
      try {
        if (server?.listening) {
          const closed = new Promise<void>((ready, reject) => server!.close(error => error ? reject(error) : ready()))
          server.closeAllConnections()
          await closed
        }
        await instances?.stopAll()
        if (organizationId !== undefined) {
          for (const table of ['instances', 'project_members', 'project_mounts', 'projects', 'auth_sessions',
            'memberships', 'users', 'compute_nodes', 'outbox']) {
            await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
          }
          await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    })
    organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Authority fixture') RETURNING id", [slug],
    )).rows[0]!.id
    await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const actors = {} as Record<Role, { id: string; publicId: number; token: string }>
    for (const role of roles) {
      const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
        organization_id,username,display_name,home_path) VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id::text`,
      [organizationId, role, join(root, role)])).rows[0]!
      const token = randomUUID()
      actors[role] = { id: row.id, publicId: Number(row.public_id), token }
      await pool.query('INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,$3)',
        [organizationId, row.id, role === 'administrator' ? 'admin' : 'member'])
      await pool.query("INSERT INTO harness.password_credentials(user_id,password_hash,must_change_password) VALUES($1,'unused',false)", [row.id])
      await pool.query(`INSERT INTO harness.auth_sessions(organization_id,user_id,token_hash,created_at,expires_at,absolute_expires_at,last_seen_at)
        VALUES($1,$2,$3,now(),now()+interval '1 hour',now()+interval '2 hours',now())`,
      [organizationId, row.id, createHash('sha256').update(token).digest()])
    }
    const project = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.projects(
      organization_id,name,created_by,owner_user_id,origin) VALUES($1,'Owned',$2,$2,'user') RETURNING id,public_id::text`,
    [organizationId, actors.owner.id])).rows[0]!
    await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
      VALUES($1,$2,$3,$4,$4)`, [organizationId, project.id, context.nodeId, root])
    for (const role of ['owner', 'writer', 'reader'] as const) {
      await pool.query('INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) VALUES($1,$2,$3,$4)',
        [organizationId, project.id, actors[role].id, role === 'reader' ? 'ro' : 'rw'])
    }
    if (memberCount > 3) await pool.query(`WITH created AS (
      INSERT INTO harness.users(organization_id,username,display_name,home_path)
      SELECT $1,('synthetic-'||n::text)::citext,'Synthetic Member','/synthetic' FROM generate_series(1,$3::integer) n RETURNING id
    ) INSERT INTO harness.project_members(organization_id,project_id,user_id,access_mode) SELECT $1,$2,id,'ro' FROM created`,
    [organizationId, project.id, memberCount - 3])
    const cfg = testConfig(root)
    const projects = new PostgresProjectService(context, cfg)
    const collaboration = new PostgresCollaborationService(context)
    instances = new InstanceManager(new PostgresInstanceRepository(context, cfg.instancePortBase), cfg)
    await instances.stateOf({ kind: 'project', id: Number(project.public_id) })
    server = createGatewayServer({ cfg, projects, collaboration, instances,
      auth: new PostgresAuthService(context, cfg), users: new PostgresUserService(context, cfg), audit: new PostgresAuditService(context),
    }, { proxy: async (_req, response, request) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(request.scope))
    } })
    await new Promise<void>((ready, reject) => {
      const failed = (error: Error): void => { reject(error) }
      server!.once('error', failed)
      server!.listen(0, '127.0.0.1', () => { server!.off('error', failed); ready() })
    })
    const base = 'http://127.0.0.1:' + String((server.address() as AddressInfo).port)
    cfg.publicOrigins.push(base)
    const publicId = Number(project.public_id)
    const request = (role: Role, cookieScope = false) => fetch(base + '/api/authority-probe'
      + (cookieScope ? '' : '?dshTarget=project:' + String(publicId)), {
      headers: { cookie: `${SESSION_COOKIE}=${actors[role].token}` + (cookieScope ? `; hgw_scope=project:${String(publicId)}` : '') },
    })
    return { organizationId, actors, project, publicId, root, projects, collaboration, request }
  }

  it.each([4, 300])('constructs a %i-member project scope with one authority SELECT and no roster read', async members => {
    const f = await fixture(members)
    const detail = vi.spyOn(f.projects, 'getById').mockRejectedValue(new Error('Full project detail is not authority metadata'))
    const queryable: Queryable = pool
    const query: Queryable['query'] = queryable.query.bind(queryable)
    let projectSelects = 0
    let memberRows = 0
    const projectStatements: string[] = []
    vi.spyOn(queryable, 'query').mockImplementation(async <R extends QueryResultRow>(text: string, values?: readonly unknown[]) => {
      const result = await query<R>(text, values)
      if (text.includes('JOIN harness.projects p') || text.includes('FROM harness.projects p') || text.includes('FROM harness.project_members m')) {
        projectSelects++
        projectStatements.push(text)
      }
      if (text.includes('SELECT m.project_id::text project_id')) memberRows += result.rows.length
      return result
    })
    const response = await f.request('owner')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ kind: 'project', projectId: f.publicId, projectName: 'Owned', mode: 'rw',
      canManage: true, uiThemePolicy: 'follow-user' })
    expect(projectSelects, projectStatements.join('\n')).toBe(1)
    expect(memberRows).toBe(0)
    expect(detail).not.toHaveBeenCalled()
  })

  it.each(['follow-user', 'light', 'dark'] as const)('publishes fresh %s theme and the same owner/member/administrator authority', async policy => {
    const f = await fixture()
    await f.projects.setThemePolicy(f.publicId, policy)
    const cases = [
      ['owner', 'rw', true], ['writer', 'rw', false], ['reader', 'ro', false], ['administrator', 'rw', true],
    ] as const
    for (const [role, mode, canManage] of cases) {
      expect(await f.collaboration.projectForUser(f.publicId, f.actors[role].publicId)).toMatchObject({ mode, canManage, uiThemePolicy: policy })
      for (const cookieScope of [false, true]) {
        const response = await f.request(role, cookieScope)
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ kind: 'project', projectId: f.publicId, projectName: 'Owned', mode, canManage, uiThemePolicy: policy })
      }
    }
    expect(await f.collaboration.projectForUser(f.publicId, f.actors.outsider.publicId)).toBeNull()
    const denied = await f.request('outsider')
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: 'not-member' })
  })

  it('reflects owner transfer, membership loss and administrator downgrade on the next authority read', async () => {
    const f = await fixture()
    await pool.query('UPDATE harness.projects SET owner_user_id=$2 WHERE id=$1', [f.project.id, f.actors.writer.id])
    expect(await f.collaboration.projectForUser(f.publicId, f.actors.owner.publicId)).toMatchObject({ mode: 'rw', canManage: false })
    expect(await f.collaboration.projectForUser(f.publicId, f.actors.writer.publicId)).toMatchObject({ mode: 'rw', canManage: true })
    expect(await f.collaboration.projectForUser(f.publicId, f.actors.administrator.publicId)).toMatchObject({ administrator: true, canManage: true })
    await pool.query('DELETE FROM harness.project_members WHERE project_id=$1 AND user_id=$2', [f.project.id, f.actors.writer.id])
    expect(await f.collaboration.projectForUser(f.publicId, f.actors.writer.publicId)).toBeNull()
    await pool.query("UPDATE harness.memberships SET role='member' WHERE organization_id=$1 AND user_id=$2", [f.organizationId, f.actors.administrator.id])
    expect(await f.collaboration.projectForUser(f.publicId, f.actors.administrator.publicId)).toBeNull()
    await pool.query("UPDATE harness.project_mounts SET status='missing' WHERE project_id=$1", [f.project.id])
    expect(await f.collaboration.projectForUser(f.publicId, f.actors.owner.publicId)).toBeNull()
  })

  it('keeps internal management and theme fields out of the existing project roster projection', async () => {
    const f = await fixture()
    const list = await f.collaboration.projectsForUser(f.actors.owner.publicId)
    expect(list).toEqual([{ projectId: f.publicId, name: 'Owned', path: f.root, mode: 'rw', kind: 'standard' }])
  })
})
