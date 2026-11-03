import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeCapacity, type RuntimeCapacityLease } from '../src/runtime-capacity.ts'

afterEach(() => { vi.useRealTimers() })
const signal = (): AbortSignal => new AbortController().signal

describe('Runtime process admission', () => {
  it('keeps cold starts bounded when the emergency resident ceiling is disabled', async () => {
    const capacity = new RuntimeCapacity({ maxStarting: 1, maxResident: 0, maxQueued: 1, maxQueueWaitMs: 1000 })
    const first = await capacity.acquire('user:1', signal())
    const second = capacity.acquire('project:2', signal())
    expect(capacity.snapshot()).toMatchObject({ starting: 1, resident: 1, queued: 1 })
    first.ready()
    const next = await second
    next.ready()
    expect(capacity.snapshot()).toMatchObject({ starting: 0, resident: 2, queued: 0 })
    first.release(); next.release()
    capacity.close()
  })

  it('admits FIFO targets within both cold-start and resident limits', async () => {
    const capacity = new RuntimeCapacity({ maxStarting: 1, maxResident: 2, maxQueued: 3, maxQueueWaitMs: 1000 })
    const first = await capacity.acquire('user:1', signal())
    const order: string[] = []
    const second = capacity.acquire('project:2', signal()).then(lease => { order.push('project:2'); return lease })
    const third = capacity.acquire('user:3', signal()).then(lease => { order.push('user:3'); return lease })
    expect(capacity.snapshot()).toMatchObject({ starting: 1, resident: 1, queued: 2, queuedTargetBytes: 15 })
    first.ready()
    const secondLease = await second
    secondLease.ready()
    expect(capacity.snapshot()).toMatchObject({ starting: 0, resident: 2, queued: 1 })
    expect(order).toEqual(['project:2'])
    first.release()
    const thirdLease = await third
    expect(order).toEqual(['project:2', 'user:3'])
    thirdLease.release(); secondLease.release()
    expect(capacity.snapshot()).toMatchObject({ resident: 0, starting: 0, queued: 0, peakStarting: 1, peakResident: 2, admitted: 3 })
  })

  it('bounds a 100-target cold burst before launching any waiting target', async () => {
    const capacity = new RuntimeCapacity({ maxStarting: 2, maxResident: 8, maxQueued: 32, maxQueueWaitMs: 30000 })
    const leases: RuntimeCapacityLease[] = []
    const results = Array.from({ length: 100 }, (_, index) => capacity.acquire(`user:${index}`, signal()).then(
      lease => { leases.push(lease); return 'admitted' },
      error => (error as { reason: string }).reason,
    ))
    await Promise.resolve()
    expect(capacity.snapshot()).toMatchObject({ starting: 2, resident: 2, queued: 32, rejected: 66 })
    for (let index = 0; index < 8; index++) {
      if (index < leases.length) leases[index]!.ready()
      await Promise.resolve()
    }
    expect(capacity.snapshot()).toMatchObject({ resident: 8, starting: 0, queued: 26, peakStarting: 2, peakResident: 8 })
    capacity.close()
    const settled = await Promise.all(results)
    expect(settled.filter(value => value === 'admitted')).toHaveLength(8)
    expect(settled.filter(value => value === 'queue-full')).toHaveLength(66)
    expect(settled.filter(value => value === 'closed')).toHaveLength(26)
    for (const lease of leases) lease.release()
    expect(capacity.snapshot()).toMatchObject({ resident: 0, queued: 0, queuedTargetBytes: 0 })
  })

  it('removes cancelled and expired waits without consuming a process reservation', async () => {
    vi.useFakeTimers()
    const capacity = new RuntimeCapacity({ maxStarting: 1, maxResident: 1, maxQueued: 2, maxQueueWaitMs: 500 })
    const first = await capacity.acquire('user:1', signal())
    const cancel = new AbortController()
    const cancelled = capacity.acquire('user:2', cancel.signal)
    const cancelledCheck = expect(cancelled).rejects.toMatchObject({ reason: 'cancelled' })
    cancel.abort()
    await cancelledCheck
    const expired = capacity.acquire('user:3', signal())
    const expiredCheck = expect(expired).rejects.toMatchObject({ reason: 'timeout' })
    await vi.advanceTimersByTimeAsync(500)
    await expiredCheck
    expect(capacity.snapshot()).toMatchObject({ resident: 1, queued: 0, cancelled: 1, timedOut: 1, wait: { count: 2 } })
    first.release()
    expect(capacity.snapshot().resident).toBe(0)
  })

  it('accounts supervisor survivors above the limit and never releases a replacement through an old lease', async () => {
    const capacity = new RuntimeCapacity({ maxStarting: 1, maxResident: 1, maxQueued: 2, maxQueueWaitMs: 1000 })
    const first = capacity.adopt('project:1')
    const survivor = capacity.adopt('project:2')
    const waiting = capacity.acquire('user:3', signal())
    expect(capacity.snapshot()).toMatchObject({ resident: 2, starting: 0, queued: 1 })
    first.release()
    expect(capacity.snapshot().queued).toBe(1)
    survivor.release()
    const next = await waiting
    next.release()
    const replacement = await capacity.acquire('user:3', signal())
    next.ready(); next.release()
    expect(capacity.snapshot()).toMatchObject({ resident: 1, starting: 1 })
    replacement.release()
  })
})
