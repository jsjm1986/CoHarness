/** Export an approved project's files from an immutable local filesystem snapshot at its database revision. */
import { constants } from 'node:fs'
import { lstat,open,opendir,realpath } from 'node:fs/promises'
import { basename,isAbsolute,join,relative,sep } from 'node:path'
import { readManagedDataPaths } from '@deepseek-ai/dsh-managed-data'
import { z } from 'zod'
import type { NodeContentBinding,NodeContentStore } from './node-content-store.ts'
import type { NodeProjectFiles } from './node-content-files.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { ProjectOrigin } from './projects.ts'
import type { documentIdentityLocations } from './document-storage.ts'
import { privateFileState } from './node-private-file.ts'
import { openPeerBtrfsSnapshot } from './peer-btrfs-snapshot.ts'
import { openPeerVssSnapshot } from './peer-vss-snapshot.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerProjectFileSnapshots } from './peer-backup-project-export.ts'
import { verifiedPeerFileRoots,type PeerFileRootMap } from './peer-snapshot-roots.ts'

const absolute=z.string().min(1).max(4096).refine(isAbsolute)
const identity=z.object({version:z.literal(1),organizationId:z.uuid(),nodeId:z.uuid(),commandTimeoutMs:z.number().int().positive().max(2147483647).optional()})
const location=z.object({projectId:z.uuid(),snapshotDirectory:absolute})
const settings=z.discriminatedUnion('provider',[
  identity.extend({provider:z.literal('btrfs'),projects:z.array(location.extend({subvolume:absolute}).strict()).min(1).max(1024)}).strict(),
  identity.extend({provider:z.literal('vss'),projects:z.array(location.extend({source:absolute,volume:z.guid()}).strict()).min(1).max(1024)}).strict(),
])
type Description=Omit<PeerFileRootMap['roots'][number],'snapshotRoot'>
const unavailable=()=>new PeerBackupError(503,'peer-backup/project-snapshot-unavailable')
function within(root:string,path:string):boolean{const rest=relative(root,path);return rest==='' || rest!=='..'&&!rest.startsWith('..'+sep)&&!isAbsolute(rest)}
async function present(path:string){try{return await lstat(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}}

/** The document provider resolves the public and private roots that share the published UserDoc identity. */
export interface PeerDocumentFileRoots {
  (input:{projectId:number;workspace:string;rootId:string;origin:ProjectOrigin;cursor:{sequence:number;ordinal:number}}):ReturnType<typeof documentIdentityLocations>
}

/** The operator chooses the snapshot subvolume. Only files belonging to the selected project are exported. */
export class NativePeerProjectSnapshots implements PeerProjectFileSnapshots {
  constructor(private readonly file:string,private readonly timeout:number,private readonly context:PostgresRuntimeContext,
    private readonly store:Pick<NodeContentStore,'read'>,private readonly files:Pick<NodeProjectFiles,'verify'>,
    private readonly documentRoots:PeerDocumentFileRoots){}

  private async selected(b:NodeContentBinding) {
    if(b.organizationId!==this.context.organizationId || b.nodeId!==this.context.nodeId || !isAbsolute(this.file) || await realpath(this.file)!==this.file) throw unavailable()
    const handle=await open(this.file,constants.O_RDONLY|(process.platform==='win32'?0:constants.O_NOFOLLOW))
    try {
      if(await privateFileState(this.file,await handle.stat(),256*1024)!=='private') throw unavailable()
      const cfg=settings.parse(JSON.parse(await handle.readFile('utf8')))
      const items=cfg.projects.filter(p=>p.projectId===b.projectId)
      if(cfg.organizationId!==b.organizationId || cfg.nodeId!==b.nodeId || items.length!==1) throw unavailable()
      const item=items[0]!
      const timeout=cfg.commandTimeoutMs??this.timeout
      return 'subvolume' in item?{provider:'btrfs' as const,source:item.subvolume,directory:item.snapshotDirectory,timeout}:
        {provider:'vss' as const,source:item.source,directory:item.snapshotDirectory,volume:item.volume,timeout}
    } finally {await handle.close()}
  }

  async acquire(b:NodeContentBinding,revision:string,signal:AbortSignal,maxEntries:number) {
    const selected=await this.selected(b)
    await this.files.verify(b)
    const project=(await this.context.pool.query<{public_id:string;origin:ProjectOrigin}>(`SELECT p.public_id::text,p.origin FROM harness.projects p JOIN harness.project_content_placement b
      ON b.organization_id=p.organization_id AND b.project_id=p.id WHERE p.organization_id=$1 AND p.id=$2 AND b.runtime_id=$3 AND b.node_id=$4
      AND b.writer_epoch=$5 AND b.volume_id=$6 AND p.status='active'`,[b.organizationId,b.projectId,b.runtimeId,b.nodeId,b.writerEpoch,b.volumeId])).rows[0]
    if(!project)throw unavailable()
    const current=()=>this.store.read(b,async tx=>{
      const space=(await tx.query<{root_path:string;revision:string;root_id:string;sequence:string;ordinal:number}>(`SELECT s.root_path,s.revision::text,d.root_id,d.sequence::text,d.ordinal
        FROM node_content.spaces s JOIN node_content.document_roots d USING(organization_id,runtime_id,volume_id,writer_epoch)
        WHERE s.organization_id=$1 AND s.project_id=$2 AND s.runtime_id=$3 AND d.scope_id=s.project_id AND d.scope_kind='project'`,
      [b.organizationId,b.projectId,b.runtimeId])).rows[0]
      if(!space || space.revision!==revision)throw new PeerBackupError(409,'peer-backup/checkpoint-moved')
      const anchors=(await tx.query<{owner:string;path:string;anchor_path:string;device:string;inode:string}>(`SELECT owner,path,anchor_path,device,inode
        FROM node_content.project_file_anchors WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 ORDER BY owner`,[b.organizationId,b.projectId,b.runtimeId])).rows
      return {space,anchors}
    },signal)
    const first=await current(),space=first.space,home=first.anchors.find(a=>a.owner==='runtime')?.path
    const storage=first.anchors.find(a=>a.owner==='storage')?.path
    if(!home || !storage || first.anchors.find(a=>a.owner==='workspace')?.path!==space.root_path)throw unavailable()
    const docRequest={projectId:Number(project.public_id),workspace:space.root_path,rootId:space.root_id,origin:project.origin,
      cursor:{sequence:Number(space.sequence),ordinal:space.ordinal}}
    const docs=await this.documentRoots(docRequest)
    const u=basename(docs.stateRoot)
    if(!/^[0-9a-f]{64}$/u.test(u)||basename(docs.filesRoot)!==u || docs.root!==join(space.root_path,'documents'))throw unavailable()
    const inputs:Description[]=[
      {role:'workspace',owner:'project-workspace',kind:'directory',logicalRoot:space.root_path},
      {role:'runtime-data',owner:'project-runtime-storage',kind:'directory',logicalRoot:storage},
      {role:'userdoc-public',owner:'gateway-documents/'+u+'/public',kind:'directory',logicalRoot:docs.root},
      {role:'userdoc-metadata',owner:'gateway-documents/'+u+'/metadata',kind:'directory',logicalRoot:docs.stateRoot},
      {role:'userdoc-objects',owner:'gateway-documents/'+u+'/files',kind:'directory',logicalRoot:docs.filesRoot},
    ]
    const capturedAt=new Date().toISOString()
    const snapshot=selected.provider==='btrfs'?await openPeerBtrfsSnapshot(selected.source,selected.directory,selected.timeout,signal):
      await openPeerVssSnapshot(selected.source,selected.volume,selected.directory,selected.timeout,signal)
    try {
      const checked='verifiedPath' in snapshot?snapshot.verifiedPath:undefined
      const gaps=new Set<string>()
      const manifest=join(home,'managed-data.jsonl')
      if(!within(selected.source,manifest))gaps.add('runtime:outside-snapshot')
      else {
        if('inspect' in snapshot)await snapshot.inspect([manifest],maxEntries)
        const stored=snapshot.map(manifest)
        if(await present(stored)) {
          inputs.push({role:'plugin',owner:'project-managed-inventory',kind:'file',logicalRoot:manifest})
          for(const record of readManagedDataPaths(stored)){
            if(record.path===home || !within(home,record.path) && !within(space.root_path,record.path)){
              gaps.add('plugin:external-data');continue
            }
            if(inputs.some(r=>r.logicalRoot===record.path && r.owner===record.owner))continue
            inputs.push({role:'plugin',owner:record.owner,kind:record.kind,logicalRoot:record.path})
          }
        } else if(await present(snapshot.map(home)))gaps.add('runtime:undeclared-files')
      }
      if('inspect' in snapshot)await snapshot.inspect(inputs.map(row=>row.logicalRoot),maxEntries)
      if(within(selected.source,home) && await present(snapshot.map(home))) {
        const known=inputs.map(item=>item.logicalRoot)
        const unowned=async(path:string):Promise<boolean>=>{
          if(known.some(root=>within(root,path)))return false
          if(!known.some(root=>within(path,root)))return true
          const dir=await opendir(snapshot.map(path))
          for await(const child of dir) if(await unowned(join(path,child.name)))return true
          return false
        }
        if(await unowned(home))gaps.add('runtime:undeclared-files')
      }
      const roots:PeerFileRootMap['roots']=[]
      for(const item of inputs){
        if(!within(selected.source,item.logicalRoot)){gaps.add(item.role+':outside-snapshot');continue}
        const target=snapshot.map(item.logicalRoot)
        const info=await present(target)
        if(info && ((checked?checked(target):await realpath(target))!==target || (item.kind==='directory'?!info.isDirectory():!info.isFile())))throw unavailable()
        roots.push({...item,snapshotRoot:target})
      }
      // No local SQL writer may have advanced while the read-only filesystem view was taken.
      const finalDocs=await this.documentRoots(docRequest)
      if(finalDocs.root!==docs.root || finalDocs.stateRoot!==docs.stateRoot || finalDocs.filesRoot!==docs.filesRoot || JSON.stringify(first)!==JSON.stringify(await current()))throw new PeerBackupError(409,'peer-backup/checkpoint-moved')
      if(!roots.length)throw unavailable()
      const map:PeerFileRootMap={version:1,organizationId:b.organizationId,sourceNodeId:b.nodeId,projectId:b.projectId,runtimeId:b.runtimeId,
        volumeId:b.volumeId,writerEpoch:b.writerEpoch,revision,documentRootId:space.root_id,provider:selected.provider,
        ...('devices' in snapshot?{devices:snapshot.devices}:{}),roots}
      return {revision,capturedAt,roots:roots.map(r=>({owner:r.owner,kind:r.kind,path:r.snapshotRoot})),logicalRoots:map,
        verifiedVssPath:checked,confirm:snapshot.confirm,gaps:[...gaps],release:snapshot.release}
    } catch(error){await snapshot.release();throw error}
  }

  async validate(binding:Parameters<PeerProjectFileSnapshots['validate']>[0],payload:string,signal:AbortSignal){
    signal.throwIfAborted()
    if(!await verifiedPeerFileRoots(binding,payload,false))throw unavailable()
  }
}
