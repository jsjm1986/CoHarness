/** Center-owned connection admission for existing Gateways on enrolled computers. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { NodeLease } from './node-access.ts'
import { NodeAccessError } from './node-access.ts'
import { NODE_CONNECTION_HEADER, NODE_EPOCH_HEADER, type NodeProbeId } from './node-channel-protocol.ts'
import { nodeServiceHttpSocket } from './node-service-http-pool.ts'
import {
  NODE_SERVICE_FRAME_BYTES, NODE_SERVICE_STREAM_PATH, NODE_SERVICE_STREAM_PROTOCOL,
  NodeServiceError, nodeServiceDuplex,
} from './node-service-stream.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import type { PostgresNodeAccessService } from './postgres/node-access-service.ts'

/** Independent connection budgets leave the control channel available during bulk transfer. */
export interface NodeServiceConfig {
  forwarding: boolean
  maxConnections: number
  maxPerNode: number
  connectTimeoutMs: number
  httpIdleTimeoutMs: number
  httpMaxIdleConnections: number
  httpMaxIdlePerNode: number
  httpMaxPendingRequests: number
  httpQueueTimeoutMs: number
}

/** Authenticated control-channel request; disposal withdraws only this connection. */
export interface NodeServiceRequest {
  lease: NodeLease
  dispose(): void
}

/** A node connection opens only its operator-configured local Gateway. */
export interface NodeServiceChannels {
  requestService(nodeId: RuntimeNodeId, id: NodeProbeId, release: string | null,
    failed: (error: unknown) => void, signal: AbortSignal): Promise<NodeServiceRequest>
}

interface Connection {
  nodeId: RuntimeNodeId
  lease?: NodeLease
  request?: NodeServiceRequest
  socket?: WebSocket
  stream?: Duplex
  credential?: string
  closed?: Promise<void>
  finished: boolean
  accept(socket: WebSocket, transport: IncomingMessage['socket']): void
  fail(error: unknown): void
}

function setting(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!/^[1-9][0-9]*$/u.test(raw) || !Number.isSafeInteger(value) || value > 2_147_483_647) throw new Error(`${key} must be a positive safe timer integer`)
  return value
}

/**
 * Resolve the existing-service transport's independent admission limits.
 * @param env - operator deployment settings.
 * @returns validated global, per-node and acquisition limits.
 */
export function loadNodeServiceConfig(env: NodeJS.ProcessEnv): NodeServiceConfig {
  const forwarding = env.HGW_NODE_SERVICE_FORWARDING ?? 'off'
  if (forwarding !== 'on' && forwarding !== 'off') throw new Error('HGW_NODE_SERVICE_FORWARDING must be on or off')
  const maxConnections = setting(env, 'HGW_NODE_SERVICE_MAX_CONNECTIONS', 64)
  const maxPerNode = setting(env, 'HGW_NODE_SERVICE_MAX_PER_NODE', 16)
  if (maxPerNode > maxConnections) throw new Error('HGW_NODE_SERVICE_MAX_PER_NODE must not exceed HGW_NODE_SERVICE_MAX_CONNECTIONS')
  const httpMaxIdleConnections = setting(env, 'HGW_NODE_SERVICE_HTTP_MAX_IDLE_CONNECTIONS', Math.min(16, maxConnections))
  const httpMaxIdlePerNode = setting(env, 'HGW_NODE_SERVICE_HTTP_MAX_IDLE_PER_NODE', Math.min(2, maxPerNode, httpMaxIdleConnections))
  if (httpMaxIdleConnections > maxConnections || httpMaxIdlePerNode > maxPerNode || httpMaxIdlePerNode > httpMaxIdleConnections) {
    throw new Error('Node service HTTP idle limits must fit the global and per-node connection limits')
  }
  return { forwarding: forwarding === 'on', maxConnections, maxPerNode, connectTimeoutMs: setting(env, 'HGW_NODE_SERVICE_CONNECT_TIMEOUT_MS', 10_000),
    httpIdleTimeoutMs: setting(env, 'HGW_NODE_SERVICE_HTTP_IDLE_TIMEOUT_MS', 30_000), httpMaxIdleConnections, httpMaxIdlePerNode,
    httpMaxPendingRequests: setting(env, 'HGW_NODE_SERVICE_HTTP_MAX_PENDING_REQUESTS', 256),
    httpQueueTimeoutMs: setting(env, 'HGW_NODE_SERVICE_HTTP_QUEUE_TIMEOUT_MS', 60_000) }
}

/** One center's transport owner; HTTP/user authorization belongs to the existing Gateway request path. */
export class GatewayNodeServices {
  private readonly server = new WebSocketServer({ noServer: true, clientTracking: false,
    perMessageDeflate: false, maxPayload: NODE_SERVICE_FRAME_BYTES })
  private readonly connections = new Map<NodeProbeId, Connection>()
  private readonly perNode = new Map<RuntimeNodeId, number>()
  private readonly paused = new Set<RuntimeNodeId>()
  private readonly sockets = new Map<WebSocket, Promise<void>>()
  private readonly streamOwners = new WeakMap<Duplex, Connection>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private checking = 0
  private closing?: Promise<void>

  /**
   * @param authority - current enrolled credential and exact lease verification.
   * @param channels - owned outbound node control channels.
   * @param config - validated connection admission and acquisition deadlines.
   * @param release - center release identity; null permits source development compositions.
   */
  constructor(private readonly authority: Pick<PostgresNodeAccessService, 'authorizeChannel'>,
    private readonly channels: NodeServiceChannels, private readonly config: NodeServiceConfig,
    private readonly release: string | null) {}

  private track<T>(operation: Promise<T>): Promise<T> {
    this.work.add(operation)
    void operation.then(() => { this.work.delete(operation) }, () => { this.work.delete(operation) })
    return operation
  }

  /**
   * Observe the connection limit that would currently block one new transport.
   * @param nodeId - target computer; its limit takes precedence over global pressure.
   * @returns current pressure without reserving capacity or authorizing a connection.
   */
  capacity(nodeId: RuntimeNodeId): 'available' | 'node' | 'global' {
    if ((this.perNode.get(nodeId) ?? 0) >= this.config.maxPerNode) return 'node'
    return this.connections.size >= this.config.maxConnections ? 'global' : 'available'
  }

  /**
   * Acquire one connection after the caller resolves the authorized target node.
   * @param nodeId - server-resolved computer identity, never an arbitrary network address.
   * @param signal - owning HTTP or browser WebSocket lifetime.
   * @returns the raw HTTP connection; cancellation closes only this request's connection.
   */
  open(nodeId: RuntimeNodeId, signal: AbortSignal): Promise<Duplex> {
    if (this.lifetime.signal.aborted) return Promise.reject(new NodeServiceError(503, 'node-service/closed'))
    if (this.paused.has(nodeId)) return Promise.reject(new NodeServiceError(409, 'node-service/cancelled'))
    if (signal.aborted) return Promise.reject(new NodeServiceError(409, 'node-service/cancelled'))
    if (this.capacity(nodeId) !== 'available') {
      return Promise.reject(new NodeServiceError(503, 'node-service/busy'))
    }
    const id = randomUUID() as NodeProbeId
    const owner = AbortSignal.any([signal, this.lifetime.signal])
    return new Promise<Duplex>((resolve, reject) => {
      const cleanup = () => {
        if (!this.connections.delete(id)) return
        clearTimeout(timer)
        owner.removeEventListener('abort', abort)
        connection.request?.dispose()
        const count = this.perNode.get(nodeId)! - 1
        if (count === 0) this.perNode.delete(nodeId); else this.perNode.set(nodeId, count)
      }
      const abort = () => { connection.fail(new NodeServiceError(409, 'node-service/cancelled')) }
      const timer = setTimeout(() => { connection.fail(new NodeServiceError(504, 'node-service/timeout')) }, this.config.connectTimeoutMs)
      timer.unref()
      const connection: Connection = {
        nodeId, finished: false,
        fail: (error) => {
          if (connection.finished) return
          connection.finished = true
          reject(error)
          connection.stream?.destroy()
          if (connection.socket !== undefined) connection.socket.terminate()
          else cleanup()
        },
        accept: (socket, transport) => {
          if (connection.finished || connection.socket !== undefined) { socket.terminate(); return }
          connection.socket = socket
          const closed = new Promise<void>(done => { socket.once('close', () => { done() }) })
          connection.closed = closed
          this.sockets.set(socket, closed)
          socket.once('close', () => {
            connection.finished = true
            reject(new NodeServiceError(503, 'node-service/unavailable'))
            this.sockets.delete(socket); cleanup()
          })
          socket.on('error', () => { connection.fail(new NodeServiceError(503, 'node-service/unavailable')) })
          clearTimeout(timer)
          const stream = nodeServiceHttpSocket(nodeServiceDuplex(socket), transport)
          connection.stream = stream
          this.streamOwners.set(stream, connection)
          stream.on('error', () => { connection.fail(new NodeServiceError(503, 'node-service/unavailable')) })
          resolve(stream)
        },
      }
      this.connections.set(id, connection)
      this.perNode.set(nodeId, (this.perNode.get(nodeId) ?? 0) + 1)
      owner.addEventListener('abort', abort, { once: true })
      void this.track(this.channels.requestService(nodeId, id, this.release, connection.fail, owner).then(request => {
        if (connection.finished) request.dispose()
        else { connection.lease = request.lease; connection.request = request }
      }, connection.fail))
    })
  }

  /**
   * Recheck an idle transport's exact credential and connection lease before another HTTP request.
   * @param stream - previously admitted service transport.
   * @returns after current center authority accepts the same node connection and epoch.
   */
  revalidate(stream: Duplex): Promise<void> {
    const connection = this.streamOwners.get(stream)
    if (connection === undefined || connection.finished || connection.lease === undefined || connection.credential === undefined
      || this.lifetime.signal.aborted || this.paused.has(connection.nodeId)) return Promise.reject(new NodeServiceError(503, 'node-service/unavailable'))
    const expected = connection.lease, credential = connection.credential
    return this.track((async () => {
      try {
        const lease = await this.authority.authorizeChannel(credential, { connectionId: expected.connectionId, epoch: expected.epoch })
        if (connection.finished || stream.destroyed || lease.nodeId !== connection.nodeId || lease.organizationId !== expected.organizationId
          || lease.connectionId !== expected.connectionId || lease.epoch !== expected.epoch) throw new NodeServiceError(503, 'node-service/unavailable')
      } catch (error) {
        connection.fail(error)
        throw error
      }
    })())
  }

  /**
   * Wait for a service stream's physical WebSocket closure and connection-budget release.
   * @param stream - previously admitted service transport.
   * @returns after the transport owner has released its connection credit.
   */
  released(stream: Duplex): Promise<void> {
    const connection = this.streamOwners.get(stream)
    if (connection?.closed === undefined) throw new Error('Unknown node service transport')
    return connection.closed
  }

  /**
   * Exclude new streams while a computer exits managed execution.
   * @param nodeId - reviewed computer; active or pending streams refuse detachment.
   * @returns disposer reopening transport admission; database policy still controls eligibility.
   */
  pauseIdle(nodeId: RuntimeNodeId): () => void {
    if (this.paused.has(nodeId) || (this.perNode.get(nodeId) ?? 0) !== 0) throw new NodeServiceError(409, 'node-service/busy')
    this.paused.add(nodeId)
    return () => { this.paused.delete(nodeId) }
  }

  /**
   * Match a one-use node-created stream to its pending target and exact connection lease.
   * @param request - outbound node upgrade with its credential and lease headers.
   * @param socket - HTTP listener-owned stream.
   * @param head - parser-owned upgrade prefix.
   * @returns after adopting the socket, or throws a declared pre-upgrade refusal.
   */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const id = new URL(request.url ?? '/', 'http://node-control').pathname.slice(NODE_SERVICE_STREAM_PATH.length)
    const connection = this.connections.get(id as NodeProbeId)
    if (this.lifetime.signal.aborted) return Promise.reject(new NodeServiceError(503, 'node-service/closed'))
    if (connection === undefined || connection.finished || connection.socket !== undefined || connection.lease === undefined) {
      return Promise.reject(new NodeServiceError(404, 'node-service/unavailable'))
    }
    if (request.method !== 'GET' || request.headers['sec-websocket-protocol'] !== NODE_SERVICE_STREAM_PROTOCOL) {
      return Promise.reject(new NodeServiceError(400, 'node-service/invalid-target'))
    }
    const bearer = request.headers.authorization
    if (typeof bearer !== 'string' || !/^Bearer dsh_node_[A-Za-z0-9_-]+$/u.test(bearer)) return Promise.reject(new NodeAccessError(401, 'node-access/unauthorized'))
    if (this.checking >= this.config.maxConnections) return Promise.reject(new NodeServiceError(503, 'node-service/busy'))
    this.checking += 1
    return this.track((async () => {
      try {
        const lease = await this.authority.authorizeChannel(bearer.slice(7), {
          connectionId: request.headers[NODE_CONNECTION_HEADER], epoch: request.headers[NODE_EPOCH_HEADER],
        })
        const expected = connection.lease!
        if (lease.nodeId !== connection.nodeId || lease.organizationId !== expected.organizationId
          || lease.connectionId !== expected.connectionId || lease.epoch !== expected.epoch) throw new NodeAccessError(409, 'node-access/lease-lost')
        if (connection.finished || connection.socket !== undefined || socket.destroyed || this.lifetime.signal.aborted) {
          throw new NodeServiceError(409, 'node-service/cancelled')
        }
        connection.credential = bearer.slice(7)
        this.server.handleUpgrade(request, socket, head, ws => { connection.accept(ws, request.socket) })
      } finally { this.checking -= 1 }
    })())
  }

  /**
   * Close every transport belonging to a revoked or replaced node connection.
   * @param nodeId - affected computer identity.
   */
  revoke(nodeId: RuntimeNodeId): void {
    for (const connection of this.connections.values()) {
      if (connection.nodeId === nodeId) connection.fail(new NodeServiceError(503, 'node-service/unavailable'))
    }
  }

  /**
   * Stop admission and await acquired sockets and lease-verification work.
   * @returns one shared quiescent shutdown completion.
   */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.lifetime.abort()
      for (const connection of this.connections.values()) connection.fail(new NodeServiceError(503, 'node-service/closed'))
      await Promise.allSettled([...this.work, ...this.sockets.values()])
      await new Promise<void>((resolve, reject) => { this.server.close(error => { if (error) reject(error); else resolve() }) })
    })()
  }
}
