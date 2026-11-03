/**
 * REAL-composition gateway admission: the deployed Connection/frontend-static
 * carriers admit a signed Gateway principal before any browser cookie exists,
 * and every unauthenticated, forged, or purpose-bound request still fails.
 * Requests go through raw node:http so headers exactly match what the proxy
 * sends after scrubbing the browser's cookie.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it, onTestFinished } from 'vitest'
import type { GatewayPrincipalClaims } from '../src/index.ts'
import {
  GATEWAY_PRINCIPAL_HEADER,
  GATEWAY_READINESS_PATH,
  GATEWAY_READINESS_NONCE_HEADER,
  GATEWAY_READINESS_REQUEST_HEADER,
  GATEWAY_WEBHOOK_DISPATCH_PATH,
} from '../src/index.ts'
import { loadGatewayComposition } from './fixtures/gateway-admission.fixture.ts'
import GatewayResourceBudget from '../src/resource-budget.ts'

interface ProbeResponse {
  readonly status: number
  readonly body: string
  readonly cacheControl: string | undefined
}

function call(
  origin: string,
  path: string,
  headers: Record<string, string | string[]>,
  method = 'GET',
  body?: string,
): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, origin), { method, headers })
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), cacheControl: res.headers['cache-control'] }) })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function readinessProof(
  credential: { token: string; runtime: { kind: string; id: unknown; generation: unknown } },
  nonce: string,
): (kind: string) => string {
  return kind => createHmac('sha256', credential.token).update([
    'dsh-gateway-readiness-v1', kind, nonce, credential.runtime.kind,
    String(credential.runtime.id), String(credential.runtime.generation),
  ].join('\u0000')).digest('base64url')
}

/** Drive the real WebSocket upgrade handshake; owns the request and socket to close. */
function wsUpgrade(
  port: number,
  headers: Record<string, string>,
): Promise<{ upgraded: true } | { status: number }> {
  return new Promise((resolve, reject) => {
    let socket: Duplex | undefined
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/api/events.mux',
      headers: {
        'connection': 'Upgrade',
        'upgrade': 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    })
    req.setTimeout(10_000, () => { req.destroy(new Error('WebSocket upgrade timed out')) })
    req.on('upgrade', (_res, sock) => {
      socket = sock
      sock.once('close', () => { resolve({ upgraded: true }) })
      sock.end()
    })
    req.on('response', (res) => {
      res.resume()
      res.once('close', () => { resolve({ status: res.statusCode ?? 0 }) })
    })
    req.on('error', (error) => {
      socket?.destroy()
      req.destroy()
      reject(error)
    })
    req.end()
  })
}

const principalHeaders = (origin: string, assertion: string): Record<string, string> => ({
  host: new URL(origin).host,
  origin,
  [GATEWAY_PRINCIPAL_HEADER]: assertion,
})

const adminUser = { id: 9, username: 'lin', displayName: 'Lin', role: 'admin' as const }

const rpcEnvelope = { type: 'client-request', rpcId: 'rpc-probe', method: 'ping', payload: {} }

/** Re-encode a signed assertion's claims under the old signature. */
function tamperPayload(assertion: string, patch: Record<string, unknown>): string {
  const [payload, signature] = assertion.split('.')
  const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString()) as Record<string, unknown>
  Object.assign(claims, patch)
  return `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`
}

describe('gateway runtime admission', () => {
  it.each(['user', 'project'] as const)('renders only the authenticated document identity for a %s runtime', async (kind) => {
    const gateway = await loadGatewayComposition({ runtime: { kind, id: 9, generation: 7 } })
    try {
      let lastRequest: IncomingMessage | undefined
      const stopCapture = gateway.ctx.on('webserver/index-inject', (_rows, request) => { lastRequest = request })
      const expectedTarget = kind === 'user' ? { kind: 'personal' } : { kind: 'project', projectId: 9 }
      const read = async (id: number): Promise<void> => {
        const reply = await call(gateway.origin, '/', principalHeaders(gateway.origin, gateway.issue({
          user: { id, username: `member-${String(id)}`, displayName: 'Member', role: 'user' },
        })))
        expect(reply.status).toBe(200)
        expect(reply.cacheControl).toBe('no-store')
        const value = /globalThis\["__DSH_DOCUMENT_IDENTITY__"\] = ([^<]+)<\/script>/.exec(reply.body)?.[1]
        expect(value).toBeDefined()
        expect(JSON.parse(value!)).toEqual({ version: 1, principalId: id, runtimeTarget: expectedTarget })
        expect(reply.body).not.toContain('runtime-secret')
        expect(reply.body).not.toContain('principalPublicKey')
      }
      await Promise.all((kind === 'user' ? [9] : [9, 10]).map(read))
      stopCapture()
      if (lastRequest === undefined) throw new Error('Served index did not forward its request')
      expect(gateway.ctx.webServer.collectIndexInjections().some(row => row.kind === 'global'
        && row.name === '__DSH_DOCUMENT_IDENTITY__')).toBe(false)
      // An alternate index owner cannot turn forwarded request headers into
      // an identity without the producer's own signature and purpose checks.
      const originalHeaders = lastRequest.headers
      try {
        lastRequest.headers = { ...originalHeaders }
        delete lastRequest.headers['x-dsh-gateway-principal']
        expect(() => gateway.ctx.webServer.collectIndexInjections(lastRequest)).toThrow(/principal assertion is required/)
        lastRequest.headers[GATEWAY_PRINCIPAL_HEADER] = 'not.a-principal'
        expect(() => gateway.ctx.webServer.collectIndexInjections(lastRequest)).toThrow(/principal assertion/)
        lastRequest.headers[GATEWAY_PRINCIPAL_HEADER] = gateway.issue({ purpose: 'archive-read', user: adminUser })
        expect(() => gateway.ctx.webServer.collectIndexInjections(lastRequest))
          .toThrow('Archive assertions permit only the archive read endpoint.')
      } finally { lastRequest.headers = originalHeaders }
      const entry = [...gateway.ctx.loader.entries()].find(candidate => candidate.options.name === '@deepseek-ai/dsh-gateway-runtime')
      if (entry === undefined) throw new Error('GatewayRuntime Loader entry is missing')
      await gateway.ctx.loader.update(entry.id, { disabled: true })
      expect(gateway.ctx.webServer.collectIndexInjections(lastRequest).some(row => row.kind === 'global'
        && row.name === '__DSH_DOCUMENT_IDENTITY__')).toBe(false)
    } finally { await gateway.dispose() }
  })

  it('admits a verified principal to the index and API without a cookie', async () => {
    const gateway = await loadGatewayComposition()
    try {
      const headers = principalHeaders(gateway.origin, gateway.issue())
      const index = await call(gateway.origin, '/', headers)
      expect(index.status).toBe(200)
      expect(index.body).toContain('shell')
      const probe = await call(gateway.origin, '/api/probe/ping', {
        ...headers,
        'content-type': 'application/json',
      }, 'POST', '{}')
      expect(probe.status).toBe(200)
      expect(probe.body).toBe('{"user":9}')
      const rpc = await call(gateway.origin, '/probe-rpc/ping', {
        ...headers,
        'content-type': 'application/json',
      }, 'POST', JSON.stringify(rpcEnvelope))
      expect(rpc.status).toBe(200)
      expect(JSON.parse(rpc.body)).toMatchObject({
        rpcId: 'rpc-probe',
        result: { ok: true, value: { user: 9 } },
      })
      const head = await call(gateway.origin, '/', headers, 'HEAD')
      expect(head.status).toBe(200)
      expect(head.body).toBe('')
    } finally {
      await gateway.dispose()
    }
  })

  it('denies absent, malformed, tampered, expired, and foreign-target assertions', async () => {
    const gateway = await loadGatewayComposition()
    try {
      const host = new URL(gateway.origin).host
      const assertion = gateway.issue()
      const plain = { host, origin: gateway.origin }
      const now = Date.now()
      const denied: Array<Record<string, string | string[]>> = [
        plain,
        principalHeaders(gateway.origin, 'not.an-assertion'),
        // A claim edit under the original signature, and a signature mutation.
        principalHeaders(gateway.origin, tamperPayload(assertion, { organization: 'elsewhere' })),
        principalHeaders(gateway.origin, `${assertion.slice(0, -1)}${assertion.endsWith('A') ? 'B' : 'A'}`),
        // Well-formed expiry: issuedAt precedes expiresAt, both behind now.
        principalHeaders(gateway.origin, gateway.issue({ issuedAt: now - 60_000, expiresAt: now - 1000 })),
        principalHeaders(gateway.origin, gateway.issue({ runtime: { kind: 'user', id: 8, generation: 7 } })),
        principalHeaders(gateway.origin, gateway.issue({ runtime: { kind: 'user', id: 9, generation: 8 } })),
        principalHeaders(gateway.origin, gateway.issue({ organization: 'elsewhere' })),
        principalHeaders(gateway.origin, gateway.issue({ scope: { kind: 'project', projectId: 41 } as never })),
        // A duplicated principal header must never verify as a single value.
        { ...plain, [GATEWAY_PRINCIPAL_HEADER]: [assertion, assertion] },
      ]
      for (const headers of denied) {
        expect((await call(gateway.origin, '/', headers)).status).toBe(401)
        expect((await call(gateway.origin, '/api/session.open', {
          ...headers as Record<string, string>,
          'content-type': 'application/json',
        }, 'POST', '{}')).status).toBe(401)
        expect((await call(gateway.origin, '/probe-rpc/ping', {
          ...headers as Record<string, string>,
          'content-type': 'application/json',
        }, 'POST', JSON.stringify(rpcEnvelope))).status).toBe(401)
      }
    } finally {
      await gateway.dispose()
    }
  })

  it('keeps the Host/Origin fence ahead of verified principals', async () => {
    const gateway = await loadGatewayComposition()
    try {
      const assertion = gateway.issue()
      const foreign = principalHeaders('http://foreign.example', assertion)
      const mismatchedOrigin = {
        ...principalHeaders(gateway.origin, assertion),
        origin: 'http://foreign.example',
      }
      for (const headers of [foreign, mismatchedOrigin]) {
        expect((await call(gateway.origin, '/', headers)).status).toBe(403)
        expect((await call(gateway.origin, '/api/session.open', {
          ...headers,
          'content-type': 'application/json',
        }, 'POST', '{}')).status).toBe(403)
        expect((await call(gateway.origin, '/probe-rpc/ping', {
          ...headers,
          'content-type': 'application/json',
        }, 'POST', JSON.stringify(rpcEnvelope))).status).toBe(403)
      }
    } finally {
      await gateway.dispose()
    }
  })

  it('denies the direct-browser token and cookie while the provider is mounted', async () => {
    const gateway = await loadGatewayComposition()
    try {
      const launchUrl = gateway.ctx.connection.authenticatedUrl(gateway.origin)
      const target = new URL(launchUrl)
      const tokenOnly = { host: new URL(gateway.origin).host }
      expect((await call(gateway.origin, `${target.pathname}${target.search}`, tokenOnly))
        .status).toBe(401)
      expect((await call(gateway.origin, '/', { ...tokenOnly, cookie: 'dsh-auth-x=forged' }))
        .status).toBe(401)
      expect((await call(gateway.origin, '/api/session.open', {
        ...tokenOnly,
        cookie: 'dsh-auth-x=forged',
        'content-type': 'application/json',
      }, 'POST', '{}')).status).toBe(401)
    } finally {
      await gateway.dispose()
    }
  })

  it('confines every purpose assertion to HTTP and its declared endpoints', async () => {
    const gateway = await loadGatewayComposition()
    try {
      const purposes: Array<[NonNullable<GatewayPrincipalClaims['purpose']>, string, string]> = [
        ['terminal-admin', 'POST', '/api/terminal/adminList'],
        ['plugin-admin', 'POST', '/api/pluginManager/listPlugins'],
        ['webhook-dispatch', 'POST', GATEWAY_WEBHOOK_DISPATCH_PATH],
        ['archive-read', 'GET', '/api/internal/archive/read'],
        ['document-admin', 'POST', '/api/documents/trash'],
        ['document-admin', 'POST', '/api/documents/restore'],
        ['document-admin', 'DELETE', '/api/documents/purge'],
      ]
      for (const [purpose, method, permittedPath] of purposes) {
        const headers = principalHeaders(gateway.origin, gateway.issue({
          purpose,
          user: adminUser,
        }))
        const permitted = await call(gateway.origin, permittedPath, {
          ...headers,
          'content-type': 'application/json',
        }, method, method === 'POST' ? '{}' : undefined)
        expect([purpose, permitted.status]).toEqual([purpose, 404])
        expect([purpose, (await call(gateway.origin, '/', headers)).status]).toEqual([purpose, 401])
        expect(await wsUpgrade(gateway.port, headers)).not.toEqual({ upgraded: true })
      }
      expect((await call(gateway.origin, '/api/pluginManager/catalog', {
        origin: gateway.origin, 'content-type': 'application/json',
      }, 'POST', '{}')).status).toBe(401)
      // The pinned purposes also refuse unrelated HTTP endpoints.
      for (const purpose of ['terminal-admin', 'plugin-admin', 'webhook-dispatch', 'archive-read', 'document-admin'] as const) {
        const headers = principalHeaders(gateway.origin, gateway.issue({
          purpose,
          user: adminUser,
        }))
        expect([purpose, (await call(gateway.origin, '/api/probe/ping', {
          ...headers, 'content-type': 'application/json',
        }, 'POST', '{}')).status]).toEqual([purpose, 401])
        expect([purpose, (await call(gateway.origin, '/api/session.open', {
          ...headers,
          'content-type': 'application/json',
        }, 'POST', '{}')).status]).toEqual([purpose, 401])
      }
      for (const [purpose, method, pathname] of [
        ['archive-read', 'POST', '/api/internal/archive/read'],
        ['archive-read', 'GET', '/api/internal/archive/read/'],
        ['document-admin', 'GET', '/api/documents/trash'],
        ['document-admin', 'POST', '/api/documents/purge'],
        ['document-admin', 'DELETE', '/api/documents/restore'],
        ['document-admin', 'POST', '/api/documents/uploads'],
        ['document-admin', 'GET', '/api/documents/content'],
      ] as const) {
        const headers = principalHeaders(gateway.origin, gateway.issue({ purpose, user: adminUser }))
        expect([purpose, method, pathname, (await call(gateway.origin, pathname, headers, method)).status])
          .toEqual([purpose, method, pathname, 401])
      }
      expect(await wsUpgrade(gateway.port, principalHeaders(gateway.origin, gateway.issue())))
        .toEqual({ upgraded: true })
    } finally {
      await gateway.dispose()
    }
  })

  it('rejects WebSocket upgrades without a verifiable principal', async () => {
    const gateway = await loadGatewayComposition()
    try {
      const plain = { host: `127.0.0.1:${String(gateway.port)}` }
      expect(await wsUpgrade(gateway.port, plain)).toEqual({ status: 403 })
      expect(await wsUpgrade(gateway.port, { ...plain, [GATEWAY_PRINCIPAL_HEADER]: 'forged' }))
        .toEqual({ status: 403 })
      // The registered loopback subtree keeps its machine fence: a foreign
      // Host is refused before any principal check.
      expect((await call(gateway.origin, GATEWAY_READINESS_PATH, {
        host: 'foreign.example',
        [GATEWAY_PRINCIPAL_HEADER]: gateway.issue(),
      })).status).toBe(403)
    } finally {
      await gateway.dispose()
    }
  })

  it('reports readiness only while the registered resource provider is available', async () => {
    const registration = Promise.withResolvers<ServerResponse>()
    const external = createServer((request, response) => {
      request.resume()
      if (request.url !== '/internal/runtime/resources/register') { response.writeHead(404).end(); return }
      registration.resolve(response)
    })
    onTestFinished(async () => {
      if (!external.listening) return
      external.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        external.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
      })
    })
    await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve))
    const address = external.address()
    if (address === null || typeof address === 'string') throw new Error('expected a loopback listener')
    const gateway = await loadGatewayComposition({ gatewayUrl: `http://127.0.0.1:${String(address.port)}` })
    const nonce = 'resource-readiness'
    const proof = readinessProof(gateway.credential, nonce)
    const headers = { host: new URL(gateway.origin).host,
      [GATEWAY_READINESS_NONCE_HEADER]: nonce, [GATEWAY_READINESS_REQUEST_HEADER]: proof('request') }
    const ready = () => call(gateway.origin, GATEWAY_READINESS_PATH, headers)
    const pending = gateway.ctx.plugin(GatewayResourceBudget, { requestTimeoutMs: 2000, cleanupTimeoutMs: 5000 })
    const reply = { nextSequence: 1, policy: {
      sampleMs: 20, staleMs: 500, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
      maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 64 * 1024, maxWaitMs: 10_000,
    } }
    let response: ServerResponse | undefined
    try {
      response = await registration.promise
      expect((await ready()).status).toBe(503)
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
      const fiber = await pending
      const admitted = await ready()
      expect(admitted.status).toBe(200)
      expect(JSON.parse(admitted.body)).toMatchObject({ runtime: gateway.credential.runtime, proof: proof('response') })
      await fiber.dispose()
      expect((await ready()).status).toBe(503)
      expect(gateway.ctx.get('resourceBudgetRequired')).toBe(true)
    } finally {
      if (response !== undefined && !response.writableEnded) response.writeHead(200).end(JSON.stringify(reply))
      await Promise.allSettled([pending])
      await gateway.dispose()
    }
  })

  it('requires each configured policy plugin to activate and withdraws readiness while it is disabled', async () => {
    const external = createServer((request, response) => {
      request.resume()
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nextSequence: 1, policy: {
        sampleMs: 20, staleMs: 500, cpuTarget: 0.85, eventLoopTargetMs: 100, linuxMemoryReserveRatio: 0.1,
        maxQueued: 16, maxQueuedPerUser: 8, maxQueuedPerProject: 8, maxQueuedBytes: 64 * 1024, maxWaitMs: 10_000,
      } }))
    })
    onTestFinished(async () => {
      external.closeAllConnections()
      await new Promise<void>((resolve, reject) => { external.close(error => error === undefined ? resolve() : reject(error)) })
    })
    await new Promise<void>(resolve => external.listen(0, '127.0.0.1', resolve))
    const address = external.address()
    if (address === null || typeof address === 'string') throw new Error('expected a loopback listener')
    const gateway = await loadGatewayComposition({ gatewayUrl: `http://127.0.0.1:${String(address.port)}`, requiredPlugins: ['managed-policy'] })
    const loading = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let pending: Promise<unknown> | undefined
    try {
      await gateway.ctx.plugin(GatewayResourceBudget, { requestTimeoutMs: 2000, cleanupTimeoutMs: 5000 })
      const nonce = 'policy-readiness'
      const proof = readinessProof(gateway.credential, nonce)
      const headers = { host: new URL(gateway.origin).host,
        [GATEWAY_READINESS_NONCE_HEADER]: nonce, [GATEWAY_READINESS_REQUEST_HEADER]: proof('request') }
      const ready = () => call(gateway.origin, GATEWAY_READINESS_PATH, headers)
      expect((await ready()).status).toBe(503)
      gateway.ctx.loader.builtins.policyReadiness = { name: 'policy-readiness', async apply() { loading.resolve(undefined); await release.promise } }
      pending = gateway.ctx.loader.root.update([...gateway.ctx.loader.root.data, { id: 'managed-policy', name: 'cordis:policyReadiness' }])
      await loading.promise
      expect((await ready()).status).toBe(503)
      release.resolve(undefined)
      await pending
      expect((await ready()).status).toBe(200)
      await gateway.ctx.loader.update('managed-policy', { disabled: true })
      expect((await ready()).status).toBe(503)
      await gateway.ctx.loader.update('managed-policy', { disabled: false })
      expect((await ready()).status).toBe(200)
      gateway.ctx.loader.remove('managed-policy')
      expect((await ready()).status).toBe(503)
    } finally {
      release.resolve(undefined)
      await pending
      await gateway.dispose()
    }
  })
})
