/** Node-local archive queries share the project's content transaction and its current organization authorization. */
import { createHash } from 'node:crypto'
import { confirmNodeArchiveFile,type NodeArchiveFileProof,type PendingNodeArchiveFile } from './node-archive-file-proof.ts'
import type { PoolClient } from 'pg'
import type { RuntimeId } from './runtime-catalog.ts'
import type { ConversationArchiveRuntimeIdentity } from './postgres/conversation-archive-service.ts'
import type { NodeContentBinding } from './node-content-store.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'

export interface ArchiveProject extends NodeContentBinding {
  publicId: number
  nameVersion: string
  generation: number
}

const selected = `jsonb_to_recordset(current_setting('coharness.archive_projects')::jsonb)
  AS p("organizationId" uuid,"projectId" uuid,"nodeId" uuid,"runtimeId" uuid,"volumeId" uuid,"writerEpoch" bigint,
    "publicId" bigint,"nameVersion" uuid)`
const matching = `(s.organization_id,s.project_id,s.node_id,s.runtime_id,s.volume_id,s.writer_epoch)
  =(p."organizationId",p."projectId",p."nodeId",p."runtimeId",p."volumeId",p."writerEpoch")`

/** SQL joins show only current allocations. Account labels are resolved for the returned page. */
export class ArchiveVolumeSession {
  readonly users = '(SELECT NULL::uuid organization_id,NULL::uuid id,NULL::bigint public_id,NULL::text display_name WHERE false)'
  readonly projects = `(SELECT s.organization_id,s.project_id id,p."publicId" public_id,
    node_content.project_name_at(s.organization_id,s.project_id,s.runtime_id,p."nameVersion") name
    FROM node_content.spaces s JOIN ${selected} ON ${matching})`
  readonly runtimes = `(SELECT s.organization_id,s.node_id,s.runtime_id id FROM node_content.spaces s JOIN ${selected} ON ${matching})`
  private constructor(readonly database: PoolClient, readonly control: PoolClient, private readonly context: PostgresRuntimeContext,
    private readonly bound: readonly ArchiveProject[],private readonly checked:ReadonlyMap<string,NodeArchiveFileProof>) {}

  /** @param database - attested local transaction. @param control - current authorization transaction.
   * @param context - serving Gateway. @param bound - approved placements and display versions. @param checked - original attachment evidence gathered before locking the project.
   * @returns a reader confined to those exact volume and writer coordinates.
   */
  static async open(database: PoolClient, control: PoolClient, context: PostgresRuntimeContext, bound: readonly ArchiveProject[],
    checked:ReadonlyMap<string,NodeArchiveFileProof>=new Map()) {
    await database.query("SELECT set_config('coharness.archive_projects',$1,true)",[JSON.stringify(bound)])
    const stored = await database.query(`SELECT 1 FROM node_content.spaces s JOIN ${selected} ON ${matching}
      WHERE s.publication_state='published' AND NOT EXISTS(SELECT FROM node_content.recovery_candidates rc
        WHERE rc.organization_id=s.organization_id AND rc.runtime_id=s.runtime_id AND rc.phase<>'active')`)
    if (stored.rowCount !== bound.length) throw new Error('Archive placement changed.')
    return new ArchiveVolumeSession(database,control,context,bound,checked)
  }

  /** Queue identities whose file checks finished before the cleanup transaction. */
  get checkedFiles():string[]{return [...this.checked.keys()]}

  /** @param column - server-owned SQL expression for the local Runtime UUID. @returns the checked allocation predicate. */
  visibleRuntime(column: string): string { return ` AND ${column} IN (SELECT id FROM ${this.runtimes} permitted)` }

  /** @param identity - authenticated allocation. @returns a matching local project Runtime. */
  runtime(identity: ConversationArchiveRuntimeIdentity): RuntimeId | undefined {
    if (identity.kind!=='project' || identity.nodeId && identity.nodeId!==this.context.nodeId) return
    const matches=this.bound.filter(p=>p.publicId===identity.id && (!identity.runtimeId || p.runtimeId===identity.runtimeId))
    return matches.length===1 ? matches[0]!.runtimeId : undefined
  }

  /** Retain paths referenced anywhere on the same computer, including earlier shared projects and staged spaces.
   * @param paths - candidate cleanup paths. @returns paths that have surviving references.
   */
  async retainedPaths(paths:readonly string[]):Promise<Set<string>>{
    const hashes=new Map(paths.map(path=>[createHash('sha256').update(path).digest('hex'),path]))
    const shared=await this.control.query<{hash:string}>(`SELECT DISTINCT encode(sha256(convert_to(f.local_path,'UTF8')),'hex') hash
      FROM harness.content_files f LEFT JOIN harness.runtime_environments r ON r.organization_id=f.organization_id AND r.id=f.runtime_id
      WHERE f.organization_id=$1 AND (r.node_id=$2 OR f.runtime_id IS NULL)
      AND sha256(convert_to(f.local_path,'UTF8'))=ANY($3::bytea[])`,
    [this.context.organizationId,this.context.nodeId,[...hashes.keys()].map(h=>Buffer.from(h,'hex'))])
    const local=await this.database.query<{local_path:string}>('SELECT DISTINCT local_path FROM node_content.content_files WHERE organization_id=$1 AND local_path=ANY($2::text[])',
      [this.context.organizationId,paths])
    return new Set([...local.rows.map(r=>r.local_path),...shared.rows.flatMap(r=>hashes.has(r.hash)?[hashes.get(r.hash)!]:[])])
  }

  /** @param entry - durable purge receipt. @returns whether the unreferenced file still matches the recorded project, path, and bytes. */
  async matchesFile(entry:PendingNodeArchiveFile):Promise<'match'|'missing'|'unverified'>{
    const root=(await this.database.query<{root_path:string}>(`SELECT s.root_path FROM node_content.spaces s JOIN node_content.conversation_archive_records a
      USING(organization_id,runtime_id) WHERE a.organization_id=$1 AND a.archive_id=$2 AND s.node_id=$3 AND a.state='purged'
      ${this.visibleRuntime('s.runtime_id')}`,[this.context.organizationId,entry.archive_id,this.context.nodeId])).rows[0]?.root_path
    return root?confirmNodeArchiveFile(this.checked.get(entry.id),entry,root):'unverified'
  }

  /** @param rows - the bounded local archive page before rendering account display names. */
  async hydrate(rows: Array<{creator_internal_id?:string|null;creator_display_name:string|null;creator_public_id:string|null}>):Promise<void> {
    const ids=[...new Set(rows.flatMap(r=>r.creator_internal_id?[r.creator_internal_id]:[]))]
    if (!ids.length) return
    const users=(await this.control.query<{id:string;public_id:string;display_name:string}>(`SELECT id,public_id::text,display_name
      FROM harness.users WHERE organization_id=$1 AND id=ANY($2::uuid[])`,[this.context.organizationId,ids])).rows
    const byId=new Map(users.map(user=>[user.id,user]))
    for (const row of rows) {
      const user=row.creator_internal_id ? byId.get(row.creator_internal_id) : undefined
      row.creator_display_name=user?.display_name ?? null
      row.creator_public_id=user?.public_id ?? null
    }
  }
}
