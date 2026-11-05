/** Cross-platform packaged or source SQLite ownership smoke. Prints only timings and object-check counts. */
import assert from 'node:assert/strict'
import { link,mkdir,mkdtemp,readFile,realpath,rm,symlink,utimes,writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mode=process.argv[2]??'src'
if(!['lib','src'].includes(mode))throw new Error('Expected src or lib')
const base=new URL('../../'+mode+'/',import.meta.url),ext=mode==='src'?'ts':'js'
const [{NodePrivateSqliteHost},{LocalNodeDrafts},{PersonalNodeIndex},{tightenPrivateFileAcl}]=await Promise.all(['node-private-sqlite-host','node-drafts','personal-index','node-private-file'].map(name=>import(new URL(`${name}.${ext}`,base))))
const root=await mkdtemp(join(await realpath(tmpdir()),'hgw-file-smoke-'));await tightenPrivateFileAcl(root)
const host=new NodePrivateSqliteHost(root),drafts=new LocalNodeDrafts(root,host),personal=new PersonalNodeIndex(root,host)
const key={organizationId:'fixture',nodeId:'node',runtimeId:'runtime',target:'personal',userId:1,draftId:'draft-a',sessionId:'conversation'}
const owner={organizationId:key.organizationId,nodeId:key.nodeId,runtimeId:key.runtimeId,userId:1}
let step='cold initial proof'
try {
  assert.equal(await host.footprint(),null);const idle=host.stats();assert.deepEqual(idle,{pid:null,requests:0,pending:0})
  let at=performance.now();await drafts.apply(key,{kind:'save',value:{revision:0,text:'private'}});const cold=Math.round(performance.now()-at),pid=host.stats().pid
  step='cold personal catalog';await personal.publish(owner,{generation:1,snapshot:{revision:1,items:[],conversations:[]}})
  assert.equal(host.stats().pid,pid)
  step='warm read and edit';const before=await host.footprint(),times=[],editTimes=[]
  for(let i=0;i<12;i++){
    at=performance.now();await drafts.apply(key,{kind:'read'});await personal.contains(owner,key.sessionId);times.push(performance.now()-at)
    at=performance.now();assert.equal((await drafts.apply(key,{kind:'save',value:{revision:i+1,text:'edit-'+i}})).status,200)
    await personal.publish(owner,{generation:1,snapshot:{revision:i+2,items:[],conversations:[]}});editTimes.push(performance.now()-at)
  }
  const after=await host.footprint();assert.equal(after.mounts,before.mounts);assert.equal(after.permissions,before.permissions)
  step='adversarial file links';const extra=join(root,'outside');await mkdir(extra,{mode:0o700});await tightenPrivateFileAcl(extra);const outside=join(extra,'sentinel');await writeFile(outside,'untouched',{mode:0o600});await tightenPrivateFileAcl(outside)
  const attacked=join(root,'attack');await mkdir(attacked,{mode:0o700});await tightenPrivateFileAcl(attacked);const d=join(attacked,'node-content-drafts');await mkdir(d,{mode:0o700});await tightenPrivateFileAcl(d)
  const other=new LocalNodeDrafts(attacked)
  try{
    await link(outside,join(d,'drafts.sqlite'));await assert.rejects(other.apply(key,{kind:'read'}));await rm(join(d,'drafts.sqlite'))
    await writeFile(join(d,'drafts.sqlite'),'',{mode:0o600});await tightenPrivateFileAcl(join(d,'drafts.sqlite'))
    await link(outside,join(d,'drafts.sqlite-wal'));await assert.rejects(other.apply(key,{kind:'read'}));await rm(join(d,'drafts.sqlite-wal'))
    assert.equal(await readFile(outside,'utf8'),'untouched')
    await rm(d,{recursive:true});await symlink(extra,d,process.platform==='win32'?'junction':'dir');await assert.rejects(other.apply(key,{kind:'read'}))
  }finally{await other.close()}
  if(process.platform==='win32'){
    const unc=new LocalNodeDrafts('\\\\localhost\\C$'+root.slice(2));try{await assert.rejects(unc.apply(key,{kind:'read'}))}finally{await unc.close()}
  }
  step='crash recovery';const operationCount=host.stats().requests
  process.kill(pid,'SIGKILL');const deadline=Date.now()+4000
  while(host.stats().pid!==null&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10))
  assert.equal(host.stats().pid,null)
  assert.deepEqual(await drafts.apply(key,{kind:'save',value:{revision:12,text:'edit-11'}}),{status:200,value:{revision:13,text:'edit-11'}})
  if(process.platform==='win32'){
    step='withdrawal of live file permissions';const {execFileSync}=await import('node:child_process'),db=join(root,'node-content-drafts','drafts.sqlite')
    execFileSync('icacls.exe',[db,'/grant','*S-1-5-32-545:(R)'],{stdio:'ignore'})
    await utimes(db,new Date(),new Date(Date.now()-5000))
    await assert.rejects(drafts.apply(key,{kind:'read'}));await tightenPrivateFileAcl(db)
    step='restored private permissions';assert.equal((await drafts.apply(key,{kind:'read'})).value.text,'edit-11')
  }
  console.log(JSON.stringify({platform:process.platform,node:process.version,mode,idleProcesses:0,idleRequests:idle.requests,selectedProcesses:1,operationCount,
    coldMs:cold,warmPairP50Ms:Number(times.toSorted((a,b)=>a-b)[5].toFixed(2)),warmEditPairP50Ms:Number(editTimes.toSorted((a,b)=>a-b)[5].toFixed(2)),rssMiB:Number((after.rss/1048576).toFixed(1)),
    warmNativeAclReads:after.nativeAclReads-before.nativeAclReads,warmMountProbes:after.mounts-before.mounts,warmPermissionProbes:after.permissions-before.permissions,hardlinkRefused:true,sidecarRefused:true,directoryLinkRefused:true,crashReplay:true,...(process.platform==='win32'?{liveDaclWithdrawal:true}:{})}))
}catch(error){throw new Error('SQLite file smoke failed at '+step,{cause:error})}finally{await Promise.all([drafts.close(),personal.close()]);await rm(root,{recursive:true,force:true})}
