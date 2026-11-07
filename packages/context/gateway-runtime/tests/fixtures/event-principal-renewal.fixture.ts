/** Real Loader, WebSocket admission and private HTTP transport; no public service or login fixture. */
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { Duplex } from 'node:stream'
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, vi } from 'vitest'
import { GATEWAY_PRINCIPAL_HEADER, type GatewayRequestPrincipal } from '../../src/index.ts'
import { loadGatewayComposition, type GatewayComposition } from './gateway-admission.fixture.ts'

function openSocket(origin: string, path: string, assertion: string): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { headers: {
      connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
      'sec-websocket-key': randomBytes(16).toString('base64'), origin,
      [GATEWAY_PRINCIPAL_HEADER]: assertion,
    } })
    req.on('upgrade', (_response, socket) => { socket.resume(); resolve(socket) })
    req.on('response', (response) => { response.resume(); reject(new Error(`upgrade refused: ${response.statusCode}`)) })
    req.on('error', reject)
    req.end()
  })
}

/** Observed assembled-carrier results without signed principal bytes, credentials or wall-clock values. */
export interface EventPrincipalScenarioResult {
  enabled: boolean
  eventSockets: number
  initialHttpStatus: number
  renewalBatches: number
  batchSizes: number[]
  passedOriginalDeadline: boolean
  retainedAuthority: boolean
  oldHttpStatus: number | null
  releasedOnSocketClose: boolean
}

/**
 * Run the real Loader composition with private HTTP renewal and actual event sockets.
 * @param enabled - whether the launch credential permits event renewal.
 * @returns observable carrier outcomes suitable for a keyless application transcript.
 */
export async function runEventPrincipalScenario(enabled: boolean): Promise<EventPrincipalScenarioResult> {
  let fixture: GatewayComposition | undefined
  const requests: Array<{
    url: string | undefined
    authorization: string | undefined
    principal: string | string[] | undefined
    body: unknown
  }> = []
  let nonce = 0
  const serving = new Set<Promise<void>>()
  const failures: unknown[] = []
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      const bytes: unknown = chunk
      if (!Buffer.isBuffer(bytes)) throw new Error('private renewal fixture requires byte chunks')
      chunks.push(bytes)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { version: number; leaseIds: string[] }
    requests.push({ url: req.url, authorization: req.headers.authorization, principal: req.headers[GATEWAY_PRINCIPAL_HEADER], body })
    if (fixture === undefined) throw new Error('runtime not loaded')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ version: 1, leases: body.leaseIds.map(leaseId => ({
      leaseId, status: 'renewed', assertion: fixture!.issue({ nonce: `replacement-${++nonce}` }),
    })) }))
  }
  const server = createServer((req, res) => {
    const pending = serve(req, res)
    serving.add(pending)
    void pending.then(() => { serving.delete(pending) }, (error: unknown) => {
      serving.delete(pending)
      failures.push(error)
      res.destroy(error instanceof Error ? error : new Error('private renewal fixture failed', { cause: error }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address() as AddressInfo
  const admitted: GatewayRequestPrincipal[] = []
  const sockets: Duplex[] = []
  let passedOriginalDeadline = false
  let retainedAuthority = false
  let oldHttpStatus: number | null = null
  let releasedOnSocketClose = false
  try {
    fixture = await loadGatewayComposition({
      gatewayUrl: `http://127.0.0.1:${address.port}`,
      ...(enabled ? { streamPrincipalRenewal: { enabled: true, intervalMs: 10_000, requestTimeoutMs: 5000, maxBatchSize: 64 } } : {}),
      onEvent: (principal) => { admitted.push(principal) },
    })
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const originalDeadline = Date.now() + 30_000
    for (const [index, path] of ['/api/events.mux', '/api/events.host'].entries()) {
      sockets.push(await openSocket(fixture.origin, path, fixture.issue({ nonce: `initial-${index}` })))
    }
    expect(admitted).toHaveLength(2)
    const httpAssertion = fixture.issue({ nonce: 'http-only' })
    const response = await fetch(fixture.origin + '/api/probe/read', { headers: { [GATEWAY_PRINCIPAL_HEADER]: httpAssertion } })
    expect(response.status).toBe(200)
    await response.arrayBuffer()
    await vi.advanceTimersByTimeAsync(10_000)
    if (enabled) {
      await vi.waitFor(() => {
        expect(admitted.every(principal => principal.claims.expiresAt > originalDeadline)).toBe(true)
      }, { interval: 1, timeout: 5000 })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toEqual({
        url: '/internal/runtime/stream-principals/renew', authorization: 'Bearer runtime-secret', principal: undefined,
        body: { version: 1, leaseIds: ['initial-0', 'initial-1'] },
      })
      for (const count of [2, 3]) {
        await vi.advanceTimersByTimeAsync(10_000)
        await vi.waitFor(() => { expect(requests).toHaveLength(count) }, { interval: 1, timeout: 5000 })
        await vi.waitFor(() => {
          expect(admitted.every(principal => principal.claims.expiresAt > originalDeadline + (count - 1) * 10_000)).toBe(true)
        }, { interval: 1, timeout: 5000 })
      }
      await vi.advanceTimersByTimeAsync(1)
      passedOriginalDeadline = Date.now() > originalDeadline
      expect(passedOriginalDeadline).toBe(true)
      expect(admitted.every(principal => principal.signal?.aborted === false)).toBe(true)
      retainedAuthority = admitted.every(principal => principal.signal?.aborted === false)
      const expiredHttp = await fetch(fixture.origin + '/api/probe/read', { headers: { [GATEWAY_PRINCIPAL_HEADER]: httpAssertion } })
      oldHttpStatus = expiredHttp.status
      expect(oldHttpStatus).toBe(401)
      await expiredHttp.arrayBuffer()
      for (const socket of sockets) socket.destroy()
      await vi.waitFor(() => {
        expect(admitted.every(principal => principal.signal?.aborted === true)).toBe(true)
      }, { interval: 1, timeout: 5000 })
      releasedOnSocketClose = admitted.every(principal => principal.signal?.aborted === true)
    } else {
      expect(requests).toHaveLength(0)
      expect(admitted.every(principal => principal.signal === undefined)).toBe(true)
    }
    return { enabled, eventSockets: admitted.length, initialHttpStatus: response.status, renewalBatches: requests.length,
      batchSizes: requests.map(entry => (entry.body as { leaseIds: string[] }).leaseIds.length),
      passedOriginalDeadline, retainedAuthority, oldHttpStatus, releasedOnSocketClose }
  } finally {
    for (const socket of sockets) socket.destroy()
    vi.useRealTimers()
    try { await fixture?.dispose() } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }))
      await Promise.allSettled([...serving])
      if (failures.length) throw new AggregateError(failures, 'private renewal fixture requests failed')
    }
  }
}
