/** A portable encrypted mapping from immutable snapshot locations to the source project's logical roots. */
import { constants } from 'node:fs'
import { lstat,open } from 'node:fs/promises'
import { join,posix,win32 } from 'node:path'
import { z } from 'zod'
import type { PeerBackupBinding } from './peer-backup-restic.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

export const peerFileRootSchema=z.object({role:z.enum(['workspace','runtime-data','userdoc-public','userdoc-metadata','userdoc-objects','plugin']),
  kind:z.enum(['directory','file']),owner:z.string().min(1).max(256),logicalRoot:z.string().min(1).max(4096),snapshotRoot:z.string().min(1).max(4096)}).strict()
const tree=z.object({version:z.literal(1),organizationId:z.uuid(),projectId:z.uuid(),runtimeId:z.uuid(),sourceNodeId:z.uuid(),volumeId:z.uuid(),
  writerEpoch:z.string().regex(/^[1-9][0-9]*$/u),revision:z.string().regex(/^(?:0|[1-9][0-9]*)$/u),documentRootId:z.uuid(),
  provider:z.enum(['btrfs','vss']),roots:z.array(peerFileRootSchema).min(1).max(4096),
  devices:z.object({filesystem:z.guid(),sourceVolume:z.guid(),snapshotVolume:z.guid(),sourceDevice:z.string().regex(/^[1-9]\d*$/u),
    snapshotDevice:z.string().regex(/^[1-9]\d*$/u)}).strict().optional()}).strict()
export type PeerFileRootMap=z.infer<typeof tree>
const invalid=()=>new PeerBackupError(409,'peer-backup/file-root-mismatch')

async function bounded(file:string,limit:number) {
  const entry=await lstat(file,{bigint:true})
  if(!entry.isFile() || entry.nlink!==1n || entry.size>BigInt(limit))throw invalid()
  const flags=constants.O_RDONLY | (process.platform==='win32'?0:constants.O_NOFOLLOW|constants.O_NONBLOCK)
  const handle=await open(file,flags)
  try {
    const before=await handle.stat({bigint:true})
    if(!before.isFile() || before.ino!==entry.ino || before.dev!==entry.dev || before.size!==entry.size || before.nlink!==1n)throw invalid()
    const bytes=Buffer.alloc(Number(before.size))
    let offset=0
    while(offset<bytes.length) {
      const read=await handle.read(bytes,offset,bytes.length-offset,offset)
      if(!read.bytesRead)throw invalid()
      offset+=read.bytesRead
    }
    const after=await handle.stat({bigint:true})
    if(after.size!==before.size || after.ctimeNs!==before.ctimeNs || after.mtimeNs!==before.mtimeNs)throw invalid()
    return bytes.toString('utf8')
  } finally {await handle.close()}
}

/** Verify file roles and ownership after decryption, without consulting the failed source computer.
 * @param binding - approved source, project and destination. @param payload - isolated decrypted payload.
 * @param complete - whether the recovery point claims full coverage. @returns verified role mapping when the built-in provider created it.
 */
export async function verifiedPeerFileRoots(binding:PeerBackupBinding,payload:string,complete:boolean):Promise<PeerFileRootMap|undefined>{
  const file=join(payload,'managed','roots.json')
  let raw:string
  try {raw=await bounded(file,4*1024*1024)} catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') return;throw error}
  const result=tree.parse(JSON.parse(raw))
  if (result.organizationId!==binding.organizationId || result.projectId!==binding.scopeId || result.sourceNodeId!==binding.sourceNodeId) throw invalid()
  const inventory=JSON.parse(await bounded(join(payload,'project','inventory.json'),64*1024))
  if(result.runtimeId!==inventory.runtimeId || result.volumeId!==inventory.volumeId || result.writerEpoch!==inventory.writerEpoch ||
    result.revision!==inventory.watermark || !inventory.hasFileSnapshot) throw invalid()
  const scope=JSON.parse((await bounded(join(payload,'project','spaces.jsonl'),64*1024)).trim())
  const projectDoc=JSON.parse((await bounded(join(payload,'project','document_roots.jsonl'),64*1024)).trim())
  const anchors=(await bounded(join(payload,'project','project_file_anchors.jsonl'),64*1024)).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s))
  if(scope.organization_id!==binding.organizationId || scope.runtime_id!==result.runtimeId || scope.project_id!==binding.scopeId ||
    projectDoc.root_id!==result.documentRootId || projectDoc.scope_id!==binding.scopeId || projectDoc.runtime_id!==result.runtimeId) throw invalid()
  const manifest=JSON.parse(await bounded(join(payload,'managed','manifest.json'),64*1024*1024))
  const paths=manifest.platform==='win32'?win32:manifest.platform==='posix'?posix:null
  if(!paths || (result.provider==='vss')!==(paths===win32) || !Array.isArray(manifest.snapshot?.roots))throw invalid()
  if(result.devices){
    const proof=result.devices
    if(result.provider!=='btrfs' || proof.sourceVolume===proof.snapshotVolume || !Array.isArray(manifest.snapshot.files) || !Array.isArray(manifest.snapshot.directories))throw invalid()
    for(const entries of [manifest.snapshot.files,manifest.snapshot.directories]){
      if(entries.some((row:{object?:{device?:string;inode?:string}})=>row.object?.device!==proof.sourceDevice || !/^[1-9]\d*$/u.test(row.object?.inode??'')))throw invalid()
    }
  }
  const within=(root:string,path:string)=>{const p=paths.relative(root,path);return p==='' || p!=='..'&&!p.startsWith('..'+paths.sep)&&!paths.isAbsolute(p)}
  const sourceHome=anchors.find(a=>a.owner==='runtime')?.path
  const storage=anchors.find(a=>a.owner==='storage')?.path
  if(!sourceHome || storage!==paths.join(sourceHome,'storages') || anchors.find(a=>a.owner==='workspace')?.path!==scope.root_path)throw invalid()
  let documentKey:string|undefined
  const roles=new Set<string>(),seen=new Set<string>(),locations=new Map<string,string>(),logical=new Map<string,string>()
  for (const root of result.roots) {
    if(root.role!=='plugin' && roles.has(root.role) || seen.has(root.logicalRoot+'\0'+root.owner))throw invalid()
    roles.add(root.role);seen.add(root.logicalRoot+'\0'+root.owner)
    for(const path of [root.snapshotRoot,root.logicalRoot]) if(path.includes('\0')||!paths.isAbsolute(path)||paths.normalize(path)!==path)throw invalid()
    const previous=locations.get(root.snapshotRoot)
    if(previous && previous!==root.logicalRoot || logical.has(root.logicalRoot) && logical.get(root.logicalRoot)!==root.snapshotRoot)throw invalid()
    locations.set(root.snapshotRoot,root.logicalRoot)
    logical.set(root.logicalRoot,root.snapshotRoot)
    if(root.role!=='plugin' && root.kind!=='directory')throw invalid()
    if(root.role==='workspace' && (root.logicalRoot!==scope.root_path || root.owner!=='project-workspace') ||
      root.role==='runtime-data' && (root.logicalRoot!==storage || root.owner!=='project-runtime-storage'))throw invalid()
    if(root.role.startsWith('userdoc-')){
      const owner=/^gateway-documents\/([a-f0-9]{64})\/(public|metadata|files)$/u.exec(root.owner)
      const suffix=root.role==='userdoc-public'?'public':root.role==='userdoc-metadata'?'metadata':'files'
      if(!owner || owner[2]!==suffix || documentKey && owner[1]!==documentKey)throw invalid()
      documentKey=owner[1]!
      if(suffix==='public'){
        if(root.logicalRoot!==paths.join(scope.root_path,'documents'))throw invalid()
      } else if(paths.basename(root.logicalRoot)!==documentKey ||
        paths.basename(paths.dirname(root.logicalRoot))!==(suffix==='metadata'?'document-identities':'.hgw-document-files') ||
        within(scope.root_path,root.logicalRoot) || within(sourceHome,root.logicalRoot))throw invalid()
    }
    if(root.role==='plugin' && (root.logicalRoot===sourceHome || !within(sourceHome,root.logicalRoot) && !within(scope.root_path,root.logicalRoot)))throw invalid()
    if(!manifest.snapshot.roots.some((x:{kind:string;path:string})=>x.path===root.snapshotRoot || x.kind==='directory'&&within(x.path,root.snapshotRoot)))throw invalid()
  }
  // A nested root must describe the same relative path in both filesystems, including roles subsumed by their workspace.
  for(const map of [logical,locations])for(const [path,other] of map) {
    let parent=paths.dirname(path)
    while(parent!==paths.dirname(parent)){
      const peer=map.get(parent)
      if(peer){if(paths.join(peer,paths.relative(parent,path))!==other)throw invalid();break}
      parent=paths.dirname(parent)
    }
  }
  if (manifest.snapshot.roots.some((x:{kind:string;path:string;owner:string})=>!result.roots.some(r=>r.snapshotRoot===x.path&&r.kind===x.kind&&r.owner===x.owner)))throw invalid()
  if(complete && ['workspace','runtime-data','userdoc-public','userdoc-metadata','userdoc-objects'].some(r=>!roles.has(r)))throw invalid()
  return result
}
