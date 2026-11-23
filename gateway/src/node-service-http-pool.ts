/** Bounded HTTP keep-alive ownership over independent node-service streams. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Agent } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import type { GatewayNodeServices, NodeServiceConfig } from './node-service.ts'
import { NodeServiceError } from './node-service-stream.ts'
import { operationPhase, timeOperation } from './operation-timing.ts'

/**
 * Supply HTTP Agent socket operations using this service stream's own WebSocket transport.
 * @param stream - HTTP byte stream, independent of the node control channel.
 * @param transport - socket admitted for this exact service-stream upgrade.
 * @returns the same stream with real transport reference, timeout and TCP controls.
 */
export function nodeServiceHttpSocket(stream: Duplex, transport: Socket): Duplex {
  // Disable Nagle on the underlying node-service TCP socket so small interactive RPCs flush immediately.
  transport.setNoDelay(true)
  const timeout = (): void => { stream.emit('timeout') }
  transport.on('timeout', timeout)
  stream.once('close', () => { transport.removeListener('timeout', timeout) })
  return Object.defineProperties(stream, {
    timeout: { get: () => transport.timeout },
    ref: { value: () => { transport.ref(); return stream } },
    unref: { value: () => { transport.unref(); return stream } },
    setKeepAlive: { value: (enabled?: boolean, delay?: number) => { transport.setKeepAlive(enabled, delay); return stream } },
    setNoDelay: { value: (enabled?: boolean) => { transport.setNoDelay(enabled); return stream } },
    setTimeout: { value: (milliseconds: number, callback?: () => void) => {
      if (callback !== undefined) {
        if (milliseconds === 0) stream.removeListener('timeout', callback)
        else stream.once('timeout', callback)
      }
      transport.setTimeout(milliseconds)
      return stream
    } },
  })
}

interface Entry {
  nodeId: RuntimeNodeId
  owner: AbortController
  busy: boolean
  interactive: boolean
  stream?: Duplex
  agent?: Agent
  idle?: ReturnType<typeof setTimeout>
}

interface Acquisition {
  revision: number
  operation: Promise<NodeServiceHttpLease>
}

interface PendingAcquisition {
  nodeId: RuntimeNodeId
  interactive: boolean
  grant(): void
  reject(error: NodeServiceError): void
}

/** A request exclusively borrows one HTTP/1 connection; release follows complete response consumption. */
export interface NodeServiceHttpLease {
  agent: Agent
  /** This request borrowed an existing idle transport. */
  reused: boolean
  /** Return a completely consumed response connection to its bounded idle owner. */
  release(): void
  /** Close this request's connection after cancellation, refusal or incomplete response. */
  destroy(): void
}

/** Identifier-free cumulative counters and live occupancy for pooled node HTTP transports. */
export interface NodeServiceHttpPoolDiagnostics {
  readonly reused: number
  readonly opened: number
  readonly queued: number
  readonly revalidateCalls: number
  readonly revalidateSkipped: number
  readonly idleInvalidationsGlobal: number
  readonly idleInvalidationsNode: number
  readonly closedIdleEntries: number
  readonly active: number
  readonly idle: number
  readonly waiting: number
}

/** Request authorization remains with both Gateways; only byte connections are retained. */
export class NodeServiceHttpPool {
  private readonly entries = new Set<Entry>()
  private readonly openings = new Set<Promise<NodeServiceHttpLease>>()
  private readonly transports = new Map<Entry, Promise<void>>()
  private closed = false
  private closing?: Promise<void>
  private revision = 0
  private readonly waiters = new Set<PendingAcquisition>()
  private readonly waitingByNode = new Map<RuntimeNodeId, number>()
  private metrics = {
    reused: 0, opened: 0, queued: 0, revalidateCalls: 0,
    idleInvalidationsGlobal: 0, idleInvalidationsNode: 0, closedIdleEntries: 0,
  }

  /**
   * @param services - existing global/per-computer connection admission and lease owner.
   * @param config - validated idle retention and waiting request limits.
   */
  constructor(private readonly services: Pick<GatewayNodeServices, 'open' | 'revalidate' | 'released' | 'capacity'>,
    private readonly config: NodeServiceConfig) {}

  /**
   * Borrow a matching idle connection or open one without replaying an HTTP request.
   * @param nodeId - currently authorized exact computer.
   * @param signal - request cancellation; it owns only its borrowed or opening connection.
   * @param interactive - retain one eligible transport for prepared conversation operations on this node.
   * @returns an exclusive request lease.
   */
  acquire(nodeId: RuntimeNodeId, signal: AbortSignal, interactive = false): Promise<NodeServiceHttpLease> {
    const operation = this.acquireOrWait(nodeId, signal, interactive)
    this.openings.add(operation)
    void operation.then(() => { this.openings.delete(operation) }, () => { this.openings.delete(operation) })
    return operation
  }

  private async acquireOrWait(nodeId: RuntimeNodeId, signal: AbortSignal, interactive: boolean): Promise<NodeServiceHttpLease> {
    let deadline: number | undefined
    let busyRevision: number | undefined
    for (;;) {
      if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
      if (signal.aborted) throw new NodeServiceError(409, 'node-service/cancelled')
      if (deadline !== undefined && performance.now() >= deadline) throw new NodeServiceError(504, 'node-service/timeout')
      this.dispatch()
      let grant = busyRevision === this.revision ? undefined : this.tryAcquire(nodeId, signal, interactive)
      if (grant === undefined) {
        deadline ??= performance.now() + this.config.httpQueueTimeoutMs
        grant = await this.waitForGrant(nodeId, signal, interactive, deadline, busyRevision)
      }
      try { return await grant.operation } catch (error) {
        if (!(error instanceof NodeServiceError) || error.code !== 'node-service/busy') throw error
        busyRevision = grant.revision
      }
    }
  }

  private changed(): void {
    this.revision++
    this.dispatch()
  }

  private dispatch(): void {
    if (this.closed) {
      for (const waiter of this.waiters) waiter.reject(new NodeServiceError(503, 'node-service/closed'))
      return
    }
    for (const waiter of this.waiters) if (waiter.interactive) waiter.grant()
    for (const waiter of this.waiters) if (!waiter.interactive) waiter.grant()
    if (this.waiters.size === 0 || [...this.transports.keys()].some(entry => !this.entries.has(entry))) return
    for (const waiter of this.waiters) {
      if (this.services.capacity(waiter.nodeId) !== 'global') continue
      const idle = [...this.entries].filter(entry => !entry.busy && this.transports.has(entry))
      const evict = idle.find(entry => !entry.interactive) ?? idle[0]
      if (evict !== undefined) this.destroy(evict)
      break
    }
  }

  private waitForGrant(nodeId: RuntimeNodeId, signal: AbortSignal, interactive: boolean, deadline: number, busyRevision?: number): Promise<Acquisition> {
    const pressure = this.services.capacity(nodeId)
    const releasable = [...this.entries, ...this.transports.keys()].some(entry =>
      pressure === 'global' || entry.nodeId === nodeId && (interactive || !entry.interactive) && (entry.busy || entry.owner.signal.aborted))
    if (!releasable) return Promise.reject(new NodeServiceError(503, 'node-service/busy'))
    const waitingOnNode = this.waitingByNode.get(nodeId) ?? 0
    if (this.waiters.size >= this.config.httpMaxPendingRequests || waitingOnNode >= this.config.httpMaxPendingPerNode) {
      return Promise.reject(new NodeServiceError(503, 'node-service/busy'))
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) return Promise.reject(new NodeServiceError(504, 'node-service/timeout'))
    const stopWaiting = operationPhase('nodeQueue')
    return new Promise<Acquisition>((resolve, reject) => {
      const finish = (): void => {
        if (!this.waiters.delete(waiter)) return
        const remainingOnNode = this.waitingByNode.get(nodeId)! - 1
        if (remainingOnNode === 0) this.waitingByNode.delete(nodeId)
        else this.waitingByNode.set(nodeId, remainingOnNode)
        clearTimeout(timer); signal.removeEventListener('abort', cancel)
        stopWaiting()
      }
      const waiter: PendingAcquisition = {
        nodeId, interactive,
        grant: AsyncLocalStorage.bind(() => {
          if (signal.aborted) { cancel(); return }
          if (performance.now() >= deadline) { waiter.reject(new NodeServiceError(504, 'node-service/timeout')); return }
          if (busyRevision === this.revision) return
          const grant = this.tryAcquire(nodeId, signal, interactive)
          if (grant !== undefined) { finish(); resolve(grant) }
        }),
        reject: error => { finish(); reject(error) },
      }
      const cancel = (): void => { waiter.reject(new NodeServiceError(409, 'node-service/cancelled')) }
      const timer = setTimeout(() => { waiter.reject(new NodeServiceError(504, 'node-service/timeout')) }, remaining)
      timer.unref()
      this.waiters.add(waiter)
      this.metrics.queued += 1
      this.waitingByNode.set(nodeId, waitingOnNode + 1)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      else this.dispatch()
    })
  }

  private tryAcquire(nodeId: RuntimeNodeId, signal: AbortSignal, interactive: boolean): Acquisition | undefined {
    const revision = this.revision
    let reserved: Entry | undefined, ordinary: Entry | undefined
    for (const entry of this.entries) {
      if (entry.nodeId !== nodeId) continue
      if (!entry.busy && (entry.stream?.destroyed || entry.stream?.writableEnded)) { this.destroy(entry); continue }
      if (entry.interactive) { reserved = entry; continue }
      if (!entry.busy && ordinary === undefined) ordinary = entry
    }
    const available = interactive && reserved?.busy === false ? reserved : ordinary
    const reserve = interactive && reserved === undefined && this.config.maxPerNode > 1 && this.config.maxConnections > 1
    if (available !== undefined) {
      if (reserve) available.interactive = true
      return { revision, operation: this.reuse(available, signal) }
    }
    if (this.services.capacity(nodeId) === 'available') return { revision, operation: this.open(nodeId, signal, reserve) }
  }

  private async reuse(entry: Entry, signal: AbortSignal): Promise<NodeServiceHttpLease> {
    clearTimeout(entry.idle); entry.idle = undefined; entry.busy = true
    const cancel = (): void => { this.destroy(entry) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const stream = entry.stream
      if (stream === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
      this.metrics.revalidateCalls += 1
      await timeOperation('nodeLeaseCheck', () => this.services.revalidate(stream))
      if (this.closed || signal.aborted || entry.owner.signal.aborted || stream.destroyed) {
        throw new NodeServiceError(409, 'node-service/cancelled')
      }
      return this.borrow(entry, true)
    } catch (error) { this.destroy(entry); throw error }
    finally { signal.removeEventListener('abort', cancel) }
  }

  private async open(nodeId: RuntimeNodeId, signal: AbortSignal, interactive: boolean): Promise<NodeServiceHttpLease> {
    const entry: Entry = { nodeId, owner: new AbortController(), busy: true, interactive }
    this.entries.add(entry)
    const cancel = (): void => { this.destroy(entry) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const stream = await timeOperation('nodeServiceOpen', () => this.services.open(nodeId, entry.owner.signal))
      entry.stream = stream
      const streamClosed = stream.closed ? Promise.resolve() : new Promise<void>(resolve => {
        stream.once('close', () => { this.destroy(entry); resolve() })
      })
      const closed = Promise.all([streamClosed, this.services.released(stream)]).then(() => {})
      this.transports.set(entry, closed)
      void closed.then(() => { this.transports.delete(entry); this.changed() })
      const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1,
        timeout: this.config.httpIdleTimeoutMs })
      agent.createConnection = () => stream
      entry.agent = agent
      if (this.closed || signal.aborted || entry.owner.signal.aborted || stream.destroyed) {
        throw new NodeServiceError(409, 'node-service/cancelled')
      }
      return this.borrow(entry, false)
    } catch (error) {
      this.destroy(entry)
      if (entry.stream === undefined) this.dispatch()
      throw error
    }
    finally { signal.removeEventListener('abort', cancel) }
  }

  private borrow(entry: Entry, reused: boolean): NodeServiceHttpLease {
    const agent = entry.agent
    if (agent === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
    if (reused) this.metrics.reused += 1
    else this.metrics.opened += 1
    let released = false
    return { agent, reused, destroy: () => { if (released) return; released = true; this.destroy(entry) }, release: () => {
      if (released) return
      released = true; entry.busy = false
      if (this.closed || entry.stream?.destroyed || entry.stream?.writableEnded) { this.destroy(entry); return }
      entry.idle = setTimeout(() => { this.destroy(entry) }, this.config.httpIdleTimeoutMs)
      entry.idle.unref()
      this.changed()
      this.trimIdle(entry.nodeId)
    } }
  }

  private trimIdle(nodeId: RuntimeNodeId): void {
    const idle = [...this.entries].filter(entry => !entry.busy).sort((a, b) => Number(a.interactive) - Number(b.interactive))
    const own = idle.filter(entry => entry.nodeId === nodeId)
    for (const entry of own.slice(0, Math.max(0, own.length - this.config.httpMaxIdlePerNode))) this.destroy(entry)
    const remaining = idle.filter(entry => this.entries.has(entry))
    for (const entry of remaining.slice(0, Math.max(0, remaining.length - this.config.httpMaxIdleConnections))) this.destroy(entry)
  }

  private destroy(entry: Entry): void {
    this.entries.delete(entry)
    clearTimeout(entry.idle); entry.idle = undefined
    entry.owner.abort()
    entry.stream?.destroy()
    entry.agent?.destroy()
  }

  /**
   * Read cumulative pool counts and live occupancy without retaining node identifiers.
   * @returns Identifier-free transport reuse, opening, queueing and invalidation diagnostics.
   */
  diagnostics(): NodeServiceHttpPoolDiagnostics {
    let active = 0
    let idle = 0
    for (const entry of this.entries) {
      if (entry.busy) active += 1
      else idle += 1
    }
    return { ...this.metrics, revalidateSkipped: 0, active, idle, waiting: this.waiters.size }
  }

  /**
   * Drain retained idle transports before the existing node detachment fence.
   * @param nodeId - affected computer, or all computers when omitted.
   * @returns after the selected idle transports have actually closed.
   */
  async closeIdle(nodeId?: RuntimeNodeId): Promise<void> {
    if (nodeId === undefined) this.metrics.idleInvalidationsGlobal += 1
    else this.metrics.idleInvalidationsNode += 1
    const entries = [...this.transports].filter(([entry]) => !entry.busy && (nodeId === undefined || entry.nodeId === nodeId))
    this.metrics.closedIdleEntries += entries.length
    for (const [entry] of entries) this.destroy(entry)
    await Promise.all(entries.map(([, closed]) => closed))
  }

  /** Stop admission and await opening and established service transports. @returns after all owned transports settle. */
  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true
      this.changed()
      const entries = [...this.entries]
      for (const entry of entries) this.destroy(entry)
      await Promise.allSettled([...this.openings])
      await Promise.all(this.transports.values())
    })()
  }
}
