/** A lazy file-only subprocess shared by both node-local SQLite domains. */
import { spawn,type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { PersonalIndexRequest } from './personal-index.ts'
import type { NodeDraftKey,NodeDraftOperation } from './node-drafts.ts'

/** Authenticated draft edits and bounded predecessor reads. */
export type DraftFileRequest={op:'apply';key:NodeDraftKey;operation:NodeDraftOperation;limits?:import('./draft-history.ts').DraftHistoryLimits}|{op:'project-page';owner:{organizationId:string;nodeId:string;runtimeId:string};after:string}
/** The file process accepts only operations supplied by its two owning services. */
export type SqliteFileRequest={domain:'drafts';input:DraftFileRequest}|{domain:'personal';input:Exclude<PersonalIndexRequest,{op:'close'}>}|{domain:'close'}|{domain:'inspect'}
const unavailable=()=>new Error('The private database operation did not complete on its computer.')

/** Each Gateway acquires one host for drafts and the personal directory. Browsing unrelated scopes starts no process. */
export class NodePrivateSqliteHost {
  private child?:ChildProcess
  private closing?:Promise<void>
  private exited?:Promise<void>
  private id=0
  private owners=0
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>()
  constructor(private readonly root:string,private readonly proofTimeoutMs=10_000){}

  /** @returns a release function that drains the worker when its final owning service closes. */
  retain():()=>Promise<void>{
    this.owners++
    let active=true
    return async()=>{if(!active)return;active=false;if(--this.owners===0)await this.drain()}
  }

  /** @returns local process and request counts for measuring idle resource use; payloads are never retained in diagnostics. */
  stats():{pid:number|null;requests:number;pending:number}{return {pid:this.child?.pid??null,requests:this.id,pending:this.pending.size}}

  /** Measure one already-active file host. An idle Gateway does not start a process or send IPC for this read.
   * @returns resident bytes and cumulative OS locality/ownership proofs, or null before first use.
   */
  async footprint():Promise<{rss:number;mounts:number;permissions:number;nativeAclReads:number}|null>{
    return this.child ? await this.send(this.child,{domain:'inspect'}) as {rss:number;mounts:number;permissions:number;nativeAclReads:number} : null
  }

  private spawn():ChildProcess{
    if(this.child)return this.child
    const source=import.meta.url.endsWith('.ts'),script=fileURLToPath(new URL('./node-private-sqlite-worker.'+(source?'ts':'js'),import.meta.url))
    const child=spawn(process.execPath,[...(source?['--import',pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href]:[]),script],{
      serialization:'advanced',windowsHide:true,
      env:Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LC_ALL'].flatMap(k=>process.env[k]===undefined?[]:[[k,process.env[k]!]])),
      stdio:['ignore','ignore','ignore','ipc'],
    })
    this.child=child
    let exited!:()=>void
    this.exited=new Promise<void>(done=>{exited=done})
    const failed=()=>{
      if(this.child!==child)return
      for(const waiter of this.pending.values())waiter.reject(unavailable())
      this.pending.clear()
    }
    child.once('error',failed)
    child.once('disconnect',()=>{
      failed()
      if(!this.closing&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL')
    })
    const gone=()=>{
      if(this.child!==child)return
      failed();this.child=undefined;this.exited=undefined;exited()
    }
    child.once('exit',gone);child.once('close',gone)
    child.on('message',(raw:unknown)=>{
      if(this.child!==child||!raw||typeof raw!=='object'||!('id' in raw)||typeof raw.id!=='number')return
      const waiter=this.pending.get(raw.id);if(!waiter)return
      this.pending.delete(raw.id)
      if('ok' in raw&&raw.ok===true)waiter.resolve('value' in raw?raw.value:undefined)
      else waiter.reject(unavailable())
    })
    return child
  }

  private send(child:ChildProcess,request:SqliteFileRequest):Promise<unknown>{
    const id=++this.id
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject})
      try{child.send({id,root:this.root,timeout:this.proofTimeoutMs,request},error=>{
        if(error&&this.pending.delete(id))reject(unavailable())
      })}catch{this.pending.delete(id);reject(unavailable())}
    })
  }

  /** @param request - an operation scoped by its authenticated owning service. @returns the node worker's committed result. */
  async request(request:Exclude<SqliteFileRequest,{domain:'close'|'inspect'}>):Promise<unknown>{
    if(this.closing)await this.closing
    if(this.child&&!this.child.connected)await this.exited
    if(!this.owners)throw unavailable()
    return this.send(this.spawn(),request)
  }

  private async drain():Promise<void>{
    if(this.closing)return this.closing
    const child=this.child,exit=this.exited
    if(!child||!exit)return
    if(!child.connected){await exit;return}
    const closing=(async()=>{
      try{await this.send(child,{domain:'close'})}finally{
        if(child.connected)child.disconnect()
        await exit
      }
    })()
    this.closing=closing
    try{await closing}finally{if(this.closing===closing)this.closing=undefined}
  }
}
