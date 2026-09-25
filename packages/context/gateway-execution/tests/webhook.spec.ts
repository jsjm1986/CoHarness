/** The managed webhook dispatch route admits only purpose-bound principals and bounded bodies. */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { registerWebhookDispatch } from '../src/webhook.ts'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

interface Fixture {
  handler: (req: IncomingMessage, res: ServerResponse) => void
  respond(res: FakeResponse, body: unknown): Promise<{ status: number; json: unknown }>
  principal(value: GatewayRequestPrincipal | undefined): void
  failSession(error: Error): void
  sessionCalls: string[]
}

interface FakeResponse {
  status: number
  body: string
  writableEnded: boolean
  writeHead(status: number): FakeResponse
  end(body?: string): void
}

function fixture(options: { withRoute?: boolean; failSession?: Error } = {}): Fixture {
  let principal: GatewayRequestPrincipal | undefined = {
    claims: { purpose: 'webhook-dispatch', expiresAt: Date.now() + 60_000, user: { id: 12 } },
  } as GatewayRequestPrincipal
  const sessionCalls: string[] = []
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  const ctx = {
    get(name: string) {
      if (name === 'connection') {
        return options.withRoute === false ? undefined : {
          http: {
            handlePrefix(_path: string, route: (req: IncomingMessage, res: ServerResponse) => void) {
              handler = route
              return async () => {}
            },
          },
        }
      }
      if (name === 'gatewayRuntime') return { current: () => principal }
      if (name === 'executionAuthority' || name === 'executionAuthorityRequired') return undefined
      return undefined
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    permissionPresets: { resolve: () => ({}), set: () => { sessionCalls.push('permission-set') } },
    agentPresets: {
      resolve: async () => ({ id: 'preset' }),
      standingKeyFor: async () => ({}),
      mount: async () => ({}),
    },
    workspaceRegistry: {
      create: async () => ({ path: '/workspace', attachSession: async () => {}, detachSession: async () => {} }),
    },
    agents: {
      create: async (createOptions: { setup?: (agentCtx: unknown) => Promise<void> }) => {
        if (options.failSession) throw options.failSession
        await createOptions.setup?.({ on: () => () => {} })
        return { agent: { session: {}, followup: () => { sessionCalls.push('followup') } }, dispose: async () => {} }
      },
    },
    sessionTitle: { rename: () => {} },
    effect(fn: () => () => Promise<void>) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    logger: { warn: vi.fn() },
  }
  registerWebhookDispatch(ctx as unknown as Context, new AbortController().signal)
  if (handler === undefined) throw new Error('dispatch route was not registered')
  const route = handler
  return {
    handler: route,
    principal(value) { principal = value },
    failSession(error) { options.failSession = error },
    sessionCalls,
    respond(res, body) {
      const req = new EventEmitter() as IncomingMessage
      req.method = 'POST'
      const raw = typeof body === 'string' ? body : JSON.stringify(body)
      process.nextTick(() => {
        req.emit('data', Buffer.from(raw))
        req.emit('end')
      })
      route(req, res as unknown as ServerResponse)
      return new Promise((resolve) => {
        const check = () => {
          if (res.writableEnded) { resolve({ status: res.status, json: JSON.parse(res.body) }); return }
          setImmediate(check)
        }
        check()
      })
    },
  }
}

function fakeResponse(): FakeResponse {
  return {
    status: 0,
    body: '',
    writableEnded: false,
    writeHead(status) { this.status = status; return this },
    end(body) { this.body = body ?? ''; this.writableEnded = true },
  }
}

const validBody = {
  ruleId: 'endpoint-1',
  delivery: {
    kind: 'github',
    source: 'primary',
    deliveryId: 'delivery-1',
    event: { action: 'opened' },
    receivedAt: 1,
  },
  request: {
    workspacePath: '/workspace',
    title: 'Review PR',
    prompt: 'Review it',
    agentPreset: 'standard',
    permissionPreset: 'read-only',
  },
}

it('registers no route without a connection', () => {
  const ctx = {
    get: () => undefined,
    effect: (fn: () => void) => { fn() },
    logger: { warn: vi.fn() },
  }
  registerWebhookDispatch(ctx as unknown as Context, new AbortController().signal)
})

it.each([undefined,
  { claims: { purpose: 'session-input', expiresAt: Date.now() + 60_000 } },
  { claims: { purpose: 'webhook-dispatch', expiresAt: Date.now() - 1 } },
])('rejects missing, wrong-purpose or expired principals (%j)', async (value) => {
  const f = fixture()
  f.principal(value as GatewayRequestPrincipal | undefined)
  const res = fakeResponse()
  const req = new EventEmitter() as IncomingMessage
  req.method = 'POST'
  f.handler(req, res as unknown as ServerResponse)
  req.emit('end')
  await vi.waitFor(() => { expect(res.writableEnded).toBe(true) })
  expect(res.status).toBe(403)
  expect(JSON.parse(res.body)).toEqual({ error: 'webhook-dispatch-required' })
  expect(f.sessionCalls).toEqual([])
})

it('rejects non-POST methods before reading the body', async () => {
  const f = fixture()
  const res = fakeResponse()
  const req = new EventEmitter() as IncomingMessage
  req.method = 'GET'
  f.handler(req, res as unknown as ServerResponse)
  await vi.waitFor(() => { expect(res.writableEnded).toBe(true) })
  expect(res.status).toBe(403)
})

it('rejects invalid JSON and schema violations', async () => {
  const f = fixture()
  expect(await f.respond(fakeResponse(), 'not json')).toEqual({ status: 400, json: { error: 'invalid-dispatch' } })
  expect(await f.respond(fakeResponse(), { ...validBody, ruleId: '' })).toEqual({ status: 400, json: { error: 'invalid-dispatch' } })
  expect(await f.respond(fakeResponse(), {
    ...validBody,
    delivery: { ...validBody.delivery, extra: 'key' },
  })).toEqual({ status: 400, json: { error: 'invalid-dispatch' } })
  const noEvent = { ...validBody, delivery: { ...validBody.delivery } } as { delivery: Record<string, unknown> }
  delete noEvent.delivery['event']
  expect(await f.respond(fakeResponse(), noEvent)).toEqual({ status: 400, json: { error: 'invalid-dispatch' } })
  expect(f.sessionCalls).toEqual([])
})

it('rejects oversized bodies while preserving the response channel', async () => {
  const f = fixture()
  const res = fakeResponse()
  const req = new EventEmitter() as IncomingMessage
  req.method = 'POST'
  let destroyed = false
  req.destroy = () => { destroyed = true; return req }
  f.handler(req, res as unknown as ServerResponse)
  req.emit('data', Buffer.alloc(1_048_577))
  req.emit('end')
  await vi.waitFor(() => { expect(res.writableEnded).toBe(true) })
  expect(destroyed).toBe(false)
  expect(res.status).toBe(502)
})

it('admits one Session per valid delivery', async () => {
  const f = fixture()
  const result = await f.respond(fakeResponse(), validBody)
  expect(result.status).toBe(200)
  expect((result.json as { sessionId: string }).sessionId).toMatch(/^webhook-/)
  expect(f.sessionCalls).toEqual(['permission-set', 'followup'])
})

it('maps Session creation failures to a bounded dispatch error', async () => {
  const f = fixture({ failSession: new Error('agent failed') })
  const result = await f.respond(fakeResponse(), validBody)
  expect(result).toEqual({ status: 502, json: { error: 'dispatch-failed' } })
})
