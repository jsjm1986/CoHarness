/** Deterministic counter regression gate for multi-computer forwarding, caching, and invalidation invariants. */
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Socket } from 'node:net'
import { brotliDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayNodeServiceProxy } from '../src/node-service-proxy.ts'
import { NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'
import type { RuntimeCatalogEntry, RuntimeId, RuntimeNodeId } from '../src/runtime-catalog.ts'
import { runMultiComputerBenchmark } from './multi-computer-latency.perf.ts'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }
})

describe('multi-computer forwarding counter invariants', () => {
  it('holds tunnel PG, idle-pool, WS upgrade, fan-out, and remote plugin cache counters within bounds', async () => {
    const report = await runMultiComputerBenchmark({ tunnelPgRttMs: 1, centerPgRttMs: 0 })
    const { scenarios } = report

    expect(scenarios.s1_concurrentPageBurst6.pgAndPool.remoteTunnelAuthorizeChannel).toBe(1)
    expect(scenarios.s1_concurrentPageBurst6.pgAndPool.remoteTunnelAccessSync).toBe(0)
    expect(scenarios.s1_concurrentPageBurst6.pgAndPool.remoteTunnelAccessSyncSkipped).toBeGreaterThanOrEqual(2)

    expect(scenarios.s2_warmInteractiveSequential10.pgAndPool.remoteTunnelAccessSync).toBe(0)
    expect(scenarios.s2_warmInteractiveSequential10.pgAndPool.remoteTunnelProxyAdmission).toBe(0)
    expect(scenarios.s2_warmInteractiveSequential10.pgAndPool.remoteTunnelReadySession).toBe(10)
    expect(scenarios.s2_warmInteractiveSequential10.pgAndPool.poolReused).toBe(10)
    expect(scenarios.s2_warmInteractiveSequential10.pgAndPool.poolOpened).toBe(0)

    expect(scenarios.s3_afterUnrelatedOrgInvalidationBurst4.pgAndPool.poolOpened).toBe(0)
    expect(scenarios.s3_afterUnrelatedOrgInvalidationBurst4.pgAndPool.poolReused).toBe(4)
    expect(scenarios.s3_afterUnrelatedOrgInvalidationBurst4.pgAndPool.remoteTunnelAuthorizeChannel).toBe(0)
    expect(scenarios.s3_afterUnrelatedOrgInvalidationBurst4.pgAndPool.idleInvalidationsGlobal).toBe(0)

    expect(scenarios.s4_dualWebSocketUpgrade.pgAndPool.remoteTunnelAuthorizeChannel).toBe(0)
    expect(scenarios.s4_dualWebSocketUpgrade.pgAndPool.remoteTunnelAccessSync).toBe(0)
    expect(scenarios.s4_dualWebSocketUpgrade.pgAndPool.remoteTunnelAccessSyncSkipped).toBe(2)

    expect(scenarios.s5_threeNodeDocumentOverview.concurrency).toBe(6)
    expect(scenarios.s5_threeNodeDocumentOverview.totalDocuments).toBe(3)
    expect(scenarios.s5_threeNodeDocumentOverview.unavailableNodes).toBe(0)

    expect(scenarios.s6_remotePluginCacheAndCompression.remotePluginFetches).toBe(1)
    expect(scenarios.s6_remotePluginCacheAndCompression.warmEncoding).toBe('br')
    expect(scenarios.s6_remotePluginCacheAndCompression.warmWireBytes).toBeLessThan(
      scenarios.s6_remotePluginCacheAndCompression.rawBytes / 10,
    )
    expect(scenarios.s6_remotePluginCacheAndCompression.cacheDiagnostics.remoteCacheHits).toBe(1)
  })

  it('refuses remote asset cache capture when upstream sets private/no-store Cache-Control or unsafe Vary', async () => {
    const localNodeId = '00000000-0000-4000-8000-000000000001' as RuntimeNodeId
    const remoteNodeId = '00000000-0000-4000-8000-000000000002' as RuntimeNodeId
    const runtimeId = '00000000-0000-4000-8000-000000000003' as RuntimeId
    let responseHeaders: Record<string, string> = {}

    const upstream = createServer((_req, res) => {
      res.writeHead(200, {
        [NODE_SERVICE_TARGET_HEADER]: remoteNodeId,
        'content-type': 'text/javascript; charset=utf-8',
        ...responseHeaders,
      })
      res.end('export const x = 1;\n')
    })
    await new Promise<void>(resolve => { upstream.listen(0, '127.0.0.1', resolve) })
    servers.push(upstream)
    const upstreamPort = (upstream.address() as AddressInfo).port

    const environment: RuntimeCatalogEntry = {
      id: runtimeId,
      owner: { kind: 'personal', id: 1, name: 'u' },
      node: { id: remoteNodeId, name: 'remote', status: 'active', lastHeartbeatAt: null },
      routing: 'unavailable',
      observedState: 'ready',
      generation: 1,
      provisioning: 'ready',
    }
    const proxy = new GatewayNodeServiceProxy(
      {
        localNodeId,
        resolveForAccount: async () => environment,
        authorizeAdministratorNode: async () => remoteNodeId,
      },
      {
        open: async () => {
          const sock = new Socket()
          await new Promise<void>((resolve, reject) => {
            sock.once('error', reject)
            sock.connect(upstreamPort, '127.0.0.1', resolve)
          })
          return sock as never
        },
        revalidate: async () => {},
        released: async () => {},
        capacity: () => 'available',
      },
      5_000,
      {
        forwarding: true,
        maxConnections: 8, maxPerNode: 4, connectTimeoutMs: 5_000,
        httpMaxIdleConnections: 8, httpMaxIdlePerNode: 4, httpIdleTimeoutMs: 10_000,
        httpMaxPendingRequests: 8, httpMaxPendingPerNode: 4, httpQueueTimeoutMs: 5_000,
      },
    )
    const onComplete = vi.fn()
    const front = createServer((req, res) => {
      void proxy.asset(
        req,
        res,
        { id: 1, username: 'u', displayName: 'u', role: 'user', status: 'active', homePath: '/', mustChangePassword: false, autoReviewEligible: false },
        { target: 'personal', local: false, resetScope: false, environment },
        { maxBytes: 1024 * 1024, onComplete },
      )
    })
    await new Promise<void>(resolve => { front.listen(0, '127.0.0.1', resolve) })
    servers.push(front)
    const frontPort = (front.address() as AddressInfo).port
    const url = `http://127.0.0.1:${frontPort}/plugins/combo.js??a/client.js&rev=012345abcdef&dshRuntime=${runtimeId}`

    try {
      responseHeaders = { 'cache-control': 'private, max-age=60' }
      expect((await fetch(url)).status).toBe(200)
      expect(onComplete).not.toHaveBeenCalled()

      responseHeaders = { 'cache-control': 'no-store' }
      expect((await fetch(url)).status).toBe(200)
      expect(onComplete).not.toHaveBeenCalled()

      responseHeaders = { 'cache-control': 'public, max-age=31536000, immutable', vary: 'accept-encoding, cookie' }
      expect((await fetch(url)).status).toBe(200)
      expect(onComplete).not.toHaveBeenCalled()

      responseHeaders = { 'cache-control': 'public, max-age=31536000, immutable', vary: 'Accept-Encoding' }
      expect((await fetch(url)).status).toBe(200)
      expect(onComplete).toHaveBeenCalledTimes(1)
    } finally {
      await proxy.close()
    }
  })

  it('stream-compresses large forwarded remote JSON responses with Brotli while weakening strong ETags', async () => {
    const localNodeId = '00000000-0000-4000-8000-000000000001' as RuntimeNodeId
    const remoteNodeId = '00000000-0000-4000-8000-000000000002' as RuntimeNodeId
    const runtimeId = '00000000-0000-4000-8000-000000000003' as RuntimeId
    const payload = JSON.stringify({
      events: Array.from({ length: 120 }, (_, i) => ({ seq: i, kind: 'assistant', text: 'Forwarded session history payload' })),
    })
    const rawBytes = Buffer.byteLength(payload, 'utf8')

    const upstream = createServer((_req, res) => {
      res.writeHead(200, {
        [NODE_SERVICE_TARGET_HEADER]: remoteNodeId,
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(rawBytes),
        etag: '"hist-v1"',
      })
      res.end(payload)
    })
    await new Promise<void>(resolve => { upstream.listen(0, '127.0.0.1', resolve) })
    servers.push(upstream)
    const upstreamPort = (upstream.address() as AddressInfo).port

    const environment: RuntimeCatalogEntry = {
      id: runtimeId,
      owner: { kind: 'personal', id: 1, name: 'u' },
      node: { id: remoteNodeId, name: 'remote', status: 'active', lastHeartbeatAt: null },
      routing: 'unavailable',
      observedState: 'ready',
      generation: 1,
      provisioning: 'ready',
    }
    const proxy = new GatewayNodeServiceProxy(
      {
        localNodeId,
        resolveForAccount: async () => environment,
        authorizeAdministratorNode: async () => remoteNodeId,
      },
      {
        open: async () => {
          const sock = new Socket()
          await new Promise<void>((resolve, reject) => {
            sock.once('error', reject)
            sock.connect(upstreamPort, '127.0.0.1', resolve)
          })
          return sock as never
        },
        revalidate: async () => {},
        released: async () => {},
        capacity: () => 'available',
      },
      5_000,
      {
        forwarding: true,
        maxConnections: 8, maxPerNode: 4, connectTimeoutMs: 5_000,
        httpMaxIdleConnections: 8, httpMaxIdlePerNode: 4, httpIdleTimeoutMs: 10_000,
        httpMaxPendingRequests: 8, httpMaxPendingPerNode: 4, httpQueueTimeoutMs: 5_000,
      },
    )
    const front = createServer((req, res) => {
      void proxy.http(
        req,
        res,
        { id: 1, username: 'u', displayName: 'u', role: 'user', status: 'active', homePath: '/', mustChangePassword: false, autoReviewEligible: false },
      )
    })
    await new Promise<void>(resolve => { front.listen(0, '127.0.0.1', resolve) })
    servers.push(front)
    const frontPort = (front.address() as AddressInfo).port

    try {
      const result = await new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
        const req = httpRequest({
          hostname: '127.0.0.1',
          port: frontPort,
          path: `/api/session.history?dshRuntime=${runtimeId}`,
          method: 'POST',
          headers: { 'accept-encoding': 'br, gzip' },
        }, res => {
          const chunks: Buffer[] = []
          res.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
          res.once('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }) })
        })
        req.once('error', reject)
        req.end('{}')
      })
      expect(result.status).toBe(200)
      expect(result.headers['content-encoding']).toBe('br')
      expect(result.headers.etag).toBe('W/"hist-v1"')
      expect(String(result.headers.vary)).toContain('accept-encoding')
      expect(result.body.byteLength).toBeLessThan(rawBytes / 4)
      expect(brotliDecompressSync(result.body).toString('utf8')).toBe(payload)
    } finally {
      await proxy.close()
    }
  })
})
