/** Caller-actor resolution for managed and standalone remote-desktop deployments. */
import { Context } from '@deepseek-ai/cordis'
import type { GatewayPrincipalClaims } from '@deepseek-ai/dsh-gateway-runtime'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteDesktopAccess } from '../src/authorization.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })
const signal = (): AbortSignal => new AbortController().signal

function claims(overrides: Partial<GatewayPrincipalClaims['user']> = {}, extra: Partial<GatewayPrincipalClaims> = {}): GatewayPrincipalClaims {
  return {
    version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: 'org',
    user: { id: 1, username: 'alice', displayName: 'Alice', role: 'user', ...overrides },
    scope: { kind: 'personal' }, runtime: { kind: 'user', id: 1, generation: 1 },
    issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000, nonce: 'n', ...extra,
  }
}

function managed(principal: { assertion: string; claims: GatewayPrincipalClaims } | undefined): RemoteDesktopAccess {
  const ctx = new Context()
  roots.push(ctx)
  ctx.provide('executionAuthorityRequired', true as never)
  ctx.provide('gatewayRuntime', { interactive: () => principal } as never)
  return new RemoteDesktopAccess(ctx)
}

describe('RemoteDesktopAccess.actor', () => {
  it('treats the standalone operator as administrator', () => {
    const ctx = new Context()
    roots.push(ctx)
    expect(new RemoteDesktopAccess(ctx).actor(signal())).toEqual({ principal: 'local-operator', admin: true })
  })

  it('resolves the verified username and role for an interactive user', () => {
    const access = managed({ assertion: 'a', claims: claims() })
    expect(access.actor(signal())).toEqual({ principal: 'alice', admin: false })
  })

  it('marks administrator role claims as administrators', () => {
    const access = managed({ assertion: 'a', claims: claims({ username: 'root', role: 'admin' }) })
    expect(access.actor(signal())).toEqual({ principal: 'root', admin: true })
  })

  it('denies requests without an interactive principal', () => {
    expect(() => managed(undefined).actor(signal())).toThrow(RemoteError)
  })

  it('denies restricted-purpose principals', () => {
    const access = managed({ assertion: 'a', claims: claims({}, { purpose: 'webhook-dispatch' }) })
    expect(() => access.actor(signal())).toThrow(RemoteError)
  })

  it('denies expired principals', () => {
    const access = managed({ assertion: 'a', claims: claims({}, { expiresAt: Date.now() - 1 }) })
    expect(() => access.actor(signal())).toThrow(RemoteError)
  })
})
