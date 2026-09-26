/** Human terminal authority is private, revocable, and independent of model execution. */
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { GatewayRuntime, GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import { GatewayUserTerminalAuthorization } from '../src/user-terminal.ts'

const policies: GatewayUserTerminalAuthorization[] = []
afterEach(() => { for (const policy of policies.splice(0)) policy.dispose() })
const session = SessionId('session-a'), grantId = '00000000-0000-4000-8000-000000000001'
function fixture() {
  let principal: GatewayRequestPrincipal | undefined =
    { claims: { user: { id: 12 }, expiresAt: Date.now() + 60_000 } } as GatewayRequestPrincipal
  let available = true
  const request = vi.fn<GatewayRuntime['request']>(async path => Response.json(path.endsWith('terminal-authorize') ? { userId: 12, grantId } : { userId: 12 }))
  const runtime = { interactive: () => principal, request, organization: 'org', identity: { kind: 'project' as const, id: 7, generation: 1 } }
  const policy = new GatewayUserTerminalAuthorization(runtime, () => available)
  policies.push(policy)
  return { policy, runtime, request, signal: new AbortController().signal,
    principal: (value: GatewayRequestPrincipal | undefined) => { principal = value }, available: (value: boolean) => { available = value } }
}

it('borrows exact-user grants and retains authority independently of the browser call', async () => {
  const f = fixture()
  const first = await f.policy.authorize(session, f.signal)
  const retained = first.retain()
  first[Symbol.dispose]()
  using second = await f.policy.authorize(session, f.signal)
  expect(second.signal).toBe(first.signal)
  expect(JSON.parse(f.request.mock.calls[0]![1]!.body as string)).toEqual({ sessionId: session })
  expect(f.request.mock.calls[0]![1]!.principal).toMatchObject({ claims: { user: { id: 12 } } })
  expect(second.creator).toBe(JSON.stringify(['org', 'project', 7, 12]))
  await f.policy.invalidate({ userId: 99 })
  await f.policy.invalidate({ projectId: 8 })
  expect(f.request).toHaveBeenCalledTimes(2)
  await f.policy.invalidate({ userId: 12 })
  expect(f.request.mock.calls[2]![1]!.principal).toBeUndefined()
  expect(JSON.parse(f.request.mock.calls[2]![1]!.body as string)).toEqual({ sessionId: session, grantId })
  expect(first.signal.aborted).toBe(false)
  retained[Symbol.dispose]()
  retained[Symbol.dispose]()
})

it('forgets unretained grants and never treats an old grant as a new one', async () => {
  const f = fixture(), first = await f.policy.authorize(session, f.signal)
  first[Symbol.dispose]()
  first[Symbol.dispose]()
  await f.policy.invalidate({ userId: 12 })
  expect(f.request).toHaveBeenCalledTimes(1)
  using second = await f.policy.authorize(session, f.signal)
  expect(second.signal).not.toBe(first.signal)
  f.request.mockResolvedValueOnce(Response.json({ userId: 12, grantId: '00000000-0000-4000-8000-000000000002' }))
  using replacement = await f.policy.authorize(session, f.signal)
  expect(second.signal.aborted).toBe(true)
  expect(replacement.signal.aborted).toBe(false)
})

it.each([undefined, { claims: { purpose: 'archive-read', expiresAt: Date.now() + 60_000 } }, { claims: { expiresAt: 0 } }])('refuses missing, restricted or expired interactive users (%j)', async (principal) => {
  const f = fixture(); f.principal(principal as GatewayRequestPrincipal | undefined)
  await expect(f.policy.authorize(session, f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
  expect(f.request).not.toHaveBeenCalled()
})

it('requires a live revocation stream and rejects cancellation and changed authority during admission', async () => {
  const f = fixture()
  f.available(false)
  await expect(f.policy.authorize(session, f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
  f.available(true)
  await expect(f.policy.authorize(session, AbortSignal.abort())).rejects.toThrow()
  f.request.mockImplementationOnce(async () => { await f.policy.invalidate({ userId: 12 }); return Response.json({ userId: 12, grantId }) })
  await expect(f.policy.authorize(session, f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
  f.request.mockImplementationOnce(async () => { f.available(false); return Response.json({ userId: 12, grantId }) })
  await expect(f.policy.authorize(session, f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
})

it.each([null, {}, [], { userId: 99, grantId }, { userId: 12, grantId: 1 }, { userId: 12, grantId: 'invalid' }])('refuses malformed or wrong-user authorization replies (%j)', async (value) => {
  const f = fixture(); f.request.mockResolvedValueOnce(Response.json(value))
  await expect(f.policy.authorize(session, f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
})

it.each([null, 'refused'])('refuses a denied admission without creating a live grant (%j)', async (body) => {
  const f = fixture(); f.request.mockResolvedValueOnce(new Response(body, { status: 403 }))
  await expect(f.policy.authorize(session, f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
})

it.each(['disconnect', 'offline', 'denied', 'empty-denial', 'bad-response', 'network'] as const)('revokes retained process owners on %s without reviving their signal', async (reason) => {
  const f = fixture()
  using authority = await f.policy.authorize(session, f.signal)
  using _held = authority.retain()
  if (reason === 'offline') f.available(false)
  if (reason === 'denied' || reason === 'empty-denial') f.request.mockResolvedValueOnce(new Response(reason === 'denied' ? 'denied' : null, { status: 403 }))
  if (reason === 'bad-response') f.request.mockResolvedValueOnce(Response.json({ userId: 99 }))
  if (reason === 'network') f.request.mockRejectedValueOnce(new Error('network lost'))
  await f.policy.invalidate(reason === 'disconnect' ? undefined : { userId: 12 })
  expect(authority.signal.aborted).toBe(true)
})

it('keeps replacement grants when an older recheck or release completes late', async () => {
  const f = fixture(), first = await f.policy.authorize(session, f.signal)
  const pending = Promise.withResolvers<Response>()
  f.request.mockImplementationOnce(() => pending.promise)
  const invalidating = f.policy.invalidate({ userId: 12 })
  f.request.mockResolvedValueOnce(Response.json({ userId: 12, grantId: '00000000-0000-4000-8000-000000000002' }))
  using replacement = await f.policy.authorize(session, f.signal)
  pending.resolve(new Response(null, { status: 403 }))
  await invalidating
  first[Symbol.dispose]()
  expect(replacement.signal.aborted).toBe(false)
  await f.policy.invalidate({ userId: 12 })
  expect(replacement.signal.aborted).toBe(false)
})

it('cancels all held owners when its provider is disposed', async () => {
  const f = fixture()
  using authority = await f.policy.authorize(session, f.signal)
  f.policy.dispose()
  expect(authority.signal.aborted).toBe(true)
  await expect(f.policy.authorize(session, f.signal)).rejects.toThrow()
})

it('limits terminal management to the dedicated administrator purpose and a fresh database decision', async () => {
  const f = fixture()
  for (const claims of [undefined, { user: { role: 'admin' }, expiresAt: Date.now() + 60_000 },
    { user: { role: 'user' }, purpose: 'terminal-admin', expiresAt: Date.now() + 60_000 },
    { user: { role: 'admin' }, purpose: 'terminal-admin', expiresAt: 0 }]) {
    f.principal(claims === undefined ? undefined : { claims } as GatewayRequestPrincipal)
    await expect(f.policy.administrator(f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
  }
  const principal = { claims: { user: { role: 'admin' }, purpose: 'terminal-admin', expiresAt: Date.now() + 60_000 } } as GatewayRequestPrincipal
  f.principal(principal)
  f.request.mockResolvedValueOnce(new Response(null, { status: 204 }))
  await f.policy.administrator(f.signal)
  expect(f.request).toHaveBeenLastCalledWith('/internal/runtime/terminal-management/authorize', expect.objectContaining({ method: 'POST', principal }))
  for (const body of [null, 'denied']) {
    f.request.mockResolvedValueOnce(new Response(body, { status: 403 }))
    await expect(f.policy.administrator(f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
  }
  await expect(f.policy.authorize(session, f.signal)).rejects.toMatchObject({ code: 'terminal/forbidden' })
})
