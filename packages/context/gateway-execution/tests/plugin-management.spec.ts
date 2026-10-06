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

it.each(['absent', 'expired', 'scoped'] as const)('refuses %s authority before contacting the Gateway', async (reason) => {
  const { principal, current, request, policy } = fixture()
  if (reason === 'absent') current.mockReturnValue(undefined)
  if (reason === 'expired') principal.claims.expiresAt = Date.now()
  if (reason === 'scoped') principal.claims.purpose = 'archive-read'
  await expect(policy.authorize()).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
  expect(request).not.toHaveBeenCalled()
})

it('opens reads to every caller while manage still asks the Gateway', async () => {
  const { current, request, policy } = fixture()
  await policy.authorize('read')
  current.mockReturnValue(undefined)
  await policy.authorize('read')
  expect(request).not.toHaveBeenCalled()
  await expect(policy.authorize()).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
  expect(request).not.toHaveBeenCalled()
})

it('reads and publishes the runtime desired state through the plugin-state path', async () => {
  const { request, lifetime, policy } = fixture()
  request.mockResolvedValueOnce(new Response(JSON.stringify({ revision: '4', state: { entries: [], bundles: ['core'] } }), { status: 200 }))
  expect(await policy.readDesiredState!()).toEqual({ revision: '4', state: { entries: [], bundles: ['core'] } })
  expect(request).toHaveBeenLastCalledWith('/internal/runtime/plugin-state', { method: 'GET', signal: lifetime.signal })
  request.mockResolvedValueOnce(new Response(JSON.stringify({ revision: '5' }), { status: 200 }))
  expect(await policy.publishDesiredState!({ entries: [], bundles: ['core'] }, '4')).toEqual({ status: 'applied', revision: '5' })
  expect(request).toHaveBeenLastCalledWith('/internal/runtime/plugin-state', expect.objectContaining({ method: 'POST' }))
  const current = { revision: '7', state: null }
  request.mockResolvedValueOnce(new Response(JSON.stringify(current), { status: 409 }))
  expect(await policy.publishDesiredState!({ entries: [], bundles: ['core'] }, '5')).toEqual({ status: 'conflict', current })
  request.mockResolvedValueOnce(new Response('{}', { status: 503 }))
  await expect(policy.publishDesiredState!({ entries: [], bundles: ['core'] }, '7')).rejects.toThrow('503')
})

it('lets the Gateway judge a member principal, grant or not', async () => {
  const { principal, request, policy } = fixture()
  principal.claims.user.role = 'user'
  await policy.authorize()
  expect(request).toHaveBeenCalledTimes(1)
  request.mockResolvedValue(new Response('{}', { status: 403 }))
  await expect(policy.authorize()).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
  expect(request).toHaveBeenCalledTimes(2)
})

it('rejects a retained authority after its provider unloads', async () => {
  const { lifetime, request, policy } = fixture()
  lifetime.abort(new Error('provider stopped'))
  await expect(policy.authorize()).rejects.toThrow('provider stopped')
  expect(request).not.toHaveBeenCalled()
})

it('accepts the dedicated profile-management assertion and still rechecks the Gateway', async () => {
  const { principal, policy, request } = fixture()
  principal.claims.purpose = 'plugin-admin'
  await policy.authorize()
  expect(request).toHaveBeenCalledTimes(1)
  principal.claims.purpose = 'terminal-admin'
  await expect(policy.authorize()).rejects.toMatchObject({ code: 'plugin-management/forbidden' })
  expect(request).toHaveBeenCalledTimes(1)
})
