/** Metadata-only conversation and resource-admission observations in a bounded process ring. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PoolClient } from 'pg'
import type { ReadySessionOutcome, ReadySessionRoute } from './performance-observer.ts'
import { isReadyRuntimeRead } from './runtime-request-path.ts'

const method = new Map([
  ['/api/prepare/v1/session.create','create'],['/api/prepare/v1/session.history','history'],['/api/session.history','history'],
  ['/api/host.describe','hostDescription'],['/api/workspace.list','workspaceList'],['/api/session.list','sessionList'],
  ['/api/admit/v1/session.prompt','send'],['/api/admit/v1/session.status','status'],
  ['/api/terminal/write','terminalWrite'],['/api/terminal/follow','terminalFollow'],
  ['/account/api/runtime/prepare/v1','runtimePrepare'],
  ['/internal/runtime/execution/input','executionInput'],['/internal/runtime/execution/register-session','executionRegister'],
  ['/internal/runtime/execution/enter','executionEnter'],['/internal/runtime/execution/authorize','executionAuthorize'],
  ['/internal/runtime/resources/request','resourceRequest'],['/internal/runtime/resources/statuses','resourceStatuses'],
  ['/internal/runtime/model-credential','modelCredential'],
] as const)
const getMethod = new Map([
  ['/account/api/workbench/rows', 'workbenchRows'],
  ['/account/api/workbench/context', 'workbenchContext'],
  ['/account/api/documents/overview', 'documentsOverview'],
  ['/account/api/node-document-overview', 'nodeDocumentOverview'],
] as const)
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
export type OperationPhase='authorize'|'prepare'|'admit'|'accessSync'|'runtimeQueue'|'runtimeLiveness'|'nodeConnection'|'nodeQueue'|'nodeLeaseCheck'|'nodeServiceOpen'|'upstream'
  |'entryReadApproval'|'entryReadRelease'|'nodePreparedRead'
  | 'governanceCheckout' | 'contentCheckout' | 'resourceWriteAdmission' | 'resourceChangeWait' | 'executionInputServer'
type Method='bootstrap'|'hostDescription'|'workspaceList'|'sessionList'|'create'|'history'|'send'|'status'
  |'terminalWrite'|'terminalFollow'|'runtimePrepare'|'workbenchRows'|'workbenchContext'|'documentsOverview'|'nodeDocumentOverview'
  |'executionInput'|'executionRegister'
  |'executionEnter'|'executionAuthorize'|'resourceRequest'|'resourceStatuses'|'modelCredential'
type SqlRole='governance'|'content'
/** Result of acquiring one exclusive PostgreSQL client. */
export type ConnectionCheckout = { kind: 'opened'; setupMs: number } | { kind: 'reused' | 'handoff' | 'failed' }
interface CheckoutSpans {
  opened: number; reused: number; handoffs: number; failed: number
  setupMs: number; waitMs: number; failedMs: number
}
type NodeTransport='opened'|'reused'
type ForwardingMark='leaseAcquired'|'assertionReady'|'socketAssigned'|'requestWritten'|'responseHeaders'
const admissionPhases=['sessionAuthority','agentReadiness','admissionWait','executionStamp','inboxAppend','inboxPublish','inboxWake','flushReceipt','readReceipt'] as const
type HostAdmission=Partial<Record<typeof admissionPhases[number],number>>
const preparationPhases = ['bodyMs', 'sessionMs', 'initialHistoryMs'] as const
type HostPreparation = Partial<Record<typeof preparationPhases[number], number>>
interface Sample {
  id:string; operation:Method; startedAtMs:number; durationMs:number; responseHeadersMs?:number
  status:number; aborted:boolean; sentBytes:number|null; receivedBytes:number|null
  forwarding?:Partial<Record<ForwardingMark,number>>
  readySession?:Partial<Record<ReadySessionRoute,Partial<Record<ReadySessionOutcome,number>>>>
  databaseCheckout?:Partial<Record<SqlRole,CheckoutSpans>>
  resourceBearerDatabase?:{poolWaitMs:number;connectionSetupMs:number;failedCheckoutMs:number;queryMs:number;queries:number}
  phases:Partial<Record<OperationPhase,number>>; sql:Record<SqlRole,{count:number;elapsedMs:number}>
  hostMs?:number; hostAdmission?:HostAdmission; hostPreparation?:HostPreparation; nodeTransport?:NodeTransport
}
interface Flight {sample:Sample; start:number; closed:boolean}
const current=new AsyncLocalStorage<Flight>()
const rounded=(ms:number)=>Math.round(Math.max(0,ms)*100)/100
function length(value:string|string[]|number|undefined):number|null {
  if(value===undefined || Array.isArray(value) || !/^\d{1,16}$/u.test(String(value))) return null
  const n=Number(value)
  return Number.isSafeInteger(n)?n:null
}

/** @returns Whether database dispatch has an active request observation to preserve across checkout. */
export function hasOperationTiming(): boolean {
  return current.getStore()?.closed === false
}

function hostPhases<Phase extends string>(value: unknown, phases: readonly Phase[]): Partial<Record<Phase, number>> | undefined {
  if(typeof value!=='string' || value.length>512) return undefined
  let decoded:unknown
  try { decoded=JSON.parse(value) } catch { return undefined }
  if (typeof decoded!=='object' || decoded===null || Array.isArray(decoded)) return undefined
  const fields=decoded as Record<string,unknown>, result:Partial<Record<Phase, number>>={}
  for(const phase of phases) {
    const ms=fields[phase]
    if(typeof ms==='number' && Number.isFinite(ms) && ms>=0 && ms<=1e8) result[phase]=rounded(ms)
  }
  return result
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

function resourceBearerDatabase(sample: Sample): NonNullable<Sample['resourceBearerDatabase']> {
  const pool = sample.databaseCheckout?.governance
  const sql = sample.sql.governance
  return { poolWaitMs: pool?.waitMs ?? 0, connectionSetupMs: pool?.setupMs ?? 0, failedCheckoutMs: pool?.failedMs ?? 0,
    queryMs: sql.elapsedMs, queries: sql.count }
}

/**
 * Attribute a resource bearer lookup before the write check and accounting statements.
 * @param work - Runtime credential verification.
 * @returns The unchanged verification result. Query duration includes database transport.
 */
export async function timeResourceBearer<T>(work: () => Promise<T> | T): Promise<T> {
  const flight = current.getStore()
  if (flight === undefined || flight.closed) return work()
  const finish = operationPhase('authorize')
  const before = resourceBearerDatabase(flight.sample)
  try { return await work() } finally {
    finish()
    if (!flight.closed) {
      const after = resourceBearerDatabase(flight.sample)
      flight.sample.resourceBearerDatabase = {
        poolWaitMs: rounded(after.poolWaitMs - before.poolWaitMs),
        connectionSetupMs: rounded(after.connectionSetupMs - before.connectionSetupMs),
        failedCheckoutMs: rounded(after.failedCheckoutMs - before.failedCheckoutMs),
        queryMs: rounded(after.queryMs - before.queryMs), queries: after.queries - before.queries,
      }
    }
  }
}

/**
 * Record connection reuse in the current bounded operation sample.
 * @param state - whether the node-service acquisition opened or reused a transport.
 */
export function recordNodeTransport(state:NodeTransport):void{
  const flight=current.getStore()
  if(flight && !flight.closed) flight.sample.nodeTransport=state
}

/**
 * Record one ready-Session forwarding attempt on the current request.
 * @param route - whether the attempt used the node assertion or ordinary account path.
 * @param outcome - decision for this attempt.
 */
export function recordReadySession(route: ReadySessionRoute, outcome: ReadySessionOutcome): void {
  const flight = current.getStore()
  if (flight === undefined || flight.closed) return
  const routes = flight.sample.readySession ??= {}
  const outcomes = routes[route] ??= {}
  outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
}

/**
 * Record the database server's elapsed execution input statement time.
 * @param milliseconds - time measured on PostgreSQL, including any server-side waits.
 */
export function recordExecutionInputServerTime(milliseconds: number): void {
  const flight = current.getStore()
  if (flight?.sample.operation === 'executionInput' && !flight.closed && Number.isFinite(milliseconds)) {
    flight.sample.phases.executionInputServer = rounded(milliseconds)
  }
}

/**
 * Capture the current request's clock for callbacks on a pooled HTTP socket.
 * @returns a recorder for elapsed milliseconds at a local forwarding event.
 */
export function forwardingMarks():(mark:ForwardingMark)=>void {
  const flight=current.getStore()
  if(!flight || flight.closed) return ()=>{}
  const marks=flight.sample.forwarding ??= {}
  return mark=>{
    if(!flight.closed) marks[mark] ??= rounded(performance.now()-flight.start)
  }
}

/**
 * Capture one pool acquisition separately from SQL issued on the resulting connection.
 * @param role - configured data plane.
 * @returns Recorder for the checkout outcome. A failed checkout reports only its elapsed time.
 */
export function observeOperationCheckout(role: SqlRole): (result: ConnectionCheckout) => void {
  const flight = current.getStore()
  if (!flight || flight.closed) return () => {}
  const start = performance.now()
  const phase = role === 'governance' ? 'governanceCheckout' : 'contentCheckout'
  return result => {
    if (flight.closed) return
    const elapsed = performance.now() - start
    flight.sample.phases[phase] = rounded((flight.sample.phases[phase] ?? 0) + elapsed)
    const all = flight.sample.databaseCheckout ??= {}
    const spans = all[role] ??= { opened: 0, reused: 0, handoffs: 0, failed: 0, setupMs: 0, waitMs: 0, failedMs: 0 }
    if (result.kind === 'failed') {
      spans.failed++
      spans.failedMs = rounded(spans.failedMs + elapsed)
      return
    }
    const setup = result.kind === 'opened' ? Math.min(elapsed, result.setupMs) : 0
    spans.setupMs = rounded(spans.setupMs + setup)
    spans.waitMs = rounded(spans.waitMs + elapsed - setup)
    if (result.kind === 'opened') spans.opened++
    else {
      spans.reused++
      if (result.kind === 'handoff') spans.handoffs++
    }
  }
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

/** Per-Gateway ring. Operation UUIDs have no authorization or routing meaning. */
export class OperationTimings {
  private readonly history:Sample[]=[]
  private position=0
  constructor(private readonly capacity:number){}
  /** @param req - browser or authenticated node request. @param res - live response. @param work - existing Gateway handler.
   * @returns the handler promise without extending the request lifetime.
   */
  run<T>(req:IncomingMessage,res:ServerResponse,work:()=>Promise<T>):Promise<T>{
    if (!this.capacity) return work()
    const suppliedId=req.headers['x-dsh-operation-id']
    if (suppliedId !== undefined && (typeof suppliedId!=='string' || !uuid.test(suppliedId))) return work()
    const path=(req.url??'').split('?',1)[0]!
    const action = req.method==='POST' ? (method as ReadonlyMap<string,Method>).get(path)
      : req.method==='GET'
        ? ((getMethod as ReadonlyMap<string,Method>).get(path)
          ?? (path==='/' && isReadyRuntimeRead(req.method, new URL(req.url??'/', 'http://gateway')) ? 'bootstrap' : undefined))
        : undefined
    if (action === undefined) return work()
    const requestId=suppliedId ?? (action==='executionEnter' || action==='executionAuthorize' || action==='resourceRequest'
      || action==='resourceStatuses' || action==='modelCredential' ? randomUUID() : undefined)
    if (requestId === undefined) return work()
    const sample:Sample={id:requestId,operation:action,startedAtMs:Date.now(),status:0,durationMs:0,aborted:false,
      receivedBytes:action==='modelCredential' ? null : length(req.headers['content-length']),
      sentBytes:null,phases:{},sql:{governance:{count:0,elapsedMs:0},content:{count:0,elapsedMs:0}}}
    const scope:Flight={sample,start:performance.now(),closed:false}
    const writeHead=res.writeHead
    const observeWriteHead=new Proxy(writeHead,{apply(target,receiver,args){
      const result=Reflect.apply(target,receiver,args)
      if(!scope.closed) sample.responseHeadersMs ??= rounded(performance.now()-scope.start)
      return result
    }})
    res.writeHead=observeWriteHead
    const finish=()=>{
      if(scope.closed)return
      scope.closed=true
      res.off('finish',finish);res.off('close',finish)
      if(res.writeHead===observeWriteHead) res.writeHead=writeHead
      sample.durationMs=rounded(performance.now()-scope.start);sample.status=res.statusCode;sample.aborted=!res.writableFinished
      if (action!=='modelCredential') sample.sentBytes=length(res.getHeader('content-length'))
      const host=res.getHeader('x-dsh-host-duration-ms')
      if(typeof host==='string' && /^\d{1,8}(?:\.\d{1,3})?$/u.test(host)) sample.hostMs=Number(host)
      const admissions=action==='send' ? hostPhases(res.getHeader('x-dsh-host-admission-ms'), admissionPhases) : undefined
      if(admissions!==undefined) sample.hostAdmission=admissions
      if(action==='create' || action==='history') {
        const preparation = hostPhases(res.getHeader('x-dsh-host-prepare-ms'), preparationPhases)
        if (preparation !== undefined) sample.hostPreparation = preparation
      }
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
