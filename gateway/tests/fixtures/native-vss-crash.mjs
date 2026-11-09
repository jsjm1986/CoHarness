/** Kill the snapshot holder and verify that the next backup reconciles its exact shadow. */
import assert from 'node:assert/strict'
import { execFile,fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp,rm,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { openPeerVssSnapshot } from '../../lib/peer-vss-snapshot.js'

const [mode,source,staging,volume]=process.argv.slice(2)
assert.equal(process.platform,'win32')
if(mode==='hold'){
  const view=await openPeerVssSnapshot(source,volume,staging,60000,new AbortController().signal)
  process.send({id:view.id})
}else{
  assert.equal(mode,'verify')
  const dir=await mkdtemp(join(source,'hgw-crash-')),ctl=await mkdtemp(join(staging,'hgw-owner-'))
  const child=fork(fileURLToPath(import.meta.url),['hold',dir,ctl,volume],{stdio:['ignore','ignore','inherit','ipc']})
  const closed=once(child,'close')
  let retired=false
  try{
    await writeFile(join(dir,'work.txt'),'active')
    const [{id}]=await Promise.race([once(child,'message'),closed.then(()=>{throw new Error('The snapshot owner exited before acquiring its view.')})])
    assert.ok(/^\{[a-f\d-]{36}\}$/iu.test(id));child.kill('SIGKILL');await closed
    const deadline=Date.now()+8000,script=fileURLToPath(new URL('../../deploy/node-content/vss-snapshot.ps1',import.meta.url))
    async function absent(){
      const probe=promisify(execFile)(join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
        ['-NoProfile','-NonInteractive','-File',script,'released'],{windowsHide:true,timeout:12000,maxBuffer:32768})
      probe.child.stdin.on('error',()=>{});probe.child.stdin.end(JSON.stringify({id}))
      try{await probe;return true}catch{return false}
    }
    let automatic=await absent()
    while(!automatic && Date.now()<deadline){await delay(250);automatic=await absent()}
    const next=await openPeerVssSnapshot(dir,volume,ctl,60000,new AbortController().signal)
    try{
      assert.equal(await absent(),true)
      await next.confirm()
    }finally{await next.release()}
    retired=true
    console.log(JSON.stringify({provider:'vss',parentKilled:true,automaticRelease:automatic,abandonedShadowAbsentOnNextCapture:true}))
  }finally{
    if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL')
    await closed
    if(retired){await rm(dir,{recursive:true,force:true});await rm(ctl,{recursive:true,force:true})}
  }
}
