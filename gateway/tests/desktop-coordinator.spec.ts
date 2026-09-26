import { describe, expect, it, onTestFinished } from 'vitest'
import Database from 'better-sqlite3'
import {
  DEFAULT_DESKTOP_COORDINATOR_CONFIG,
  DesktopCoordinator,
  DesktopCoordinationError,
  SqliteDesktopCoordinatorRepository,
  desktopResourceKey,
} from '../src/desktop-coordinator.ts'
import type { GatewayPrincipalClaims } from '../src/principal.ts'
import type { RuntimeTarget } from '../src/instances.ts'

function claims(over: Partial<{
  runtimeKind: 'user' | 'project'
  runtimeId: number
  generation: number
  userId: number
  projectScope: number
}> = {}): GatewayPrincipalClaims {
  return {
    version: 1,
    issuer: 'harness-gateway',
    audience: 'dsh-runtime',
    organization: 'org',
    user: { id: over.userId ?? 7, username: 'u7', displayName: 'U7', role: 'user' },
    scope: over.projectScope === undefined ? { kind: 'personal' } : { kind: 'project', projectId: over.projectScope, projectName: 'p', mode: 'rw' },
    runtime: { kind: over.runtimeKind ?? 'user', id: over.runtimeId ?? 7, generation: over.generation ?? 1 },
    issuedAt: 0,
    expiresAt: 0,
    nonce: 'n',
  }
}

function harness(options: { now?: () => number; generations?: Record<string, number> } = {}) {
  const db = new Database(':memory:')
  const repo = new SqliteDesktopCoordinatorRepository(db)
  const generations = {
    generationOf: async (target: RuntimeTarget) =>
      options.generations?.[`${target.kind}:${String(target.id)}`] ?? 1,
  }
  let now = 1_000_000
  const coordinator = new DesktopCoordinator(repo, generations, {
    grantTtlMs: 1_000,
    stoppingTtlMs: 2_000,
    queueTtlMs: 5_000,
    queueCapacity: 2,
  }, undefined, options.now ?? (() => now))
  return { db, repo, coordinator, advance: (ms: number) => { now += ms } }
}

const desktop = { node: 'node-a', desktop: 'seat-1' }

describe('DesktopCoordinator', () => {
  it('isolates grant retries, queue cancellation and lease operations by the exact driving Session', async () => {
    const { coordinator, db } = harness()
    onTestFinished(() => { db.close() })
    await coordinator.initialize()
    const c = claims(), resource = { node: 'node-a', desktop: 'seat-1' }
    const first = await coordinator.acquire(c, { ...resource, requestId: 'same-request', runId: 'session-a' })
    expect(first.status).toBe('granted')
    if (first.status !== 'granted') throw new Error('missing desktop grant')
    const second = await coordinator.acquire(c, { ...resource, requestId: 'same-request', runId: 'session-b' })
    expect(second.status).toBe('queued')
    expect(await coordinator.status(c, { ...resource, requestId: 'same-request' })).toEqual({ status: 'unknown' })
    expect(await coordinator.heartbeat(c, first.grantId, 'session-b')).toBe('lost')
    await expect(coordinator.release(c, first.grantId, 'session-b')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(coordinator.confirmStopped(c, first.grantId, 'session-b')).rejects.toMatchObject({ code: 'forbidden' })
    expect(await coordinator.cancel(c, { ...resource, requestId: 'same-request', runId: 'session-a' })).toBe(false)
    expect(await coordinator.heartbeat(c, first.grantId, 'session-a')).toBe('held')
    await coordinator.release(c, first.grantId, 'session-a')
    expect(await coordinator.status(c, { ...resource, requestId: 'same-request', runId: 'session-b' })).toMatchObject({ status: 'granted' })
  })

  it('grants one desktop and serializes a second holder into FIFO order', async () => {
    const { coordinator } = harness()
    await coordinator.initialize()
    const first = await coordinator.acquire(claims({ runtimeId: 7 }), { ...desktop, requestId: 'r1' })
    expect(first.status).toBe('granted')
    const second = await coordinator.acquire(claims({ runtimeKind: 'project', runtimeId: 3, projectScope: 3 }), { ...desktop, requestId: 'r2' })
    expect(second.status).toBe('queued')
    if (second.status === 'queued') expect(second.position).toBe(1)
    const third = await coordinator.acquire(claims({ runtimeId: 9, userId: 9 }), { ...desktop, requestId: 'r3' })
    if (third.status === 'queued') expect(third.position).toBe(2)
  })

  it('is idempotent per (holder, requestId) and shares a grant within one run', async () => {
    const { coordinator } = harness()
    await coordinator.initialize()
    const c = claims({ runtimeId: 7 })
    const first = await coordinator.acquire(c, { ...desktop, requestId: 'r1', runId: 'run-1' })
    expect(first.status).toBe('granted')
    const retry = await coordinator.acquire(c, { ...desktop, requestId: 'r1', runId: 'run-1' })
    expect(retry.status).toBe('held')
    if (first.status === 'granted' && retry.status === 'held') expect(retry.grantId).toBe(first.grantId)
    const sameRun = await coordinator.acquire(c, { ...desktop, requestId: 'r2', runId: 'run-1' })
    expect(sameRun.status).toBe('held')
    const otherRun = await coordinator.acquire(c, { ...desktop, requestId: 'r3', runId: 'run-2' })
    expect(otherRun.status).toBe('queued')
  })

  it('rejects a stale-generation caller', async () => {
    const { coordinator } = harness({ generations: { 'user:7': 5 } })
    await coordinator.initialize()
    await expect(coordinator.acquire(claims({ runtimeId: 7, generation: 4 }), { ...desktop, requestId: 'r1' }))
      .rejects.toMatchObject({ code: 'stale-generation' })
  })

  it('rejects acquisition while the resource is unavailable', async () => {
    const { coordinator, advance } = harness()
    await coordinator.initialize()
    const c = claims({ runtimeId: 7 })
    const grant = await coordinator.acquire(c, { ...desktop, requestId: 'r1' })
    if (grant.status !== 'granted') throw new Error('expected grant')
    advance(1_500)
    await coordinator.sweep()
    advance(2_500)
    await coordinator.sweep()
    await expect(coordinator.acquire(claims({ runtimeId: 9, userId: 9 }), { ...desktop, requestId: 'r9' }))
      .rejects.toMatchObject({ code: 'unavailable' })
  })

  it('caps the queue at the configured capacity', async () => {
    const { coordinator } = harness()
    await coordinator.initialize()
    await coordinator.acquire(claims({ runtimeId: 7 }), { ...desktop, requestId: 'r1' })
    await coordinator.acquire(claims({ runtimeId: 8, userId: 8 }), { ...desktop, requestId: 'r2' })
    await coordinator.acquire(claims({ runtimeId: 9, userId: 9 }), { ...desktop, requestId: 'r3' })
    await expect(coordinator.acquire(claims({ runtimeId: 10, userId: 10 }), { ...desktop, requestId: 'r4' }))
      .rejects.toMatchObject({ code: 'queue-full' })
  })

  it('cancels a queued request and promotes the next in FIFO order', async () => {
    const { coordinator } = harness()
    await coordinator.initialize()
    const holder = claims({ runtimeId: 7 })
    const first = await coordinator.acquire(holder, { ...desktop, requestId: 'r1' })
    if (first.status !== 'granted') throw new Error('expected grant')
    const waiterA = claims({ runtimeId: 8, userId: 8 })
    const waiterB = claims({ runtimeId: 9, userId: 9 })
    await coordinator.acquire(waiterA, { ...desktop, requestId: 'ra' })
    await coordinator.acquire(waiterB, { ...desktop, requestId: 'rb' })
    expect(await coordinator.cancel(waiterA, { ...desktop, requestId: 'ra' })).toBe(true)
    await coordinator.release(holder, first.grantId)
    const promoted = await coordinator.status(waiterB, { ...desktop, requestId: 'rb' })
    expect(promoted.status).toBe('granted')
  })

  it('promotes the FIFO head on release', async () => {
    const { coordinator } = harness()
    await coordinator.initialize()
    const holder = claims({ runtimeId: 7 })
    const first = await coordinator.acquire(holder, { ...desktop, requestId: 'r1' })
    if (first.status !== 'granted') throw new Error('expected grant')
    const waiter = claims({ runtimeKind: 'project', runtimeId: 3, projectScope: 3 })
    await coordinator.acquire(waiter, { ...desktop, requestId: 'r2' })
    await coordinator.release(holder, first.grantId)
    const promoted = await coordinator.status(waiter, { ...desktop, requestId: 'r2' })
    if (promoted.status !== 'granted') throw new Error('expected promotion')
    expect(promoted.fencing).toBe(first.fencing + 1)
  })

  it('drops a stale-generation queue entry at promotion instead of granting', async () => {
    const generations: Record<string, number> = { 'user:7': 1, 'user:8': 1 }
    const { coordinator } = harness({ generations })
    await coordinator.initialize()
    const holder = claims({ runtimeId: 7 })
    const first = await coordinator.acquire(holder, { ...desktop, requestId: 'r1' })
    if (first.status !== 'granted') throw new Error('expected grant')
    const waiter = claims({ runtimeId: 8, userId: 8, generation: 1 })
    await coordinator.acquire(waiter, { ...desktop, requestId: 'r2' })
    generations['user:8'] = 2
    await coordinator.release(holder, first.grantId)
    expect((await coordinator.status(waiter, { ...desktop, requestId: 'r2' })).status).toBe('expired')
    const fresh = await coordinator.acquire(claims({ runtimeId: 9, userId: 9 }), { ...desktop, requestId: 'r9' })
    expect(fresh.status).toBe('granted')
  })

  it('moves heartbeat loss to stopping, then pending-confirm with the resource unavailable', async () => {
    const { coordinator, repo, advance } = harness()
    await coordinator.initialize()
    const c = claims({ runtimeId: 7 })
    const grant = await coordinator.acquire(c, { ...desktop, requestId: 'r1' })
    if (grant.status !== 'granted') throw new Error('expected grant')
    expect(await coordinator.heartbeat(c, grant.grantId)).toBe('held')
    advance(1_500)
    await coordinator.sweep()
    expect((await repo.snapshot(desktopResourceKey(desktop))).grants[0]?.state).toBe('stopping')
    expect(await coordinator.heartbeat(c, grant.grantId)).toBe('stopping')
    advance(2_500)
    await coordinator.sweep()
    const snap = await repo.snapshot(desktopResourceKey(desktop))
    expect(snap.grants[0]?.state).toBe('pending-confirm')
    expect(snap.resource?.state).toBe('unavailable')
  })

  it('releases through confirm-stopped and promotes the queue head', async () => {
    const { coordinator, advance } = harness()
    await coordinator.initialize()
    const c = claims({ runtimeId: 7 })
    const grant = await coordinator.acquire(c, { ...desktop, requestId: 'r1' })
    if (grant.status !== 'granted') throw new Error('expected grant')
    const waiter = claims({ runtimeId: 8, userId: 8 })
    await coordinator.acquire(waiter, { ...desktop, requestId: 'r2' })
    advance(1_500)
    await coordinator.sweep()
    await coordinator.confirmStopped(c, grant.grantId)
    const promoted = await coordinator.status(waiter, { ...desktop, requestId: 'r2' })
    expect(promoted.status).toBe('granted')
  })

  it('keeps the resource blocked until an admin clears an unconfirmable stop', async () => {
    const { coordinator, repo, advance } = harness()
    await coordinator.initialize()
    const c = claims({ runtimeId: 7 })
    const grant = await coordinator.acquire(c, { ...desktop, requestId: 'r1' })
    if (grant.status !== 'granted') throw new Error('expected grant')
    advance(4_000)
    await coordinator.sweep()
    advance(2_500)
    await coordinator.sweep()
    await expect(coordinator.acquire(claims({ runtimeId: 9, userId: 9 }), { ...desktop, requestId: 'r9' }))
      .rejects.toMatchObject({ code: 'unavailable' })
    await coordinator.clearUnavailable(desktop, { userId: 1 })
    expect((await repo.snapshot(desktopResourceKey(desktop))).resource?.state).toBe('available')
    const fresh = await coordinator.acquire(claims({ runtimeId: 9, userId: 9 }), { ...desktop, requestId: 'r9' })
    expect(fresh.status).toBe('granted')
  })

  it('revokes a held grant and waits for confirmation before release', async () => {
    const { coordinator, repo } = harness()
    await coordinator.initialize()
    const c = claims({ runtimeId: 7 })
    const grant = await coordinator.acquire(c, { ...desktop, requestId: 'r1' })
    if (grant.status !== 'granted') throw new Error('expected grant')
    await coordinator.revoke(grant.grantId, { userId: 1 })
    expect(await coordinator.heartbeat(c, grant.grantId)).toBe('stopping')
    expect((await repo.snapshot(desktopResourceKey(desktop))).grants[0]?.reason).toBe('revoked')
    await coordinator.confirmStopped(c, grant.grantId)
    expect((await repo.snapshot(desktopResourceKey(desktop))).grants[0]?.state).toBe('released')
  })

  it('reconciles across a coordinator restart instead of clearing records', async () => {
    const db = new Database(':memory:')
    const repo = new SqliteDesktopCoordinatorRepository(db)
    const generations = { generationOf: async () => 1 }
    let now = 1_000_000
    const first = new DesktopCoordinator(repo, generations, DEFAULT_DESKTOP_COORDINATOR_CONFIG, undefined, () => now)
    await first.initialize()
    const c = claims({ runtimeId: 7 })
    const grant = await first.acquire(c, { ...desktop, requestId: 'r1' })
    if (grant.status !== 'granted') throw new Error('expected grant')
    now += DEFAULT_DESKTOP_COORDINATOR_CONFIG.grantTtlMs + 500
    const restarted = new DesktopCoordinator(repo, generations, DEFAULT_DESKTOP_COORDINATOR_CONFIG, undefined, () => now)
    await restarted.initialize()
    const snap = await repo.snapshot(desktopResourceKey(desktop))
    expect(snap.grants[0]?.state).toBe('stopping')
    const queued = await restarted.acquire(claims({ runtimeId: 8, userId: 8 }), { ...desktop, requestId: 'r2' })
    expect(queued.status).toBe('queued')
    await restarted.confirmStopped(c, grant.grantId)
    expect((await restarted.status(claims({ runtimeId: 8, userId: 8 }), { ...desktop, requestId: 'r2' })).status).toBe('granted')
  })

  it('expires queue entries past the wait TTL', async () => {
    const { coordinator, advance } = harness()
    await coordinator.initialize()
    await coordinator.acquire(claims({ runtimeId: 7 }), { ...desktop, requestId: 'r1' })
    const waiter = claims({ runtimeId: 8, userId: 8 })
    await coordinator.acquire(waiter, { ...desktop, requestId: 'r2' })
    advance(6_000)
    await coordinator.sweep()
    expect((await coordinator.status(waiter, { ...desktop, requestId: 'r2' })).status).toBe('expired')
  })

  it('forbids release and confirm-stopped from a different holder', async () => {
    const { coordinator } = harness()
    await coordinator.initialize()
    const grant = await coordinator.acquire(claims({ runtimeId: 7 }), { ...desktop, requestId: 'r1' })
    if (grant.status !== 'granted') throw new Error('expected grant')
    const other = claims({ runtimeId: 8, userId: 8 })
    await expect(coordinator.release(other, grant.grantId)).rejects.toBeInstanceOf(DesktopCoordinationError)
    await expect(coordinator.confirmStopped(other, grant.grantId)).rejects.toBeInstanceOf(DesktopCoordinationError)
  })
})
