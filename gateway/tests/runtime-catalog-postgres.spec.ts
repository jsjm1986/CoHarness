/** Environment-directory authorization and bounded real Gateway responses. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { InstanceManager } from '../src/instances.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import type { RuntimeCatalogPage, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import { createGatewayServer, SCOPE_COOKIE } from '../src/server.ts'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const describePg = databaseUrl === undefined ? describe.skip : describe

describePg('PostgreSQL runtime environment directory', () => {
  let pool: Pool
  const releases: Array<() => Promise<void>> = []
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    const failures: unknown[] = []
    for (const release of releases.splice(0).reverse()) {
      try { await release() } catch (error) { failures.push(error) }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime directory fixture cleanup failed')
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-runtime-directory-'))
    releases.push(() => rm(root, { recursive: true, force: true }))
    const slug = `runtimes-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Environment directory') RETURNING id", [slug],
    )).rows[0]!.id
    releases.push(() => removeFixtureOrganization(pool, organizationId))
    for (const name of ['computer-a', 'computer-b']) await pool.query(
      'INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name],
    )
    const context = await resolvePostgresRuntimeContext(pool, slug, 'computer-a')
    const otherContext = await resolvePostgresRuntimeContext(pool, slug, 'computer-b')
    const cfg = testConfig(root)
    const users = new PostgresUserService(context, cfg)
    const admin = await users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
    const member = await users.create({ username: 'member', password: 'pw-12345678' })
    await users.changeOwnPassword(admin.id, 'pw-12345678')
    await users.changeOwnPassword(member.id, 'pw-12345678')
    const remoteUsers = new PostgresUserService(otherContext, cfg)
    const remote = await remoteUsers.create({ username: 'remote', password: 'pw-12345678' })
    await remoteUsers.changeOwnPassword(remote.id, 'pw-12345678')
    const projects = new PostgresProjectService(context, cfg)
    const project = await projects.createManaged({ name: 'Shared project', ownerUserId: admin.id })
    const catalog = new PostgresRuntimeCatalog(context, cfg.runtimeCatalog)
    const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
    return { root, cfg, context, otherContext, organizationId, users, admin, member, remote, projects, project, catalog, repository }
  }

  it('keeps environment IDs through generation changes and exposes remote metadata without opening a node connection', async () => {
    const f = await fixture()
    const before = await f.catalog.pageForAdministrator(f.admin, {})
    expect(before.items).toHaveLength(4)
    expect(new Set(before.items.map(item => item.id)).size).toBe(4)
    expect(before.items.find(item => item.owner.id === f.remote.id && item.owner.kind === 'personal'))
      .toMatchObject({ routing: 'unavailable', node: { name: 'computer-b' } })
    await pool.query("UPDATE harness.compute_nodes SET status='offline' WHERE id=$1", [f.otherContext.nodeId])
    await pool.query('UPDATE harness.instances SET generation=generation+1 WHERE organization_id=$1', [f.organizationId])
    const after = await new PostgresRuntimeCatalog(f.context, f.cfg.runtimeCatalog).pageForAdministrator(f.admin, {})
    expect(after.items.map(item => item.id)).toEqual(before.items.map(item => item.id))
    expect(after.items.find(item => item.node.name === 'computer-b')?.node.status).toBe('offline')
    expect(after.items.every(item => item.generation === 2)).toBe(true)
  })

  it('keeps personal environments private and rechecks project membership and administrator authority', async () => {
    const f = await fixture()
    expect((await f.catalog.pageForAccount(f.member, {})).items.map(item => item.owner))
      .toEqual([{ kind: 'personal', id: f.member.id, name: 'member' }])
    await f.projects.setMember(f.project.id, f.member.id, 'ro', f.admin.id)
    expect((await f.catalog.pageForAccount(f.member, {})).items).toHaveLength(2)
    await f.projects.removeMember(f.project.id, f.member.id, f.admin.id)
    expect((await f.catalog.pageForAccount(f.member, {})).items).toHaveLength(1)
    await expect(f.catalog.pageForAdministrator(f.member, {})).rejects.toMatchObject({ status: 403 })
    await f.users.setRole(f.member.id, 'admin')
    await f.users.setRole(f.admin.id, 'user')
    await expect(f.catalog.pageForAdministrator(f.admin, {})).rejects.toMatchObject({ status: 403 })
  })

  it('resolves existing owner selectors from metadata and refuses ambiguity without guessing a Runtime', async () => {
    const f = await fixture()
    const personal = await f.catalog.resolveForOwner(f.member, { kind: 'personal', id: f.member.id })
    expect(personal.owner).toMatchObject({ kind: 'personal', id: f.member.id })
    await expect(f.catalog.resolveForOwner(f.member, { kind: 'personal', id: f.admin.id })).rejects.toMatchObject({ status: 404 })
    await expect(f.catalog.resolveForOwner(f.member, { kind: 'project', id: f.project.id })).rejects.toMatchObject({ status: 404 })
    await f.projects.setMember(f.project.id, f.member.id, 'ro', f.admin.id)
    expect((await f.catalog.resolveForOwner(f.member, { kind: 'project', id: f.project.id })).owner.id).toBe(f.project.id)
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
        SELECT organization_id,user_id,assigned_node_id,port+100,'isolated' FROM harness.instances WHERE runtime_id=$1`, [personal.id])
      const catalog = new PostgresRuntimeCatalog({ ...f.context, pool: tx }, f.cfg.runtimeCatalog)
      await expect(catalog.resolveForOwner(f.member, { kind: 'personal', id: f.member.id }))
        .rejects.toMatchObject({ status: 409, code: 'runtime-catalog/ambiguous-target' })
      expect(await catalog.resolveForAccount(f.member, personal.id)).toMatchObject({ id: personal.id })
    } finally { await tx.query('ROLLBACK'); tx.release() }
  })

  it('enters a stable authorized personal default while exact and owner selectors retain their identities', async () => {
    const f = await fixture()
    const original = await f.catalog.resolveForOwner(f.member, { kind: 'personal', id: f.member.id })
    const account = (await pool.query<{ id: string }>(
      'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [f.organizationId, f.member.id],
    )).rows[0]!.id
    await pool.query(`INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
      VALUES($1,$2,$3,$4)`, [f.organizationId, f.otherContext.nodeId, account, join(f.root, 'member-b')])
    await pool.query(`INSERT INTO harness.computer_use_permissions(organization_id,node_id,user_id,enabled)
      VALUES($1,$2,$3,true)`, [f.organizationId, f.otherContext.nodeId, account])
    const remote = (await pool.query<{ runtime_id: string }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
      VALUES($1,$2,$3,65520) RETURNING runtime_id`, [f.organizationId, account, f.otherContext.nodeId])).rows[0]!.runtime_id
    const extra = (await pool.query<{ runtime_id: string }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
      VALUES($1,$2,$3,65521,'isolated') RETURNING runtime_id`, [f.organizationId, account, f.context.nodeId])).rows[0]!.runtime_id
    await pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,storage_layout)
      VALUES($1,$2,$3,65522,'isolated')`, [f.organizationId, account, f.context.nodeId])
    await pool.query("UPDATE harness.runtime_environments SET created_at='2000-01-01' WHERE id=ANY($1::uuid[])", [[remote, extra]])
    await pool.query("UPDATE harness.compute_nodes SET status='offline' WHERE id=$1", [f.context.nodeId])
    expect((await f.catalog.resolveForLanding(f.member)).id).toBe(original.id)
    await expect(f.catalog.resolveForOwner(f.member, { kind: 'personal', id: f.member.id }))
      .rejects.toMatchObject({ status: 409, code: 'runtime-catalog/ambiguous-target' })
    expect((await f.catalog.resolveForAccount(f.member, remote)).id).toBe(remote)
    const secondary = new PostgresRuntimeCatalog(f.otherContext, f.cfg.runtimeCatalog, f.otherContext.nodeId as RuntimeNodeId)
    expect((await secondary.resolveForLanding(f.member)).id).toBe(remote)
    await expect(secondary.resolveForAccount(f.member, original.id)).rejects.toMatchObject({ status: 404 })
    await pool.query('DELETE FROM harness.instances WHERE runtime_id=$1', [original.id])
    await expect(f.catalog.resolveForAccount(f.member, original.id)).rejects.toMatchObject({ status: 404 })
    expect((await f.catalog.resolveForLanding(f.member)).id).toBe(extra)
    await pool.query(`UPDATE harness.computer_use_permissions SET enabled=false
      WHERE organization_id=$1 AND node_id=$2 AND user_id=$3`, [f.organizationId, f.context.nodeId, account])
    expect((await f.catalog.resolveForLanding(f.member)).id).toBe(remote)
    const local = new PostgresRuntimeCatalog(f.context, f.cfg.runtimeCatalog, f.context.nodeId as RuntimeNodeId)
    await expect(local.resolveForLanding(f.member)).rejects.toMatchObject({ status: 404 })
    await pool.query(`UPDATE harness.computer_use_permissions SET enabled=false
      WHERE organization_id=$1 AND node_id=$2 AND user_id=$3`, [f.organizationId, f.otherContext.nodeId, account])
    await expect(f.catalog.resolveForLanding(f.member)).rejects.toMatchObject({ status: 404 })
    await f.users.setStatus(f.member.id, 'disabled')
    await expect(f.catalog.resolveForLanding(f.member)).rejects.toMatchObject({ status: 403 })
  })

  it('fences lifecycle reads and writes by RuntimeId without falling back to the same owner', async () => {
    const f = await fixture()
    const personal = await f.catalog.resolveForOwner(f.member, { kind: 'personal', id: f.member.id })
    const unrelated = await f.catalog.resolveForOwner(f.admin, { kind: 'personal', id: f.admin.id })
    const target = { kind: 'user' as const, id: f.member.id, runtimeId: personal.id }
    const wrong = { ...target, runtimeId: unrelated.id }
    expect(await f.repository.resolveTarget({ kind: 'user', id: f.member.id })).toEqual(target)
    await expect(f.repository.resolveTarget(wrong)).rejects.toMatchObject({ reason: 'unavailable' })
    expect(await f.repository.owner(wrong)).toBeNull()
    expect(await f.repository.personalPolicy(f.member.id, undefined, unrelated.id)).toBeNull()
    expect(await f.repository.startEligibility(wrong)).toBeNull()
    await expect(f.repository.portOf(wrong)).rejects.toThrow('no instance row')
    const before = await f.repository.generationOf(target)
    await expect(f.repository.beginStart(wrong, Date.now(), Buffer.alloc(32), 'explicit')).rejects.toMatchObject({ reason: 'unavailable' })
    expect(await f.repository.markStopping(wrong, before)).toBe(false)
    expect(await f.repository.markStopped(wrong, before)).toBe(false)
    expect(await f.repository.generationOf(target)).toBe(before)
    const token = randomUUID()
    const generation = await f.repository.beginStart(target, Date.now(), createHash('sha256').update(token).digest(), 'explicit')
    await f.repository.markReady(target, generation)
    expect(await f.repository.markStopping(wrong, generation)).toBe(false)
    expect(await f.repository.stateOf(target)).toBe('ready')
    expect(await f.repository.authenticateRuntimeToken(token)).not.toBeNull()
    await f.repository.markStopped(target, generation)
    await pool.query('DELETE FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2', [f.organizationId, personal.id])
    await f.repository.initialize()
    const replacement = await f.repository.resolveTarget({ kind: 'user', id: f.member.id })
    expect(replacement.runtimeId).not.toBe(target.runtimeId)
    expect(await f.repository.startEligibility(target)).toBeNull()
    expect(await f.repository.markStopping(target, await f.repository.generationOf(replacement))).toBe(false)
    expect(await f.repository.stateOf(replacement)).toBe('stopped')
    const replacementGeneration = await f.repository.beginStart(replacement, Date.now(), Buffer.alloc(32, 7), 'explicit')
    expect(replacementGeneration).toBeGreaterThan(generation)
    await f.repository.markStopped(replacement, replacementGeneration)
    await expect(f.catalog.resolveForAccount(f.member, personal.id)).rejects.toMatchObject({ status: 404 })
  })

  it('preserves the original environment and creates no orphan when an instance is upserted', async () => {
    const f = await fixture()
    const original = (await f.catalog.pageForAccount(f.member, {})).items[0]!
    const ownerId = (await pool.query<{ id: string }>(
      'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [f.organizationId, f.member.id],
    )).rows[0]!.id
    const result = await pool.query<{ runtime_id: string }>(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port)
      VALUES($1,$2,$3,65528) ON CONFLICT(organization_id,assigned_node_id,user_id) WHERE user_id IS NOT NULL AND storage_layout='legacy' DO UPDATE
        SET port=excluded.port RETURNING runtime_id`, [f.organizationId, ownerId, f.context.nodeId])
    expect(result.rows[0]?.runtime_id).toBe(original.id)
    expect((await pool.query<{ n: string }>(
      'SELECT count(*)::text n FROM harness.runtime_environments WHERE organization_id=$1 AND owner_id=$2', [f.organizationId, ownerId],
    )).rows[0]?.n).toBe('1')
  })

  it('does not return another organization or trust a stale enabled actor', async () => {
    const f = await fixture(), peer = await fixture()
    const listed = await f.catalog.pageForAdministrator(f.admin, {})
    const peerIds = new Set((await peer.catalog.pageForAdministrator(peer.admin, {})).items.map(item => item.id))
    expect(listed.items.some(item => peerIds.has(item.id))).toBe(false)
    await f.users.setStatus(f.member.id, 'disabled')
    await expect(f.catalog.pageForAccount(f.member, {})).rejects.toMatchObject({ status: 403 })
    expect((await f.catalog.pageForAdministrator(f.admin, {})).items.some(item => item.owner.kind === 'personal' && item.owner.id === f.member.id)).toBe(true)
  })

  it('uses bounded, actor-scoped keyset pages and rejects malformed or reused cursors', async () => {
    const f = await fixture()
    const ids: string[] = []
    let cursor: string | undefined
    do {
      const page = await f.catalog.pageForAdministrator(f.admin, { limit: '1', ...(cursor === undefined ? {} : { cursor }) })
      expect(page.items).toHaveLength(1)
      ids.push(page.items[0]!.id)
      cursor = page.nextCursor ?? undefined
    } while (cursor !== undefined)
    expect(ids).toEqual((await f.catalog.pageForAdministrator(f.admin, {})).items.map(item => item.id))
    expect(new Set(ids).size).toBe(4)
    const first = await f.catalog.pageForAdministrator(f.admin, { limit: '1' })
    await expect(f.catalog.pageForAccount(f.admin, { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'runtime-catalog/invalid-cursor' })
    await expect(f.catalog.pageForAdministrator(f.member, { cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'runtime-catalog/invalid-cursor' })
    for (const cursor of ['', 'garbage', 'a'.repeat(513)]) await expect(f.catalog.pageForAccount(f.member, { cursor })).rejects.toMatchObject({ status: 400 })
    for (const limit of ['0', '-1', '1e2', '01', '51']) await expect(f.catalog.pageForAccount(f.member, { limit })).rejects.toMatchObject({ code: 'runtime-catalog/invalid-limit' })
  })

  it('resolves saved IDs with current account access, bounded pages and filter-bound cursors', async () => {
    const f = await fixture()
    const all = await f.catalog.pageForAdministrator(f.admin, {})
    const ids = all.items.map(item => item.id).join(',')
    const personal = await f.catalog.pageForAccount(f.member, { ids })
    expect(personal.items.map(item => item.owner)).toEqual([{ kind: 'personal', id: f.member.id, name: 'member' }])
    const first = await f.catalog.pageForAdministrator(f.admin, { ids, limit: '1' })
    expect(first.nextCursor).not.toBeNull()
    await expect(f.catalog.pageForAdministrator(f.admin, { ids: first.items[0]!.id, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: 'runtime-catalog/invalid-cursor' })
    for (const ids of ['', 'invalid', Array.from({ length: 33 }, () => randomUUID()).join(','),
      Array.from({ length: 33 }, () => all.items[0]!.id).join(',')]) {
      await expect(f.catalog.pageForAccount(f.member, { ids })).rejects.toMatchObject({ code: 'runtime-catalog/invalid-id' })
    }
    const withdrawn = all.items.find(item => item.owner.kind === 'project')!
    await f.projects.setMember(f.project.id, f.member.id, 'ro', f.admin.id)
    expect((await f.catalog.pageForAccount(f.member, { ids: withdrawn.id })).items).toHaveLength(1)
    await f.projects.removeMember(f.project.id, f.member.id, f.admin.id)
    expect((await f.catalog.pageForAccount(f.member, { ids: withdrawn.id })).items).toEqual([])
  })

  it('bounds complete UTF-8 pages including their continuation and rejects one oversized entry', async () => {
    const f = await fixture()
    const full = await f.catalog.pageForAdministrator(f.admin, {})
    const first = await f.catalog.pageForAdministrator(f.admin, { limit: '1' })
    const maxBytes = Buffer.byteLength(JSON.stringify(first))
    const bounded = new PostgresRuntimeCatalog(f.context, { pageSize: 50, maxBytes })
    const page = await bounded.pageForAdministrator(f.admin, {})
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBe(first.nextCursor)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(maxBytes)
    await pool.query('UPDATE harness.users SET display_name=$3 WHERE organization_id=$1 AND public_id=$2',
      [f.organizationId, f.member.id, '文件'.repeat(maxBytes)])
    await expect(bounded.pageForAccount(f.member, {})).rejects.toMatchObject({ status: 413, code: 'runtime-catalog/entry-too-large' })
    expect(full.items).toHaveLength(4)
  })

  it('retains retired environment identities after account and project assignment removal', async () => {
    const f = await fixture()
    const original = (await f.catalog.pageForAccount(f.member, {})).items[0]!
    await f.users.remove(f.member.id)
    expect((await pool.query<{ retired: boolean }>(
      'SELECT retired_at IS NOT NULL retired FROM harness.runtime_environments WHERE id=$1', [original.id],
    )).rows).toEqual([{ retired: true }])
    expect((await f.catalog.pageForAdministrator(f.admin, {})).items.some(item => item.id === original.id)).toBe(false)
    const replacement = await f.users.create({ username: 'replacement', password: 'pw-12345678' })
    expect((await f.catalog.pageForAccount(replacement, {})).items[0]!.id).not.toBe(original.id)
    const project = (await f.catalog.pageForAccount(f.admin, {})).items.find(item => item.owner.kind === 'project')!
    await f.projects.remove(f.project.id)
    expect((await pool.query<{ retired: boolean }>(
      'SELECT retired_at IS NOT NULL retired FROM harness.runtime_environments WHERE id=$1', [project.id],
    )).rows).toEqual([{ retired: true }])
  })

  it('resolves exact authorized placement metadata and refuses inaccessible or retired identities', async () => {
    const f = await fixture()
    const own = (await f.catalog.pageForAccount(f.member, {})).items[0]!
    expect(await f.catalog.resolveForAccount(f.member, own.id)).toEqual(own)
    await expect(f.catalog.resolveForAccount(f.admin, own.id)).rejects.toMatchObject({ status: 404 })
    const remote = (await f.catalog.pageForAccount(f.remote, {})).items[0]!
    expect(await f.catalog.resolveForAccount(f.remote, remote.id)).toEqual(remote)
    await expect(f.catalog.resolveForAccount(f.member, randomUUID())).rejects.toMatchObject({ status: 404 })
    await expect(f.catalog.resolveForAccount(f.member, 'personal')).rejects.toMatchObject({ status: 400 })
    await pool.query('DELETE FROM harness.instances WHERE runtime_id=$1', [own.id])
    await expect(f.catalog.resolveForAccount(f.member, own.id)).rejects.toMatchObject({ status: 404 })
  })

  it('rejects forged identities, changed owners and reassignment of an active process', async () => {
    const f = await fixture()
    const row = (await pool.query<{ id: string; user_id: string }>(
      'SELECT id,user_id FROM harness.instances WHERE organization_id=$1 AND assigned_node_id=$2 AND user_id IS NOT NULL ORDER BY port LIMIT 1', [f.organizationId, f.context.nodeId],
    )).rows[0]!
    await expect(pool.query('UPDATE harness.instances SET runtime_id=gen_random_uuid() WHERE id=$1', [row.id])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query('UPDATE harness.instances SET user_id=gen_random_uuid() WHERE id=$1', [row.id])).rejects.toMatchObject({ code: '23514' })
    await expect(pool.query(`INSERT INTO harness.instances(organization_id,user_id,assigned_node_id,port,runtime_id)
      VALUES($1,$2,$3,65530,$4)`, [f.organizationId, row.user_id, f.context.nodeId, row.id])).rejects.toMatchObject({ code: '23514' })
    await pool.query("UPDATE harness.instances SET observed_state='ready' WHERE id=$1", [row.id])
    await expect(pool.query('UPDATE harness.instances SET assigned_node_id=$2 WHERE id=$1', [row.id, f.otherContext.nodeId])).rejects.toMatchObject({ code: '23514' })
    await pool.query("UPDATE harness.instances SET observed_state='stopped' WHERE id=$1", [row.id])
    await expect(pool.query('UPDATE harness.instances SET assigned_node_id=$2,port=65529 WHERE id=$1', [row.id, f.otherContext.nodeId]))
      .rejects.toMatchObject({ code: '23514' })
    await pool.query(`INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path)
      VALUES($1,$2,$3,$4)`, [f.organizationId, f.otherContext.nodeId, row.user_id, join(f.root, 'computer-b-home')])
    await pool.query('UPDATE harness.instances SET assigned_node_id=$2,port=65529 WHERE id=$1', [row.id, f.otherContext.nodeId])
    expect((await pool.query<{ node_id: string }>('SELECT node_id FROM harness.runtime_environments WHERE id=$1', [row.id])).rows[0]?.node_id).toBe(f.otherContext.nodeId)
  })

  it('serves a keyless authenticated HTTP transcript while runtime launch remains unavailable', async () => {
    const f = await fixture()
    const upgrades = new WebSocketServer({ noServer: true })
    releases.push(async () => {
      for (const client of upgrades.clients) client.terminate()
      await new Promise<void>((done, reject) => { upgrades.close(error => { if (error) reject(error); else done() }) })
    })
    let starts = 0
    const instances = new InstanceManager(f.repository, f.cfg, {
      instancesOutliveGateway: false,
      start: async () => { starts++; throw new Error('Execution nodes are unavailable') },
    })
    const server = createGatewayServer({ cfg: f.cfg, users: f.users, projects: f.projects, instances,
      auth: new PostgresAuthService(f.context, f.cfg), audit: new PostgresAuditService(f.context), runtimeCatalog: f.catalog,
      runtimeRouter: new GatewayRuntimeRouter(new LocalRuntimeAdapter({ collaboration: new PostgresCollaborationService(f.context) }), {
        catalog: f.catalog, localNodeId: f.context.nodeId as RuntimeNodeId,
      }),
      collaboration: new PostgresCollaborationService(f.context) }, {
      proxy: async (_request, response, context) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ scope: context.scope.kind, owner: context.runtime.id }))
      },
      upgrade: async (request, socket, head, context) => {
        upgrades.handleUpgrade(request, socket, head, client => {
          client.send(JSON.stringify({ scope: context.scope.kind, environmentId: context.environment?.id }))
          client.close()
        })
      },
    })
    releases.push(async () => {
      for (const client of upgrades.clients) client.terminate()
      server.closeAllConnections()
      await new Promise<void>((resolvePromise, reject) => { server.close(error => { if (error) reject(error); else resolvePromise() }) })
      await instances.stopAll()
    })
    await new Promise<void>((resolvePromise, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolvePromise) })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    f.cfg.publicOrigins.push(base)
    const login = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base },
      body: new URLSearchParams({ username: 'admin', password: 'pw-12345678' }) })
    await login.arrayBuffer()
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const account = await fetch(`${base}/account/api/runtimes?limit=1`, { headers: { cookie } })
    const page = await account.json() as RuntimeCatalogPage
    const admin = await fetch(`${base}/admin/api/runtimes`, { headers: { cookie } })
    const all = await admin.json() as RuntimeCatalogPage
    const bad = await fetch(`${base}/account/api/runtimes?limit=0`, { headers: { cookie } })
    const own = all.items.find(item => item.owner.kind === 'personal' && item.owner.id === f.admin.id)!
    const scopedCookie = `${cookie}; ${SCOPE_COOKIE}=project:${f.project.id}`
    const routed = await fetch(`${base}/api/echo?dshRuntime=${own.id}`, { headers: { cookie: scopedCookie } })
    expect(await routed.json()).toEqual({ scope: 'personal', owner: f.admin.id })
    const project = all.items.find(item => item.owner.kind === 'project')!
    const projectRouted = await fetch(`${base}/api/echo?dshRuntime=${project.id}`, { headers: { cookie } })
    expect(await projectRouted.json()).toEqual({ scope: 'project', owner: f.project.id })
    const mismatch = await fetch(`${base}/api/echo?dshRuntime=${own.id}&dshTarget=project:${f.project.id}`, { headers: { cookie } })
    const remoteLogin = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base },
      body: new URLSearchParams({ username: 'remote', password: 'pw-12345678' }) })
    await remoteLogin.arrayBuffer()
    const remoteCookie = remoteLogin.headers.get('set-cookie')!.split(';')[0]!
    const remoteEnvironment = all.items.find(item => item.owner.kind === 'personal' && item.owner.id === f.remote.id)!
    const observeUpgrade = async (query: string, actorCookie = cookie) => {
      const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/route?${query}`, { headers: { cookie: actorCookie, origin: base } })
      const closed = new Promise<void>(done => { socket.once('close', () => done()) })
      try {
        return await new Promise<{ status: number; scope?: string; environmentId?: string }>((done, reject) => {
          socket.once('error', reject)
          socket.once('unexpected-response', (_request, response) => { response.resume(); done({ status: response.statusCode! }) })
          socket.once('message', data => { done({ status: 101, ...JSON.parse(data.toString()) as { scope: string; environmentId: string } }) })
        })
      } finally { socket.terminate(); await closed }
    }
    const personalUpgrade = await observeUpgrade(`dshRuntime=${own.id}`)
    const projectUpgrade = await observeUpgrade(`dshRuntime=${project.id}`)
    const remoteUpgrade = await observeUpgrade(`dshRuntime=${remoteEnvironment.id}`, remoteCookie)
    const unknownUpgrade = await observeUpgrade(`dshRuntime=${randomUUID()}`)
    const conflictUpgrade = await observeUpgrade(`dshRuntime=${own.id}&dshTarget=project:${f.project.id}`)
    expect(mismatch.status).toBe(400)
    expect(await mismatch.json()).toEqual({ error: 'runtime-catalog/target-mismatch' })
    const denied = await fetch(`${base}/account/api/runtimes`)
    await denied.arrayBuffer()
    const transcript = {
      account: { status: account.status, entries: page.items.length, hasMore: page.nextCursor !== null, cache: account.headers.get('cache-control') },
      admin: { status: admin.status, entries: all.items.length, local: all.items.filter(item => item.routing === 'local').length,
        remote: all.items.filter(item => item.routing === 'unavailable').length },
      invalid: { status: bad.status, body: await bad.json() },
      unauthenticated: denied.status,
      runtimeStarts: starts,
      localRouting: { personal: routed.status, project: projectRouted.status, conflictingTarget: mismatch.status },
      webSocketRouting: {
        personal: { status: personalUpgrade.status, scope: personalUpgrade.scope, environmentBound: personalUpgrade.environmentId === own.id },
        project: { status: projectUpgrade.status, scope: projectUpgrade.scope, environmentBound: projectUpgrade.environmentId === project.id },
        remote: remoteUpgrade.status, unknown: unknownUpgrade.status, conflictingTarget: conflictUpgrade.status,
      },
    }
    await expect(JSON.stringify(transcript, null, 2) + '\n').toMatchFileSnapshot(
      fileURLToPath(new URL('./expected/runtime-catalog.json', import.meta.url)),
    )
  })
})
