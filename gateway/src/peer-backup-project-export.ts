/** Bounded space-local MVCC export. Only the approved runtime is projected. */
import { verifiedPeerFileRoots, type PeerFileRootMap } from './peer-snapshot-roots.ts'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { PoolClient } from 'pg'
import type { ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { z } from 'zod'
import type { NodeContentBinding, NodeContentStore } from './node-content-store.ts'
import type { Queryable } from './postgres/database.ts'
import { snapshotManagedFiles } from './managed-files.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import {
  verifyPeerManagedFiles,
  type PeerBackupBinding,
  type PeerBackupExporter,
  type PeerCapture,
} from './peer-backup-restic.ts'

import { peerProjectTables } from './node-content-project-tables.ts'

export { peerProjectTables }
const tables = peerProjectTables
type Table = (typeof tables)[number]
const projectScoped = new Set<Table>(['project_journal', 'project_journal_state', 'project_journal_requests'])
const tableRecord = z
  .object({ name: z.enum(tables), rows: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict()
const inventorySchema = z
  .object({
    version: z.literal(1),
    projectId: z.uuid(),
    runtimeId: z.uuid(),
    nodeId: z.uuid(),
    volumeId: z.uuid(),
    organizationId: z.uuid(),
    writerEpoch: z.string(),
    watermark: z.string(),
    tables: z.array(tableRecord).max(tables.length),
    hasFileSnapshot: z.boolean(),
    sourceOnlyFileWitnesses: z.boolean().optional(),
  })
  .strict()
interface View {
  revision: string
  capturedAt: string
  /** Read-only roots pinned at this database revision; providers must release without stopping the writer. */
  roots: readonly ManagedDataPath[]
  logicalRoots?: PeerFileRootMap
  verifiedVssPath?:(path:string)=>string
  confirm?():Promise<void>
  gaps: string[]
  release(): Promise<void>
}

/** An online file snapshot owner attests one content watermark and every declared plugin's coverage. */
export interface PeerProjectFileSnapshots {
  acquire(binding: NodeContentBinding, revision: string, signal: AbortSignal, maxEntries:number): Promise<View>
  validate(binding: PeerBackupBinding, payload: string, signal: AbortSignal): Promise<void>
}

interface Options {
  control: Queryable
  store: Pick<NodeContentStore, 'read'>
  files?: PeerProjectFileSnapshots
  maxBytes: number
  maxRows: number
}

async function projectBinding(control: Queryable, p: PeerBackupBinding): Promise<NodeContentBinding> {
  const row = (
    await control.query<NodeContentBinding>(
      `SELECT organization_id "organizationId",project_id "projectId",node_id "nodeId",
    runtime_id "runtimeId",volume_id "volumeId",writer_epoch::text "writerEpoch" FROM harness.project_content_placement
    WHERE organization_id=$1 AND project_id=$2 AND node_id=$3`,
      [p.organizationId, p.scopeId, p.sourceNodeId],
    )
  ).rows[0]
  if (!row) throw new PeerBackupError(409, 'peer-backup/space-not-local')
  return row
}

async function exportTable(
  tx: PoolClient,
  table: Table,
  binding: NodeContentBinding,
  destination: string,
  budget: { bytes: number; rows: number },
  signal: AbortSignal,
) {
  // ctid is an in-snapshot tie-breaker. Event replay always follows the recorded Session sequence.
  const order = table === 'conversation_events' ? 'session_id,seq' : table === 'conversation_sessions' ? 'id' : 'ctid'
  await tx.query(
    `DECLARE peer_rows NO SCROLL CURSOR FOR SELECT CASE WHEN octet_length(row_to_json(t)::text)<=$3
    THEN row_to_json(t)::text ELSE NULL END AS body FROM node_content."${table}" t
    WHERE organization_id=$1 AND ${projectScoped.has(table) ? 'project_id' : 'runtime_id'}=$2 ORDER BY ${order}`,
    [binding.organizationId, projectScoped.has(table) ? binding.projectId : binding.runtimeId, Math.min(8 << 20, budget.bytes)],
  )
  const file = await open(join(destination, table + '.jsonl'), 'wx', 0o600),
    hash = createHash('sha256')
  let count = 0
  try {
    for (;;) {
      signal.throwIfAborted()
      const batch = await tx.query<{ body: string | null }>('FETCH FORWARD 2 FROM peer_rows')
      if (!batch.rowCount) break
      for (const { body } of batch.rows) {
        if (body === null) throw new PeerBackupError(507, 'peer-backup/export-budget')
        const line = body + '\n'
        budget.bytes -= Buffer.byteLength(line)
        budget.rows--
        if (budget.bytes < 0 || budget.rows < 0) throw new PeerBackupError(507, 'peer-backup/export-budget')
        await file.writeFile(line)
        hash.update(line)
        count++
      }
    }
    await file.sync()
    return { name: table, rows: count, sha256: hash.digest('hex') }
  } finally {
    await file.close()
    await tx.query('CLOSE peer_rows')
  }
}

/** One verified local transaction pins all SQL rows. Mutable paths never silently enter a certified snapshot. */
export class PeerProjectExporter implements PeerBackupExporter {
  constructor(private readonly options: Options) {}
  async capture(policy: PeerBackupBinding, destination: string, signal: AbortSignal): Promise<PeerCapture> {
    const binding = await projectBinding(this.options.control, policy)
    const directory = join(destination, 'project')
    await mkdir(directory, { mode: 0o700 })
    let files: View | undefined
    const budget = { bytes:this.options.maxBytes, rows:this.options.maxRows }
    try {
      if(this.options.files) {
        const version=await this.options.store.read(binding,async tx=>(await tx.query<{revision:string}>(`SELECT revision::text
          FROM node_content.spaces WHERE organization_id=$1 AND runtime_id=$2`,[binding.organizationId,binding.runtimeId])).rows[0],signal)
        if(!version) throw new PeerBackupError(409,'peer-backup/space-placement-changed')
        files=await this.options.files.acquire(binding,version.revision,signal,this.options.maxRows)
      }
      const result = await this.options.store.read(
        binding,
        async tx => {
          const space = (
            await tx.query<{ revision: string; capturedAt: Date }>(
              `SELECT revision::text,transaction_timestamp() "capturedAt"
          FROM node_content.spaces WHERE organization_id=$1 AND runtime_id=$2`,
              [binding.organizationId, binding.runtimeId],
            )
          ).rows[0]
          if (!space) throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
          const known = await tx.query<{
            name: string
          }>(`SELECT relname name FROM pg_class WHERE relnamespace='node_content'::regnamespace AND relkind IN ('r','p')
          AND relname NOT IN ('volume','schema_migrations','desktop_session_confirmations','migration_snapshots','migration_batches','migration_domain_receipts','recovery_source_fences','recovery_candidates','recovery_stage_roots','conversation_acl_versions','personal_document_imports')`)
          const present = new Set(known.rows.map(row => row.name))
          const installed = Number(
            (await tx.query('SELECT max(version) AS version FROM node_content.schema_migrations')).rows[0]?.version,
          )
          const addedAt: Partial<Record<Table, number>> = {
            document_roots: 8,
            document_entries: 8,
            document_events: 8,
            document_receipts: 8,
            project_name_versions: 9,
            plugin_states: 11,
            project_file_anchors: 11,
            conversation_archive_search: 10,
            conversation_archive_commands: 10,
            conversation_archive_file_cleanup: 10,
          }
          const gaps = [...present].filter(name => !(tables as readonly string[]).includes(name)).map(name => 'table:' + name)
          if (files && files.revision !== space.revision) throw new PeerBackupError(409, 'peer-backup/checkpoint-moved')
          if (!files) gaps.push('workspace-and-plugin-files:no-consistent-snapshot')
          else gaps.push(...files.gaps)
          const records = []
          for (const name of tables) {
            if (!present.has(name)) {
              if ((addedAt[name] ?? 1) <= installed) gaps.push('table-missing:' + name)
              continue
            }
            records.push(await exportTable(tx, name, binding, directory, budget, signal))
          }
          const inventory = inventorySchema.parse({
            version: 1,
            projectId: binding.projectId,
            runtimeId: binding.runtimeId,
            nodeId: binding.nodeId,
            volumeId: binding.volumeId,
            organizationId: binding.organizationId,
            writerEpoch: binding.writerEpoch,
            watermark: space.revision,
            tables: records,
            hasFileSnapshot: files !== undefined,
            sourceOnlyFileWitnesses: present.has('project_file_anchors'),
          })
          await writeFile(join(directory, 'inventory.json'), JSON.stringify(inventory), { flag: 'wx', mode: 0o600 })
          return {
            version: 1 as const,
            organizationId: binding.organizationId,
            sourceNodeId: binding.nodeId,
            scopeId: binding.projectId,
            writerEpoch: binding.writerEpoch,
            watermark: space.revision,
            capturedAt: files && files.capturedAt<space.capturedAt.toISOString()?files.capturedAt:space.capturedAt.toISOString(),
            coveredCount: records.length + (files?.roots.length ?? 0),
            gaps,
          }
        },
        signal,
      )
      if (files) {
        const managed = join(destination, 'managed')
        await mkdir(managed, { mode: 0o700 })
        const witness = await snapshotManagedFiles(files.roots,managed,signal,{maxBytes:budget.bytes,maxEntries:budget.rows,
          rejectNestedBtrfs:files.logicalRoots?.provider==='btrfs',btrfsDevices:files.logicalRoots?.devices,verifiedVssPath:files.verifiedVssPath})
        await files.confirm?.()
        if(files.logicalRoots) await writeFile(join(managed,'roots.json'),JSON.stringify(files.logicalRoots),{flag:'wx',mode:0o600})
        await writeFile(
          join(managed, 'manifest.json'),
          JSON.stringify({ platform: process.platform === 'win32' ? 'win32' : 'posix', snapshot: witness }),
          { flag: 'wx', mode: 0o600 },
        )
      }
      const current = await projectBinding(this.options.control, policy)
      if (
        current.writerEpoch !== binding.writerEpoch ||
        current.volumeId !== binding.volumeId ||
        current.runtimeId !== binding.runtimeId
      ) {
        throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
      }
      return result
    } finally {
      await files?.release()
    }
  }

  validate(binding: PeerBackupBinding, capture: PeerCapture, destination: string, signal: AbortSignal) {
    return validatePeerProject(binding, capture, destination, signal, this.options)
  }
}

/** Verify restored project rows, event continuity and managed bytes without connecting to the original node. */
export async function validatePeerProject(
  binding: PeerBackupBinding,
  capture: PeerCapture,
  destination: string,
  signal: AbortSignal,
  options: Pick<Options, 'maxBytes' | 'maxRows' | 'files'>,
): Promise<void> {
  const base = join(destination, 'project')
  const inventoryInfo = await lstat(join(base, 'inventory.json'))
  if (!inventoryInfo.isFile() || inventoryInfo.isSymbolicLink() || inventoryInfo.size > 16384)
    throw new PeerBackupError(409, 'peer-backup/invalid-export')
  const manifest = inventorySchema.parse(JSON.parse(await readFile(join(base, 'inventory.json'), 'utf8')))
  if (
    manifest.organizationId !== binding.organizationId ||
    manifest.projectId !== binding.scopeId ||
    manifest.nodeId !== binding.sourceNodeId ||
    manifest.writerEpoch !== capture.writerEpoch ||
    manifest.watermark !== capture.watermark ||
    new Set(manifest.tables.map(t => t.name)).size !== manifest.tables.length
  )
    throw new PeerBackupError(409, 'peer-backup/invalid-export')
  if (manifest.tables.some(table => table.name === 'project_file_anchors') !== (manifest.sourceOnlyFileWitnesses === true)) {
    throw new PeerBackupError(409, 'peer-backup/invalid-file-manifest')
  }
  const counts = new Map<string, { count: number; seen: number; previous: number }>()
  let rows = 0,
    bytes = 0,
    spaces = 0
  for (const table of manifest.tables) {
    const hash = createHash('sha256')
    let count = 0
    const stream = createReadStream(join(base, table.name + '.jsonl'), { signal })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (++rows > options.maxRows || (bytes += Buffer.byteLength(line) + 1) > options.maxBytes)
          throw new PeerBackupError(507, 'peer-backup/export-budget')
        const row = JSON.parse(line) as Record<string, unknown>
        if (
          row.organization_id !== binding.organizationId ||
          (!projectScoped.has(table.name) && row.runtime_id !== manifest.runtimeId) ||
          (projectScoped.has(table.name) && row.project_id !== binding.scopeId) ||
          (row.project_id !== undefined && row.project_id !== binding.scopeId)
        )
          throw new PeerBackupError(409, 'peer-backup/cross-scope-row')
        if (table.name === 'spaces') {
          spaces++
          if (
            row.node_id !== binding.sourceNodeId ||
            row.volume_id !== manifest.volumeId ||
            String(row.writer_epoch) !== manifest.writerEpoch ||
            String(row.revision) !== manifest.watermark
          )
            throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
        } else if (table.name === 'conversation_sessions') {
          if (typeof row.id !== 'string' || counts.has(row.id) || !Number.isSafeInteger(row.event_count))
            throw new PeerBackupError(409, 'peer-backup/session-order')
          counts.set(row.id, { count: Number(row.event_count), seen: 0, previous: -1 })
        } else if (table.name === 'conversation_events') {
          const session = counts.get(String(row.session_id)),
            seq = Number(row.seq)
          if (!session || !Number.isSafeInteger(seq) || seq < 0 || (session.seen > 0 && seq !== session.previous + 1))
            throw new PeerBackupError(409, 'peer-backup/session-order')
          session.seen++
          session.previous = seq
        }
        hash.update(line + '\n')
        count++
      }
    } finally {
      lines.close()
      stream.destroy()
    }
    if (table.rows !== count || hash.digest('hex') !== table.sha256) throw new PeerBackupError(409, 'peer-backup/table-digest')
  }
  if (spaces !== 1) throw new PeerBackupError(409, 'peer-backup/space-placement-changed')
  for (const entry of counts.values()) if (entry.seen !== entry.count) throw new PeerBackupError(409, 'peer-backup/session-order')
  if (manifest.hasFileSnapshot) {
    const native=await verifiedPeerFileRoots(binding,destination,capture.gaps.length===0)
    await verifyPeerManagedFiles(join(destination,'managed'),signal,native?'roots.json':undefined)
    if (!native) {
      if (!options.files) throw new PeerBackupError(409, 'peer-backup/file-verifier-unavailable')
      await options.files.validate(binding,destination,signal)
    }
  }
}
