/** Reuse bounded node-service transports for already approved peer repository requests. */
import { request, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import type { GatewayAccessMonitor } from './access-invalidation.ts'
import { NodeServiceHttpPool } from './node-service-http-pool.ts'
import type { GatewayNodeServices, NodeServiceConfig } from './node-service.ts'
import { NODE_SERVICE_TARGET_HEADER } from './node-service-stream.ts'
import type { RuntimeNodeId } from './runtime-catalog.ts'
import { PEER_REPOSITORY_PREFIX, PeerBackupError, type PeerRepositoryGrant } from './peer-backup-repository.ts'

const requestHeaders = ['authorization', 'accept', 'content-type', 'content-length', 'range'] as const
const responseHeaders = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'retry-after'] as const
interface Active {
  policyId: string
  source: string
  target: string
  abort: AbortController
}

/** Backup traffic owns at most two active transports and one reusable idle connection. */
export class PeerBackupRelay {
  private readonly pool: NodeServiceHttpPool
  private readonly active = new Set<Active>()
  private readonly pending = new Set<Promise<void>>()
  private readonly limit: number
  private readonly lifetime = new AbortController()
  private readonly unsubscribe?: () => void
  constructor(
    services: Pick<GatewayNodeServices, 'open' | 'revalidate' | 'released' | 'capacity'>,
    config: NodeServiceConfig,
    private readonly timeoutMs: number,
    monitor?: GatewayAccessMonitor,
  ) {
    this.limit = Math.max(0, Math.min(2, config.maxConnections - 1, config.maxPerNode - 1))
    this.pool = new NodeServiceHttpPool(services, {
      ...config,
      httpMaxIdleConnections: Math.min(config.httpMaxIdleConnections, 1),
      httpMaxIdlePerNode: Math.min(config.httpMaxIdlePerNode, 1),
      httpMaxPendingRequests: 1,
    })
    this.unsubscribe = monitor?.subscribe((subject) => {
      if (subject.userId !== undefined || subject.projectId !== undefined) return
      for (const entry of this.active) {
        if (!subject.nodeId || entry.target === subject.nodeId || entry.source === subject.nodeId) entry.abort.abort()
      }
      void this.pool.closeIdle(subject.nodeId)
    })
  }
  /** Reconfiguration stops the affected transmissions before a new credential/target is used. */
  invalidate(policyId: string): void {
    for (const entry of this.active) if (entry.policyId === policyId) entry.abort.abort()
  }
  /** Stream one repository request with backpressure and independent cancellation; never replay a partial operation. */
  forward = (req: IncomingMessage, res: ServerResponse, grant: PeerRepositoryGrant): Promise<void> => {
    const operation = this.forwardOne(req, res, grant)
    this.pending.add(operation)
    void operation.then(
      () => {
        this.pending.delete(operation)
      },
      () => {
        this.pending.delete(operation)
      },
    )
    return operation
  }
  private async forwardOne(req: IncomingMessage, res: ServerResponse, grant: PeerRepositoryGrant): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (
      !url.pathname.startsWith(PEER_REPOSITORY_PREFIX + grant.policyId + '/') ||
      (url.search && url.search !== '?create=true')
    ) {
      throw new PeerBackupError(403, 'peer-backup/relay-denied')
    }
    if (this.lifetime.signal.aborted || this.active.size >= this.limit)
      throw new PeerBackupError(503, 'peer-backup/relay-capacity')
    const entry = {
      policyId: grant.policyId,
      source: grant.sourceNodeId,
      target: grant.targetNodeId,
      abort: new AbortController(),
    }
    const signal = AbortSignal.any([entry.abort.signal, this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)])
    const cancel = (): void => {
      if (!res.writableFinished) entry.abort.abort()
    }
    this.active.add(entry)
    req.once('aborted', cancel)
    res.once('close', cancel)
    try {
      await grant.revalidate()
      const lease = await this.pool.acquire(grant.targetNodeId as RuntimeNodeId, signal)
      let complete = false
      try {
        await grant.revalidate()
        signal.throwIfAborted()
        const headers: OutgoingHttpHeaders = { [NODE_SERVICE_TARGET_HEADER]: grant.targetNodeId }
        for (const name of requestHeaders) if (req.headers[name] !== undefined) headers[name] = req.headers[name]
        const outgoing = request({
          hostname: 'node.gateway.invalid',
          port: 80,
          method: req.method,
          path: url.pathname + url.search,
          headers,
          agent: lease.agent,
          signal,
        })
        const received = new Promise<void>((ok, fail) => {
          let responded = false
          outgoing.once('error', fail)
          outgoing.once('close', () => {
            if (!responded) fail(new PeerBackupError(503, 'peer-backup/relay-closed'))
          })
          outgoing.once('response', (upstream) => {
            responded = true
            if (upstream.headers[NODE_SERVICE_TARGET_HEADER] !== grant.targetNodeId) {
              upstream.destroy()
              fail(new PeerBackupError(409, 'peer-backup/wrong-receiver'))
              return
            }
            const downstream: OutgoingHttpHeaders = { 'cache-control': 'no-store' }
            for (const name of responseHeaders)
              if (upstream.headers[name] !== undefined) downstream[name] = upstream.headers[name]
            res.writeHead(upstream.statusCode ?? 502, downstream)
            void pipeline(upstream, res, { signal }).then(ok, fail)
          })
        })
        const sent = pipeline(req, outgoing, { signal })
        try {
          await Promise.all([sent, received])
          complete = true
        } finally {
          if (!complete) {
            outgoing.destroy()
            entry.abort.abort()
            await Promise.allSettled([sent, received])
          }
        }
      } finally {
        if (complete) lease.release()
        else lease.destroy()
      }
    } finally {
      req.off('aborted', cancel)
      res.off('close', cancel)
      this.active.delete(entry)
    }
  }
  /** Abort all requests and join their transport disposal. */
  async close(): Promise<void> {
    this.lifetime.abort()
    this.unsubscribe?.()
    await this.pool.close()
    await Promise.allSettled(this.pending)
  }
}
