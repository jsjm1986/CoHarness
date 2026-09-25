/** Loopback-only managed webhook dispatch: a Gateway-verified delivery becomes one Session. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GATEWAY_WEBHOOK_DISPATCH_PATH, type GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import { createWebhookSession, WebhookDeliveryId, WebhookRuleId, WebhookSourceId, type VerifiedWebhookDelivery } from '@deepseek-ai/dsh-webhook'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'

const DISPATCH_BODY_LIMIT = 1_048_576

const dispatchBody = z.object({
  ruleId: z.string().min(1).max(256),
  delivery: z.object({
    kind: z.string().min(1).max(64),
    source: z.string().min(1).max(128),
    deliveryId: z.string().min(1).max(256),
    event: z.unknown(),
    receivedAt: z.number().int().min(0),
  }).strict(),
  request: z.object({
    workspacePath: z.string().min(1).max(1024),
    title: z.string().min(1).max(512),
    prompt: z.string().min(1).max(65_536),
    agentPreset: z.string().min(1).max(128),
    permissionPreset: z.string().min(1).max(128),
    model: z.object({
      provider: z.string().min(1).max(128),
      model: z.string().min(1).max(256),
      maxTokens: z.number().int().positive().optional(),
    }).strict().optional(),
  }).strict(),
}).strict()

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > limit) { reject(new Error('dispatch body too large')); return }
      chunks.push(chunk)
    })
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', reject)
  })
}

/**
 * Register the managed dispatch route; only `webhook-dispatch` principals reach
 * the handler, and the runtime admission authority stamps the Session.
 * @param ctx - runtime context carrying gatewayRuntime and the webhook services.
 * @param signal - owning plugin lifetime; disposal aborts in-flight admission.
 */
export function registerWebhookDispatch(ctx: Context, signal: AbortSignal): void {
  const connection = ctx.get('connection') as {
    http?: { handlePrefix?: (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void, options: { authority: 'loopback' }) => () => Promise<void> }
  } | undefined
  const runtime = ctx.get('gatewayRuntime') as Pick<GatewayRuntime, 'current'> | undefined
  const http = connection?.http
  const handlePrefix = http?.handlePrefix
  if (http === undefined || handlePrefix === undefined || runtime === undefined) return
  ctx.effect(() => handlePrefix.call(http, GATEWAY_WEBHOOK_DISPATCH_PATH, (req, res) => {
    void (async () => {
      const principal = runtime.current()
      if (req.method !== 'POST' || principal === undefined || principal.claims.purpose !== 'webhook-dispatch'
        || principal.claims.expiresAt <= Date.now()) {
        send(res, 403, { error: 'webhook-dispatch-required' })
        return
      }
      const raw = await readBody(req, DISPATCH_BODY_LIMIT)
      let parsedBody: z.infer<typeof dispatchBody>
      try {
        const parsed = dispatchBody.safeParse(JSON.parse(raw))
        if (!parsed.success) throw new Error('invalid dispatch body')
        parsedBody = parsed.data
      } catch {
        send(res, 400, { error: 'invalid-dispatch' })
        return
      }
      if (!isJsonValue(parsedBody.delivery.event)) { send(res, 400, { error: 'invalid-dispatch' }); return }
      const event = parsedBody.delivery.event as JsonValue
      const delivery: VerifiedWebhookDelivery = {
        kind: parsedBody.delivery.kind,
        source: WebhookSourceId(parsedBody.delivery.source),
        deliveryId: WebhookDeliveryId(parsedBody.delivery.deliveryId),
        event,
        receivedAt: parsedBody.delivery.receivedAt,
      }
      const { model, ...request } = parsedBody.request
      const sessionId = await createWebhookSession(ctx, delivery,
        WebhookRuleId(parsedBody.ruleId),
        {
          ...request,
          ...(model === undefined ? {} : {
            model: { provider: model.provider, model: model.model,
              ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }) },
          }),
        }, signal)
      send(res, 200, { sessionId })
    })().catch((error: unknown) => {
      if (res.writableEnded) return
      const status = error instanceof TypeError ? 400 : 502
      send(res, status, { error: status === 400 ? 'invalid-dispatch' : 'dispatch-failed' })
      ctx.logger.warn('webhook dispatch failed', { error: error instanceof Error ? error.message : String(error) })
    })
  }, { authority: 'loopback' }), 'gateway-execution: webhook dispatch route')
}
