/** Managed SSH resolution binds the live caller, the revocation epoch, and per-mount lifetimes. */
import { afterEach, expect, it, vi } from 'vitest'
import type { GatewayRuntime, GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import { GatewaySshAuthorization } from '../src/ssh.ts'

const services: GatewaySshAuthorization[] = []
afterEach(() => { for (const service of services.splice(0)) service.dispose() })
const config = {
  host: 'builder', node: '/usr/bin/node', helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64),
  workspace: '/srv/work', requestTimeoutMs: 5_000, bootstrapPath: '/opt/dsh/ptc.js', bootstrapHash: 'b'.repeat(64),
  maxFrameBytes: 1024, maxPending: 4, leaseMs: 10_000,
}
function fixture(identity: { kind: 'user' | 'project'; id: number } = { kind: 'project', id: 7 }) {
  let principal: GatewayRequestPrincipal | undefined =
    { claims: { user: { id: 12 }, expiresAt: Date.now() + 60_000 } } as GatewayRequestPrincipal
  let available = true
  const request = vi.fn<GatewayRuntime['request']>(async () => Response.json({ userId: 12, config }))
  const runtime = { interactive: () => principal, request, identity: { kind: identity.kind, id: identity.id, generation: 1 } }
  const service = new GatewaySshAuthorization(runtime, () => available)
  services.push(service)
  return { service, request, signal: new AbortController().signal,
    principal: (value: GatewayRequestPrincipal | undefined) => { principal = value }, available: (value: boolean) => { available = value } }
}

it('resolves coordinates for the interactive caller and returns a revocable signal', async () => {
  const f = fixture()
  const resolved = await f.service.resolve(42, f.signal)
  expect(resolved.userId).toBe(12)
  expect(resolved.config).toEqual(config)
  expect(resolved.signal.aborted).toBe(false)
  expect(JSON.parse(f.request.mock.calls[0]![1]!.body as string)).toEqual({ targetId: 42 })
  expect(f.request.mock.calls[0]![1]!.principal).toMatchObject({ claims: { user: { id: 12 } } })
  f.service.invalidate({ userId: 12 })
  expect(resolved.signal.aborted).toBe(true)
})

it.each([undefined, { claims: { purpose: 'webhook-dispatch', expiresAt: Date.now() + 60_000 } },
  { claims: { expiresAt: 0 } }])('refuses missing, restricted or expired interactive users (%j)', async (principal) => {
  const f = fixture(); f.principal(principal as GatewayRequestPrincipal | undefined)
  await expect(f.service.resolve(1, f.signal)).rejects.toMatchObject({ code: 'ssh/forbidden' })
  expect(f.request).not.toHaveBeenCalled()
})

it('requires a live revocation stream and rejects authority changes during resolution', async () => {
  const f = fixture()
  f.available(false)
  await expect(f.service.resolve(1, f.signal)).rejects.toMatchObject({ code: 'ssh/forbidden' })
  f.available(true)
  await expect(f.service.resolve(1, AbortSignal.abort())).rejects.toThrow()
  f.request.mockImplementationOnce(async () => { f.service.invalidate({ userId: 12 }); return Response.json({ userId: 12, config }) })
  await expect(f.service.resolve(1, f.signal)).rejects.toMatchObject({ code: 'ssh/forbidden' })
  f.request.mockImplementationOnce(async () => { f.available(false); return Response.json({ userId: 12, config }) })
  await expect(f.service.resolve(1, f.signal)).rejects.toMatchObject({ code: 'ssh/forbidden' })
})

it.each([null, {}, [], { userId: 99, config }, { userId: 12 }, { userId: 12, config: { host: 'x' } },
  { userId: 12, config: { ...config, extra: 'key' } }])('refuses malformed or wrong-user replies (%j)', async (value) => {
  const f = fixture(); f.request.mockResolvedValueOnce(Response.json(value))
  await expect(f.service.resolve(1, f.signal)).rejects.toMatchObject({ code: 'ssh/forbidden' })
})

it.each([null, 'refused'])('refuses a denied resolution without a live grant (%j)', async (body) => {
  const f = fixture(); f.request.mockResolvedValueOnce(new Response(body, { status: 403 }))
  await expect(f.service.resolve(1, f.signal)).rejects.toMatchObject({ code: 'ssh/forbidden' })
})

it('narrows revocation to the invalidated subject', async () => {
  const f = fixture()
  const first = await f.service.resolve(1, f.signal)
  const second = await f.service.resolve(2, f.signal)
  f.service.invalidate({ userId: 99 })
  f.service.invalidate({ projectId: 8 })
  expect(first.signal.aborted).toBe(false)
  expect(second.signal.aborted).toBe(false)
  f.service.invalidate({ projectId: 7 })
  expect(first.signal.aborted).toBe(true)
  expect(second.signal.aborted).toBe(true)
})

it('notifies listeners and revokes every grant on a broadcast invalidation', async () => {
  const f = fixture()
  const resolved = await f.service.resolve(1, f.signal)
  const seen: unknown[] = []
  using _sub = f.service.onInvalidated((subject) => { seen.push(subject) })
  f.service.invalidate()
  expect(seen).toEqual([{}])
  expect(resolved.signal.aborted).toBe(true)
  const fresh = await f.service.resolve(1, f.signal)
  expect(fresh.signal.aborted).toBe(false)
})

it('cancels every grant when its provider is disposed', async () => {
  const f = fixture()
  const resolved = await f.service.resolve(1, f.signal)
  f.service.dispose()
  expect(resolved.signal.aborted).toBe(true)
  await expect(f.service.resolve(1, f.signal)).rejects.toThrow()
})

it('resolves a minimal configuration under the provider lifetime and releases the mount explicitly', async () => {
  const minimal = {
    host: 'builder', node: '/usr/bin/node', helper: '/opt/dsh/helper.js', helperHash: 'a'.repeat(64),
    workspace: '/srv/work',
  }
  const f = fixture()
  f.request.mockResolvedValueOnce(Response.json({ userId: 12, config: minimal }))
  const resolved = await f.service.resolve(1)
  expect(resolved.config).toEqual(minimal)
  resolved.release?.()
  expect(resolved.signal.aborted).toBe(true)
})

it('carries a declared password credential reference into the released configuration', async () => {
  const f = fixture()
  f.request.mockResolvedValueOnce(Response.json({ userId: 12, config: { ...config, passwordRef: 'SSH_BUILDER_PASSWORD' } }))
  await expect(f.service.resolve(1, f.signal)).resolves.toMatchObject({ config: { passwordRef: 'SSH_BUILDER_PASSWORD' } })
})

it('scopes grants to the caller alone under a user runtime identity', async () => {
  const f = fixture({ kind: 'user', id: 9 })
  const resolved = await f.service.resolve(1, f.signal)
  f.service.invalidate({ projectId: 7 })
  expect(resolved.signal.aborted).toBe(false)
  f.service.invalidate({ userId: 12 })
  expect(resolved.signal.aborted).toBe(true)
})

it('notifies live listeners that disposal revoked every mount', () => {
  const f = fixture()
  const seen: unknown[] = []
  f.service.onInvalidated((subject) => { seen.push(subject) })
  f.service.dispose()
  expect(seen).toEqual([{}])
})
