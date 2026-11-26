import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { AuditService } from '../src/audit.ts'
import { AuthService } from '../src/auth.ts'
import { openDb } from '../src/db.ts'
import type { GatewayForwardClaims, GatewayForwardSessionCandidate } from '../src/forwarded-principal.ts'
import { NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'
import { GatewayPerformanceObserver } from '../src/performance-observer.ts'
import { ProjectService } from '../src/projects.ts'
import type { RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { createGatewayServer, SESSION_COOKIE, type GatewayDeps, type ReadySessionHandler } from '../src/server.ts'
import { UserService } from '../src/users.ts'
import { testConfig } from './test-config.ts'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

describe('forwarded readySession fallback routing', () => {
  it('does not re-enter ordinary readySession after a forwarded personal POST falls back', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hgw-ready-route-'))
    const db = openDb(join(root, 'gateway.sqlite'))
    const performance = new GatewayPerformanceObserver({ enabled: true, eventLoopResolutionMs: 50 })
    cleanups.push(() => {
      performance.dispose()
      try { db.close() } finally { rmSync(root, { recursive: true, force: true }) }
    })
    const cfg = testConfig(root, { HGW_USERS_ROOT: join(root, 'users'), HGW_PERFORMANCE_ENABLED: 'true' })
    const users = new UserService(db, cfg)
    const created = await users.create({ username: 'forward-member', password: 'pw-12345678' })
    db.prepare('UPDATE users SET must_change_password = 0 WHERE id = ?').run(created.id)
    const user = users.getById(created.id)!
    const auth = new AuthService(db, cfg)
    const audit = new AuditService(db)
    const login = await auth.login('forward-member', 'pw-12345678', '127.0.0.1', 'test')
    if (typeof login === 'string') throw new Error(`unexpected login result: ${login}`)
    const token = login.token
    const nodeId = '00000000-0000-4000-8000-000000000010' as RuntimeNodeId
    const runtimeId = '00000000-0000-4000-8000-000000000020' as RuntimeId
    const path = '/api/admit/v1/session.prompt'
    const claims: GatewayForwardClaims = {
      version: 1,
      issuer: 'harness-gateway',
      audience: 'dsh-node',
      organization: 'org-1',
      issuerNode: nodeId,
      audienceNode: nodeId,
      nonce: 'nonce-1',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      user,
      selection: { runtimeId, target: 'personal' },
      context: { environment: { id: runtimeId, nodeId } },
      request: {
        method: 'POST',
        path,
        sessionHash: createHash('sha256').update(token).digest('hex'),
      },
    }
    const candidate: GatewayForwardSessionCandidate = {
      claims,
      issuerPublicKey: 'fixture-key',
      consume: () => true,
    }
    const projects = new ProjectService(db, cfg)
    const deps: GatewayDeps = {
      cfg,
      auth,
      users,
      projects,
      instances: {} as GatewayDeps['instances'],
      audit,
      performance,
      runtimeRouter: {
        placement: async () => ({
          target: 'personal',
          local: true,
          resetScope: false,
          environment: { id: runtimeId, nodeId, node: { id: nodeId, name: 'node-a' } } as never,
        }),
        landing: async () => ({ target: 'personal', local: true, resetScope: false }),
        resolve: async () => ({
          context: {
            user,
            scope: { kind: 'personal' },
            runtime: { ...user, runtimeId },
            environment: { id: runtimeId, nodeId, nodeName: 'node-a' },
          },
          resetScope: false,
        }),
      },
      nodeServiceIdentity: {
        nodeId,
        organizationId: 'org-1',
        authorize: async () => { throw new Error('unused') },
      },
      forwardedSessionPrincipal: () => candidate,
      forwardedPrincipal: async () => claims,
    }
    const readySession = vi.fn<ReadySessionHandler>(async (_req, _res, context) => {
      context.observe?.(context.forwarded === undefined ? 'ordinary' : 'forwarded', 'fallbackNotRetained')
      return false
    })
    const proxy = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"route":"proxy"}')
    })
    const server = createGatewayServer(deps, { readySession, proxy })

    server.listen(0, '127.0.0.1')
    onTestFinished(() => new Promise<void>((resolve, reject) => {
      server.close(error => { if (error) reject(error); else resolve() })
    }))
    await once(server, 'listening')
    const origin = cfg.publicOrigins[0] ?? 'http://127.0.0.1:8080'
    const port = (server.address() as AddressInfo).port
    const response = await fetch(`http://127.0.0.1:${port}${path}?dshRuntime=${runtimeId}&dshTarget=personal&dshNode=${nodeId}`, {
      method: 'POST',
      headers: {
        cookie: `${SESSION_COOKIE}=${token}`,
        origin,
        host: new URL(origin).host,
        'content-type': 'application/json',
        [NODE_SERVICE_TARGET_HEADER]: nodeId,
        'x-dsh-gateway-forward': 'signed-assertion',
      },
      body: '{}',
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ route: 'proxy' })
    expect(readySession).toHaveBeenCalledTimes(1)
    expect(readySession).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ forwarded: candidate }))
    expect(proxy).toHaveBeenCalledTimes(1)
    const snapshot = performance.snapshot(null).readySession
    expect(snapshot.forwarded.fallbackNotRetained).toBe(1)
    expect(snapshot.ordinary.fallbackNotRetained).toBe(0)
  })
})
