/** Verify an online project checkpoint with an OS snapshot, published content DB and UserDoc identity. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lstat,mkdir,mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Run only inside a disposable mounted volume. Its database and accounts come from the built Gateway entry. */
export async function verifyNativeProjectPoint({lib,temp,config,context,store,project,projectUuid,workspace,source,staging,windowsVolume}){
  const {NativePeerProjectSnapshots}=await lib('peer-native-project-snapshots')
  const {PeerProjectExporter,validatePeerProject}=await lib('peer-backup-project-export')
  const {NodeProjectFiles}=await lib('node-content-files')
  const {LocalDocumentBroker}=await lib('documents-local')
  const {PostgresDocumentCatalogService}=await lib('postgres/document-catalog-service')
  const {verifiedPeerFileRoots}=await lib('peer-snapshot-roots')
  const {snapshotManagedFiles}=await lib('managed-files')
  const directory=await mkdtemp(join(tmpdir(),'hgw-native-recovery-point-'))
  const settings=join(temp,'peer-project-snapshots.json'),signal=new AbortController().signal
  const policy={policyId:randomUUID(),organizationId:context.organizationId,scopeId:projectUuid,
    sourceNodeId:context.nodeId,targetNodeId:randomUUID(),revision:1}
  const catalog=new PostgresDocumentCatalogService(context,config.archiveRetentionDays,context.nodeId)
  const documents=new LocalDocumentBroker({cfg:config,organizationId:context.organizationId,nodeId:context.nodeId,catalog})
  const files=new NodeProjectFiles(config,context,store)
  try{
    const providerName=windowsVolume?'vss':'btrfs'
    await writeFile(settings,JSON.stringify({version:1,organizationId:context.organizationId,nodeId:context.nodeId,provider:providerName,commandTimeoutMs:60000,
      projects:[{projectId:projectUuid,...(windowsVolume?{source,volume:windowsVolume}:{subvolume:source}),snapshotDirectory:staging}]}),{flag:'wx',mode:0o600})
    const provider=new NativePeerProjectSnapshots(settings,15000,context,store,files,input=>documents.snapshotProjectDocumentRoots({
      organizationId:context.organizationId,nodeId:context.nodeId,projectPublicId:input.projectId,origin:input.origin,projectPath:input.workspace,
      rootId:input.rootId,cursor:input.cursor}))
    const live=join(workspace,'ongoing-work.txt'),home=join(config.projectRuntimesRoot,String(project),'dsh'),storage=join(home,'storages')
    const safe='published workspace version',next='foreground work continued',timer='{"next":"2099-06-01T00:00:00Z"}\n'
    await writeFile(live,safe,{flag:'wx'})
    await mkdir(storage,{recursive:true,mode:0o700})
    await writeFile(join(storage,'scheduled.json'),timer,{mode:0o600})
    await writeFile(join(home,'managed-data.jsonl'),JSON.stringify({version:1,owner:'@deepseek-ai/dsh-storage-json',kind:'directory',path:storage})+'\n',{mode:0o600})
    const b=(await context.pool.query('SELECT harness.project_content_key($1,$2) AS b',[context.organizationId,projectUuid])).rows[0].b
    await files.verify(b)
    const limits={maxRows:10000,maxBytes:16<<20}
    const exporter=new PeerProjectExporter({control:context.pool,store,...limits,files:{
      async acquire(...args){
        const view=await provider.acquire(...args)
        try{await writeFile(live,next);return view}catch(error){await view.release();throw error}
      },validate:provider.validate.bind(provider)}})
    const point=await exporter.capture(policy,directory,signal)
    assert.deepEqual(point.gaps,[])
    await validatePeerProject(policy,point,directory,signal,limits)
    const map=await verifiedPeerFileRoots(policy,directory,true)
    const {snapshot}=JSON.parse(await readFile(join(directory,'managed','manifest.json'),'utf8'))
    if(!windowsVolume)assert.ok(map.devices && map.devices.sourceVolume!==map.devices.snapshotVolume && map.devices.sourceDevice!==map.devices.snapshotDevice)
    for(const role of ['userdoc-public','userdoc-metadata','userdoc-objects']){
      const mapped=map.roots.find(row=>row.role===role)
      const object=snapshot.directories.find(d=>d.path===mapped.snapshotRoot).object
      const original=await lstat(mapped.logicalRoot,{bigint:true})
      assert.deepEqual(object,{device:String(original.dev),inode:String(original.ino)})
    }
    if(!windowsVolume)await assert.rejects(snapshotManagedFiles([{kind:'file',owner:'fixture',path:live}],undefined,signal,
      {maxBytes:4096,maxEntries:4,btrfsDevices:map.devices}),/outside the witnessed Btrfs snapshot/u)
    for(const [role,name,expected] of [['workspace','ongoing-work.txt',safe],['runtime-data','scheduled.json',timer]]){
      const frozen=map.roots.find(row=>row.role===role)
      const row=snapshot.files.find(row=>row.sourcePath===join(frozen.snapshotRoot,name))
      assert.ok(row)
      assert.equal(await readFile(join(directory,'managed',row.member),'utf8'),expected)
    }
    assert.equal(await readFile(live,'utf8'),next)
    assert.equal((await readdir(staging)).some(name=>name.startsWith(windowsVolume?'hgw-vss-':'hgw-peer-')),false)
    const sidecar=join(directory,'managed','roots.json'),original=await readFile(sidecar)
    const forged=structuredClone(map)
    forged.roots.find(row=>row.role==='userdoc-objects').logicalRoot=storage
    await writeFile(sidecar,JSON.stringify(forged))
    await assert.rejects(verifiedPeerFileRoots(policy,directory,true),e=>e.code==='peer-backup/file-root-mismatch')
    await writeFile(sidecar,original)
    await writeFile(join(home,'unreported-plugin-state'),'not in the plugin inventory')
    const sparse=join(directory,'partial');await mkdir(sparse)
    const partial=await exporter.capture(policy,sparse,signal)
    assert.ok(partial.gaps.includes('runtime:undeclared-files'))
    console.log(JSON.stringify({entry:'published Gateway project',provider:providerName,workspaceAndScheduleFrozen:true,
      sourceStillWritable:true,verifiedWithoutSourceSnapshot:true,userDocRootVerified:true,sourceDeviceAndInodesMatch:true,
      ...(!windowsVolume?{foreignSnapshotDeviceRejected:true}:{}),foreignPrivateRootRejected:true,unknownPluginReported:true}))
  }finally{await documents.dispose();await rm(directory,{recursive:true,force:true})}
}
