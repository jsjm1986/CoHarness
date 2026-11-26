/** Target-owned personal replacement uses verified private roots and inode-preserving publication. */
import { createHash } from 'node:crypto'
import { lstat,mkdir,readFile,realpath,writeFile } from 'node:fs/promises'
import { dirname,join,parse,relative,sep } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { withDocumentDirectoryMove } from '@deepseek-ai/dsh-userdoc-local'
import { z } from 'zod'
import type { GatewayConfig } from './config.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { NodeContentStore } from './node-content-store.ts'
import type { PeerPersonalRecoveryOperation } from './peer-backup-personal-recovery.ts'
import type { PeerBackupDrill } from './peer-backup-restic.ts'
import { readPersonalRecoveryPoint } from './peer-backup-personal.ts'
import { stagePersonalRecoveryFiles,readPersonalRecoveryEvidence,personalRecoveryInput,personalRecoveryLaunchPaths,type PersonalRecoveryLimits,type PersonalRecoveryEvidence } from './peer-backup-personal-stage.ts'
import { snapshotManagedFiles } from './managed-files.ts'
import { suspendRecoveredSchedules } from './peer-backup-disaster-schedule.ts'
import { suspendRecoveredEnvironment } from './peer-runtime-profile.ts'
import { sealRecoveryEnvironment } from './peer-recovery-environment.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { documentIdentityLocations } from './document-storage.ts'
import { syncStateDirectory } from './node-private-file.ts'
import { importPersonalRecoveryProjection } from './peer-backup-personal-projection.ts'
import { importPersonalRecoveryDocuments } from './peer-backup-personal-db.ts'

type Root=PersonalRecoveryEvidence['roots'][number]
function fail(code:string):never{throw new PeerBackupError(409,'peer-backup/'+code)}
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
async function info(path:string){return lstat(path,{bigint:true}).catch((error:unknown)=>{if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return;throw error})}
async function physical(path:string){
  const entry=await info(path)
  if(!entry)return
  if(!entry.isDirectory()||entry.isSymbolicLink()||await realpath(path)!==path)fail('personal-target-changed')
  return {device:String(entry.dev),inode:String(entry.ino)}
}
const same=(a:{device:string;inode:string}|undefined,b:{device:string;inode:string})=>!!a&&a.device===b.device&&a.inode===b.inode
async function located(root:Root){
  if(same(await physical(root.staged),root))return root.staged
  if(root.destination&&same(await physical(root.destination),root))return root.destination
  return fail('personal-target-changed')
}

/** Compare contents and directory ownership without treating moved destination paths as different data. */
export async function personalCandidateDigest(roots:readonly Root[],limits:PersonalRecoveryLimits,signal:AbortSignal):Promise<string>{
  const names=await Promise.all(roots.map(async root=>({owner:root.role,path:await located(root),kind:'directory' as const})))
  const snapshot=await snapshotManagedFiles(names,undefined,signal,{maxBytes:limits.maxBytes,maxEntries:limits.maxRows})
  if(snapshot.absent.length)fail('personal-target-changed')
  const role=(path:string)=>{
    const root=names.find(row=>path===row.path||path.startsWith(row.path+sep))
    if(!root)fail('personal-target-changed')
    return [root.owner,relative(root.path,path)]
  }
  return sha([
    ...snapshot.directories.map(row=>JSON.stringify(['directory',...role(row.path),row.mode])),
    ...snapshot.files.map(row=>JSON.stringify(['file',...role(row.sourcePath),row.mode,row.sizeBytes,row.sha256])),
  ].sort().join('\n'))
}

async function rebindWorkspace(storage:string,mappings:PersonalRecoveryEvidence['workspaces'],limits:PersonalRecoveryLimits){
  const single=join(storage,'workspace.json'),tree=join(storage,'workspace'),singleInfo=await info(single),treeInfo=await info(tree)
  if(singleInfo&&treeInfo)fail('personal-workspace-evidence-incomplete')
  const records=z.record(z.string(),z.unknown()),byId=new Map(mappings.map(row=>[row.id,row]))
  const amend=(id:string,raw:unknown)=>{
    const row=records.parse(raw),mapping=byId.get(id)
    if(!mapping||row.path!==mapping.source)fail('personal-workspace-evidence-incomplete')
    byId.delete(id);return {...row,path:mapping.destination}
  }
  const read=async(path:string)=>{const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limits.maxBytes)fail('personal-workspace-evidence-incomplete');return records.parse(JSON.parse(await readFile(path,'utf8')))}
  if(singleInfo){
    const value=await read(single),unit=records.parse(value.unit),tables=records.parse(value.tables),workspaces=records.parse(tables.workspaces)
    if(unit.name!=='workspace'||unit.version!==2)fail('personal-workspace-evidence-incomplete')
    const result=Object.fromEntries(Object.entries(workspaces).map(([id,row])=>[id,amend(id,row)]))
    await writeFile(single,JSON.stringify({...value,tables:{...tables,workspaces:result}})+'\n',{mode:0o600,flush:true})
  }else if(treeInfo){
    for(const row of mappings){const path=join(tree,'workspaces',row.id+'.json');if(dirname(path)!==join(tree,'workspaces'))fail('personal-workspace-evidence-incomplete');const value=await read(path);await writeFile(path,JSON.stringify({...value,record:amend(row.id,value.record)})+'\n',{mode:0o600,flush:true})}
  }
  if(byId.size)fail('personal-workspace-evidence-incomplete')
}

/** Prepare only the private restored copy: schedules pause, registry paths move, immutable Session bytes remain untouched. */
export async function preparePersonalCandidate(op:PeerPersonalRecoveryOperation,
  proof:Awaited<ReturnType<typeof readPersonalRecoveryPoint>>,candidate:string,layout:Pick<PersonalRecoveryEvidence,'homePath'|'runtimeHome'|'workspaces'>,
  limits:PersonalRecoveryLimits,signal:AbortSignal):Promise<{roots:Root[];suspendedEnvironmentKeys:string[]}>{
  const runtime=join(candidate,'content',op.runtimeId,'runtime')
  const suspendedEnvironmentKeys=await sealRecoveryEnvironment(runtime,await suspendRecoveredEnvironment(runtime,limits.maxBytes),limits.maxBytes)
  await suspendRecoveredSchedules(join(runtime,'storages'),limits,signal)
  await rebindWorkspace(join(runtime,'storages'),layout.workspaces,limits)
  const inventory=join(runtime,'managed-data.jsonl'),text=await readFile(inventory,'utf8')
  const rows=text.trimEnd().split('\n').filter(Boolean).map(line=>z.object({version:z.literal(1),owner:z.string(),kind:z.enum(['file','directory']),path:z.string()}).strict().parse(JSON.parse(line)))
  const rebound=rows.map(row=>{
    if(row.owner==='@deepseek-ai/dsh-userdoc-local'&&row.kind==='directory'&&proof.roots.roots.some(root=>root.role==='userdoc-public'&&root.logicalSource===row.path))
      return {...row,path:join(layout.homePath,'documents')}
    const declared=proof.roots.roots.find(item=>item.logicalSource===row.path&&item.owner===row.owner&&item.kind===row.kind)??
      proof.roots.roots.find(item=>item.owner==='gateway-runtime-profiles'&&item.kind==='directory'&&row.path.startsWith(item.logicalSource!+sep))
    if(!declared||!['runtime','artifact'].includes(declared.role))fail('invalid-plugin-inventory')
    return {...row,path:join(layout.runtimeHome,...declared.key.split('/'),relative(declared.logicalSource!,row.path))}
  })
  await writeFile(inventory,rebound.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600,flush:true})
  const paths:[string,string,string|null][]=[['runtime',runtime,layout.runtimeHome],
    ...layout.workspaces.map(row=>['workspace:'+row.id,join(candidate,'content',op.runtimeId,'workspace',row.key),row.destination] as [string,string,string]),
    ...(!op.documentReceiptOperationId?['userdoc-public','userdoc-metadata','userdoc-objects'].map(role=>[role,join(candidate,'content','accounts',op.accountId,op.sourceNode,role),null] as [string,string,null]):[]),
  ]
  return {roots:await Promise.all(paths.map(async([role,staged,destination])=>{const actual=await physical(staged);if(!actual)fail('personal-target-changed');return {role,staged,destination,...actual}})),suspendedEnvironmentKeys}
}

/** Scoped adapter shared by the target worker and the ordinary Runtime launcher; it never opens a restored plugin. */
export class PeerPersonalRecoveryFiles {
  constructor(private readonly context:PostgresRuntimeContext,private readonly cfg:GatewayConfig,private readonly volume?:Pick<NodeContentStore,'readVolume'|'writeVolume'>,private readonly limits?:PersonalRecoveryLimits){}
  /** Certify a native point in a private directory while the source continues unchanged. */
  async stage(op:PeerPersonalRecoveryOperation,drill:PeerBackupDrill,signal:AbortSignal){
    this.local(op)
    const {limits}=this.provisioned()
    const account=(await this.context.pool.query<{home_path:string}>('SELECT home_path FROM harness.node_user_accounts WHERE organization_id=$1 AND node_id=$2 AND user_id=$3',[op.organizationId,op.targetNode,op.accountId])).rows[0]
    return stagePersonalRecoveryFiles(this.cfg,op,drill,limits,signal,account?.home_path)
  }
  private provisioned(){if(!this.volume||!this.limits)throw new PeerBackupError(503,'peer-backup/execution-not-provisioned');return {volume:this.volume,limits:this.limits}}
  private local(op:PeerPersonalRecoveryOperation){if(op.organizationId!==this.context.organizationId||op.targetNode!==this.context.nodeId)fail('wrong-recovery-node')}
  /** Use the exact installed target home and new-work directory after formal publication. */
  async paths(op:PeerPersonalRecoveryOperation){
    this.local(op)
    const member=(await this.context.pool.query<{role:string}>(`SELECT m.role FROM harness.memberships m JOIN harness.users u ON u.id=m.user_id AND u.organization_id=m.organization_id
      WHERE m.organization_id=$1 AND m.user_id=$2 AND m.status='active' AND u.status='active' AND u.deleted_at IS NULL`,[op.organizationId,op.accountId])).rows[0]
    if(!member)fail('personal-owner-unavailable')
    return {...await personalRecoveryLaunchPaths(this.cfg,op),admin:member.role==='admin'}
  }
  /** Return the immutable root-and-child Session set from this computer's sealed evidence. */
  async oldSessions(op:PeerPersonalRecoveryOperation){this.local(op);return (await readPersonalRecoveryEvidence(this.cfg,op)).oldSessionIds}
  /** Publish only the recorded directories under an already-held account file gate, then leave execution held. */
  async activate(op:PeerPersonalRecoveryOperation,drill:PeerBackupDrill,signal:AbortSignal){
    this.local(op)
    const {volume,limits}=this.provisioned()
    if(op.phase!=='activating'||!(await this.context.pool.query('SELECT 1 WHERE harness.node_physically_isolated($1,$2)',[op.organizationId,op.sourceNode])).rowCount)fail('recovery-approval-changed')
    const saved=await readPersonalRecoveryEvidence(this.cfg,op),input=await personalRecoveryInput(op,drill,limits,signal)
    if(input.proof.documentDigest!==saved.documentDigest)fail('personal-target-changed')
    const base=join(this.cfg.stateRoot,'peer-personal-recovery',op.id),planFile=join(base,'installation.json')
    const prior=await readFile(planFile,'utf8').catch((error:unknown)=>{if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return;throw error})
    let roots:Root[]
    if(prior){
      const plan=z.object({evidenceDigest:z.string(),roots:z.array(z.object({role:z.string(),staged:z.string(),destination:z.string().nullable(),device:z.string(),inode:z.string()}).strict())}).strict().parse(JSON.parse(prior))
      if(plan.evidenceDigest!==op.evidenceDigest)fail('personal-target-changed');roots=plan.roots
      if(roots.length!==saved.roots.length||roots.some(row=>!saved.roots.some(old=>row.role===old.role&&row.staged===old.staged&&same(row,old)&&
        (old.destination===null||row.destination===old.destination))))fail('personal-target-changed')
    }else{
      for(const path of [saved.homePath,dirname(saved.runtimeHome),...saved.workspaces.map(row=>dirname(row.destination))]){
        await mkdir(path,{recursive:true,mode:0o700});if(await realpath(path)!==path)fail('invalid-target-files')
      }
      roots=saved.roots.map(row=>({...row}))
      if(!op.documentReceiptOperationId){
        const docs=await documentIdentityLocations(this.cfg,saved.homePath,join(saved.homePath,'documents'),{organizationId:op.organizationId,target:{kind:'user',id:op.userId},projectionOwner:async()=>fail('personal-target-documents-exist')},async()=>{})
        for(const row of roots){if(row.role==='userdoc-public')row.destination=docs.root;else if(row.role==='userdoc-metadata')row.destination=docs.stateRoot;else if(row.role==='userdoc-objects')row.destination=docs.filesRoot}
      }
      for(const row of roots)if(!row.destination||await info(row.destination))fail('replacement-must-be-empty')
      await writeFileAtomic(planFile,JSON.stringify({evidenceDigest:op.evidenceDigest,roots}),{mode:0o600})
    }
    if(await personalCandidateDigest(roots,limits,signal)!==saved.installedDigest)fail('personal-target-changed')
    for(const row of roots){
      signal.throwIfAborted()
      const destination=row.destination??fail('personal-target-changed')
      if(same(await physical(destination),row))continue
      if(await info(destination)||!same(await physical(row.staged),row)||await realpath(dirname(destination))!==dirname(destination))fail('personal-target-changed')
      await withDocumentDirectoryMove(parse(destination).root,row.staged,destination,async handle=>{
        await handle.verify()
        if(!same(await physical(row.staged),row))fail('personal-target-changed')
        await handle.rename();await handle.sync()
      })
      await syncStateDirectory(dirname(destination))
      if(!same(await physical(destination),row))fail('personal-target-changed')
    }
    if(await personalCandidateDigest(roots,limits,signal)!==saved.installedDigest)fail('personal-target-changed')
    await importPersonalRecoveryDocuments(volume,op,input.proof.documents,drill.directory,limits,signal)
    await importPersonalRecoveryProjection(this.cfg.stateRoot,op,drill.directory,saved.workspaces,limits,signal)
    return {homePath:saved.homePath,documentDigest:saved.documentDigest,filesDigest:saved.filesDigest,evidenceDigest:op.evidenceDigest!}
  }
}
