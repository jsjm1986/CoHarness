/** Management authority is checked independently of profile and tool permissions. */
import { expect, it, vi } from 'vitest'
import type { GatewayRequestPrincipal } from '@deepseek-ai/dsh-gateway-runtime'
import { gatewayPluginManagementAuthorization } from '../src/plugin-management.ts'

function fixture() {
  const principal: GatewayRequestPrincipal = {
    assertion: 'verified-assertion',
    claims: {
      version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: 'acme',
      user: { id: 1, username: 'admin', displayName: 'Admin', role: 'admin' },
      scope: { kind: 'personal' }, runtime: { kind: 'user', id: 1, generation: 1 },
      issuedAt: Date.now(), expiresAt: Date.now() + 60_000, nonce: 'management-test',
    },
  }
  const current = vi.fn<() => GatewayRequestPrincipal | undefined>(() => principal)
  const request = vi.fn(async () => new Response(null, { status: 204 }))
  const lifetime = new AbortController()
  const policy = gatewayPluginManagementAuthorization({ current, request }, lifetime.signal)
  return { principal, current, request, lifetime, policy }
}

it('requires a fresh Gateway decision for every profile operation', async () => {
  const { principal, request, lifetime, policy } = fixture()
  await policy.authorize()
  expect(request).toHaveBeenCalledWith('/internal/runtime/plugin-management/authorize', {
    method: 'POST', principal, signal: lifetime.signal,
  })
  request.mockResolvedValue(new Response('{}', { status: 403 }))
  await expect(policy.authorize()).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
  expect(request).toHaveBeenCalledTimes(2)
  expect(policy.protectedModules).toContain('@deepseek-ai/dsh-model-governance')
  expect(policy.protectedModules).toContain('@deepseek-ai/dsh-directory-guard')
})

it.each(['absent', 'member', 'expired', 'scoped'] as const)('refuses %s authority before contacting the Gateway', async (reason) => {
  const { principal, current, request, policy } = fixture()
  if (reason === 'absent') current.mockReturnValue(undefined)
  if (reason === 'member') principal.claims.user.role = 'user'
  if (reason === 'expired') principal.claims.expiresAt = Date.now()
  if (reason === 'scoped') principal.claims.purpose = 'archive-read'
  await expect(policy.authorize()).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
  expect(request).not.toHaveBeenCalled()
})

it('rejects a retained authority after its provider unloads', async () => {
  const { lifetime, request, policy } = fixture()
  lifetime.abort(new Error('provider stopped'))
  await expect(policy.authorize()).rejects.toThrow('provider stopped')
  expect(request).not.toHaveBeenCalled()
})
