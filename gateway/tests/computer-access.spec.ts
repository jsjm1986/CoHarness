/** Local consumers exclude other computers while the center retains global cancellation delivery. */
import { expect, it, vi } from 'vitest'
import { scopeAccessMonitor, type AccessInvalidationSubject, type GatewayAccessMonitor } from '../src/access-invalidation.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'

it('isolates computer changes, preserves global revocations and disposes subscriptions independently', async () => {
  const listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
  let available = true
  const synchronize = vi.fn(async () => {})
  const monitor: GatewayAccessMonitor = {
    get available() { return available }, synchronize,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const a = '11111111-1111-4111-8111-111111111111' as RuntimeNodeId
  const b = '22222222-2222-4222-8222-222222222222' as RuntimeNodeId
  const local = scopeAccessMonitor(monitor, a), other = scopeAccessMonitor(monitor, b)
  const localChanged = vi.fn(), otherChanged = vi.fn(), forwarded = vi.fn()
  const releaseLocal = local.subscribe(localChanged), releaseOther = other.subscribe(otherChanged), releaseForwarded = monitor.subscribe(forwarded)
  const publish = async (subject: AccessInvalidationSubject) => { await Promise.all([...listeners].map(listener => listener(subject))) }
  try {
    await publish({ nodeId: b, userId: 7 })
    expect(localChanged).not.toHaveBeenCalled()
    expect(otherChanged).toHaveBeenCalledWith({ nodeId: b, userId: 7 })
    expect(forwarded).toHaveBeenCalledWith({ nodeId: b, userId: 7 })
    await publish({ userId: 7 })
    await publish({})
    expect(localChanged.mock.calls).toEqual([[{ userId: 7 }], [{}]])
    expect(otherChanged).toHaveBeenCalledTimes(3)
    releaseLocal()
    await publish({ nodeId: a, userId: 7 })
    expect(localChanged).toHaveBeenCalledTimes(2)
    expect(otherChanged).toHaveBeenCalledTimes(3)
    await local.synchronize()
    expect(synchronize).toHaveBeenCalledTimes(1)
    available = false
    expect(local.available).toBe(false)
    expect(other.available).toBe(false)
  } finally { releaseLocal(); releaseOther(); releaseForwarded() }
  expect(listeners.size).toBe(0)
})
