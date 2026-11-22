/**
 * Reproducible multi-computer latency benchmark under synthetic central-PG tunnel RTT.
 * Exercises real Center <-> NodeAgent <-> Remote Gateway HTTP/WebSocket forwarding,
 * access-monitor synchronization, pool contention, org-wide invalidation storms,
 * and multi-computer document overview fan-out.
 *
 * Run directly:
 *   node --import tsx/esm gateway/tests/multi-computer-latency.perf.ts
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket, { WebSocketServer } from 'ws'
import { openDb } from '../src/db.ts'
import { AuthService } from '../src/auth.ts'
import { AuditService } from '../src/audit.ts'
import { UserService } from '../src/users.ts'
import { ProjectService } from '../src/projects.ts'
import { InstanceManager } from '../src/instances.ts'
import { createGatewayServer, scopeCookie, type GatewayDeps } from '../src/server.ts'
import { RuntimeAssets } from '../src/runtime-assets.ts'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { verifyGatewayForward } from '../src/forwarded-principal.ts'
import { generateKeyPairSync } from 'node:crypto'
import { brotliDecompressSync } from 'node:zlib'
import { request as httpRequest } from 'node:http'
import { GatewayRuntimeRouter, LocalRuntimeAdapter } from '../src/runtime-router.ts'
import { RuntimeCatalogError, type RuntimeCatalogEntry, type RuntimeId, type RuntimeNodeId } from '../src/runtime-catalog.ts'
import { NodeAccessError, type NodeCredential, type NodeLease } from '../src/node-access.ts'
import { GatewayNodeChannels } from '../src/node-channel.ts'
import { runNodeChannel } from '../src/node-channel-client.ts'
import { NodeDialer } from '../src/node-dialer.ts'
import { loadNodeChannelClientLimits } from '../src/node-channel-protocol.ts'
import { GatewayNodeServices } from '../src/node-service.ts'
import { GatewayNodeServiceProxy } from '../src/node-service-proxy.ts'
import type { AccessInvalidationSubject, GatewayAccessMonitor } from '../src/access-invalidation.ts'
import { createBrowserDocumentHandler } from '../src/browser-documents.ts'
import { mergeDocumentOverview } from '../src/node-content-documents-overview.ts'
import { NODE_SERVICE_TARGET_HEADER } from '../src/node-service-stream.ts'
import { testConfig } from './test-config.ts'
import { writePerformanceReport } from './performance-report.ts'

function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return Math.round(sorted[index]! * 100) / 100
}

function summarize(samples: readonly number[], totalMs: number) {
  return {
    count: samples.length,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: samples.length === 0 ? 0 : Math.round(Math.max(...samples) * 100) / 100,
    totalMs: Math.round(totalMs * 100) / 100,
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) })
}

class SyntheticAccessMonitor implements Pick<GatewayAccessMonitor, 'subscribe' | 'synchronize' | 'available' | 'currentRevision' | 'ensureAtLeast'> {
  readonly available = true
  private readonly listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
  private revision = 1n
  syncCalls = 0
  ensureAtLeastSkips = 0
  constructor(private readonly rttMs: number, private readonly sharedDbRevision: { current: bigint }) {}
  currentRevision(): bigint | undefined { return this.available ? this.revision : undefined }
  async ensureAtLeast(revision: bigint): Promise<boolean> {
    if (this.available && this.revision >= revision) {
      this.ensureAtLeastSkips += 1
      return true
    }
    await this.synchronize()
    return this.available && this.revision >= revision
  }
  subscribe(listener: (subject: AccessInvalidationSubject) => void | Promise<void>): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  async synchronize(): Promise<void> {
    this.syncCalls += 1
    if (this.rttMs > 0) await delay(this.rttMs)
    this.revision = this.sharedDbRevision.current
  }
  async emit(subject: AccessInvalidationSubject, peers: SyntheticAccessMonitor[] = []): Promise<void> {
    this.sharedDbRevision.current += 1n
    this.revision = this.sharedDbRevision.current
    for (const listener of this.listeners) await listener(subject)
    // Simulate PostgreSQL NOTIFY propagating the committed revision to connected peers.
    for (const peer of peers) {
      peer.revision = this.sharedDbRevision.current
      for (const listener of peer.listeners) await listener(subject)
    }
  }
}

/** Options controlling synthetic database RTT injection for benchmark or deterministic regression runs. */
export interface MultiComputerBenchmarkOptions {
  readonly tunnelPgRttMs?: number
  readonly centerPgRttMs?: number
}

/** Run the end-to-end multi-computer benchmark and return its structured report. */
export async function runMultiComputerBenchmark(options: MultiComputerBenchmarkOptions = {}) {
  const TUNNEL_PG_RTT_MS = options.tunnelPgRttMs ?? Number(process.env.HGW_PERF_TUNNEL_PG_RTT_MS ?? '40')
  const CENTER_PG_RTT_MS = options.centerPgRttMs ?? Number(process.env.HGW_PERF_CENTER_PG_RTT_MS ?? '4')
  const SCALE_TO_200MS = 200 / Math.max(1, TUNNEL_PG_RTT_MS)
  const root = await mkdtemp(join(tmpdir(), 'hgw-multi-computer-perf-'))
  const cleanups: Array<() => Promise<void>> = []
  try {
    const db = openDb(join(root, 'accounts.sqlite'))
    cleanups.push(async () => { db.close() })
    const centerConfig = testConfig(join(root, 'center'), { HGW_NODE_SERVICE_FORWARDING: 'on' })
    const remoteConfig = testConfig(join(root, 'remote'))
    const users = new UserService(db, centerConfig)
    const admin = await users.create({ username: 'perf-admin', password: 'pw-12345678', role: 'admin' })
    await users.changeOwnPassword(admin.id, 'pw-12345678')

    const localNodeId = randomUUID() as RuntimeNodeId
    const remoteNodeId = randomUUID() as RuntimeNodeId
    const lease: NodeLease = {
      protocolVersion: 1,
      organizationId: randomUUID() as NodeLease['organizationId'],
      nodeId: remoteNodeId,
      connectionId: randomUUID() as NodeLease['connectionId'],
      epoch: '1' as NodeLease['epoch'],
      executionReady: true,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      heartbeatMs: 5_000,
    }
    const credential = `dsh_node_${randomBytes(32).toString('base64url')}` as NodeCredential

    const pgCounts = {
      centerAuthorizeChannel: 0,
      remoteTunnelAuthorizeChannel: 0,
      remoteTunnelProxyAdmission: 0,
      remoteTunnelReadySession: 0,
    }

    const centerAuthorizeChannel = async (token: string, input: unknown) => {
      pgCounts.centerAuthorizeChannel += 1
      if (CENTER_PG_RTT_MS > 0) await delay(CENTER_PG_RTT_MS)
      const value = input as { connectionId: string; epoch: string }
      if (token !== credential) throw new NodeAccessError(401, 'node-access/unauthorized')
      if (value.connectionId !== lease.connectionId || value.epoch !== lease.epoch) throw new NodeAccessError(409, 'node-access/lease-lost')
      return lease
    }
    const remoteAuthorizeChannel = async (token: string, input: unknown) => {
      pgCounts.remoteTunnelAuthorizeChannel += 1
      if (TUNNEL_PG_RTT_MS > 0) await delay(TUNNEL_PG_RTT_MS)
      const value = input as { connectionId: string; epoch: string }
      if (token !== credential) throw new NodeAccessError(401, 'node-access/unauthorized')
      if (value.connectionId !== lease.connectionId || value.epoch !== lease.epoch) throw new NodeAccessError(409, 'node-access/lease-lost')
      return lease
    }

    const environment: RuntimeCatalogEntry = {
      id: randomUUID() as RuntimeId,
      owner: { kind: 'personal', id: admin.id, name: admin.displayName },
      node: { id: remoteNodeId, name: 'Remote-Ubuntu-101', status: 'active', lastHeartbeatAt: null },
      generation: 1,
      observedState: 'ready',
      routing: 'unavailable',
    }
    const resolveForAccount = async (actor: typeof admin, id: string) => {
      if (CENTER_PG_RTT_MS > 0) await delay(CENTER_PG_RTT_MS)
      if (id !== environment.id || actor.id !== admin.id) throw new RuntimeCatalogError(404, 'runtime-catalog/not-found')
      return environment
    }
    const catalog = {
      resolveForAccount,
      resolveForLanding: async (actor: typeof admin) => resolveForAccount(actor, environment.id),
      resolveForOwner: async (actor: typeof admin) => resolveForAccount(actor, environment.id),
      pageForAccount: async () => ({ items: [environment], nextCursor: null }),
      pageForAdministrator: async () => ({ items: [environment], nextCursor: null }),
    }

    const sharedDbRevision = { current: 1n }
    const centerMonitor = new SyntheticAccessMonitor(CENTER_PG_RTT_MS, sharedDbRevision)
    const remoteMonitor = new SyntheticAccessMonitor(TUNNEL_PG_RTT_MS, sharedDbRevision)
    const forwardKeys = generateKeyPairSync('ed25519')
    const forwardSigner = new GatewayPrincipalSigner(forwardKeys.privateKey, lease.organizationId, 30_000)
    const channels = new GatewayNodeChannels({
      authorizeChannel: centerAuthorizeChannel,
      authorizeAdministratorNode: async () => remoteNodeId,
    }, centerConfig.nodeChannel)
    const services = new GatewayNodeServices({ authorizeChannel: centerAuthorizeChannel }, channels, centerConfig.nodeService)
    const proxy = new GatewayNodeServiceProxy({
      localNodeId,
      resolveForAccount,
      resolveForAdministrator: resolveForAccount,
      authorizeAdministratorNode: async () => remoteNodeId,
      authorizeAccountNode: async () => {},
      resolvePlacement: (actor, selection) => centerRouter.placement(actor, selection),
      resetScopeCookie: () => scopeCookie('personal', centerConfig),
    }, services, 15_000, centerConfig.nodeService, centerMonitor as unknown as GatewayAccessMonitor,
    async (target, user, request) => {
      const rev = centerMonitor.currentRevision()
      return forwardSigner.issueForward({
        issuerNode: localNodeId,
        audienceNode: target.nodeId,
        user,
        selection: { runtimeId: target.runtimeId ?? null, target: target.resolvedTarget ?? null },
        ...(target.environment === undefined || target.resolvedTarget === undefined ? {} : {
          context: { environment: { id: target.environment.id, nodeId: target.environment.node.id, nodeName: target.environment.node.name } },
        }),
        request,
        ...(rev === undefined ? {} : { accessRevision: String(rev) }),
      })
    })
    cleanups.push(async () => { await proxy.close(); await services.close(); await channels.close() })

    const makeDeps = (cfg: typeof centerConfig, id: RuntimeNodeId, authChannel: typeof centerAuthorizeChannel): GatewayDeps => ({
      cfg,
      auth: new AuthService(db, cfg),
      users,
      projects: new ProjectService(db, cfg),
      audit: new AuditService(db),
      instances: new InstanceManager(db, cfg),
      runtimeCatalog: catalog,
      nodeServiceIdentity: { nodeId: id, organizationId: lease.organizationId, authorize: authChannel },
    })
    const centerDeps = makeDeps(centerConfig, localNodeId, centerAuthorizeChannel)
    const remoteDeps = makeDeps(remoteConfig, remoteNodeId, remoteAuthorizeChannel)
    centerDeps.nodeChannels = channels
    centerDeps.nodeServices = services
    centerDeps.nodeServiceProxy = proxy
    const centerRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(centerDeps), { localNodeId, catalog })
    centerDeps.runtimeRouter = centerRouter
    remoteDeps.runtimeRouter = new GatewayRuntimeRouter(new LocalRuntimeAdapter(remoteDeps), { localNodeId: remoteNodeId, catalog })
    remoteDeps.accessMonitor = remoteMonitor as unknown as GatewayAccessMonitor
    remoteDeps.forwardedPrincipal = async assertion => verifyGatewayForward(assertion, forwardKeys.publicKey, {
      audienceNode: remoteNodeId,
      organization: lease.organizationId,
    })

    const remoteWss = new WebSocketServer({ noServer: true })
    remoteWss.on('headers', headers => { headers.push(`${NODE_SERVICE_TARGET_HEADER}: ${remoteNodeId}`) })
    cleanups.push(async () => { await new Promise<void>(resolve => { remoteWss.close(() => { resolve() }) }) })

    const syncRemoteAccess = async (forwardedRevision?: bigint) => {
      if (forwardedRevision !== undefined && await remoteMonitor.ensureAtLeast(forwardedRevision)) return
      await remoteMonitor.synchronize()
    }

    const remoteServer = createGatewayServer(remoteDeps, {
      readySession: async (_req, res) => {
        // Simulates remote readySession fast path: single atomic admitSession SQL over tunnel (1 RTT vs 3+ RTTs).
        pgCounts.remoteTunnelReadySession += 1
        if (TUNNEL_PG_RTT_MS > 0) await delay(TUNNEL_PG_RTT_MS)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true,"route":"readySession"}')
        return true
      },
      proxy: async (_req, res, context) => {
        // Simulates remote proxy.ts slow-path admission with Wave 3 ensureAtLeast sync skip + 2 serial PG checks.
        await syncRemoteAccess(context.forwardedAccessRevision)
        pgCounts.remoteTunnelProxyAdmission += 2
        if (TUNNEL_PG_RTT_MS > 0) await delay(TUNNEL_PG_RTT_MS * 2)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"ok":true}')
      },
      upgrade: async (req, socket, head, context) => {
        await syncRemoteAccess(context.forwardedAccessRevision)
        remoteWss.handleUpgrade(req, socket, head, ws => {
          ws.send('{"ready":true}')
        })
      },
    })
    const centerServer = createGatewayServer(centerDeps, {
      proxy: async (_req, res) => { res.writeHead(500); res.end('unexpected-local') },
      upgrade: async (_req, socket) => { socket.destroy() },
    })
    const remoteBase = await listen(remoteServer)
    cleanups.push(() => close(remoteServer))
    const centerBase = await listen(centerServer)
    cleanups.push(() => close(centerServer))
    centerConfig.publicOrigins = [centerBase]
    remoteConfig.publicOrigins = [centerBase, remoteBase]

    const agentController = new AbortController()
    const channelReady = new Promise<void>(resolve => {
      const dialer = new NodeDialer([centerBase], 60_000, () => {})
      const agentRun = runNodeChannel({
        dialer,
        credential,
        lease,
        requestTimeoutMs: 10_000,
        retryMs: 60_000,
        limits: loadNodeChannelClientLimits({})!,
        localGatewayUrl: remoteBase,
        maxServices: centerConfig.nodeService.maxPerNode,
      }, agentController.signal, event => {
        if (event.status === 'channel-ready') resolve()
      }, async () => ({ platform: 'linux', architecture: 'x64', uptimeSeconds: 1, executionReady: true }))
      cleanups.push(async () => {
        agentController.abort()
        await agentRun.catch(() => {})
      })
    })
    await channelReady

    const loginRes = await fetch(`${centerBase}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: centerBase },
      body: new URLSearchParams({ username: 'perf-admin', password: 'pw-12345678' }),
      redirect: 'manual',
    })
    const cookie = (loginRes.headers.get('set-cookie') ?? '').split(';', 1)[0]!
    await loginRes.arrayBuffer()

    const snapshotCounters = () => ({
      ...pgCounts,
      centerAccessSync: centerMonitor.syncCalls,
      remoteTunnelAccessSync: remoteMonitor.syncCalls,
      remoteTunnelAccessSyncSkipped: remoteMonitor.ensureAtLeastSkips,
      forwarding: proxy.diagnostics(),
    })
    const delta = (before: ReturnType<typeof snapshotCounters>, after: ReturnType<typeof snapshotCounters>) => ({
      centerAuthorizeChannel: after.centerAuthorizeChannel - before.centerAuthorizeChannel,
      remoteTunnelAuthorizeChannel: after.remoteTunnelAuthorizeChannel - before.remoteTunnelAuthorizeChannel,
      remoteTunnelProxyAdmission: after.remoteTunnelProxyAdmission - before.remoteTunnelProxyAdmission,
      remoteTunnelReadySession: after.remoteTunnelReadySession - before.remoteTunnelReadySession,
      centerAccessSync: after.centerAccessSync - before.centerAccessSync,
      remoteTunnelAccessSync: after.remoteTunnelAccessSync - before.remoteTunnelAccessSync,
      remoteTunnelAccessSyncSkipped: after.remoteTunnelAccessSyncSkipped - before.remoteTunnelAccessSyncSkipped,
      poolOpened: after.forwarding.pool.opened - before.forwarding.pool.opened,
      poolReused: after.forwarding.pool.reused - before.forwarding.pool.reused,
      poolQueued: after.forwarding.pool.queued - before.forwarding.pool.queued,
      poolRevalidateCalls: after.forwarding.pool.revalidateCalls - before.forwarding.pool.revalidateCalls,
      poolRevalidateSkipped: after.forwarding.pool.revalidateSkipped - before.forwarding.pool.revalidateSkipped,
      idleInvalidationsGlobal: after.forwarding.pool.idleInvalidationsGlobal - before.forwarding.pool.idleInvalidationsGlobal,
      closedIdleEntries: after.forwarding.pool.closedIdleEntries - before.forwarding.pool.closedIdleEntries,
    })

    const apiUrl = `${centerBase}/api/session.list?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`
    const callOne = async (path = apiUrl, extraHeaders: Record<string, string> = {}): Promise<number> => {
      const started = performance.now()
      const res = await fetch(path, {
        method: 'POST',
        headers: {
          cookie,
          origin: centerBase,
          'content-type': 'application/json',
          'x-dsh-expected-principal-id': String(admin.id),
          ...extraHeaders,
        },
        body: '{}',
      })
      if (res.status !== 200) throw new Error(`unexpected status ${String(res.status)}`)
      await res.arrayBuffer()
      return performance.now() - started
    }

    // Scenario 1: Concurrent 6-request Web UI page-open / computer-switch burst
    const s1Before = snapshotCounters()
    const s1Start = performance.now()
    const s1Samples = await Promise.all([
      callOne(`${centerBase}/api/host.describe?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`),
      callOne(`${centerBase}/api/session.list?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`),
      callOne(`${centerBase}/api/workspace.list?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`),
      callOne(`${centerBase}/api/session.history?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`),
      callOne(`${centerBase}/api/terminal/list?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`),
      callOne(`${centerBase}/api/files/list?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`),
    ])
    const s1Total = performance.now() - s1Start
    const s1Delta = delta(s1Before, snapshotCounters())

    // Scenario 2: 10 sequential warm interactive RPCs (e.g., terminal keystrokes / file clicks)
    const s2Before = snapshotCounters()
    const s2Start = performance.now()
    const s2Samples: number[] = []
    for (let i = 0; i < 10; i++) {
      s2Samples.push(await callOne(`${centerBase}/api/terminal/write?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`))
    }
    const s2Total = performance.now() - s2Start
    const s2Delta = delta(s2Before, snapshotCounters())

    // Scenario 3: Unrelated org-wide invalidation followed by 4 concurrent requests
    const s3Before = snapshotCounters()
    await centerMonitor.emit({ userId: 999999 }, [remoteMonitor])
    await delay(10)
    const s3Start = performance.now()
    const s3Samples = await Promise.all([callOne(), callOne(), callOne(), callOne()])
    const s3Total = performance.now() - s3Start
    const s3Delta = delta(s3Before, snapshotCounters())

    // Scenario 4: Dual WebSocket upgrades (events.mux + events.host)
    const openWs = (path: string): Promise<{ ms: number; ws: WebSocket }> => new Promise((resolve, reject) => {
      const started = performance.now()
      const ws = new WebSocket(`${centerBase.replace(/^http/, 'ws')}${path}?dshRuntime=${environment.id}&dshTarget=personal&dshNode=${remoteNodeId}`, {
        headers: { cookie, origin: centerBase },
      })
      ws.once('error', reject)
      ws.once('message', () => { resolve({ ms: performance.now() - started, ws }) })
    })
    const s4Before = snapshotCounters()
    const s4Start = performance.now()
    const openedWs = await Promise.all([openWs('/api/events.mux'), openWs('/api/events.host')])
    const s4Total = performance.now() - s4Start
    const s4Samples = openedWs.map(entry => entry.ms)
    for (const entry of openedWs) entry.ws.close()
    await delay(20)
    const s4Delta = delta(s4Before, snapshotCounters())

    // Scenario 5: Multi-computer document overview across 3 remote computers (simulated 1-RTT per node)
    const nodeIds = [randomUUID() as RuntimeNodeId, randomUUID() as RuntimeNodeId, randomUUID() as RuntimeNodeId]
    const mockOverviewServer = createServer(async (req, res) => {
      const targetNode = new URL(req.url ?? '/', 'http://gateway').searchParams.get('dshNode') ?? nodeIds[0]!
      if (TUNNEL_PG_RTT_MS > 0) await delay(TUNNEL_PG_RTT_MS)
      res.writeHead(200, { 'content-type': 'application/json', [NODE_SERVICE_TARGET_HEADER]: targetNode })
      res.end(JSON.stringify({
        documents: [{
          catalogId: randomUUID(),
          scope: { kind: 'personal', id: admin.id, label: 'Personal', mode: 'rw', nodeId: targetNode },
          docId: 'doc-1', directoryId: '', name: 'spec.md', bytes: 128, mediaType: 'text/markdown',
          modifiedAt: Date.now(), owner: { id: admin.id, displayName: admin.displayName },
          identity: null, trashId: null, ownerSource: 'upload', state: 'active',
          trashedAt: null, restoredAt: null, purgeAfter: null, purgedAt: null, legacy: false, lineageRootId: null,
        }],
        metrics: { total: 1, active: 1, trash: 0, purged: 0, deleted: 0, personal: 1, project: 0, bytes: 128, operations24h: 0, failures24h: 0 },
        totalDocuments: 1,
      }))
    })
    const mockOverviewUrl = await listen(mockOverviewServer)
    cleanups.push(() => close(mockOverviewServer))
    const mockOverviewPort = Number(new URL(mockOverviewUrl).port)
    let overviewConcurrencyObserved = 0
    const browserDocs = createBrowserDocumentHandler({
      transfer: {} as never,
      locations: {} as never,
      organizationId: lease.organizationId,
      origin: centerBase,
      responseLimit: 4 * 1024 * 1024,
      overview: {
        overview: async (userId, options, _includeProject, readRemote, signal, concurrency, progress) => {
          overviewConcurrencyObserved = concurrency ?? 1
          return mergeDocumentOverview(
            { organizationId: lease.organizationId, userId, entryNodeId: localNodeId },
            options ?? {},
            nodeIds.map(nodeId => ({ id: nodeId, read: (offset, limit, s) => readRemote!(nodeId, offset, limit, s) })),
            concurrency ?? 1,
            signal,
            progress,
          )
        },
      },
      overviewDeadlineMs: 5_000,
    })
    const s5Start = performance.now()
    const overviewResult = await browserDocs(
      { headers: { cookie }, socket: { localPort: mockOverviewPort } } as never,
      admin,
      'overview',
      { limit: 20 },
      new AbortController().signal,
    ) as { totalDocuments: number; unavailableNodes?: readonly string[] }
    const s5Total = performance.now() - s5Start

    // Scenario 6: Center-side remote /plugins/combo.js cache (cold vs warm) + Brotli dynamic compression ratio
    const pluginPayload = 'export const bundle = ' + JSON.stringify(Array.from({ length: 400 }, (_, i) => ({
      id: `plugin-item-${i}`, title: 'Multi-computer plugin module payload', version: '1.0.0',
    }))) + ';\n'
    const pluginBytes = Buffer.byteLength(pluginPayload, 'utf8')
    let remotePluginFetches = 0
    const pluginAssets = new RuntimeAssets({
      cfg: centerConfig,
      localNodeId,
      admission: {
        admit: async () => {
          if (CENTER_PG_RTT_MS > 0) await delay(CENTER_PG_RTT_MS)
          return {
            user: admin,
            scope: { kind: 'personal' },
            accessRevision: '1',
            expiresAt: Date.now() + 60_000,
            placement: { local: false, resetScope: false, target: 'personal', environment },
            snapshot: { target: { kind: 'user', id: admin.id, runtimeId: environment.id }, state: 'ready', generation: 1, port: 1, launchStamp: 's', startedAt: Date.now() },
          }
        },
      },
      instances: { retainAsset: async () => null },
      monitor: { available: true, synchronize: async () => {}, synchronizeTo: async () => true, subscribe: () => () => {} },
      signer: new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'perf', 30_000),
      forward: async (_req, res, _actor, _placement, capture) => {
        remotePluginFetches += 1
        if (TUNNEL_PG_RTT_MS > 0) await delay(TUNNEL_PG_RTT_MS)
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', etag: '"rev-012345abcdef"' })
        res.end(pluginPayload)
        capture?.onComplete({
          status: 200,
          contentType: 'text/javascript; charset=utf-8',
          etag: '"rev-012345abcdef"',
          body: Buffer.from(pluginPayload, 'utf8'),
        })
        return true
      },
    })
    cleanups.push(() => pluginAssets.close())
    const pluginServer = createServer((req, res) => { void pluginAssets.handle(req, res, admin) })
    const pluginBase = await listen(pluginServer)
    cleanups.push(() => close(pluginServer))
    const pluginPort = Number(new URL(pluginBase).port)
    const pluginPath = `/plugins/combo.js??fixture/client.js&rev=012345abcdef&dshRuntime=${environment.id}`
    const fetchRaw = (headers: Record<string, string>) => new Promise<{ ms: number; bytes: number; encoding: string | undefined }>((resolve, reject) => {
      const started = performance.now()
      const req = httpRequest({ hostname: '127.0.0.1', port: pluginPort, path: pluginPath, method: 'GET', headers: { cookie, ...headers } }, res => {
        const chunks: Buffer[] = []
        res.on('data', chunk => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) })
        res.once('end', () => {
          const buf = Buffer.concat(chunks)
          if (res.headers['content-encoding'] === 'br' && brotliDecompressSync(buf).toString('utf8') !== pluginPayload) {
            reject(new Error('corrupt brotli payload')); return
          }
          resolve({ ms: performance.now() - started, bytes: buf.byteLength, encoding: res.headers['content-encoding'] })
        })
      })
      req.once('error', reject); req.end()
    })
    const s6Cold = await fetchRaw({ 'accept-encoding': 'br, gzip' })
    const s6Warm = await fetchRaw({ 'accept-encoding': 'br, gzip' })

    return {
      schemaVersion: 1,
      config: {
        tunnelPgRttMs: TUNNEL_PG_RTT_MS,
        centerPgRttMs: CENTER_PG_RTT_MS,
        extrapolationFactorTo200ms: Math.round(SCALE_TO_200MS * 100) / 100,
        httpMaxIdlePerNode: centerConfig.nodeService.httpMaxIdlePerNode,
        preparedReadDelegation: centerConfig.nodeService.preparedReadDelegation,
      },
      scenarios: {
        s1_concurrentPageBurst6: { ...summarize(s1Samples, s1Total), pgAndPool: s1Delta },
        s2_warmInteractiveSequential10: { ...summarize(s2Samples, s2Total), pgAndPool: s2Delta },
        s3_afterUnrelatedOrgInvalidationBurst4: { ...summarize(s3Samples, s3Total), pgAndPool: s3Delta },
        s4_dualWebSocketUpgrade: { ...summarize(s4Samples, s4Total), pgAndPool: s4Delta },
        s5_threeNodeDocumentOverview: {
          totalMs: Math.round(s5Total * 100) / 100,
          nodesQueried: nodeIds.length,
          concurrency: overviewConcurrencyObserved,
          totalDocuments: overviewResult.totalDocuments,
          unavailableNodes: overviewResult.unavailableNodes?.length ?? 0,
        },
        s6_remotePluginCacheAndCompression: {
          coldMs: Math.round(s6Cold.ms * 100) / 100,
          warmMs: Math.round(s6Warm.ms * 100) / 100,
          rawBytes: pluginBytes,
          warmWireBytes: s6Warm.bytes,
          warmEncoding: s6Warm.encoding,
          compressionRatio: Math.round((s6Warm.bytes / pluginBytes) * 1000) / 1000,
          remotePluginFetches,
          cacheDiagnostics: pluginAssets.diagnostics(),
        },
      },
      finalForwardingDiagnostics: proxy.diagnostics(),
    }
  } finally {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  writePerformanceReport(await runMultiComputerBenchmark())
}
