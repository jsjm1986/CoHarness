/** Restart the installed Schedule dispatcher over the recovered JSON storage and a real project Session journal. */
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import type { NodeContentBinding, NodeContentStore } from '../src/node-content-store.ts'
import { readProjectScheduleWitness } from '../src/peer-backup-takeover-schedule.ts'

/** Verify one overdue task can deliver while the previously committed reminder and a future recurrence stay quiet. */
export async function verifyReplacementDispatch(
  store: NodeContentStore,
  binding: NodeContentBinding,
  session: string,
  originalMessage: string,
  storage: string,
  scheduleEntrypoint = resolve(import.meta.dirname, '../../packages/schedule/schedule/lib/types/runtime.js'),
) {
  const { ScheduleRuntime } = await import(pathToFileURL(scheduleEntrypoint).href)
  const path = join(storage, 'schedule.json'),
    snap = JSON.parse(await readFile(path, 'utf8'))
  const tasks = new Map<string, { record: { id: string }; sessionId: string }>(Object.entries(snap.tables.tasks))
  const messages: { id: string; source: { kind: string } }[] = []
  let current: Promise<void> | undefined
  const warnings: string[] = []
  const ctx = {
    agents: {
      withoutInitiator: (work: () => Promise<void>) => {
        current = work()
        return current
      },
    },
    logger: { warn: (message: string) => warnings.push(message) },
    sessionController: {
      resolveAgent: async (id: string) => {
        assert.equal(id, session)
        return { ok: true, agent: { session, followup: (message: (typeof messages)[number]) => messages.push(message) } }
      },
    },
    sessions: {
      flush: async (id: string) => {
        assert.equal(id, session)
        const message = messages.at(-1)!
        await store.write(binding, async (tx) => {
          const row = (
            await tx.query(
              'UPDATE node_content.conversation_sessions SET next_seq=next_seq+1,event_count=event_count+1 WHERE organization_id=$1 AND runtime_id=$2 AND id=$3 RETURNING next_seq-1 seq',
              [binding.organizationId, binding.runtimeId, session],
            )
          ).rows[0]
          await tx.query(
            `INSERT INTO node_content.conversation_events(organization_id,runtime_id,session_id,seq,event_type,occurred_at,event,payload_bytes,query_fields)
          VALUES($1,$2,$3,$4,'agent/inbox/spliced',clock_timestamp(),$5,0,'{}')`,
            [
              binding.organizationId,
              binding.runtimeId,
              session,
              row.seq,
              JSON.stringify({ type: 'agent/inbox/spliced', data: { target: 'followup', start: 0, inserted: [message] } }),
            ],
          )
        })
        return true
      },
    },
  }
  const runtime = new ScheduleRuntime(
    ctx,
    () => [...tasks.values()],
    (work: () => Promise<void>) => work(),
    async (task: typeof tasks extends Map<string, infer T> ? T : never) => {
      tasks.set(task.record.id, task)
      await writeFile(path, JSON.stringify({ ...snap, tables: { tasks: Object.fromEntries(tasks) } }) + '\n', {
        flush: true,
      })
    },
    { days: 3650, records: 100 },
  )
  try {
    runtime.requestDrive()
    await current
    assert.deepEqual(warnings, [])
    assert.equal(messages.length, 1)
    assert.notEqual(messages[0]!.id, originalMessage)
    runtime.requestDrive()
    await current
    assert.equal(messages.length, 1)
    const persisted = await store.read(
      binding,
      async (tx) =>
        (
          await tx.query(
            `SELECT m->>'id' id FROM node_content.conversation_events e
      CROSS JOIN LATERAL json_array_elements(e.event->'data'->'inserted') m WHERE e.organization_id=$1 AND e.runtime_id=$2 AND e.session_id=$3
      AND e.event_type='agent/inbox/spliced' AND m->'source'->>'kind'='schedule' ORDER BY e.seq`,
            [binding.organizationId, binding.runtimeId, session],
          )
        ).rows,
    )
    assert.deepEqual(
      persisted.map((r) => r.id),
      [originalMessage, messages[0]!.id],
    )
    return persisted.length
    await store.read(binding, (tx) => readProjectScheduleWitness(tx, binding, { maxRows: 5000, maxBytes: 32 << 20 }))
  } finally {
    await runtime.dispose()
  }
}
