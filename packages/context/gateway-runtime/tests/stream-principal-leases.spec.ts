import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GatewayPrincipalClaims, GatewayRequestPrincipal, GatewayRuntimeCredential } from '../src/index.ts'
import { verifyGatewayPrincipal } from '../src/index.ts'
import { StreamPrincipalLeasePool } from '../src/stream-principal-leases.ts'

function fixture(maxBatchSize = 2) {
  const pair = generateKeyPairSync('ed25519')
  const credential: GatewayRuntimeCredential = {
    version: 1, gatewayUrl: 'http://127.0.0.1:8899', organization: 'acme',
    runtime: { kind: 'user', id: 9, generation: 7 }, token: 'private',
    principalPublicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  }
  let sequence = 0
  const issue = (patch: Partial<GatewayPrincipalClaims> = {}): GatewayRequestPrincipal => {
    const claims: GatewayPrincipalClaims = {
      version: 1, issuer: 'harness-gateway', audience: 'dsh-runtime', organization: 'acme',
      user: { id: 9, username: 'lin', displayName: 'Lin', role: 'user' }, scope: { kind: 'personal' },
      runtime: credential.runtime, issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: `nonce-${++sequence}`, ...patch,
    }
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return { claims, assertion: `${payload}.${sign(null, Buffer.from(payload), pair.privateKey).toString('base64url')}` }
  }
  const unavailable = vi.fn()
  const renew = vi.fn(async (ids: readonly string[], _signal: AbortSignal): Promise<unknown> => ({
    version: 1, leases: ids.map(leaseId => ({ leaseId, status: 'renewed', assertion: issue().assertion })),
  }))
  const pool = new StreamPrincipalLeasePool({
    config: { enabled: true, intervalMs: 10_000, requestTimeoutMs: 5000, maxBatchSize },
    renew, verify: assertion => verifyGatewayPrincipal(assertion, credential), reportUnavailable: unavailable,
  })
  return { issue, renew, unavailable, pool }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
afterEach(() => { vi.useRealTimers() })

describe('event connection principal pool', () => {
  it('renews one owned handle across the original deadline without increasing the signing lifetime', async () => {
    const f = fixture()
    try {
      const original = f.issue()
      const handle = f.pool.open(original, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(35_000)
      expect(f.renew).toHaveBeenCalledTimes(3)
      expect(handle.signal?.aborted).toBe(false)
      expect(handle.claims.expiresAt).toBe(70_000)
      expect(handle.claims.expiresAt - handle.claims.issuedAt).toBe(30_000)
      expect(handle.assertion).not.toBe(original.assertion)
      expect(f.pool.size).toBe(1)
    } finally { await f.pool.close() }
  })

  it('sends at most one bounded batch at a time and schedules the remaining sockets', async () => {
    const f = fixture()
    try {
      for (let i = 0; i < 5; i++) f.pool.open(f.issue(), new AbortController().signal)
      let finish!: (value: unknown) => void
      f.renew.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(f.renew).toHaveBeenCalledTimes(1)
      expect(f.renew.mock.calls[0]![0]).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(100)
      expect(f.renew).toHaveBeenCalledTimes(1)
      finish({ version: 1, leases: f.renew.mock.calls[0]![0].map(leaseId => ({ leaseId, status: 'renewed', assertion: f.issue().assertion })) })
      await vi.advanceTimersByTimeAsync(3)
      expect(f.renew.mock.calls.map(call => call[0].length)).toEqual([2, 2, 1])
      expect(f.pool.size).toBe(5)
    } finally { await f.pool.close() }
  })

  it.each(['rejected', 'lost'] as const)('retains the old signed expiry after a %s response', async (mode) => {
    const f = fixture()
    try {
      const handle = f.pool.open(f.issue(), new AbortController().signal)
      f.renew.mockImplementation((_ids, signal) => mode === 'lost' ? new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('cancelled', { cause: signal.reason })) }, { once: true })
      }) : Promise.reject(new Error('offline')))
      await vi.advanceTimersByTimeAsync(30_000)
      expect(handle.signal?.aborted).toBe(true)
      expect(f.pool.size).toBe(0)
      expect(f.renew).toHaveBeenCalledTimes(1)
      expect(f.unavailable).toHaveBeenCalledTimes(1)
    } finally { await f.pool.close() }
  })

  it.each(['close', 'expiry', 'dispose'] as const)('does not resurrect a socket after %s while a batch is pending', async (mode) => {
    const f = fixture()
    const source = new AbortController()
    const handle = f.pool.open(f.issue(), source.signal)
    let finish!: (value: unknown) => void
    f.renew.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    let closing: Promise<void> | undefined
    try {
      await vi.advanceTimersByTimeAsync(10_000)
      const ids = f.renew.mock.calls[0]![0]
      if (mode === 'close') source.abort()
      else if (mode === 'expiry') await vi.advanceTimersByTimeAsync(20_000)
      else {
        let returned = false
        closing = f.pool.close().then(() => { returned = true })
        await Promise.resolve()
        expect(returned).toBe(false)
        expect(handle.signal?.aborted).toBe(true)
      }
      finish({ version: 1, leases: ids.map(leaseId => ({ leaseId, status: 'renewed', assertion: f.issue().assertion })) })
      await closing
      await vi.advanceTimersByTimeAsync(1)
      expect(handle.signal?.aborted).toBe(true)
      expect(f.pool.size).toBe(0)
      expect(handle.claims.expiresAt).toBe(40_000)
    } finally { await f.pool.close() }
  })

  it('keeps the next batch blocked until a timed-out underlying transport settles', async () => {
    const f = fixture(1)
    let finish!: (value: unknown) => void
    f.renew.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    try {
      f.pool.open(f.issue(), new AbortController().signal)
      f.pool.open(f.issue(), new AbortController().signal)
      await vi.advanceTimersByTimeAsync(15_001)
      expect(f.renew).toHaveBeenCalledTimes(1)
      finish({ version: 1, leases: f.renew.mock.calls[0]![0].map(leaseId => ({ leaseId, status: 'renewed', assertion: f.issue().assertion })) })
      await vi.advanceTimersByTimeAsync(1)
      expect(f.renew).toHaveBeenCalledTimes(2)
    } finally { await f.pool.close() }
  })

  it.each(['denied', 'signature', 'generation', 'role', 'scope', 'purpose', 'long', 'replay', 'nonadvancing', 'expired', 'malformed'] as const)(
    'rejects a %s renewal without applying authority', async (mode) => {
      const f = fixture()
      try {
        const original = f.issue()
        const handle = f.pool.open(original, new AbortController().signal)
        f.renew.mockImplementation(async (ids) => {
          if (mode === 'malformed') return { version: 1, leases: [{ leaseId: 'unknown', status: 'denied' }] }
          if (mode === 'denied') return { version: 1, leases: ids.map(leaseId => ({ leaseId, status: 'denied' })) }
          const patch: Partial<GatewayPrincipalClaims> = mode === 'generation' ? { runtime: { kind: 'user', id: 9, generation: 8 } }
            : mode === 'role' ? { user: { ...original.claims.user, role: 'admin' } }
              : mode === 'scope' ? { scope: { kind: 'project', projectId: 41, projectName: 'P', mode: 'rw' } }
                : mode === 'purpose' ? { purpose: 'webhook-dispatch' }
                  : mode === 'long' ? { expiresAt: Date.now() + 30_001 }
                    : mode === 'nonadvancing' ? { expiresAt: original.claims.expiresAt }
                      : mode === 'expired' ? { issuedAt: Date.now() - 100, expiresAt: Date.now() - 1 } : {}
          let assertion = mode === 'replay' ? original.assertion : f.issue(patch).assertion
          if (mode === 'signature') assertion = `${assertion.split('.')[0]}.AAAA`
          return { version: 1, leases: ids.map(leaseId => ({ leaseId, status: 'renewed', assertion })) }
        })
        await vi.advanceTimersByTimeAsync(10_000)
        expect(handle.signal?.aborted).toBe(true)
        expect(handle.assertion).toBe(original.assertion)
        expect(f.pool.size).toBe(0)
      } finally { await f.pool.close() }
    })

  it('requires a unique ordinary short-lived initial assertion and refuses openings after disposal', async () => {
    const f = fixture()
    try {
      const principal = f.issue()
      f.pool.open(principal, new AbortController().signal)
      expect(() => f.pool.open(principal, new AbortController().signal)).toThrow('already open')
      expect(() => f.pool.open(f.issue({ purpose: 'webhook-dispatch' }), new AbortController().signal)).toThrow('short-lived')
      expect(() => f.pool.open(f.issue({ expiresAt: Date.now() + 30_001 }), new AbortController().signal)).toThrow('short-lived')
      await f.pool.close()
      expect(() => f.pool.open(f.issue(), new AbortController().signal)).toThrow('stopped')
    } finally { await f.pool.close() }
  })
})
