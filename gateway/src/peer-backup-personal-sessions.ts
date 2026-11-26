/** Bounded offline Session validation includes roots and children without waking a Runtime. */
import { Worker } from 'node:worker_threads'
import { PeerBackupError } from './peer-backup-repository.ts'

/** Read every persisted Session through its installed format provider, preserving the original files.
 * @param root - previously verified immutable or private restored JSONL directory.
 * @param limits - configured decoded-data and event-count allowance.
 * @param signal - backup or recovery cancellation.
 * @returns the complete old Session set and decoded event count, never Session content.
 */
export async function inspectPersonalSessions(root:string,limits:{maxBytes:number;maxRows:number},signal:AbortSignal,sourcePlatform?:'posix'|'win32'):Promise<{sessionIds:string[];rows:number}>{
  signal.throwIfAborted()
  const env={...process.env};delete env.DSH_MANAGED_DATA_MANIFEST
  const extension=import.meta.url.endsWith('.ts')?'ts':'js'
  const worker=new Worker(new URL(`./peer-backup-personal-sessions-worker.${extension}`,import.meta.url),{
    workerData:{root,...limits,sourcePlatform},env,resourceLimits:{maxOldGenerationSizeMb:256},
  })
  const abort=()=>{void worker.terminate()}
  signal.addEventListener('abort',abort,{once:true})
  try{
    const result=await new Promise<{sessionIds:string[];rows:number}>((accept,reject)=>{
      worker.once('message',(message:{result?:{sessionIds:string[];rows:number};error?:string})=>{
        if(message.result)accept(message.result)
        else reject(new PeerBackupError(409,message.error==='peer-backup/personal-session-platform-unsupported'?message.error:'peer-backup/personal-session-evidence-incomplete'))
      })
      worker.once('error',reject)
      worker.once('exit',()=>reject(new PeerBackupError(503,'peer-backup/personal-session-reader-unavailable')))
    })
    signal.throwIfAborted()
    return result
  }finally{signal.removeEventListener('abort',abort);await worker.terminate()}
}
