import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { createAdminApiHandler } from '../src/admin-api.ts'
import { testConfig } from './test-config.ts'
import { openDb } from '../src/db.ts'
import { InstanceManager, RuntimeStartBlockedError } from '../src/instances.ts'
import type { ModelUsageSubject, UsageSummary } from '../src/model-governance.ts'
import { ProjectService } from '../src/projects.ts'
import type { GatewayCollaborationService } from '../src/services.ts'
import { createGatewayServer, type GatewayDeps, type GatewayHandlers, type GatewayRuntimeHandler } from '../src/server.ts'
import { UserService } from '../src/users.ts'
import { GatewayPerformanceObserver } from '../src/performance-observer.ts'
import { RuntimeCapacityError } from '../src/runtime-capacity.ts'
import { RuntimeAccountError } from '../src/launcher.ts'
import { PostgresCheckoutQueueFullError } from '../src/postgres/database.ts'
import { MAX_PASSWORD_LENGTH } from '../src/password.ts'
import type { AccessInvalidationSubject } from '../src/access-invalidation.ts'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import type { RuntimeCatalogEntry, RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'

const conversationEnvironment: RuntimeCatalogEntry = {
  id: '10111111-1111-4111-8111-111111111111' as RuntimeId, owner: { kind: 'project', id: 7, name: 'Shared' },
  node: { id: '61f22202-1c02-4a3c-8d34-f11222333444' as RuntimeNodeId, name: 'Local', status: 'active', lastHeartbeatAt: null },
  routing: 'local', observedState: 'stopped', generation: 1,
}

let closer: (() => Promise<void>) | undefined
afterEach(async () => { const close = closer; closer = undefined; await close?.() })

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(ready => { resolve = ready })
  return { promise, resolve }
}

async function setup(env: NodeJS.ProcessEnv = {}, handlers: GatewayHandlers = {}, performance?: GatewayPerformanceObserver, environment?: RuntimeCatalogEntry) {
  const root = mkdtempSync(join(tmpdir(), 'hgw-'))
  const db = openDb(join(root, 'g.sqlite'))
  const cfg = testConfig(root, {
    ...env,
    HGW_USERS_ROOT: join(root, 'users'),
    HGW_STATE_ROOT: join(root, 'state'),
    HGW_USER_PROJECTS_ROOT: join(root, 'user-projects'),
  })
  const projects = new ProjectService(db, cfg)
  const deps: GatewayDeps = {
    cfg,
    auth: new AuthService(db, cfg),
    users: new UserService(db, cfg),
    projects,
    audit: new AuditService(db),
    instances: new InstanceManager(db, cfg),
    ...(performance === undefined ? {} : { performance }),
  }
  if (environment !== undefined) deps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(deps), {
    localNodeId: environment.node.id,
    catalog: { resolveForAccount: async () => environment, resolveForOwner: async () => environment, resolveForLanding: async () => environment },
  })
  const admin = await deps.users.create({ username: 'root-admin', password: 'pw-12345678', role: 'admin' })
  await deps.users.changeOwnPassword(admin.id, 'pw-12345678')
  const server = createGatewayServer(deps, { admin: createAdminApiHandler(deps), ...handlers })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const base = `http://127.0.0.1:${port}`
  cfg.publicOrigins.push(base)
  closer = async () => {
    server.closeAllConnections()
    const outcomes = await Promise.allSettled([
      deps.instances.stopAll(),
      new Promise<void>((ready, reject) => { server.close(error => { if (error) reject(error); else ready() }) }),
    ])
    try { db.close() }
    finally { rmSync(root, { recursive: true, force: true }) }
    const failures = outcomes.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'Gateway HTTP fixture cleanup failed')
  }
  return { deps, base, projects }
}

/** Install a small ACL adapter over the synchronous project service for HTTP route tests. */
function installProjectCollaboration(deps: GatewayDeps): void {
  const authority = async (projectId: number, userId: number) => {
    const [project, user] = await Promise.all([deps.projects.getById(projectId), deps.users.getById(userId)])
    if (project === null || user === null || user.status !== 'active') return null
    if (user.role === 'admin') return {
      projectId, name: project.name, path: project.path, mode: 'rw' as const, administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const,
    }
    const member = project.members.find(candidate => candidate.userId === userId)
    return member === undefined ? null : {
      projectId, name: project.name, path: project.path, mode: member.mode, administrator: false, canManage: project.owner?.id === userId, uiThemePolicy: 'follow-user' as const,
    }
  }
  deps.collaboration = {
    projectsForUser: async userId => {
      const scopes: Array<{ projectId: number; name: string; path: string; mode: 'ro' | 'rw' }> = []
      for (const project of await deps.projects.list()) {
        const value = await authority(project.id, userId)
        if (value === null) continue
        scopes.push({ projectId: value.projectId, name: value.name, path: value.path, mode: value.mode })
      }
      return scopes
    },
    projectForUser: authority,
    access: () => { throw new Error('not implemented in route test') },
    listConversations: () => [],
    readableSessionIds: () => [],
    setVisibility: () => { throw new Error('not implemented in route test') },
    claimInteraction: () => false, listActivity: async () => ({ items: [] }),
  } satisfies GatewayCollaborationService
}

async function login(base: string, username: string, password: string): Promise<string> {
  const response = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username, password }),
  })
  expect(response.status).toBe(302)
  const cookie = response.headers.get('set-cookie') ?? ''
  return cookie.split(';')[0] ?? ''
}

it('answers the browser fallback icon without resolving, starting or forwarding a Runtime', async () => {
  const proxy = vi.fn<NonNullable<GatewayHandlers['proxy']>>()
  const { deps, base } = await setup({}, { proxy })
  const resolveTarget = vi.spyOn(deps.instances, 'resolveTarget')
  const ensureRunning = vi.spyOn(deps.instances, 'ensureRunning')
  const cookie = await login(base, 'root-admin', 'pw-12345678')
  for (const method of ['GET', 'HEAD']) {
    const response = await fetch(`${base}/favicon.ico`, { method, headers: { cookie, referer: `${base}/admin/deployment` } })
    expect(response.status).toBe(204)
    expect(await response.text()).toBe('')
  }
  const anonymous = await fetch(`${base}/favicon.ico`, { redirect: 'manual' })
  expect(anonymous.status).toBe(204)
  await anonymous.arrayBuffer()
  expect(resolveTarget).not.toHaveBeenCalled()
  expect(ensureRunning).not.toHaveBeenCalled()
  expect(proxy).not.toHaveBeenCalled()
})

const emptyUsageSummary: UsageSummary = {
  month: '2026-08',
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  estimatedCostMicros: 0,
  companyCostMicros: 0,
  calls: 0,
  missingUsageCalls: 0,
  tokenLimit: null,
  companyCostMicrosLimit: null,
  alerts: [],
}

describe('gateway server', () => {
  it('restricts cumulative performance diagnostics to administrators without retaining request identifiers', async () => {
    const { base, deps } = await setup()
    deps.databasePerformance = () => ({ total: 4, idle: 2, waiting: 1, maximum: 10 })
    expect((await fetch(base + '/admin/api/performance')).status).toBe(401)
    await deps.users.create({ username: 'performance-reader', password: 'pw-12345678', role: 'user' })
    const reader = await deps.users.getByUsername('performance-reader')
    await deps.users.changeOwnPassword(reader!.id, 'pw-12345678')
    const readerCookie = await login(base, 'performance-reader', 'pw-12345678')
    expect((await fetch(base + '/admin/api/performance', { headers: { cookie: readerCookie } })).status).toBe(403)
    const adminCookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(base + '/admin/api/performance?private-label=must-not-be-retained', { headers: { cookie: adminCookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = await response.text()
    const snapshot = JSON.parse(body)
    expect(snapshot).toMatchObject({
      schemaVersion: 1, enabled: true, disposed: false,
      measurement: { kind: 'cumulative' },
      databasePool: { total: 4, idle: 2, waiting: 1, maximum: 10 },
    })
    expect(snapshot.requests.started).toBeGreaterThanOrEqual(5)
    expect(snapshot.requests.inflight).toBe(1)
    expect(snapshot.operationClasses.http.durationMs.percentileMethod).toBe('bucket-upper-bound')
    expect(snapshot.memory.rss).toBeGreaterThan(0)
    expect(body).not.toContain('must-not-be-retained')
    expect(body).not.toContain('performance-reader')
    const mutation = await fetch(base + '/admin/api/performance', { method: 'POST', headers: { cookie: adminCookie, origin: base } })
    expect(mutation.status).toBe(405)
    expect(mutation.headers.get('allow')).toBe('GET')
  })

  it('reports disabled observation explicitly', async () => {
    const { base } = await setup({ HGW_PERFORMANCE_ENABLED: 'false' })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(base + '/admin/api/performance', { headers: { cookie } })
    expect(await response.json()).toMatchObject({ enabled: false, requests: { started: 0, completed: 0 } })
  })

  it('retains response occupancy after its handler returns and preserves caller ownership of a shared observer', async () => {
    const observer = new GatewayPerformanceObserver({ enabled: true, eventLoopResolutionMs: 20 })
    let publishResponse!: (response: import('node:http').ServerResponse) => void
    const pending = new Promise<import('node:http').ServerResponse>(resolve => { publishResponse = resolve })
    const { base } = await setup({}, {
      proxy: async (_req, res) => {
        res.writeHead(200)
        res.flushHeaders()
        publishResponse(res)
      },
    }, observer)
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const request = fetch(base + '/api/performance-stream', { headers: { cookie } })
    const response = await pending
    expect(observer.snapshot(null).requests.inflight).toBe(1)
    response.end('complete')
    expect(await (await request).text()).toBe('complete')
    expect(observer.snapshot(null).requests.inflight).toBe(0)
    await closer?.()
    closer = undefined
    expect(observer.snapshot(null).disposed).toBe(false)
    observer.dispose()
    expect(observer.snapshot(null).disposed).toBe(true)
  })

  it('returns an explicit retryable capacity response when a new Runtime cannot be admitted', async () => {
    const { base } = await setup({}, { proxy: async () => { throw new RuntimeCapacityError('queue-full') } })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(base + '/api/performance-capacity', { headers: { cookie } })
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await response.json()).toMatchObject({ error: { code: 'INSTANCE_CAPACITY' } })
  })

  it.each([
    ['personal', 'zh'], ['personal', 'en'], ['project', 'zh'], ['project', 'en'],
  ] as const)('keeps the %s selection in the %s HTML start failure without changing another tab scope', async (kind, language) => {
    const environment: RuntimeCatalogEntry = { ...conversationEnvironment,
      owner: kind === 'personal' ? { kind: 'personal', id: 1, name: 'root-admin' } : { kind: 'project', id: 1, name: 'Shared' } }
    const { base, deps } = await setup({}, {}, undefined, environment)
    if (kind === 'project') {
      const project = await deps.projects.create({ name: 'Shared', createdBy: 1 })
      expect(project.id).toBe(1)
      installProjectCollaboration(deps)
    }
    const ensure = vi.spyOn(deps.instances, 'ensureRunning').mockRejectedValue(new RuntimeCapacityError('timeout'))
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const target = kind === 'personal' ? 'personal' : 'project:1'
    const action = `/account/runtime/start?dshRuntime=${environment.id}&dshTarget=${encodeURIComponent(target)}`
    const response = await fetch(base + action, { method: 'POST', redirect: 'manual',
      headers: { cookie: `${cookie}; hgw_lang=${language}; hgw_scope=personal`, origin: base,
        'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ kind, ...(kind === 'project' ? { projectId: '1' } : {}) }) })
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(response.headers.get('set-cookie')).toBeNull()
    const page = await response.text()
    expect(page).toContain(`<html lang="${language === 'zh' ? 'zh-CN' : 'en'}">`)
    expect(page).toContain(language === 'zh' ? '电脑暂时繁忙' : 'This computer is busy')
    expect(page).toContain(`action="${action.replaceAll('&', '&amp;')}"`)
    expect(page).toContain(`name="kind" value="${kind}"`)
    if (kind === 'project') expect(page).toContain('name="projectId" value="1"')
    expect(page).not.toContain('http-equiv="refresh"')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({ runtimeId: environment.id })
    expect(ensure.mock.calls[0]?.[1]).toBe('explicit')
  })

  it('keeps scope API capacity failures as JSON without changing an explicit Runtime selection', async () => {
    const environment: RuntimeCatalogEntry = { ...conversationEnvironment, owner: { kind: 'personal', id: 1, name: 'root-admin' } }
    const { base, deps } = await setup({}, {}, undefined, environment)
    const ensure = vi.spyOn(deps.instances, 'ensureRunning').mockRejectedValue(new RuntimeCapacityError('timeout'))
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/account/api/scope?dshRuntime=${environment.id}`, { method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'personal' }) })
    expect(response.status).toBe(503)
    expect(response.headers.get('content-type')).toContain('application/json')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toMatchObject({ error: { code: 'INSTANCE_CAPACITY' } })
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({ runtimeId: environment.id })
  })

  it.each(['html', 'api'] as const)('preserves %s startup refusal during maintenance without starting a Runtime', async presentation => {
    const { base, deps } = await setup()
    deps.maintenanceGate = async () => 'maintenance'
    const ensure = vi.spyOn(deps.instances, 'ensureRunning')
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const html = presentation === 'html'
    const response = await fetch(base + (html ? '/account/runtime/start' : '/account/api/scope'), { method: 'POST',
      headers: { cookie, origin: base, 'content-type': html ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: html ? 'kind=personal' : JSON.stringify({ kind: 'personal' }) })
    expect(response.status).toBe(503)
    expect(response.headers.get('set-cookie')).toBeNull()
    if (html) {
      expect(response.headers.get('content-type')).toContain('text/html')
      const page = await response.text()
      expect(page).toContain('工作环境的状态已变化')
      expect(page).not.toContain('<form')
    } else expect(await response.json()).toEqual({ error: 'maintenance' })
    expect(ensure).not.toHaveBeenCalled()
  })

  it.each([
    ['account', () => new RuntimeAccountError('harness-unprovisioned', 'missing', { cause: new Error('/private/startup-secret') }), 409, '运行账号尚未就绪'],
    ['blocked', () => new RuntimeStartBlockedError('unavailable', '/private/startup-secret'), 503, '工作环境的状态已变化'],
    ['unknown', () => new Error('/private/startup-secret'), 500, '启动未能完成'],
  ] as const)('renders a safe %s HTML startup failure and retains its server diagnostic', async (_reason, failure, status, copy) => {
    const { base, deps } = await setup()
    const error = failure()
    const ensure = vi.spyOn(deps.instances, 'ensureRunning').mockRejectedValue(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const cookie = await login(base, 'root-admin', 'pw-12345678')
      const response = await fetch(base + '/account/runtime/start', { method: 'POST',
        headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'kind=personal' })
      const page = await response.text()
      expect(response.status).toBe(status)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(response.headers.get('retry-after')).toBeNull()
      expect(response.headers.get('set-cookie')).toBeNull()
      expect(page).toContain(copy)
      expect(page).not.toContain('startup-secret')
      expect(page).not.toContain('<form')
      expect(log).toHaveBeenCalledWith('[gateway] request failed:', error)
      expect(ensure).toHaveBeenCalledTimes(1)
    } finally { log.mockRestore() }
  })

  it.each([
    ['invalid form', 'kind=project', ''],
    ['mismatched target', 'kind=personal', '&dshTarget=project%3A1'],
    ['mismatched Runtime', 'kind=personal', ''],
    ['lost project membership', 'kind=project&projectId=7', ''],
  ] as const)('refuses an %s HTML start without launching or offering an unsafe retry', async (reason, body, query) => {
    const { base, deps } = await setup({}, {}, undefined, conversationEnvironment)
    const ensure = vi.spyOn(deps.instances, 'ensureRunning')
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/account/runtime/start?dshRuntime=${conversationEnvironment.id}${query}`, { method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body })
    expect(response.status).toBe(reason === 'lost project membership' ? 403 : 400)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(response.headers.get('set-cookie')).toBeNull()
    const page = await response.text()
    expect(page).toContain(reason === 'lost project membership' ? '没有此工作环境的使用权限' : '启动信息无效')
    expect(page).not.toContain('<form')
    expect(ensure).not.toHaveBeenCalled()
  })

  it.each(['missing', 'unavailable'] as const)('returns a safe %s Linux account diagnostic without exposing command details', async reason => {
    const failure = new RuntimeAccountError('harness-unprovisioned', reason, { cause: new Error('/private/command-secret') })
    const { base } = await setup({}, { proxy: async () => { throw failure } })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(base + '/api/runtime-account', { headers: { cookie } })
    expect(response.status).toBe(failure.status)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: { code: failure.code, message: failure.message } })
  })

  it.each([
    ['database', () => new PostgresCheckoutQueueFullError(1)],
    ['runtime', () => new RuntimeCapacityError('queue-full')],
  ] as const)('terminates a partial response when %s capacity fails after headers', async (_name, failure) => {
    const { base } = await setup({}, {
      proxy: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.flushHeaders()
        res.write('partial')
        throw failure()
      },
    })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    await expect((async () => {
      const response = await fetch(base + '/api/partial-capacity', { headers: { cookie } })
      await response.text()
    })()).rejects.toThrow()
    expect((await fetch(base + '/healthz/live')).status).toBe(200)
  })

  it('returns retryable database overload before routing an authenticated request', async () => {
    const { base, deps } = await setup()
    deps.auth.validate = () => { throw new PostgresCheckoutQueueFullError(1) }
    const response = await fetch(base + '/admin/api/performance', { headers: { cookie: 'hgw_session=fixture-only' } })
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await response.json()).toMatchObject({ error: { code: 'DB_CHECKOUT_QUEUE_FULL' } })
  })

  it('rejects a stale browser principal before HTTP or WebSocket routing while keeping untagged clients compatible', async () => {
    const routed: number[] = [], upgrades: number[] = []
    const { base, deps } = await setup({}, {
      proxy: async (_req, res, context) => { routed.push(context.user.id); res.end('routed') },
      upgrade: async (_req, socket, _head, context) => { upgrades.push(context.user.id); socket.destroy() },
    })
    const second = await deps.users.create({ username: 'second-user', password: 'pw-12345678', role: 'user' })
    await deps.users.changeOwnPassword(second.id, 'pw-12345678')
    const cookie = await login(base, 'second-user', 'pw-12345678')
    const rejected = await fetch(`${base}/api/identity-proof`, { headers: { cookie, 'x-dsh-expected-principal-id': '1' } })
    expect(rejected.status).toBe(409)
    expect(rejected.headers.get('x-dsh-principal-id')).toBe(String(second.id))
    expect(await rejected.json()).toEqual({ error: 'account-changed' })
    for (const principal of ['1', `${second.id}&dshPrincipal=${second.id}`]) {
      const chunk = await fetch(`${base}/api/documents/uploads/00000000-0000-4000-8000-000000000000/chunks/0?dshPrincipal=${principal}&dshTarget=personal`, {
        method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/octet-stream' }, body: 'private document',
      })
      expect(chunk.status).toBe(409)
      expect(await chunk.json()).toEqual({ error: 'account-changed' })
    }
    expect(routed).toEqual([])
    expect((await fetch(`${base}/account/api/context`, { headers: { cookie, 'x-dsh-expected-principal-id': '1' } })).status).toBe(409)
    const accepted = await fetch(`${base}/api/identity-proof`, { headers: { cookie, 'x-dsh-expected-principal-id': String(second.id) } })
    expect(accepted.status).toBe(200)
    expect(accepted.headers.get('x-dsh-principal-id')).toBe(String(second.id))
    expect((await fetch(`${base}/api/identity-proof`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${base}/api/identity-proof?dshPrincipal=${second.id}`, { headers: { cookie } })).status).toBe(200)
    expect(routed).toEqual([second.id, second.id, second.id])
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/events?dshPrincipal=1`, { headers: { cookie, origin: base } })
    const status = await new Promise<number | undefined>((resolveStatus, reject) => {
      socket.once('unexpected-response', (_request, response) => { response.resume(); response.once('end', () => { resolveStatus(response.statusCode) }) })
      socket.once('error', reject)
      socket.once('open', () => { socket.close(); reject(new Error('wrong principal reached WebSocket')) })
    })
    expect(status).toBe(409)
    expect(upgrades).toEqual([])
  })

  it.each(['/?dshRuntime=10000000-0000-4000-8000-000000000001', '/admin/computers/10000000-0000-4000-8000-000000000002/users/7'])('retains %s through a rejected and then successful login', async target => {
    const { base } = await setup()
    const anonymous = await fetch(`${base}${target}`, { headers: { accept: 'text/html' }, redirect: 'manual' })
    expect(anonymous.headers.get('location')).toBe(`/login?returnTo=${encodeURIComponent(target)}`)
    await anonymous.arrayBuffer()
    const rejected = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base }, body: new URLSearchParams({ username: 'root-admin', password: 'wrong-password', returnTo: target }) })
    expect(rejected.status).toBe(401)
    expect(await rejected.text()).toContain(`name="returnTo" value="${target}"`)
    const accepted = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base }, body: new URLSearchParams({ username: 'root-admin', password: 'pw-12345678', returnTo: target }) })
    expect(accepted.status).toBe(302)
    expect(accepted.headers.get('location')).toBe(target)
    await accepted.arrayBuffer()
  })

  it('refuses an external destination submitted to the login form', async () => {
    const { base } = await setup()
    const response = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base }, body: new URLSearchParams({ username: 'root-admin', password: 'pw-12345678', returnTo: '//example.com/admin' }) })
    expect(response.headers.get('location')).toBe('/')
    await response.arrayBuffer()
  })

  it.each([false, true])('keeps the intended environment through required password setup and refuses a substituted external return (%s)', async external => {
    const { base, deps } = await setup()
    await deps.users.create({ username: 'new-member', password: 'initial-password', role: 'user' })
    const target = '/?dshRuntime=10000000-0000-4000-8000-000000000001'
    const signedIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', headers: { origin: base }, body: new URLSearchParams({ username: 'new-member', password: 'initial-password', returnTo: target }) })
    const cookie = signedIn.headers.get('set-cookie')!.split(';')[0]!
    await signedIn.arrayBuffer()
    const required = await fetch(`${base}${target}`, { headers: { cookie, accept: 'text/html' }, redirect: 'manual' })
    expect(required.headers.get('location')).toBe(`/account/password?returnTo=${encodeURIComponent(target)}`)
    await required.arrayBuffer()
    const form = await fetch(`${base}/account/password?returnTo=${encodeURIComponent(target)}`, { headers: { cookie } })
    expect(await form.text()).toContain(`name="returnTo" value="${target}"`)
    const saved = await fetch(`${base}/account/password`, { method: 'POST', redirect: 'manual', headers: { origin: base, cookie }, body: new URLSearchParams({ password: 'updated-password', returnTo: external ? '//example.com/admin' : target }) })
    expect(saved.headers.get('location')).toBe(external ? '/' : target)
    await saved.arrayBuffer()
  })

  it('serves healthz without auth and redirects anonymous html to /login', async () => {
    const { base } = await setup()
    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true, configurationRevision: 0 })
    const anonymous = await fetch(`${base}/`, { redirect: 'manual', headers: { accept: 'text/html' } })
    expect(anonymous.status).toBe(302)
    expect(anonymous.headers.get('location')).toBe('/login')
    const api = await fetch(`${base}/api/session.list`, { method: 'POST', headers: { origin: base } })
    expect(api.status).toBe(401)
  })

  it('publishes the immutable release identifier in health diagnostics', async () => {
    const releaseRoot = realpathSync(join(import.meta.dirname, '../..'))
    const { base } = await setup({ HGW_RELEASE_ROOT: releaseRoot })

    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({
      ok: true,
      release: basename(releaseRoot),
      configurationRevision: 0,
    })
  })

  it('serves the alternate document-scope list in the Gateway without proxying it', async () => {
    const documentTransferList = vi.fn(async ({ user, payload }: { user: { id: number }; payload: unknown }) => {
      expect(user.id).toBe(1)
      expect(payload).toEqual({ version: 1, scope: { kind: 'personal' } })
      return {
        version: 1 as const,
        scope: { kind: 'personal' as const, label: 'Personal documents' },
        documents: [],
      }
    })
    const { deps, base } = await setup({}, { documentTransferList })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/api/documents/transfer/list`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, scope: { kind: 'personal' } }),
      redirect: 'manual',
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({
      version: 1,
      scope: { kind: 'personal', label: 'Personal documents' },
      documents: [],
    })
    expect(documentTransferList).toHaveBeenCalledOnce()
    expect(await deps.audit.query({ action: 'api' })).toEqual([])
  })

  it('maps an unexpected document scope listing failure to a retryable response', async () => {
    const documentTransferList = vi.fn(async () => { throw new Error('runtime detail') })
    const { deps, base } = await setup({}, { documentTransferList })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/api/documents/transfer/list`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, scope: { kind: 'personal' } }),
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: { code: 'DOCUMENT_TRANSFER_UNAVAILABLE', message: 'Document scope listing is temporarily unavailable.' },
    })
    expect(await deps.audit.query({ action: 'api' })).toEqual([
      expect.objectContaining({ methodPath: 'POST /api/documents/transfer/list', status: 503 }),
    ])
  })

  it('dispatches target-scope upload requests before the runtime proxy', async () => {
    const upload = vi.fn(async ({ user, scope, pathname }: { user: { id: number }; scope: unknown; pathname: string }) => {
      expect(user.id).toBe(1)
      expect(scope).toEqual({ kind: 'personal' })
      expect(pathname).toBe('/api/documents/transfer/uploads')
      return new Response(JSON.stringify({
        uploadId: '00000000-0000-4000-8000-000000000000', name: 'hello.txt', directoryId: '', bytes: 0,
        fingerprint: 'x', chunkBytes: 64, receivedBytes: 0, expiresAt: Date.now() + 1_000, state: 'complete',
        ref: { docId: 'hello.txt', name: 'hello.txt', bytes: 0, mediaType: 'text/plain', modifiedAt: 1, path: '' },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const { base } = await setup({}, { documentTransferUpload: upload })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/api/documents/transfer/uploads?scope=personal`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, name: 'hello.txt', directory: '', bytes: 0, fingerprint: 'x' }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'complete', ref: { path: '' } })
    expect(upload).toHaveBeenCalledOnce()
  })

  it('rejects a target upload without a valid compact scope key', async () => {
    const upload = vi.fn(async () => new Response('{}', { status: 200 }))
    const { base } = await setup({}, { documentTransferUpload: upload })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/api/documents/transfer/uploads?scope=project:0`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1 }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: { code: 'INVALID_DOCUMENT_TRANSFER', message: 'Invalid document upload scope.' } })
    expect(upload).not.toHaveBeenCalled()
  })

  it.each(['account', 'project', 'monitor'] as const)('cancels a browser upload on %s invalidation and joins its cleanup', async (reason) => {
    const entered = deferred<AbortSignal>(), cleanup = deferred<undefined>()
    const listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
    const { base, deps } = await setup({}, { documentTransferUpload: async ({ signal }) => {
      entered.resolve(signal)
      await cleanup.promise
      return new Response('{}')
    } })
    let available = true
    deps.accessMonitor = { get available() { return available }, synchronize: async () => {}, subscribe: listener => {
      listeners.add(listener); return () => { listeners.delete(listener) }
    } }
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const pending = Promise.allSettled([fetch(`${base}/api/documents/transfer/uploads?scope=project:41`, {
      method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: '{}',
    })])
    let notified: Promise<void> | undefined
    try {
      const signal = await entered.promise
      for (const subject of [{ userId: 999 }, { projectId: 999 }]) {
        await Promise.all([...listeners].map(listener => listener(subject)))
        expect(signal.aborted).toBe(false)
      }
      if (reason === 'monitor') available = false
      const subject = reason === 'account' ? { userId: 1 } : reason === 'project' ? { projectId: 41 } : {}
      let acknowledged = false
      notified = Promise.all([...listeners].map(listener => listener(subject))).then(() => { acknowledged = true })
      expect(signal.aborted).toBe(true)
      expect(acknowledged).toBe(false)
      cleanup.resolve(undefined)
      await notified
      expect(acknowledged).toBe(true)
      const [result] = await pending
      expect(result?.status).toBe('rejected')
      expect(listeners.size).toBe(0)
    } finally {
      cleanup.resolve(undefined)
      await notified
      await pending
    }
  })

  it('checks the current login after replaying earlier document access changes', async () => {
    const upload = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      expect(signal.aborted).toBe(false)
      return new Response('{}')
    })
    const { base, deps } = await setup({}, { documentTransferUpload: upload })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
    deps.accessMonitor = { available: true, synchronize: async () => {
      await Promise.all([...listeners].map(listener => listener({ userId: 1 })))
    }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    // Only the first catch-up contains the earlier change; later reads are current.
    const catchUp = deps.accessMonitor.synchronize
    let reads = 0
    deps.accessMonitor.synchronize = async () => { if (++reads === 1) await catchUp() }
    const response = await fetch(`${base}/api/documents/transfer/uploads?scope=personal`, {
      method: 'POST', headers: { cookie, origin: base }, body: '{}',
    })
    expect(response.status).toBe(200); await response.arrayBuffer()
    expect(reads).toBe(2)
    expect(upload).toHaveBeenCalledOnce()
    expect(listeners.size).toBe(0)
  })

  it.each(['login', 'monitor'] as const)('refuses browser upload admission when the %s is unavailable', async (reason) => {
    const upload = vi.fn(async () => new Response('{}'))
    const { base, deps } = await setup({}, { documentTransferUpload: upload })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    deps.accessMonitor = { available: reason !== 'monitor', synchronize: async () => {}, subscribe: () => () => {} }
    const validate = deps.auth.validate.bind(deps.auth)
    let calls = 0
    const validation = vi.spyOn(deps.auth, 'validate').mockImplementation(token => {
      if (++calls > 1 && reason === 'login') return null
      return validate(token)
    })
    try {
      const response = await fetch(`${base}/api/documents/transfer/uploads?scope=personal`, {
        method: 'POST', headers: { cookie, origin: base }, body: '{}',
      })
      expect(response.status).toBe(reason === 'login' ? 401 : 503); await response.arrayBuffer()
      expect(upload).not.toHaveBeenCalled()
    } finally { validation.mockRestore() }
  })

  it('refuses a browser upload revoked during current-login validation without waiting on itself', async () => {
    const upload = vi.fn(async () => new Response('{}'))
    const { base, deps } = await setup({}, { documentTransferUpload: upload })
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
    let reads = 0
    deps.accessMonitor = { available: true, synchronize: async () => {
      if (++reads === 2) await Promise.all([...listeners].map(listener => listener({ userId: 1 })))
    }, subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } }
    await expect(fetch(`${base}/api/documents/transfer/uploads?scope=personal`, {
      method: 'POST', headers: { cookie, origin: base }, body: '{}',
    })).rejects.toBeInstanceOf(Error)
    expect(upload).not.toHaveBeenCalled()
    expect(listeners.size).toBe(0)
  })

  it('streaming runtime: handles authenticated raw bytes before the buffered API limit', async () => {
    const buffered = vi.fn<GatewayRuntimeHandler>(async () => false)
    const stream: NonNullable<GatewayRuntimeHandler['stream']> = async (req, res, pathname) => {
      if (pathname !== '/internal/runtime/documents/store') return false
      let bytes = 0
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) throw new Error('The fixture requires raw byte chunks.')
        bytes += chunk.length
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ bytes }))
      return true
    }
    const { base } = await setup({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '16' }, {
      runtimeAuthorize: async () => true, runtime: Object.assign(buffered, { stream }),
    })
    const response = await fetch(`${base}/internal/runtime/documents/store`, { method: 'POST', body: 'x'.repeat(32) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ bytes: 32 })
    expect(buffered).not.toHaveBeenCalled()
  })

  it('streaming runtime: refuses an invalid runtime before either handler consumes its body', async () => {
    const buffered = vi.fn<GatewayRuntimeHandler>(async () => false)
    const stream = vi.fn<NonNullable<GatewayRuntimeHandler['stream']>>(async () => true)
    const { base } = await setup({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '16' }, {
      runtimeAuthorize: async () => false, runtime: Object.assign(buffered, { stream }),
    })
    const response = await fetch(`${base}/internal/runtime/documents/store`, { method: 'POST', body: 'x'.repeat(32) })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid-runtime-token' })
    expect(stream).not.toHaveBeenCalled()
    expect(buffered).not.toHaveBeenCalled()
  })

  it('streaming runtime: leaves an unhandled request subject to the original buffered limit', async () => {
    const buffered = vi.fn<GatewayRuntimeHandler>(async (_req, res, _path, body) => {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ body }))
      return true
    })
    const stream = vi.fn<NonNullable<GatewayRuntimeHandler['stream']>>(async () => false)
    const { base } = await setup({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '16' }, {
      runtimeAuthorize: async () => true, runtime: Object.assign(buffered, { stream }),
    })
    const accepted = await fetch(`${base}/internal/runtime/control`, { method: 'POST', body: 'x'.repeat(16) })
    expect(accepted.status).toBe(200)
    expect(await accepted.json()).toEqual({ body: 'x'.repeat(16) })
    const rejected = await fetch(`${base}/internal/runtime/control`, { method: 'POST', body: 'x'.repeat(17) })
    expect(rejected.status).toBe(413)
    expect(await rejected.json()).toEqual({ error: 'runtime-request-too-large' })
    expect(stream).toHaveBeenCalledTimes(2)
    expect(buffered).toHaveBeenCalledTimes(1)
  })

  it('streaming runtime: retains read access in maintenance and holds a writer span through write responses', async () => {
    const buffered = vi.fn<GatewayRuntimeHandler>(async () => false)
    const stream: NonNullable<GatewayRuntimeHandler['stream']> = async (req, res, pathname, writeGate) => {
      if (!pathname.startsWith('/internal/runtime/stream/')) return false
      const verdict = pathname.endsWith('/read') ? 'open' : await writeGate()
      req.resume()
      res.writeHead(verdict === 'open' ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ verdict }))
      return true
    }
    const { base, deps } = await setup({}, { runtimeAuthorize: async () => true, runtime: Object.assign(buffered, { stream }) })
    let verdict: 'open' | 'maintenance' = 'maintenance', writers = 0, released = 0
    const gate = vi.fn(async () => verdict)
    deps.maintenanceGate = gate
    deps.writerSpan = () => { writers++; return () => { writers--; released++ } }
    const read = await fetch(`${base}/internal/runtime/stream/read`, { method: 'POST', body: 'read metadata' })
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ verdict: 'open' })
    expect(gate).not.toHaveBeenCalled()
    expect(released).toBe(0)
    const blocked = await fetch(`${base}/internal/runtime/stream/write`, { method: 'POST', body: 'raw bytes' })
    expect(blocked.status).toBe(503)
    expect(await blocked.json()).toEqual({ verdict: 'maintenance' })
    expect(writers).toBe(0); expect(released).toBe(1)
    const blockedGet = await fetch(`${base}/internal/runtime/stream/write`)
    expect(blockedGet.status).toBe(503)
    expect(await blockedGet.json()).toEqual({ verdict: 'maintenance' })
    expect(writers).toBe(0); expect(released).toBe(2)
    verdict = 'open'
    const written = await fetch(`${base}/internal/runtime/stream/write`, { method: 'POST', body: 'raw bytes' })
    expect(written.status).toBe(200)
    expect(await written.json()).toEqual({ verdict: 'open' })
    expect(writers).toBe(0); expect(released).toBe(3)
    expect(buffered).not.toHaveBeenCalled()
  })

  it('uses the runtime API body limit and returns JSON 413 before dispatch', async () => {
    const received: string[] = []
    const { base } = await setup({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '16' }, {
      runtimeAuthorize: async () => true,
      runtime: async (_req, res, _pathname, body) => {
        received.push(body)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
        return true
      },
    })
    const accepted = await fetch(`${base}/internal/runtime/test`, { method: 'POST', body: '1234567890123456' })
    expect(accepted.status).toBe(200)
    const rejected = await fetch(`${base}/internal/runtime/test`, { method: 'POST', body: '12345678901234567' })
    expect(rejected.status).toBe(413)
    expect(rejected.headers.get('content-type')).toBe('application/json')
    expect(await rejected.json()).toEqual({ error: 'runtime-request-too-large' })
    expect(received).toEqual(['1234567890123456'])
  })

  it('returns a safe JSON envelope when an unexpected runtime request fails', async () => {
    const { base } = await setup({}, {
      runtimeAuthorize: async () => true,
      runtime: async () => { throw new Error('database details must stay server-side') },
    })

    const response = await fetch(`${base}/internal/runtime/session/append`, {
      method: 'POST',
      body: '{}',
    })

    expect(response.status).toBe(500)
    expect(response.headers.get('content-type')).toMatch(/application\/json/)
    expect(await response.json()).toEqual({
      error: 'runtime-internal',
      code: 'internal',
      message: 'The runtime could not complete this request.',
    })
  })

  it('rejects an unauthenticated runtime request before reading its body', async () => {
    const authorize = vi.fn(async () => false)
    const runtime = vi.fn(async () => true)
    const { base } = await setup({ HGW_RUNTIME_API_BODY_LIMIT_BYTES: '16' }, {
      runtimeAuthorize: authorize,
      runtime,
    })

    const response = await fetch(`${base}/internal/runtime/test`, {
      method: 'POST',
      body: '12345678901234567',
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'invalid-runtime-token' })
    expect(authorize).toHaveBeenCalledOnce()
    expect(runtime).not.toHaveBeenCalled()
  })

  it('logs in, enforces csrf origin, logs out', async () => {
    const { base } = await setup()
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const evil = await fetch(`${base}/api/x`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    })
    expect(evil.status).toBe(403)
    expect(evil.headers.get('content-type')).toMatch(/text\/plain/)
    expect(await evil.text()).toBe('origin not allowed')
    const out = await fetch(`${base}/logout`, {
      method: 'POST', redirect: 'manual', headers: { cookie, origin: base },
    })
    expect(out.status).toBe(302)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    const after = await fetch(`${base}/api/x`, { method: 'POST', headers: { cookie, origin: base } })
    expect(after.status).toBe(401)
  })

  it('registers and removes push devices only through an authenticated same-origin request', async () => {
    const { deps, base } = await setup()
    const registerDevice = vi.fn(async (userId: number, input: {
      token: string
      platform: 'android'
      provider?: 'fcm' | 'jpush'
      deviceId?: string
      appVersion?: string
    }) => {
      expect(userId).toBe(1)
      return { id: `device-${input.token}` }
    })
    const removeDevice = vi.fn(async (userId: number, deviceId: string) => userId === 1
      && deviceId === '018f8c3e-9d74-7f2e-b4a1-2c3d4e5f6a7b')
    deps.push = {
      registerDevice,
      removeDevice,
      notifyCompleted: vi.fn(async () => {}),
    }
    const cookie = await login(base, 'root-admin', 'pw-12345678')

    const registered = await fetch(`${base}/account/api/push-devices`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token', platform: 'android', appVersion: '1.0.0' }),
    })
    expect(registered.status).toBe(201)
    expect(await registered.json()).toEqual({ id: 'device-token' })
    expect(registerDevice).toHaveBeenCalledWith(1, {
      token: 'token', platform: 'android', provider: 'fcm', appVersion: '1.0.0',
    })

    const jpushRegistered = await fetch(`${base}/account/api/push-devices`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'jpush-token', platform: 'android', provider: 'jpush' }),
    })
    expect(jpushRegistered.status).toBe(201)
    expect(registerDevice).toHaveBeenCalledWith(1, {
      token: 'jpush-token', platform: 'android', provider: 'jpush',
    })

    const invalid = await fetch(`${base}/account/api/push-devices`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token', platform: 'ios' }),
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'invalid-push-device' })

    const invalidProvider = await fetch(`${base}/account/api/push-devices`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'token', platform: 'android', provider: 'unknown' }),
    })
    expect(invalidProvider.status).toBe(400)
    expect(await invalidProvider.json()).toEqual({ error: 'invalid-push-device' })

    const removed = await fetch(`${base}/account/api/push-devices/018f8c3e-9d74-7f2e-b4a1-2c3d4e5f6a7b`, {
      method: 'DELETE', headers: { cookie, origin: base },
    })
    expect(removed.status).toBe(204)
    expect(removeDevice).toHaveBeenCalledWith(1, '018f8c3e-9d74-7f2e-b4a1-2c3d4e5f6a7b')

    const malformed = await fetch(`${base}/account/api/push-devices/not-a-uuid`, {
      method: 'DELETE', headers: { cookie, origin: base },
    })
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'invalid-push-device-id' })
  })

  it('forces password change before proxying', async () => {
    const { deps, base } = await setup()
    await deps.users.create({ username: 'fresh', password: 'pw-11111111' })
    const cookie = await login(base, 'fresh', 'pw-11111111')
    const blocked = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie, accept: 'text/html' } })
    expect(blocked.status).toBe(302)
    expect(blocked.headers.get('location')).toBe('/account/password')
    const change = await fetch(`${base}/account/password`, {
      method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ password: 'pw-22222222' }),
    })
    expect(change.status).toBe(302)
    const proxied = await fetch(`${base}/`, { redirect: 'manual', headers: { cookie, accept: 'text/html' } })
    expect(proxied.status).toBe(503)
  })

  it('keeps an active browser session until its absolute expiry', async ({ signal }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { base } = await setup({ HGW_SESSION_TTL_MS: '2000', HGW_SESSION_ABS_TTL_MS: '10000' })
      const signedIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', signal,
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'root-admin', password: 'pw-12345678' }) })
      const cookie = signedIn.headers.get('set-cookie') ?? ''
      await signedIn.arrayBuffer()
      expect(signedIn.status).toBe(302)
      const token = cookie.split(';')[0]!
      const retention = Number(/Max-Age=([0-9]+)/.exec(cookie)?.[1])
      expect(Number.isSafeInteger(retention)).toBe(true)
      const issuedAt = Date.now(), browserExpiry = issuedAt + retention * 1000, statuses: number[] = []
      // Browser expiry follows the received Max-Age; only Date is faked, so owned HTTP and Argon2 work remain real.
      for (let seconds = 1; seconds < 10; seconds++) {
        vi.setSystemTime(issuedAt + seconds * 1000)
        const response = await fetch(`${base}/admin/api/performance`, {
          signal, headers: Date.now() < browserExpiry ? { cookie: token } : {},
        })
        await response.arrayBuffer()
        statuses.push(response.status)
        expect(response.status).toBe(200)
      }
      vi.setSystemTime(issuedAt + 10001)
      const expired = await fetch(`${base}/admin/api/performance`, { headers: { cookie: token }, signal })
      await expired.arrayBuffer()
      expect(expired.status).toBe(401)
      const idleCookie = await login(base, 'root-admin', 'pw-12345678')
      vi.setSystemTime(Date.now() + 2001)
      const idle = await fetch(`${base}/admin/api/performance`, { headers: { cookie: idleCookie }, signal })
      await idle.arrayBuffer()
      expect(idle.status).toBe(401)
      await expect(['# Browser session retention', '', `cookieMaxAgeSeconds=${retention}`,
        `activeRequestStatuses=${statuses.join(',')}`, `afterAbsoluteExpiry=${expired.status}`, `afterIdleExpiry=${idle.status}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/auth/browser-session-retention.expected.md'))
    } finally { vi.useRealTimers() }
  })

  it('issues a usable browser cookie for a sub-second session lifetime', async ({ signal }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { base } = await setup({ HGW_SESSION_TTL_MS: '100', HGW_SESSION_ABS_TTL_MS: '900' })
      const signedIn = await fetch(`${base}/login`, { method: 'POST', redirect: 'manual', signal,
        headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'root-admin', password: 'pw-12345678' }) })
      await signedIn.arrayBuffer()
      expect(signedIn.status).toBe(302)
      const cookie = signedIn.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('Max-Age=1')
      const token = cookie.split(';')[0]!, issuedAt = Date.now()
      vi.setSystemTime(issuedAt + 50)
      const active = await fetch(`${base}/admin/api/performance`, { signal, headers: { cookie: token } })
      await active.arrayBuffer()
      expect(active.status).toBe(200)
      vi.setSystemTime(issuedAt + 901)
      const expired = await fetch(`${base}/admin/api/performance`, { signal, headers: { cookie: token } })
      await expired.arrayBuffer()
      expect(expired.status).toBe(401)
      await expect(['# Sub-second browser session', '', 'cookieMaxAgeSeconds=1',
        `whileActive=${active.status}`, `afterServerExpiry=${expired.status}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/auth/browser-sub-second-session.expected.md'))
    } finally { vi.useRealTimers() }
  })

  it('retains a selected project for a sub-second session lifetime', async ({ signal }) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const { deps, base, projects } = await setup({ HGW_SESSION_TTL_MS: '100', HGW_SESSION_ABS_TTL_MS: '900' }, {
        proxy: async (_request, response, context) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ scope: context.scope.kind }))
        },
      })
      installProjectCollaboration(deps)
      const owner = await deps.users.getByUsername('root-admin')
      const project = await projects.createManaged({ name: 'Small lifetime', ownerUserId: owner!.id })
      vi.spyOn(deps.instances, 'ensureRunning').mockResolvedValue({ port: 43200, generation: 1 })
      const cookie = await login(base, 'root-admin', 'pw-12345678')
      const selected = await fetch(`${base}/account/api/scope`, { method: 'POST', signal,
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'project', projectId: project.id }) })
      expect(selected.status).toBe(204)
      const scope = selected.headers.get('set-cookie') ?? ''
      expect(scope).toContain('Max-Age=1')
      const selectedCookie = `${cookie}; ${scope.split(';')[0]!}`, issuedAt = Date.now()
      vi.setSystemTime(issuedAt + 50)
      const active = await fetch(`${base}/api/scope-fixture`, { signal, headers: { cookie: selectedCookie } })
      expect(active.status).toBe(200)
      expect(await active.json()).toEqual({ scope: 'project' })
      vi.setSystemTime(issuedAt + 901)
      const expired = await fetch(`${base}/api/scope-fixture`, { signal, headers: { cookie: selectedCookie } })
      await expired.arrayBuffer()
      expect(expired.status).toBe(401)
      await expect(['# Sub-second selected project', '', 'scopeCookieMaxAgeSeconds=1',
        `selectedScope=project`, `whileActive=${String(active.status)}`, `afterServerExpiry=${String(expired.status)}`, '',
      ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, 'snapshots/auth/browser-sub-second-scope.expected.md'))
    } finally { vi.useRealTimers() }
  })

  it.for(['zh', 'en'] as const)('keeps an overlong password error on the %s password form', async (language, { signal }) => {
    const { deps, base } = await setup()
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const mutate = vi.spyOn(deps.users, 'changeOwnPassword')
    const response = await fetch(`${base}/account/password`, {
      method: 'POST', redirect: 'manual', signal,
      headers: { cookie: `${cookie}; hgw_lang=${language}`, origin: base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }),
    })
    const page = await response.text()
    expect(response.status).toBe(400)
    expect(mutate).not.toHaveBeenCalled()
    const error = language === 'zh' ? `密码最多 ${MAX_PASSWORD_LENGTH} 位` : `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`
    expect(page).toContain(error)
    expect(page).toContain('name="password"')
    await expect(['# Password form validation', '', `language=${language}`, `httpStatus=${response.status}`,
      `error=${error}`, `passwordUnchanged=${!mutate.mock.calls.length}`, '',
    ].join('\n')).toMatchFileSnapshot(join(import.meta.dirname, `snapshots/auth/password-limit-${language}.expected.md`))
  })

  it('does not steal the proxy for /adminfoo', async () => {
    const { base } = await setup()
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const res = await fetch(`${base}/adminfoo`, { headers: { cookie } })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'proxy-not-configured' })
  })

  it('reads usage for the active personal or project scope', async () => {
    const { deps, base } = await setup()
    const calls: Array<{ subject: ModelUsageSubject; month?: string }> = []
    deps.governance = {
      summary: (subject, month) => {
        calls.push({ subject, ...(month === undefined ? {} : { month }) })
        return { ...emptyUsageSummary, month: month ?? emptyUsageSummary.month }
      },
    } as NonNullable<GatewayDeps['governance']>
    deps.collaboration = {
      projectForUser: (projectId, userId) => projectId === 42 && userId === 1
        ? { projectId, name: 'Shared project', path: '/shared', mode: 'rw' }
        : null,
    } as NonNullable<GatewayDeps['collaboration']>
    const cookie = await login(base, 'root-admin', 'pw-12345678')

    expect((await fetch(`${base}/account/api/usage?month=2026-07`, {
      headers: { cookie },
    })).status).toBe(200)
    expect((await fetch(`${base}/account/api/usage?month=2026-06`, {
      headers: { cookie: `${cookie}; hgw_scope=project:42` },
    })).status).toBe(200)

    expect(calls).toEqual([
      { subject: { kind: 'user', id: 1 }, month: '2026-07' },
      { subject: { kind: 'project', id: 42 }, month: '2026-06' },
    ])
  })

  it('builds account context owner flags from one project catalog read', async () => {
    const { deps, base } = await setup()
    const project = await deps.projects.create({ name: 'context-project', createdBy: 1 })
    deps.collaboration = {
      projectsForUser: () => [{ projectId: project.id, name: project.name, path: project.path, mode: 'rw' }],
      projectForUser: () => ({
        projectId: project.id, name: project.name, path: project.path, mode: 'rw', administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const,
      }),
      access: () => { throw new Error('not implemented in context test') },
      listConversations: () => [],
      readableSessionIds: () => [],
      setVisibility: () => { throw new Error('not implemented in context test') },
      claimInteraction: () => false, listActivity: async () => ({ items: [] }),
    } satisfies GatewayCollaborationService
    const list = vi.spyOn(deps.projects, 'list')
    const detail = vi.spyOn(deps.projects, 'getById')
    const cookie = await login(base, 'root-admin', 'pw-12345678')

    const response = await fetch(`${base}/account/api/context`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      projects: [expect.objectContaining({ name: 'context-project', canManage: true })],
    })
    // The collaboration stub supplies the membership set; one catalog read
    // supplies all owner rows, with no per-project detail read.
    expect(list).toHaveBeenCalledTimes(1)
    expect(detail).not.toHaveBeenCalled()
  })

  it('serves an ACL-filtered account conversation catalog for the workbench', async () => {
    const { deps, base } = await setup()
    const project = await deps.projects.create({ name: 'workbench-project', createdBy: 1 })
    deps.collaboration = {
      projectsForUser: () => [{ projectId: project.id, name: project.name, path: project.path, mode: 'ro' }],
      projectForUser: () => ({ projectId: project.id, name: project.name, path: project.path, mode: 'ro', administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }),
      listAccountConversations: () => [{
        sessionId: 'project-session',
        runtime: { kind: 'project', projectId: project.id, projectName: project.name },
        visibility: 'project', creatorUserId: 2, creatorDisplayName: 'Alice',
        updatedAt: 123, blank: false, canWrite: false,
      }],
      access: () => { throw new Error('not implemented in catalog test') },
      listConversations: () => [],
      readableSessionIds: () => [],
      setVisibility: () => { throw new Error('not implemented in catalog test') },
      claimInteraction: () => false, listActivity: async () => ({ items: [] }),
    } satisfies GatewayCollaborationService
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/account/api/workbench/catalog`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      personal: { id: 1 },
      personalComplete: false,
      projects: [expect.objectContaining({ projectId: project.id, mode: 'ro' })],
      items: [expect.objectContaining({ sessionId: 'project-session', canWrite: false })],
    })
  })

  it.each([false, true])('exposes personal catalog completeness %s through the authenticated route', async (personalComplete) => {
    const { deps, base } = await setup({}, { workbenchCatalog: async () => ({ items: [], personalComplete }) })
    installProjectCollaboration(deps)
    deps.collaboration!.listAccountConversations = async () => []
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/account/api/workbench/catalog`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ personalComplete, items: [] })
  })

  it('routes a target-runtime API request through membership-checked context', async () => {
    const proxy = vi.fn(async (_req, res, context) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ kind: context.scope.kind, projectId: context.scope.kind === 'project' ? context.scope.projectId : null }))
    })
    const { deps, base } = await setup({}, { proxy })
    const project = await deps.projects.create({ name: 'target-project', createdBy: 1 })
    installProjectCollaboration(deps)
    deps.collaboration!.projectForUser = async (projectId, userId) => projectId === project.id && userId === 1
      ? { projectId, name: project.name, path: project.path, mode: 'ro', administrator: false, canManage: false, uiThemePolicy: 'follow-user' as const }
      : null
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/api/session.list?dshTarget=project:${String(project.id)}`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ kind: 'project', projectId: project.id })
    expect(proxy).toHaveBeenCalledOnce()
  })

  it('uses authorized remote project owner metadata without reading details on the entry computer', async () => {
    const { deps, base } = await setup()
    installProjectCollaboration(deps)
    deps.collaboration!.projectsForUser = async () => [{ projectId: 991, name: 'Remote project', path: '/remote/project', mode: 'rw',
      nodeId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as import('../src/runtime-catalog.ts').RuntimeNodeId,
      nodeName: 'Ubuntu', owner: { id: 1, username: 'root-admin', displayName: 'Administrator' }, origin: 'user' }]
    deps.projects.getByIds = vi.fn(async () => [])
    const details = vi.spyOn(deps.projects, 'getById').mockResolvedValue(null)
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/account/api/context`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ projects: [{ projectId: 991, nodeName: 'Ubuntu', canManage: true,
      owner: { id: 1, username: 'root-admin' }, origin: 'user' }] })
    expect(details).not.toHaveBeenCalled()
  })

  it('keeps the detail fallback for legacy catalogs without owner metadata', async () => {
    const { deps, base } = await setup()
    const project = await deps.projects.create({ name: 'legacy-context-project', createdBy: 1 })
    const catalog = vi.spyOn(deps.projects, 'list').mockReturnValue([{
      id: project.id,
      name: project.name,
      path: project.path,
      memberCount: project.memberCount,
      origin: project.origin,
    }])
    deps.collaboration = {
      projectsForUser: () => [{ projectId: project.id, name: project.name, path: project.path, mode: 'rw' }],
      projectForUser: () => ({
        projectId: project.id, name: project.name, path: project.path, mode: 'rw', administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const,
      }),
      access: () => { throw new Error('not implemented in legacy context test') },
      listConversations: () => [],
      readableSessionIds: () => [],
      setVisibility: () => { throw new Error('not implemented in legacy context test') },
      claimInteraction: () => false, listActivity: async () => ({ items: [] }),
    } satisfies GatewayCollaborationService
    const detail = vi.spyOn(deps.projects, 'getById')
    const cookie = await login(base, 'root-admin', 'pw-12345678')

    const response = await fetch(`${base}/account/api/context`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      projects: [expect.objectContaining({ name: 'legacy-context-project', canManage: true })],
    })
    expect(catalog).toHaveBeenCalledTimes(1)
    expect(detail).toHaveBeenCalledWith(project.id)
  })

  it('starts the selected runtime before persisting a personal or project scope', async () => {
    const { deps, base } = await setup()
    installProjectCollaboration(deps)
    vi.spyOn(deps.collaboration!, 'projectForUser').mockImplementation((projectId, userId) =>
      projectId === 42 && userId === 1
        ? {
            projectId,
            name: 'Shared project',
            path: '/shared',
            mode: 'rw',
            administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const,
          }
        : null)
    const ensureRunning = vi.spyOn(deps.instances, 'ensureRunning').mockResolvedValue({ port: 43200, generation: 1 })
    const cookie = await login(base, 'root-admin', 'pw-12345678')

    const project = await fetch(`${base}/account/api/scope`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'project', projectId: 42 }),
    })
    expect(project.status).toBe(204)
    expect(project.headers.get('set-cookie')).toContain('hgw_scope=project:42')
    expect(ensureRunning).toHaveBeenNthCalledWith(1, {
      kind: 'project', id: 42, name: 'Shared project', path: '/shared', steward: false,
    }, 'explicit')

    const personal = await fetch(`${base}/account/api/scope`, {
      method: 'POST',
      headers: { cookie, origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'personal' }),
    })
    expect(personal.status).toBe(204)
    expect(personal.headers.get('set-cookie')).toContain('hgw_scope=personal')
    expect(ensureRunning).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: 1, username: 'root-admin' }), 'explicit')
  })

  it('keeps the current scope when the selected runtime cannot start', async () => {
    const { deps, base } = await setup()
    installProjectCollaboration(deps)
    vi.spyOn(deps.collaboration!, 'projectForUser').mockReturnValue({
      projectId: 42,
      name: 'Shared project',
      path: '/shared',
      mode: 'rw',
      administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const,
    })
    vi.spyOn(deps.instances, 'ensureRunning').mockRejectedValue(new Error('runtime failed'))
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    try {
      const response = await fetch(`${base}/account/api/scope`, {
        method: 'POST',
        headers: { cookie, origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'project', projectId: 42 }),
      })
      expect(response.status).toBe(500)
      expect(response.headers.get('set-cookie')).toBeNull()
    } finally {
      logged.mockRestore()
    }
  })

  it('lets a user own a managed project, invite a member, and exposes one admin project view', async () => {
    const { deps, base } = await setup()
    const alice = await deps.users.create({ username: 'alice', password: 'pw-12345678', displayName: 'Alice' })
    const bob = await deps.users.create({ username: 'bob', password: 'pw-12345678', displayName: 'Bob' })
    await deps.users.changeOwnPassword(alice.id, 'pw-12345678')
    await deps.users.changeOwnPassword(bob.id, 'pw-12345678')
    installProjectCollaboration(deps)

    const aliceCookie = await login(base, 'alice', 'pw-12345678')
    const created = await fetch(`${base}/account/api/projects`, {
      method: 'POST', headers: {
        cookie: aliceCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ name: '  Alice workspace  ' }),
    })
    expect(created.status).toBe(201)
    const project = await created.json() as {
      id: number; name: string; path: string; origin: string; owner: { id: number }; memberCount: number
      modelAccessDefaultAllowed: boolean
    }
    expect(project).toMatchObject({
      name: 'Alice workspace', origin: 'user', owner: { id: alice.id }, memberCount: 1,
      modelAccessDefaultAllowed: true,
    })
    expect(project.path.startsWith(realpathSync(deps.cfg.userProjectsRoot) + '/')).toBe(true)

    const aliceContext = await fetch(`${base}/account/api/context`, { headers: { cookie: aliceCookie } })
    expect(aliceContext.status).toBe(200)
    expect(await aliceContext.json()).toMatchObject({
      fullAccess: false,
      projects: [{ projectId: project.id, mode: 'rw', canManage: true }],
    })

    const invitationResponse = await fetch(`${base}/account/api/projects/${project.id}/invitations`, {
      method: 'POST', headers: {
        cookie: aliceCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ username: 'bob', mode: 'ro' }),
    })
    expect(invitationResponse.status).toBe(201)
    const invitation = await invitationResponse.json() as { id: string; status: string; invitee: { username: string }; mode: string }
    expect(invitation).toMatchObject({ status: 'pending', mode: 'ro', invitee: { username: 'bob' } })

    const bobCookie = await login(base, 'bob', 'pw-12345678')
    const bobInvitations = await fetch(`${base}/account/api/invitations`, { headers: { cookie: bobCookie } })
    expect(bobInvitations.status).toBe(200)
    expect(await bobInvitations.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: invitation.id })]))
    const accepted = await fetch(`${base}/account/api/invitations/${encodeURIComponent(invitation.id)}/accept`, {
      method: 'POST', headers: { cookie: bobCookie, origin: base },
    })
    expect(accepted.status).toBe(204)

    const bobContext = await fetch(`${base}/account/api/context`, { headers: { cookie: bobCookie } })
    expect(await bobContext.json()).toMatchObject({
      fullAccess: false,
      projects: [{ projectId: project.id, mode: 'ro' }],
    })
    const bobCannotInvite = await fetch(`${base}/account/api/projects/${project.id}/invitations`, {
      method: 'POST', headers: {
        cookie: bobCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ username: 'root-admin', mode: 'ro' }),
    })
    expect(bobCannotInvite.status).toBe(403)

    const adminCookie = await login(base, 'root-admin', 'pw-12345678')
    const adminContext = await fetch(`${base}/account/api/context`, { headers: { cookie: adminCookie } })
    expect(await adminContext.json()).toMatchObject({
      fullAccess: true,
      projects: [expect.objectContaining({ projectId: project.id, mode: 'rw', canManage: true })],
    })
    const adminProjectContext = await fetch(`${base}/account/api/context`, {
      headers: { cookie: `${adminCookie}; hgw_scope=project:${project.id}` },
    })
    expect(await adminProjectContext.json()).toMatchObject({
      fullAccess: true,
      scope: { kind: 'project', projectId: project.id, mode: 'rw' },
    })
    const userProjects = await fetch(`${base}/admin/api/projects?origin=user`, { headers: { cookie: adminCookie } })
    expect(userProjects.status).toBe(200)
    expect(await userProjects.json()).toEqual([expect.objectContaining({
      id: project.id, origin: 'user', owner: expect.objectContaining({ id: alice.id }),
    })])

    const adminPath = join(deps.cfg.projectPathRoots[0] ?? deps.cfg.projectsRoot, 'admin-project')
    mkdirSync(adminPath, { recursive: true })
    const adminCreated = await fetch(`${base}/admin/api/projects`, {
      method: 'POST', headers: {
        cookie: adminCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ name: 'Admin workspace', path: adminPath }),
    })
    expect(adminCreated.status).toBe(200)
    const adminProject = await adminCreated.json() as { id: number; origin: string; owner: unknown }
    expect(adminProject).toMatchObject({ origin: 'admin', owner: null })
    const adminProjects = await fetch(`${base}/admin/api/projects?origin=admin`, { headers: { cookie: adminCookie } })
    expect(await adminProjects.json()).toEqual([expect.objectContaining({ id: adminProject.id, origin: 'admin' })])
  })

  it('lists active users for the member picker and counts pending invitations', async () => {
    const { deps, base } = await setup()
    const alice = await deps.users.create({ username: 'alice', password: 'pw-12345678', displayName: 'Alice' })
    const bob = await deps.users.create({ username: 'bob', password: 'pw-12345678', displayName: 'Bob' })
    const carol = await deps.users.create({ username: 'carol', password: 'pw-12345678', displayName: 'Carol' })
    await deps.users.changeOwnPassword(alice.id, 'pw-12345678')
    await deps.users.changeOwnPassword(bob.id, 'pw-12345678')
    await deps.users.setStatus(carol.id, 'disabled')
    installProjectCollaboration(deps)

    const aliceCookie = await login(base, 'alice', 'pw-12345678')
    const aliceUsers = await fetch(`${base}/account/api/users`, { headers: { cookie: aliceCookie } })
    expect(aliceUsers.status).toBe(200)
    const visible = await aliceUsers.json() as Array<{ id: number; username: string; displayName: string }>
    expect(visible).toEqual(expect.arrayContaining([
      { id: alice.id, username: 'alice', displayName: 'Alice' },
      { id: bob.id, username: 'bob', displayName: 'Bob' },
    ]))
    // Disabled accounts are not pickable; enabled admins are.
    expect(visible.map(user => user.username)).not.toContain('carol')
    expect(visible.map(user => user.username)).toContain('root-admin')

    const created = await fetch(`${base}/account/api/projects`, {
      method: 'POST', headers: {
        cookie: aliceCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ name: 'Picker workspace' }),
    })
    expect(created.status).toBe(201)
    const project = await created.json() as { id: number }

    const bobCookie = await login(base, 'bob', 'pw-12345678')
    const before = await fetch(`${base}/account/api/invitations/count`, { headers: { cookie: bobCookie } })
    expect(before.status).toBe(200)
    expect(await before.json()).toEqual({ pending: 0 })

    const invitationResponse = await fetch(`${base}/account/api/projects/${project.id}/invitations`, {
      method: 'POST', headers: {
        cookie: aliceCookie, origin: base, 'content-type': 'application/json',
      }, body: JSON.stringify({ username: 'bob', mode: 'ro' }),
    })
    expect(invitationResponse.status).toBe(201)

    const after = await fetch(`${base}/account/api/invitations/count`, { headers: { cookie: bobCookie } })
    expect(await after.json()).toEqual({ pending: 1 })

    const invitation = await invitationResponse.json() as { id: string }
    const accepted = await fetch(`${base}/account/api/invitations/${encodeURIComponent(invitation.id)}/accept`, {
      method: 'POST', headers: { cookie: bobCookie, origin: base },
    })
    expect(accepted.status).toBe(204)
    const cleared = await fetch(`${base}/account/api/invitations/count`, { headers: { cookie: bobCookie } })
    expect(await cleared.json()).toEqual({ pending: 0 })
  })

  it('rejects malformed encoded conversation ids without raising a server error', async () => {
    const { deps, base } = await setup({}, {}, undefined, conversationEnvironment)
    deps.collaboration = {
      projectsForUser: () => [],
      projectForUser: () => ({ projectId: 7, name: 'Shared', path: deps.cfg.projectsRoot, mode: 'rw', administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const }),
      access: () => { throw new Error('must not authorize an invalid path') },
      listConversations: () => [],
      readableSessionIds: () => [],
      setVisibility: () => {},
      claimInteraction: () => false, listActivity: async () => ({ items: [] }),
    }
    const cookie = await login(base, 'root-admin', 'pw-12345678')
    const response = await fetch(`${base}/account/api/conversations/%E0%A4%A?dshRuntime=${conversationEnvironment.id}`, {
      headers: { cookie },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'invalid-session-id' })
  })
})

it('checks the explicit project before returning or modifying a conversation with the same raw ID', async () => {
  const { deps, base } = await setup({}, {}, undefined, conversationEnvironment)
  const setVisibility = vi.fn()
  deps.collaboration = {
    projectsForUser: () => [], projectForUser: () => ({ projectId: 7, name: 'Shared', path: deps.cfg.projectsRoot, mode: 'rw', administrator: true, canManage: true, uiThemePolicy: 'follow-user' as const }),
    access: () => ({ sessionId: 'same', rootSessionId: 'same', projectId: 7, visibility: 'project', creatorUserId: 1,
      mode: 'rw', canRead: true, canWrite: true, canManage: true }),
    listConversations: () => [], readableSessionIds: () => [], setVisibility, claimInteraction: () => false, listActivity: async () => ({ items: [] }),
  }
  const cookie = await login(base, 'root-admin', 'pw-12345678')
  const headers = { cookie, origin: base, 'content-type': 'application/json' }
  const conversation = `${base}/account/api/conversations/same?dshRuntime=${conversationEnvironment.id}`
  expect((await fetch(`${conversation}&projectId=7`, { headers })).status).toBe(200)
  expect((await fetch(`${conversation}&projectId=8`, { headers })).status).toBe(404)
  expect((await fetch(`${conversation}&projectId=8`, { method: 'PATCH', headers, body: '{"visibility":"private"}' })).status).toBe(404)
  expect(setVisibility).not.toHaveBeenCalled()
  expect((await fetch(`${conversation}&projectId=07`, { headers })).status).toBe(400)
  expect((await fetch(`${conversation}&projectId=7`, { method: 'PATCH', headers, body: '{"visibility":"private"}' })).status).toBe(204)
  expect(setVisibility).toHaveBeenCalledOnce()
})
