/** Socket ownership, revocation races and bounded private renewal. */
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayPrincipalSigner } from '../src/principal.ts'
import { StreamPrincipalLeases, StreamPrincipalRequestError } from '../src/stream-principal-leases.ts'
import type { GatewayRequestContext } from '../src/server.ts'
import type { StreamSessionQualification, UserRow } from '../src/auth.ts'

const user: UserRow = { id: 7, username: 'synthetic', displayName: 'Synthetic', role: 'user', status: 'active',
  homePath: '/synthetic/home', mustChangePassword: false, autoReviewEligible: false }
const runtime = { target: { kind: 'user' as const, id: 7 }, generation: 2 }

function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(10_000)
  const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'synthetic-org', 30_000)
  const context: GatewayRequestContext = { user, scope: { kind: 'personal' }, runtime: user }
  const qualify = vi.fn(async (): Promise<(StreamSessionQualification & { scope: { kind: 'personal' } }) | null> =>
    ({ user, scope: { kind: 'personal' }, expiresAt: 100_000 }))
  const synchronize = vi.fn(async () => {})
  const registry = new StreamPrincipalLeases({ signer, qualify, synchronize, maxBatchSize: 2 })
  const register = () => {
    const assertion = signer.issueStream({ user, scope: context.scope,
      runtime: { kind: 'user', id: 7, generation: 2 } })
    const signal = new AbortController()
    const cancel = vi.fn(() => { signal.abort() })
    registry.register({ assertion, token: 'synthetic-login', context, signal: signal.signal, cancel })
    return { id: signer.verify(assertion).nonce, signal, cancel, assertion }
  }
  return { registry, register, signer, qualify, synchronize }
}

afterEach(() => { vi.useRealTimers() })

describe('registered event principal renewal', () => {
  it('merges same-session/target qualification and issues new signatures capped at 30 seconds', async () => {
    const f = fixture()
    try {
      const first = f.register(), second = f.register()
      vi.setSystemTime(20_000)
      const result = await f.registry.renew(runtime, { version: 1, leaseIds: [first.id, second.id] }, async () => true)
      expect(f.qualify).toHaveBeenCalledTimes(1)
      expect(f.synchronize).toHaveBeenCalledTimes(2)
      expect(result.leases.every(lease => lease.status === 'renewed')).toBe(true)
      for (const lease of result.leases) if (lease.status === 'renewed') {
        expect(f.signer.verify(lease.assertion)).toMatchObject({ issuedAt: 20_000, expiresAt: 50_000 })
      }
      expect(first.cancel).not.toHaveBeenCalled()
    } finally { f.registry.close() }
  })

  it('cannot renew an HTTP assertion, unknown registration, foreign target or generation', async () => {
    const f = fixture()
    try {
      const socket = f.register()
      const http = f.signer.verify(f.signer.issue({ user, scope: { kind: 'personal' }, runtime: { kind: 'user', id: 7, generation: 2 } }))
      expect((await f.registry.renew(runtime, { version: 1, leaseIds: [http.nonce] }, async () => true)).leases)
        .toEqual([{ leaseId: http.nonce, status: 'denied' }])
      for (const other of [{ ...runtime, generation: 3 }, { ...runtime, target: { kind: 'user' as const, id: 8 } }]) {
        expect((await f.registry.renew(other, { version: 1, leaseIds: [socket.id] }, async () => true)).leases[0]?.status).toBe('denied')
      }
      expect(f.qualify).not.toHaveBeenCalled()
      expect(socket.cancel).not.toHaveBeenCalled()
    } finally { f.registry.close() }
  })

  it.each(['role', 'login', 'expiry', 'runtime'] as const)('closes the socket after %s eligibility changes', async kind => {
    const f = fixture()
    try {
      const socket = f.register()
      vi.setSystemTime(20_000)
      if (kind === 'role') f.qualify.mockResolvedValue({ user: { ...user, role: 'admin' }, scope: { kind: 'personal' }, expiresAt: 100_000 })
      if (kind === 'login') f.qualify.mockResolvedValue(null)
      if (kind === 'expiry') f.qualify.mockResolvedValue({ user, scope: { kind: 'personal' }, expiresAt: 20_000 })
      const result = await f.registry.renew(runtime, { version: 1, leaseIds: [socket.id] }, async () => kind !== 'runtime')
      expect(result.leases).toEqual([{ leaseId: socket.id, status: 'denied' }])
      expect(socket.cancel).toHaveBeenCalledOnce()
      expect(f.registry.size).toBe(0)
    } finally { f.registry.close() }
  })

  it.each(['unchanged', 'mode', 'manage', 'name', 'theme'] as const)('retains only the original project permission snapshot: %s', async change => {
    vi.useFakeTimers(); vi.setSystemTime(10_000)
    const signer = new GatewayPrincipalSigner(generateKeyPairSync('ed25519').privateKey, 'synthetic-org', 30_000)
    const scope = { kind: 'project' as const, projectId: 19, projectName: 'Synthetic', mode: 'rw' as const,
      canManage: false, uiThemePolicy: 'dark' as const }
    const context: GatewayRequestContext = { user, scope, runtime: { kind: 'project', id: 19, name: 'Synthetic', path: '/synthetic/project' } }
    const currentScope = change === 'mode' ? { ...scope, mode: 'ro' as const }
      : change === 'manage' ? { ...scope, canManage: true }
        : change === 'name' ? { ...scope, projectName: 'Renamed' }
          : change === 'theme' ? { ...scope, uiThemePolicy: 'light' as const } : { ...scope }
    const registry = new StreamPrincipalLeases({ signer, maxBatchSize: 2, synchronize: async () => {},
      qualify: async () => ({ user, scope: currentScope, expiresAt: 100_000 }) })
    const source = new AbortController()
    const cancel = vi.fn(() => { source.abort() })
    const assertion = signer.issueStream({ user, scope, runtime: { kind: 'project', id: 19, generation: 2 } })
    const id = signer.verify(assertion).nonce
    try {
      registry.register({ assertion, token: 'synthetic-login', context, signal: source.signal, cancel })
      vi.setSystemTime(20_000)
      const reply = await registry.renew({ target: { kind: 'project', id: 19 }, generation: 2 }, { version: 1, leaseIds: [id] }, async () => true)
      expect(reply.leases[0]?.status).toBe(change === 'unchanged' ? 'renewed' : 'denied')
      expect(cancel).toHaveBeenCalledTimes(change === 'unchanged' ? 0 : 1)
    } finally { registry.close() }
  })

  it('does not extend the original login deadline', async () => {
    const f = fixture()
    try {
      const socket = f.register()
      vi.setSystemTime(20_000)
      f.qualify.mockResolvedValue({ user, scope: { kind: 'personal' }, expiresAt: 42_000 })
      const result = await f.registry.renew(runtime, { version: 1, leaseIds: [socket.id] }, async () => true)
      const replacement = result.leases[0]!
      expect(replacement.status).toBe('renewed')
      if (replacement.status === 'renewed') expect(f.signer.verify(replacement.assertion).expiresAt).toBe(42_000)
      await vi.advanceTimersByTimeAsync(22_000)
      expect(socket.cancel).toHaveBeenCalledOnce()
    } finally { f.registry.close() }
  })

  it.each(['close', 'registry-close', 'expire', 'monitor'] as const)('cannot revive a socket after %s while qualification waits', async kind => {
    const f = fixture()
    let resolve!: (value: StreamSessionQualification & { scope: { kind: 'personal' } }) => void
    try {
      const socket = f.register()
      const entered = new Promise<void>(ready => { f.qualify.mockImplementationOnce(() => {
        ready()
        return new Promise(done => { resolve = done })
      }) })
      const renewal = f.registry.renew(runtime, { version: 1, leaseIds: [socket.id] }, async () => true)
      await entered
      if (kind === 'close') socket.signal.abort()
      if (kind === 'registry-close') f.registry.close()
      if (kind === 'expire') await vi.advanceTimersByTimeAsync(30_000)
      if (kind === 'monitor') {
        socket.signal.abort()
        f.synchronize.mockRejectedValueOnce(new Error('monitor disconnected'))
      }
      resolve({ user, scope: { kind: 'personal' }, expiresAt: 100_000 })
      if (kind === 'monitor') await expect(renewal).rejects.toThrow('monitor disconnected')
      else expect((await renewal).leases).toEqual([{ leaseId: socket.id, status: 'denied' }])
      expect(f.registry.size).toBe(0)
    } finally { f.registry.close() }
  })

  it('rechecks runtime generation after the qualification barrier', async () => {
    const f = fixture()
    try {
      const socket = f.register()
      let generation = 2
      f.qualify.mockImplementationOnce(async () => {
        generation = 3
        return { user, scope: { kind: 'personal' }, expiresAt: 100_000 }
      })
      expect((await f.registry.renew(runtime, { version: 1, leaseIds: [socket.id] }, async () => generation === 2)).leases[0]?.status).toBe('denied')
    } finally { f.registry.close() }
  })

  it.each([null, {}, { version: 1, leaseIds: [] }, { version: 1, leaseIds: ['a', 'a'] },
    { version: 1, leaseIds: ['a', 'b', 'c'] }, { version: 1, leaseIds: ['a'], userId: 7 }])('rejects malformed or unbounded batches before qualification: %j', async request => {
    const f = fixture()
    try {
      await expect(f.registry.renew(runtime, request, async () => true)).rejects.toBeInstanceOf(StreamPrincipalRequestError)
      expect(f.qualify).not.toHaveBeenCalled()
      expect(f.synchronize).not.toHaveBeenCalled()
    } finally { f.registry.close() }
  })
})
