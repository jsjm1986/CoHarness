/** Node-scoped process reservations restored from real PostgreSQL assignments. @module */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { InstanceManager, type RuntimeTarget } from '../src/instances.ts'
import type { UserRow } from '../src/auth.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { testConfig } from './test-config.ts'

const databaseUrl = process.env.HGW_TEST_DATABASE_URL
if (databaseUrl !== undefined && !/(_test|_accept|_acceptance)(\?.*)?$/.test(databaseUrl)) {
  throw new Error('HGW_TEST_DATABASE_URL must select a disposable test database ending in _test, _accept, or _acceptance')
}
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL Runtime capacity restoration', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  it('counts same-node ready and incomplete survivors, excludes stopped and removed assignments, and retains uncertain deleted owners', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hgw-capacity-postgres-'))
    const slug = `capacity-${randomUUID()}`
    let organizationId: string | undefined
    let manager: InstanceManager | undefined
    try {
      organizationId = (await pool.query<{ id: string }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Runtime capacity') RETURNING id", [slug],
      )).rows[0]!.id
      for (const name of ['local', 'remote']) await pool.query(
        'INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name],
      )
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const remote = (await pool.query<{ id: string }>(
        "SELECT id FROM harness.compute_nodes WHERE organization_id=$1 AND name='remote'", [organizationId],
      )).rows[0]!.id
      const users = new Map<string, { uuid: string; user: UserRow }>()
      for (const name of ['ready', 'starting', 'stopping', 'stopped', 'removed', 'remote', 'uncertain-deleted']) {
        const row = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
          organization_id,username,display_name,home_path) VALUES($1,$2::text,$2::text,$3) RETURNING id,public_id`,
        [organizationId, name, root])).rows[0]!
        await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, row.id])
        users.set(name, { uuid: row.id, user: {
          id: Number(row.public_id), username: name, displayName: name, homePath: root,
          status: 'active', role: 'user', mustChangePassword: false, autoReviewEligible: false,
        } })
      }
      const projectDirectory = join(root, 'project')
      await mkdir(projectDirectory)
      const projectPath = await realpath(projectDirectory)
      const project = (await pool.query<{ id: string; public_id: string }>(
        "INSERT INTO harness.projects(organization_id,name) VALUES($1,'Capacity project') RETURNING id,public_id", [organizationId],
      )).rows[0]!
      await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
        VALUES($1,$2,$3,$4,$4)`, [organizationId, project.id, context.nodeId, projectPath])
      const repository = new PostgresInstanceRepository(context, 48000)
      await repository.initialize(true)
      for (const state of ['ready', 'starting', 'stopping', 'stopped']) await pool.query(
        'UPDATE harness.instances SET observed_state=$3 WHERE organization_id=$1 AND user_id=$2',
        [organizationId, users.get(state)!.uuid, state],
      )
      await pool.query("UPDATE harness.instances SET observed_state='ready' WHERE organization_id=$1 AND project_id=$2", [organizationId, project.id])
      await pool.query("UPDATE harness.instances SET assigned_node_id=$3,observed_state='ready' WHERE organization_id=$1 AND user_id=$2",
        [organizationId, users.get('remote')!.uuid, remote])
      await pool.query("UPDATE harness.instances SET observed_state='ready' WHERE organization_id=$1 AND user_id=$2", [organizationId, users.get('uncertain-deleted')!.uuid])
      await pool.query("UPDATE harness.users SET deleted_at=now(),status='disabled' WHERE organization_id=$1 AND id=ANY($2::uuid[])",
        [organizationId, [users.get('removed')!.uuid, users.get('uncertain-deleted')!.uuid]])
      await pool.query('DELETE FROM harness.instances WHERE organization_id=$1 AND user_id=$2', [organizationId, users.get('removed')!.uuid])
      const expected: RuntimeTarget[] = ['ready', 'starting', 'stopping', 'uncertain-deleted']
        .map(name => ({ kind: 'user', id: users.get(name)!.user.id }))
      expected.push({ kind: 'project', id: Number(project.public_id) })
      const key = (target: RuntimeTarget): string => `${target.kind}:${target.id}`
      expect((await repository.activeTargets()).map(key).sort()).toEqual(expected.map(key).sort())

      const cfg = testConfig(root, { HGW_RUNTIME_MAX_STARTING: '1', HGW_RUNTIME_MAX_RESIDENT: '2' })
      manager = new InstanceManager(repository, cfg, {
        instancesOutliveGateway: true,
        attach: () => ({ hasExited: () => false, isAlive: async () => true, terminate: async () => {} }),
        start: async () => { throw new Error('restoration must not launch a process') },
      })
      await manager.stateOf({ kind: 'project', id: Number(project.public_id) })
      expect(manager.capacitySnapshot()).toMatchObject({ resident: 5, starting: 0, queued: 0, admitted: 0 })
      await expect(manager.ensureRunning({ kind: 'project', id: Number(project.public_id), name: 'Capacity project', path: projectPath }))
        .resolves.toHaveProperty('port')
      await expect(manager.ensureRunning(users.get('starting')!.user, 'explicit')).rejects.toMatchObject({ code: 'INSTANCE_UNAVAILABLE' })
      expect(manager.capacitySnapshot()).toMatchObject({ resident: 5, queued: 0, admitted: 0 })
    } finally {
      await manager?.stopAll()
      try {
        if (organizationId !== undefined) {
          for (const table of ['instances', 'project_mounts', 'projects', 'memberships', 'users', 'outbox', 'compute_nodes']) {
            await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
          }
          await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
})
