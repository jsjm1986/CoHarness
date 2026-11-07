/** Recreate a verified project's typed SQL on an explicitly approved empty replacement volume. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { NodeContentStore } from './node-content-store.ts'
import { peerProjectTables } from './peer-backup-project-export.ts'
import { projectScopedTables } from './node-content-project-tables.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { peerCaptureSchema, type PeerBackupDrill } from './peer-backup-restic.ts'
import { recoveryBinding, type PeerRecoveryOperation } from './peer-backup-takeover.ts'
import { readProjectScheduleWitness } from './peer-backup-takeover-schedule.ts'

export interface ReplacementFiles {
  workspacePath: string
  roots: readonly {
    owner: 'workspace' | 'runtime' | 'storage'
    path: string
    anchorPath: string
    device: string
    inode: string
    missing: boolean
  }[]
  protectedRoots: readonly { owner: string; kind: 'directory'; path: string }[]
  targetFilesDigest: string
  sourceFilesDigest: string
  documentRootId: string
  /** Only a logical source path with an authenticated owner can map into the new computer. */
  localPath(path: string): string
}
// Physical OS identifiers are replaced only after inspecting this computer's own files.
const relationNames = peerProjectTables.filter((table) => table !== 'spaces' && table !== 'project_file_anchors')

const scopeByProject = projectScopedTables
const fail = (code: string): never => {
  throw new PeerBackupError(409, 'peer-backup/' + code)
}
type Limits = { maxRows: number; maxBytes: number }
async function privateJson(path: string, max: number): Promise<unknown> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > max || (await realpath(path)) !== resolve(path))
    fail('invalid-export')
  return JSON.parse(await readFile(path, 'utf8'))
}
const inventory = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    projectId: z.uuid(),
    runtimeId: z.uuid(),
    nodeId: z.uuid(),
    volumeId: z.uuid(),
    writerEpoch: z.string(),
    watermark: z.string(),
    hasFileSnapshot: z.boolean(),
    sourceOnlyFileWitnesses: z.boolean().optional(),
    tables: z
      .array(
        z
          .object({ name: z.string(), rows: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/u) })
          .strict(),
      )
      .max(128),
  })
  .strict()

/** A peer restore never imports source OS identities. Revalidate every reconstructed target anchor at its actual device and inode. */
async function confirmRoots(tx: PoolClient, op: PeerRecoveryOperation, files: ReplacementFiles) {
  const byRole = new Map(files.roots.map((row) => [row.owner, row]))
  if (
    byRole.size !== 3 ||
    files.roots.length !== 3 ||
    byRole.get('workspace')?.path !== files.workspacePath ||
    byRole.get('storage')?.path !== join(byRole.get('runtime')?.path ?? '', 'storages')
  )
    fail('invalid-target-files')
  for (const witness of files.roots) {
    if (!witness.path || !witness.anchorPath || (await realpath(witness.anchorPath)) !== resolve(witness.anchorPath))
      fail('invalid-target-files')
    const info = await lstat(witness.anchorPath, { bigint: true })
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      String(info.dev) !== witness.device ||
      String(info.ino) !== witness.inode
    )
      fail('invalid-target-files')
    await tx.query(
      `INSERT INTO node_content.project_file_anchors(organization_id,project_id,runtime_id,owner,path,anchor_path,device,inode,missing)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        op.organizationId,
        op.projectId,
        op.runtimeId,
        witness.owner,
        witness.path,
        witness.anchorPath,
        witness.device,
        witness.inode,
        witness.missing,
      ],
    )
  }
}

/** Import into a private candidate only after authenticating the sealed point, file owner and all serialized table digests. */
export async function stagePeerProject(
  volume: Pick<NodeContentStore, 'writeVolume'>,
  op: PeerRecoveryOperation,
  drill: PeerBackupDrill,
  files: ReplacementFiles,
  limits: Limits,
  signal: AbortSignal,
): Promise<void> {
  const point = drill.point
  if (
    point.pointId !== op.pointId ||
    point.organizationId !== op.organizationId ||
    point.scopeId !== op.projectId ||
    point.sourceNodeId !== op.sourceNode ||
    point.writerEpoch !== op.oldEpoch ||
    point.watermark !== op.revision ||
    point.manifestDigest !== op.digest ||
    point.gapCount
  )
    fail('point-mismatch')
  const manifestFile = join(drill.directory, 'checkpoint.json')
  if (
    (await lstat(manifestFile)).size > 1 << 20 ||
    createHash('sha256')
      .update(await readFile(manifestFile))
      .digest('hex') !== op.digest
  )
    fail('point-mismatch')
  const capture = peerCaptureSchema.parse(
    z.object({ capture: peerCaptureSchema }).parse(await privateJson(manifestFile, 1 << 20)).capture,
  )
  if (capture.gaps.length || capture.watermark !== op.revision || capture.writerEpoch !== op.oldEpoch)
    fail('coverage-incomplete')
  const project = join(drill.directory, 'project')
  const data = inventory.parse(await privateJson(join(project, 'inventory.json'), 16384))
  if (
    !data.hasFileSnapshot ||
    !data.sourceOnlyFileWitnesses ||
    data.organizationId !== op.organizationId ||
    data.projectId !== op.projectId ||
    data.runtimeId !== op.runtimeId ||
    data.nodeId !== op.sourceNode ||
    data.volumeId !== op.sourceVolume ||
    data.writerEpoch !== op.oldEpoch ||
    data.watermark !== op.revision
  )
    fail('invalid-export')
  const available = new Map(data.tables.map((table) => [table.name, table]))
  if (
    available.size !== data.tables.length ||
    available.size !== relationNames.length + 2 ||
    !available.has('spaces') ||
    !available.has('project_file_anchors') ||
    relationNames.some((name) => !available.has(name))
  )
    fail('unverified-domain')
  const inventorySpace = available.get('spaces')!
  const rawSpace = await readFile(join(project, 'spaces.jsonl'))
  if (
    inventorySpace.rows !== 1 ||
    rawSpace.length > 1 << 20 ||
    createHash('sha256').update(rawSpace).digest('hex') !== inventorySpace.sha256
  )
    fail('invalid-export')
  const body = z
    .object({
      organization_id: z.uuid(),
      project_id: z.uuid(),
      runtime_id: z.uuid(),
      node_id: z.uuid(),
      volume_id: z.uuid(),
      revision: z.number().int().nonnegative(),
      writer_epoch: z.number().int().positive(),
      runtime_generation: z.number().int().nonnegative(),
      plugin_revision: z.number().int().nonnegative(),
      name: z.string(),
    })
    .parse(JSON.parse(rawSpace.toString()))
  if (
    body.organization_id !== op.organizationId ||
    body.project_id !== op.projectId ||
    body.runtime_id !== op.runtimeId ||
    body.node_id !== op.sourceNode ||
    body.volume_id !== op.sourceVolume ||
    String(body.writer_epoch) !== op.oldEpoch ||
    String(body.revision) !== op.revision
  )
    fail('invalid-export')
  await volume.writeVolume(async (tx) => {
    const known = (
      await tx.query<{ phase: string }>(
        `SELECT phase FROM node_content.recovery_candidates WHERE operation_id=$1 AND point_id=$2 AND manifest_digest=$3
      AND destination_volume_id=$4`,
        [op.id, op.pointId, op.digest, op.targetVolume],
      )
    ).rows[0]
    if (known?.phase === 'verified' || known?.phase === 'active') return
    if (
      !(
        await tx.query('SELECT FROM node_content.volume WHERE organization_id=$1 AND node_id=$2 AND volume_id=$3', [
          op.organizationId,
          op.targetNode,
          op.targetVolume,
        ])
      ).rowCount ||
      (
        await tx.query('SELECT FROM node_content.spaces WHERE organization_id=$1 AND (project_id=$2 OR runtime_id=$3)', [
          op.organizationId,
          op.projectId,
          op.runtimeId,
        ])
      ).rowCount
    )
      fail('replacement-must-be-empty')
    await tx.query('SET CONSTRAINTS ALL DEFERRED')
    await tx.query(
      `INSERT INTO node_content.spaces(organization_id,project_id,runtime_id,node_id,volume_id,writer_epoch,revision,runtime_generation,name,root_path,plugin_revision,publication_state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'staging')`,
      [
        op.organizationId,
        op.projectId,
        op.runtimeId,
        op.targetNode,
        op.targetVolume,
        op.newEpoch,
        op.revision,
        body.runtime_generation,
        body.name,
        files.workspacePath,
        body.plugin_revision,
      ],
    )
    let rows = 0,
      bytes = 0
    for (const name of relationNames) {
      const table = available.get(name)!,
        hash = createHash('sha256')
      const fields = (
        await tx.query<{ name: string }>(
          `SELECT a.attname name FROM pg_attribute a WHERE a.attrelid=('node_content.'||$1)::regclass
        AND a.attnum>0 AND NOT a.attisdropped AND a.attgenerated='' ORDER BY a.attnum`,
          [name],
        )
      ).rows.map((row) => row.name)
      if (!fields.length || fields.some((f) => !/^[a-z_]+[a-z0-9_]*$/u.test(f))) fail('unsupported-source')
      const projection = fields.map((f) => '"' + f + '"').join(',')
      const stream = createReadStream(join(project, name + '.jsonl'), { signal }),
        lines = createInterface({ input: stream, crlfDelay: Infinity })
      let count = 0
      try {
        for await (const line of lines) {
          if (++rows > limits.maxRows || (bytes += Buffer.byteLength(line) + 1) > limits.maxBytes) fail('export-budget')
          const row = JSON.parse(line) as Record<string, unknown>
          if (
            row.organization_id !== op.organizationId ||
            (!scopeByProject.has(name) && row.runtime_id !== op.runtimeId) ||
            (row.project_id !== undefined && row.project_id !== op.projectId) ||
            fields.some((f) => !Object.hasOwn(row, f))
          )
            fail('cross-scope-row')
          hash.update(line + '\n')
          count++
          if (name === 'document_roots' && row.root_id !== files.documentRootId) fail('document-root-mismatch')
          // PostgreSQL preserves the original JSON event and numeric literals; JS must not reserialize model or Session content.
          const args: unknown[] = [line],
            columns = new Map<string, string>()
          const set = (field: string, parameter: unknown, type: 'uuid' | 'text' | 'bigint' | 'jsonb') => {
            args.push(parameter)
            columns.set(field, '$' + args.length + '::' + type)
          }
          if (name === 'document_roots') {
            set('node_id', op.targetNode, 'uuid')
            set('volume_id', op.targetVolume, 'uuid')
            set('writer_epoch', op.newEpoch, 'bigint')
          } else if (name === 'conversation_archive_records' || name === 'conversation_archive_file_cleanup') {
            if (row.node_id !== op.sourceNode) fail('cross-scope-row')
            set('node_id', op.targetNode, 'uuid')
          }
          for (const field of ['cwd', 'local_path', 'workspace_path']) {
            const old = row[field]
            if (old === null || old === undefined) continue
            if (typeof old !== 'string') return fail('foreign-storage-path')
            const local = files.localPath(old)
            if (
              name === 'conversation_draft_reservations' &&
              local !== old &&
              Date.parse(String(row.lease_expires_at)) > Date.now()
            )
              fail('outstanding-draft-reservation')
            set(field, local, 'text')
          }
          if (name === 'workspace_catalog') {
            for (const [field, nested] of [
              ['items', 'path'],
              ['predecessor_conversations', 'cwd'],
            ] as const) {
              const items = row[field]
              if (items === null || items === undefined) continue
              if (!Array.isArray(items)) return fail('invalid-export')
              const moves = items.map((item) => {
                const path = item?.[nested]
                if (path === undefined) return null
                if (typeof path !== 'string') return fail('foreign-storage-path')
                return files.localPath(path)
              })
              // Project only the operational path. The rest of the JSON stays in PostgreSQL verbatim.
              args.push(JSON.stringify(moves))
              columns.set(
                field,
                `(SELECT coalesce(jsonb_agg(CASE WHEN ($${args.length}::jsonb->(i-1)::int)='null'::jsonb THEN v
                ELSE jsonb_set(v,'{${nested}}',($${args.length}::jsonb->(i-1)::int),false) END ORDER BY i),'[]'::jsonb)
                FROM jsonb_array_elements("${field}") WITH ORDINALITY a(v,i))`,
              )
            }
          }
          const values = fields.map((field) => columns.get(field) ?? '"' + field + '"').join(',')
          await tx.query(
            `INSERT INTO node_content."${name}"(${projection}) OVERRIDING SYSTEM VALUE SELECT ${values}
            FROM json_populate_record(NULL::node_content."${name}",$1::json)`,
            args,
          )
        }
      } finally {
        lines.close()
        stream.destroy()
      }
      if (count !== table.rows || hash.digest('hex') !== table.sha256) fail('table-digest')
    }
    // Document audit ordinals are root-scoped, but the database allocator is shared with other local roots.
    await tx.query('SELECT node_content.advance_document_event_sequence()')
    if (
      !(
        await tx.query(
          'SELECT FROM node_content.project_name_versions WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND version_id=$4',
          [op.organizationId, op.projectId, op.runtimeId, op.nameId],
        )
      ).rowCount
    )
      fail('project-name-version-missing')
    await confirmRoots(tx, op, files)
    const target = recoveryBinding(op, 'target')
    const schedule = await readProjectScheduleWitness(tx, target, limits, signal)
    // A leftover 'active' candidate from a completed takeover holds the
    // UNIQUE(organization_id,runtime_id) slot forever; no retry can pass.
    await tx.query(
      `INSERT INTO node_content.recovery_candidates(operation_id,organization_id,project_id,runtime_id,source_node_id,source_volume_id,source_epoch,
      destination_node_id,destination_volume_id,destination_epoch,point_id,manifest_digest,schedule_digest,files_digest,target_files_digest,protected_roots,phase,verified_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'verified',now())`,
      [
        op.id,
        op.organizationId,
        op.projectId,
        op.runtimeId,
        op.sourceNode,
        op.sourceVolume,
        op.oldEpoch,
        op.targetNode,
        op.targetVolume,
        op.newEpoch,
        op.pointId,
        op.digest,
        schedule,
        files.sourceFilesDigest,
        files.targetFilesDigest,
        JSON.stringify(files.protectedRoots),
      ],
    ).catch((error: unknown) => {
      if (error !== null && typeof error === 'object' && 'code' in error && String(error.code) === '23505')
        throw new PeerBackupError(409, 'peer-backup/already-recovered', true)
      throw error
    })
    await tx.query("UPDATE node_content.spaces SET publication_state='sealed' WHERE organization_id=$1 AND project_id=$2", [
      op.organizationId,
      op.projectId,
    ])
  }, signal)
}

/** Remove only a never-published, cancelled candidate and its exact imported project rows. */
export async function discardPeerCandidate(volume:Pick<NodeContentStore,'writeVolume'>,op:PeerRecoveryOperation,signal:AbortSignal):Promise<void> {
  await volume.writeVolume(async db=>{
    const candidate=await db.query(`SELECT FROM node_content.recovery_candidates c JOIN node_content.spaces s USING(organization_id,project_id,runtime_id)
      WHERE c.operation_id=$1 AND c.organization_id=$2 AND c.project_id=$3 AND c.runtime_id=$4 AND c.destination_node_id=$5
      AND c.destination_volume_id=$6 AND c.destination_epoch=$7 AND c.point_id=$8 AND c.manifest_digest=$9 AND c.phase='verified'
      AND s.node_id=c.destination_node_id AND s.volume_id=c.destination_volume_id AND s.writer_epoch=c.destination_epoch
      AND s.publication_state='sealed' FOR UPDATE OF c,s`,
    [op.id,op.organizationId,op.projectId,op.runtimeId,op.targetNode,op.targetVolume,op.newEpoch,op.pointId,op.digest])
    if(!candidate.rowCount){
      if((await db.query('SELECT FROM node_content.recovery_candidates WHERE operation_id=$1',[op.id])).rowCount) fail('candidate-not-releasable')
      return
    }
    if(!(await db.query(`SELECT FROM node_content.recovery_stage_roots WHERE operation_id=$1 AND organization_id=$2
      AND runtime_id=$3 AND node_id=$4 AND volume_id=$5 GROUP BY operation_id HAVING count(DISTINCT role)=4`,
      [op.id,op.organizationId,op.runtimeId,op.targetNode,op.targetVolume])).rowCount) fail('staging-ownership-unverified')
    await db.query('SET CONSTRAINTS ALL DEFERRED')
    await db.query("DELETE FROM node_content.recovery_candidates WHERE operation_id=$1 AND phase='verified'",[op.id])
    for(const table of [...peerProjectTables].reverse()){
      signal.throwIfAborted()
      const project=scopeByProject.has(table)
      await db.query(`DELETE FROM node_content."${table}" WHERE organization_id=$1 AND ${project?'project_id':'runtime_id'}=$2`,
        [op.organizationId,project?op.projectId:op.runtimeId])
    }
  },signal)
}
