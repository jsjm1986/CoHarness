/** Node-scoped process reservations restored from real PostgreSQL assignments. @module */
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { InstanceManager, INSTANCE_PROFILE, type RuntimeTarget } from '../src/instances.ts'
import { computeLaunchStamps } from '../src/launch-stamp.ts'
import type { UserRow } from '../src/auth.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { testConfig } from './test-config.ts'
import { LocalLauncher } from '../src/launcher.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

/** A launch stamp the fence accepts under this config; variants differ but membership is what `liveEndpoint` checks. */
const mintedLaunchStamp = (cfg: Parameters<typeof computeLaunchStamps>[0]): string =>
  [...computeLaunchStamps(cfg, '', INSTANCE_PROFILE).stamps][0]!

describePg('PostgreSQL Runtime capacity restoration', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterAll(async () => { await pool?.end() })

  async function withAssignment(operation: (repository: PostgresInstanceRepository, target: RuntimeTarget, root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), 'hgw-generation-postgres-'))
    const slug = `generation-${randomUUID()}`
    let organizationId: string | undefined
    try {
      organizationId = (await pool.query<{ id: string }>(
        "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Runtime generation') RETURNING id", [slug],
      )).rows[0]!.id
      await pool.query("INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,'local')", [organizationId])
      const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
      const user = (await pool.query<{ id: string; public_id: string }>(`INSERT INTO harness.users(
        organization_id,username,display_name,home_path) VALUES($1,'alice','Alice',$2) RETURNING id,public_id`,
      [organizationId, root])).rows[0]!
      await pool.query("INSERT INTO harness.memberships(organization_id,user_id,role) VALUES($1,$2,'member')", [organizationId, user.id])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
        [organizationId, context.nodeId, user.id])
      const repository = new PostgresInstanceRepository(context, 48000)
      await repository.initialize()
      await operation(repository, { kind: 'user', id: Number(user.public_id) }, root)
    } finally {
      try {
        if (organizationId !== undefined) {
          for (const table of ['instances', 'memberships', 'users', 'outbox', 'compute_nodes']) {
            await pool.query(`DELETE FROM harness.${table} WHERE organization_id=$1`, [organizationId])
          }
          await pool.query('DELETE FROM harness.organizations WHERE id=$1', [organizationId])
        }
      } finally { await rm(root, { recursive: true, force: true }) }
    }
  }

  it('allows only one coordinator to claim a stopped generation', async () => {
    await withAssignment(async (repository, target) => {
      const starts = await Promise.allSettled([
        repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit'),
        repository.beginStart(target, Date.now(), Buffer.alloc(32, 2), 'explicit'),
      ])
      expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      const started = starts.find(result => result.status === 'fulfilled')
      expect(await repository.generationOf(target)).toBe(started?.value)
    })
  })

  it('keeps a live local assignment during coordinator initialization', async () => {
    await withAssignment(async (repository, target, root) => {
      const generation = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit')
      await repository.markReady(target, generation)
      let stops = 0
      const manager = new InstanceManager(repository, testConfig(root), {
        instancesOutliveGateway: false,
        start: async () => { throw new Error('initialization must not launch') },
        attach: () => ({ hasExited: () => false, terminate: async () => { stops += 1 } }),
      })
      try {
        expect(await manager.stateOf(target)).toBe('ready')
        expect(await repository.generationOf(target)).toBe(generation)
        expect(await repository.credentialHashOf(target, generation)).toBe(Buffer.alloc(32, 1).toString('hex'))
        expect(manager.capacitySnapshot().resident).toBe(1)
        await expect(repository.beginStart(target, Date.now(), Buffer.alloc(32, 2), 'explicit'))
          .rejects.toThrow()
        await manager.stop(target)
        expect(stops).toBe(1)
        expect(await repository.stateOf(target)).toBe('stopped')
      } finally { await manager.stopAll() }
    })
  })

  it('retains local survivor occupation when a new coordinator cannot confirm termination', async () => {
    await withAssignment(async (repository, target, root) => {
      const generation = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit')
      await repository.markReady(target, generation)
      const manager = new InstanceManager(repository, testConfig(root), {
        instancesOutliveGateway: false,
        start: async () => { throw new Error('an unowned survivor cannot be replaced') },
      })
      try {
        expect(await manager.stateOf(target)).toBe('ready')
        await expect(manager.stop(target)).rejects.toThrow('termination cannot be confirmed')
        expect(manager.capacitySnapshot().resident).toBe(1)
        expect(await repository.stateOf(target)).toBe('stopping')
        expect(await repository.generationOf(target)).toBe(generation)
        await expect(repository.beginStart(target, Date.now(), Buffer.alloc(32, 2), 'explicit'))
          .rejects.toThrow()
      } finally { await expect(manager.stopAll()).rejects.toThrow('termination cannot be confirmed') }
    })
  })

  it.skipIf(process.platform === 'win32')('recovers a real local runtime from PostgreSQL and reclaims resources only after physical stop', async () => {
    await withAssignment(async (repository, target, root) => {
      const credential = Buffer.alloc(32, 0xaa)
      const cfg = testConfig(root)
      cfg.dshRepoRoot = fileURLToPath(new URL('../../', import.meta.url))
      cfg.dshCommand = [process.execPath, fileURLToPath(new URL('./fixtures/local-runtime-server.mjs', import.meta.url)), join(root, 'ready.json')]
      const generation = await repository.beginStart(target, Date.now(), credential, 'explicit', undefined, undefined, mintedLaunchStamp(cfg))
      const runtime = { kind: 'user' as const, ownerId: target.id, username: 'alice', runtimeKey: 'alice', systemUser: 'harness-alice',
        port: await repository.portOf(target), homePath: root, dshHome: join(cfg.usersRoot, 'alice', 'dsh'), generation,
        credentialHash: credential.toString('hex'), gatewayCredential: '{"fixture":true}' }
      const handle = await new LocalLauncher(cfg).start(runtime)
      let manager: InstanceManager | undefined
      try {
        let pid = 0
        await vi.waitFor(async () => { pid = (JSON.parse(await readFile(join(root, 'ready.json'), 'utf8')) as { pid: number }).pid; expect(pid).toBeGreaterThan(0) })
        await repository.markReady(target, generation)
        const reclaims: Array<{ generation: number; registration: 'remove' | 'retain' }> = []
        manager = new InstanceManager(repository, cfg, new LocalLauncher(cfg), { principalPublicKey: '' }, {
          registered: async () => true, admitRuntimeStart: async () => {},
          stopped: async (_target, stoppedGeneration, registration = 'remove') => {
            expect(() => process.kill(pid, 0)).toThrow(); reclaims.push({ generation: stoppedGeneration, registration })
          },
        })
        expect(await manager.isLive(target)).toBe(true)
        expect(manager.capacitySnapshot().resident).toBe(1)
        expect(await repository.generationOf(target)).toBe(generation)
        await manager.stopAll()
        expect(reclaims).toEqual([{ generation, registration: 'retain' }, { generation, registration: 'remove' }])
        expect(manager.capacitySnapshot().resident).toBe(0)
        expect(await repository.stateOf(target)).toBe('stopped')
      } finally { await manager?.stopAll(); await handle.terminate(0) }
    })
  })

  it('keeps a replacement ready when an older coordinator finishes stopping its captured process', async () => {
    await withAssignment(async (repository, target, root) => {
      const first = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit')
      expect(await repository.credentialHashOf(target, first)).toBe(Buffer.alloc(32, 1).toString('hex'))
      await repository.markReady(target, first)
      let confirmOldStop!: () => void
      let oldStopEntered!: () => void
      const oldStopped = new Promise<void>(resolve => { confirmOldStop = resolve })
      const stoppingOld = new Promise<void>(resolve => { oldStopEntered = resolve })
      const cfg = testConfig(root)
      const oldManager = new InstanceManager(repository, cfg, {
        instancesOutliveGateway: true,
        start: async () => { throw new Error('stop fixture never launches') },
        attach: () => ({ hasExited: () => false, terminate: async () => { oldStopEntered(); await oldStopped } }),
      })
      const replacementManager = new InstanceManager(repository, cfg, {
        instancesOutliveGateway: true,
        start: async () => { throw new Error('stop fixture never launches') },
        attach: () => ({ hasExited: () => false, terminate: async () => {} }),
      })
      const oldStop = oldManager.stop(target)
      try {
        await stoppingOld
        await replacementManager.stop(target)
        const second = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 2), 'explicit')
        expect(await repository.credentialHashOf(target, second)).toBe(Buffer.alloc(32, 2).toString('hex'))
        await expect(repository.credentialHashOf(target, first)).rejects.toThrow('stale instance generation')
        await repository.markReady(target, second)
        confirmOldStop()
        await oldStop
        expect(await replacementManager.stateOf(target)).toBe('ready')
        expect(await repository.generationOf(target)).toBe(second)
      } finally {
        confirmOldStop()
        await oldStop
        await Promise.all([oldManager.stopAll(), replacementManager.stopAll()])
      }
    })
  })

  it('stops the current assignment after cleaning a locally retained predecessor handle', async () => {
    await withAssignment(async (repository, target, root) => {
      const cfg = testConfig(root)
      const stamp = mintedLaunchStamp(cfg)
      const first = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 1), 'explicit', undefined, undefined, stamp)
      await repository.markReady(target, first)
      const stopped: number[] = []
      const oldManager = new InstanceManager(repository, cfg, {
        instancesOutliveGateway: true,
        start: async () => { throw new Error('stop fixture never launches') },
        attach: runtime => ({
          hasExited: () => false, isAlive: async () => true,
          terminate: async () => { stopped.push(runtime.generation) },
        }),
      })
      try {
        expect(await oldManager.isLive(target)).toBe(true)
        await repository.markStopped(target, first)
        const second = await repository.beginStart(target, Date.now(), Buffer.alloc(32, 2), 'explicit', undefined, undefined, stamp)
        await repository.markReady(target, second)
        await oldManager.stop(target)
        expect(stopped).toEqual([first, second])
        expect(await repository.stateOf(target)).toBe('stopped')
      } finally { await oldManager.stopAll() }
    })
  })

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
        await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
          [organizationId, context.nodeId, row.id])
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
      await repository.initialize()
      for (const state of ['ready', 'starting', 'stopping', 'stopped']) await pool.query(
        'UPDATE harness.instances SET observed_state=$3 WHERE organization_id=$1 AND user_id=$2',
        [organizationId, users.get(state)!.uuid, state],
      )
      await pool.query("UPDATE harness.instances SET observed_state='ready' WHERE organization_id=$1 AND project_id=$2", [organizationId, project.id])
      const remoteHome = join(root, 'remote-home')
      await mkdir(remoteHome)
      await pool.query('INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4)',
        [organizationId, remote, users.get('remote')!.uuid, remoteHome])
      await pool.query('INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled) VALUES($1,$2,$3,true)',
        [organizationId, remote, users.get('remote')!.uuid])
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
      await pool.query('UPDATE harness.instances SET launch_stamp=$1 WHERE organization_id=$2', [mintedLaunchStamp(cfg), organizationId])
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
