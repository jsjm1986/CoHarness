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
  return { ctx, registry, internals: registry as unknown as RegistryInternals }
}

function makeActivation(childId: SessionId, parentSession: SessionId, agent?: Agent): Activation {
  return {
    pool: { reserve: () => () => {} },
    releaseSlot: () => {},
    childId,
    parentSession,
    provider: 'test',
    handle: { agent: agent ?? {} } as unknown as AgentHandle,
    inbox: { closing: undefined },
    ancestry: new WeakSet<Agent>(),
    ownedChildren: new Set<SessionId>(),
    observer: {} as ActivationObserver,
    announced: false,
    poke: Promise.withResolvers(),
  } as unknown as Activation
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
