/** Reattach verified, byte-equivalent filesystem copies to one stopped local project. */
import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { restoreDocumentIdentityBackup, verifyDocumentIdentityBackup, type DocumentBackupEntry } from '@deepseek-ai/dsh-userdoc-local'
import type { PoolClient } from 'pg'
import { runGatewayChildCommand } from './child-command.ts'
import { snapshotManagedFiles } from './managed-files.ts'
import type { NodeProjectFiles } from './node-content-files.ts'
import { NodeContentUnavailable, type NodeContentBinding, type NodeContentStore } from './node-content-store.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { PeerDocumentFileRoots } from './peer-native-project-snapshots.ts'
import { attestPeerBtrfsSource, type PeerBtrfsBindMount } from './peer-btrfs-snapshot.ts'
import type { ProjectOrigin } from './projects.ts'

/** A canonical directory and the retained pre-migration copy used for verification. */
export interface RetainedProjectDirectory {
  readonly path: string
  readonly retained: string
}

interface Anchor {
  owner: 'workspace' | 'runtime' | 'storage'
  path: string
  anchorPath: string
  device: string
  inode: string
  missing: boolean
}

interface Relocation {
  context: PostgresRuntimeContext
  store: Pick<NodeContentStore,'read'|'write'>
  files: Pick<NodeProjectFiles,'verifyWith'>
  documentLocations: PeerDocumentFileRoots
  documentRoots: PeerDocumentFileRoots
  binding: NodeContentBinding
  directories: readonly RetainedProjectDirectory[]
  timeout: number
  signal: AbortSignal
  maxBytes: number
  maxEntries: number
}

interface BtrfsRemount extends Pick<Relocation,'context'|'store'|'files'|'binding'|'timeout'|'signal'> {
  source: string
  staging: string
  binds: readonly PeerBtrfsBindMount[]
  filesystem: string
  subvolume: string
}

interface DocumentLocations {
  root: string
  stateRoot: string
  filesRoot: string
}

interface DocumentMove extends Pick<Relocation,'timeout'|'signal'|'maxBytes'|'maxEntries'> {
  live: DocumentLocations
  retained: DocumentLocations
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent,child)
  return path === '' || path !== '..' && !path.startsWith('..'+sep) && !isAbsolute(path)
}

function refuse(message: string): never {
  throw new NodeContentUnavailable(message)
}

async function anchors(local: PoolClient, b: NodeContentBinding): Promise<Anchor[]> {
  const rows = (await local.query<Anchor>(`SELECT owner,path,anchor_path "anchorPath",device,inode,missing
    FROM node_content.project_file_anchors WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 ORDER BY owner`,
  [b.organizationId,b.projectId,b.runtimeId])).rows
  if (rows.map(row=>row.owner).join(',') !== 'runtime,storage,workspace') refuse('The saved project file identities are incomplete.')
  return rows
}

async function identity(path: string) {
  const info = await lstat(path,{bigint:true}).catch(error=>{
    if ((error as NodeJS.ErrnoException).code==='ENOENT') return undefined
    throw error
  })
  if (!info) return undefined
  if (!info.isDirectory() || await realpath(path) !== path) refuse('Project file reattachment requires canonical directories.')
  return {device:String(info.dev),inode:String(info.ino)}
}

async function visibleAnchor(old: Anchor): Promise<Anchor> {
  let anchorPath=old.path
  for(;;){
    const found=await identity(anchorPath)
    if(found)return {...old,anchorPath,...found,missing:anchorPath!==old.path}
    const parent=dirname(anchorPath)
    if(parent===anchorPath)refuse('A visible project directory has no verified parent.')
    anchorPath=parent
  }
}

async function compareDirectories(directories: readonly RetainedProjectDirectory[], timeout: number, signal: AbortSignal): Promise<void> {
  if (!directories.length) refuse('At least one relocated directory must be verified.')
  const all=directories.flatMap(entry=>[entry.path,entry.retained])
  if (all.some((path,index)=>all.some((other,i)=>i!==index&&contains(path,other)))) refuse('Project relocation directories overlap.')
  for (const entry of directories) {
    const [visible,retained]=await Promise.all([identity(entry.path),identity(entry.retained)])
    if (!visible || !retained || visible.device===retained.device && visible.inode===retained.inode)
      refuse('A retained directory must be a separate physical copy.')
    const {stdout}=await runGatewayChildCommand('/usr/bin/rsync',[
      '-aHAX','--checksum','--numeric-ids','--delete','--dry-run','--itemize-changes','--',entry.retained+'/',entry.path+'/',
    ],timeout,signal,4096)
    if(stdout.trim())refuse('The relocated directory differs from its retained copy.')
  }
}

function documentDirectories(live: DocumentLocations, retained: DocumentLocations) {
  return (['root','stateRoot','filesRoot'] as const).map(role=>({role,path:live[role],retained:retained[role]}))
}

async function documentEvidence(roots: DocumentLocations, input: DocumentMove): Promise<DocumentBackupEntry[]> {
  const {signal,maxBytes,maxEntries}=input
  const manifest=await snapshotManagedFiles(documentDirectories(roots,roots).map(({role,path})=>({
    owner:'gateway-documents/relocation/'+role,kind:'directory',path,
  })),undefined,signal,{maxBytes,maxEntries})
  return [
    ...manifest.directories.map(row=>({path:row.path,object:row.object})),
    ...manifest.files.map(row=>({path:row.sourcePath,object:row.object,sha256:row.sha256,sizeBytes:row.sizeBytes,modifiedAt:row.modifiedAt})),
  ]
}

async function reattachDocumentCopy(input: DocumentMove) {
  const {live,retained,signal}=input
  const roots=documentDirectories(live,retained)
  const before=await documentEvidence(retained,input)
  const rebased=before.map(row=>{
    const root=roots.find(item=>contains(item.retained,row.path))
    if(!root)refuse('A retained UserDoc member lies outside the reviewed directories.')
    return {...row,path:join(root.path,relative(root.retained,row.path))}
  })
  await restoreDocumentIdentityBackup(live,rebased,signal)
  await verifyDocumentIdentityBackup(live,await documentEvidence(live,input),signal)
}

/**
 * Reattach the retained document-only domains that share a moved workspace mount.
 * @param input - live and original copies of all three registered roots, while their writers are stopped.
 * @returns after the copied roots pass the existing UserDoc identity and digest verifier.
 */
export async function relocateRetainedDocumentIdentity(input: DocumentMove): Promise<void> {
  await compareDirectories(documentDirectories(input.live,input.retained),input.timeout,input.signal)
  await reattachDocumentCopy(input)
}

/**
 * Update kernel device numbers after remounting the very same verified Btrfs subvolume.
 * @param input - the stopped Gateway's binding and its root-private, previously verified filesystem and subvolume UUIDs.
 * @returns whether the device numbers changed. A substituted volume or inode is refused.
 */
export async function refreshProjectBtrfsFileDevices(input:BtrfsRemount):Promise<boolean>{
  const {context,store,files,binding:b,source,staging,binds,timeout,signal}=input
  if(context.organizationId!==b.organizationId||context.nodeId!==b.nodeId)refuse('Project remount verification requires the current owning node.')
  const live=await attestPeerBtrfsSource(source,staging,binds,timeout,signal)
  if(live.filesystem!==input.filesystem||live.subvolume!==input.subvolume)refuse('The project is mounted on a different Btrfs subvolume.')
  return transaction(context.pool,async control=>{
    const placement=await control.query(`SELECT FROM harness.project_content_placement
      WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND node_id=$4 AND volume_id=$5 AND writer_epoch=$6
      FOR SHARE`,[b.organizationId,b.projectId,b.runtimeId,b.nodeId,b.volumeId,b.writerEpoch])
    if(placement.rowCount!==1)refuse('The project placement changed before remount verification.')
    const previous=await store.read(b,local=>anchors(local,b),signal)
    const changed: Anchor[]=[]
    for(const old of previous){
      const current=await identity(old.anchorPath)
      const mapped=contains(source,old.anchorPath)||binds.some(mount=>contains(mount.path,old.anchorPath))
      if(!current||current.inode!==old.inode||current.device!==(mapped?live.device:old.device))
        refuse('A saved project directory changed during remount verification.')
      if(current.device!==old.device)changed.push(old)
    }
    if(!changed.length)return false
    await store.write(b,async local=>{
      if(JSON.stringify(await anchors(local,b))!==JSON.stringify(previous))refuse('The project file identities changed during remount verification.')
      for(const old of changed){
        const updated=await local.query(`UPDATE node_content.project_file_anchors SET device=$5
          WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND owner=$4`,
        [b.organizationId,b.projectId,b.runtimeId,old.owner,live.device])
        if(updated.rowCount!==1)refuse('A saved project file identity is missing during remount verification.')
      }
      await files.verifyWith(local,b)
      signal.throwIfAborted()
    })
    return true
  },signal)
}

/**
 * Publish new inode witnesses for a stopped project after a local mount change.
 * @param input - exact current assignment and retained directories. The operator must quiesce
 * the Gateway and every other writer below the relocated paths until publication or rollback completes.
 * @returns the previous revision and the committed inode witnesses. A failed check rolls back the SQL update.
 */
export async function relocateProjectFileAnchors(input: Relocation) {
  const {context,store,files,documentLocations,documentRoots,binding:b,directories,timeout,signal,maxBytes,maxEntries}=input
  if(context.organizationId!==b.organizationId||context.nodeId!==b.nodeId)refuse('Project file reattachment requires the current owning node.')
  const retainedPath=(path:string)=>{
    const entry=directories.find(item=>contains(item.path,path))
    return entry?join(entry.retained,relative(entry.path,path)):path
  }
  return transaction(context.pool,async control=>{
    const project=(await control.query<{publicId:string;origin:ProjectOrigin}>(`SELECT p.public_id::text "publicId",p.origin
      FROM harness.projects p
      JOIN harness.project_content_placement b ON (p.organization_id,p.id)=(b.organization_id,b.project_id)
      JOIN harness.instances i ON (b.organization_id,b.runtime_id,b.project_id,b.node_id)=(i.organization_id,i.runtime_id,i.project_id,i.assigned_node_id)
      WHERE p.organization_id=$1 AND p.id=$2 AND b.runtime_id=$3 AND b.node_id=$4 AND b.volume_id=$5 AND b.writer_epoch=$6
        AND p.status='active' AND p.kind='standard' AND i.desired_state='stopped' AND i.observed_state='stopped'
        AND NOT EXISTS (SELECT FROM harness.runtime_destructive_operations o WHERE o.organization_id=i.organization_id AND o.runtime_id=i.runtime_id)
      FOR SHARE OF p,b,i`,[b.organizationId,b.projectId,b.runtimeId,b.nodeId,b.volumeId,b.writerEpoch])).rows[0]
    if(!project)refuse('The published project Runtime must be stopped on this node.')
    const checkpoint=await store.read(b,async local=>{
      const space=(await local.query<{path:string;revision:string;rootId:string;sequence:string;ordinal:number}>(`SELECT
        s.root_path path,s.revision::text,d.root_id "rootId",d.sequence::text,d.ordinal
        FROM node_content.spaces s JOIN node_content.document_roots d USING(organization_id,runtime_id,volume_id,writer_epoch)
        WHERE s.organization_id=$1 AND s.project_id=$2 AND s.runtime_id=$3 AND s.publication_state='published'
          AND d.scope_kind='project' AND d.scope_id=s.project_id`,[b.organizationId,b.projectId,b.runtimeId])).rows[0]
      if(!space)refuse('The published project and document checkpoint is unavailable.')
      return {space,anchors:await anchors(local,b)}
    },signal)
    const {space,anchors:previous}=checkpoint
    for(const old of previous){
      const saved=await identity(retainedPath(old.anchorPath))
      if(!saved||saved.device!==old.device||saved.inode!==old.inode)refuse('The retained files do not match the previous project identity.')
    }
    await compareDirectories(directories,timeout,signal)
    const request={projectId:Number(project.publicId),origin:project.origin,workspace:space.path,rootId:space.rootId,
      cursor:{sequence:Number(space.sequence),ordinal:space.ordinal}}
    const docs=await documentLocations(request)
    if(previous.find(row=>row.owner==='workspace')?.path!==space.path || docs.root!==join(space.path,'documents'))
      refuse('The live project and UserDoc paths do not match their publication.')
    const owned=[...previous.map(row=>row.path),docs.stateRoot,docs.filesRoot]
    if(directories.some(move=>!owned.some(path=>contains(move.path,path))))
      refuse('A relocated directory does not own files in this project.')
    const retained={root:retainedPath(docs.root),stateRoot:retainedPath(docs.stateRoot),filesRoot:retainedPath(docs.filesRoot)}
    if(documentDirectories(docs,retained).some(row=>row.path===row.retained))refuse('All three UserDoc roots require retained copies.')
    await reattachDocumentCopy({live:docs,retained,timeout,signal,maxBytes,maxEntries})
    const verifiedDocs=await documentRoots(request)
    if(verifiedDocs.root!==docs.root||verifiedDocs.stateRoot!==docs.stateRoot||verifiedDocs.filesRoot!==docs.filesRoot)
      refuse('The relocated UserDoc storage changed during verification.')
    const next=await Promise.all(previous.map(visibleAnchor))
    await store.write(b,async local=>{
      const state=(await local.query<{revision:string}>(`SELECT revision::text FROM node_content.spaces
        WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3`,[b.organizationId,b.projectId,b.runtimeId])).rows[0]
      if(state?.revision!==(BigInt(space.revision)+1n).toString()||JSON.stringify(await anchors(local,b))!==JSON.stringify(previous))
        refuse('The project changed during its file reattachment.')
      for(const row of next){
        const updated=await local.query(`UPDATE node_content.project_file_anchors SET anchor_path=$5,device=$6,inode=$7,missing=$8
          WHERE organization_id=$1 AND project_id=$2 AND runtime_id=$3 AND owner=$4`,
        [b.organizationId,b.projectId,b.runtimeId,row.owner,row.anchorPath,row.device,row.inode,row.missing])
        if(updated.rowCount!==1)refuse('A project file identity changed during its reattachment.')
      }
      await files.verifyWith(local,b)
      signal.throwIfAborted()
    })
    return {previousRevision:space.revision,anchors:next,documentRootId:space.rootId}
  },signal)
}
