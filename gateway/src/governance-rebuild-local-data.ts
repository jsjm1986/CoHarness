/** Node-local data attestation after governance loss. Existing files are inspected without provisioning or importing restored plugins. */
import { createHash,randomUUID } from 'node:crypto'
import { lstat,open,readFile,realpath } from 'node:fs/promises'
import { dirname,isAbsolute,join,resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import type { GatewayConfig } from './config.ts'
import type { NodeContentStore } from './node-content-store.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { personalRuntimeLayout,type PersonalRuntimeStorageLayout } from './runtime-layout.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { privateFileState } from './node-private-file.ts'
import { peerPrivateDirectory,PeerBackupError } from './peer-backup-repository.ts'
import { inspectPersonalSessions } from './peer-backup-personal-sessions.ts'
import { recoveredEnvironmentKeys } from './peer-runtime-profile.ts'

const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
const positive=z.string().regex(/^[1-9][0-9]*$/u),sum=z.string().regex(/^[a-f0-9]{64}$/u)
const physical=z.object({path:z.string(),device:z.string(),inode:z.string()}).strict()
const evidenceSchema=z.object({version:z.literal(1),bindingId:z.uuid(),operationId:z.uuid(),organizationId:z.uuid(),nodeId:z.uuid(),
  runtimeId:z.uuid(),ownerId:z.uuid(),ownerKind:z.enum(['user','project']),sourceGeneration:positive,writerEpoch:positive,
  volumeId:z.uuid().nullable(),homePath:z.string(),runtimeHome:z.string(),cwd:z.string(),oldSessionIds:z.array(z.string()),
  roots:z.array(physical),catalogDigest:sum}).strict()
type Evidence=z.infer<typeof evidenceSchema>
interface Subject {id:string;organizationId:string;nodeId:string;runtimeId:RuntimeId;ownerId:string;ownerKind:'user'|'project';
  sourceGeneration:string;writerEpoch:string;volumeId:string|null;publicId:number;username:string|null;storageLayout:PersonalRuntimeStorageLayout;admin:boolean;
  generation:string;desiredState:string;tokenAbsent:boolean}
/** Opaque durable coordinates. No paths or Session IDs may be persisted in the governance receipt. */
export interface GovernanceLocalDataReference {bindingId:string;evidenceDigest:string}
/** Explicit input to the owning node's local configuration interface; never a center-forwarded browser path. */
export interface GovernanceLocalDataSelection {homePath:string;runtimeHome?:string}
/** A verified inspection can be accepted only while the Runtime remains at the inspected stopped generation. */
export interface GovernanceLocalDataProof extends GovernanceLocalDataReference {oldSessionCount:number;sourceGeneration:string}
/** Local configuration requires explicit editing before binding; the original file and values are never returned or changed. */
export class GovernanceLocalEnvironmentReview extends PeerBackupError {
  constructor(readonly keys:readonly string[]){super(409,'peer-backup/governance-local-environment-review-required')}
}
interface Options {limits:{maxRows:number;maxBytes:number};volume?:Pick<NodeContentStore,'readVolume'>}
type Config=Pick<GatewayConfig,'stateRoot'|'usersRoot'|'projectRuntimesRoot'>
function fail(code:string):never{throw new PeerBackupError(409,'peer-backup/governance-'+code)}
const missing=(error:unknown)=>error instanceof Error&&'code' in error&&error.code==='ENOENT'

/** Own immutable local bindings; callers own administrator authorization and the per-Runtime file-operation gate. */
export class GovernanceRebuildLocalData {
  constructor(private readonly context:PostgresRuntimeContext,private readonly cfg:Config,private readonly options:Options){}

  private async subject(id:string,stopped=false):Promise<Subject>{
    z.uuid().parse(id)
    const row=(await this.context.pool.query<Subject>(`SELECT r.id,r.organization_id "organizationId",r.node_id "nodeId",r.runtime_id "runtimeId",
      r.owner_id "ownerId",r.owner_kind "ownerKind",r.source_generation::text "sourceGeneration",r.writer_epoch::text "writerEpoch",r.volume_id "volumeId",
      coalesce(u.public_id,p.public_id)::float8 "publicId",u.username::text username,e.storage_layout "storageLayout",coalesce(m.role='admin',false) admin,
      i.generation::text generation,i.desired_state "desiredState",i.runtime_token_hash IS NULL "tokenAbsent"
      FROM harness.governance_rebuild_runtimes r JOIN harness.governance_rebuild_operations o ON o.id=r.operation_id
      JOIN harness.runtime_environments e ON (e.organization_id,e.id,e.node_id,e.owner_kind,e.owner_id)=(r.organization_id,r.runtime_id,r.node_id,r.owner_kind,r.owner_id)
      JOIN harness.instances i ON (i.organization_id,i.runtime_id,i.assigned_node_id)=(r.organization_id,r.runtime_id,r.node_id)
      LEFT JOIN harness.users u ON r.owner_kind='user' AND u.id=r.owner_id AND u.organization_id=r.organization_id
      LEFT JOIN harness.projects p ON r.owner_kind='project' AND p.id=r.owner_id AND p.organization_id=r.organization_id
      LEFT JOIN harness.memberships m ON m.organization_id=r.organization_id AND m.user_id=u.id
      WHERE r.id=$1 AND r.organization_id=$2 AND r.node_id=$3 AND e.retired_at IS NULL
      AND o.recovery_epoch=(SELECT max(recovery_epoch) FROM harness.governance_rebuild_operations WHERE organization_id=$2)
      AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=r.organization_id AND q.node_id=r.node_id)`,
    [id,this.context.organizationId,this.context.nodeId])).rows[0]
    if(!row)fail('local-identity-mismatch')
    if(BigInt(row.generation)<BigInt(row.sourceGeneration))fail('local-generation-changed')
    if(stopped&&(row.generation!==row.sourceGeneration||row.desiredState!=='stopped'||!row.tokenAbsent))fail('local-runtime-not-stopped')
    return row
  }

  private async directory(path:string):Promise<z.infer<typeof physical>>{
    if(!isAbsolute(path)||resolve(path)!==path)fail('local-path-invalid')
    let info:Awaited<ReturnType<typeof lstat>>
    try{info=await lstat(path)}catch(error){if(missing(error))fail('local-data-missing');throw error}
    if(!info.isDirectory()||info.isSymbolicLink()||await realpath(path)!==path||!info.ino)fail('local-path-invalid')
    return {path,device:String(info.dev),inode:String(info.ino)}
  }

  private async file(path:string,privateOnly=false):Promise<void>{
    const info=await lstat(path)
    if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||await realpath(path)!==path||info.size>this.options.limits.maxBytes)fail('local-data-invalid')
    if(privateOnly&&await privateFileState(path,info,this.options.limits.maxBytes)!=='private')fail('local-data-invalid')
  }

  private async environment(home:string):Promise<void>{
    const file=join(home,'.env')
    try{await this.file(file)}catch(error){if(missing(error))return;throw error}
    const keys=recoveredEnvironmentKeys(parseEnv(await readFile(file,'utf8')))
    if(keys.length){
      if(keys.length>128||keys.some(key=>!/^[A-Z_][A-Z0-9_]{0,127}$/iu.test(key)))fail('local-environment-invalid')
      throw new GovernanceLocalEnvironmentReview(keys.map(key=>key.toUpperCase()))
    }
  }

  private async personal(row:Subject,home:string,signal:AbortSignal){
    const file=join(await realpath(this.cfg.stateRoot),'personal-directory','index.sqlite')
    await this.file(file)
    for(const suffix of ['-wal','-shm','-journal']){
      try{await this.file(file+suffix)}catch(error){if(!missing(error))throw error}
    }
    const owner=JSON.stringify([row.organizationId,row.nodeId,row.runtimeId,row.publicId]),db=new DatabaseSync(file,{readOnly:true})
    const sessions=new Set<string>(),workspaces:string[]=[],hash=createHash('sha256');let bytes=0,count=0
    try{
      db.exec('BEGIN')
      const version=db.prepare('PRAGMA user_version').get() as {user_version:number}
      if(version.user_version!==1)fail('local-directory-unsupported')
      const publication=db.prepare('SELECT CAST(generation AS TEXT) generation,revision,digest,has_conversations FROM publications WHERE owner=?').get(owner)
      if(!publication)fail('local-directory-unpublished')
      if(BigInt(String(publication.generation))>BigInt(row.sourceGeneration))fail('local-generation-ahead')
      hash.update(JSON.stringify(publication))
      for(const kind of ['workspaces','conversations','members'] as const){
        for(const item of db.prepare('SELECT * FROM '+kind+' WHERE owner=? ORDER BY '+(kind==='members'?'workspace,session':'id')).iterate(owner)){
          signal.throwIfAborted();const text=JSON.stringify(item);bytes+=Buffer.byteLength(text)
          if(++count>this.options.limits.maxRows||bytes>this.options.limits.maxBytes)fail('local-data-budget')
          hash.update(text)
          if(kind==='workspaces'){
            const value=z.object({path:z.string()}).passthrough().parse(JSON.parse(String(item.value)))
            workspaces.push(value.path)
          }else sessions.add(String(kind==='members'?item.session:item.id))
        }
      }
      db.exec('COMMIT')
    }finally{db.close()}
    const root=join(home,'sessions'),info=await lstat(root).catch(error=>{if(missing(error))return;throw error})
    if(info&&(!info.isDirectory()||info.isSymbolicLink()||await realpath(root)!==root))fail('local-session-evidence-incomplete')
    const old=info?await inspectPersonalSessions(root,this.options.limits,signal):{sessionIds:[]}
    const ids=new Set(old.sessionIds)
    if([...sessions].some(id=>!ids.has(id)))fail('local-session-evidence-incomplete')
    return {oldSessionIds:old.sessionIds,workspaces,catalogDigest:hash.digest('hex'),indexedSessionCount:sessions.size}
  }

  private async project(row:Subject,signal:AbortSignal){
    if(!this.options.volume||!row.volumeId)fail('local-volume-required')
    return this.options.volume.readVolume(async tx=>{
      const args=[row.organizationId,row.ownerId,row.runtimeId,row.nodeId,row.volumeId,row.writerEpoch]
      const space=(await tx.query<{root_path:string;runtime_generation:string}>(`SELECT root_path,runtime_generation::text FROM node_content.spaces
        WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND node_id=$4 AND volume_id=$5 AND writer_epoch=$6`,args)).rows[0]
      if(!space)fail('local-project-placement-mismatch')
      if(BigInt(space.runtime_generation)>BigInt(row.sourceGeneration))fail('local-generation-ahead')
      signal.throwIfAborted()
      const ids=(await tx.query<{id:string}>(`SELECT id FROM node_content.conversation_sessions WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3
        ORDER BY id LIMIT $4`,[row.organizationId,row.ownerId,row.runtimeId,this.options.limits.maxRows+1])).rows.map(item=>item.id)
      if(ids.length>this.options.limits.maxRows||Buffer.byteLength(JSON.stringify(ids))>this.options.limits.maxBytes)fail('local-data-budget')
      return {oldSessionIds:ids,workspaces:[space.root_path],catalogDigest:sha(JSON.stringify([args,space,ids])),indexedSessionCount:ids.length}
    })
  }

  /** Inspect existing node data and write only a private immutable receipt. The caller publishes its opaque proof under the stopped-generation lock.
   * @param id - preserved per-Runtime rebuilding operation.
   * @param selection - explicit node-local paths; omission tries the ordinary layout but never creates it.
   * @param signal - bounded inspection cancellation.
   * @returns checksums and counts suitable for the governance receipt, with no business paths or content.
   */
  async bind(id:string,selection:GovernanceLocalDataSelection|undefined,signal:AbortSignal):Promise<GovernanceLocalDataProof>{
    const row=await this.subject(id,true),users=row.ownerKind==='user'?await realpath(this.cfg.usersRoot):''
    const standard=row.ownerKind==='user'?personalRuntimeLayout({usersRoot:users},{username:row.username!,runtimeId:row.runtimeId,storageLayout:row.storageLayout}).dshHome:
      join(await realpath(this.cfg.projectRuntimesRoot),String(row.publicId),'dsh')
    const runtimeHome=selection?.runtimeHome??standard
    const runtimeRoot=await this.directory(runtimeHome)
    await this.directory(join(runtimeHome,'profiles','web'))
    await this.file(join(runtimeHome,'profiles','web','package.json'))
    // A bundle-only profile has no local patch; an existing patch still needs ordinary file evidence.
    await this.file(join(runtimeHome,'profiles','web','cordis.patch.yml')).catch(error=>{if(!missing(error))throw error})
    await this.environment(runtimeHome)
    const inspected=row.ownerKind==='user'?await this.personal(row,runtimeHome,signal):await this.project(row,signal)
    // Empty nonstandard Runtime homes have no Session identity to bind them to the preserved allocation.
    if(runtimeHome!==standard&&!inspected.indexedSessionCount)fail('local-runtime-identity-unproven')
    const homePath=selection?.homePath??(row.ownerKind==='user'?join(users,row.username!,'home'):inspected.workspaces[0]!)
    if(row.ownerKind==='project'&&homePath!==inspected.workspaces[0])fail('local-project-placement-mismatch')
    if(row.ownerKind==='user'){
      const accepted=(await this.accountHomes([row.publicId])).get(row.publicId)
      if(accepted!==undefined&&accepted!==null&&accepted!==homePath)fail('local-account-home-conflict')
    }
    const roots=[runtimeRoot,await this.directory(homePath)]
    for(const path of new Set(inspected.workspaces))roots.push(await this.directory(path))
    const latest=await this.subject(id,true)
    if(JSON.stringify([latest.runtimeId,latest.ownerId,latest.sourceGeneration,latest.writerEpoch,latest.volumeId])!==
      JSON.stringify([row.runtimeId,row.ownerId,row.sourceGeneration,row.writerEpoch,row.volumeId]))fail('local-generation-changed')
    const bindingId=randomUUID(),saved=evidenceSchema.parse({version:1,bindingId,operationId:id,organizationId:row.organizationId,nodeId:row.nodeId,
      runtimeId:row.runtimeId,ownerId:row.ownerId,ownerKind:row.ownerKind,sourceGeneration:row.sourceGeneration,writerEpoch:row.writerEpoch,volumeId:row.volumeId,
      homePath,runtimeHome,cwd:inspected.workspaces[0]??homePath,roots,oldSessionIds:inspected.oldSessionIds,catalogDigest:inspected.catalogDigest})
    const directory=join(await realpath(this.cfg.stateRoot),'governance-rebuild-local',id)
    await peerPrivateDirectory(dirname(directory));await peerPrivateDirectory(directory)
    const text=JSON.stringify(saved)
    if(Buffer.byteLength(text)>this.options.limits.maxBytes)fail('local-data-budget')
    const file=await open(join(directory,bindingId+'.json'),'wx',0o600)
    try{await file.writeFile(text);await file.sync()}finally{await file.close()}
    return {bindingId,evidenceDigest:sha(text),oldSessionCount:saved.oldSessionIds.length,sourceGeneration:row.sourceGeneration}
  }

  /** Verify original directories and current placement without expanding the frozen old Session set.
   * @param id - preserved per-Runtime rebuilding operation. @param reference - immutable governance binding receipt.
   * @returns node-private evidence, which must never be returned through a management response.
   */
  async verify(id:string,reference:GovernanceLocalDataReference):Promise<Evidence>{
    const row=await this.subject(id),saved=await this.readEvidence(id,reference)
    if(saved.organizationId!==row.organizationId||saved.nodeId!==row.nodeId||
      saved.runtimeId!==row.runtimeId||saved.ownerId!==row.ownerId||saved.ownerKind!==row.ownerKind||saved.sourceGeneration!==row.sourceGeneration||
      saved.writerEpoch!==row.writerEpoch||saved.volumeId!==row.volumeId)fail('local-binding-changed')
    for(const item of saved.roots){const current=await this.directory(item.path);if(current.device!==item.device||current.inode!==item.inode)fail('local-binding-changed')}
    await this.environment(saved.runtimeHome)
    if(row.ownerKind==='project'){
      if(!this.options.volume)fail('local-volume-required')
      const present=await this.options.volume.readVolume(tx=>tx.query(`SELECT FROM node_content.spaces WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3
        AND node_id=$4 AND volume_id=$5 AND writer_epoch=$6 AND root_path=$7`,[row.organizationId,row.ownerId,row.runtimeId,row.nodeId,row.volumeId,row.writerEpoch,saved.cwd]))
      if(present.rowCount!==1)fail('local-project-placement-mismatch')
    }
    return saved
  }

  private async readEvidence(id:string,reference:GovernanceLocalDataReference):Promise<Evidence>{
    z.uuid().parse(id);z.uuid().parse(reference.bindingId);sum.parse(reference.evidenceDigest)
    const path=join(await realpath(this.cfg.stateRoot),'governance-rebuild-local',id,reference.bindingId+'.json')
    await this.file(path,true)
    const text=await readFile(path,'utf8')
    if(sha(text)!==reference.evidenceDigest)fail('local-binding-changed')
    const saved=evidenceSchema.parse(JSON.parse(text))
    if(saved.bindingId!==reference.bindingId||saved.operationId!==id)fail('local-binding-changed')
    return saved
  }

  /** Read node-private launch paths; current administrator policy is resolved from governance, never restored configuration.
   * @param id - preserved rebuilding operation. @param reference - accepted binding receipt.
   * @returns private launch paths and current administrator status.
   */
  async paths(id:string,reference:GovernanceLocalDataReference){const saved=await this.verify(id,reference),row=await this.subject(id)
    return {home:saved.runtimeHome,homePath:saved.homePath,cwd:saved.cwd,admin:row.admin}}
  /** Return the immutable historical Session set for the existing execution-review policy; new Sessions remain executable.
   * @param id - preserved rebuilding operation. @param reference - accepted binding receipt.
   * @returns original Session IDs for the node-local recovery policy only.
   */
  async oldSessionIds(id:string,reference:GovernanceLocalDataReference){return (await this.verify(id,reference)).oldSessionIds}

  /** Resolve account-owned homes from accepted bindings of the latest rebuild on this computer, independently of Runtime retirement.
   * @param ids - organization-scoped public account identifiers requested by the user service.
   * @returns a private home per restored account, null while no binding is accepted, and no entry for ordinary or newer scope-owned allocations.
   */
  async accountHomes(ids:readonly number[]):Promise<ReadonlyMap<number,string|null>>{
    if(!ids.length)return new Map()
    const rows=(await this.context.pool.query<{userId:number;ownerId:string;id:string|null;runtimeId:string|null;sourceGeneration:string|null;writerEpoch:string|null;
      bindingId:string|null;evidenceDigest:string|null}>(`SELECT u.public_id::float8 "userId",u.id "ownerId",r.id,r.runtime_id "runtimeId",
      r.source_generation::text "sourceGeneration",r.writer_epoch::text "writerEpoch",b.binding_id "bindingId",b.evidence_digest "evidenceDigest"
      FROM harness.node_user_accounts a JOIN harness.users u ON u.organization_id=a.organization_id AND u.id=a.user_id
      LEFT JOIN harness.governance_rebuild_runtimes r ON r.organization_id=a.organization_id AND r.node_id=a.node_id AND r.owner_id=u.id AND r.owner_kind='user'
        AND r.operation_id=(SELECT id FROM harness.governance_rebuild_operations WHERE organization_id=$1 ORDER BY recovery_epoch DESC LIMIT 1)
      LEFT JOIN harness.governance_rebuild_data_bindings b ON b.runtime_operation_id=r.id AND b.organization_id=r.organization_id
        AND b.runtime_id=r.runtime_id AND b.node_id=r.node_id AND b.source_generation=r.source_generation
      WHERE a.organization_id=$1 AND a.node_id=$2 AND u.public_id=ANY($3::bigint[]) AND u.deleted_at IS NULL
        AND a.home_path='governance-recovery-unbound:'||u.id::text
      ORDER BY u.public_id,r.id LIMIT $4`,[this.context.organizationId,this.context.nodeId,ids,this.options.limits.maxRows+1])).rows
    if(rows.length>this.options.limits.maxRows)fail('local-data-budget')
    const homes=new Map<number,string|null>()
    for(const row of rows){
      if(!homes.has(row.userId))homes.set(row.userId,null)
      if(row.id===null||row.bindingId===null||row.evidenceDigest===null)continue
      const saved=await this.readEvidence(row.id,{bindingId:row.bindingId,evidenceDigest:row.evidenceDigest})
      if(saved.organizationId!==this.context.organizationId||saved.nodeId!==this.context.nodeId||saved.ownerKind!=='user'||saved.ownerId!==row.ownerId||
        saved.runtimeId!==row.runtimeId||saved.sourceGeneration!==row.sourceGeneration||saved.writerEpoch!==row.writerEpoch||saved.volumeId!==null)fail('local-binding-changed')
      const recorded=saved.roots.find(root=>root.path===saved.homePath)
      if(!recorded)fail('local-binding-changed')
      const actual=await this.directory(saved.homePath)
      if(actual.device!==recorded.device||actual.inode!==recorded.inode)fail('local-binding-changed')
      const current=homes.get(row.userId)
      if(current!==null&&current!==saved.homePath)fail('local-account-home-conflict')
      homes.set(row.userId,saved.homePath)
    }
    return homes
  }
}
