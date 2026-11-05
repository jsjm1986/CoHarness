/** Exact personal Runtime files copied from an immutable node view. Logical paths are restored only below a new private directory. */
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
import { personalRuntimeLayout, type PersonalRuntimeStorageLayout } from './runtime-layout.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import type { Queryable } from './postgres/database.ts'

const invalid = () => new PeerBackupError(409,'peer-backup/invalid-personal-files')
const unavailable = () => new PeerBackupError(503,'peer-backup/personal-snapshot-unavailable')
const over = () => new PeerBackupError(507,'peer-backup/export-budget')
const absolute = z.string().min(1).max(4096).refine(isAbsolute)
const volume = z.object({ runtimeId:z.uuid(), source:absolute, snapshotDirectory:absolute, volume:z.guid().optional(),
  workspaces:z.array(z.object({id:z.string().min(1).max(512),path:absolute}).strict()).max(1024).default([]) }).strict()
const settings = z.object({version:z.literal(1),organizationId:z.uuid(),nodeId:z.uuid(),provider:z.enum(['btrfs','vss']),
  runtimes:z.array(volume).min(1).max(2048)}).strict()
type Selection=z.infer<typeof volume>
type Provider=z.infer<typeof settings>['provider']
type Budget={maxBytes:number;maxRows:number}
type Owner={account:string;username:string;home:string;layout:PersonalRuntimeStorageLayout;generation:string}
type FilesRole='runtime'|'workspace'|'userdoc-public'|'userdoc-metadata'|'userdoc-objects'
type DocReceipt=z.infer<typeof personalDocumentReceipt>
type DocLocations={root:string;stateRoot:string;filesRoot:string}
type FsRoot={role:FilesRole;key:string;owner:string;kind:'file'|'directory';source:string}
type Frame={root:string;map(path:string):string;inspect?(paths:readonly string[],limit:number):Promise<void>;confirm():Promise<void>;
  release():Promise<void>;verifiedPath?(path:string):string;devices?:{sourceDevice:string;snapshotDevice:string}}

/** Exact OS snapshot generation used by the file exporters and deterministic provider tests. */
export type PersonalSnapshotOpener=(provider:Provider, selection:Selection, timeout:number, signal:AbortSignal)=>Promise<Frame>

const openNative:PersonalSnapshotOpener=async(provider,selection,timeout,signal)=>{
  if(provider==='btrfs')return openPeerBtrfsSnapshot(selection.source,selection.snapshotDirectory,timeout,signal)
  if(!selection.volume)throw unavailable()
  return openPeerVssSnapshot(selection.source,selection.volume,selection.snapshotDirectory,timeout,signal)
}
const roles=z.enum(['runtime','workspace','userdoc-public','userdoc-metadata','userdoc-objects'])
const rootInventory=z.object({version:z.literal(1),organizationId:z.uuid(),nodeId:z.uuid(),runtimeId:z.uuid(),account:z.uuid(),userId:z.number().int().positive(),
  roots:z.array(z.object({role:roles,key:z.string().min(1).max(1024),owner:z.string().min(1).max(256),
    kind:z.enum(['file','directory']),source:z.string().min(1).max(4096)}).strict()).max(100000)}).strict()
/** Watermarks for file bytes only. A plugin or Schedule delivery needs its own replay evidence. */
export const personalFileReceipt=z.object({digest:z.string().regex(/^[0-9a-f]{64}$/u),roots:z.number().int().nonnegative(),capturedAt:z.iso.datetime()}).strict()
const allowed = new Map<string,[string,ManagedDataPath['kind']]>([
  ['@deepseek-ai/dsh-session-persistence-jsonl',['sessions','directory']],
  ['@deepseek-ai/dsh-attachment-local',['attachments/v1','directory']],
  ['@deepseek-ai/dsh-storage-json',['storages','directory']],
  ['@deepseek-ai/dsh-settings-file',['settings.yaml','file']],
  ['@deepseek-ai/dsh-agent-preset-registry',['.agent-presets','directory']],
  ['@deepseek-ai/dsh-workspace-changes',['workspace-reviews','directory']],
])
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
function workspaceRows(directory:string, selected:Selection):Map<string,string>{
  const db=new DatabaseSync(join(directory,'personal.sqlite'),{readOnly:true})
  try {
    const chosen=new Set(selected.workspaces.map(w=>w.id)), rows=new Map<string,string>()
    for(const result of db.prepare("SELECT body FROM records WHERE collection='workspaces'").iterate()){
      const record=JSON.parse(String(result.body)) as {id?:string;value?:string}
      if(!record.id||!chosen.has(record.id))continue
      const item=JSON.parse(String(record.value)) as {path?:string;workspaceId?:string}
      if(item.workspaceId!==record.id||typeof item.path!=='string'||rows.has(record.id))throw invalid()
      rows.set(record.id,item.path)
    }
    return rows
  }finally{db.close()}
}

/** The operator chooses a volume, while live allocation and the promoted directory decide which registered files it may contain. */
export class PeerPersonalFiles {
  constructor(private readonly control:Queryable,private readonly usersRoot:string,private readonly configFile:string,
    private readonly timeout:number,private readonly documentRoots?: (user:number,rootId:string,cursor:{sequence:number;ordinal:number},maxRows:number)=>Promise<DocLocations>,
    private readonly acquire:PersonalSnapshotOpener=openNative){}
  private async owner(binding:PeerBackupBinding,userId:number):Promise<Owner>{
    const result=await this.control.query<Owner>(`SELECT u.id account,u.username::text,ua.home_path home,e.storage_layout layout,i.generation::text
      FROM harness.runtime_environments e JOIN harness.users u ON (u.organization_id,u.id)=(e.organization_id,e.owner_id)
      JOIN harness.instances i ON (i.organization_id,i.runtime_id,i.assigned_node_id,i.user_id)=(e.organization_id,e.id,e.node_id,e.owner_id)
      JOIN harness.node_user_accounts ua ON (ua.organization_id,ua.node_id,ua.user_id)=(e.organization_id,e.node_id,u.id)
      WHERE e.organization_id=$1 AND e.node_id=$2 AND e.id=$3 AND u.public_id=$4 AND e.owner_kind='user'
        AND e.retired_at IS NULL AND i.provisioning_state='ready'`,[binding.organizationId,binding.sourceNodeId,binding.scopeId,userId])
    const row=result.rows[0]
    if(!row || !row.username || row.username==='.'||row.username==='..'||/[\\/]/u.test(row.username)||!isAbsolute(row.home))throw unavailable()
    return row
  }
  /** Copy only the selected Runtime's declared data and approved personal workspace directories. */
  async capture(binding:PeerBackupBinding,userId:number,directory:string,budget:Budget,signal:AbortSignal,documents?:DocReceipt){
    const config=await trustedConfig(this.configFile)
    if(config.organizationId!==binding.organizationId||config.nodeId!==binding.sourceNodeId)throw unavailable()
    const matches=config.runtimes.filter(item=>item.runtimeId===binding.scopeId)
    if(!matches.length)return undefined
    if(matches.length!==1)throw unavailable()
    const item=matches[0]!, owner=await this.owner(binding,userId), home=personalRuntimeLayout({usersRoot:this.usersRoot},
      {runtimeId:binding.scopeId as RuntimeId,username:owner.username,storageLayout:owner.layout}).dshHome
    if(!subpath(item.source,home)||home===item.source)throw unavailable()
    const resolveDocuments=async()=>{
      if(!documents||!this.documentRoots)return
      const sequence=Number(documents.sequence)
      if(!Number.isSafeInteger(sequence)||documents.owner!==owner.account)throw invalid()
      return this.documentRoots(userId,documents.rootId,{sequence,ordinal:documents.ordinal},budget.maxRows)
    }
    const docs=await resolveDocuments()
    const view=await this.acquire(config.provider,item,this.timeout,signal), capturedAt=new Date().toISOString()
    const gaps=new Set<string>(), inputs:FsRoot[]=[], managed=join(directory,'personal-files')
    try {
      const inventory=join(home,'managed-data.jsonl')
      await view.inspect?.([inventory],budget.maxRows)
      const frozen=view.map(inventory),info=await filePresent(frozen)
      if(!info)gaps.add('plugin:runtime-inventory-unavailable')
      else {
        if(!info.isFile()||info.nlink!==1||(view.verifiedPath?.(frozen)??await realpath(frozen))!==frozen || info.size>Math.min(budget.maxBytes,4<<20))throw invalid()
        const providers=readManagedDataPaths(frozen)
        if(providers.length>budget.maxRows)throw over()
        for(const row of providers){
          const fixed=allowed.get(row.owner)
          if(!fixed || row.path!==join(home,...fixed[0].split('/'))||row.kind!==fixed[1]){
            gaps.add('plugin:unverified-managed-paths');continue
          }
          if(!inputs.some(r=>r.key===fixed[0]&&r.role==='runtime'))inputs.push({role:'runtime',key:fixed[0],owner:row.owner,kind:row.kind,source:row.path})
        }
      }
      const rows=workspaceRows(directory,item)
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
      const mapped=inputs.map(r=>({...r,source:view.map(r.source)}))
      const actual=mapped.map(r=>({owner:r.owner,kind:r.kind,path:r.source}))
      await mkdir(managed,{mode:0o700})
      const captured=await snapshotManagedFiles(actual,managed,signal,{maxBytes:budget.maxBytes,maxEntries:budget.maxRows,
        ...(view.verifiedPath?{verifiedVssPath:view.verifiedPath}:{}),...(view.devices?{rejectNestedBtrfs:true,btrfsDevices:view.devices}:{})})
      if(hasDocuments && (mapped.some(r=>r.role.startsWith('userdoc-') && captured.absent.includes(r.source)) ||
        JSON.stringify(await resolveDocuments())!==JSON.stringify(docs)))throw unavailable()
      await view.confirm()
      if(JSON.stringify(owner)!==JSON.stringify(await this.owner(binding,userId)))throw unavailable()
      const inventoryText=JSON.stringify(rootInventory.parse({version:1,organizationId:binding.organizationId,nodeId:binding.sourceNodeId,
        runtimeId:binding.scopeId,account:owner.account,userId,roots:mapped}))
      const bytes=Buffer.from(JSON.stringify({platform:process.platform==='win32'?'win32':'posix',snapshot:captured}))
      if(bytes.length>16<<20 || Buffer.byteLength(inventoryText)>1<<20 || captured.files.reduce((n,x)=>n+x.sizeBytes,bytes.length+Buffer.byteLength(inventoryText))>budget.maxBytes)throw over()
      await writeFile(join(managed,'manifest.json'),bytes,{flag:'wx',mode:0o600})
      await writeFile(join(directory,'personal-roots.json'),inventoryText,{flag:'wx',mode:0o600})
      if(!inputs.some(row=>row.owner==='@deepseek-ai/dsh-session-persistence-jsonl')||captured.absent.some(path=>mapped.find(r=>r.source===path)?.key==='sessions'))gaps.add('sessions:runtime-files-unavailable')
      return {receipt:personalFileReceipt.parse({roots:mapped.length-captured.absent.length,capturedAt,digest:fileKey(inventoryText)}),gaps:[...gaps]}
    }finally{await view.release()}
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
  const keys=new Set<string>()
  for(const r of saved.roots){
    if(!snapshot.roots.some(x=>x.path===r.source&&x.kind===r.kind&&x.owner===r.owner)||keys.has(r.role+'/'+r.key)
      ||(r.role==='runtime' ? allowed.get(r.owner)?.[0]!==r.key||allowed.get(r.owner)?.[1]!==r.kind
        : r.role==='workspace' ? r.owner!=='personal-workspace'||r.kind!=='directory'||!/^[a-f0-9]{64}$/u.test(r.key)
        : r.owner!==r.role||r.kind!=='directory'||!docReceipt||r.key!==docReceipt.rootId||saved.account!==docReceipt.owner))throw invalid()
    keys.add(r.role+'/'+r.key)
  }
  const docRoots=saved.roots.filter(r=>r.role.startsWith('userdoc-'))
  if(docRoots.length && (docRoots.length!==3 || docRoots.some(r=>snapshot.absent.includes(r.source))))throw invalid()
  if(!destination)return
  const base=resolve(destination)
  if(await realpath(resolve(base,'..'))!==resolve(base,'..'))throw invalid()
  await mkdir(base,{mode:0o700})
  function target(path:string){
    for(const root of saved.roots){
      const tail=paths.relative(root.source,path)
      if(tail && (root.kind!=='directory'||tail==='..'||tail.startsWith('..'+paths.sep)||paths.isAbsolute(tail)))continue
      const parts=tail===''?[]:safeComponents(tail.split(paths.sep).join('/'))
      return root.role.startsWith('userdoc-') ? join(base,'accounts',saved.account,binding.sourceNodeId,root.role,...parts)
        : join(base,binding.scopeId,root.role,...safeComponents(root.key),...parts)
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
      signal.throwIfAborted();const path=target(d.path);await mkdir(path,{recursive:true,mode:0o700})
      if(await realpath(path)!==path)throw invalid()
      witnesses.push({path,object:d.object})
    }
    for(const f of snapshot.files){
      signal.throwIfAborted()
      const dest=target(f.sourcePath);await mkdir(resolve(dest,'..'),{recursive:true,mode:0o700})
      const copied=await copyVerifiedFile(join(managed,f.member),dest,signal)
      if(copied.sizeBytes!==f.sizeBytes||copied.sha256!==f.sha256)throw invalid()
      if(process.platform!=='win32' && (f.mode&0o100)!==0)await chmod(dest,0o700)
      witnesses.push({path:dest,object:f.object,sizeBytes:f.sizeBytes,sha256:f.sha256,modifiedAt:f.modifiedAt})
    }
    if(docRoots.length&&docReceipt){
      const locations={root:target(docRoots.find(x=>x.role==='userdoc-public')!.source),stateRoot:target(docRoots.find(x=>x.role==='userdoc-metadata')!.source),
        filesRoot:target(docRoots.find(x=>x.role==='userdoc-objects')!.source)}
      const db=new DatabaseSync(join(locations.stateRoot,'metadata.sqlite'),{readOnly:true})
      try{if(db.prepare('SELECT root_id FROM document_identity_root WHERE slot=1').get()?.root_id!==docReceipt.rootId)throw invalid()}finally{db.close()}
      await restoreDocumentIdentityBackup(locations,witnesses,signal)
    }
  }catch(error){await rm(base,{recursive:true,force:true});throw error}
}
