import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { ModelRegistrationEvent, UsageEvent } from './model-governance.ts'
import type { GatewayAuditService, GatewayModelGovernanceService } from './services.ts'
import type { GatewayPerformanceObserver } from './performance-observer.ts'
import { PostgresCheckoutQueueFullError } from './postgres/database.ts'

async function body(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const value = Buffer.from(chunk as Uint8Array); size += value.length; if (size > limit) throw new Error('body too large'); chunks.push(value) }
  return Buffer.concat(chunks).toString('utf8')
}

/** Maintenance fencing for the intake's write path. */
export interface UsageIntakeWrites {
  /** False while a maintenance window or restore closes writes. */
  open(): Promise<boolean>
  /** Run the request as a counted in-flight writer so quiesce waits for it. */
  track<T>(operation: () => Promise<T>): Promise<T>
}

/**
 * Create the private loopback-only, bearer-authenticated usage intake.
 * @param governance - Authenticates and persists usage records.
 * @param audit - Optional metadata-only audit sink.
 * @param writes - Optional maintenance and writer ownership.
 * @param performanceObserver - Shared observer disposed by its supplying owner after server closure.
 * @returns An unbound server whose caller owns listening and closure.
 */
export function createUsageIntakeServer(
  governance: GatewayModelGovernanceService,
  audit?: GatewayAuditService,
  writes?: UsageIntakeWrites,
  performanceObserver?: GatewayPerformanceObserver,
): Server {
  return createServer((req, res) => {
    performanceObserver?.observeResponse(res, 'internal')
    void (async () => {
    if (req.method !== 'POST' || req.url !== '/usage') { res.writeHead(404).end(); return }
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : ''
    const subject = token === '' ? null : await governance.subjectForIntakeToken(token)
    if (subject === null) { res.writeHead(401).end(); return }
    // The gate verdict is read inside the writer span: a heartbeat between
    // admission and the first write must already see this request counted.
    const ingest = async (): Promise<void> => {
      if (writes !== undefined && !(await writes.open())) {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"maintenance"}')
        return
      }
      const event = JSON.parse(await body(req)) as UsageEvent | ModelRegistrationEvent
      if (event !== null && typeof event === 'object' && 'kind' in event && event.kind === 'model-registration') {
        const result = await governance.ingestRegistration(subject, event as ModelRegistrationEvent)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
        return
      }
      const usage = event as UsageEvent
      const result = await governance.ingest(subject, usage)
      if (result.inserted && usage.status === 'denied') {
        await audit?.write({
          ...(subject.kind === 'user' ? { userId: subject.id } : {}),
          action: 'model.denied',
          detail: JSON.stringify({
            subject,
            provider: usage.provider,
            model: usage.model,
            purpose: usage.purpose,
          }),
        })
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result))
    }
    try {
      await (writes === undefined ? ingest() : writes.track(ingest))
    } catch (error) {
      if (error instanceof PostgresCheckoutQueueFullError) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.code }))
        return
      }
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }))
    }
  })().catch((error: unknown) => {
    if (res.writableEnded) return
    if (error instanceof PostgresCheckoutQueueFullError) {
      res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: error.code }))
      return
    }
    res.writeHead(500).end()
  }) })
}
