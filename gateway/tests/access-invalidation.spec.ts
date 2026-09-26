import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { PostgresAccessMonitor, type AccessInvalidationSubject } from '../src/access-invalidation.ts'
import { loadConfig } from '../src/config.ts'
import { createGatewayDocumentScopeHandler, type GatewayDocumentScopeHandler } from '../src/document-transfer.ts'
import { PostgresAuditService } from '../src/postgres/audit-service.ts'
import { PostgresAuthService } from '../src/postgres/auth-service.ts'
import { PostgresCollaborationService } from '../src/postgres/collaboration-service.ts'
import { createPostgresPool, runMigrations } from '../src/postgres/database.ts'
import { PostgresProjectService } from '../src/postgres/project-service.ts'
import type { PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import { PostgresUserService } from '../src/postgres/user-service.ts'
import { createProxyHandlers } from '../src/proxy.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { barrier } from './barrier.ts'

// This suite owns a disposable PostgreSQL database, like postgres.spec.ts.
const databaseUrl = process.env.HGW_TEST_DATABASE_URL
const describePg = databaseUrl === undefined ? describe.skip : describe
const migrations = resolve(import.meta.dirname, '../deploy/postgres/migrations')
let pool: Pool
let cleanup: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const dispose of cleanup.reverse()) await dispose(); cleanup = [] })

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolveListen => { server.listen(0, '127.0.0.1', resolveListen) })
  cleanup.push(() => new Promise<void>((resolveClose, reject) => {
    server.closeAllConnections()
    server.close(error => { if (error) reject(error); else resolveClose() })
  }))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

async function fixture(options: {
  runtime?: (req: IncomingMessage, res: ServerResponse) => boolean
  wrapDocumentScope?: (handler: GatewayDocumentScopeHandler) => GatewayDocumentScopeHandler
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'hgw-access-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const slug = randomUUID()
  const organization = await pool.query<{ id: string }>(
    'INSERT INTO harness.organizations(slug,display_name) VALUES($1::text,$1::text) RETURNING id', [slug],
  )
  const organizationId = organization.rows[0]!.id
  const contexts: PostgresRuntimeContext[] = []
  for (const name of ['first', 'second']) {
    const nodeName = `${slug}-${name}`
    const node = await pool.query<{ id: string }>(
      'INSERT INTO harness.compute_nodes(organization_id,name) VALUES($1,$2) RETURNING id', [organizationId, nodeName],
    )
    contexts.push({ pool, organizationId, organizationSlug: slug, nodeName, nodeId: node.rows[0]!.id })
  }
  const context = contexts[0]!
  const cfg = loadConfig({ HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECT_RUNTIMES_ROOT: join(root, 'runtimes') })
  const users = new PostgresUserService(context, cfg)
  const alice = await users.create({ username: 'alice', password: 'password-123' })
  const bob = await users.create({ username: 'bob', password: 'password-123' })
  await users.changeOwnPassword(alice.id, 'password-123')
  await users.changeOwnPassword(bob.id, 'password-123')
  const projects = new PostgresProjectService(context, cfg)
  const path = join(root, 'project')
  await mkdir(path)
  const project = await projects.create({ name: 'project', path, createdBy: alice.id })
  await projects.setMember(project.id, alice.id, 'rw')
  await projects.setMember(project.id, bob.id, 'rw')
  const projectInternal = await pool.query<{ id: string }>(
    'SELECT id FROM harness.projects WHERE organization_id=$1 AND public_id=$2', [organizationId, project.id],
  )
  const projectId = projectInternal.rows[0]!.id
  await pool.query(`INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path)
    VALUES($1,$2,$3,$4,$4)`, [organizationId, projectId, contexts[1]!.nodeId, path])
  const aliceInternal = await pool.query<{ id: string }>(
    'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2', [organizationId, alice.id],
  )
  const aliceId = aliceInternal.rows[0]!.id
  const registerDocument = async (): Promise<void> => {
    await pool.query(`INSERT INTO harness.document_catalog(organization_id,scope_kind,scope_project_id,
      runtime_doc_id,name,bytes,media_type,modified_at_ms,owner_user_id)
      VALUES($1,'project',$2,$3,'new upload',1,'text/plain',1,$4)`, [organizationId, projectId, randomUUID(), aliceId])
  }
  const runtime = createServer((req, res) => {
    if (options.runtime?.(req, res) === true) return
    if (req.url?.startsWith('/api/hold')) { res.write('authorized-prefix'); return }
    if (req.url?.startsWith('/api/register-document')) {
      void registerDocument().then(() => { res.end('registered') }, () => { res.writeHead(500); res.end() })
      return
    }
    res.end('ok')
  })
  const runtimeBase = await listen(runtime)
  const webSockets = new WebSocketServer({ server: runtime })
  webSockets.on('connection', (socket) => {
    socket.send('ready')
    socket.on('message', data => { socket.send(data) })
  })
  cleanup.push(() => {
    for (const socket of webSockets.clients) socket.terminate()
    return new Promise<void>(resolveClose => { webSockets.close(() => { resolveClose() }) })
  })
  const port = Number(new URL(runtimeBase).port)
  const principals = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, slug, 30_000)
  const gateways: Array<{
    base: string
    monitor: PostgresAccessMonitor
    deps: GatewayDeps
    stop: ReturnType<typeof vi.fn<GatewayDeps['instances']['stop']>>
    owner: PostgresRuntimeContext
  }> = []
  for (const owner of contexts) {
    // Runtime transport is real HTTP/WS; lifecycle calls are observed separately.
    const stop = vi.fn<GatewayDeps['instances']['stop']>(async () => {})
    const monitor = new PostgresAccessMonitor(owner, 60_000)
    const deps: GatewayDeps = {
      cfg, users, projects: new PostgresProjectService(owner, cfg),
      auth: new PostgresAuthService(owner, cfg), audit: new PostgresAuditService(owner),
      collaboration: new PostgresCollaborationService(owner), accessMonitor: monitor,
      instances: {
        portOf: async () => port, generationOf: async () => 1, stateOf: async () => 'ready',
        isLive: async () => true, touch: async () => {}, wsRef: async () => {},
        operationRef: vi.fn<NonNullable<GatewayDeps['instances']['operationRef']>>(async () => {}),
        ensureRunning: async () => ({ port, generation: 1 }), reapIdle: async () => 0,
        stop, stopAll: async () => {}, withStopped: async (_target, operation) => operation(),
      },
    }
    const proxy = createProxyHandlers(deps)
    const documentScope = createGatewayDocumentScopeHandler({
      instances: deps.instances, users, projects: deps.projects, collaboration: deps.collaboration!, principals,
    })
    const server = createGatewayServer(deps, {
      ...proxy, documentScope: options.wrapDocumentScope?.(documentScope) ?? documentScope,
    })
    const base = await listen(server)
    cleanup.push(async () => { proxy.close(); await monitor.close() })
    cfg.publicOrigins.push(base)
    await monitor.synchronize()
    stop.mockClear()
    gateways.push({ base, monitor, deps, stop, owner })
  }
  const auth = new PostgresAuthService(context, cfg)
  const login = async (username: string) => {
    const result = await auth.login(username, 'password-123', '127.0.0.1', 'test')
    if (typeof result === 'string') throw new Error(result)
    return `hgw_session=${result.token}`
  }
  const aliceCookie = await login('alice')
  const bobCookie = await login('bob')
  const target = `?dshTarget=project:${project.id}`
  const socket = async (gateway: typeof gateways[number], cookie: string): Promise<WebSocket> => {
    const ws = new WebSocket(`${gateway.base.replace('http', 'ws')}/api/events.mux${target}`, {
      headers: { cookie, origin: gateway.base },
    })
    cleanup.push(() => ws.terminate())
    await once(ws, 'message', { signal: AbortSignal.timeout(5_000) })
    return ws
  }
  const revision = async () => (await pool.query<{ revision: string }>(
    'SELECT access_revision::text AS revision FROM harness.organizations WHERE id=$1', [organizationId],
  )).rows[0]!.revision
  return { gateways, organizationId, projects, project, projectId, alice, aliceId, bob, aliceCookie, bobCookie, target, socket, revision }
}

describePg('cross-Gateway access invalidation', () => {
  beforeAll(async () => {
    pool = createPostgresPool(databaseUrl!, { max: 10 })
    await pool.query('DROP SCHEMA IF EXISTS harness CASCADE')
    await runMigrations(pool, migrations)
  })
  afterAll(async () => { await pool?.end() })

  it('cancels another Gateway HTTP/WS traffic on committed membership removal, preserving other users', async () => {
    const f = await fixture()
    const first = f.gateways[0]!
    const second = f.gateways[1]!
    const alice = await f.socket(second, f.aliceCookie)
    const bob = await f.socket(second, f.bobCookie)
    const response = await fetch(`${first.base}/api/hold${f.target}`, { headers: { cookie: f.aliceCookie } })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    const closed = once(alice, 'close', { signal: AbortSignal.timeout(5_000) })
    const ended = reader.read().then(
      result => { expect(result.done).toBe(true) },
      (error: unknown) => { expect(error).toBeInstanceOf(Error) },
    )
    await first.deps.projects.removeMember(f.project.id, f.alice.id)
    await Promise.all([closed, ended])
    reader.releaseLock()
    await second.monitor.synchronize()
    expect(second.stop).toHaveBeenCalledWith({ kind: 'user', id: f.alice.id })
    const pong = once(bob, 'message', { signal: AbortSignal.timeout(5_000) })
    bob.send('still-authorized')
    expect(String((await pong)[0])).toBe('still-authorized')
    const denied = await fetch(`${second.base}/api/echo${f.target}`, { headers: { cookie: f.aliceCookie } })
    expect(denied.status).toBe(403)
  })

  it('fails closed on LISTEN loss and catches up committed revocations before reconnect admission', async () => {
    const f = await fixture()
    const second = f.gateways[1]!
    const ws = await f.socket(second, f.aliceCookie)
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(5_000) })
    const stopped = await pool.query<{ stopped: boolean }>(
      'SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE application_name=$1',
      [`hgw-access:${second.owner.nodeName}`],
    )
    expect(stopped.rows).toEqual([{ stopped: true }])
    await closed
    await f.projects.removeMember(f.project.id, f.alice.id)
    await second.monitor.synchronize()
    expect(second.stop).toHaveBeenCalledWith({ kind: 'user', id: f.alice.id })
    expect((await fetch(`${second.base}/api/echo${f.target}`, { headers: { cookie: f.aliceCookie } })).status).toBe(403)
  })

  it('keeps uploads, new Sessions, appends, statistics, and sliding login expiry out of revocations', async () => {
    const f = await fixture()
    const second = f.gateways[1]!
    const ws = await f.socket(second, f.aliceCookie)
    const before = await f.revision()
    const uploaded = await fetch(`${second.base}/api/register-document${f.target}`, { headers: { cookie: f.aliceCookie } })
    expect(await uploaded.text()).toBe('registered')
    const sessionId = randomUUID()
    await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,project_id,
      session_format_version,created_at,updated_at,visibility,root_session_id)
      VALUES($1,$2,$3,$4,1,now(),now(),'project',$1)`, [sessionId, f.organizationId, f.aliceId, f.projectId])
    await pool.query(`UPDATE harness.conversation_sessions SET next_seq=1,event_count=1,version=version+1,
      status='closed',updated_at=now() WHERE id=$1`, [sessionId])
    await pool.query('UPDATE harness.document_catalog SET bytes=2,modified_at_ms=2 WHERE organization_id=$1', [f.organizationId])
    await pool.query(`UPDATE harness.auth_sessions SET last_seen_at=now(),expires_at=expires_at+interval '1 minute'
      WHERE organization_id=$1`, [f.organizationId])
    await second.monitor.synchronize()
    expect(await f.revision()).toBe(before)
    const pong = once(ws, 'message', { signal: AbortSignal.timeout(5_000) })
    ws.send('upload-survived')
    expect(String((await pong)[0])).toBe('upload-survived')
    expect(second.stop).not.toHaveBeenCalled()
  })

  it('coalesces a transaction, ignores rolled-back changes, and handles repeated wakeups once', async () => {
    const f = await fixture()
    const monitor = f.gateways[1]!.monitor
    const observed: AccessInvalidationSubject[] = []
    monitor.subscribe(subject => { observed.push(subject) })
    const before = await f.revision()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("UPDATE harness.project_members SET access_mode='ro' WHERE project_id=$1", [f.projectId])
      await client.query('ROLLBACK')
      await monitor.synchronize()
      expect(await f.revision()).toBe(before)
      expect(observed).toEqual([])
      await client.query('BEGIN')
      await client.query("UPDATE harness.project_members SET access_mode='ro' WHERE project_id=$1", [f.projectId])
      await client.query("UPDATE harness.project_members SET access_mode='rw' WHERE project_id=$1", [f.projectId])
      await client.query('COMMIT')
    } finally { client.release() }
    await monitor.synchronize()
    expect(BigInt(await f.revision())).toBe(BigInt(before) + 1n)
    expect(observed).toEqual(expect.arrayContaining([
      { userId: f.alice.id, restartRuntime: true }, { userId: f.bob.id, restartRuntime: true },
    ]))
    expect(observed).toHaveLength(2)
    await pool.query("SELECT pg_notify('harness_access_invalidation',$1)", [f.organizationId])
    await monitor.synchronize()
    expect(observed).toHaveLength(2)
  })

  it('covers conversation, archive, document, and directory access without restarting for visibility alone', async () => {
    const f = await fixture()
    const gateway = f.gateways[1]!
    const observed: AccessInvalidationSubject[] = []
    gateway.monitor.subscribe(subject => { observed.push(subject) })
    const sessionId = randomUUID()
    await pool.query(`INSERT INTO harness.conversation_sessions(id,organization_id,creator_user_id,project_id,
      session_format_version,created_at,updated_at,visibility,root_session_id)
      VALUES($1,$2,$3,$4,1,now(),now(),'project',$1)`, [sessionId, f.organizationId, f.aliceId, f.projectId])
    await pool.query(`INSERT INTO harness.conversation_archive_records(organization_id,root_session_id,runtime_kind,
      runtime_public_id,project_id,creator_user_id) VALUES($1,$2,'project',$3,$4,$5)`,
    [f.organizationId, sessionId, f.project.id, f.projectId, f.aliceId])
    await pool.query(`INSERT INTO harness.document_catalog(organization_id,scope_kind,scope_project_id,
      runtime_doc_id,name,bytes,media_type,modified_at_ms) VALUES($1,'project',$2,$3,'document',1,'text/plain',1)`,
    [f.organizationId, f.projectId, randomUUID()])
    for (const statement of [
      "UPDATE harness.conversation_sessions SET visibility='private' WHERE organization_id=$1",
      "UPDATE harness.conversation_archive_records SET state='trash' WHERE organization_id=$1",
      "UPDATE harness.document_catalog SET state='trash' WHERE organization_id=$1",
    ]) {
      await pool.query(statement, [f.organizationId])
      await gateway.monitor.synchronize()
    }
    expect(observed).toEqual(Array.from({ length: 3 }, () => ({ projectId: f.project.id })))
    expect(gateway.stop).not.toHaveBeenCalled()
    await pool.query("UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1", [f.organizationId])
    await gateway.monitor.synchronize()
    expect(gateway.stop).toHaveBeenCalledWith({ kind: 'user', id: f.alice.id })
    expect(gateway.stop).toHaveBeenCalledWith({ kind: 'user', id: f.bob.id })
    expect(gateway.stop).toHaveBeenCalledWith({ kind: 'project', id: f.project.id })
  })

  it('invalidates active tokens and disabled organizations without waiting for principal expiry', async () => {
    const f = await fixture()
    const gateway = f.gateways[1]!
    const ws = await f.socket(gateway, f.aliceCookie)
    const closed = once(ws, 'close', { signal: AbortSignal.timeout(5_000) })
    await f.gateways[0]!.deps.auth.revoke(f.aliceCookie.slice('hgw_session='.length))
    await closed
    expect((await fetch(`${gateway.base}/api/echo`, { headers: { cookie: f.aliceCookie } })).status).toBe(401)
    const bob = await f.socket(gateway, f.bobCookie)
    const bobClosed = once(bob, 'close', { signal: AbortSignal.timeout(5_000) })
    await pool.query("UPDATE harness.organizations SET status='disabled' WHERE id=$1", [f.organizationId])
    await bobClosed
    await expect(gateway.monitor.synchronize()).rejects.toThrow('access organization is not active')
  })

  it('resumes the node checkpoint on cold start and coalesces repeated offline runtime changes', async () => {
    const f = await fixture()
    const gateway = f.gateways[1]!
    await gateway.monitor.close()
    await f.projects.setMember(f.project.id, f.alice.id, 'ro')
    await f.projects.setMember(f.project.id, f.alice.id, 'rw')
    const replayed: AccessInvalidationSubject[] = []
    const replacement = new PostgresAccessMonitor(gateway.owner, 60_000)
    const dispose = replacement.subscribe(subject => { replayed.push(subject) })
    cleanup.push(() => replacement.close())
    await replacement.synchronize()
    expect(replayed).toEqual([{ userId: f.alice.id, restartRuntime: true }])
    dispose()
    await replacement.close()
    const confirmed = await pool.query<{ revision: string }>(
      'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [gateway.owner.nodeId],
    )
    expect(confirmed.rows[0]!.revision).toBe(await f.revision())
    const secondStart = new PostgresAccessMonitor(gateway.owner, 60_000)
    const repeated: AccessInvalidationSubject[] = []
    secondStart.subscribe(subject => { repeated.push(subject) })
    cleanup.push(() => secondStart.close())
    await secondStart.synchronize()
    expect(repeated).toEqual([])
  })

  it('waits for disconnect cancellation and keeps its own cursor when another process acknowledges changes', async () => {
    const f = await fixture()
    const gateway = f.gateways[1]!
    const cancellationStarted = barrier()
    const releaseCancellation = barrier()
    const replayed: AccessInvalidationSubject[] = []
    const dispose = gateway.monitor.subscribe(async (subject) => {
      if (subject.userId === undefined && subject.projectId === undefined) {
        cancellationStarted.resolve()
        await releaseCancellation.promise
      } else replayed.push(subject)
    })
    const killed = await pool.query<{ stopped: boolean }>(
      'SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE application_name=$1',
      [`hgw-access:${gateway.owner.nodeName}`],
    )
    expect(killed.rows).toEqual([{ stopped: true }])
    await cancellationStarted.promise
    let recovered = false
    const recovery = gateway.monitor.synchronize().then(() => { recovered = true })
    const otherProcess = new PostgresAccessMonitor({ ...gateway.owner, nodeName: `${gateway.owner.nodeName}-peer` }, 60_000)
    otherProcess.subscribe(() => {})
    cleanup.push(() => otherProcess.close())
    try {
      await f.projects.removeMember(f.project.id, f.alice.id)
      await otherProcess.synchronize()
      expect(recovered).toBe(false)
      releaseCancellation.resolve()
      await recovery
      expect(replayed).toEqual([{ userId: f.alice.id, restartRuntime: true }])
    } finally {
      releaseCancellation.resolve()
      await recovery
      dispose()
    }
  })

  it('keeps admission closed when disconnect cancellation fails', async () => {
    const f = await fixture()
    const owner = { ...f.gateways[1]!.owner, nodeName: `${randomUUID()}-failure` }
    const monitor = new PostgresAccessMonitor(owner, 60_000)
    const started = barrier()
    const failure = new Error('cancellation did not settle safely')
    monitor.subscribe((subject) => {
      if (subject.userId === undefined && subject.projectId === undefined) {
        started.resolve()
        return Promise.reject(failure)
      }
    })
    await monitor.synchronize()
    await pool.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1', [`hgw-access:${owner.nodeName}`])
    await started.promise
    try {
      await expect(monitor.synchronize()).rejects.toBe(failure)
      await expect(monitor.synchronize()).rejects.toBe(failure)
    } finally {
      await expect(monitor.close()).rejects.toBe(failure)
    }
  })

  it('cancels document content before a slow runtime stop and acknowledges only after the stream lease is released', async () => {
    let upstream!: ServerResponse
    const upstreamClosed = barrier()
    const f = await fixture({ runtime(req, res) {
      if (!req.url?.startsWith('/api/documents/content')) return false
      upstream = res
      res.once('close', upstreamClosed.resolve)
      res.write('already-sent-prefix')
      return true
    } })
    const gateway = f.gateways[1]!
    const stopStarted = barrier(), releaseStop = barrier()
    const leaseReleasing = barrier(), releaseLease = barrier()
    gateway.stop.mockImplementation(async () => { stopStarted.resolve(); await releaseStop.promise })
    const operationRef = vi.mocked(gateway.deps.instances.operationRef!)
    operationRef.mockImplementation(async (_target, delta) => {
      if (delta === -1) { leaseReleasing.resolve(); await releaseLease.promise }
    })
    const originalSubscribe = gateway.monitor.subscribe.bind(gateway.monitor)
    let contentSubscriptions = 0
    gateway.monitor.subscribe = (listener) => {
      contentSubscriptions++
      const dispose = originalSubscribe(listener)
      return () => { contentSubscriptions--; dispose() }
    }
    const acknowledged = async () => (await pool.query<{ revision: string }>(
      'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [gateway.owner.nodeId],
    )).rows[0]!.revision
    const before = await acknowledged()
    const response = await fetch(`${gateway.base}/api/documents/scope/content?scope=project:${f.project.id}&docId=file`, {
      headers: { cookie: f.aliceCookie },
    })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('already-sent-prefix')
    const tail = reader.read().then(
      result => { expect(result.done).toBe(true) },
      (error: unknown) => { expect(error).toBeInstanceOf(Error) },
    )
    try {
      await f.projects.removeMember(f.project.id, f.alice.id)
      await stopStarted.promise
      await upstreamClosed.promise
      await leaseReleasing.promise
      expect(upstream.destroyed).toBe(true)
      expect(upstream.write('forbidden-suffix')).toBe(false)
      await tail
      expect(contentSubscriptions).toBe(1)
      expect(await acknowledged()).toBe(before)
      releaseStop.resolve()
      expect(await acknowledged()).toBe(before)
      releaseLease.resolve()
      await gateway.monitor.synchronize()
      expect(operationRef.mock.calls).toEqual([
        [{ kind: 'project', id: f.project.id }, 1, 1],
        [{ kind: 'project', id: f.project.id }, -1, 1],
      ])
      expect(contentSubscriptions).toBe(0)
      expect(await acknowledged()).toBe(await f.revision())
    } finally {
      releaseStop.resolve()
      releaseLease.resolve()
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  })

  it('keeps unrelated subjects, ordinary uploads, and metadata from cancelling a document download', async () => {
    let upstream!: ServerResponse
    const f = await fixture({ runtime(req, res) {
      const url = new URL(req.url ?? '/', 'http://runtime')
      if (url.pathname === '/api/documents/content') {
        upstream = res
        res.write('prefix')
        return true
      }
      if (url.pathname === '/api/documents') { res.end('{"documents":[]}'); return true }
      return false
    } })
    const gateway = f.gateways[1]!
    const response = await fetch(`${gateway.base}/api/documents/scope/content?scope=project:${f.project.id}&docId=file`, {
      headers: { cookie: f.aliceCookie },
    })
    const reader = response.body!.getReader()
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('prefix')
      await f.gateways[0]!.deps.auth.revoke(f.bobCookie.slice('hgw_session='.length))
      await pool.query('SELECT harness.invalidate_access($1,$2::jsonb)', [
        f.organizationId, JSON.stringify({ projectId: f.project.id + 1000 }),
      ])
      await gateway.monitor.synchronize()
      const upload = await fetch(`${gateway.base}/api/register-document`, { headers: { cookie: f.aliceCookie } })
      expect(await upload.text()).toBe('registered')
      const metadata = await fetch(`${gateway.base}/api/documents/scope?scope=project:${f.project.id}`, {
        headers: { cookie: f.aliceCookie },
      })
      expect(await metadata.json()).toEqual({ documents: [] })
      await gateway.monitor.synchronize()
      upstream.end('authorized-suffix')
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('authorized-suffix')
      expect((await reader.read()).done).toBe(true)
      expect(vi.mocked(gateway.deps.instances.operationRef!).mock.calls.reduce((sum, call) => sum + call[1], 0)).toBe(0)
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  })

  it('cancels every subject in a project transaction before waiting for one user runtime to stop', async () => {
    const upstreams = new Map<string, { response: ServerResponse; closed: ReturnType<typeof barrier> }>()
    const f = await fixture({ runtime(req, res) {
      if (!req.url?.startsWith('/api/documents/content')) return false
      const name = new URL(req.url, 'http://runtime').searchParams.get('docId')!
      const closed = barrier()
      upstreams.set(name, { response: res, closed })
      res.once('close', closed.resolve)
      res.write(`prefix:${name}`)
      return true
    } })
    const gateway = f.gateways[1]!
    const admin = await gateway.deps.users.create({ username: 'carol', password: 'password-123', role: 'admin' })
    await gateway.deps.users.changeOwnPassword(admin.id, 'password-123')
    const login = await gateway.deps.auth.login('carol', 'password-123', '127.0.0.1', 'test')
    if (typeof login === 'string') throw new Error(login)
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = []
    const tails: Promise<unknown>[] = []
    const stopped = barrier(), release = barrier()
    let pausedUser: number | undefined
    try {
      for (const [name, cookie] of [['alice', f.aliceCookie], ['bob', f.bobCookie], ['carol', `hgw_session=${login.token}`]]) {
        const response = await fetch(`${gateway.base}/api/documents/scope/content?scope=project:${f.project.id}&docId=${name}`, {
          headers: { cookie: cookie! },
        })
        const reader = response.body!.getReader()
        readers.push(reader)
        expect(new TextDecoder().decode((await reader.read()).value)).toBe(`prefix:${name}`)
        tails.push(reader.read().then(
          result => { expect(result.done).toBe(true) },
          (error: unknown) => { expect(error).toBeInstanceOf(Error) },
        ))
      }
      await gateway.monitor.synchronize()
      const before = await f.revision()
      gateway.stop.mockImplementation(async (target) => {
        if (typeof target === 'object' && target.kind === 'user' && pausedUser === undefined) {
          pausedUser = target.id
          stopped.resolve()
          await release.promise
        }
      })
      await pool.query("UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1", [f.organizationId])
      await stopped.promise
      expect([f.alice.id, f.bob.id]).toContain(pausedUser)
      const otherUser = pausedUser === f.alice.id ? 'bob' : 'alice'
      // Both the other member and the non-member administrator depend on
      // subjects after the paused owner in the same committed transaction.
      for (const name of [otherUser, 'carol']) {
        const upstream = upstreams.get(name)!
        if (!upstream.response.destroyed) {
          await once(upstream.response, 'close', { signal: AbortSignal.timeout(5_000) })
        }
        expect(upstream.response.write('forbidden-suffix')).toBe(false)
      }
      expect((await pool.query<{ revision: string }>(
        'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [gateway.owner.nodeId],
      )).rows[0]!.revision).toBe(before)
      release.resolve()
      await gateway.monitor.synchronize()
      await Promise.all(tails)
      expect(vi.mocked(gateway.deps.instances.operationRef!).mock.calls.reduce((sum, call) => sum + call[1], 0)).toBe(0)
    } finally {
      release.resolve()
      await Promise.all(readers.map(async (reader) => { await reader.cancel().catch(() => {}); reader.releaseLock() }))
    }
  })

  it.each(['authorization', 'lease'] as const)('cancels content waiting for %s and releases any late lease', async (waiting) => {
    const calls: string[] = []
    const f = await fixture({ runtime(req, res) {
      calls.push(req.url ?? '/')
      res.end('must-not-be-requested')
      return true
    } })
    const gateway = f.gateways[1]!
    const started = barrier(), release = barrier()
    const operationRef = vi.mocked(gateway.deps.instances.operationRef!)
    if (waiting === 'authorization') {
      const validate = gateway.deps.auth.validate.bind(gateway.deps.auth)
      let validations = 0
      gateway.deps.auth.validate = async (token) => {
        const user = await validate(token)
        if (++validations === 2) { started.resolve(); await release.promise }
        return user
      }
    } else {
      operationRef.mockImplementation(async (_target, delta) => {
        if (delta === 1) { started.resolve(); await release.promise }
      })
    }
    const fetching = fetch(`${gateway.base}/api/documents/scope/content?scope=project:${f.project.id}`, {
      headers: { cookie: f.aliceCookie },
    }).then(() => { throw new Error('revoked download returned a response') }, (error: unknown) => { expect(error).toBeInstanceOf(Error) })
    try {
      await started.promise
      await f.projects.removeMember(f.project.id, f.alice.id)
      await fetching
      if (waiting === 'authorization') await gateway.monitor.synchronize()
      release.resolve()
      await gateway.monitor.synchronize()
      expect(calls).toEqual([])
      expect(operationRef.mock.calls.map(call => call[1])).toEqual(waiting === 'lease' ? [1, -1] : [])
    } finally { release.resolve(); await fetching }
  })

  it('cancels a late document Response body and releases its lease before acknowledging revocation', async () => {
    const ready = barrier(), deliver = barrier()
    const f = await fixture({
      runtime(_req, res) { res.end('buffered-before-revocation'); return true },
      wrapDocumentScope: handler => async input => {
        const response = await handler(input)
        ready.resolve()
        await deliver.promise
        return response
      },
    })
    const gateway = f.gateways[1]!
    const operationRef = vi.mocked(gateway.deps.instances.operationRef!)
    const fetching = fetch(`${gateway.base}/api/documents/scope/content?scope=project:${f.project.id}`, {
      headers: { cookie: f.aliceCookie },
    }).then(() => { throw new Error('late response reached the revoked caller') }, (error: unknown) => { expect(error).toBeInstanceOf(Error) })
    try {
      await ready.promise
      expect(operationRef.mock.calls.map(call => call[1])).toEqual([1])
      await f.projects.removeMember(f.project.id, f.alice.id)
      await fetching
      expect(operationRef.mock.calls.map(call => call[1])).toEqual([1])
      deliver.resolve()
      await gateway.monitor.synchronize()
      expect(operationRef.mock.calls.map(call => call[1])).toEqual([1, -1])
    } finally { deliver.resolve(); await fetching }
  })

  it.each(['revocation', 'response limit', 'empty body'] as const)('does not acknowledge document revocation when lease cleanup fails during %s', async (trigger) => {
    const f = await fixture({ runtime(req, res) {
      if (req.method === 'HEAD') res.end()
      else res.write('prefix')
      return true
    } })
    const gateway = f.gateways[1]!
    if (trigger === 'response limit') gateway.deps.cfg.upstreamResponseLimitBytes = 3
    const failure = new Error('lease release unavailable')
    const operationRef = vi.mocked(gateway.deps.instances.operationRef!)
    operationRef.mockImplementation(async (_target, delta) => { if (delta === -1) throw failure })
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
    const close = gateway.monitor.close.bind(gateway.monitor)
    vi.spyOn(gateway.monitor, 'close').mockImplementation(async () => {
      await expect(close()).rejects.toMatchObject({ name: 'DocumentLeaseReleaseError', cause: failure })
    })
    const before = await pool.query<{ revision: string }>(
      'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [gateway.owner.nodeId],
    )
    const request = fetch(`${gateway.base}/api/documents/scope/content?scope=project:${f.project.id}`, {
      method: trigger === 'empty body' ? 'HEAD' : 'GET', headers: { cookie: f.aliceCookie },
    })
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    let tail: Promise<unknown> | undefined
    if (trigger === 'response limit') {
      await expect(request.then(response => response.arrayBuffer())).rejects.toBeInstanceOf(Error)
    } else if (trigger === 'empty body') {
      const response = await request
      expect(response.status).toBe(503)
      await response.arrayBuffer()
    } else {
      reader = (await request).body!.getReader()
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('prefix')
      tail = reader.read().catch(() => undefined)
    }
    try {
      await f.projects.removeMember(f.project.id, f.alice.id)
      await tail
      await expect(gateway.monitor.synchronize()).rejects.toMatchObject({ name: 'DocumentLeaseReleaseError', cause: failure })
      await expect(gateway.monitor.synchronize()).rejects.toMatchObject({ name: 'DocumentLeaseReleaseError', cause: failure })
      expect((await pool.query<{ revision: string }>(
        'SELECT access_applied_revision::text AS revision FROM harness.compute_nodes WHERE id=$1', [gateway.owner.nodeId],
      )).rows).toEqual(before.rows)
      expect(operationRef.mock.calls.map(call => call[1])).toEqual([1, -1])
      expect(diagnostics).toHaveBeenCalledWith('[gateway] document lease cleanup failed:', expect.objectContaining({ cause: failure }))
    } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); diagnostics.mockRestore() }
  })
})
