/** Public webhook ingress: provider verification, durable reservation, managed runtime dispatch. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RuntimeLeaseUnavailableError, type RuntimeTarget } from './instances.ts'
import { PRINCIPAL_HEADER, type GatewayPrincipalSigner } from './principal.ts'
import { DISPATCH_BODY_LIMIT, WebhookEndpointError, type PostgresWebhookEndpointService, type WebhookIntakeConfig } from './postgres/webhook-endpoint-service.ts'
import { WebhookReceiptError, type PostgresWebhookDeliveryService, type WebhookEndpointId, type WebhookReceipt } from './postgres/webhook-delivery-service.ts'
import type { GatewayDeps } from './server.ts'

/** Route the managed runtime exposes for `webhook-dispatch` assertions. */
export const WEBHOOK_DISPATCH_PATH = '/api/internal/gateway/webhook-dispatch'
const INTAKE_PATH = /^\/webhook\/([1-9][0-9]*)$/u
const SIGNATURE = /^sha256=([0-9a-f]{64})$/u

/** Classified intake failure; `status` is the provider-facing HTTP answer. */
export class WebhookIntakeError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 405 | 409 | 413 | 415 | 429 | 503, message: string) {
    super(message)
  }
}

/** Render `{{path}}` placeholders against the delivery context; missing values fail closed. */
function renderTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/gu, (_match, path: string) => {
    let value: unknown = context
    for (const key of path.split('.')) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new WebhookIntakeError(400, 'webhook template references an unavailable field')
      }
      value = (value as Record<string, unknown>)[key]
    }
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    throw new WebhookIntakeError(400, 'webhook template references an unavailable field')
  })
}

function requiredHeader(req: IncomingMessage, name: string): string {
  const values = req.headersDistinct[name]
  const value = values?.[0]
  if (values?.length !== 1 || value === undefined || value.trim() === '') {
    throw new WebhookIntakeError(400, `missing ${name} header`)
  }
  return value
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false
  const parts = value.split(';').map(part => part.trim())
  const [mediaType, parameter, ...extra] = parts
  if (mediaType?.toLowerCase() !== 'application/json') return false
  if (parameter === undefined) return true
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/iu.test(parameter)
}

async function readBoundedBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk) : (chunk as Buffer).byteLength
    size += bytes
    if (size > limit) { req.resume(); throw new WebhookIntakeError(413, 'webhook body too large') }
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function verifyGitHubSignature(body: string, signature: string, secret: string): boolean {
  const match = signature.match(SIGNATURE)
  if (match === null) return false
  const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex')
  const received = Buffer.from(match[1]!, 'hex')
  const wanted = Buffer.from(expected, 'hex')
  return received.length === wanted.length && timingSafeEqual(received, wanted)
}

/** The payload's `repository.full_name`, lowercased; absent or malformed fails the configured filter. */
function repositoryName(payload: Record<string, unknown>): string | undefined {
  const repository = payload['repository']
  if (repository === null || typeof repository !== 'object' || Array.isArray(repository)) return undefined
  const fullName = (repository as Record<string, unknown>)['full_name']
  return typeof fullName === 'string' && fullName !== '' ? fullName.toLowerCase() : undefined
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** One webhook endpoint's verified ingress and its dispatch to the bound runtime. */
export class GatewayWebhookIntake {
  constructor(
    private readonly deps: {
      cfg: Pick<GatewayDeps['cfg'], 'upstreamTimeoutMs'>
      users: Pick<GatewayDeps['users'], 'getById'>
      projects: Pick<GatewayDeps['projects'], 'getById'>
      instances: Pick<GatewayDeps['instances'], 'isLive' | 'generationOf' | 'portOf' | 'operationRef'>
    },
    private readonly endpoints: Pick<PostgresWebhookEndpointService, 'intake' | 'dispatchConfig'>,
    private readonly deliveries: Pick<PostgresWebhookDeliveryService, 'get' | 'reserve' | 'redispatch' | 'complete'>,
    private readonly signer: GatewayPrincipalSigner,
  ) {}

  /**
   * Admit one provider delivery: verify, deduplicate, dispatch, record.
   * @param req - inbound provider request; only POST reaches this handler.
   * @param res - provider-facing response; always a bounded status page.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        throw new WebhookIntakeError(405, 'method not allowed')
      }
      const match = (new URL(req.url ?? '/', 'http://x').pathname).match(INTAKE_PATH)
      const config = await this.endpoints.intake(Number(match?.[1]))
      if (!isJsonContentType(req.headers['content-type'])) {
        throw new WebhookIntakeError(415, 'content type must be application/json')
      }
      const body = await readBoundedBody(req, config.maxBodyBytes)
      const delivery = this.verify(config, req, body)
      const requestHash = createHash('sha256').update(body, 'utf8').digest('hex')
      const reservation = await this.deliveries.reserve({
        endpointId: config.endpointId as WebhookEndpointId, deliveryId: delivery.deliveryId, requestHash,
        configurationRevision: config.revision, executionUserUuid: config.executionUserUuid,
        target: { kind: config.runtimeKind, id: config.runtimePublicId },
        limit: config.intakeLimit, windowMs: config.intakeWindowMs, replayWindowMs: config.replayWindowMs,
        event: delivery.event,
      })
      if (reservation.dispatch) {
        const outcome = await this.dispatch(config, delivery.deliveryId, delivery.event, delivery.receivedAt)
        await this.deliveries.complete(config.endpointId as WebhookEndpointId, reservation.receipt.id, outcome)
      }
      sendJson(res, 202, { ok: true })
    } catch (error: unknown) {
      if (error instanceof WebhookEndpointError) {
        sendJson(res, error.status === 404 ? 404 : error.status, { error: error.status === 404 ? 'not-found' : error.message })
        return
      }
      if (error instanceof WebhookReceiptError) { sendJson(res, error.status, { error: error.message }); return }
      if (error instanceof WebhookIntakeError) { sendJson(res, error.status, { error: error.message }); return }
      sendJson(res, 503, { error: 'webhook ingress is unavailable' })
      console.error('[gateway] webhook intake failed:', error)
    }
  }

  /**
   * Replay one settled receipt's stored event under the endpoint's current
   * configuration; the synthetic delivery id bypasses content deduplication.
   * @param receiptId - settled receipt selected by an administrator.
   * @returns the new receipt after dispatch settles, or its recorded failure.
   */
  async redispatch(receiptId: unknown): Promise<WebhookReceipt> {
    const stored = await this.deliveries.get(receiptId)
    const config = await this.endpoints.dispatchConfig(stored.endpointId)
    const rerun = await this.deliveries.redispatch(receiptId, {
      endpointId: stored.endpointId, configurationRevision: config.revision,
      executionUserUuid: config.executionUserUuid,
      target: { kind: config.runtimeKind, id: config.runtimePublicId },
    })
    if (stored.event === null || typeof stored.event !== 'object' || Array.isArray(stored.event)) {
      const settled = await this.deliveries.complete(stored.endpointId as WebhookEndpointId, rerun.receipt.id,
        { state: 'rejected', errorCode: 'event-unavailable' })
      return settled
    }
    const event = stored.event as { name?: unknown; payload?: unknown }
    if (typeof event.name !== 'string' || event.payload === null || typeof event.payload !== 'object'
      || Array.isArray(event.payload)) {
      return this.deliveries.complete(stored.endpointId as WebhookEndpointId, rerun.receipt.id,
        { state: 'rejected', errorCode: 'event-unavailable' })
    }
    const outcome = await this.dispatch(config, rerun.deliveryId,
      { name: event.name, payload: event.payload as Record<string, unknown> }, Date.now())
    return this.deliveries.complete(stored.endpointId as WebhookEndpointId, rerun.receipt.id, outcome)
  }

  /** Verify the provider signature and normalize the delivery. */
  private verify(config: WebhookIntakeConfig, req: IncomingMessage, body: string): {
    deliveryId: string; event: { name: string; payload: Record<string, unknown> }; receivedAt: number
  } {
    const signature = requiredHeader(req, 'x-hub-signature-256')
    const deliveryId = requiredHeader(req, 'x-github-delivery')
    const eventName = requiredHeader(req, 'x-github-event')
    if (!verifyGitHubSignature(body, signature, config.secret)) {
      throw new WebhookIntakeError(401, 'invalid webhook signature')
    }
    let payload: unknown
    try {
      payload = JSON.parse(body)
    } catch {
      throw new WebhookIntakeError(400, 'request body is not valid JSON')
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new WebhookIntakeError(400, 'webhook payload must be a JSON object')
    }
    return { deliveryId, event: { name: eventName, payload: payload as Record<string, unknown> }, receivedAt: Date.now() }
  }

  /**
   * Forward one reserved delivery to its bound running runtime.
   * @returns the completion record; transport ambiguity becomes `unknown`.
   */
  private async dispatch(
    config: Omit<WebhookIntakeConfig, 'secret'>, deliveryId: string,
    event: { name: string; payload: Record<string, unknown> }, receivedAt: number,
  ): Promise<unknown> {
    const action = typeof event.payload['action'] === 'string' ? event.payload['action'] : undefined
    if (config.events.length !== 0 && !config.events.includes(event.name)) {
      return { state: 'ignored', errorCode: 'event-unmatched' }
    }
    if (config.actions.length !== 0 && (action === undefined || !config.actions.includes(action))) {
      return { state: 'ignored', errorCode: 'action-unmatched' }
    }
    if (config.repositories.length !== 0) {
      const repository = repositoryName(event.payload)
      const allowed = config.repositories.map(entry => entry.toLowerCase())
      if (repository === undefined || !allowed.includes(repository)) {
        return { state: 'ignored', errorCode: 'repository-unmatched' }
      }
    }
    const target: RuntimeTarget = { kind: config.runtimeKind, id: config.runtimePublicId }
    const instances = this.deps.instances
    let user: Awaited<ReturnType<GatewayDeps['users']['getById']>>
    let live: boolean
    let generation: number
    try {
      user = await this.deps.users.getById(config.executionUserId)
      live = await instances.isLive(target)
      generation = await instances.generationOf(target)
    } catch {
      return { state: 'unknown', errorCode: 'dispatch-unavailable' }
    }
    if (user === null || user.status !== 'active') return { state: 'rejected', errorCode: 'execution-account' }
    if (!live) return { state: 'rejected', errorCode: 'runtime-offline' }
    if (instances.operationRef === undefined) return { state: 'unknown', errorCode: 'dispatch-unavailable' }
    let title: string
    let prompt: string
    try {
      const context = {
        delivery: { id: deliveryId }, event: { name: event.name, action },
        payload: event.payload,
      }
      title = renderTemplate(config.titleTemplate, context)
      prompt = renderTemplate(config.promptTemplate, context)
    } catch {
      return { state: 'rejected', errorCode: 'template-unresolved' }
    }
    const payload = JSON.stringify({
      ruleId: `endpoint:${String(config.endpointPublicId)}`,
      delivery: {
        kind: config.provider, source: config.source, deliveryId,
        event: { name: event.name, payload: event.payload }, receivedAt,
      },
      request: {
        workspacePath: config.workspacePath, title, prompt,
        agentPreset: config.agentPreset, permissionPreset: config.permissionPreset,
        ...(config.modelProvider === null || config.modelId === null ? {} : {
          model: {
            provider: config.modelProvider, model: config.modelId,
            ...(config.modelMaxTokens === null ? {} : { maxTokens: config.modelMaxTokens }),
          },
        }),
      },
    })
    if (Buffer.byteLength(payload, 'utf8') > DISPATCH_BODY_LIMIT) {
      return { state: 'rejected', errorCode: 'dispatch-too-large' }
    }
    try {
      await instances.operationRef(target, 1, generation)
    } catch (error) {
      return { state: error instanceof RuntimeLeaseUnavailableError ? 'rejected' : 'unknown', errorCode: 'runtime-lease' }
    }
    try {
      const projectName = target.kind === 'project'
        ? (await this.deps.projects.getById(target.id))?.name ?? ''
        : ''
      const assertion = this.signer.issueWebhookDispatch({
        user,
        runtime: { ...target, generation },
        scope: target.kind === 'user'
          ? { kind: 'personal' }
          : { kind: 'project', projectId: target.id, projectName, mode: 'ro' },
      }, this.deps.cfg.upstreamTimeoutMs)
      const port = await instances.portOf(target)
      const authority = `127.0.0.1:${String(port)}`
      const response = await fetch(`http://${authority}${WEBHOOK_DISPATCH_PATH}`, {
        method: 'POST',
        headers: { host: authority, 'content-type': 'application/json', [PRINCIPAL_HEADER]: assertion },
        body: payload,
        signal: AbortSignal.timeout(this.deps.cfg.upstreamTimeoutMs),
      })
      if (response.status === 200) {
        const result = await response.json() as { sessionId?: unknown }
        if (typeof result.sessionId === 'string' && result.sessionId.length > 0) {
          return { state: 'submitted', sessionId: result.sessionId }
        }
        return { state: 'unknown', errorCode: 'dispatch-result' }
      }
      await response.body?.cancel()
      return response.status < 500
        ? { state: 'rejected', errorCode: 'dispatch-refused' }
        : { state: 'unknown', errorCode: 'dispatch-failed' }
    } catch {
      return { state: 'unknown', errorCode: 'dispatch-failed' }
    } finally {
      try {
        await instances.operationRef(target, -1, generation)
      } catch {
        // A failed release leaves the lease for its own timeout accounting.
      }
    }
  }
}
