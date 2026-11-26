/** Exact personal Runtime files copied from an immutable node view. Logical paths are restored only below a new private directory. */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, opendir, readFile, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { readManagedDataPaths, type ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { z } from 'zod'
import { restoreDocumentIdentityBackup, type DocumentBackupEntry } from '@deepseek-ai/dsh-userdoc-local'
import type { personalDocumentReceipt } from './peer-backup-personal-db.ts'
import { privateFileState } from './node-private-file.ts'
import { copyVerifiedFile, snapshotManagedFiles } from './managed-files.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { readVerifiedPeerManagedFiles, type PeerBackupBinding } from './peer-backup-restic.ts'
import { openPeerBtrfsSnapshot } from './peer-btrfs-snapshot.ts'
import { openPeerVssSnapshot } from './peer-vss-snapshot.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import type { Queryable } from './postgres/database.ts'
import { recoveryExecutionDataRoots } from './peer-backup-execution-data.ts'
import { nativeRuntimeProfileData,managedRuntimeProfileKey } from './peer-runtime-profile.ts'
import { watchPeerSourcePaths, writePeerSourceFile, type PeerSourceWrites } from './peer-backup-source-space.ts'

const invalid = () => new PeerBackupError(409,'peer-backup/invalid-personal-files')
const unavailable = () => new PeerBackupError(503,'peer-backup/personal-snapshot-unavailable')
const over = () => new PeerBackupError(507,'peer-backup/export-budget')
const absolute = z.string().min(1).max(4096).refine(isAbsolute)
const volume = z.object({ runtimeId:z.uuid(), source:absolute, snapshotDirectory:absolute, volume:z.guid().optional(),
  workspaces:z.array(z.object({id:z.string().min(1).max(512),path:absolute}).strict()).max(1024).default([]),
  artifacts:z.array(z.object({path:absolute,kind:z.enum(['file','directory'])}).strict()).max(1024).default([]) }).strict()
const settings = z.object({version:z.literal(1),organizationId:z.uuid(),nodeId:z.uuid(),provider:z.enum(['btrfs','vss']),
  runtimes:z.array(volume).min(1).max(2048)}).strict()
type Selection=z.infer<typeof volume>
type Provider=z.infer<typeof settings>['provider']
type Budget={maxBytes:number;maxRows:number;space?:PeerSourceWrites}
type Owner={account:string;username:string;home:string;runtimeHome:string;generation:string}
type FilesRole='runtime'|'artifact'|'workspace'|'recovery-private'|'userdoc-public'|'userdoc-metadata'|'userdoc-objects'
type DocReceipt=z.infer<typeof personalDocumentReceipt>
type DocLocations={root:string;stateRoot:string;filesRoot:string}
type FsRoot={role:FilesRole;key:string;owner:string;kind:'file'|'directory';source:string;expectedSha256?:string}
type Frame={root:string;map(path:string):string;inspect?(paths:readonly string[],limit:number):Promise<void>;confirm():Promise<void>;
  release():Promise<void>;verifiedPath?(path:string):string;devices?:{sourceDevice:string;snapshotDevice:string}}
type FileCapture={receipt:z.infer<typeof personalFileReceipt>;gaps:string[]}

/** One immutable view shared by scoped directory, draft and Runtime-file exports. */
export interface PersonalFilesSnapshot {
  /** Original native snapshot time, independent of later file-copy time. */
  capturedAt:string
  /** Account UUID already verified against this Runtime assignment. */
  account:string
  /** Supervisor process generation observed on both sides of the immutable view. */
  generation:string
  /** Resolve only the directory and draft stores when both belong to this native view. */
  localState(stateRoot:string,maxRows:number):Promise<string|undefined>
  /** Copy this Runtime's selected roots from this same immutable view. */
  capture(directory:string,budget:Budget,documents?:DocReceipt,stateRoot?:string):Promise<FileCapture>
}

/** Exact OS snapshot generation used by the file exporters and deterministic provider tests. */
export type PersonalSnapshotOpener=(provider:Provider, selection:Selection, timeout:number, signal:AbortSignal)=>Promise<Frame>

const openNative:PersonalSnapshotOpener=async(provider,selection,timeout,signal)=>{
  if(provider==='btrfs')return openPeerBtrfsSnapshot(selection.source,selection.snapshotDirectory,timeout,signal)
  if(!selection.volume)throw unavailable()
  return openPeerVssSnapshot(selection.source,selection.volume,selection.snapshotDirectory,timeout,signal)
}
const roles=z.enum(['runtime','artifact','workspace','recovery-private','userdoc-public','userdoc-metadata','userdoc-objects'])
const rootInventory=z.object({version:z.union([z.literal(1),z.literal(2)]),organizationId:z.uuid(),nodeId:z.uuid(),runtimeId:z.uuid(),account:z.uuid(),userId:z.number().int().positive(),runtimeHome:z.string().max(4096).optional(),
  roots:z.array(z.object({role:roles,key:z.string().min(1).max(1024),owner:z.string().min(1).max(256),
    kind:z.enum(['file','directory']),source:z.string().min(1).max(4096),logicalSource:z.string().min(1).max(4096).optional(),expectedSha256:z.string().regex(/^[a-f0-9]{64}$/u).optional()}).strict()).max(100000)}).strict()
/** Watermarks for file bytes only. A plugin or Schedule delivery needs its own replay evidence. */
export const personalFileReceipt=z.object({digest:z.string().regex(/^[0-9a-f]{64}$/u),roots:z.number().int().nonnegative(),capturedAt:z.iso.datetime()}).strict()
const allowed = new Map<string,[string,ManagedDataPath['kind']]>([
  ['@deepseek-ai/dsh-session-persistence-jsonl',['sessions','directory']],
  ['@deepseek-ai/dsh-attachment-local',['attachments/v1','directory']],
  ['@deepseek-ai/dsh-storage-json',['storages','directory']],
  ['@deepseek-ai/dsh-settings-file',['settings.yaml','file']],
  ['@deepseek-ai/dsh-agent-preset-registry',['.agent-presets','directory']],
  ['@deepseek-ai/dsh-workspace-changes',['workspace-reviews','directory']],
  ['@deepseek-ai/dsh-credentials-local',['.credentials.yaml','file']],
  ['@deepseek-ai/dsh-anonymous-user-id',['.anonymous-user-id','file']],
  ['gateway-personal-inventory',['managed-data.jsonl','file']],
])
const profileFiles=new Set(['package.json','cordis.patch.yml','pnpm-workspace.yaml','pnpm-lock.yaml'])
function runtimeKeyValid(owner:string,key:string,kind:ManagedDataPath['kind']):boolean{
  if(managedRuntimeProfileKey(owner,key,kind))return true
  if(owner==='app-boot'){
    const parts=key.split('/')
    return kind==='file'&&parts.length===3&&parts[0]==='profiles'&&!!parts[1]&&parts[1]!=='node_modules'&&profileFiles.has(parts[2]!)
  }
  const fixed=allowed.get(owner)
  return fixed?.[0]===key&&fixed[1]===kind
}
const subpath=(parent:string,path:string)=>{const rest=relative(parent,path);return rest==='' || !isAbsolute(rest)&&rest!=='..'&&!rest.startsWith('..'+sep)}
function safeComponents(text:string):string[] {
  const parts=text.split('/')
  if(parts.some(part=>!part || part==='..'||part==='.'||/[\\:\x00-\x1f<>"|?*]/u.test(part)||/[ .]$/u.test(part)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)))throw invalid()
  return parts
}
function fileKey(name:string){return createHash('sha256').update(name).digest('hex')}
async function trustedConfig(path:string){
  if(await realpath(path)!==resolve(path)||await privateFileState(path,await lstat(path),1<<20)!=='private')throw unavailable()
  return settings.parse(JSON.parse(await readFile(path,'utf8')))
}
async function filePresent(path:string) {
  try {return await lstat(path)} catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
}
function workspaceRows(directory:string):Map<string,string>{
  const db=new DatabaseSync(join(directory,'personal.sqlite'),{readOnly:true})
  try {
    const rows=new Map<string,string>()
    for(const result of db.prepare("SELECT body FROM records WHERE collection='workspaces'").iterate()){
      const record=JSON.parse(String(result.body)) as {id?:string;value?:string}
      if(!record.id)throw invalid()
      const item=JSON.parse(String(record.value)) as {path?:string;workspaceId?:string}
      if(item.workspaceId!==record.id||typeof item.path!=='string'||rows.has(record.id))throw invalid()
      rows.set(record.id,item.path)
    }
    return rows
  }finally{db.close()}
}

/** The operator chooses a volume, while live allocation and the promoted directory decide which registered files it may contain. */
export class PeerPersonalFiles {
  constructor(private readonly control:Queryable,private readonly configFile:string,private readonly timeout:number,
    private readonly resolvePaths:(target:{kind:'user';id:number;runtimeId:RuntimeId})=>Promise<{homePath:string;dshHome:string}>,
    private readonly documentRoots?: (user:number,rootId:string,cursor:{sequence:number;ordinal:number},maxRows:number)=>Promise<DocLocations>,
    private readonly acquire:PersonalSnapshotOpener=openNative){}
  private async owner(binding:PeerBackupBinding,userId:number):Promise<Owner>{
    const result=await this.control.query<Pick<Owner,'account'|'username'|'generation'>>(`SELECT u.id account,u.username::text,i.generation::text
      FROM harness.runtime_environments e JOIN harness.users u ON (u.organization_id,u.id)=(e.organization_id,e.owner_id)
      JOIN harness.instances i ON (i.organization_id,i.runtime_id,i.assigned_node_id,i.user_id)=(e.organization_id,e.id,e.node_id,e.owner_id)
      JOIN harness.node_user_accounts ua ON (ua.organization_id,ua.node_id,ua.user_id)=(e.organization_id,e.node_id,u.id)
      WHERE e.organization_id=$1 AND e.node_id=$2 AND e.id=$3 AND u.public_id=$4 AND e.owner_kind='user'
        AND e.retired_at IS NULL AND i.provisioning_state='ready'`,[binding.organizationId,binding.sourceNodeId,binding.scopeId,userId])
    const row=result.rows[0]
    if(!row || !row.username || row.username==='.'||row.username==='..'||/[\\/]/u.test(row.username))throw unavailable()
    const paths=await this.resolvePaths({kind:'user',id:userId,runtimeId:binding.scopeId as RuntimeId})
    if(!isAbsolute(paths.homePath)||!isAbsolute(paths.dshHome))throw unavailable()
    return {...row,home:paths.homePath,runtimeHome:paths.dshHome}
  }
  /** Acquire one native view without pausing the Runtime; release it after every scoped reader finishes. */
  async snapshot<T>(binding:PeerBackupBinding,userId:number,signal:AbortSignal,work:(snapshot:PersonalFilesSnapshot)=>Promise<T>,before?:(account:string)=>Promise<void>,space?:PeerSourceWrites):Promise<T|undefined>{
    const config=await trustedConfig(this.configFile)
    if(config.organizationId!==binding.organizationId||config.nodeId!==binding.sourceNodeId)throw unavailable()
    const matches=config.runtimes.filter(item=>item.runtimeId===binding.scopeId)
    if(!matches.length)return undefined
    if(matches.length!==1)throw unavailable()
    const item=matches[0]!, owner=await this.owner(binding,userId), home=owner.runtimeHome
    if(!subpath(item.source,home)||home===item.source)throw unavailable()
    await before?.(owner.account)
    const unwatch=await watchPeerSourcePaths(space,[item.source,item.snapshotDirectory])
    const capturedAt=new Date().toISOString(),view=await this.acquire(config.provider,item,this.timeout,signal).catch(error=>{unwatch();throw error})
    try {
      await space?.check(item.source)
      return await work({capturedAt,account:owner.account,generation:owner.generation,localState:async(stateRoot,maxRows)=>{
        if(!subpath(item.source,stateRoot))return undefined
        await view.inspect?.([join(stateRoot,'personal-directory'),join(stateRoot,'node-content-drafts')],maxRows)
        return view.map(stateRoot)
      },capture:(directory,budget,documents,stateRoot)=>this.captureView(binding,userId,directory,budget,signal,item,owner,home,view,capturedAt,documents,stateRoot)})
    }finally{try{await view.release()}finally{unwatch()}}
  }
  /** Copy only the selected Runtime's declared data and approved personal workspace directories. */
  async capture(binding:PeerBackupBinding,userId:number,directory:string,budget:Budget,signal:AbortSignal,documents?:DocReceipt){
    return this.snapshot(binding,userId,signal,view=>view.capture(directory,budget,documents),undefined,budget.space)
  }
  private async captureView(binding:PeerBackupBinding,userId:number,directory:string,budget:Budget,signal:AbortSignal,
    item:Selection,owner:Owner,home:string,view:Frame,capturedAt:string,documents?:DocReceipt,stateRoot?:string):Promise<FileCapture>{
    const resolveDocuments=async()=>{
      if(!documents||!this.documentRoots)return
      const sequence=Number(documents.sequence)
      if(!Number.isSafeInteger(sequence)||documents.owner!==owner.account)throw invalid()
      return this.documentRoots(userId,documents.rootId,{sequence,ordinal:documents.ordinal},budget.maxRows)
    }
    const docs=await resolveDocuments()
    const gaps=new Set<string>(), inputs:FsRoot[]=[], managed=join(directory,'personal-files')
      const profile=await nativeRuntimeProfileData(home,path=>view.map(path),budget.maxRows,signal)
      for(const gap of profile.gaps)gaps.add(gap)
      for(const row of profile.roots)inputs.push({role:'runtime',key:relative(home,row.path).split(sep).join('/'),owner:row.owner,kind:row.kind,source:row.path})
      if(stateRoot){
        const policies=await recoveryExecutionDataRoots({pool:this.control,organizationId:binding.organizationId,nodeId:binding.sourceNodeId},stateRoot,binding.scopeId)
        if(policies.length>budget.maxRows)throw over()
        for(const policy of policies){
          if(!subpath(stateRoot,policy.path)||!subpath(item.source,policy.path)){gaps.add('files:recovery-policies-outside-checkpoint');continue}
          const info=await lstat(policy.path)
          if(info.size>Math.min(budget.maxBytes,64<<20)||policy.kind!=='file')throw over()
          inputs.push({role:'recovery-private',owner:policy.owner,key:fileKey(policy.owner),kind:'file',source:policy.path,expectedSha256:fileKey(await readFile(policy.path,'utf8'))})
        }
      }
      const inventory=join(home,'managed-data.jsonl')
      await view.inspect?.([inventory],budget.maxRows)
      const frozen=view.map(inventory),info=await filePresent(frozen)
      if(!info)gaps.add('plugin:runtime-inventory-unavailable')
      else {
        if(!info.isFile()||info.nlink!==1||(view.verifiedPath?.(frozen)??await realpath(frozen))!==frozen || info.size>Math.min(budget.maxBytes,4<<20))throw invalid()
        const providers=readManagedDataPaths(frozen)
        if(providers.length>budget.maxRows)throw over()
        inputs.push({role:'runtime',key:'managed-data.jsonl',owner:'gateway-personal-inventory',kind:'file',source:inventory})
        for(const row of providers){
          if(row.owner==='@deepseek-ai/dsh-userdoc-local'&&row.kind==='directory'&&row.path===docs?.root)continue
          const key=relative(home,row.path).split(sep).join('/')
          if(!subpath(home,row.path)||!runtimeKeyValid(row.owner,key,row.kind)){
            gaps.add('plugin:unverified-managed-paths');continue
          }
          safeComponents(key)
          if(!inputs.some(r=>r.source===row.path||r.kind==='directory'&&subpath(r.source,row.path)))inputs.push({role:'runtime',key,owner:row.owner,kind:row.kind,source:row.path})
        }
      }
      for(const artifact of item.artifacts){
        if(inputs.some(row=>row.kind==='directory'&&subpath(row.source,artifact.path)))continue
        if(!subpath(home,artifact.path)||artifact.path===home||inputs.some(r=>subpath(r.source,artifact.path)||subpath(artifact.path,r.source)))throw invalid()
        const key=relative(home,artifact.path).split(sep).join('/');safeComponents(key)
        inputs.push({role:'artifact',key,owner:'personal-artifact',kind:artifact.kind,source:artifact.path})
      }
      let inspected=0
      const uncovered=async(path:string):Promise<boolean>=>{
        if(++inspected>budget.maxRows)throw over()
        if(inputs.some(row=>row.source===path||row.kind==='directory'&&subpath(row.source,path)))return false
        const actual=view.map(path),entry=await filePresent(actual)
        if(!entry)return false
        if(!entry.isDirectory()||entry.isSymbolicLink())return true
        for await(const child of await opendir(actual))if(await uncovered(join(path,child.name)))return true
        return false
      }
      if(await uncovered(home))gaps.add('runtime:undeclared-files')
      const rows=workspaceRows(directory)
      if(rows.size!==item.workspaces.length||new Set(item.workspaces.map(w=>w.id)).size!==item.workspaces.length)gaps.add('files:unselected-personal-workspaces')
      for(const w of item.workspaces){
        if(rows.get(w.id)!==w.path || !subpath(owner.home,w.path)||w.path===owner.home||!subpath(item.source,w.path)
          || subpath(home,w.path)||subpath(w.path,home)||inputs.some(r=>subpath(r.source,w.path)||subpath(w.path,r.source)))throw invalid()
        const sibling=await this.control.query(`SELECT FROM harness.node_user_accounts WHERE organization_id=$1 AND node_id=$2 AND user_id<>$3
          AND (home_path=$4 OR left(home_path,length($4)+1)=$4||$5 OR left($4,length(home_path)+1)=home_path||$5) LIMIT 1`,
        [binding.organizationId,binding.sourceNodeId,owner.account,w.path,sep])
        if(sibling.rowCount)throw invalid()
        inputs.push({role:'workspace',key:fileKey(w.id),owner:'personal-workspace',kind:'directory',source:w.path})
      }
      const hasDocuments=!!docs && !!documents && docs.root===join(owner.home,'documents') &&
        [docs.root,docs.stateRoot,docs.filesRoot].every(path=>subpath(item.source,path) && path!==item.source &&
          !inputs.some(r=>subpath(r.source,path)||subpath(path,r.source)))
      if(hasDocuments && docs && documents){
        for(const [role,path] of [['userdoc-public',docs.root],['userdoc-metadata',docs.stateRoot],['userdoc-objects',docs.filesRoot]] as const)
          inputs.push({role,key:documents.rootId,owner:role,kind:'directory',source:path})
      }else gaps.add('files:account-documents-outside-checkpoint')
      await view.inspect?.(inputs.map(r=>r.source),budget.maxRows)
      const mapped=inputs.map(r=>({...r,logicalSource:r.source,source:view.map(r.source)}))
      const actual=mapped.map(r=>({owner:r.owner,kind:r.kind,path:r.source}))
      const create=()=>mkdir(managed,{mode:0o700})
      if(budget.space)await budget.space.write(directory,0,create);else await create()
      const captured=await snapshotManagedFiles(actual,managed,signal,{maxBytes:budget.maxBytes,maxEntries:budget.maxRows,
        guardWrite:budget.space&&((bytes,write)=>budget.space!.write(managed,bytes,write)),
        ...(view.verifiedPath?{verifiedVssPath:view.verifiedPath}:{}),...(view.devices?{rejectNestedBtrfs:true,btrfsDevices:view.devices}:{})})
      for(const row of mapped.filter(row=>row.role==='recovery-private'))if(!captured.files.some(file=>file.sourcePath===row.source&&file.sha256===row.expectedSha256))throw unavailable()
      if(hasDocuments && (mapped.some(r=>r.role.startsWith('userdoc-') && captured.absent.includes(r.source)) ||
        JSON.stringify(await resolveDocuments())!==JSON.stringify(docs)))throw unavailable()
      await view.confirm()
      if(JSON.stringify(owner)!==JSON.stringify(await this.owner(binding,userId)))throw unavailable()
      const inventoryText=JSON.stringify(rootInventory.parse({version:2,organizationId:binding.organizationId,nodeId:binding.sourceNodeId,
        runtimeId:binding.scopeId,account:owner.account,userId,runtimeHome:home,roots:mapped}))
      const bytes=Buffer.from(JSON.stringify({platform:process.platform==='win32'?'win32':'posix',snapshot:captured}))
      if(bytes.length>16<<20 || Buffer.byteLength(inventoryText)>1<<20 || captured.files.reduce((n,x)=>n+x.sizeBytes,bytes.length+Buffer.byteLength(inventoryText))>budget.maxBytes)throw over()
      await writePeerSourceFile(join(managed,'manifest.json'),bytes,budget.space)
      await writePeerSourceFile(join(directory,'personal-roots.json'),inventoryText,budget.space)
      if(!inputs.some(row=>row.owner==='@deepseek-ai/dsh-session-persistence-jsonl'))gaps.add('sessions:runtime-files-unavailable')
      if(!inputs.some(row=>row.owner==='app-boot'||row.owner==='gateway-runtime-profiles'))gaps.add('plugin:profile-unavailable')
      return {receipt:personalFileReceipt.parse({roots:mapped.length-captured.absent.length,capturedAt,digest:fileKey(inventoryText)}),gaps:[...gaps]}
  }
}

/** Validate portable membership and, on request, materialize only below a fresh offline rehearsal directory. */
export async function verifyPersonalFiles(binding:PeerBackupBinding,userId:number,receipt:z.infer<typeof personalFileReceipt>,directory:string,
  budget:Budget,signal:AbortSignal,docReceipt?:DocReceipt,destination?:string){
  const inventory=join(directory,'personal-roots.json'), info=await lstat(inventory)
  if(!info.isFile()||info.nlink!==1||info.size>Math.min(1<<20,budget.maxBytes)||await realpath(inventory)!==inventory)throw invalid()
  const text=await readFile(inventory,'utf8'),saved=rootInventory.parse(JSON.parse(text))
  if(fileKey(text)!==receipt.digest||saved.organizationId!==binding.organizationId||saved.nodeId!==binding.sourceNodeId||saved.runtimeId!==binding.scopeId||saved.userId!==userId)throw invalid()
  const managed=join(directory,'personal-files')
  const {snapshot,sourcePlatform}=await readVerifiedPeerManagedFiles(managed,signal)
  if(snapshot.roots.length!==saved.roots.length||snapshot.roots.length-snapshot.absent.length!==receipt.roots||snapshot.files.length+snapshot.directories.length>budget.maxRows
    ||snapshot.files.reduce((n,x)=>n+x.sizeBytes,0)>budget.maxBytes)throw invalid()
  const paths=sourcePlatform==='win32'?win32:posix
  if(saved.version===2&&(!saved.runtimeHome||!paths.isAbsolute(saved.runtimeHome)||saved.roots.some(root=>!root.logicalSource||!paths.isAbsolute(root.logicalSource))))throw invalid()
  const keys=new Set<string>()
  for(const r of saved.roots){
    if(!snapshot.roots.some(x=>x.path===r.source&&x.kind===r.kind&&x.owner===r.owner)||keys.has(r.role+'/'+r.key)
      ||(r.role==='runtime' ? !runtimeKeyValid(r.owner,r.key,r.kind)
        : r.role==='artifact' ? r.owner!=='personal-artifact'
        : r.role==='workspace' ? r.owner!=='personal-workspace'||r.kind!=='directory'||!/^[a-f0-9]{64}$/u.test(r.key)
        : r.role==='recovery-private' ? r.kind!=='file'||!/^gateway-(?:(?:personal-recovery|recovery-execution|governance-binding)\/[a-f0-9-]{36}|personal-retained\/[a-f0-9-]{36}\/[a-f0-9]{64})$/u.test(r.owner)||r.key!==fileKey(r.owner)||!r.expectedSha256||!snapshot.files.some(file=>file.sourcePath===r.source&&file.sha256===r.expectedSha256)
        : r.owner!==r.role||r.kind!=='directory'||!docReceipt||r.key!==docReceipt.rootId||saved.account!==docReceipt.owner))throw invalid()
    keys.add(r.role+'/'+r.key)
    if(r.role==='runtime'||r.role==='artifact')safeComponents(r.key)
    if(saved.version===2&&(r.role==='runtime'||r.role==='artifact')&&paths.relative(saved.runtimeHome!,r.logicalSource!).split(paths.sep).join('/')!==r.key)throw invalid()
  }
  const docRoots=saved.roots.filter(r=>r.role.startsWith('userdoc-'))
  if(docRoots.length && (docRoots.length!==3 || docRoots.some(r=>snapshot.absent.includes(r.source))))throw invalid()
  if(!destination)return saved
  const base=resolve(destination)
  if(await realpath(resolve(base,'..'))!==resolve(base,'..'))throw invalid()
  const create=()=>mkdir(base,{mode:0o700})
  if(budget.space)await budget.space.write(resolve(base,'..'),0,create);else await create()
  const createParents=async(path:string)=>{
    const create=()=>mkdir(path,{recursive:true,mode:0o700})
    if(budget.space)await budget.space.write(base,0,create,relative(base,path).split(sep).filter(Boolean).length)
    else await create()
  }
  function target(path:string){
    for(const root of saved.roots){
      const tail=paths.relative(root.source,path)
      if(tail && (root.kind!=='directory'||tail==='..'||tail.startsWith('..'+paths.sep)||paths.isAbsolute(tail)))continue
      const parts=tail===''?[]:safeComponents(tail.split(paths.sep).join('/'))
      return root.role.startsWith('userdoc-') ? join(base,'accounts',saved.account,binding.sourceNodeId,root.role,...parts)
        : join(base,binding.scopeId,root.role==='artifact'?'runtime':root.role,...safeComponents(root.key),...parts)
    }
    throw invalid()
  }
  try{
    const witnesses:DocumentBackupEntry[]=[],claimed=new Map<string,string>()
    for(const raw of [...snapshot.directories.map(x=>x.path),...snapshot.files.map(x=>x.sourcePath)]){
      const folded=target(raw).normalize('NFC').toLowerCase()
      if(claimed.has(folded)&&claimed.get(folded)!==raw)throw invalid()
      claimed.set(folded,raw)
    }
    for(const d of snapshot.directories){
      signal.throwIfAborted();const path=target(d.path);await createParents(path)
      if(await realpath(path)!==path)throw invalid()
      witnesses.push({path,object:d.object})
    }
    for(const f of snapshot.files){
      signal.throwIfAborted()
      const dest=target(f.sourcePath);await createParents(resolve(dest,'..'))
      const copied=await copyVerifiedFile(join(managed,f.member),dest,signal,budget.space&&((bytes,write)=>budget.space!.write(resolve(dest,'..'),bytes,write)))
      if(copied.sizeBytes!==f.sizeBytes||copied.sha256!==f.sha256)throw invalid()
      if(process.platform!=='win32' && (f.mode&0o100)!==0)await chmod(dest,0o700)
      witnesses.push({path:dest,object:f.object,sizeBytes:f.sizeBytes,sha256:f.sha256,modifiedAt:f.modifiedAt})
    }
    if(docRoots.length&&docReceipt){
      const locations={root:target(docRoots.find(x=>x.role==='userdoc-public')!.source),stateRoot:target(docRoots.find(x=>x.role==='userdoc-metadata')!.source),
        filesRoot:target(docRoots.find(x=>x.role==='userdoc-objects')!.source)}
      const db=new DatabaseSync(join(locations.stateRoot,'metadata.sqlite'),{readOnly:true})
      try{if(db.prepare('SELECT root_id FROM document_identity_root WHERE slot=1').get()?.root_id!==docReceipt.rootId)throw invalid()}finally{db.close()}
      const restore=()=>restoreDocumentIdentityBackup(locations,witnesses,signal)
      if(budget.space)await budget.space.write(base,budget.maxBytes,restore)
      else await restore()
    }
  }catch(error){await rm(base,{recursive:true,force:true});throw error}
  return saved
}
