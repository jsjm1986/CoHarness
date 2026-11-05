/** One refused linked database releases its file process even when no database handle opened. */
import assert from 'node:assert/strict'
import {lstat,link,mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {tmpdir,freemem} from 'node:os'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
const mode=process.argv[2]??'lib';assert.ok(['src','lib'].includes(mode))
const base=new URL('../../'+mode+'/',import.meta.url),suffix=mode==='lib'?'.js':'.ts'
const minStart=Number(process.env.HGW_TEST_FILE_MIN_START_MIB??0),minLive=Number(process.env.HGW_TEST_FILE_MIN_FREE_MIB??0)
const maxDelta=Number(process.env.HGW_TEST_FILE_MAX_DROP_MIB??Infinity),initial=Math.floor(freemem()/1048576)
if(initial<minStart){console.log(JSON.stringify({skipped:'startup-headroom',initial,minStart}));process.exit(4)}
const {NodePrivateSqliteHost}=await import(new URL('node-private-sqlite-host'+suffix,base))
const {LocalNodeDrafts}=await import(new URL('node-drafts'+suffix,base))
const root=await mkdtemp(join(await realpath(tmpdir()),'hgw-file-close-')),db=join(root,'node-content-drafts','drafts.sqlite')
const host=new NodePrivateSqliteHost(root),drafts=new LocalNodeDrafts(root,host)
let phase='prepare',pid,lowest=initial,stopped
const start=performance.now(),signal=Promise.withResolvers()
const guard=setInterval(()=>{
  lowest=Math.min(lowest,Math.floor(freemem()/1048576))
  const problem=lowest<minLive||initial-lowest>maxDelta?'headroom':performance.now()-start>=8000?'deadline':null
  if(problem&&!stopped){stopped=problem;signal.reject(new Error(problem))}
},40)
async function reaped(id){
  if(!id)return false
  const deadline=Date.now()+750
  for(;;){try{process.kill(id,0)}catch(error){if(error.code==='ESRCH')return true;throw error}
    if(Date.now()>=deadline)return false;await delay(10)}
}
const run=async()=>{
  await mkdir(join(root,'node-content-drafts'),{mode:0o700})
  await writeFile(join(root,'known'),'fixture-unchanged',{mode:0o600});await link(join(root,'known'),db)
  assert.equal((await lstat(db)).nlink,2)
  phase='refuse';await assert.rejects(drafts.apply({organizationId:'synthetic',nodeId:'node',runtimeId:'runtime',target:'personal',userId:1,draftId:'draft',sessionId:'session'},{kind:'read'}))
  pid=host.stats().pid;assert.ok(pid);phase='close';await drafts.close()
  assert.equal(host.stats().pid,null);assert.ok(await reaped(pid))
  assert.equal(await readFile(join(root,'known'),'utf8'),'fixture-unchanged')
}
try{
  await Promise.race([run(),signal.promise])
  console.log(JSON.stringify({platform:process.platform,mode,refused:true,reapedPid:pid,pending:host.stats().pending,elapsedMs:Math.round(performance.now()-start),initial,lowest}))
}catch(error){
  pid=host.stats().pid??pid
  if(pid)try{process.kill(pid,'SIGKILL')}catch(e){if(e.code!=='ESRCH')throw e}
  const confirmed=await reaped(pid)
  console.log(JSON.stringify({stopped:stopped??'check-failed',phase,pid,reaped:confirmed,elapsedMs:Math.round(performance.now()-start),initial,lowest}))
  if(!stopped||!confirmed)throw error;process.exitCode=4
}finally{clearInterval(guard);await rm(root,{recursive:true,force:true})}
