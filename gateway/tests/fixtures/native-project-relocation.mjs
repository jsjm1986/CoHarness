/** Reattach a published project to Btrfs, remount the subvolume and verify the reverse move. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod,lstat,mkdir,readFile,rm,writeFile } from 'node:fs/promises'
import { dirname,join,relative } from 'node:path'
import { promisify } from 'node:util'

const execute=promisify(execFile)
const command=(file,args)=>execute(file,args,{timeout:15000})
const copy=(from,to)=>command('/usr/bin/rsync',['-aHAX','--numeric-ids','--',from+'/',to+'/'])

/**
 * Exercise the built verifier and exporter with real retained copies and both directions of the move.
 * @param input - isolated project created through the built Gateway and the disposable Btrfs source.
 */
export async function verifyNativeProjectRelocation({lib,temp,config,context,store,project,projectUuid,workspace,source,staging,document,neighbor}){
  const {NodeProjectFiles}=await lib('node-content-files')
  const {LocalDocumentBroker}=await lib('documents-local')
  const {PostgresDocumentCatalogService}=await lib('postgres/document-catalog-service')
  const {documentIdentityLocations}=await lib('document-storage')
  const {NativePeerProjectSnapshots}=await lib('peer-native-project-snapshots')
  const {PeerProjectExporter}=await lib('peer-backup-project-export')
  const {relocateProjectFileAnchors,refreshProjectBtrfsFileDevices}=await lib('node-content-file-relocation')
  const {attestPeerBtrfsSource}=await lib('peer-btrfs-snapshot')
  const catalog=new PostgresDocumentCatalogService(context,config.archiveRetentionDays,context.nodeId)
  const broker=new LocalDocumentBroker({cfg:config,organizationId:context.organizationId,nodeId:context.nodeId,catalog})
  const files=new NodeProjectFiles(config,context,store)
  const b=(await context.pool.query('SELECT harness.project_content_key($1,$2) AS b',[context.organizationId,projectUuid])).rows[0].b
  const state=()=>store.read(b,async tx=>(await tx.query(`SELECT s.revision::text,s.root_path,d.root_id,d.sequence::text,d.ordinal
    FROM node_content.spaces s JOIN node_content.document_roots d USING(organization_id,runtime_id,volume_id,writer_epoch)
    WHERE s.project_id=$1 AND s.runtime_id=$2 AND d.scope_kind='project' AND d.scope_id=s.project_id`,[b.projectId,b.runtimeId])).rows[0])
  const signal=AbortSignal.timeout(90000)
  const request={organizationId:b.organizationId,nodeId:b.nodeId,projectPublicId:project,projectPath:workspace,origin:'user'}
  const documentRoots=({rootId,cursor})=>broker.snapshotProjectDocumentRoots({...request,rootId,cursor})
  const documentLocations=({workspace:projectPath,projectId})=>documentIdentityLocations(config,projectPath,join(projectPath,'documents'),{
    organizationId:b.organizationId,target:{kind:'project',id:projectId},projectionOwner:async rootId=>{
      const owner=await catalog.projectionOwner(rootId)
      return owner===null?null:owner.kind==='personal'?{kind:'user',id:owner.userId}:{kind:'project',id:owner.projectId}
    }})
  const documentProbe=info=>documentRoots({rootId:info.root_id,cursor:{sequence:Number(info.sequence),ordinal:info.ordinal}})
  const neighborBinding=(await context.pool.query('SELECT harness.project_content_key($1,$2) AS b',[context.organizationId,neighbor.id])).rows[0].b
  const otherSpace=await store.read(neighborBinding,async tx=>(await tx.query(`SELECT s.root_path,d.root_id,d.sequence::text,d.ordinal
    FROM node_content.spaces s JOIN node_content.document_roots d USING(organization_id,runtime_id,volume_id,writer_epoch)
    WHERE s.project_id=$1 AND s.runtime_id=$2 AND d.scope_kind='project' AND d.scope_id=s.project_id`,
  [neighbor.id,neighbor.runtime_id])).rows[0])
  const otherDocs=()=>broker.snapshotProjectDocumentRoots({...request,projectPublicId:neighbor.publicId,projectPath:otherSpace.root_path,
    rootId:otherSpace.root_id,cursor:{sequence:Number(otherSpace.sequence),ordinal:otherSpace.ordinal}})
  const otherBefore=await otherDocs()
  const otherIdentity=(await lstat(otherSpace.root_path)).ino
  const assertNeighbor=async()=>{
    await files.verify(neighborBinding)
    assert.deepEqual(await otherDocs(),otherBefore)
  }
  const owns=await state()
  const oldDevice=(await lstat(workspace)).dev
  assert.notEqual(oldDevice,(await lstat(source)).dev)
  const runtime=join(config.projectRuntimesRoot,String(project))
  const home=join(runtime,'dsh')
  const name='fixture-rebound-workspace.txt'
  await mkdir(home,{recursive:true,mode:0o700})
  await writeFile(join(home,'model-governance.json'),'{"intakeToken":"private-test-projection"}',{mode:0o600})
  await writeFile(join(workspace,name),'old project data',{mode:0o600})
  await files.verify(b)
  const docs=await documentProbe(await state())
  assert.equal(await readFile(join(docs.root,document.name),'utf8'),document.text)
  assert.equal(dirname(docs.filesRoot),dirname(otherBefore.filesRoot))
  const paths=[dirname(dirname(docs.filesRoot)),runtime,docs.stateRoot,otherBefore.stateRoot]
  const retained=[]
  const mounted=[]
  const binds=paths.map((path,i)=>({path,sourcePath:join(source,'project-move-'+i)}))
  const unmount=async list=>{while(list.length){await command('/usr/bin/umount',[list.at(-1)]);list.pop()}}
  try {
    for(const [i,{path,sourcePath}] of binds.entries()){
      const before=join(temp,'retained-'+i)
      await mkdir(before,{mode:0o700})
      await mkdir(sourcePath,{mode:0o700})
      await copy(path,sourcePath)
      await command('/usr/bin/mount',['--bind',path,before]);retained.push(before)
      await command('/usr/bin/mount',['--bind',sourcePath,path]);mounted.push(path)
    }
    const retainedDirs=binds.map(({path},i)=>({path,retained:retained[i]}))
    const move=(directories,binding=b)=>relocateProjectFileAnchors({context,store,files,documentLocations,
      documentRoots:binding===b?documentRoots:otherDocs,binding,directories,
      timeout:15000,signal,maxBytes:8<<20,maxEntries:4096})
    const own=(mount,path)=>({path,retained:join(mount.retained,relative(mount.path,path))})
    const primary=items=>[own(items[0],workspace),items[1],items[2],own(items[0],docs.filesRoot)]
    const adjacent=items=>[own(items[0],otherSpace.root_path),items[3],own(items[0],otherBefore.filesRoot)]
    const original=await state()
    await assert.rejects(files.verify(b),/project directory was replaced/u)
    await writeFile(join(workspace,name),'wrong file contents')
    await assert.rejects(move(primary(retainedDirs)),/differs from its retained copy/u)
    assert.deepEqual(await state(),original)
    await copy(retained[0],binds[0].sourcePath)
    const privateBase=dirname(docs.filesRoot)
    const mode=(await lstat(privateBase)).mode&0o7777
    await chmod(privateBase,0o755)
    try{await assert.rejects(documentLocations({workspace,projectId:project}),/document scope storage is unavailable/iu)}
    finally{await chmod(privateBase,mode)}
    const after=await move(primary(retainedDirs))
    await move(adjacent(retainedDirs),neighborBinding)
    assert.equal((await lstat(join(retained[0],relative(paths[0],otherSpace.root_path)))).ino,otherIdentity)
    assert.equal(after.documentRootId,owns.root_id)
    assert.equal(after.previousRevision,original.revision)
    await files.verify(b)
    assert.deepEqual(await documentProbe(await state()),docs)
    await assertNeighbor()
    const rebound=await state()
    assert.deepEqual({...rebound,revision:owns.revision},owns)
    assert.equal(BigInt(rebound.revision),BigInt(original.revision)+1n)
    const cfg=join(temp,'btrfs-reattached-project.json')
    await writeFile(cfg,JSON.stringify({version:1,organizationId:b.organizationId,nodeId:b.nodeId,provider:'btrfs',
      projects:[{projectId:b.projectId,subvolume:source,snapshotDirectory:staging,bindMounts:binds}]}),{mode:0o600})
    const provider=new NativePeerProjectSnapshots(cfg,15000,context,store,files,documentRoots)
    const exporter=new PeerProjectExporter({control:context.pool,store,files:provider,maxRows:4096,maxBytes:8<<20})
    const dest=join(temp,'reattached-point');await mkdir(dest,{mode:0o700})
    const policy={policyId:randomUUID(),organizationId:b.organizationId,scopeId:b.projectId,sourceNodeId:b.nodeId,targetNodeId:randomUUID(),revision:1}
    const point=await exporter.capture(policy,dest,signal)
    assert.deepEqual(point.gaps,[])
    await exporter.validate(policy,point,dest,signal)
    const mapping=JSON.parse(await readFile(join(dest,'managed','roots.json'),'utf8'))
    assert.equal(mapping.documentRootId,owns.root_id)
    assert.equal(mapping.runtimeId,b.runtimeId)
    assert.equal(mapping.volumeId,b.volumeId)
    assert.equal(mapping.writerEpoch,b.writerEpoch)
    assert.equal(mapping.roots.find(item=>item.role==='workspace').logicalRoot,workspace)
    assert.equal(mapping.roots.find(item=>item.role==='userdoc-metadata').logicalRoot,docs.stateRoot)
    assert.equal(mapping.roots.find(item=>item.role==='userdoc-objects').logicalRoot,docs.filesRoot)
    const stable=await attestPeerBtrfsSource(source,staging,binds,15000,signal)
    const refresh={context,store,files,binding:b,source,staging,binds,timeout:15000,signal,...stable}
    await assert.rejects(refreshProjectBtrfsFileDevices({...refresh,subvolume:randomUUID()}),/different Btrfs subvolume/u)
    const btrfsMount=dirname(source),lab=dirname(btrfsMount)
    const devices=[process.env.HGW_TEST_BTRFS_DEVICE,process.env.HGW_TEST_BTRFS_REMOUNT_DEVICE]
    for(const [index,image] of ['volume.img','remount.img'].entries()){
      assert.match(devices[index],/^\/dev\/loop\d+$/u)
      const {stdout}=await command('/usr/sbin/losetup',['--associated',join(lab,image)])
      assert.ok(stdout.startsWith(devices[index]+':'))
    }
    await unmount(mounted)
    await command('/usr/bin/umount',[btrfsMount])
    const other=join(lab,'remount')
    const mountBtrfs=(device,target)=>command('/usr/bin/mount',
      ['-n','-t','btrfs','-o','nodiscard,nosuid,nodev,user_subvol_rm_allowed',device,target])
    await mountBtrfs(devices[1],other)
    await lstat(other)
    await mountBtrfs(devices[0],btrfsMount)
    for(const {path,sourcePath} of binds){
      await command('/usr/bin/mount',['--bind',sourcePath,path]);mounted.push(path)
    }
    const mountedAgain=await attestPeerBtrfsSource(source,staging,binds,15000,signal)
    assert.deepEqual({...mountedAgain,device:stable.device},stable)
    assert.notEqual(mountedAgain.device,stable.device)
    await assert.rejects(files.verify(b),/project directory was replaced/u)
    assert.equal(await refreshProjectBtrfsFileDevices(refresh),true)
    assert.equal(await refreshProjectBtrfsFileDevices(refresh),false)
    assert.equal(await refreshProjectBtrfsFileDevices({...refresh,binding:neighborBinding}),true)
    await files.verify(b)
    assert.deepEqual(await documentProbe(await state()),docs)
    assert.equal(await readFile(join(docs.root,document.name),'utf8'),document.text)
    await assertNeighbor()
    assert.equal(JSON.parse(await readFile(join(docs.filesRoot,'domain.json'),'utf8')).state.volume,stable.subvolume)
    const reverseCopies=await Promise.all(binds.map(async ({path},i)=>{
      const copyPath=join(temp,'rollback-copy-'+i)
      await mkdir(copyPath,{mode:0o700})
      await copy(path,copyPath)
      return copyPath
    }))
    await unmount(mounted)
    await assert.rejects(files.verify(b),/project directory was replaced/u)
    for(const [i,{path}] of binds.entries()){
      await command('/usr/bin/mount',['--bind',reverseCopies[i],path]);mounted.push(path)
    }
    const reverse=binds.map(({path,sourcePath})=>({path,retained:sourcePath}))
    const reversed=await move(primary(reverse))
    await move(adjacent(reverse),neighborBinding)
    assert.equal(reversed.documentRootId,owns.root_id)
    assert.equal(reversed.anchors.find(a=>a.owner==='workspace').device,String(oldDevice))
    await files.verify(b)
    assert.deepEqual(await documentProbe(await state()),docs)
    assert.equal(await readFile(join(workspace,name),'utf8'),'old project data')
    assert.equal(await readFile(join(docs.root,document.name),'utf8'),document.text)
    await assertNeighbor()
    assert.deepEqual({...await state(),revision:owns.revision},owns)
    const receipt={sameNode:true,btrfs:true,workspaceVerified:true,runtimeVerified:true,userDocVerified:true,
      changedCopyRejected:true,unsafePrivateParentRejected:true,sharedParentProjectVerified:true,
      completeNativePoint:true,remountDeviceRefreshVerified:true,rollbackVerified:true}
    assert.deepEqual(receipt,JSON.parse(await readFile(new URL('../expected/native-project-relocation.jsonl',import.meta.url),'utf8')))
    console.log(JSON.stringify(receipt))
  }finally{
    try{await unmount(mounted)}finally{
      await unmount(retained)
      for(const {sourcePath} of binds)await rm(sourcePath,{recursive:true,force:true})
      await broker.dispose()
    }
  }
}
