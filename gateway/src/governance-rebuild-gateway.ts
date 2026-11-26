/** Restricted Admin actions for an imported governance database; normal routing is supplied by the Gateway owner. */
import type { IncomingMessage,ServerResponse } from 'node:http'
import { z } from 'zod'
import { CollaborationDeniedError } from './collaboration.ts'
import type { GatewayConfig } from './config.ts'
import type { RuntimeTarget } from './instances.ts'
import type { NodeContentStore } from './node-content-store.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { GovernanceRebuildExecution } from './governance-rebuild-execution.ts'
import { GovernanceLocalEnvironmentReview,GovernanceRebuildLocalData } from './governance-rebuild-local-data.ts'
import { GovernanceRebuildReview } from './governance-rebuild-review.ts'
import { PeerRecoveryExecution } from './peer-backup-execution.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

const base='/admin/api/governance-recovery'
interface Options {
  context:PostgresRuntimeContext
  config:GatewayConfig
  limits:{maxRows:number;maxBytes:number}
  pageSize:number
  volume?:Pick<NodeContentStore,'readVolume'>
  assertStopped:(target:RuntimeTarget)=>Promise<void>
  prepareProfile:(target:RuntimeTarget)=>Promise<void>
}
/** Ingress facts must be derived before any forwarding; browser headers cannot authorize local path selection. */
export interface GovernanceRebuildIngress {directLocal:boolean;signal:AbortSignal}

async function body(req:IncomingMessage):Promise<unknown>{
  const chunks:Buffer[]=[];let bytes=0
  for await(const chunk of req){const value=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk as Uint8Array);bytes+=value.length
    if(bytes>16384)throw new PeerBackupError(413,'peer-backup/request-too-large');chunks.push(value)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function send(res:ServerResponse,status:number,data:unknown){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}).end(JSON.stringify(data))}

/** Owner-constructed services and HTTP dispatch; creation performs no import, process launch or background work. */
export class GovernanceRebuildGateway {
  readonly review:GovernanceRebuildReview
  readonly data:GovernanceRebuildLocalData
  readonly adapter:GovernanceRebuildExecution
  readonly execution:PeerRecoveryExecution
  constructor(options:Options){
    this.review=new GovernanceRebuildReview(options.context,{pageSize:options.pageSize,projectNameKeyFile:options.config.projectNameKeyFile})
    this.data=new GovernanceRebuildLocalData(options.context,options.config,{limits:options.limits,volume:options.volume})
    this.adapter=new GovernanceRebuildExecution(options.context,{config:options.config,files:this.data,assertStopped:options.assertStopped})
    this.execution=new PeerRecoveryExecution({context:options.context,config:options.config,governance:this.adapter,
      volume:options.volume,maxRows:options.limits.maxRows,maxBytes:options.limits.maxBytes,prepareProfile:options.prepareProfile})
  }

  /** Advance only node-owned inspection queues; an execution hold remains until explicit artifact review succeeds.
   * @param signal - the owning Gateway worker lifetime.
   */
  async advance(signal:AbortSignal):Promise<void>{await this.adapter.bindNext(signal);await this.execution.prepareNext(signal)}

  /** Dispatch after cookie authentication and origin checks, including during the restricted rebuilding state.
   * @param req - authenticated browser request. @param res - response owned when true is returned.
   * @param actor - current administrator's public account ID. @param ingress - trusted original-entry facts and request lifetime.
   * @returns whether this is a governance rebuilding endpoint.
   */
  async admin(req:IncomingMessage,res:ServerResponse,actor:number,ingress:GovernanceRebuildIngress):Promise<boolean>{
    const url=new URL(req.url??'/','http://localhost')
    if(url.pathname!==base&&!url.pathname.startsWith(base+'/'))return false
    try{
      if(!ingress.directLocal)throw new PeerBackupError(403,'peer-backup/governance-local-target-required')
      if(url.pathname===base+'/local'&&req.method==='GET'){
        const {after}=z.object({after:z.uuid().optional()}).strict().parse(Object.fromEntries(url.searchParams))
        send(res,200,await this.review.localStatus(actor,after));return true
      }
      if(url.pathname===base&&req.method==='GET'){
        const cursors=z.object({accounts:z.string().optional(),nodes:z.string().optional(),runtimes:z.string().optional(),configuration:z.string().optional()}).strict().parse(Object.fromEntries(url.searchParams))
        send(res,200,await this.review.status(actor,cursors));return true
      }
      const route=/^\/admin\/api\/governance-recovery\/([a-f0-9-]{36})\/(?:release|(accounts|nodes)\/([a-f0-9-]{36})\/review|runtimes\/([a-f0-9-]{36})\/(bind-data|execution)(?:\/(prepare|enable)|\/items\/([^/]+)\/approve)?)$/u.exec(url.pathname)
      if(!route)throw new PeerBackupError(404,'peer-backup/unsupported-operation')
      const operation=z.uuid().parse(route[1]),runtime=route[4]
      if(runtime){
        const current=await this.adapter.get(runtime)
        if(current.governanceOperationId!==operation)throw new PeerBackupError(409,'peer-backup/governance-review-changed')
        if(route[5]==='execution'&&req.method==='GET'&&!route[6]&&!route[7])send(res,200,await this.execution.status(actor,runtime))
        else if(req.method==='POST'){
          const input=await body(req)
          if(route[5]==='bind-data'){
            if(typeof input==='object'&&input!==null&&'selection' in input){
              await this.adapter.bindLocal(actor,runtime,input,ingress.signal)
            }else await this.adapter.requestBinding(actor,runtime,input)
            send(res,202,{status:'accepted'})
          }else{
            if(route[6]==='prepare')await this.execution.prepare(actor,runtime,input)
            else if(route[6]==='enable')await this.execution.enable(actor,runtime,input)
            else if(route[7])await this.execution.approveItem(actor,runtime,decodeURIComponent(route[7]),input)
            else throw new PeerBackupError(405,'peer-backup/unsupported-operation')
            send(res,route[6]==='enable'?200:202,await this.execution.status(actor,runtime))
          }
        }else throw new PeerBackupError(405,'peer-backup/unsupported-operation')
      }else if(req.method==='POST'){
        const input=await body(req)
        const result=route[2]==='accounts'?await this.review.reviewAccount(actor,operation,route[3]!,input):
          route[2]==='nodes'?await this.review.reviewNode(actor,operation,route[3]!,input):await this.review.release(actor,operation,input)
        send(res,200,result)
      }else throw new PeerBackupError(405,'peer-backup/unsupported-operation')
    }catch(error){
      req.resume()
      if(res.headersSent)res.destroy()
      else if(error instanceof GovernanceLocalEnvironmentReview&&ingress.directLocal)send(res,error.status,{error:error.code,keys:error.keys})
      else if(error instanceof PeerBackupError)send(res,error.status,{error:error.code})
      else if(error instanceof CollaborationDeniedError)send(res,403,{error:'forbidden'})
      else if(error instanceof z.ZodError||error instanceof SyntaxError||error instanceof URIError)send(res,400,{error:'peer-backup/invalid-request'})
      else send(res,503,{error:'peer-backup/governance-operation-failed'})
    }
    return true
  }
}
