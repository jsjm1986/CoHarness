/** Isolated real Gateway HTTP routing; external stores, authentication and runtime output are fixed fixtures. */
import { mkdtemp, rm } from 'node:fs/promises'
import { request, Agent, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { GatewayDeps } from '../src/server.ts'
import type { UserRow } from '../src/auth.ts'
import { testConfig } from './test-config.ts'

const RESPONSE_BODY = JSON.stringify({ text: 'synthetic-response-'.repeat(256), done: true })
const unreachable = (): never => { throw new Error('performance fixture reached an external service') }

/**
 * Boot a private loopback listener through the selected production Gateway entry.
 * @param enabled - Whether the same observer implementation counts requests.
 * @param plane - Source diagnostic or prebuilt Gateway modules; built mode never falls back to source.
 * @returns Fixture-owned listener, observer and asynchronous cleanup.
 */
export async function createPerformanceFixture(enabled: boolean, plane: 'source' | 'built' = 'source') {
  const root = await mkdtemp(join(tmpdir(), 'hgw-performance-'))
  let server: Server | undefined
  let observer: import('../src/performance-observer.ts').GatewayPerformanceObserver | undefined
  const close = async (): Promise<void> => {
    try {
      if (server?.listening) {
        const closing = new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()))
        server.closeAllConnections()
        await closing
      }
    } finally {
      observer?.dispose()
      await rm(root, { recursive: true, force: true })
    }
  }
  try {
    const prefix = plane === 'built' ? '../lib/' : '../src/'
    const extension = plane === 'built' ? '.js' : '.ts'
    const serverModule = await import(new URL(`${prefix}server${extension}`, import.meta.url).href) as typeof import('../src/server.ts')
    const observerModule = await import(new URL(`${prefix}performance-observer${extension}`, import.meta.url).href) as typeof import('../src/performance-observer.ts')
    observer = new observerModule.GatewayPerformanceObserver({ enabled, eventLoopResolutionMs: 20 })
    const cfg = testConfig(root)
    const user: UserRow = {
      id: 1, username: 'performance-fixture', displayName: 'Performance fixture', role: 'user', status: 'active',
      homePath: join(root, 'home'), mustChangePassword: false, autoReviewEligible: false,
    }
    const deps: GatewayDeps = {
      cfg, performance: observer,
      auth: { validate: token => token === 'fixture-only' ? user : null, login: unreachable, revoke: unreachable },
      users: {
        count: unreachable, create: unreachable, list: unreachable, getById: unreachable, getListedById: unreachable,
        getByUsername: unreachable, setStatus: unreachable, setRole: unreachable, setDisplayName: unreachable,
        remove: unreachable, resetPassword: unreachable, changeOwnPassword: unreachable,
      },
      projects: {
        create: unreachable, list: unreachable, getById: unreachable, rename: unreachable, remove: unreachable,
        setMember: unreachable, removeMember: unreachable, effectiveGrants: unreachable,
      },
      audit: { write: unreachable, query: unreachable },
      instances: {
        portOf: unreachable, stateOf: unreachable, stopReasonOf: unreachable, generationOf: unreachable,
        isLive: unreachable, touch: unreachable, wsRef: unreachable, ensureRunning: unreachable, startRequest: unreachable,
        reapIdle: unreachable, stop: unreachable, stopAll: unreachable, withStopped: unreachable,
      },
    }
    server = serverModule.createGatewayServer(deps, {
      proxy: async (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(RESPONSE_BODY) })
        res.end(RESPONSE_BODY)
      },
    })
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => { server!.off('error', reject); resolve() })
    })
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    cfg.publicOrigins.push(base)
    return { base, observer, close, responseBytes: Buffer.byteLength(RESPONSE_BODY) }
  } catch (error) {
    await close()
    throw error
  }
}

/**
 * Run a fixed closed-loop workload against a caller-owned fixture, consuming every response body.
 * @param base - Address returned by createPerformanceFixture; remote production targets are not accepted by the CLI.
 * @param options - Fixed request count, maximum in-flight requests and per-request timeout.
 * @returns Independent client latency samples and counts; this workload does not establish open-loop capacity.
 */
export async function runPerformanceLoad(base: string, options: { requests: number; concurrency: number; timeoutMs: number }) {
  for (const [name, value] of Object.entries(options)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  }
  const agent = new Agent({ keepAlive: true, maxSockets: options.concurrency })
  let next = 0
  let completed = 0
  let failed = 0
  let responseBytes = 0
  const latencyMs: number[] = []
  const statuses: Record<string, number> = {}
  const start = performance.now()
  try {
    await Promise.all(Array.from({ length: Math.min(options.concurrency, options.requests) }, async () => {
      while (next < options.requests) {
        const ordinal = next++
        const path = ordinal % 10 === 0 ? '/healthz/live' : '/api/performance-baseline?dshTarget=personal'
        const at = performance.now()
        try {
          const result = await new Promise<{ status: number; bytes: number }>((resolve, reject) => {
            const req = request(new URL(path, base), { agent, headers: { cookie: 'hgw_session=fixture-only' } }, (response) => {
              let bytes = 0
              response.on('data', (chunk: Buffer) => { bytes += chunk.length })
              response.once('error', reject)
              response.once('end', () => { resolve({ status: response.statusCode ?? 0, bytes }) })
            })
            req.setTimeout(options.timeoutMs, () => { req.destroy(new Error('performance fixture request timed out')) })
            req.once('error', reject)
            req.end()
          })
          completed += 1
          statuses[String(result.status)] = (statuses[String(result.status)] ?? 0) + 1
          responseBytes += result.bytes
          if (result.status !== 200) failed += 1
        } catch { failed += 1 }
        latencyMs.push(performance.now() - at)
      }
    }))
    const elapsedMs = performance.now() - start
    const sorted = latencyMs.toSorted((left, right) => left - right)
    const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
    return {
      offered: next, completed, failed, statuses, responseBytes, elapsedMs,
      completedPerSecond: completed * 1000 / elapsedMs,
      latencyMs: { p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99), max: sorted.at(-1)!, samples: latencyMs },
    }
  } finally {
    const sockets = new Set([...Object.values(agent.sockets), ...Object.values(agent.freeSockets)].flat()
      .filter((socket): socket is Socket => socket !== undefined))
    const closed = [...sockets].map(socket => socket.closed
      ? Promise.resolve()
      : new Promise<void>(resolve => { socket.once('close', () => { resolve() }) }))
    agent.destroy()
    await Promise.all(closed)
  }
}
