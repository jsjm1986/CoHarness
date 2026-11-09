/** Metadata-only per-request observations on the versioned conversation routes, confined to a bounded process ring. */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PoolClient } from 'pg'

const method = new Map([
  ['/api/prepare/v1/session.create','create'],['/api/prepare/v1/session.history','history'],
  ['/api/admit/v1/session.prompt','send'],['/api/admit/v1/session.status','status'],
] as const)
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
export type OperationPhase='authorize'|'prepare'|'admit'|'nodeConnection'|'upstream'
type Method='create'|'history'|'send'|'status'
type SqlRole='governance'|'content'
interface Sample {
  id:string; operation:Method; durationMs:number; status:number; aborted:boolean; sentBytes:number|null; receivedBytes:number|null
  phases:Partial<Record<OperationPhase,number>>; sql:Record<SqlRole,{count:number;elapsedMs:number}>; hostMs?:number
}
interface Flight {sample:Sample; closed:boolean}
const current=new AsyncLocalStorage<Flight>()
const rounded=(ms:number)=>Math.round(Math.max(0,ms)*100)/100
function length(value:string|string[]|number|undefined):number|null {
  if(value===undefined || Array.isArray(value) || !/^\d{1,16}$/u.test(String(value))) return null
  const n=Number(value)
  return Number.isSafeInteger(n)?n:null
}

/** @param phase - fixed stage of the current operation. @returns a callback for its end, including callbacks on a pooled socket. */
export function operationPhase(phase:OperationPhase):()=>void {
  const flight=current.getStore()
  if(!flight || flight.closed) return ()=>{}
  const start=performance.now()
  let settled=false
  return ()=>{
    if (!settled && !flight.closed) flight.sample.phases[phase]=rounded((flight.sample.phases[phase]??0)+performance.now()-start)
    settled=true
  }
}

/** @param phase - fixed operation category. @param work - existing authorized operation. @returns the unmodified result. */
export async function timeOperation<T>(phase:OperationPhase,work:()=>Promise<T>):Promise<T>{
  const finish=operationPhase(phase)
  try { return await work() } finally { finish() }
}

/** Capture only query count and duration, preserving pg's native callback, Promise and query-object interfaces.
 * @param db - a newly owned pool client. @param role - its configured data plane.
 */
export function observeOperationSql(db:PoolClient,role:SqlRole):void{
  db.query=new Proxy(db.query,{apply(target,receiver,args:unknown[]){
    const flight=current.getStore()
    if(!flight || flight.closed) return Reflect.apply(target,receiver,args)
    const start=performance.now(),measure=flight.sample.sql[role]
    let settled=false
    const finish=()=>{
      if(settled || flight.closed)return
      settled=true
      measure.elapsedMs=rounded(measure.elapsedMs+performance.now()-start)
    }
    measure.count++
    const cb=args.at(-1)
    const hasCallback=typeof cb==='function'
    if(hasCallback) args[args.length-1]=new Proxy(cb,{apply(callback,owner,parameters){finish();return Reflect.apply(callback,owner,parameters)}})
    try {
      const answer=Reflect.apply(target,receiver,args)
      if(!hasCallback && answer instanceof Promise) void answer.then(finish,finish)
      return answer
    } catch(error) {finish();throw error}
  }})
}

/** Per-Gateway ring. The browser operation UUID has no authorization or routing meaning. */
export class OperationTimings {
  private readonly history:Sample[]=[]
  private position=0
  constructor(private readonly capacity:number){}
  /** @param req - browser or authenticated node request. @param res - live response. @param work - existing Gateway handler.
   * @returns the handler promise without extending the request lifetime.
   */
  run<T>(req:IncomingMessage,res:ServerResponse,work:()=>Promise<T>):Promise<T>{
    const requestId=req.headers['x-dsh-operation-id'],path=(req.url??'').split('?',1)[0]!
    const action=(method as ReadonlyMap<string,Method>).get(path)
    if (!this.capacity || req.method!=='POST' || !action || typeof requestId!=='string' || !uuid.test(requestId)) return work()
    const sample:Sample={id:requestId,operation:action,status:0,durationMs:0,aborted:false,receivedBytes:length(req.headers['content-length']),
      sentBytes:null,phases:{},sql:{governance:{count:0,elapsedMs:0},content:{count:0,elapsedMs:0}}}
    const scope:Flight={sample,closed:false},start=performance.now()
    const finish=()=>{
      if(scope.closed)return
      scope.closed=true
      res.off('finish',finish);res.off('close',finish)
      sample.durationMs=rounded(performance.now()-start);sample.status=res.statusCode;sample.aborted=!res.writableFinished
      sample.sentBytes=length(res.getHeader('content-length'))
      const host=res.getHeader('x-dsh-host-duration-ms')
      if(typeof host==='string' && /^\d{1,8}(?:\.\d{1,3})?$/u.test(host)) sample.hostMs=Number(host)
      if(this.history.length<this.capacity) this.history.push(sample)
      else {this.history[this.position]=sample;this.position=(this.position+1)%this.capacity}
    }
    res.setHeader('x-dsh-operation-id',requestId)
    res.once('finish',finish);res.once('close',finish)
    return current.run(scope,work)
  }
  /** @param id - optional exact browser intent. @returns completed observations oldest first. */
  samples(id?:string):readonly Sample[]{
    return [...this.history.slice(this.position),...this.history.slice(0,this.position)].filter(row=>id===undefined || row.id===id)
  }
}
