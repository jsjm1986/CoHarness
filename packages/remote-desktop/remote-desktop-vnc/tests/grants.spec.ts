/**
 * Tests for grant matching (machine vs session scope, revocation, expiry,
 * principal/target binding) and the JSONL store's durable round-trip.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { RemoteDesktopError, RemoteDesktopGrantId } from '@deepseek-ai/dsh-remote-desktop'
import type { RemoteDesktopGrant } from '@deepseek-ai/dsh-remote-desktop'
import { matchingGrants, VncGrantStore } from '../src/grants.ts'

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
})
