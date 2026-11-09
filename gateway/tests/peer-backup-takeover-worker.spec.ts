/** Independent processes on one computer must not stage or retire the same project concurrently. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { PeerProjectFileGate } from '../src/peer-backup-file-gate.ts'

it('keeps a replacement job exclusive across processes and releases it when the worker dies',async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),'hgw-recovery-work-')))
  const fixture=fileURLToPath(new URL('./fixtures/peer-takeover-work-lock.mjs',import.meta.url))
  const child=spawn(process.execPath,['--import','tsx/esm',fixture,directory],{stdio:['ignore','ignore','pipe','ipc']})
  const exited=once(child,'exit')
  let errors=''
  child.stderr?.on('data',chunk=>{errors+=String(chunk).slice(0,300)})
  try{
    const readiness=await Promise.race([once(child,'message').then(([message])=>message),
      exited.then(()=>{throw new Error('Worker exited before taking the slot: '+errors)})])
    expect(readiness).toBe('held')
    const gate=new PeerProjectFileGate(directory,'peer-project-recovery-work')
    let calls=0
    await expect(gate.exclusive(71,async()=>{calls++})).rejects.toMatchObject({code:'peer-backup/project-files-busy'})
    expect(calls).toBe(0)
    await expect(gate.exclusive(72,async()=>true)).resolves.toBe(true)
    child.kill('SIGKILL')
    await exited
    await expect(gate.exclusive(71,async()=>true)).resolves.toBe(true)
  }finally{
    if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL')
    await exited
    await rm(directory,{recursive:true,force:true})
  }
},15000)
