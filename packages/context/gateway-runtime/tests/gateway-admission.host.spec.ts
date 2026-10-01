/**
 * REAL-composition gateway admission: the deployed Connection/frontend-static
 * carriers admit a signed Gateway principal before any browser cookie exists,
 * and every unauthenticated, forged, or purpose-bound request still fails.
 * Requests go through raw node:http so headers exactly match what the proxy
 * sends after scrubbing the browser's cookie.
 */

import { randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { GatewayPrincipalClaims } from '../src/index.ts'
import {
  GATEWAY_PRINCIPAL_HEADER,
  GATEWAY_READINESS_PATH,
  GATEWAY_WEBHOOK_DISPATCH_PATH,
} from '../src/index.ts'
import { loadGatewayComposition } from './fixtures/gateway-admission.fixture.ts'

interface ProbeResponse {
  readonly status: number
  readonly body: string
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
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }) })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
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
      const purposes: Array<[GatewayPrincipalClaims['purpose'], string | undefined]> = [
        ['terminal-admin', '/api/terminal/adminList'],
        ['plugin-admin', '/api/pluginManager/listPlugins'],
        ['webhook-dispatch', GATEWAY_WEBHOOK_DISPATCH_PATH],
        // Archive and document purposes carry no declared HTTP endpoint of
        // their own; ordinary HTTP admission stays unrestricted for them.
        ['archive-read', '/api/session.open'],
        ['document-admin', '/api/session.open'],
      ]
      for (const [purpose, permittedPath] of purposes) {
        const headers = principalHeaders(gateway.origin, gateway.issue({
          ...(purpose === undefined ? {} : { purpose }),
          user: adminUser,
        }))
        const permitted = await call(gateway.origin, permittedPath!, {
          ...headers,
          'content-type': 'application/json',
        }, 'POST', '{}')
        expect([purpose, permitted.status]).toEqual([purpose, 404])
        expect([purpose, (await call(gateway.origin, '/', headers)).status]).toEqual([purpose, 401])
        expect(await wsUpgrade(gateway.port, headers)).not.toEqual({ upgraded: true })
      }
      // The three pinned purposes also refuse unrelated HTTP endpoints.
      for (const purpose of ['terminal-admin', 'plugin-admin', 'webhook-dispatch'] as const) {
        const headers = principalHeaders(gateway.origin, gateway.issue({
          ...(purpose === undefined ? {} : { purpose }),
          user: adminUser,
        }))
        expect([purpose, (await call(gateway.origin, '/api/session.open', {
          ...headers,
          'content-type': 'application/json',
        }, 'POST', '{}')).status]).toEqual([purpose, 401])
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
})
