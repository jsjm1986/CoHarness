/** Select the authoritative archive store using server-owned identities before consulting transcript rows. */
import type { PoolClient } from 'pg'
import type { RuntimeId } from './runtime-catalog.ts'
import type { ConversationArchiveId } from './archive-identity.ts'
import type { ConversationSessionIdentity } from './session-identity.ts'
import type { RuntimeCredentialSubject } from './runtime-api.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { transaction } from './postgres/database.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { requireNodeContentRelations, type NodeContentCheckInput } from './node-content-publication.ts'
import { ArchiveVolumeSession, type ArchiveProject } from './node-archive-session.ts'
import { verifyNodeArchiveFile,type PendingNodeArchiveFile,type NodeArchiveFileProof } from './node-archive-file-proof.ts'
import { NodeContentUnavailable, type NodeContentStore } from './node-content-store.ts'
import { ConversationArchiveService, type ConversationArchiveAdminFilter, type ConversationArchiveRow,
  type ConversationArchiveState } from './postgres/conversation-archive-service.ts'

type ArchiveStore = Pick<NodeContentStore,'read'|'write'|'readVolume'>
type RuntimeArchive = Pick<ConversationArchiveService,'syncRuntimeSnapshot'|'hasPendingCommands'|'acknowledgeCommand'>
const noOwner = () => new NodeContentUnavailable('The selected archive has no available writer on this computer.')

/** Personal and predecessor archives retain their existing Runtime reader; published project archives use the owning volume. */
export class NodeArchiveRouter extends ConversationArchiveService {
  constructor(private readonly owner:PostgresRuntimeContext, private readonly days:number, private readonly store:ArchiveStore) {
    super(owner,days,undefined,true,async paths=>{
      const volumes=await owner.pool.query('SELECT FROM harness.node_content_volumes WHERE organization_id=$1 AND node_id=$2 LIMIT 1',[owner.organizationId,owner.nodeId])
      if (!volumes.rowCount) return new Set()
      const kept=await store.readVolume(async local=>(await local.query<{local_path:string}>(
        'SELECT DISTINCT local_path FROM node_content.content_files WHERE organization_id=$1 AND local_path=ANY($2::text[])',[owner.organizationId,paths])).rows)
      return new Set(kept.map(row=>row.local_path))
    })
  }

  /** @param input - exact prospective placement. @param domain - archive lifecycle or full-text reads served by this Gateway. */
  async verifyNodeContent({binding,local}:NodeContentCheckInput,domain:'archive'|'search'):Promise<void> {
    if (binding.nodeId!==this.owner.nodeId || binding.organizationId!==this.owner.organizationId) throw noOwner()
    const names=domain==='search'?['conversation_search','conversation_archive_search']:
      ['conversation_archive_records','conversation_archive_commands','conversation_archive_file_cleanup','content_files']
    await requireNodeContentRelations(local,names)
    if (domain==='search') {
      const available=await local.query("SELECT node_content.conversation_search_literal('prefix',NULL,ARRAY['%ref%']) ok")
      if (!available.rows[0]?.ok) throw noOwner()
    }
  }

  private async placements(control: PoolClient, options: {runtime?:RuntimeId;publicId?:number;generation?:number;volume?:string;epoch?:string} = {}):Promise<ArchiveProject[]> {
    return (await control.query<ArchiveProject>(`SELECT b.organization_id "organizationId",b.node_id "nodeId",b.project_id "projectId",
      b.runtime_id "runtimeId",b.volume_id "volumeId",b.writer_epoch::text "writerEpoch",p.public_id::float8 "publicId",
      p.logical_name_id "nameVersion",i.generation::float8 generation FROM harness.project_content_placement b
      JOIN harness.projects p ON p.organization_id=b.organization_id AND p.id=b.project_id AND p.status='active'
      JOIN harness.runtime_environments e ON e.organization_id=b.organization_id AND e.id=b.runtime_id AND e.node_id=b.node_id
        AND e.owner_id=b.project_id AND e.owner_kind='project' AND e.retired_at IS NULL
      JOIN harness.instances i ON (i.organization_id,i.assigned_node_id,i.runtime_id,i.project_id)=(b.organization_id,b.node_id,b.runtime_id,b.project_id)
      JOIN harness.compute_nodes n ON n.organization_id=b.organization_id AND n.id=b.node_id AND n.status='active'
      JOIN harness.organizations o ON o.id=b.organization_id AND o.status='active'
      WHERE b.organization_id=$1 AND b.node_id=$2 AND ($3::uuid IS NULL OR b.runtime_id=$3) AND ($4::bigint IS NULL OR p.public_id=$4)
        AND ($5::bigint IS NULL OR i.generation=$5 AND i.provisioning_state='ready' AND i.desired_state='running' AND i.observed_state IN ('starting','ready')
          AND harness.runtime_node_execution_allowed(i.organization_id,i.assigned_node_id,i.node_connection_id,i.node_connection_epoch))
        AND ($6::uuid IS NULL OR b.volume_id=$6) AND ($7::bigint IS NULL OR b.writer_epoch=$7)
      ORDER BY b.runtime_id FOR SHARE OF b,p,e,i,n,o`,[this.owner.organizationId,this.owner.nodeId,options.runtime??null,options.publicId??null,
      options.generation??null,options.volume??null,options.epoch??null])).rows
  }

  private async service(db:PoolClient, control:PoolClient, rows:ArchiveProject[],checked?:ReadonlyMap<string,NodeArchiveFileProof>):Promise<ConversationArchiveService>{
    return new ConversationArchiveService(this.owner,this.days,await ArchiveVolumeSession.open(db,control,this.owner,rows,checked))
  }

  private shared(control:PoolClient):ConversationArchiveService {
    return new ConversationArchiveService(this.owner,this.days,undefined,true,undefined,control)
  }

  /** Select a store only from the Gateway-authenticated generation and volume.
   * @param subject - the credential verified by the runtime API for this request.
   * @returns operations scoped to this Runtime, or the predecessor implementation for its original layout.
   */
  forCredential(subject:RuntimeCredentialSubject):RuntimeArchive {
    const b=subject.contentBinding
    if (!b) return this
    const target=subject.target
    const run=<T>(write:boolean,work:(archives:ConversationArchiveService)=>Promise<T>):Promise<T> => transaction(this.owner.pool,async control=>{
      if (target.kind!=='project' || b.organizationId!==this.owner.organizationId || b.nodeId!==this.owner.nodeId || b.runtimeId!==target.runtimeId
        || b.projectId!==subject.projectInternalId) throw noOwner()
      const rows=await this.placements(control,{runtime:b.runtimeId,publicId:target.id,generation:subject.generation,volume:b.volumeId,epoch:b.writerEpoch})
      if (rows.length!==1 || rows[0]!.projectId!==b.projectId) throw noOwner()
      const perform=async(db:PoolClient)=>work(await this.service(db,control,rows))
      return write ? this.store.write(b,perform,subject.generation) : this.store.read(b,perform,undefined,subject.generation)
    })
    return {
      hasPendingCommands:()=>run(false,svc=>svc.hasPendingCommands(target)),
      syncRuntimeSnapshot:snapshot=>run(true,svc=>svc.syncRuntimeSnapshot(snapshot,target)),
      acknowledgeCommand:(id,revision,error)=>run(true,svc=>svc.acknowledgeCommand(id,revision,error,target)),
    }
  }

  private async page<T>(actor:number|undefined,publicId:number|undefined,
    work:(local:ConversationArchiveService,shared:ConversationArchiveService)=>Promise<T>):Promise<T|undefined>{
    return transaction(this.owner.pool,async control=>{
      if (actor!==undefined) await lockAdministrator(control,this.owner,actor)
      const bound=await this.placements(control,{publicId})
      if (!bound.length) return
      return this.store.readVolume(async db=>work(await this.service(db,control,bound),this.shared(control)))
    })
  }

  private async byId<T>(id:ConversationArchiveId,actor:number|undefined,write:boolean,work:(svc:ConversationArchiveService)=>Promise<T>):Promise<T|undefined> {
    return transaction(this.owner.pool,async control=>{
      if (actor!==undefined) await lockAdministrator(control,this.owner,actor)
      const existing=await control.query('SELECT FROM harness.project_content_placement WHERE organization_id=$1 AND node_id=$2 LIMIT 1',[this.owner.organizationId,this.owner.nodeId])
      if (!existing.rowCount) return
      const runtime=await this.store.readVolume(async db=>(await db.query<{runtime_id:RuntimeId}>(
        'SELECT runtime_id FROM node_content.conversation_archive_records WHERE organization_id=$1 AND node_id=$2 AND archive_id=$3',
        [this.owner.organizationId,this.owner.nodeId,id])).rows[0]?.runtime_id)
      if (!runtime) return
      const rows=await this.placements(control,{runtime})
      if (rows.length!==1) throw noOwner()
      const b=rows[0]!,perform=async(db:PoolClient)=>work(await this.service(db,control,rows))
      return write ? this.store.write(b,perform) : this.store.read(b,perform)
    })
  }

  override async status(id:ConversationArchiveId,actor?:number) {
    return await super.status(id,actor) ?? await this.byId(id,actor,false,svc=>svc.status(id,actor)) ?? null
  }
  override async detail(id:ConversationArchiveId,from=0,limit=200,actor?:number) {
    return await super.detail(id,from,limit,actor) ?? await this.byId(id,actor,false,svc=>svc.detail(id,from,limit,actor)) ?? null
  }
  override async exportDetail(id:ConversationArchiveId,actor?:number) {
    return await super.exportDetail(id,actor) ?? await this.byId(id,actor,false,svc=>svc.exportDetail(id,actor)) ?? null
  }
  override async setState(id:ConversationArchiveId,state:Exclude<ConversationArchiveState,'purged'>,actor:number,key?:string) {
    if (await super.status(id,actor)) return super.setState(id,state,actor,key)
    return await this.byId(id,actor,true,svc=>svc.setState(id,state,actor,key)) ?? null
  }
  override async settle(id:ConversationArchiveId,actor?:number) {
    if (await super.status(id,actor)) return super.settle(id,actor)
    return await this.byId(id,actor,true,svc=>svc.settle(id,actor)) ?? null
  }
  override async purge(id:ConversationArchiveId,actor?:number,key?:string) {
    if (await super.status(id,actor)) return super.purge(id,actor,key)
    return await this.byId(id,actor,true,svc=>svc.purge(id,actor,key)) ?? false
  }

  override async adminList(filter:ConversationArchiveAdminFilter={},actor?:number):Promise<readonly ConversationArchiveRow[]> {
    const offset=Math.max(0,filter.offset??0),limit=Math.max(1,Math.min(filter.limit??50,200))
    const result=await this.page(actor,filter.projectId,async (local,shared)=>{
      let a=0,b=0,skipped=0,left:readonly ConversationArchiveRow[]=[],right:readonly ConversationArchiveRow[]=[]
      let leftEnded=false,rightEnded=false
      const out:ConversationArchiveRow[]=[]
      while(out.length<limit) {
        if (!left.length && !leftEnded) {
          left=await shared.adminList({...filter,offset:a,limit},actor); a+=left.length; leftEnded=left.length<limit
        }
        if (!right.length && !rightEnded) {
          right=await local.adminList({...filter,offset:b,limit},actor); b+=right.length; rightEnded=right.length<limit
        }
        const l=left[0],r=right[0]
        if (!l && !r) break
        const takeLeft=!!l && (!r || l.archivedAt>r.archivedAt || l.archivedAt===r.archivedAt && l.archiveId<r.archiveId)
        const row=takeLeft?l!:r!
        if (takeLeft) left=left.slice(1); else right=right.slice(1)
        if (skipped++>=offset) out.push(row)
      }
      return out
    })
    return result??super.adminList(filter,actor)
  }

  override async previewEmptyDrafts(options:{olderThanMs?:number;limit?:number}={},actor?:number) {
    const shared=await super.previewEmptyDrafts(options,actor)
    const node=await this.page(actor,undefined,svc=>svc.previewEmptyDrafts(options,actor))
    if (!node) return shared
    const cutoff=Math.min(shared.cutoff,node.cutoff)
    const candidates=[...shared.candidates,...node.candidates].filter(x=>x.updatedAt<=cutoff)
      .sort((a,b)=>a.updatedAt-b.updatedAt || a.rootSessionId.localeCompare(b.rootSessionId) || a.runtime.runtimeId.localeCompare(b.runtime.runtimeId))
    return {cutoff,candidates:candidates.slice(0,Math.max(1,Math.min(options.limit??50,200)))}
  }

  override async trashEmptyDrafts(sessions:readonly ConversationSessionIdentity[],actor:number,cutoff?:number) {
    if (!sessions.length || sessions.length>200) throw new Error('invalid empty-draft batch')
    return transaction(this.owner.pool,async control=>{
      await lockAdministrator(control,this.owner,actor)
      const ids=[...new Set(sessions.map(s=>s.runtimeId))]
      const bound=(await this.placements(control)).filter(b=>ids.includes(b.runtimeId))
      const legacy=sessions.filter(s=>!bound.some(b=>b.runtimeId===s.runtimeId))
      const accepted:ConversationSessionIdentity[]=[]
      for (const b of bound) accepted.push(...await this.store.write(b,async db=>
        (await this.service(db,control,[b])).trashEmptyDrafts(sessions.filter(s=>s.runtimeId===b.runtimeId),actor,cutoff)))
      if (legacy.length) accepted.push(...await this.shared(control).trashEmptyDrafts(legacy,actor,cutoff))
      return accepted
    })
  }

  override async cleanupDue(limit=200):Promise<number>{
    let completed=await super.cleanupDue(limit)
    const remaining=Math.max(0,Math.min(200,limit)-completed)
    if(!remaining)return completed
    const projects=await transaction(this.owner.pool,async control=>{
      const bound=await this.placements(control)
      if (!bound.length) return []
      const owners=await this.store.readVolume(async local=>(await local.query<{runtime_id:RuntimeId}>(`SELECT runtime_id
        FROM node_content.conversation_archive_file_cleanup WHERE organization_id=$1 AND node_id=$2 AND runtime_id=ANY($3::uuid[])
          AND next_attempt_at<=now() AND (lease_until IS NULL OR lease_until<=now())
        GROUP BY runtime_id ORDER BY min(next_attempt_at),runtime_id LIMIT $4`,[this.owner.organizationId,this.owner.nodeId,bound.map(b=>b.runtimeId),remaining])).rows)
      return owners.map(row=>bound.find(p=>p.runtimeId===row.runtime_id)!)
    })
    let examined=0
    for(const b of projects){
      if(examined>=remaining)break
      const candidates=await this.store.read(b,async tx=>(await tx.query<PendingNodeArchiveFile & {root_path:string}>(`SELECT q.id::text,q.archive_id,q.local_path,
        q.expected_sha256,q.expected_bytes::text,s.root_path FROM node_content.conversation_archive_file_cleanup q
        JOIN node_content.spaces s USING(organization_id,runtime_id,node_id)
        JOIN node_content.conversation_archive_records a USING(organization_id,runtime_id,archive_id)
        WHERE s.organization_id=$1 AND s.runtime_id=$2 AND q.next_attempt_at<=clock_timestamp()
          AND (q.lease_until IS NULL OR q.lease_until<=clock_timestamp()) AND a.state='purged'
        ORDER BY q.next_attempt_at,q.created_at,q.id LIMIT $3`,[b.organizationId,b.runtimeId,remaining-examined])).rows)
      examined+=candidates.length
      if(!candidates.length)continue
      const checked=new Map<string,NodeArchiveFileProof>()
      for(const row of candidates)checked.set(row.id,await verifyNodeArchiveFile(row,row.root_path))
      completed+=await transaction(this.owner.pool,async control=>{
        const current=await this.placements(control,{runtime:b.runtimeId,volume:b.volumeId,epoch:b.writerEpoch})
        if(current.length!==1 || current[0]!.projectId!==b.projectId)return 0
        return this.store.write(b,async local=>(await this.service(local,control,current,checked)).cleanupDue(checked.size))
      })
    }
    return completed
  }

  override async purgeDue(limit=50):Promise<number> {
    const count=await super.purgeDue(limit)
    const due=await this.page(undefined,undefined,svc=>svc.dueIds(limit))
    let localCount=0
    for (const id of due??[]) if (await this.purge(id)) localCount++
    return count+localCount
  }
}
