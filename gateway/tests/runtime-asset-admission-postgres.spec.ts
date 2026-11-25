/** PostgreSQL and live Gateway checks for exact Runtime resource and Session admission. */
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { PostgresAccessMonitor } from '../src/access-invalidation.ts'
import { PostgresComputerAccess } from '../src/computer-access.ts'
import { forwardIssuerOf, verifyGatewayForward, type GatewayForwardClaims } from '../src/forwarded-principal.ts'
import { InstanceManager, INSTANCE_PROFILE } from '../src/instances.ts'
import { computeLaunchStamps } from '../src/launch-stamp.ts'
import { NodeResourceBudget } from '../src/node-resource-budget.ts'
import { NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresInstanceRepository } from '../src/postgres/instance-repository.ts'
import { PostgresMaintenanceService } from '../src/postgres/maintenance-service.ts'
import { NodePrincipalDirectory } from '../src/postgres/node-principal-directory.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import { PostgresRuntimeCatalog } from '../src/postgres/runtime-catalog.ts'
import { resolvePostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { GatewayPrincipalSigner, PRINCIPAL_HEADER } from '../src/principal.ts'
import { createProxyHandlers } from '../src/proxy.ts'
import { PostgresRuntimeAssetAdmission, type RuntimeAssetRequest } from '../src/runtime-asset-admission.ts'
import { RuntimeAssets } from '../src/runtime-assets.ts'
import type { RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import { createGatewayServer, SESSION_COOKIE, type GatewayDeps } from '../src/server.ts'
import { barrier, deferred } from './barrier.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
import { removeFixtureOrganization } from './postgres-fixture-cleanup.ts'
import { testConfig } from './test-config.ts'

const databaseUrl = postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const pg = databaseUrl === undefined ? describe.skip : describe

pg('PostgreSQL exact Runtime admission', () => {
  let pool: Pool
  const releases: Array<() => Promise<unknown>> = []
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 4 })
    await runMigrations(pool, resolve(import.meta.dirname, '../deploy/postgres/migrations'))
  })
  afterEach(async () => {
    const failures: unknown[] = []
    for (const release of releases.splice(0).reverse()) { try { await release() } catch (error) { failures.push(error) } }
    if (failures.length > 0) throw new AggregateError(failures, 'Runtime asset fixture cleanup failed')
  })
  afterAll(async () => { await pool?.end() })

  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'hgw-runtime-assets-'))
    releases.push(() => rm(root, { recursive: true, force: true }))
    const slug = `assets-${randomUUID()}`
    const organizationId = (await pool.query<{ id: string }>(
      "INSERT INTO harness.organizations(slug,display_name) VALUES($1,'Runtime assets') RETURNING id", [slug],
    )).rows[0]!.id
    releases.push(() => removeFixtureOrganization(pool, organizationId))
    for (const name of ['local', 'other']) await pool.query('INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2)', [organizationId, name])
    const context = await resolvePostgresRuntimeContext(pool, slug, 'local')
    const other = await resolvePostgresRuntimeContext(pool, slug, 'other')
    const cfg = testConfig(root)
    const users = new PostgresUserService(context, cfg)
    const admin = await users.create({ username: 'admin', password: 'pw-12345678', role: 'admin' })
    const member = await users.create({ username: 'member', password: 'pw-12345678' })
    await users.changeOwnPassword(admin.id, 'pw-12345678'); await users.changeOwnPassword(member.id, 'pw-12345678')
    const projects = new PostgresProjectService(context, cfg)
    const project = await projects.createManaged({ name: 'Fixture project', ownerUserId: admin.id })
    await projects.setMember(project.id, member.id, 'ro', admin.id)
    const catalog = new PostgresRuntimeCatalog(context, cfg.runtimeCatalog)
    const personal = await catalog.resolveForOwner(member, { kind: 'personal', id: member.id })
    const shared = await catalog.resolveForOwner(member, { kind: 'project', id: project.id })
    const repository = new PostgresInstanceRepository(context, cfg.instancePortBase)
    const budget = new NodeResourceBudget(pool, organizationId, context.nodeId, cfg.resourceBudget)
    for (const [kind, id, runtimeId] of [['user', member.id, personal.id], ['project', project.id, shared.id]] as const) {
      const target = { kind, id, runtimeId }
      const generation = await repository.beginStart(target, Date.now(), createHash('sha256').update(randomUUID()).digest(), 'explicit', undefined, true, 'fixture-stamp')
      await repository.markReady(target, generation)
      await budget.register({ organizationId, target, generation })
    }
    const auth = new PostgresAuthService(context, cfg)
    const login = await auth.login(member.username, 'pw-12345678', '127.0.0.1', 'asset-fixture')
    if (typeof login === 'string') throw new Error(login)
    const request: RuntimeAssetRequest = { actorId: member.id, sessionToken: login.token, runtimeId: personal.id }
    const maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
    const writeEpoch = await maintenance.currentWriteEpoch()
    const admission = new PostgresRuntimeAssetAdmission(context, writeEpoch)
    return { root, context, other, cfg, organizationId, users, admin, member, projects, project, personal, shared,
      auth, request, admission, repository, budget, maintenance, writeEpoch }
  }

  it('reads personal and read-only project authority in one statement without changing login or Runtime activity', async () => {
    const f = await fixture()
    const before = await pool.query(`SELECT session.last_seen_at,session.expires_at,instance.last_activity_at,instance.generation
      FROM harness.auth_sessions session JOIN harness.instances instance ON instance.organization_id=session.organization_id
      WHERE session.organization_id=$1 AND instance.runtime_id=$2`, [f.organizationId, f.personal.id])
    const query = vi.spyOn(pool, 'query')
    try {
      const personal = await f.admission.admit(f.request)
      expect(query).toHaveBeenCalledOnce()
      expect(personal).toMatchObject({ user: { id: f.member.id }, scope: { kind: 'personal' }, placement: { local: true, environment: { id: f.personal.id } },
        snapshot: { target: { runtimeId: f.personal.id }, state: 'ready' } })
      expect(personal.expiresAt).toBeGreaterThan(Date.now())
      query.mockClear()
      expect(await f.admission.admit({ ...f.request, runtimeId: f.shared.id })).toMatchObject({ scope: { kind: 'project', projectId: f.project.id, mode: 'ro' } })
      expect(query).toHaveBeenCalledOnce()
    } finally { query.mockRestore() }
    expect((await pool.query(`SELECT session.last_seen_at,session.expires_at,instance.last_activity_at,instance.generation
      FROM harness.auth_sessions session JOIN harness.instances instance ON instance.organization_id=session.organization_id
      WHERE session.organization_id=$1 AND instance.runtime_id=$2`, [f.organizationId, f.personal.id])).rows).toEqual(before.rows)
  })

  it('binds primary history approval to the current issuer, exact target and live browser session', async () => {
    const f = await fixture()
    const nodeId = f.context.nodeId as RuntimeNodeId
    const pem = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await pool.query('UPDATE harness.compute_nodes SET principal_public_key=$2 WHERE id=$1', [nodeId, pem])
    await pool.query(`UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2,primary_origin='https://test.invalid'
      WHERE organization_id=$1`, [f.organizationId, nodeId])
    const request = { ...f.request, target: 'personal' as const, nodeId }
    expect(await f.admission.approvePersonalRead(request, pem)).toMatchObject({ launchStamp: 'fixture-stamp' })
    expect(await f.admission.approvePersonalRead({ ...request, nodeId: f.other.nodeId as RuntimeNodeId }, pem)).toBeNull()
    expect(await f.admission.approvePersonalRead({ ...request, runtimeId: f.shared.id }, pem)).toBeNull()

    const replacement = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await pool.query('UPDATE harness.compute_nodes SET principal_public_key=$2 WHERE id=$1', [nodeId, replacement])
    expect(await f.admission.approvePersonalRead(request, pem)).toBeNull()
    expect(await f.admission.approvePersonalRead(request, replacement)).toMatchObject({ launchStamp: 'fixture-stamp' })
    await f.auth.revoke(request.sessionToken)
    expect(await f.admission.approvePersonalRead(request, replacement)).toBeNull()
  })

  it('records authorized personal and read-only project Session activity in one round trip without renewing the browser session', async () => {
    const f = await fixture()
    for (const [runtimeId, target, scope] of [
      [f.personal.id, 'personal', { kind: 'personal' }],
      [f.shared.id, `project:${f.project.id}`, { kind: 'project', projectId: f.project.id, projectName: f.project.name, mode: 'ro' }],
    ] as const) {
      await pool.query("UPDATE harness.instances SET last_activity_at='2001-01-01' WHERE runtime_id=$1", [runtimeId])
      const read = () => pool.query<{ last_seen_at: Date; expires_at: Date; last_activity_at: Date; generation: string }>(
        `SELECT session.last_seen_at,session.expires_at,instance.last_activity_at,instance.generation
          FROM harness.auth_sessions session JOIN harness.instances instance ON instance.organization_id=session.organization_id
          WHERE session.organization_id=$1 AND instance.runtime_id=$2`, [f.organizationId, runtimeId])
      const before = (await read()).rows[0]!
      const query = vi.spyOn(pool, 'query')
      try {
        await expect(f.admission.admitSession({ ...f.request, runtimeId, nodeId: f.context.nodeId as RuntimeNodeId, target },
          Number(before.generation))).resolves.toMatchObject({ scope, snapshot: { generation: Number(before.generation) } })
        expect(query).toHaveBeenCalledOnce()
      } finally { query.mockRestore() }
      const after = (await read()).rows[0]!
      expect(after.last_seen_at).toEqual(before.last_seen_at)
      expect(after.expires_at).toEqual(before.expires_at)
      expect(after.generation).toEqual(before.generation)
      expect(after.last_activity_at.getTime()).toBeGreaterThan(before.last_activity_at.getTime())
    }
  })

  it.each([true, false])('checks the forwarding issuer and remote generation with start activity %s', async recordActivity => {
    const f = await fixture()
    const nodeId = f.context.nodeId as RuntimeNodeId, issuerNode = f.other.nodeId as RuntimeNodeId
    const issuerKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await pool.query("UPDATE harness.instances SET observed_state='stopped',desired_state='stopped' WHERE organization_id=$1", [f.organizationId])
    await pool.query(`UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2,
      primary_origin='http://127.0.0.1:1' WHERE organization_id=$1`, [f.organizationId, issuerNode])
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,attachment_state,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'managed',$4,5,clock_timestamp()+interval '60 seconds')`,
    [f.organizationId, nodeId, createHash('sha256').update(randomUUID()).digest(), randomUUID()])
    await pool.query('UPDATE harness.compute_nodes SET principal_public_key=$2 WHERE id=$1', [issuerNode, issuerKey])
    const target = { kind: 'user' as const, id: f.member.id, runtimeId: f.personal.id }
    const generation = await f.repository.beginStart(target, Date.now(), createHash('sha256').update(randomUUID()).digest(), 'explicit', undefined, true, 'fixture-stamp')
    await f.repository.markReady(target, generation)
    await f.budget.register({ organizationId: f.organizationId, target, generation })
    const request = { ...f.request, nodeId, target: 'personal' as const }
    const issuer = { nodeId: issuerNode, publicKey: issuerKey }
    const query = vi.spyOn(pool, 'query')
    try {
      await expect(f.admission.admitSession(request, generation, issuer, recordActivity)).resolves.toMatchObject({
        user: { id: f.member.id }, scope: { kind: 'personal' }, snapshot: { generation },
      })
      expect(query).toHaveBeenCalledOnce()
    } finally { query.mockRestore() }

    await pool.query("UPDATE harness.instances SET last_activity_at='2001-01-01' WHERE runtime_id=$1", [f.personal.id])
    const rotatedKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await pool.query('UPDATE harness.compute_nodes SET principal_public_key=$2 WHERE id=$1', [issuerNode, rotatedKey])
    await expect(f.admission.admitSession(request, generation, issuer, recordActivity)).rejects.toMatchObject({ status: 403, code: 'access-revoked' })
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,attachment_state,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'managed',$4,1,clock_timestamp()-interval '60 seconds')`,
    [f.organizationId, issuerNode, createHash('sha256').update(randomUUID()).digest(), randomUUID()])
    await expect(f.admission.admitSession(request, generation, { ...issuer, publicKey: rotatedKey }, recordActivity))
      .rejects.toMatchObject({ status: 403, code: 'access-revoked' })
    expect((await pool.query<{ unchanged: boolean }>(
      "SELECT last_activity_at='2001-01-01' unchanged FROM harness.instances WHERE runtime_id=$1", [f.personal.id],
    )).rows[0]?.unchanged).toBe(true)
  })

  it('admits a retained personal preparation while directory publication holds a shared instance lock', async () => {
    const f = await fixture()
    const target = { kind: 'user' as const, id: f.member.id, runtimeId: f.personal.id }
    const generation = await f.repository.generationOf(target)
    const request = { ...f.request, nodeId: f.context.nodeId as RuntimeNodeId, target: 'personal' as const }
    await pool.query("UPDATE harness.instances SET last_activity_at='2001-01-01' WHERE runtime_id=$1", [f.personal.id])
    const holder = await pool.connect()
    let preparing: Promise<unknown> | undefined
    const blocked = deferred<never>()
    const deadline = AbortSignal.timeout(2_000)
    const reportTimeout = (): void => blocked.reject(deadline.reason)
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT 1 FROM harness.instances WHERE runtime_id=$1 FOR SHARE', [f.personal.id])
      preparing = f.admission.admitSession(request, generation, undefined, false)
      deadline.addEventListener('abort', reportTimeout, { once: true })
      await expect(Promise.race([preparing, blocked.promise])).resolves.toMatchObject({
        user: { id: f.member.id }, scope: { kind: 'personal' }, snapshot: { generation, target },
      })
      expect((await holder.query<{ unchanged: boolean }>(
        "SELECT last_activity_at='2001-01-01' unchanged FROM harness.instances WHERE runtime_id=$1", [f.personal.id],
      )).rows[0]?.unchanged).toBe(true)
    } finally {
      deadline.removeEventListener('abort', reportTimeout)
      try { await holder.query('ROLLBACK') } finally { holder.release() }
      await Promise.allSettled(preparing === undefined ? [] : [preparing])
    }
    await f.repository.touch(target, Date.UTC(2002, 5, 1), generation)
    expect((await pool.query<{ last_activity_at: Date }>('SELECT last_activity_at FROM harness.instances WHERE runtime_id=$1',
      [f.personal.id])).rows[0]!.last_activity_at).toEqual(new Date(Date.UTC(2002, 5, 1)))
  })

  it('records completed activity monotonically and leaves a replacement generation untouched', async () => {
    const f = await fixture()
    const target = { kind: 'user' as const, id: f.member.id, runtimeId: f.personal.id }
    const generation = await f.repository.generationOf(target)
    await pool.query("UPDATE harness.instances SET last_activity_at='2001-01-01' WHERE runtime_id=$1", [f.personal.id])
    const newer = Date.UTC(2002, 5, 1)
    await f.repository.touch(target, newer, generation)
    await f.repository.touch(target, newer - 1_000, generation)
    await pool.query('UPDATE harness.instances SET generation=generation+1 WHERE runtime_id=$1', [f.personal.id])
    await f.repository.touch(target, newer + 1_000, generation)
    const observed = await pool.query<{ last_activity_at: Date }>('SELECT last_activity_at FROM harness.instances WHERE runtime_id=$1', [f.personal.id])
    expect(observed.rows[0]!.last_activity_at.getTime()).toBe(newer)
  })

  const revocationCases = ['session', 'computer-grant', 'maintenance', 'write-epoch', 'generation', 'project-mount', 'issuer-revision'] as const
  it.each(revocationCases.flatMap(change => (change === 'project-mount' ? [true] : [true, false])
    .map(recordActivity => ({ change, recordActivity }))))(
    'rechecks $change after the instance lock with start activity $recordActivity', async ({ change, recordActivity }) => {
    const f = await fixture()
    const runtimeId = change === 'project-mount' ? f.shared.id : f.personal.id
    const request = { ...f.request, runtimeId, nodeId: f.context.nodeId as RuntimeNodeId,
      target: change === 'project-mount' ? `project:${f.project.id}` as const : 'personal' as const }
    let issuer: { nodeId: RuntimeNodeId; publicKey: string } | undefined
    if (change === 'issuer-revision') {
      issuer = { nodeId: request.nodeId, publicKey: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString() }
      await pool.query('UPDATE harness.compute_nodes SET principal_public_key=$2 WHERE id=$1', [issuer.nodeId, issuer.publicKey])
    }
    const holder = await pool.connect()
    try {
      await holder.query('BEGIN')
      const locked = (await holder.query<{ generation: string; pid: number }>(
        'SELECT generation::text,pg_backend_pid() pid FROM harness.instances WHERE runtime_id=$1 FOR UPDATE', [runtimeId])).rows[0]!
      const settled = f.admission.admitSession(request, Number(locked.generation), issuer, recordActivity)
        .then(value => ({ value }), (error: unknown) => ({ error }))
      let result: Awaited<typeof settled>
      try {
        await expect.poll(async () => (await pool.query<{ blocked: boolean }>(
          'SELECT EXISTS(SELECT FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked', [locked.pid])).rows[0]!.blocked).toBe(true)
        if (change === 'session') await f.auth.revoke(f.request.sessionToken)
        else if (change === 'computer-grant') {
          await holder.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1', [f.organizationId])
        } else if (change === 'maintenance') {
          await holder.query(`INSERT INTO harness.cluster_control (organization_id,mode) VALUES($1,'maintenance')`, [f.organizationId])
        } else if (change === 'write-epoch') {
          await holder.query('INSERT INTO harness.cluster_control (organization_id,write_epoch) VALUES($1,$2)', [f.organizationId, String(f.writeEpoch + 1n)])
        } else if (change === 'generation') {
          await holder.query('UPDATE harness.instances SET generation=generation+1 WHERE runtime_id=$1', [runtimeId])
        } else if (change === 'issuer-revision') {
          await holder.query('SELECT harness.invalidate_access($1,$2)', [f.organizationId, { userId: f.admin.id }])
        } else {
          await holder.query("UPDATE harness.project_mounts SET local_path=local_path||'-moved' WHERE organization_id=$1", [f.organizationId])
        }
      } finally {
        // Release the instance lock before awaiting the admission that it blocks.
        await holder.query('COMMIT')
        result = await settled
      }
      if (change === 'generation') expect(result).toEqual({ value: null })
      else if (change === 'issuer-revision') expect(result).toMatchObject({ error: { status: 409, code: 'RUNTIME_LEASE_UNAVAILABLE' } })
      else expect(result).toMatchObject({ error: change === 'maintenance' || change === 'write-epoch'
        ? { status: 503, code: change === 'maintenance' ? 'maintenance' : 'stale-epoch' }
        : { status: 403 } })
    } finally { holder.release() }
  })

  it('serves the same versioned Session operations through a live Gateway with fewer governance statements', async () => {
    const f = await fixture()
    const nodeId = f.context.nodeId as RuntimeNodeId
    const pair = generateKeyPairSync('ed25519')
    const signer = new GatewayPrincipalSigner(pair.privateKey, f.cfg.organizationSlug, 30_000)
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    await pool.query('UPDATE harness.compute_nodes SET principal_public_key=$2 WHERE id=$1', [nodeId, pem])
    const publishedKeys = new NodePrincipalDirectory(f.context, 1)
    await publishedKeys.issuerKey(nodeId)
    const audience = { audienceNode: nodeId, organization: f.cfg.organizationSlug }
    const consumed = new Set<string>()
    const consume = (claims: GatewayForwardClaims): boolean => {
      if (consumed.has(claims.nonce)) return false
      consumed.add(claims.nonce)
      return true
    }
    const listen = async (server: Server): Promise<string> => {
      releases.push(() => new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); server.close(error => error ? reject(error) : resolve())
      }))
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
    const upstreamRequest = vi.fn()
    const upstream = createServer(async (req, res) => {
      upstreamRequest()
      const assertion = req.headers[PRINCIPAL_HEADER]
      if (typeof assertion !== 'string') { res.writeHead(403).end(); return }
      const principal = signer.verify(assertion)
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ scope: principal.scope, user: principal.user.id, runtime: principal.runtime,
        path: req.url, payload: Buffer.concat(chunks).toString() }))
    })
    await listen(upstream)
    const sockets = new WebSocketServer({ noServer: true })
    releases.push(() => new Promise<void>((done, fail) => {
      for (const socket of sockets.clients) socket.terminate()
      sockets.close(error => error ? fail(error) : done())
    }))
    const upgraded = vi.fn()
    upstream.on('upgrade', (req, socket, head) => {
      const assertion = req.headers[PRINCIPAL_HEADER]
      if (typeof assertion !== 'string') { socket.destroy(); return }
      upgraded()
      sockets.handleUpgrade(req, socket, head, ws => {
        const { user, runtime, expiresAt, issuedAt } = signer.verify(assertion)
        ws.send(JSON.stringify({ user: user.id, runtime, lifespan: expiresAt - issuedAt, retainedCookie: req.headers.cookie !== undefined }))
      })
    })
    f.cfg.dshRepoRoot = f.root
    f.cfg.modelGovernancePackage = f.root
    f.cfg.steward.toolsPackage = f.root
    f.cfg.dshCommand = [process.execPath]
    f.cfg.guardPatch = ''
    f.cfg.performanceEnabled = true
    await writeFile(join(f.root, 'package.json'), '{}\n')
    await writeFile(join(f.root, 'cordis.patch.yml'), '[]\n')
    const launchStamp = [...computeLaunchStamps(f.cfg, '', INSTANCE_PROFILE).stamps][0]!
    await pool.query('UPDATE harness.instances SET launch_stamp=$2,port=$3 WHERE runtime_id=$1',
      [f.personal.id, launchStamp, (upstream.address() as AddressInfo).port])
    const start = vi.fn(async () => { throw new Error('Ready Session admission must use the tracked Runtime') })
    const instances = new InstanceManager(f.repository, f.cfg, {
      instancesOutliveGateway: true, start, attach: () => ({ hasExited: () => false, isAlive: async () => true, terminate: async () => {} }),
    }, undefined, f.budget)
    releases.push(() => instances.stopAll())
    const target = { kind: 'user' as const, id: f.member.id, runtimeId: f.personal.id }
    const generation = await f.repository.generationOf(target)
    await expect(instances.liveEndpoint(target)).resolves.toMatchObject({ generation })
    const monitor = new PostgresAccessMonitor(f.context, 60_000)
    releases.push(() => monitor.close())
    await monitor.synchronize()
    const catalog = new PostgresRuntimeCatalog(f.context, f.cfg.runtimeCatalog)
    const collaboration = new PostgresCollaborationService(f.context)
    const deps: GatewayDeps = { cfg: f.cfg, instances, users: f.users, projects: f.projects, auth: f.auth,
      audit: new PostgresAuditService(f.context), collaboration, accessMonitor: monitor, runtimeCatalog: catalog,
      revalidateOnComputer: token => f.auth.validateOnComputer(token),
      maintenanceGate: async () => (await f.maintenance.writeGate(f.writeEpoch)).verdict,
      computerAccess: new PostgresComputerAccess(f.context, f.cfg.runtimeCatalog, nodeId),
      nodeServiceIdentity: { nodeId, organizationId: f.context.organizationId, authorize: async () => { throw new Error('Not a node enrollment') } },
      forwardedSessionPrincipal: assertion => {
        const issuerNode = forwardIssuerOf(assertion)
        const issuerPublicKey = issuerNode === null ? null : publishedKeys.publishedKeyCandidate(issuerNode)
        const claims = issuerPublicKey === null ? null : verifyGatewayForward(assertion, issuerPublicKey, audience)
        return claims === null || issuerPublicKey === null ? null : { claims, issuerPublicKey, consume: () => consume(claims) }
      },
      forwardedPrincipal: async assertion => {
        const issuerNode = forwardIssuerOf(assertion)
        const issuerKey = issuerNode === null ? null : await new NodePrincipalDirectory(f.context, 1).issuerKey(issuerNode)
        const claims = issuerKey === null ? null : verifyGatewayForward(assertion, issuerKey, audience)
        return claims !== null && consume(claims) ? claims : null
      },
      runtimeRouter: new GatewayRuntimeRouter(new LocalRuntimeAdapter({ collaboration, instances }), { catalog, localNodeId: nodeId }),
    }
    const handlers = createProxyHandlers(deps, signer, f.admission)
    releases.push(async () => { handlers.close() })
    const baseline = await listen(createGatewayServer(deps, { ...handlers, readySession: undefined }))
    const forwardedBaseline = await listen(createGatewayServer({ ...deps, forwardedSessionPrincipal: undefined }, handlers))
    const readySession = vi.fn(handlers.readySession)
    const candidate = await listen(createGatewayServer(deps, { ...handlers, readySession }))
    f.cfg.publicOrigins.push(baseline, forwardedBaseline, candidate)
    const admin = await f.auth.login(f.admin.username, 'pw-12345678', '127.0.0.1', 'asset-fixture')
    if (typeof admin === 'string') throw new Error(admin)
    let browserToken = f.request.sessionToken
    const sendRequest = (entry: string, path: string, body: string, id = randomUUID(), headers?: Record<string, string>) =>
      fetch(`${entry}${path}?dshRuntime=${f.personal.id}&dshTarget=personal&dshNode=${nodeId}`,
        { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${browserToken}`, origin: entry,
          'content-type': 'application/json', 'x-dsh-operation-id': id, ...headers }, body })
    const request = async (...args: Parameters<typeof sendRequest>) => {
      const response = await sendRequest(...args)
      expect(response.status, response.ok ? args[1] : `${args[1]}: ${await response.text()}`).toBe(200)
      return response
    }
    const measure = async (entry: string, path: string, body: string, headers?: Record<string, string>) => {
      const id = randomUUID()
      const response = await request(entry, path, body, id, headers)
      const runtimeId = response.headers.get('x-dsh-runtime-id')
      const data = await response.json()
      const observations = await fetch(`${entry}/admin/api/performance/operations?id=${id}`, { headers: { cookie: `${SESSION_COOKIE}=${admin.token}` } })
      expect(observations.status).toBe(200)
      const metrics = await observations.json() as { operations: Array<{
        phases: { runtimeQueue?: number; runtimeLiveness?: number }
        sql: { governance: { count: number } }
        readySession?: unknown
      }> }
      expect(metrics.operations).toHaveLength(1)
      const { phases, sql: { governance }, readySession: decisions } = metrics.operations[0]!
      return { runtimeId, data, phases, governance, decisions }
    }
    const sessionId = 'fixture-history', requestId = randomUUID()
    for (const [path, method, payload] of [
      ['/api/prepare/v1/session.history', 'session.history', { sessionId }],
      ['/api/prepare/v1/session.create', 'session.create', { draftId: `draft-${requestId}` }],
      ['/api/admit/v1/session.prompt', 'session.prompt', { sessionId, requestId, prompt: 'fixture-input' }],
      ['/api/admit/v1/session.status', 'session.promptStatus', { sessionId, requestId, confirmInput: true }],
    ] as const) {
      const body = JSON.stringify({ type: 'client-request', rpcId: 'fixture', method, payload })
      const before = await measure(baseline, path, body)
      const after = await measure(candidate, path, body)
      expect([before.runtimeId, after.runtimeId]).toEqual([f.personal.id, f.personal.id])
      expect(after.data).toEqual(before.data)
      expect(after.data).toMatchObject({ user: f.member.id, runtime: { runtimeId: f.personal.id, generation }, path, payload: body })
      expect(after.governance.count, `${method} ready Session statements`).toBe(3)
      expect(before.governance.count - after.governance.count, `${method} statements removed`).toBeGreaterThanOrEqual(5)
      expect(after.phases.runtimeQueue).toBeGreaterThanOrEqual(0)
      expect(after.phases.runtimeLiveness).toBeGreaterThanOrEqual(0)
      expect(after.decisions).toEqual({ ordinary: { ready: 1 } })
      expect(before.decisions).toBeUndefined()
    }
    expect(readySession).toHaveBeenCalledTimes(4)
    const legacy = '/api/session.history'
    const body = JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'session.history', payload: { sessionId } })
    expect(await (await request(candidate, legacy, body)).json()).toMatchObject({ path: legacy, payload: body })
    expect(readySession).toHaveBeenCalledTimes(4)
    const path = '/api/admit/v1/session.prompt'
    const payload = JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: 'session.prompt', payload: { sessionId, requestId, prompt: 'fixture-input' } })
    const forwardedHeaders = (requestPath = path, user = f.member, accessRevision?: string): Record<string, string> => ({
      [NODE_SERVICE_TARGET_HEADER]: nodeId,
      'x-dsh-gateway-forward': signer.issueForward({ issuerNode: nodeId, audienceNode: nodeId, user, accessRevision,
        selection: { runtimeId: f.personal.id, target: 'personal' },
        context: { environment: { id: f.personal.id, nodeId } },
        request: { method: 'POST', path: requestPath, sessionHash: createHash('sha256').update(browserToken).digest('hex') },
      }),
    })
    const forwarded = forwardedHeaders()
    const before = await measure(forwardedBaseline, path, payload, forwardedHeaders())
    const after = await measure(candidate, path, payload, forwarded)
    expect([before.runtimeId, after.runtimeId]).toEqual([f.personal.id, f.personal.id])
    expect(after.data).toEqual(before.data)
    expect(before.governance.count - after.governance.count).toBe(1)
    expect(before.decisions).toEqual({ forwarded: { fallbackCandidate: 1 }, ordinary: { ready: 1 } })
    expect(after.decisions).toEqual({ forwarded: { ready: 1 } })
    expect(readySession).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ forwarded: expect.anything() }))
    expect(consumed.size).toBe(2)
    const replay = await fetch(`${candidate}${path}?dshRuntime=${f.personal.id}&dshTarget=personal&dshNode=${nodeId}`, {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${f.request.sessionToken}`, origin: candidate,
        'content-type': 'application/json', ...forwarded }, body: payload,
    })
    expect(replay.status).toBe(409)
    expect(await replay.json()).toMatchObject({ error: { code: 'RUNTIME_LEASE_UNAVAILABLE' } })
    expect(start).not.toHaveBeenCalled()

    const wsRef = vi.spyOn(instances, 'wsRef')
    const synchronized = vi.spyOn(monitor, 'synchronizeTo')
    const event = (url: string, header: Record<string, string> = {}) => new Promise<unknown>((done, fail) => {
      const ws = new WebSocket(url.replace('http:', 'ws:'), { origin: candidate, handshakeTimeout: 5_000,
        headers: { cookie: `${SESSION_COOKIE}=${f.request.sessionToken}`, ...header } })
      ws.once('error', fail)
      ws.once('message', frame => {
        let result: unknown
        try { result = JSON.parse(frame.toString()) } catch (error) { fail(error) }
        ws.once('close', () => done(result))
        ws.close()
      })
    })
    const coordinates = `?dshRuntime=${f.personal.id}&dshTarget=personal&dshNode=${nodeId}`
    const eventURL = `${candidate}/api/events.mux${coordinates}`
    await expect(event(eventURL)).resolves.toMatchObject({ user: f.member.id,
      runtime: { runtimeId: f.personal.id, generation }, lifespan: 30_000, retainedCookie: false })
    expect(wsRef).not.toHaveBeenCalled()
    expect(synchronized).toHaveBeenCalledOnce()
    expect(upgraded).toHaveBeenCalledOnce()
    const login = await f.auth.qualifyForStream(f.request.sessionToken)
    if (login === null) throw new Error('Expected eligible browser login for an event stream')
    const forwardEvent = {
      [NODE_SERVICE_TARGET_HEADER]: nodeId,
      'x-dsh-gateway-forward': signer.issueForward({ issuerNode: nodeId, audienceNode: nodeId, user: login.user,
        selection: { runtimeId: f.personal.id, target: 'personal' },
        context: { environment: { id: f.personal.id, nodeId } },
        request: { method: 'GET', path: '/api/events.mux', sessionHash: createHash('sha256').update(f.request.sessionToken).digest('hex') },
      }),
    }
    await expect(event(eventURL, forwardEvent)).resolves.toMatchObject({ runtime: { runtimeId: f.personal.id, generation } })
    expect(upgraded).toHaveBeenCalledTimes(2)
    synchronized.mockResolvedValueOnce(false)
    await expect(event(eventURL)).rejects.toThrow()
    expect(upgraded).toHaveBeenCalledTimes(2)
    expect(wsRef).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()

    const principal = { 'x-dsh-expected-principal-id': String(f.member.id) }
    for (const [readMethod, input] of [
      ['host.describe', {}], ['workspace.list', {}], ['session.list', {}],
      ['session.history', { sessionId, beforeSeq: 17, maxMessages: 50, detail: 'conversation' }],
    ] as const) {
      const readPath = `/api/${readMethod}`
      const envelope = JSON.stringify({ type: 'client-request', rpcId: 'read', method: readMethod, payload: input })
      const ordinary = await request(baseline, readPath, envelope, randomUUID(), principal)
      const prepared = await request(candidate, readPath, envelope, randomUUID(), { ...principal, ...forwardedHeaders(readPath) })
      expect(prepared.headers.get('x-dsh-runtime-id')).toBe(f.personal.id)
      expect(await prepared.json()).toEqual(await ordinary.json())
      expect(readySession).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
        expect.objectContaining({ runtimeId: f.personal.id, nodeId, target: 'personal', forwarded: expect.anything() }))
    }
    const filesPath = '/api/workspaceFiles.list'
    const filesBody = JSON.stringify({ type: 'client-request', rpcId: 'files', method: 'workspaceFiles.list', payload: { sessionId, path: '.' } })
    const appliedRevision = monitor.currentRevision()?.toString()
    expect(appliedRevision).toBeDefined()
    const listHeaders = () => ({ ...principal, ...forwardedHeaders(filesPath, login.user, appliedRevision) })
    const ordinaryFiles = await measure(baseline, filesPath, filesBody, listHeaders())
    const readyFiles = await measure(candidate, filesPath, filesBody, listHeaders())
    expect(readyFiles.data).toEqual(ordinaryFiles.data)
    expect(readyFiles.data).toMatchObject({ user: f.member.id, scope: { kind: 'personal' },
      path: filesPath, payload: filesBody, runtime: { runtimeId: f.personal.id, generation } })
    expect(readyFiles.decisions).toEqual({ forwarded: { ready: 1 } })
    expect(readyFiles.runtimeId).toBe(f.personal.id)
    expect(ordinaryFiles.decisions).toBeUndefined()
    expect(readyFiles.governance.count, 'forwarded file list governance statements before response').toBe(1)
    expect(ordinaryFiles.governance.count - readyFiles.governance.count, 'file list statements removed').toBeGreaterThanOrEqual(5)
    expect(readySession).toHaveBeenLastCalledWith(expect.anything(), expect.anything(),
      expect.not.objectContaining({ managedPersonalRead: true }))
    const unboundFiles = await measure(candidate, filesPath, filesBody, forwardedHeaders(filesPath, login.user, appliedRevision))
    expect(unboundFiles.data).toEqual(ordinaryFiles.data)
    expect(unboundFiles.decisions).toBeUndefined()

    const boot = (entry: string, requestPrincipal: string, session = f.request.sessionToken) =>
      fetch(`${entry}/${coordinates}&dshBootstrap=1`, { headers: {
        cookie: `${SESSION_COOKIE}=${session}`, accept: 'application/json', 'x-dsh-expected-principal-id': requestPrincipal,
      } })
    const legacyBoot = await boot(baseline, String(f.member.id))
    const readyBoot = await boot(candidate, String(f.member.id))
    expect(readyBoot.status).toBe(200)
    expect(readyBoot.headers.get('x-dsh-runtime-id')).toBe(f.personal.id)
    expect(await readyBoot.json()).toEqual(await legacyBoot.json())
    const acceptedReads = readySession.mock.calls.length
    expect((await boot(candidate, String(f.admin.id))).status).toBe(409)
    expect((await boot(candidate, String(f.member.id), 'unknown-token')).status).toBe(401)
    expect(readySession).toHaveBeenCalledTimes(acceptedReads)
    expect(start).not.toHaveBeenCalled()

    await pool.query("INSERT INTO harness.cluster_control(organization_id,mode) VALUES($1,'maintenance')", [f.organizationId])
    const refused = await fetch(`${candidate}/api/prepare/v1/session.history?dshRuntime=${f.personal.id}&dshTarget=personal&dshNode=${nodeId}`,
      { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${f.request.sessionToken}`, origin: candidate,
        'content-type': 'application/json' }, body })
    expect(refused.status).toBe(503)
    expect(await refused.json()).toEqual({ error: 'maintenance' })
    const refusedRead = await fetch(`${candidate}/api/session.history${coordinates}`, { method: 'POST', headers: {
      cookie: `${SESSION_COOKIE}=${f.request.sessionToken}`, origin: candidate, 'content-type': 'application/json', ...principal,
    }, body })
    expect(refusedRead.status).toBe(503)
    await refusedRead.body?.cancel()
    const dispatchedBeforeMaintenanceList = upstreamRequest.mock.calls.length
    const maintenanceFiles = await sendRequest(candidate, filesPath, filesBody, randomUUID(), listHeaders())
    expect(maintenanceFiles.status).toBe(503)
    expect(await maintenanceFiles.json()).toEqual({ error: 'maintenance' })
    expect(upstreamRequest).toHaveBeenCalledTimes(dispatchedBeforeMaintenanceList)
    const maintenanceBoot = await boot(candidate, String(f.member.id))
    expect(maintenanceBoot.status).toBe(200)
    expect(await maintenanceBoot.json()).toEqual(await (await boot(baseline, String(f.member.id))).json())
    const performance = await fetch(`${candidate}/admin/api/performance`, { headers: { cookie: `${SESSION_COOKIE}=${admin.token}` } })
    expect(performance.status).toBe(200)
    expect(await performance.json()).toMatchObject({
      readySession: { ordinary: { ready: 5, refused: 2, fallbackMaintenance: 1 }, forwarded: { ready: 6, refused: 2 } },
    })

    await pool.query("UPDATE harness.cluster_control SET mode='serving' WHERE organization_id=$1", [f.organizationId])
    const dispatchedBeforeRevocation = upstreamRequest.mock.calls.length
    await f.auth.revoke(browserToken)
    await monitor.synchronize()
    const revokedFiles = await sendRequest(candidate, filesPath, filesBody, randomUUID(), listHeaders())
    expect(revokedFiles.status).toBe(403)
    expect(await revokedFiles.json()).toEqual({ error: 'access-revoked' })
    expect(upstreamRequest).toHaveBeenCalledTimes(dispatchedBeforeRevocation)

    const renewedLogin = await f.auth.login(f.member.username, 'pw-12345678', '127.0.0.1', 'asset-fixture')
    if (typeof renewedLogin === 'string') throw new Error(renewedLogin)
    browserToken = renewedLogin.token
    await pool.query("UPDATE harness.instances SET generation=generation+1,observed_state='stopped',desired_state='stopped',stop_reason='manual' WHERE runtime_id=$1",
      [f.personal.id])
    const staleFiles = await sendRequest(candidate, filesPath, filesBody, randomUUID(), listHeaders())
    expect(staleFiles.status).toBe(409)
    expect(await staleFiles.json()).toMatchObject({ error: { code: 'INSTANCE_STOPPED' } })
    expect(upstreamRequest).toHaveBeenCalledTimes(dispatchedBeforeRevocation)
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses revoked sessions, foreign owners, duplicate-owner guesses and mismatched explicit scope or computer', async () => {
    const f = await fixture()
    await expect(f.admission.admit({ ...f.request, actorId: f.admin.id })).rejects.toMatchObject({ status: 403 })
    await expect(f.admission.admit({ ...f.request, entryNodeId: f.other.nodeId as RuntimeNodeId })).rejects.toMatchObject({ status: 403 })
    await expect(f.admission.admit({ ...f.request, runtimeId: randomUUID() as RuntimeId })).rejects.toMatchObject({ status: 403 })
    await expect(f.admission.admit({ ...f.request, nodeId: f.other.nodeId as RuntimeNodeId })).rejects.toMatchObject({ status: 409 })
    await expect(f.admission.admit({ ...f.request, target: `project:${f.project.id}` })).rejects.toMatchObject({ status: 409 })
    await f.auth.revoke(f.request.sessionToken)
    await expect(f.admission.admit(f.request)).rejects.toMatchObject({ status: 403 })
  })

  it.each(['project-member', 'computer-grant', 'password', 'membership', 'account', 'organization', 'retired', 'mount'] as const)(
    'refuses the next resource after %s authority is withdrawn', async change => {
      const f = await fixture()
      const request = { ...f.request, runtimeId: f.shared.id }
      await expect(f.admission.admit(request)).resolves.toMatchObject({ scope: { kind: 'project' } })
      if (change === 'project-member') await f.projects.removeMember(f.project.id, f.member.id, f.admin.id)
      else if (change === 'computer-grant') await pool.query('UPDATE harness.computer_use_permissions SET enabled=false WHERE organization_id=$1', [f.organizationId])
      else if (change === 'password') await pool.query('UPDATE harness.password_credentials SET must_change_password=true WHERE user_id IN (SELECT id FROM harness.users WHERE organization_id=$1)', [f.organizationId])
      else if (change === 'membership') await pool.query("UPDATE harness.memberships SET status='disabled' WHERE organization_id=$1", [f.organizationId])
      else if (change === 'account') await f.users.setStatus(f.member.id, 'disabled')
      else if (change === 'organization') await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.organizationId])
      else if (change === 'retired') await pool.query('UPDATE harness.runtime_environments SET retired_at=clock_timestamp() WHERE id=$1', [f.shared.id])
      else await pool.query("UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1", [f.organizationId])
      await expect(f.admission.admit(request)).rejects.toMatchObject({ status: 403 })
    },
  )

  it.each(['stopped', 'registration', 'generation', 'provisioning', 'node'] as const)('refuses unavailable %s without changing its assignment', async change => {
    const f = await fixture()
    if (change === 'stopped') await pool.query("UPDATE harness.instances SET observed_state='stopped',desired_state='stopped' WHERE runtime_id=$1", [f.personal.id])
    else if (change === 'registration') await pool.query('DELETE FROM harness.node_resource_runtimes WHERE runtime_id=$1', [f.personal.id])
    else if (change === 'generation') await pool.query('UPDATE harness.instances SET generation=generation+1 WHERE runtime_id=$1', [f.personal.id])
    else if (change === 'provisioning') {
      const user = (await pool.query<{ id: string }>('SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [f.organizationId, f.member.id])).rows[0]!.id
      f.request.runtimeId = (await pool.query<{ runtime_id: RuntimeId }>(`INSERT INTO harness.instances
        (organization_id,user_id,assigned_node_id,port,storage_layout,provisioning_state)
        VALUES($1,$2,$3,65520,'isolated','preparing') RETURNING runtime_id`, [f.organizationId, user, f.context.nodeId])).rows[0]!.runtime_id
    }
    else await pool.query("UPDATE harness.compute_nodes SET status='offline' WHERE id=$1", [f.context.nodeId])
    const before = (await pool.query('SELECT generation,observed_state,last_activity_at FROM harness.instances WHERE runtime_id=$1', [f.personal.id])).rows
    await expect(f.admission.admit(f.request)).rejects.toMatchObject({ status: 503 })
    expect((await pool.query('SELECT generation,observed_state,last_activity_at FROM harness.instances WHERE runtime_id=$1', [f.personal.id])).rows).toEqual(before)
  })

  it('preserves manual-stop refusal without changing the stopped generation or its activity', async () => {
    const f = await fixture()
    await pool.query("UPDATE harness.instances SET observed_state='stopped',desired_state='stopped',stop_reason='manual' WHERE runtime_id=$1", [f.personal.id])
    const before = (await pool.query('SELECT generation,observed_state,last_activity_at FROM harness.instances WHERE runtime_id=$1', [f.personal.id])).rows
    await expect(f.admission.admit(f.request)).rejects.toMatchObject({ status: 409, code: 'INSTANCE_STOPPED' })
    expect((await pool.query('SELECT generation,observed_state,last_activity_at FROM harness.instances WHERE runtime_id=$1', [f.personal.id])).rows).toEqual(before)
  })

  it.each(['expiry', 'connection', 'epoch'] as const)('refuses a managed generation after its %s changes without rotating its identity', async change => {
    const f = await fixture()
    await pool.query("UPDATE harness.instances SET observed_state='stopped',desired_state='stopped' WHERE organization_id=$1", [f.organizationId])
    await pool.query(`UPDATE harness.deployment_topology SET enabled=true,primary_node_id=$2,
      primary_origin='http://127.0.0.1:1',revision=revision+1 WHERE organization_id=$1`, [f.organizationId, f.other.nodeId])
    const connection = randomUUID()
    await pool.query(`INSERT INTO harness.node_agents(organization_id,node_id,credential_hash,attachment_state,connection_id,connection_epoch,lease_expires_at)
      VALUES($1,$2,$3,'managed',$4,5,clock_timestamp()+interval '60 seconds')`,
    [f.organizationId, f.context.nodeId, createHash('sha256').update(randomUUID()).digest(), connection])
    const target = { kind: 'user' as const, id: f.member.id, runtimeId: f.personal.id }
    const generation = await f.repository.beginStart(target, Date.now(), createHash('sha256').update(randomUUID()).digest(), 'explicit', undefined, true, 'fixture-stamp')
    await f.repository.markReady(target, generation)
    await f.budget.register({ organizationId: f.organizationId, target, generation })
    const admitted = await f.admission.admit(f.request)
    expect(admitted.expiresAt - Date.now()).toBeLessThanOrEqual(60_000)
    expect(await f.admission.admit({ ...f.request, entryNodeId: f.other.nodeId as RuntimeNodeId })).toMatchObject({ snapshot: { generation } })
    if (change === 'expiry') await pool.query("UPDATE harness.node_agents SET lease_expires_at=clock_timestamp() WHERE node_id=$1", [f.context.nodeId])
    else if (change === 'connection') await pool.query('UPDATE harness.node_agents SET connection_id=$2 WHERE node_id=$1', [f.context.nodeId, randomUUID()])
    else await pool.query('UPDATE harness.node_agents SET connection_epoch=connection_epoch+1 WHERE node_id=$1', [f.context.nodeId])
    await expect(f.admission.admit(f.request)).rejects.toMatchObject({ status: 503 })
    expect(await f.repository.generationOf(target)).toBe(generation)
  })

  it.each(['revocation', 'monitor-disconnect'] as const)('closes an admitted resource stream after a real PostgreSQL %s', async change => {
    const f = await fixture(), entered = barrier(), released = barrier(), cancelled = barrier()
    const listen = async (server: Server): Promise<number> => {
      releases.push(() => new Promise<void>((resolve, reject) => {
        server.closeAllConnections(); server.close(error => error ? reject(error) : resolve())
      }))
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      return (server.address() as AddressInfo).port
    }
    const upstream = createServer((req, res) => { req.resume(); res.write('authorized-prefix'); entered.resolve() })
    const port = await listen(upstream)
    await pool.query('UPDATE harness.instances SET port=$2 WHERE runtime_id=$1', [f.personal.id, port])
    const monitor = new PostgresAccessMonitor(f.context, 60_000)
    releases.push(() => monitor.close())
    await monitor.synchronize()
    const unsubscribe = monitor.subscribe(() => { cancelled.resolve() })
    releases.push(async () => { unsubscribe() })
    let references = 0
    const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, f.cfg.organizationSlug, 30_000)
    const assets = new RuntimeAssets({ cfg: f.cfg, localNodeId: f.context.nodeId as RuntimeNodeId,
      admission: f.admission, monitor, signer, instances: {
        async retainAsset(_runtimeId, qualify) {
          const admission = await qualify()
          references += 1
          let disposed = false
          return { admission, release() { if (!disposed) { disposed = true; references -= 1; released.resolve() } } }
        },
      } })
    releases.push(() => assets.close())
    const server = createServer((req, res) => {
      void assets.handle(req, res, f.member).catch(() => { res.destroy() })
    })
    const origin = `http://127.0.0.1:${String(await listen(server))}`
    const response = await fetch(`${origin}/plugins/combo.js??fixture/client.js&rev=012345abcdef&dshRuntime=${f.personal.id}`,
      { headers: { cookie: `hgw_session=${f.request.sessionToken}` } })
    const reader = response.body!.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('authorized-prefix')
      await entered.promise
      expect(references).toBe(1)
      const pending = reader.read().then<unknown, unknown>(value => value, error => error)
      if (change === 'revocation') { await f.users.setStatus(f.member.id, 'disabled'); await monitor.synchronize() }
      else {
        const terminated = await pool.query<{ stopped: boolean }>(
          'SELECT pg_terminate_backend(pid) stopped FROM pg_stat_activity WHERE application_name=$1', [`hgw-access:${f.context.nodeName}`])
        expect(terminated.rows).toEqual([{ stopped: true }])
      }
      await cancelled.promise
      await pending; await released.promise
      expect(references).toBe(0)
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  })

  it('requires exact revision identity and never repeats a read for an already applied revision', async () => {
    const f = await fixture()
    const monitor = new PostgresAccessMonitor(f.context, 60_000)
    releases.push(() => monitor.close())
    await monitor.synchronize()
    const revision = BigInt((await f.admission.admit(f.request)).accessRevision)
    const synchronize = vi.spyOn(monitor, 'synchronize')
    expect(await monitor.synchronizeTo(revision)).toBe(true)
    expect(synchronize).not.toHaveBeenCalled()
    await f.users.setStatus(f.member.id, 'disabled')
    await monitor.synchronize()
    expect(await monitor.synchronizeTo(revision)).toBe(false)
    const fresh = BigInt((await pool.query<{ revision: string }>('SELECT access_revision::text revision FROM harness.organizations WHERE id=$1', [f.organizationId])).rows[0]!.revision)
    expect(await monitor.synchronizeTo(fresh)).toBe(true)
  })
})
