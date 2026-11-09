/** A volatile VSS view of one operator-selected, non-system NTFS volume. */
import { execFile,spawn } from 'node:child_process'
import { randomBytes,randomUUID } from 'node:crypto'
import { lstat,mkdtemp,realpath,rm,writeFile } from 'node:fs/promises'
import { createServer,type Socket } from 'node:net'
import { isAbsolute,join,relative,resolve,sep } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { scrubbedGatewayChildEnv } from './child-environment.ts'
import { privateDirectoryState } from './node-private-file.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

const run=promisify(execFile)
const denied=()=>new PeerBackupError(503,'peer-backup/vss-snapshot-unavailable')
const helper=resolve(import.meta.dirname,'../deploy/node-content/vss-snapshot.ps1')
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel==='' || rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
const hello=z.object({key:z.string(),id:z.string().regex(/^\{[A-Fa-f0-9-]{36}\}$/u),device:z.string().regex(/^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[0-9]+$/u)}).strict()

/** @param source - project data beneath the dedicated drive. @param volume - configured OS volume GUID.
 * @param staging - protected control directory outside the source. @param timeout - system command deadline.
 * @param signal - background job lifetime. @returns the immutable view and its mandatory release.
 */
export async function openPeerVssSnapshot(source:string,volume:string,staging:string,timeout:number,signal:AbortSignal){
  if(process.platform!=='win32'||!z.guid().safeParse(volume).success||!/^[A-Za-z]:\\/u.test(source)||
    resolve(source)!==source||!isAbsolute(staging)||inside(source,staging)||inside(staging,source))throw denied()
  if(await realpath(source)!==source || await realpath(staging)!==staging || await privateDirectoryState(staging,await lstat(staging))!=='private')throw denied()
  const system=process.env.SystemRoot
  if(!system||!isAbsolute(system))throw denied()
  const powershell=join(system,'System32','WindowsPowerShell','v1.0','powershell.exe')
  async function command(mode:'volume'|'scan'|'released'|'release'|'recover'|'witness',request:object,lifetime?:AbortSignal){
    const task=run(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',helper,mode],{timeout,signal:lifetime,windowsHide:true,maxBuffer:32768,env:scrubbedGatewayChildEnv()})
    task.child.stdin?.on('error',()=>{/* Process exit reports failure if the helper closes its input early. */})
    task.child.stdin?.end(JSON.stringify(request))
    const result=await task
    return JSON.parse(result.stdout.trim())
  }
  const selected=await command('volume',{source,volume,pid:process.pid},signal)
  if(typeof selected.volume!=='string' || selected.volume.toLowerCase()!==('\\\\?\\Volume{'+volume+'}\\').toLowerCase() ||
    typeof selected.start!=='string'||!/^\d+$/u.test(selected.start))throw denied()
  await command('recover',{source,volume,stage:staging},signal)
  const job=await mkdtemp(join(staging,'hgw-vss-'))
  const pipe='hgw-vss-'+randomUUID(),key=randomBytes(32).toString('hex')
  const sockets=new Set<Socket>()
  const server=createServer()
  const controller=new AbortController()
  let owner:Socket|undefined,receipt:z.infer<typeof hello>|undefined
  let processExit:Promise<void>|undefined,worker:ReturnType<typeof spawn>|undefined
  const shutdown=()=>{for(const socket of sockets)socket.destroy()}
  const disconnected=()=>controller.abort()
  signal.addEventListener('abort',disconnected,{once:true})
  controller.signal.addEventListener('abort',shutdown,{once:true})
  let readyTimer:ReturnType<typeof setTimeout>|undefined
  let ending:Promise<void>|undefined
  const release=()=>ending??=(async()=>{
    let cleaned=false
    try{
      if(readyTimer)clearTimeout(readyTimer)
      await writeFile(join(job,'cancel'),'')
      for(const socket of sockets)socket.end()
      if(processExit){
        const deadline=setTimeout(()=>{shutdown();worker?.kill()},timeout)
        try{await processExit}finally{clearTimeout(deadline)}
      }
      await command('release',{source,volume,job})
      if(receipt)await command('released',{id:receipt.id})
      cleaned=true
    }finally{
      signal.removeEventListener('abort',disconnected)
      controller.signal.removeEventListener('abort',shutdown)
      for(const socket of sockets)socket.destroy()
      if(server.listening)await new Promise<void>(done=>server.close(()=>done()))
      if(cleaned && await realpath(job)===job)await rm(job,{recursive:true,force:true})
    }
  })()
  try{
    if(await privateDirectoryState(job,await lstat(job))!=='private')throw denied()
    await writeFile(join(job,'request.json'),JSON.stringify({pipe,key,volume,timeout,pid:process.pid,start:selected.start}),{flag:'wx',mode:0o600})
    await writeFile(join(job,'hold.cmd'),'@echo off\r\n"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -NonInteractive -File "%HGW_VSS_HELPER%" hold\r\nexit /b %errorlevel%\r\n',{flag:'wx'})
    await writeFile(join(job,'run.dsh'),['SET CONTEXT VOLATILE NOWRITERS','SET METADATA hgw-shadow.cab','ADD VOLUME '+selected.volume+' ALIAS HgwProjectShadow','CREATE','EXEC hold.cmd','DELETE SHADOWS ID %HgwProjectShadow%','EXIT',''].join('\r\n'),{flag:'wx'})
    await new Promise<void>((accept,reject)=>{server.once('error',reject);server.listen('\\\\.\\pipe\\'+pipe,accept)})
    const connected=new Promise<z.infer<typeof hello>>((accept,reject)=>{
      server.on('connection',socket=>{
        sockets.add(socket)
        socket.once('error',()=>socket.destroy())
        socket.once('close',()=>{sockets.delete(socket);if(socket===owner && !ending)controller.abort()})
        let message=''
        socket.on('data',(chunk:Buffer)=>{
          if(owner||message.length+chunk.length>2048){socket.destroy();return}
          message+=chunk.toString('utf8')
          if(!message.includes('\n'))return
          try{
            const received=hello.parse(JSON.parse(message.trim()))
            if(received.key!==key){socket.destroy();return}
            owner=socket;accept(received)
          }catch{socket.destroy()}
        })
      })
      readyTimer=setTimeout(()=>reject(denied()),timeout)
    })
    signal.throwIfAborted()
    worker=spawn(join(system,'System32','diskshadow.exe'),['-s','run.dsh'],{cwd:job,windowsHide:true,stdio:'ignore',
      env:{...scrubbedGatewayChildEnv(),HGW_VSS_JOB:job,HGW_VSS_HELPER:helper}})
    processExit=new Promise<void>((accept,reject)=>{worker!.once('error',reject);worker!.once('close',()=>accept())})
    receipt=await Promise.race([connected,processExit.then(()=>{throw denied()})])
    clearTimeout(readyTimer)
    signal.throwIfAborted()
    const shadow=receipt
    const drive=source.slice(0,3)
    const map=(path:string)=>{
      if(!inside(source,path)||resolve(path)!==path||path.slice(2).includes(':'))throw denied()
      return join(shadow.device,relative(drive,path))
    }
    let inspected:string[]=[]
    const confirm=async()=>{if(controller.signal.aborted||ending)throw denied();await command('witness',{source,volume,id:shadow.id,device:shadow.device},signal)}
    return {id:shadow.id,root:map(source),map,release,confirm,async inspect(paths:readonly string[],limit:number){
      const originals=paths.filter(path=>inside(source,path))
      if(!Number.isSafeInteger(limit)||limit<1||limit>2147483647)throw denied()
      await command('scan',{source,volume,id:shadow.id,device:shadow.device,paths:originals.map(path=>relative(drive,path)),limit},signal)
      inspected=originals.map(map)
    },verifiedPath(path:string){
      if(controller.signal.aborted||ending||!inspected.some(root=>inside(root,path))||resolve(path)!==path)throw denied()
      return path
    }}
  }catch(error){
    shutdown()
    try{await release()}catch(cleanup){throw new AggregateError([error,cleanup],'Project shadow acquisition and release failed')}
    throw error
  }
}
