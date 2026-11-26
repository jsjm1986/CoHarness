/** Recovery checks retained receipts without requiring deleted tasks or unbounded delivery history. */
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readProjectScheduleWitness } from '../src/peer-backup-takeover-schedule.ts'
import type { NodeContentBinding } from '../src/node-content-store.ts'
import { fixtureQueryClient } from './postgres-query-fixture.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'hgw-schedule-witness-')))
  roots.push(root)
  const storage = join(root, 'storage')
  await mkdir(storage)
  const physical = await lstat(storage, { bigint: true })
  const binding: NodeContentBinding = { organizationId: randomUUID(), projectId: randomUUID(), runtimeId: randomUUID() as NodeContentBinding['runtimeId'],
    nodeId: randomUUID(), volumeId: randomUUID(), writerEpoch: '1' }
  const session = randomUUID(), message = randomUUID(), older = randomUUID(), taskId = randomUUID()
  const delivered = '2026-01-01T00:00:00.000Z', next = '2026-02-01T00:00:00.000Z'
  const receipt = { scheduledAt: delivered, deliveredAt: delivered, messageId: message }
  const task = { sessionId: session, status: 'active',
    record: { id: taskId, kind: 'every', title: 'Report', prompt: 'Prepare the report.', everySeconds: 600, scheduledAt: next },
    lastDelivery: receipt, deliveryHistory: { records: [receipt], earlierRecordsUnavailable: false, earlierRecordsPruned: false } }
  const rows = [
    { session_id: session, message_id: older, at: Date.parse(delivered) - 600000 },
    { session_id: session, message_id: message, at: Date.parse(delivered) },
  ]
  // The real on-disk domain and installed decoder are used; only the two database reads are supplied here.
  const db = fixtureQueryClient(sql => sql.includes('project_file_anchors')
    ? [{ path: storage, anchor_path: storage, device: String(physical.dev), inode: String(physical.ino), missing: false }]
    : rows)
  const save = (tasks: Record<string, unknown>) => writeFile(join(storage, 'schedule.json'),
    JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks } }))
  const read = () => readProjectScheduleWitness(db, binding, { maxRows: 100, maxBytes: 65536 })
  return { save, read, task, taskId, rows, delivered, older }
}

describe('schedule recovery evidence', () => {
  it('accepts a pruned history with a retained receipt and a later pending occurrence', async () => {
    const f = await fixture()
    f.task.deliveryHistory.earlierRecordsUnavailable = true
    f.task.deliveryHistory.earlierRecordsPruned = true
    await f.save({ [f.taskId]: f.task })
    expect(await f.read()).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('accepts deleted tasks without discarding their committed Session deliveries', async () => {
    const f = await fixture()
    await f.save({})
    const witness = await f.read()
    f.rows.pop()
    expect(await f.read()).not.toBe(witness)
  })

  it('rejects an active occurrence that may already be in the durable inbox', async () => {
    const f = await fixture()
    f.task.deliveryHistory.earlierRecordsPruned = true
    f.task.record.scheduledAt = f.delivered
    await f.save({ [f.taskId]: f.task })
    await expect(f.read()).rejects.toMatchObject({ code: 'peer-backup/schedule-evidence-incomplete' })
  })

  it('requires every retained receipt to name a committed Session message', async () => {
    const f = await fixture()
    f.rows.pop()
    await f.save({ [f.taskId]: f.task })
    await expect(f.read()).rejects.toMatchObject({ code: 'peer-backup/schedule-evidence-incomplete' })
  })

  it('keeps inactive tasks inactive while checking their retained receipts', async () => {
    const f = await fixture()
    f.task.status = 'inactive'
    f.task.record.scheduledAt = f.delivered
    f.task.deliveryHistory.earlierRecordsPruned = true
    await f.save({ [f.taskId]: f.task })
    expect(await f.read()).toMatch(/^[a-f0-9]{64}$/u)
  })
})
