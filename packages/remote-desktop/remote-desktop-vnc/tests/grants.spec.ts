/**
 * Tests for grant matching (machine vs session scope, revocation, expiry,
 * principal/target binding) and the JSONL store's durable round-trip.
 */

import { mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteDesktopError, RemoteDesktopGrantId } from '@deepseek-ai/dsh-remote-desktop'
import type { RemoteDesktopGrant } from '@deepseek-ai/dsh-remote-desktop'
import { matchingGrants, VncGrantStore } from '../src/grants.ts'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

const io = vi.hoisted(() => ({ failedDestination: undefined as string | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (args[1] === io.failedDestination) {
        throw Object.assign(new Error('EIO: injected grant publication failure'), { code: 'EIO' })
      }
      return actual.rename(...args)
    },
  }
})

const NOW = 1_000_000

function grant(overrides: Partial<RemoteDesktopGrant> = {}): RemoteDesktopGrant {
  return {
    id: RemoteDesktopGrantId('g1'),
    target: { nodeId: 'n1' },
    principal: 'alice',
    level: 'view',
    scope: { kind: 'machine' },
    recording: false,
    grantedBy: 'admin',
    createdAt: NOW - 1000,
    ...overrides,
  }
}

describe('matchingGrants', () => {
  const target = { nodeId: 'n1' }

  it('matches a machine grant without a session', () => {
    expect(matchingGrants([grant()], 'alice', target, undefined, NOW)).toHaveLength(1)
  })

  it('matches a session grant only for its live session window', () => {
    const sessionGrant = grant({
      id: RemoteDesktopGrantId('g2'),
      scope: { kind: 'session', sessionId: SessionId('s1'), expiresAt: NOW + 100 },
    })
    expect(matchingGrants([sessionGrant], 'alice', target, SessionId('s1'), NOW)).toHaveLength(1)
    expect(matchingGrants([sessionGrant], 'alice', target, SessionId('s2'), NOW)).toHaveLength(0)
    expect(matchingGrants([sessionGrant], 'alice', target, undefined, NOW)).toHaveLength(0)
    expect(matchingGrants([sessionGrant], 'alice', target, SessionId('s1'), NOW + 200)).toHaveLength(0)
  })

  it('excludes revoked, foreign-principal, and foreign-target rows', () => {
    const rows = [
      grant({ id: RemoteDesktopGrantId('a'), revokedAt: NOW - 1 }),
      grant({ id: RemoteDesktopGrantId('b'), principal: 'bob' }),
      grant({ id: RemoteDesktopGrantId('c'), target: { nodeId: 'n2' } }),
      grant({ id: RemoteDesktopGrantId('d'), target: { nodeId: 'n1', desktop: 'left' } }),
    ]
    expect(matchingGrants(rows, 'alice', target, undefined, NOW)).toHaveLength(0)
  })

  it('distinguishes desktop identity within one node', () => {
    const left = grant({ target: { nodeId: 'n1', desktop: 'left' } })
    expect(matchingGrants([left], 'alice', { nodeId: 'n1', desktop: 'left' }, undefined, NOW)).toHaveLength(1)
    expect(matchingGrants([left], 'alice', { nodeId: 'n1' }, undefined, NOW)).toHaveLength(0)
  })
})

describe('VncGrantStore', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-desktop-'))
  })
  afterEach(async () => {
    io.failedDestination = undefined
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips grants through the JSONL file', async () => {
    const file = join(dir, 'grants.jsonl')
    const store = await VncGrantStore.open(file)
    await store.insert(grant())
    const reopened = await VncGrantStore.open(file)
    expect(reopened.all()).toEqual([grant()])
  })

  it('persists partial updates', async () => {
    const file = join(dir, 'grants.jsonl')
    const store = await VncGrantStore.open(file)
    await store.insert(grant())
    await store.update(RemoteDesktopGrantId('g1'), { revokedAt: NOW })
    const reopened = await VncGrantStore.open(file)
    expect(reopened.all()[0]!.revokedAt).toBe(NOW)
  })

  it('preserves an independent writer revocation when another runtime inserts a grant', async () => {
    const file = join(dir, 'grants.jsonl')
    const first = await VncGrantStore.open(file)
    await first.insert(grant())
    const second = await VncGrantStore.open(file)
    await second.refresh()
    await first.update(RemoteDesktopGrantId('g1'), { revokedAt: NOW })
    await second.insert(grant({ id: RemoteDesktopGrantId('g2'), principal: 'bob' }))
    const rows = (await VncGrantStore.open(file)).all()
    expect(rows).toEqual([grant({ revokedAt: NOW }), grant({ id: RemoteDesktopGrantId('g2'), principal: 'bob' })])
    expect(second.all()).toEqual(rows)
    expect(matchingGrants(rows, 'alice', { nodeId: 'n1' }, undefined, NOW)).toEqual([])
  })

  it('preserves independent inserts and revocations when a stale runtime changes another grant level', async () => {
    const file = join(dir, 'grants.jsonl')
    const first = await VncGrantStore.open(file)
    await first.insert(grant())
    await first.insert(grant({ id: RemoteDesktopGrantId('g2'), principal: 'bob' }))
    const second = await VncGrantStore.open(file)
    await second.refresh()
    await first.update(RemoteDesktopGrantId('g1'), { revokedAt: NOW })
    await first.insert(grant({ id: RemoteDesktopGrantId('g3'), principal: 'carol' }))
    expect((await second.update(RemoteDesktopGrantId('g2'), { level: 'control' })).level).toBe('control')
    const rows = (await VncGrantStore.open(file)).all()
    expect(rows.map(row => row.id)).toEqual(['g1', 'g2', 'g3'])
    expect(rows[0]!.revokedAt).toBe(NOW)
    expect(second.all()).toEqual(rows)
  })

  it('keeps failed inserts out of authorization and later durable writes', async () => {
    const file = join(dir, 'grants.jsonl')
    const store = await VncGrantStore.open(file)
    await store.insert(grant())
    await store.refresh()
    io.failedDestination = file
    const rejected = grant({ id: RemoteDesktopGrantId('rejected'), principal: 'bob', level: 'control' })

    await expect(store.insert(rejected)).rejects.toMatchObject({ code: 'EIO' })
    await store.refresh()
    expect(matchingGrants(store.all(), 'bob', rejected.target, undefined, NOW)).toEqual([])
    expect((await VncGrantStore.open(file)).all()).toEqual([grant()])

    io.failedDestination = undefined
    await store.update(RemoteDesktopGrantId('g1'), { recording: true })
    expect((await VncGrantStore.open(file)).all()).toEqual([grant({ recording: true })])
  })

  it('keeps a failed level update out of the live grant set', async () => {
    const file = join(dir, 'grants.jsonl')
    const store = await VncGrantStore.open(file)
    await store.insert(grant())
    io.failedDestination = file

    await expect(store.update(RemoteDesktopGrantId('g1'), { level: 'control' })).rejects.toMatchObject({ code: 'EIO' })
    expect(store.all()).toEqual([grant()])
    expect((await VncGrantStore.open(file)).all()).toEqual([grant()])
  })

  it('commits concurrent inserts in order without losing a row', async () => {
    const file = join(dir, 'grants.jsonl')
    const store = await VncGrantStore.open(file)
    const second = grant({ id: RemoteDesktopGrantId('g2') })
    await Promise.all([store.insert(grant()), store.insert(second)])

    expect(store.all()).toEqual([grant(), second])
    expect((await VncGrantStore.open(file)).all()).toEqual([grant(), second])
  })

  it('opens an absent file as empty and rejects unknown updates', async () => {
    const store = await VncGrantStore.open(join(dir, 'missing.jsonl'))
    expect(store.all()).toEqual([])
    await expect(store.update(RemoteDesktopGrantId('nope'), {})).rejects.toThrow(RemoteDesktopError)
  })

  it('reads pre-seeded rows and skips blank lines', async () => {
    const file = join(dir, 'seeded.jsonl')
    await writeFile(file, `${JSON.stringify(grant())}\n\n`, 'utf8')
    const store = await VncGrantStore.open(file)
    expect(store.all()).toHaveLength(1)
  })

  it('reloads when an external writer replaces the file', async () => {
    const file = join(dir, 'shared.jsonl')
    await writeFile(file, `${JSON.stringify(grant())}\n`, 'utf8')
    const store = await VncGrantStore.open(file)
    expect(store.all()).toHaveLength(1)
    // External writers (the administration surface) replace the file wholesale;
    // a bumped mtime must surface the new rows without a restart.
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeFile(file, `${JSON.stringify(grant())}\n${JSON.stringify(grant({ id: RemoteDesktopGrantId('g2') }))}\n`, 'utf8')
    await store.refresh()
    expect(store.all().map(g => g.id)).toEqual(['g1', 'g2'])
    await store.refresh()
    expect(store.all()).toHaveLength(2)
  })

  it('observes a revoked grant when atomic replacement preserves the modification timestamp', async () => {
    const file = join(dir, 'shared.jsonl'), timestamp = new Date('2020-01-01T00:00:00Z')
    await writeFileAtomic(file, `${JSON.stringify(grant())}\n`, { mode: 0o600 })
    await utimes(file, timestamp, timestamp)
    const store = await VncGrantStore.open(file)
    await store.refresh()
    await writeFileAtomic(file, `${JSON.stringify(grant({ revokedAt: NOW }))}\n`, { mode: 0o600 })
    await utimes(file, timestamp, timestamp)
    await store.refresh()
    expect(store.all()[0]!.revokedAt).toBe(NOW)
    expect(matchingGrants(store.all(), 'alice', { nodeId: 'n1' }, undefined, NOW)).toEqual([])
  })

  it('rejects unreadable file identity without discarding committed grants and recovers after repair', async () => {
    const file = join(dir, 'grants.jsonl')
    await writeFileAtomic(file, `${JSON.stringify(grant())}\n`, { mode: 0o600 })
    const store = await VncGrantStore.open(file)
    await rm(file); await symlink('grants.jsonl', file)
    await expect(store.refresh()).rejects.toThrow()
    expect(store.all()).toEqual([grant()])
    await rm(file)
    await writeFileAtomic(file, `${JSON.stringify(grant({ revokedAt: NOW }))}\n`, { mode: 0o600 })
    await store.refresh()
    expect(store.all()).toEqual([grant({ revokedAt: NOW })])
  })

  it('keeps the last good rows on a corrupt write and retries until it parses', async () => {
    const file = join(dir, 'corruptible.jsonl')
    await writeFile(file, `${JSON.stringify(grant())}\n`, 'utf8')
    const store = await VncGrantStore.open(file)
    expect(store.all()).toHaveLength(1)
    // A truncated external write must fail loudly without discarding the last
    // committed rows, and the unconsumed mtime must retry on the next call.
    await writeFile(file, '{"id":', 'utf8')
    await expect(store.refresh()).rejects.toThrow(RemoteDesktopError)
    expect(store.all()).toHaveLength(1)
    await expect(store.refresh()).rejects.toThrow(RemoteDesktopError)
    expect(store.all()).toHaveLength(1)
    // The next good write recovers without a restart.
    await writeFile(file, `${JSON.stringify(grant({ id: RemoteDesktopGrantId('g9') }))}\n`, 'utf8')
    await store.refresh()
    expect(store.all().map(g => g.id)).toEqual(['g9'])
  })

  it('picks up an external rewrite that lands after its own persist', async () => {
    const file = join(dir, 'self-then-external.jsonl')
    const store = await VncGrantStore.open(file)
    await store.insert(grant())
    // An external writer replacing the file after the store's own persist must
    // still be observed: the self-write must not pre-mark the mtime as seen.
    await new Promise(resolve => setTimeout(resolve, 5))
    await writeFile(file, `${JSON.stringify(grant())}\n${JSON.stringify(grant({ id: RemoteDesktopGrantId('g2') }))}\n`, 'utf8')
    await store.refresh()
    expect(store.all()).toHaveLength(2)
  })
})
