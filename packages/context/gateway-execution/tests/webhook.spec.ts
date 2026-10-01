/** The managed webhook dispatch route admits only purpose-bound principals and bounded bodies. */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GatewayCollaboration } from '@deepseek-ai/dsh-collaboration-gateway'
import { Context } from '@deepseek-ai/cordis'
import type { GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import { WebhookPresetError } from '@deepseek-ai/dsh-webhook'
import { afterEach, expect, it, vi } from 'vitest'
import { registerWebhookDispatch } from '../src/webhook.ts'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of disposers.splice(0)) await dispose() })

interface Fixture {
  handler: (req: IncomingMessage, res: ServerResponse) => void
  respond(res: FakeResponse, body: unknown): Promise<{ status: number; json: unknown }>
  principal(value: GatewayRequestPrincipal | undefined): void
  failSession(error: unknown): void
  sessionCalls: string[]
}

interface FakeResponse {
  status: number
  body: string
  writableEnded: boolean
  writeHead(status: number): FakeResponse
  end(body?: string): void
}

function fixture(options: { withRoute?: boolean; failSession?: unknown } = {}): Fixture {
  let principal: GatewayRequestPrincipal | undefined = {
    claims: { purpose: 'webhook-dispatch', expiresAt: Date.now() + 60_000, user: { id: 12 }, scope: { kind: 'personal' } },
  } as GatewayRequestPrincipal
  const sessionCalls: string[] = []
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  const ctx = {
    inject(_dependencies: readonly string[], callback: (ctx: Context) => void): void { callback(ctx as unknown as Context) },
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
    effect(fn: () => () => void | Promise<void>) {
      const dispose = fn()
      disposers.push(async () => { await dispose() })
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

it.each([
  { scope: { kind: 'personal' as const }, visibility: 'project' as const, status: 200 },
  { scope: { kind: 'project' as const, projectId: 1, projectName: 'Shared', mode: 'rw' as const }, visibility: 'project' as const, status: 200 },
  { scope: { kind: 'project' as const, projectId: 1, projectName: 'Shared', mode: 'rw' as const }, visibility: 'private' as const, status: 200 },
  { scope: { kind: 'project' as const, projectId: 1, projectName: 'Shared', mode: 'ro' as const }, visibility: 'private' as const, status: 403 },
])('carries the creation visibility through Cordis and removes dispatch with its services (%j)', async ({ scope, visibility, status }) => {
  const ctx = new Context()
  let handler: ((req: IncomingMessage, res: ServerResponse) => void) | undefined
  const followup = vi.fn()
  const removed = vi.fn()
  const resolving = Promise.withResolvers<undefined>()
  const resume = Promise.withResolvers<undefined>()
  let holdPreset = false
  const principal = { claims: { purpose: 'webhook-dispatch', expiresAt: Date.now() + 60_000, scope } }
  ctx.provide('gatewayRuntime', { current: () => principal, requireCurrent: () => principal } as never)
  const collaboration = ctx.plugin(GatewayCollaboration)
  disposers.push(async () => { await collaboration.dispose() })
  await collaboration.await()
  ctx.provide('connection', { http: { handlePrefix(_path: string, next: typeof handler) {
    handler = next
    return async () => { removed(); handler = undefined }
  } } } as never)
  ctx.provide('agents', { create: async (options: { setup: (ctx: Context) => Promise<void> }) => {
    expect(ctx.collaboration.currentCreation()).toEqual(scope.kind === 'project' ? { visibility } : undefined)
    await options.setup(ctx)
    return { agent: { session: {}, followup }, dispose: async () => {} }
  } } as never)
  ctx.provide('permissionPresets', { resolve: () => ({}), set: () => {} } as never)
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
  ctx.provide('workspaceRegistry', { create: async () => ({ path: '/workspace', attachSession: async () => {}, detachSession: async () => {} }) } as never)
  ctx.provide('sessionTitle', { rename: () => {} } as never)
  const presets = ctx.plugin({ apply(provider: Context) {
    provider.provide('agentPresets', {
      resolve: async () => { if (holdPreset) { resolving.resolve(undefined); await resume.promise }; return { id: 'preset' } },
      standingKeyFor: async () => ({}), mount: async () => ({}),
    } as never)
  } })
  const consumer = ctx.plugin({ inject: ['gatewayRuntime', 'agents', 'permissionPresets'], apply(scope: Context) {
    registerWebhookDispatch(scope, new AbortController().signal)
  } })
  disposers.push(async () => { await consumer.dispose(); await presets.dispose() })
  await consumer.await()
  await vi.waitFor(() => { expect(handler).toBeDefined() })
  const req = new EventEmitter() as IncomingMessage; req.method = 'POST'
  const res = fakeResponse()
  handler!(req, res as unknown as ServerResponse)
  const body = { ...validBody, request: { ...validBody.request, projectVisibility: visibility } }
  req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end')
  await vi.waitFor(() => { expect(res.writableEnded).toBe(true) })
  expect(res.status).toBe(status)
  if (status === 403) { expect(followup).not.toHaveBeenCalled(); return }
  expect(followup).toHaveBeenCalledOnce()
  holdPreset = true
  const pending = new EventEmitter() as IncomingMessage; pending.method = 'POST'
  const cancelled = fakeResponse()
  handler!(pending, cancelled as unknown as ServerResponse)
  pending.emit('data', Buffer.from(JSON.stringify(body))); pending.emit('end')
  await resolving.promise
  await presets.dispose()
  resume.resolve(undefined)
  await vi.waitFor(() => { expect(removed).toHaveBeenCalledOnce() })
  expect(handler).toBeUndefined()
  await vi.waitFor(() => { expect(cancelled.writableEnded).toBe(true) })
  expect(cancelled.status).toBe(502)
  expect(followup).toHaveBeenCalledOnce()
})

it('registers no route without a connection', () => {
  const ctx = {
    inject(_dependencies: readonly string[], callback: (ctx: Context) => void): void { callback(ctx as unknown as Context) },
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

it('refuses a project delivery when the collaboration provider is absent', async () => {
  const f = fixture()
  f.principal({ claims: { purpose: 'webhook-dispatch', expiresAt: Date.now() + 60_000,
    scope: { kind: 'project', projectId: 1, projectName: 'Shared', mode: 'rw' } } } as GatewayRequestPrincipal)
  expect(await f.respond(fakeResponse(), validBody)).toMatchObject({ status: 502 })
  expect(f.sessionCalls).toEqual([])
})

it('maps Session creation failures to a bounded dispatch error', async () => {
  const f = fixture({ failSession: new Error('agent failed') })
  const result = await f.respond(fakeResponse(), validBody)
  expect(result).toEqual({ status: 502, json: { error: 'dispatch-failed' } })
})

it.each([{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm', maxTokens: 4096 }])(
  'adapts an optional model override into Session creation (%j)', async (model) => {
    const f = fixture()
    const body = { ...validBody, request: { ...validBody.request, model } }
    expect((await f.respond(fakeResponse(), body)).status).toBe(200)
  })

it('rejects a delivery event that JSON cannot round-trip', async () => {
  const f = fixture()
  const raw = JSON.stringify(validBody).replace('"event":{"action":"opened"}', '"event":-0')
  expect(await f.respond(fakeResponse(), raw)).toEqual({ status: 400, json: { error: 'invalid-dispatch' } })
})

it('maps input validation failures to an invalid-dispatch response', async () => {
  const f = fixture({ failSession: new TypeError('model is not configurable') })
  expect(await f.respond(fakeResponse(), validBody)).toEqual({ status: 400, json: { error: 'invalid-dispatch' } })
})

it('maps unresolvable presets to a distinguishable preset-invalid refusal', async () => {
  const f = fixture({ failSession: new WebhookPresetError('agentPreset', 'code') })
  expect(await f.respond(fakeResponse(), validBody)).toEqual({ status: 400, json: { error: 'preset-invalid' } })
})

it('logs non-Error dispatch failures verbatim', async () => {
  const f = fixture({ failSession: 'revoked' })
  expect(await f.respond(fakeResponse(), validBody)).toEqual({ status: 502, json: { error: 'dispatch-failed' } })
})

it('leaves an already-committed response untouched when its write fails', async () => {
  const f = fixture()
  const res = fakeResponse()
  res.end = (body?: string) => {
    res.body = body ?? ''
    res.writableEnded = true
    throw new TypeError('socket closed')
  }
  const result = await f.respond(res, validBody)
  expect(result.status).toBe(200)
  expect((result.json as { sessionId: string }).sessionId).toMatch(/^webhook-/)
})
