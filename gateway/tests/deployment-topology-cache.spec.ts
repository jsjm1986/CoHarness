/** Invalidation-coupled caching and single-flight deduplication for PostgresDeploymentTopology.assertNode. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { AccessInvalidationSubject, GatewayAccessMonitor } from '../src/access-invalidation.ts'
import { DeploymentTopologyError, PostgresDeploymentTopology } from '../src/deployment-topology.ts'
import type { RuntimeNodeId } from '../src/runtime-catalog.ts'
import { fixtureQueryPool } from './postgres-query-fixture.ts'

function createMonitor() {
  let available = true
  let revision = 10n
  const listeners = new Set<(subject: AccessInvalidationSubject) => void | Promise<void>>()
  const monitor: GatewayAccessMonitor = {
    get available() { return available },
    synchronize: async () => {},
    currentRevision: () => (available ? revision : undefined),
    subscribe: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    monitor,
    setAvailable: (next: boolean) => { available = next },
    setRevision: (next: bigint) => { revision = next },
    listenerCount: () => listeners.size,
    emit: async (subject: AccessInvalidationSubject) => {
      for (const listener of listeners) await listener(subject)
    },
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(next => { resolve = next })
  return { promise, resolve }
}

it('deduplicates concurrent assertNode checks, caches positive results while LISTEN is healthy, and evicts immediately on node/org invalidation', async () => {
  const localNodeId = randomUUID() as RuntimeNodeId
  const remoteNodeId = randomUUID() as RuntimeNodeId
  const otherNodeId = randomUUID() as RuntimeNodeId
  const ctl = createMonitor()
  let allowed = true
  let queryCount = 0
  let gate: { promise: Promise<void>; resolve: () => void } | undefined

  const context = {
    organizationId: randomUUID(),
    organizationSlug: 'fixture',
    nodeId: localNodeId,
    nodeName: 'center',
    pool: fixtureQueryPool(async () => {
      queryCount += 1
      const row = { allowed }
      await gate?.promise
      return [row]
    }),
  }

  const topology = new PostgresDeploymentTopology(context, {
    legacyForwarding: true,
    refreshAfterMs: 30_000,
    pageSize: 50,
    maxBytes: 65_536,
    allowedOrigins: ['https://center.test'],
    monitor: ctl.monitor,
    assertNodeCacheMs: 5_000,
  })
  try {
    // Local node never queries PG.
    await topology.assertNode(localNodeId)
    expect(queryCount).toBe(0)

    // Concurrent checks for the same remote node coalesce into one PG query.
    gate = deferred()
    const burst = Promise.all([
      topology.assertNode(remoteNodeId),
      topology.assertNode(remoteNodeId),
      topology.assertNode(remoteNodeId),
    ])
    gate.resolve()
    await burst
    expect(queryCount).toBe(1)

    // Subsequent calls hit the positive cache while revision & LISTEN are unchanged.
    await topology.assertNode(remoteNodeId)
    expect(queryCount).toBe(1)

    // User- or project-scoped invalidations do not evict node visibility.
    await ctl.emit({ userId: 42 })
    await ctl.emit({ projectId: 7 })
    await topology.assertNode(remoteNodeId)
    expect(queryCount).toBe(1)

    // Node-scoped invalidation for another node preserves remoteNodeId.
    await ctl.emit({ nodeId: otherNodeId })
    await topology.assertNode(remoteNodeId)
    expect(queryCount).toBe(1)

    // Node-scoped invalidation for remoteNodeId evicts immediately.
    await ctl.emit({ nodeId: remoteNodeId })
    await topology.assertNode(remoteNodeId)
    expect(queryCount).toBe(2)

    // Advancing the organization revision forces a fresh check even without explicit eviction.
    ctl.setRevision(11n)
    await topology.assertNode(remoteNodeId)
    expect(queryCount).toBe(3)

    // Disconnecting LISTEN bypasses the cache completely.
    ctl.setAvailable(false)
    await topology.assertNode(remoteNodeId)
    await topology.assertNode(remoteNodeId)
    expect(queryCount).toBe(5)

    // Rejections are never cached.
    ctl.setAvailable(true)
    allowed = false
    await expect(topology.assertNode(remoteNodeId)).rejects.toThrow(DeploymentTopologyError)
    await expect(topology.assertNode(remoteNodeId)).rejects.toThrow(DeploymentTopologyError)
    expect(queryCount).toBe(7)

    // An invalidation fences an earlier database snapshot and any subsequent callers.
    allowed = true
    const beforeRevocation = deferred()
    gate = beforeRevocation
    const inFlight = expect(topology.assertNode(remoteNodeId)).rejects.toThrow(DeploymentTopologyError)
    await ctl.emit({ nodeId: remoteNodeId })
    allowed = false
    gate = undefined
    const current = expect(topology.assertNode(remoteNodeId)).rejects.toThrow(DeploymentTopologyError)
    beforeRevocation.resolve()
    await Promise.all([inFlight, current])
    expect(queryCount).toBe(9)
    allowed = true
    await topology.assertNode(remoteNodeId)
    expect(queryCount).toBe(10)
  } finally {
    topology.dispose()
    expect(ctl.listenerCount()).toBe(0)
  }
})
