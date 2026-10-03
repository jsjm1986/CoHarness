/** Deployment admin routes and the maintenance write gate over the HTTP server. @module */
import { mkdtempSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { ModelGovernanceService } from '../src/model-governance.ts'
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'
import {
  MaintenanceError,
  type ClusterNodeView,
  type ClusterState,
  type DeploymentOperationView,
} from '../src/postgres/maintenance-service.ts'
import type { BackupRecordView } from '../src/postgres/backup-service.ts'

let closer: (() => Promise<void>) | undefined
afterEach(async () => { await closer?.() })

async function login(base: string, username: string, password: string): Promise<string> {
  const res = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password }),
  })
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'hgw-deploy-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = testConfig(root, { HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects') })
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects: new ProjectService(db, cfg),
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
    governance: new ModelGovernanceService(db),
  }
  const boss = await deps.users.create({ username: 'boss', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(boss.id, 'pw-12345678')
  const worker = await deps.users.create({ username: 'worker', password: 'pw-12345678' })
  await deps.users.changeOwnPassword(worker.id, 'pw-12345678')
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  closer = () => new Promise(resolve => server.close(() => resolve()))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const cookie = await login(base, 'boss', 'pw-12345678')
  const post = (pathname: string, body: unknown, auth = cookie) => fetch(`${base}${pathname}`, {
    method: 'POST', headers: { cookie: auth, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { deps, base, cookie, post }
}

const state = (over: Partial<ClusterState> = {}): ClusterState => ({
  mode: 'serving', maintenanceEpoch: '0', writeEpoch: '1', reason: null, enteredAt: null,
  updatedAt: 'now', nodes: [], writersQuiesced: false, ...over,
})

type MaintenanceStub = NonNullable<GatewayDeps['maintenance']>
const operation = (over: Partial<DeploymentOperationView> = {}): DeploymentOperationView => ({
  id: 'op-0', kind: 'restore', status: 'pending', nodeName: null, detail: {},
  createdBy: null, createdAt: 'now', startedAt: null, finishedAt: null, error: null, ...over,
})
const nodeView = (over: Partial<ClusterNodeView> = {}): ClusterNodeView => ({
  nodeId: 'n1', name: 'node-a', status: 'active', lastHeartbeatAt: null,
  heartbeatAgeMs: null, maintenanceAppliedEpoch: '0', inflightWrites: 0, activeRuntimes: 0, quiesced: true, ...over,
})
const maintenanceStub = (over: Partial<MaintenanceStub> = {}): MaintenanceStub => ({
  state: async () => state(),
  listOperations: async () => [],
  enterMaintenance: async () => state({ mode: 'maintenance', maintenanceEpoch: '4' }),
  exitMaintenance: async () => state(),
  setNodeStatus: async () => nodeView(),
  requestRestore: async () => operation(),
  logOperation: async () => 'op-0',
  ...over,
})

describe('deployment admin API', () => {
  it('serves cluster state with migration diff and operations to admins only', async () => {
    const { deps, base, cookie } = await setup()
    const url = `${base}/admin/api/deployment`
    expect((await fetch(url, { headers: { cookie } })).status).toBe(503)
    deps.maintenance = maintenanceStub()
    deps.migrationPlan = async () => ({ applied: [1], pending: [{ version: 2, name: '002_x' }], drifted: [], current: 2 })
    const worker = await login(base, 'worker', 'pw-12345678')
    expect((await fetch(url, { headers: { cookie: worker } })).status).toBe(403)
    const response = await fetch(url, { headers: { cookie } })
    expect(response.status).toBe(200)
    const body = await response.json() as Record<string, unknown>
    expect(body.mode).toBe('serving')
    expect((body.migrations as { pending: unknown[] }).pending).toHaveLength(1)
  })

  it('drives maintenance enter/exit and node status through the service', async () => {
    const { deps, post } = await setup()
    const enter = vi.fn(async () => state({ mode: 'maintenance', maintenanceEpoch: '4' }))
    const exit = vi.fn(async () => state())
    const nodeStatus = vi.fn(async (): Promise<ClusterNodeView> => ({
      nodeId: 'n1', name: 'node-a', status: 'draining', lastHeartbeatAt: null,
      heartbeatAgeMs: null, maintenanceAppliedEpoch: '0', inflightWrites: 0, activeRuntimes: 0, quiesced: false,
    }))
    deps.maintenance = maintenanceStub({
      enterMaintenance: enter, exitMaintenance: exit, setNodeStatus: nodeStatus,
    })
    expect((await post('/admin/api/deployment/maintenance', { action: 'enter', reason: 'upgrade' })).status).toBe(200)
    expect(enter).toHaveBeenCalledWith(expect.any(Number), 'upgrade')
    expect((await post('/admin/api/deployment/maintenance', { action: 'bogus' })).status).toBe(400)
    expect((await post('/admin/api/deployment/maintenance', { action: 'exit' })).status).toBe(200)
    expect(exit).toHaveBeenCalled()
    expect((await post('/admin/api/deployment/nodes/status', { nodeId: 'n1', status: 'draining' })).status).toBe(200)
    expect(nodeStatus).toHaveBeenCalledWith(expect.any(Number), 'n1', 'draining')
    expect((await post('/admin/api/deployment/nodes/status', { nodeId: 'n1', status: 'weird' })).status).toBe(400)
    exit.mockRejectedValueOnce(new MaintenanceError(409, 'restore-in-progress'))
    expect((await post('/admin/api/deployment/maintenance', { action: 'exit' })).status).toBe(409)
  })

  it('requests a restore only for a verified backup and rejects duplicates', async () => {
    const { deps, post } = await setup()
    const requestRestore = vi.fn(async (): Promise<DeploymentOperationView> => ({
      id: 'op-1', kind: 'restore', status: 'pending', nodeName: null, detail: { backupId: 'b1' },
      createdBy: 1, createdAt: 'now', startedAt: null, finishedAt: null, error: null,
    }))
    deps.maintenance = maintenanceStub({ requestRestore })
    const get = vi.fn(async (id: string): Promise<BackupRecordView> => ({
      id, path: '/tmp/d.dump', format: 'pg-dump-custom', migrationVersion: 41, writeEpoch: '1',
      sizeBytes: 1, sha256: 'f'.repeat(64), managedSnapshot: { version: 1, roots: [], directories: [], absent: [], files: [] }, status: id === 'b1' ? 'verified' : 'recording',
      createdBy: 1, createdAt: 'now', verifiedAt: null, restoredAt: null, error: null,
    }))
    deps.backups = { list: vi.fn(async () => []), get, record: vi.fn(), setVerified: vi.fn() }
    expect((await post('/admin/api/deployment/restore', { backupId: 'b1' })).status).toBe(200)
    expect(requestRestore).toHaveBeenCalledWith(expect.any(Number), 'b1')
    expect((await post('/admin/api/deployment/restore', { backupId: 'b2' })).status).toBe(409)
    expect((await post('/admin/api/deployment/restore', {})).status).toBe(400)
  })

  it('delegates backup creation and complete artifact verification and propagates admission refusal', async () => {
    const { deps, post } = await setup()
    const recorded: BackupRecordView = {
      id: 'b1', path: '/backups/fixture.dump', format: 'pg-dump-custom', migrationVersion: 46, writeEpoch: '1',
      sizeBytes: 42, sha256: 'f'.repeat(64),
      managedSnapshot: { version: 1, roots: [], directories: [], absent: [], files: [] }, status: 'verified',
      createdBy: 1, createdAt: 'now', verifiedAt: 'now', restoredAt: null, error: null,
    }
    const create = vi.fn(async () => recorded), verify = vi.fn(async () => recorded)
    const previewNodeConfiguration = vi.fn(async (id: string) => ({ backupId: id, configFile: null,
      appliedRevision: null, values: null, incompatibleFields: [] }))
    deps.backupWork = { create, verify, previewNodeConfiguration }
    deps.backups = { list: vi.fn(async () => [recorded]), get: vi.fn(async () => recorded), record: vi.fn(), setVerified: vi.fn() }
    expect((await post('/admin/api/backups', {})).status).toBe(200)
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.any(Number))
    expect((await post('/admin/api/backups/verify', { id: 'b1' })).status).toBe(200)
    expect(verify).toHaveBeenCalledExactlyOnceWith('b1')
    expect((await post('/admin/api/backups/node-configuration', { id: 'b1' })).status).toBe(200)
    expect(previewNodeConfiguration).toHaveBeenCalledExactlyOnceWith('b1')
    create.mockRejectedValueOnce(new MaintenanceError(409, 'writers-not-quiesced'))
    expect((await post('/admin/api/backups', {})).status).toBe(409)
    verify.mockRejectedValueOnce(new MaintenanceError(409, 'backup-manifest-differs-from-registry'))
    expect((await post('/admin/api/backups/verify', { id: 'b1' })).status).toBe(409)
  })
})

describe('maintenance write gate', () => {
  it('rejects mutating requests during maintenance while reads and control stay open', async () => {
    const { deps, base, cookie, post } = await setup()
    const gate = vi.fn(async (): Promise<'maintenance' | 'stale-epoch'> => 'maintenance')
    deps.maintenanceGate = gate
    deps.maintenance = maintenanceStub({
      state: async () => state({ mode: 'maintenance' }),
      enterMaintenance: async () => state({ mode: 'maintenance' }),
    })
    const get = await fetch(`${base}/admin/api/deployment`, { headers: { cookie } })
    expect(get.status).toBe(200)
    const control = await post('/admin/api/deployment/maintenance', { action: 'enter' })
    expect(control.status).toBe(200)
    const mutation = await post('/admin/api/users/create', { username: 'x', password: 'pw-12345678' })
    expect(mutation.status).toBe(503)
    expect(await mutation.json()).toEqual({ error: 'maintenance' })
    const runtime = await fetch(`${base}/internal/runtime/execution/input`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
      body: '{}',
    })
    expect(runtime.status).toBe(503)
    const user = (await deps.users.list())[0]!
    const stop = vi.spyOn(deps.instances, 'stop').mockResolvedValue(undefined)
    expect((await post(`/admin/api/users/${user.id}/instance/stop`, {})).status).toBe(204)
    expect(stop).toHaveBeenCalledExactlyOnceWith(user.id)
    expect((await post(`/admin/api/users/${user.id}/instance/start`, {})).status).toBe(503)
    gate.mockResolvedValue('stale-epoch')
    expect((await post(`/admin/api/users/${user.id}/instance/stop`, {})).status).toBe(503)
    expect(stop).toHaveBeenCalledOnce()
    const stale = await post('/admin/api/users/create', { username: 'y', password: 'pw-12345678' })
    expect(stale.status).toBe(503)
    expect(await stale.json()).toEqual({ error: 'stale-epoch' })
  })

  it('gates authenticated runtime calls only after authorization', async () => {
    const { deps, base } = await setup()
    deps.maintenanceGate = async () => 'maintenance'
    const unauthorized = await fetch(`${base}/internal/runtime/execution/input`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(unauthorized.status).toBe(401)
    const authorized = await fetch(`${base}/internal/runtime/execution/input`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
      body: '{}',
    })
    expect(authorized.status).toBe(503)
  })

  it('excludes proxied /api requests from the writer ledger while still gating them', async () => {
    const { deps, post } = await setup()
    const span = vi.fn()
    deps.writerSpan = span
    deps.maintenanceGate = vi.fn(async (): Promise<'open' | 'maintenance'> => 'open')
    const proxied = await post('/api/session.history', {})
    expect(proxied.status).toBe(503)
    expect(span).not.toHaveBeenCalled()
    expect((await post('/admin/api/users', { username: 'zoe', password: 'pw-12345678' })).status).toBe(200)
    expect(span).toHaveBeenCalledOnce()
    deps.maintenanceGate = vi.fn(async (): Promise<'open' | 'maintenance'> => 'maintenance')
    const gated = await post('/api/session.history', {})
    expect(gated.status).toBe(503)
    expect(await gated.json()).toEqual({ error: 'maintenance' })
    expect(span).toHaveBeenCalledOnce()
  })
})

it('retains a writer until its handler settles after the HTTP client disconnects', async () => {
  const { deps, base, cookie } = await setup()
  let writers = 0, release!: () => void, entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const began = new Promise<void>(resolve => { entered = resolve })
  deps.maintenanceGate = async () => 'open'
  deps.writerSpan = () => { writers++; return () => { writers-- } }
  const create = deps.users.create.bind(deps.users)
  deps.users.create = async input => { entered(); await waiting; return create(input) }
  const abort = new AbortController()
  const request = fetch(`${base}/admin/api/users`, { method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'after-disconnect', password: 'pw-12345678' }), signal: abort.signal })
  const cancelled = expect(request).rejects.toThrow()
  try {
    await began
    abort.abort()
    await cancelled
    expect(writers).toBe(1)
  } finally { release() }
  await vi.waitFor(() => { expect(writers).toBe(0) })
  expect(await deps.users.getByUsername('after-disconnect')).not.toBeNull()
})
