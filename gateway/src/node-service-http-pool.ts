/** Bounded HTTP keep-alive ownership over independent node-service streams. */
import { Agent } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import type { GatewayNodeServices, NodeServiceConfig } from './node-service.ts'
import { NodeServiceError } from './node-service-stream.ts'

/**
 * Supply HTTP Agent socket operations using this service stream's own WebSocket transport.
 * @param stream - HTTP byte stream, independent of the node control channel.
 * @param transport - socket admitted for this exact service-stream upgrade.
 * @returns the same stream with real transport reference, timeout and TCP controls.
 */
export function nodeServiceHttpSocket(stream: Duplex, transport: Socket): Duplex {
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
  stream?: Duplex
  agent?: Agent
  idle?: ReturnType<typeof setTimeout>
  closed?: Promise<void>
}

/** A request exclusively borrows one HTTP/1 connection; release follows complete response consumption. */
export interface NodeServiceHttpLease {
  agent: Agent
  /** Return a completely consumed response connection to its bounded idle owner. */
  release(): void
  /** Close this request's connection after cancellation, refusal or incomplete response. */
  destroy(): void
}

/** Request authorization remains with both Gateways; only byte connections are retained. */
export class NodeServiceHttpPool {
  private readonly entries = new Set<Entry>()
  private readonly openings = new Set<Promise<NodeServiceHttpLease>>()
  private readonly transports = new Map<Entry, Promise<void>>()
  private closed = false
  private closing?: Promise<void>
  private revision = 0
  private readonly waiters = new Set<() => void>()

  /**
   * @param services - existing global/per-computer connection admission and lease owner.
   * @param config - validated idle retention bounds; active streams retain the existing service limits.
   */
  constructor(private readonly services: Pick<GatewayNodeServices, 'open' | 'revalidate' | 'released' | 'capacity'>,
    private readonly config: NodeServiceConfig) {}

  /**
   * Borrow a matching idle connection or open one without replaying an HTTP request.
   * @param nodeId - currently authorized exact computer.
   * @param signal - request cancellation; it owns only its borrowed or opening connection.
   * @returns an exclusive request lease.
   */
  acquire(nodeId: RuntimeNodeId, signal: AbortSignal): Promise<NodeServiceHttpLease> {
    const operation = this.acquireOrWait(nodeId, signal)
    this.openings.add(operation)
    void operation.then(() => { this.openings.delete(operation) }, () => { this.openings.delete(operation) })
    return operation
  }

  private async acquireOrWait(nodeId: RuntimeNodeId, signal: AbortSignal): Promise<NodeServiceHttpLease> {
    let deadline: number | undefined
    for (;;) {
      if (deadline !== undefined && performance.now() >= deadline) throw new NodeServiceError(504, 'node-service/timeout')
      const observed = this.revision
      try { return await this.acquireNow(nodeId, signal) } catch (error) {
        if (!(error instanceof NodeServiceError) || error.code !== 'node-service/busy') throw error
        if (signal.aborted) throw new NodeServiceError(409, 'node-service/cancelled')
        if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
        if (observed !== this.revision) continue
        const pressure = this.services.capacity(nodeId)
        const releasable = [...this.entries, ...this.transports.keys()].some(entry =>
          (entry.busy || entry.owner.signal.aborted) && (pressure === 'global' || entry.nodeId === nodeId))
        if (!releasable) throw error
        deadline ??= performance.now() + this.config.httpQueueTimeoutMs
        await this.waitForChange(observed, signal, deadline)
      }
    }
  }

  private changed(): void {
    this.revision++
    for (const wake of [...this.waiters]) wake()
  }

  private waitForChange(observed: number, signal: AbortSignal, deadline: number): Promise<void> {
    if (observed !== this.revision) return Promise.resolve()
    if (this.waiters.size >= this.config.httpMaxPendingRequests) return Promise.reject(new NodeServiceError(503, 'node-service/busy'))
    const remaining = deadline - performance.now()
    if (remaining <= 0) return Promise.reject(new NodeServiceError(504, 'node-service/timeout'))
    return new Promise<void>((resolve, reject) => {
      const finish = (error?: NodeServiceError): void => {
        this.waiters.delete(wake); clearTimeout(timer); signal.removeEventListener('abort', cancel)
        if (error === undefined) resolve()
        else reject(error)
      }
      const wake = (): void => { finish() }
      const cancel = (): void => { finish(new NodeServiceError(409, 'node-service/cancelled')) }
      const timer = setTimeout(() => { finish(new NodeServiceError(504, 'node-service/timeout')) }, remaining)
      timer.unref()
      this.waiters.add(wake)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
    })
  }

  private async acquireNow(nodeId: RuntimeNodeId, signal: AbortSignal): Promise<NodeServiceHttpLease> {
    if (this.closed) throw new NodeServiceError(503, 'node-service/closed')
    if (signal.aborted) throw new NodeServiceError(409, 'node-service/cancelled')
    for (const entry of this.entries) {
      if (entry.busy || entry.nodeId !== nodeId) continue
      if (entry.stream?.destroyed || entry.stream?.writableEnded) { this.destroy(entry); continue }
      clearTimeout(entry.idle); entry.idle = undefined; entry.busy = true
      const cancel = (): void => { this.destroy(entry) }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        if (entry.stream === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
        await this.services.revalidate(entry.stream)
        if (this.closed || signal.aborted || entry.owner.signal.aborted || entry.stream.destroyed) {
          throw new NodeServiceError(409, 'node-service/cancelled')
        }
        return this.borrow(entry)
      } catch (error) { this.destroy(entry); throw error }
      finally { signal.removeEventListener('abort', cancel) }
    }
    await this.makeRoom(nodeId, signal)
    if (this.closed || signal.aborted) throw new NodeServiceError(409, 'node-service/cancelled')
    const entry: Entry = { nodeId, owner: new AbortController(), busy: true }
    this.entries.add(entry)
    const cancel = (): void => { this.destroy(entry) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      const stream = await this.services.open(nodeId, entry.owner.signal)
      entry.stream = stream
      entry.closed = stream.closed ? Promise.resolve() : new Promise<void>(resolve => {
        stream.once('close', () => { this.destroy(entry); resolve() })
      })
      entry.closed = Promise.all([entry.closed, this.services.released(stream)]).then(() => {})
      this.transports.set(entry, entry.closed)
      void entry.closed.then(() => { this.transports.delete(entry); this.changed() })
      const agent = new Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1,
        timeout: this.config.httpIdleTimeoutMs })
      agent.createConnection = () => stream
      entry.agent = agent
      if (this.closed || signal.aborted || entry.owner.signal.aborted || stream.destroyed) {
        throw new NodeServiceError(409, 'node-service/cancelled')
      }
      return this.borrow(entry)
    } catch (error) {
      this.destroy(entry)
      throw error
    } finally { signal.removeEventListener('abort', cancel) }
  }

  private async makeRoom(nodeId: RuntimeNodeId, signal: AbortSignal): Promise<void> {
    for (;;) {
      const pressure = this.services.capacity(nodeId)
      if (pressure === 'available') return
      const selected = [...this.transports].find(([entry]) => !entry.busy && (pressure === 'global' || entry.nodeId === nodeId))
      if (selected === undefined) return
      const [idle, closed] = selected
      this.destroy(idle)
      let abort: () => void = () => {}
      try {
        await new Promise<void>((resolve, reject) => {
          abort = () => { reject(new NodeServiceError(409, 'node-service/cancelled')) }
          signal.addEventListener('abort', abort, { once: true })
          if (signal.aborted) abort()
          else void closed.then(resolve, reject)
        })
      } finally { signal.removeEventListener('abort', abort) }
    }
  }

  private borrow(entry: Entry): NodeServiceHttpLease {
    const agent = entry.agent
    if (agent === undefined) throw new NodeServiceError(503, 'node-service/unavailable')
    let released = false
    return { agent, destroy: () => { if (released) return; released = true; this.destroy(entry) }, release: () => {
      if (released) return
      released = true; entry.busy = false
      if (this.closed || entry.stream?.destroyed || entry.stream?.writableEnded) { this.destroy(entry); return }
      entry.idle = setTimeout(() => { this.destroy(entry) }, this.config.httpIdleTimeoutMs)
      entry.idle.unref()
      this.trimIdle(entry.nodeId)
      this.changed()
    } }
  }

  private trimIdle(nodeId: RuntimeNodeId): void {
    const idle = [...this.entries].filter(entry => !entry.busy)
    const own = idle.filter(entry => entry.nodeId === nodeId)
    for (const entry of own.slice(0, Math.max(0, own.length - this.config.httpMaxIdlePerNode))) this.destroy(entry)
    const remaining = idle.filter(entry => this.entries.has(entry))
    for (const entry of remaining.slice(0, Math.max(0, remaining.length - this.config.httpMaxIdleConnections))) this.destroy(entry)
  }

  private destroy(entry: Entry): void {
    const present = this.entries.delete(entry)
    clearTimeout(entry.idle); entry.idle = undefined
    entry.owner.abort()
    entry.stream?.destroy()
    entry.agent?.destroy()
    if (present && entry.stream !== undefined) this.changed()
  }

  /**
   * Drain retained idle transports before the existing node detachment fence.
   * @param nodeId - affected computer, or all computers when omitted.
   * @returns after the selected idle transports have actually closed.
   */
  async closeIdle(nodeId?: RuntimeNodeId): Promise<void> {
    const entries = [...this.transports].filter(([entry]) => !entry.busy && (nodeId === undefined || entry.nodeId === nodeId))
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
