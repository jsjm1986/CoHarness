/** Adaptive LISTEN-healthy reconciliation cadence for PostgresAccessMonitor without requiring live PostgreSQL. */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { PostgresAccessMonitor } from '../src/access-invalidation.ts'

class FakeListenerClient extends EventEmitter {
  revision = '1'
  revisionReads = 0
  released = false

  async query(sql: string) {
    if (sql.includes('access_revision')) {
      this.revisionReads += 1
      return {
        rows: [{ access_revision: this.revision, access_applied_revision: this.revision, node_status: 'active' as const }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 1 }
  }

  release(): void {
    this.released = true
  }
}

afterEach(() => { vi.useRealTimers() })

it('backs off periodic polling to healthyPollMs while LISTEN is healthy and wakes immediately on NOTIFY or disconnect', async () => {
  vi.useFakeTimers()
  const clients: FakeListenerClient[] = []
  const pool = {
    connect: async () => {
      const client = new FakeListenerClient()
      clients.push(client)
      return client
    },
  }
  const monitor = new PostgresAccessMonitor(
    { pool: pool as never, organizationId: 'org-1', organizationSlug: 'org', nodeName: 'node-1', nodeId: 'node-1' },
    1_000,
    pool as never,
    10_000,
  )
  monitor.subscribe(() => {})
  try {
    await monitor.synchronize()
    const client = clients[0]!
    expect(monitor.available).toBe(true)
    expect(client.revisionReads).toBe(1)

    // Five 1s ticks inside the 10s healthyPollMs window trigger zero extra DB reads.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.revisionReads).toBe(1)

    // Reaching healthyPollMs triggers one reconciliation read.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(client.revisionReads).toBe(2)

    // A PostgreSQL NOTIFY wakes immediately inside the healthyPollMs window.
    client.emit('notification', { channel: 'harness_access_invalidation', payload: 'org-1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(client.revisionReads).toBe(3)

    // Disconnect immediately drops availability and resumes fast 1s polling.
    client.emit('end')
    expect(monitor.available).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(clients).toHaveLength(2)
    expect(clients[1]!.revisionReads).toBe(1)
    expect(monitor.available).toBe(true)
  } finally {
    await monitor.close()
  }
})
