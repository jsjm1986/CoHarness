/** Verify a stopped project's durable schedule state against the Session messages it actually delivered. */
import { createHash } from 'node:crypto'
import { lstat, opendir, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PoolClient } from 'pg'
import type { NodeContentBinding } from './node-content-store.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

interface Limits {
  maxRows: number
  maxBytes: number
}
const ambiguous = (): never => {
  throw new PeerBackupError(409, 'peer-backup/schedule-evidence-incomplete')
}
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ambiguous()
  return value as Record<string, unknown>
}
async function info(path: string) {
  try {
    return await lstat(path, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function iso(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return ambiguous()
  return Date.parse(value)
}

/** Return an opaque digest only if no restored task can replay an already persisted reminder. */
export async function readProjectScheduleWitness(
  db: PoolClient,
  b: NodeContentBinding,
  limits: Limits,
  signal?: AbortSignal,
): Promise<string> {
  const anchor = (
    await db.query<{ path: string; anchor_path: string; device: string; inode: string; missing: boolean }>(
      `SELECT path,anchor_path,device,inode,missing
    FROM node_content.project_file_anchors WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND owner='storage'`,
      [b.organizationId, b.projectId, b.runtimeId],
    )
  ).rows[0]
  if (!anchor) return ambiguous()
  const physical = await info(anchor.anchor_path)
  if (
    !physical?.isDirectory() ||
    physical.isSymbolicLink() ||
    (await realpath(anchor.anchor_path)) !== resolve(anchor.anchor_path) ||
    String(physical.dev) !== anchor.device ||
    String(physical.ino) !== anchor.inode
  )
    return ambiguous()
  const folder = await info(anchor.path)
  if (
    anchor.missing !== !folder ||
    (folder && (!folder.isDirectory() || folder.isSymbolicLink() || (await realpath(anchor.path)) !== resolve(anchor.path)))
  )
    return ambiguous()
  let bytes = 0,
    rows = 0
  const tasks = new Map<string, Record<string, unknown>>()
  const parse = async (file: string): Promise<Record<string, unknown>> => {
    signal?.throwIfAborted()
    const data = await lstat(file)
    bytes += data.size
    if (
      !data.isFile() ||
      data.isSymbolicLink() ||
      data.nlink !== 1 ||
      bytes > limits.maxBytes ||
      (await realpath(file)) !== resolve(file)
    )
      return ambiguous()
    return record(JSON.parse(await readFile(file, 'utf8')))
  }
  const add = (task: unknown, expected?: string) => {
    const value = record(task),
      id = record(value.record).id
    if (
      ++rows > limits.maxRows ||
      typeof id !== 'string' ||
      !id ||
      (expected !== undefined && id !== expected) ||
      tasks.has(id)
    )
      return ambiguous()
    tasks.set(id, value)
  }
  if (folder) {
    const single = join(anchor.path, 'schedule.json'),
      tree = join(anchor.path, 'schedule')
    const [file, directory] = await Promise.all([info(single), info(tree)])
    if (file && directory) return ambiguous()
    if (file) {
      const data = await parse(single),
        header = record(data.unit)
      if (header.name !== 'schedule' || header.version !== 1) return ambiguous()
      for (const [key, value] of Object.entries(record(record(data.tables).tasks ?? {}))) add(value, key)
    } else if (directory) {
      if (!directory.isDirectory() || directory.isSymbolicLink() || (await realpath(tree)) !== resolve(tree))
        return ambiguous()
      const table = join(tree, 'tasks'),
        tableInfo = await info(table)
      if (tableInfo) {
        if (!tableInfo.isDirectory() || tableInfo.isSymbolicLink()) return ambiguous()
        for await (const entry of await opendir(table)) {
          if (!entry.isFile() || !entry.name.endsWith('.json')) return ambiguous()
          const value = await parse(join(table, entry.name))
          if (value.version !== 1) return ambiguous()
          add(value.record, entry.name.slice(0, -'.json'.length))
        }
      }
    }
  }
  const actual = (
    await db.query<{ session_id: string; message_id: string; at: number }>(
      `SELECT e.session_id,m->>'id' message_id,
    (extract(epoch FROM e.occurred_at)*1000)::float8 at FROM node_content.conversation_events e
    CROSS JOIN LATERAL json_array_elements(CASE WHEN json_typeof(e.event->'data'->'inserted')='array' THEN e.event->'data'->'inserted'
      ELSE '[]'::json END) m WHERE e.organization_id=$1 AND e.runtime_id=$2 AND e.event_type='agent/inbox/spliced'
      AND m->'source'->>'kind'='schedule' ORDER BY e.session_id,e.seq LIMIT $3`,
      [b.organizationId, b.runtimeId, limits.maxRows + 1],
    )
  ).rows
  if (actual.length > limits.maxRows) return ambiguous()
  const messages = new Set(actual.map((item) => JSON.stringify([item.session_id, item.message_id])))
  if (messages.size !== actual.length || actual.some((item) => !item.message_id)) return ambiguous()
  const reported = new Set<string>(),
    timings = new Map<string, number>()
  for (const item of actual) timings.set(item.session_id, Math.max(timings.get(item.session_id) ?? 0, item.at))
  // Only the installed plugin decides which saved variants, legacy states and receipts it can resume.
  const validator = tasks.size
    ? (await import('@deepseek-ai/dsh-schedule')).scheduleDomain.tables.tasks.valueSchema
    : undefined
  for (const task of tasks.values()) {
    if (!validator?.safeParse(task).success) return ambiguous()
    const spec = record(task.record),
      session = spec.sessionId ?? task.sessionId
    const status = task.status ?? 'active'
    if (typeof session !== 'string' || !session || !['active', 'inactive'].includes(String(status))) return ambiguous()
    const next = iso(spec.scheduledAt)
    const recorded = task.deliveryHistory === undefined ? undefined : record(task.deliveryHistory)
    if (
      recorded &&
      (!Array.isArray(recorded.records) ||
        recorded.earlierRecordsUnavailable === true ||
        recorded.earlierRecordsPruned === true)
    )
      return ambiguous()
    const history = (recorded?.records as unknown[] | undefined) ?? (task.lastDelivery ? [task.lastDelivery] : [])
    for (const item of history) {
      const receipt = record(item),
        at = iso(receipt.scheduledAt)
      if (typeof receipt.messageId !== 'string' || (status === 'active' && at >= next)) return ambiguous()
      const identity = JSON.stringify([session, receipt.messageId])
      if (!messages.has(identity)) return ambiguous()
      reported.add(identity)
    }
    if (status === 'active' && next <= (timings.get(session) ?? Number.NEGATIVE_INFINITY)) return ambiguous()
  }
  if ([...messages].some((id) => !reported.has(id))) return ambiguous()
  const hash = createHash('sha256')
  for (const [id, task] of [...tasks].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
    hash.update(JSON.stringify([id, task]) + '\n')
  hash.update(JSON.stringify([...messages].sort()))
  return hash.digest('hex')
}
