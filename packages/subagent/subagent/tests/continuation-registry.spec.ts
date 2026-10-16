import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  ContinuableActivationRegistry,
  type Activation,
} from '../src/continuation-activation.ts'
import type { ActivationObserver } from '../src/lifecycle.ts'

/** Private residency surface reachable only through the public operations' races. */
interface RegistryInternals {
  readonly resident: Map<SessionId, Activation>
  readonly childOwners: Map<SessionId, Activation>
  readonly materializations: Set<{ readonly lineage: readonly Agent[]; readonly settled: Promise<void> }>
  reserveActivation(parentSession: SessionId): { transfer(): void; release(): void }
  removeActivation(activation: Activation): void
  acquireOwnership(parent: Agent, childId: SessionId): void
  releaseOwnership(childId: SessionId): void
}

function makeRegistry(limits = { maxActivations: 8, maxActivationsPerParent: 4 }): {
  ctx: Context
  registry: ContinuableActivationRegistry
  internals: RegistryInternals
} {
  const ctx = new Context()
  const registry = new ContinuableActivationRegistry(
    ctx,
    () => ({}) as ActivationObserver,
    () => limits,
    () => 8,
  )
  return { ctx, registry, internals: registry as never }
}

function makeActivation(childId: SessionId, parentSession: SessionId, agent?: Agent): Activation {
  return {
    pool: { reserve: () => () => {} },
    releaseSlot: () => {},
    childId,
    parentSession,
    provider: 'test',
    handle: { agent: agent ?? {} } as never,
    inbox: { closing: undefined },
    ancestry: new WeakSet<Agent>(),
    ownedChildren: new Set<SessionId>(),
    observer: {} as ActivationObserver,
    announced: false,
    poke: Promise.withResolvers(),
  } as never
}

describe('continuable activation registry internals', () => {
  it('rejects quota reservation reuse once it leaves the pending state', () => {
    const { internals } = makeRegistry()
    const transferred = internals.reserveActivation(SessionId('p1'))
    transferred.transfer()
    expect(() => { transferred.transfer() }).toThrow('quota reservation is not pending')
    expect(() => { transferred.release() }).not.toThrow()

    const released = internals.reserveActivation(SessionId('p2'))
    released.release()
    expect(() => { released.release() }).not.toThrow()
    expect(() => { released.transfer() }).toThrow('quota reservation is not pending')
  })

  it('ignores removal of a non-resident activation and tolerates a missing parent count', () => {
    const { internals } = makeRegistry()
    const stale = makeActivation(SessionId('child-1'), SessionId('parent-1'))
    internals.removeActivation(stale)
    expect(internals.resident.size).toBe(0)

    internals.resident.set(stale.childId, stale)
    internals.removeActivation(stale)
    expect(internals.resident.size).toBe(0)
  })

  it('rejects a child already owned by another live activation', () => {
    const { internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const owner = makeActivation(parent.id, SessionId('grandparent'))
    const other = makeActivation(SessionId('other'), SessionId('grandparent'))
    internals.resident.set(parent.id, owner)
    internals.childOwners.set(SessionId('child-1'), other)
    expect(() => { internals.acquireOwnership(parent, SessionId('child-1')) })
      .toThrow('already owned by another activation')
  })

  it('releases ownership without waking an owner whose set no longer holds the child', () => {
    const { internals } = makeRegistry()
    const owner = makeActivation(SessionId('owner-1'), SessionId('parent-1'))
    internals.childOwners.set(SessionId('child-1'), owner)
    expect(() => { internals.releaseOwnership(SessionId('child-1')) }).not.toThrow()
    expect(internals.childOwners.size).toBe(0)
  })

  it('runs a held ownership releaser once even when invoked repeatedly', () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const owner = makeActivation(parent.id, SessionId('grandparent'), parent)
    internals.resident.set(parent.id, owner)

    const release = registry.holdOwnership(parent, SessionId('child-1'))
    expect(owner.ownedChildren.has(SessionId('child-1'))).toBe(true)
    release()
    expect(owner.ownedChildren.size).toBe(0)
    release()
    expect(owner.ownedChildren.size).toBe(0)
  })
})

describe('waitForChildren', () => {
  function runningActivation(childId: SessionId, parent: Agent, overrides: {
    status?: 'running' | 'idle'
    hasPending?: boolean
    closing?: Promise<void>
    ownedChildren?: readonly SessionId[]
    onWhenIdle?: () => void
  } = {}): Activation {
    const activation = makeActivation(childId, parent.id)
    const agent = {
      id: childId,
      get status() { return overrides.status ?? 'idle' },
      whenIdle: () => { overrides.onWhenIdle?.(); return Promise.resolve() },
    } as Partial<Agent> as Agent
    activation.ancestry.add(parent)
    return {
      ...activation,
      handle: { agent } as Partial<AgentHandle> as AgentHandle,
      inbox: { closing: overrides.closing, hasPending: overrides.hasPending ?? false },
      ownedChildren: new Set(overrides.ownedChildren ?? []),
    } as Activation
  }

  it('returns false immediately with no descendants', async () => {
    const { registry } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    await expect(registry.waitForChildren(parent)).resolves.toBe(false)
  })

  it('parks an idle child whose inbox still holds queued work', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    internals.resident.set(SessionId('child-1'), runningActivation(SessionId('child-1'), parent, { hasPending: true }))
    await expect(registry.waitForChildren(parent)).resolves.toBe(false)
  })

  it('joins a busy descendant and reports observed work', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const child = runningActivation(SessionId('child-1'), parent, {
      status: 'running',
      onWhenIdle: () => { internals.resident.delete(SessionId('child-1')) },
    })
    internals.resident.set(child.childId, child)
    await expect(registry.waitForChildren(parent)).resolves.toBe(true)
  })

  it('joins a closing descendant through its close transaction', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const closing = Promise.withResolvers<undefined>()
    internals.resident.set(SessionId('child-1'), runningActivation(SessionId('child-1'), parent, { closing: closing.promise }))
    const wait = registry.waitForChildren(parent)
    closing.resolve(undefined)
    internals.resident.delete(SessionId('child-1'))
    await expect(wait).resolves.toBe(true)
  })

  it('absorbs a closing descendant whose close transaction rejects', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const closing = Promise.withResolvers<undefined>()
    internals.resident.set(SessionId('child-1'), runningActivation(SessionId('child-1'), parent, { closing: closing.promise }))
    const wait = registry.waitForChildren(parent)
    closing.promise.catch(() => undefined)
    closing.reject(new Error('close failed'))
    internals.resident.delete(SessionId('child-1'))
    await expect(wait).resolves.toBe(true)
  })

  it('joins an in-flight materialization through its settlement', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const settled = Promise.withResolvers<undefined>()
    const materialization = { lineage: [parent], settled: settled.promise }
    internals.materializations.add(materialization)
    const wait = registry.waitForChildren(parent)
    settled.resolve(undefined)
    internals.materializations.delete(materialization)
    await expect(wait).resolves.toBe(true)
  })

  it('keeps an unrelated in-flight materialization out of the join set', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const other = { id: SessionId('other-1') } as Agent
    internals.materializations.add({ lineage: [other], settled: new Promise<void>(() => {}) })
    await expect(registry.waitForChildren(parent)).resolves.toBe(false)
    internals.materializations.clear()
  })

  it('joins a descendant published while the parent was idle', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    internals.resident.set(SessionId('child-1'), runningActivation(SessionId('child-1'), parent, {
      hasPending: true,
      onWhenIdle: () => {
        internals.resident.set(SessionId('child-2'), runningActivation(SessionId('child-2'), parent, {
          status: 'running',
          onWhenIdle: () => { internals.resident.clear() },
        }))
      },
    }))
    await expect(registry.waitForChildren(parent)).resolves.toBe(true)
  })

  it('parks on an owned child whose publication has not landed', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const child = runningActivation(SessionId('child-1'), parent, { ownedChildren: [SessionId('grand-1')] })
    internals.resident.set(child.childId, child)
    const wait = registry.waitForChildren(parent)
    child.poke.resolve(undefined)
    internals.resident.delete(child.childId)
    await expect(wait).resolves.toBe(true)
  })

  it('joins a materialization admitted while the parent looked idle', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    let wakes = 0
    internals.resident.set(SessionId('child-1'), runningActivation(SessionId('child-1'), parent, {
      hasPending: true,
      onWhenIdle: () => {
        wakes += 1
        if (wakes === 1) internals.materializations.add({ lineage: [parent], settled: Promise.resolve() })
        else internals.materializations.clear()
      },
    }))
    await expect(registry.waitForChildren(parent)).resolves.toBe(true)
  })

  it('does not park on an owned child whose publication already landed', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const grand = makeActivation(SessionId('grand-1'), SessionId('child-1'))
    internals.resident.set(grand.childId, grand)
    const child = runningActivation(SessionId('child-1'), parent, { ownedChildren: [grand.childId] })
    internals.resident.set(child.childId, child)
    await expect(registry.waitForChildren(parent)).resolves.toBe(false)
  })

  it('parks on an idle descendant until its next wake', async () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    const child = runningActivation(SessionId('child-1'), parent)
    internals.resident.set(child.childId, child)
    const wait = registry.waitForChildren(parent)
    child.poke.resolve(undefined)
    internals.resident.delete(child.childId)
    await expect(wait).resolves.toBe(true)
  })
})

describe('hasPendingDirectChildren', () => {
  it('reports an in-flight materialization or a resident child of the parent', () => {
    const { registry, internals } = makeRegistry()
    const parent = { id: SessionId('parent-1') } as Agent
    expect(registry.hasPendingDirectChildren(parent)).toBe(false)

    const materialization = { lineage: [parent], settled: new Promise<void>(() => {}) }
    internals.materializations.add(materialization)
    expect(registry.hasPendingDirectChildren(parent)).toBe(true)
    internals.materializations.delete(materialization)

    internals.resident.set(SessionId('child-1'), makeActivation(SessionId('child-1'), parent.id))
    expect(registry.hasPendingDirectChildren(parent)).toBe(true)
    internals.resident.clear()
    expect(registry.hasPendingDirectChildren(parent)).toBe(false)
  })
})
