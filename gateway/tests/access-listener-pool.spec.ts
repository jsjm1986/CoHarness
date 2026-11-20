/** Outbox delivery and cancellation retain their own PostgreSQL connection. */
import { Client, Pool } from 'pg'
import { expect, it, vi } from 'vitest'
import { PostgresAccessMonitor } from '../src/access-invalidation.ts'
import { barrier } from './barrier.ts'

it('fences admitted traffic while an earlier Runtime cleanup still holds acknowledgment', async () => {
  let revision = 0, acknowledged = 0
  const fixtureDb = { host: '127.0.0.1', port: 1, database: 'fixture_test', user: 'fixture', password: 'fixture' }
  const business = Object.assign(new Pool(fixtureDb), {
    connect: vi.fn(async () => { throw new Error('Business pool has no free connection') }),
  })
  const listener = Object.assign(new Client(fixtureDb), {
    release: vi.fn(),
    query: vi.fn(async (sql: string, values: string[] = []) => {
      if (sql.includes('set_config') || sql.startsWith('LISTEN')) return { rows: [] }
      if (sql.includes('n.access_applied_revision')) {
        return { rows: [{ access_revision: String(revision), access_applied_revision: String(acknowledged), status: 'active' }] }
      }
      if (sql.startsWith('SELECT access_revision::text')) return { rows: [{ access_revision: String(revision) }] }
      if (sql.includes('FROM harness.outbox')) return {
        rows: Array.from({ length: Number(values[2]) - Number(values[1]) }, (_, index) => {
          const id = Number(values[1]) + index + 1
          return { revision: String(id), subjects: [{ userId: id, restartRuntime: id === 1 }] }
        }),
      }
      if (sql.startsWith('UPDATE ')) { acknowledged = Number(values[2]); return { rowCount: 1 } }
      throw new Error('Unexpected access monitor statement')
    }),
  })
  const control = Object.assign(new Pool(fixtureDb), { connect: vi.fn(async () => listener) })
  const context = { pool: business, organizationId: 'fixture',
    organizationSlug: 'fixture', nodeId: 'node', nodeName: 'fixture-node' }
  const monitor = new PostgresAccessMonitor(context, 60_000, control)
  const entered = barrier(), finish = barrier(), fenced = barrier()
  let secondClosed = false
  monitor.subscribe(async subject => {
    if (subject.userId === 1) {
      entered.resolve()
      await finish.promise
    }
    if (subject.userId === 2 || subject.userId === undefined) secondClosed = true
    if (subject.userId === undefined) fenced.resolve()
  })
  let first: Promise<void> | undefined
  try {
    await monitor.synchronize()
    expect(monitor.available).toBe(true)
    expect(business.connect).not.toHaveBeenCalled()
    expect(control.connect).toHaveBeenCalledOnce()
    revision = 1
    first = monitor.synchronize()
    await entered.promise
    expect(secondClosed).toBe(false)
    await monitor.checkControlReadiness()
    expect(acknowledged).toBe(0)
    revision = 2
    listener.emit('notification', { channel: 'harness_access_invalidation', payload: context.organizationId })
    await fenced.promise
    expect(secondClosed).toBe(true)
    expect(monitor.available).toBe(false)
    await monitor.checkControlReadiness()
    expect(acknowledged).toBe(0)
    finish.resolve()
    await first
    await monitor.synchronize()
    expect(acknowledged).toBe(2)
  } finally {
    finish.resolve()
    await first?.catch(() => undefined)
    await monitor.close()
    await Promise.all([business.end(), control.end()])
  }
  expect(listener.release).toHaveBeenCalledExactlyOnceWith(true)
})
