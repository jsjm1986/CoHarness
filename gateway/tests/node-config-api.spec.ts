import { isolatedNodeConfigurationAuthority } from './node-config-fixture.ts'
/** Admin node settings and project lifecycle use authenticated HTTP and durable local storage. */
import { mkdtemp, rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { testConfig, testEnvironment } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager } from '../src/instances.ts'
import { NodeConfigurationStore } from '../src/node-config-store.ts'
import { ProjectService } from '../src/projects.ts'
import { createGatewayServer, type GatewayDeps } from '../src/server.ts'
import { UserService } from '../src/users.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'hgw-node-config-api-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const env = testEnvironment(root, { HGW_STATE_ROOT: join(root, 'state'), HGW_USERS_ROOT: join(root, 'users'), HGW_PROJECTS_ROOT: join(root, 'projects') })
  const cfg = testConfig(root, env), db = openDb(join(root, 'gateway.sqlite'))
  cleanup.push(async () => { db.close() })
  const nodeConfiguration = new NodeConfigurationStore({ organizationId: 'org-a', nodeId: 'node-a' }, cfg, env, isolatedNodeConfigurationAuthority)
  await nodeConfiguration.initialize()
  const deps: GatewayDeps = { cfg, auth: new AuthService(db, cfg), users: new UserService(db, cfg),
    audit: new AuditService(db), instances: new InstanceManager(db, cfg), projects: new ProjectService(db, cfg), nodeConfiguration }
  const admin = await deps.users.create({ username: 'admin-fixture', password: 'fixture-password', role: 'admin' })
  const member = await deps.users.create({ username: 'member-fixture', password: 'fixture-password', role: 'user' })
  await deps.users.changeOwnPassword(admin.id, 'fixture-password')
  await deps.users.changeOwnPassword(member.id, 'fixture-password')
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) }))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  cfg.publicOrigins.push(base)
  const login = async (username: string) => {
    const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: 'fixture-password' }) })
    return response.headers.get('set-cookie')!.split(';')[0]!
  }
  const cookie = await login('admin-fixture')
  const post = (path: string, body: unknown, auth = cookie, origin = base) => fetch(`${base}${path}`, { method: 'POST',
    headers: { cookie: auth, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { root, deps, nodeConfiguration, base, cookie, post, login, admin }
}

it('saves and rereads the current node while rejecting members, wrong nodes, stale revisions and CSRF', async () => {
  const f = await fixture(), path = '/admin/api/deployment/configuration', initial = await f.nodeConfiguration.view()
  const body = { action: 'save', organizationId: initial.organizationId, nodeId: initial.nodeId, revision: initial.revision,
    values: { ...initial.desired, HGW_PORT: '9381' } }
  const member = await f.login('member-fixture')
  expect((await f.post(path, body, member)).status).toBe(403)
  expect((await f.post(path, body, f.cookie, 'https://not-this-gateway.example')).status).toBe(403)
  expect((await f.post(path, { ...body, nodeId: 'other' })).status).toBe(409)
  expect((await f.post(path, body)).status).toBe(200)
  expect((await f.post(path, body)).status).toBe(409)
  const read = await fetch(`${f.base}${path}`, { headers: { cookie: f.cookie } })
  expect(await read.json()).toMatchObject({ revision: 1, desired: { HGW_PORT: '9381' }, effective: { HGW_PORT: '8899' } })
  expect((await f.post(path, { ...body, action: 'apply', revision: 1 })).status).toBe(200)
  expect((await f.nodeConfiguration.view()).operation).toMatchObject({ status: 'pending', revision: 1 })
})

it('lets admins stop project runtimes during maintenance but refuses starts and all stale-epoch mutations', async () => {
  const f = await fixture(), project = await f.deps.projects.create({ name: 'fixture-project', createdBy: f.admin.id })
  const stop = vi.spyOn(f.deps.instances, 'stop').mockResolvedValue(undefined)
  const start = vi.spyOn(f.deps.instances, 'ensureRunning').mockResolvedValue({ port: 44001, generation: 1 })
  f.deps.maintenanceGate = async () => 'maintenance'
  const path = `/admin/api/projects/${project.id}/instance`
  expect((await f.post(`${path}/start`, {})).status).toBe(503)
  expect((await f.post(`${path}/restart`, {})).status).toBe(503)
  expect(start).not.toHaveBeenCalled()
  expect((await f.post(`${path}/stop`, {})).status).toBe(204)
  expect(stop).toHaveBeenCalledWith({ kind: 'project', id: project.id })
  const member = await f.login('member-fixture')
  expect((await f.post(`${path}/stop`, {}, member)).status).toBe(403)
  f.deps.maintenanceGate = async () => 'stale-epoch'
  expect((await f.post(`${path}/stop`, {})).status).toBe(503)
  f.deps.maintenanceGate = async () => 'open'
  expect((await f.post(`${path}/start`, {})).status).toBe(204)
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'project', id: project.id }), 'explicit')
})
