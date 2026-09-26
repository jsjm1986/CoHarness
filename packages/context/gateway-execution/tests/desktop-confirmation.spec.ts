/** Human desktop gestures never borrow model execution or stale target identity. */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GatewayRequestPrincipal, GatewayRuntime } from '@deepseek-ai/dsh-gateway-runtime'
import { desktopConfirmationController } from '../src/desktop-confirmation.ts'

function fixture() {
  const root = { id: SessionId('root') } as Agent, child = { id: SessionId('child') } as Agent
  let owner = root
  let principal = { claims: { user: { id: 12 }, expiresAt: Date.now() + 60_000 } } as GatewayRequestPrincipal | undefined
  const value = { rootSessionId: root.id, nodeId: 'node', desktop: 'display-0', userId: 12, eligible: true, confirmed: false }
  const request = vi.fn<GatewayRuntime['request']>(async path => Response.json(path.endsWith('/desktop-confirm') ? { saved: true } : value))
  const policy = desktopConfirmationController({ interactive: () => principal, request }, () => owner, 'display-0')
  return { policy, root, child, value, request, signal: new AbortController().signal,
    setOwner: (agent: Agent) => { owner = agent }, setPrincipal: (user: GatewayRequestPrincipal | undefined) => { principal = user } }
}

describe('desktop human confirmation', () => {
  it('reads the exact live root and saves the displayed node without forging an actor', async () => {
    const f = fixture()
    expect(await f.policy.read(f.child, f.signal)).toEqual(f.value)
    expect(JSON.parse(f.request.mock.calls[0]![1]!.body as string)).toEqual({ sessionId: 'root', desktop: 'display-0' })
    expect(await f.policy.set(f.child, f.value, true, f.signal)).toEqual(f.value)
    expect(JSON.parse(f.request.mock.calls[1]![1]!.body as string))
      .toEqual({ sessionId: 'root', desktop: 'display-0', expectedNodeId: 'node', confirmed: true })
    expect(f.request.mock.calls[1]![1]!.principal).toMatchObject({ claims: { user: { id: 12 } } })
    await f.policy.set(f.child, f.value, false, f.signal)
    expect((JSON.parse(f.request.mock.calls[3]![1]!.body as string) as { confirmed?: boolean }).confirmed).toBe(false)
  })

  it.each([undefined, { claims: { purpose: 'archive-read', expiresAt: Date.now() + 60_000 } },
    { claims: { expiresAt: 0 } }])('rejects missing, limited or expired interactive identity', async (principal) => {
    const f = fixture()
    f.setPrincipal(principal as GatewayRequestPrincipal | undefined)
    await expect(f.policy.read(f.root, f.signal)).rejects.toThrow('active human request')
    await expect(f.policy.set(f.root, f.value, true, f.signal)).rejects.toThrow('active human request')
    expect(f.request).not.toHaveBeenCalled()
  })

  it.each([{ rootSessionId: SessionId('different') }, { desktop: 'another' }])('refuses changed expected targets before saving', async (changed) => {
    const f = fixture()
    await expect(f.policy.set(f.child, { ...f.value, ...changed }, true, f.signal)).rejects.toThrow('target changed')
    expect(f.request).not.toHaveBeenCalled()
  })

  it.each([{ rootSessionId: 'different' }, { desktop: 'another' }, { userId: 99 }])('rejects a response for another target or account', async (changed) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(Response.json({ ...f.value, ...changed }))
    await expect(f.policy.read(f.child, f.signal)).rejects.toThrow('target changed')
  })

  it('rejects ownership changed during read or save', async () => {
    const f = fixture()
    f.request.mockImplementationOnce(async () => { f.setOwner(f.child); return Response.json(f.value) })
    await expect(f.policy.read(f.child, f.signal)).rejects.toThrow('target changed')
    f.setOwner(f.root)
    f.request.mockImplementationOnce(async () => { f.setOwner(f.child); return Response.json({ saved: true }) })
    await expect(f.policy.set(f.child, f.value, true, f.signal)).rejects.toThrow('target changed')
  })

  it.each([null, 'denied'])('rejects gateway errors without accepting old confirmation (%s)', async (body) => {
    const f = fixture()
    f.request.mockResolvedValueOnce(new Response(body, { status: 403 }))
    await expect(f.policy.read(f.child, f.signal)).rejects.toThrow('unavailable')
    f.request.mockResolvedValueOnce(new Response(body, { status: 409 }))
    await expect(f.policy.set(f.child, f.value, true, f.signal)).rejects.toThrow('not saved')
  })

  it('validates wire replies and cancellation before presenting or storing consent', async () => {
    const f = fixture()
    f.request.mockResolvedValueOnce(Response.json({ ...f.value, userId: '12' }))
    await expect(f.policy.read(f.child, f.signal)).rejects.toThrow()
    f.request.mockResolvedValueOnce(Response.json({ saved: false }))
    await expect(f.policy.set(f.child, f.value, true, f.signal)).rejects.toThrow()
    await expect(f.policy.read(f.child, AbortSignal.abort())).rejects.toThrow()
    await expect(f.policy.set(f.child, f.value, true, AbortSignal.abort())).rejects.toThrow()
  })
})
