/** Center-owned node control channels; probes and service requests share authenticated lease ownership. */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { UserRow } from './auth.ts'
import { NodeAccessError, type NodeLease } from './node-access.ts'
import {
  NODE_CHANNEL_PROTOCOL, NODE_CONNECTION_HEADER, NODE_EPOCH_HEADER, NodeChannelError, nodeChannelReplySchema,
  type NodeChannelConfig, type NodeProbeId, type NodeProbeInfo, type NodeProbeResult,
} from './node-channel-protocol.ts'
import { parseNodeChannelFrame, sendNodeChannelFrame } from './node-channel-wire.ts'
import type { PostgresNodeAccessService } from './postgres/node-access-service.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import { NodeServiceError } from './node-service-stream.ts'
import type { NodeServiceChannels, NodeServiceRequest } from './node-service.ts'

type Authority = Pick<PostgresNodeAccessService, 'authorizeChannel' | 'authorizeAdministratorNode'>
interface Pending {
  actor: UserRow
  validating: boolean
  finish(error: unknown, info?: NodeProbeInfo): void
}
interface Peer {
  socket: WebSocket
  token: string
  lease: NodeLease
  pending: Map<NodeProbeId, Pending>
  services: Map<NodeProbeId, (error: unknown) => void>
  closed: Promise<void>
  disposed: boolean
  expiry?: ReturnType<typeof setTimeout>
}

function cancelled(signal: AbortSignal): NodeChannelError {
  return new NodeChannelError(signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 504 : 409,
    signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'node-channel/timeout' : 'node-channel/cancelled')
}

function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled(signal))
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(cancelled(signal)) }
    signal.addEventListener('abort', abort, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** A channel owner for one center organization; discovery reads never invoke this service. */
export class GatewayNodeChannels implements NodeServiceChannels {
  private readonly server: WebSocketServer
  private readonly peers = new Map<RuntimeNodeId, Peer>()
  private readonly sockets = new Set<Peer>()
  private readonly perNode = new Map<string, number>()
  private readonly work = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private opening = 0
  private inFlight = 0
  private checking = 0
  private closing?: Promise<void>

  /**
   * @param authority - current organization, administrator and exact node-lease authority.
   * @param config - validated admission, deadline and byte budgets.
   */
  constructor(private readonly authority: Authority, private readonly config: NodeChannelConfig) {
    this.server = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: config.maxFrameBytes })
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.work.add(operation)
    void operation.then(() => { this.work.delete(operation) }, () => { this.work.delete(operation) })
    return operation
  }

  private async check<T>(operation: () => Promise<T>): Promise<T> {
    if (this.checking >= this.config.maxInFlight) throw new NodeChannelError(503, 'node-channel/busy')
    this.checking += 1
    try { return await operation() } finally { this.checking -= 1 }
  }

  private drop(peer: Peer, error: unknown): void {
    if (peer.disposed) return
    peer.disposed = true
    clearTimeout(peer.expiry)
    if (this.peers.get(peer.lease.nodeId) === peer) this.peers.delete(peer.lease.nodeId)
    for (const pending of [...peer.pending.values()]) pending.finish(error)
    for (const fail of [...peer.services.values()]) fail(error)
    peer.services.clear()
    peer.socket.terminate()
  }

  private async validate(peer: Peer): Promise<NodeLease> {
    const lease = await this.check(() => this.authority.authorizeChannel(peer.token, { connectionId: peer.lease.connectionId, epoch: peer.lease.epoch }))
      .catch((error: unknown) => {
        if (error instanceof NodeAccessError && (error.status === 401 || error.status === 409)) {
          this.drop(peer, error)
          throw new NodeChannelError(503, 'node-channel/disconnected', error)
        }
        throw error
      })
    if (peer.disposed || this.peers.get(lease.nodeId) !== peer || lease.nodeId !== peer.lease.nodeId
      || lease.organizationId !== peer.lease.organizationId || lease.connectionId !== peer.lease.connectionId || lease.epoch !== peer.lease.epoch) {
      throw new NodeAccessError(409, 'node-access/lease-lost')
    }
    return lease
  }

  private armExpiry(peer: Peer, lease: NodeLease): void {
    if (peer.disposed) return
    peer.lease = lease
    clearTimeout(peer.expiry)
    peer.expiry = setTimeout(() => {
      void this.track(this.validate(peer).then(current => { this.armExpiry(peer, current) })
        .catch(error => { this.drop(peer, error) }))
    }, Math.max(1, Math.min(2_147_483_647, Date.parse(lease.expiresAt) - Date.now())))
    peer.expiry.unref()
  }

  /**
   * Authenticate an outbound upgrade before admitting the WebSocket.
   * @param request - upgrade with the node bearer, exact connection/epoch headers and versioned subprotocol.
   * @param socket - listener-owned stream; the caller writes declared HTTP refusals before upgrade.
   * @param head - upgrade bytes already read by Node's HTTP parser.
   * @returns after the socket is adopted; capacity refusals never queue or replace an existing peer.
   */
  accept(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (this.lifetime.signal.aborted) return Promise.reject(new NodeChannelError(503, 'node-channel/closed'))
    const bearer = request.headers.authorization
    if (typeof bearer !== 'string' || !/^Bearer dsh_node_[A-Za-z0-9_-]+$/u.test(bearer)) {
      return Promise.reject(new NodeAccessError(401, 'node-access/unauthorized'))
    }
    if (request.method !== 'GET' || request.headers['sec-websocket-protocol'] !== NODE_CHANNEL_PROTOCOL) {
      return Promise.reject(new NodeChannelError(400, 'node-channel/invalid-frame'))
    }
    if (this.opening >= this.config.maxInFlight) return Promise.reject(new NodeChannelError(503, 'node-channel/busy'))
    this.opening += 1
    return this.track((async () => {
      try {
        const token = bearer.slice(7)
        const lease = await this.check(() => this.authority.authorizeChannel(token, {
          connectionId: request.headers[NODE_CONNECTION_HEADER], epoch: request.headers[NODE_EPOCH_HEADER],
        }))
        if (this.lifetime.signal.aborted || socket.destroyed) throw new NodeChannelError(503, 'node-channel/closed')
        if (!this.peers.has(lease.nodeId) && this.peers.size >= this.config.maxConnections) throw new NodeChannelError(503, 'node-channel/busy')
        this.server.handleUpgrade(request, socket, head, ws => { this.attach(ws, token, lease) })
      } finally { this.opening -= 1 }
    })())
  }

  private attach(socket: WebSocket, token: string, lease: NodeLease): void {
    const previous = this.peers.get(lease.nodeId)
    if (previous !== undefined) this.drop(previous, new NodeChannelError(503, 'node-channel/disconnected'))
    const peer: Peer = { socket, token, lease, disposed: false, pending: new Map(), services: new Map(),
      closed: new Promise<void>(resolve => { socket.once('close', () => { resolve() }) }) }
    this.peers.set(lease.nodeId, peer)
    this.sockets.add(peer)
    socket.on('error', () => { this.drop(peer, new NodeChannelError(503, 'node-channel/disconnected')) })
    socket.once('close', () => { this.sockets.delete(peer); this.drop(peer, new NodeChannelError(503, 'node-channel/disconnected')) })
    socket.on('message', (bytes, binary) => {
      if (peer.disposed) return
      try {
        const reply = parseNodeChannelFrame(bytes, binary, nodeChannelReplySchema)
        const service = peer.services.get(reply.id)
        if (service !== undefined) {
          if (reply.kind !== 'failure') throw new NodeChannelError(400, 'node-channel/invalid-frame')
          service(new NodeServiceError(503, reply.error === 'busy' ? 'node-service/busy' : 'node-service/unavailable'))
          return
        }
        const pending = peer.pending.get(reply.id)
        if (pending === undefined || pending.validating) return
        pending.validating = true
        void this.track((async () => {
          try {
            const current = await this.validate(peer)
            await this.check(() => this.authority.authorizeAdministratorNode(pending.actor, peer.lease.nodeId))
            this.armExpiry(peer, current)
            if (reply.kind === 'result') pending.finish(undefined, reply.info)
            else pending.finish(new NodeChannelError(503, reply.error === 'busy' ? 'node-channel/busy' : 'node-channel/probe-failed'))
          } catch (error) { pending.finish(error); if (error instanceof NodeAccessError && error.status !== 403) this.drop(peer, error) }
        })())
      } catch (error) { this.drop(peer, error) }
    })
    this.armExpiry(peer, lease)
    try { sendNodeChannelFrame(socket, { ...lease, kind: 'ready', channelVersion: 1 }, this.config) }
    catch (error) { this.drop(peer, error) }
  }

  /**
   * Request a bounded read-only node observation after current administrator and lease authorization.
   * @param actor - administrator candidate; authority is rechecked before dispatch and before returning the reply.
   * @param nodeId - untrusted node UUID; an absent channel never falls back to another node.
   * @param signal - request owner cancellation; cancellation and timeout send a best-effort cancel frame.
   * @returns the observation, with no retry and no runtime launch or durable mutation.
   */
  probe(actor: UserRow, nodeId: string, signal: AbortSignal): Promise<NodeProbeResult> {
    if (this.lifetime.signal.aborted) return Promise.reject(new NodeChannelError(503, 'node-channel/closed'))
    const count = this.perNode.get(nodeId) ?? 0
    if (this.inFlight >= this.config.maxInFlight || count >= this.config.maxPerNode) return Promise.reject(new NodeChannelError(503, 'node-channel/busy'))
    const deadline = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.requestTimeoutMs)])
    this.inFlight += 1; this.perNode.set(nodeId, count + 1)
    const operation = this.track(this.dispatch(actor, nodeId, deadline).finally(() => {
      this.inFlight -= 1
      const remaining = this.perNode.get(nodeId)! - 1
      if (remaining === 0) this.perNode.delete(nodeId); else this.perNode.set(nodeId, remaining)
    }))
    return untilAbort(operation, deadline)
  }

  private async dispatch(actor: UserRow, rawId: string, signal: AbortSignal): Promise<NodeProbeResult> {
    const id = await this.check(() => this.authority.authorizeAdministratorNode(actor, rawId))
    if (signal.aborted) throw cancelled(signal)
    const peer = this.peers.get(id)
    if (peer === undefined) throw new NodeChannelError(503, 'node-channel/not-connected')
    this.armExpiry(peer, await this.validate(peer))
    if (signal.aborted) throw cancelled(signal)
    return new Promise<NodeProbeResult>((resolve, reject) => {
      const requestId = randomUUID() as NodeProbeId
      const abort = () => {
        pending.finish(cancelled(signal))
        try { sendNodeChannelFrame(peer.socket, { kind: 'cancel', id: requestId }, this.config) }
        catch (error) { this.drop(peer, error) }
      }
      const pending: Pending = { actor, validating: false, finish: (error, info) => {
        if (!peer.pending.delete(requestId)) return
        signal.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve({ nodeId: peer.lease.nodeId, connectionId: peer.lease.connectionId, epoch: peer.lease.epoch, info: info! })
      } }
      peer.pending.set(requestId, pending)
      signal.addEventListener('abort', abort, { once: true })
      try { sendNodeChannelFrame(peer.socket, { kind: 'probe', id: requestId }, this.config) }
      catch (error) { pending.finish(error); this.drop(peer, error) }
    })
  }

  /**
   * Ask an enrolled computer to connect its fixed local Gateway to a one-use stream.
   * @param nodeId - target already authorized by the caller's existing account or Admin route.
   * @param id - service owner's one-use connection identity.
   * @param release - center release required by the node-local identity check.
   * @param failed - connection owner notified on refusal, revocation or control-channel loss.
   * @param signal - owning request lifetime.
   * @returns the exact lease and a disposer that cancels only this connection.
   */
  async requestService(nodeId: RuntimeNodeId, id: NodeProbeId, release: string | null,
    failed: (error: unknown) => void, signal: AbortSignal): Promise<NodeServiceRequest> {
    if (this.lifetime.signal.aborted) throw new NodeServiceError(503, 'node-service/closed')
    const peer = this.peers.get(nodeId)
    if (peer === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
    const lease = await this.track(this.validate(peer))
    this.armExpiry(peer, lease)
    signal.throwIfAborted()
    peer.services.set(id, failed)
    const dispose = () => {
      if (!peer.services.delete(id)) return
      try { sendNodeChannelFrame(peer.socket, { kind: 'cancel', id }, this.config) }
      catch (error) { this.drop(peer, error) }
    }
    try { sendNodeChannelFrame(peer.socket, { kind: 'service', id, release }, this.config) }
    catch (error) { dispose(); throw error }
    return { lease, dispose }
  }

  /**
   * Retire this node's local channel after a committed administrator credential change.
   * @param nodeId - affected canonical node identity.
   * @returns after pending probes are rejected; no lease, process or writer state is modified.
   */
  revoke(nodeId: RuntimeNodeId): void {
    const peer = this.peers.get(nodeId)
    if (peer !== undefined) this.drop(peer, new NodeAccessError(401, 'node-access/unauthorized'))
  }

  /**
   * Refuse admission, cancel probes and await sockets and owned authorization work before releasing PostgreSQL.
   * @returns after all work owned by this service has settled; repeated calls share that completion.
   */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.lifetime.abort()
      const peers = [...this.sockets]
      for (const peer of peers) this.drop(peer, new NodeChannelError(503, 'node-channel/closed'))
      await Promise.allSettled([...this.work, ...peers.map(peer => peer.closed)])
      await new Promise<void>((resolve, reject) => { this.server.close(error => { if (error) reject(error); else resolve() }) })
    })()
  }
}
