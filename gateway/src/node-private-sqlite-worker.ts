/** Private, metadata-free IPC for the Gateway's node-owned drafts and personal projection. */
import type {NodeSqlite} from './node-sqlite-driver.ts'
import {NodePrivateSqlite} from './node-private-sqlite.ts'
import {openDraftStorage} from './node-drafts.ts'
import {openPersonalIndex} from './personal-index-worker.ts'
import type {SqliteFileRequest} from './node-private-sqlite-host.ts'

if(!process.send)throw new Error('Node-private SQLite requires a dedicated Gateway IPC host.')
let queue=Promise.resolve(),configuration:{root:string;timeout:number}|undefined,closing=false
let drafts:NodePrivateSqlite|undefined,index:NodePrivateSqlite|undefined
let runDraft:ReturnType<typeof openDraftStorage>|undefined,runIndex:ReturnType<typeof openPersonalIndex>|undefined
function abandonUnverifiedHandle(){process.kill(process.pid,'SIGKILL')}
async function close(){
  if(closing)return
  closing=true
  try{if(drafts?.unsafeClose||index?.unsafeClose)abandonUnverifiedHandle();await drafts?.close();await index?.close()}
  catch{abandonUnverifiedHandle()}
}
process.on('disconnect',()=>{void queue.then(close)})
process.on('message',(raw:unknown)=>{
  if(!raw||typeof raw!=='object'||!('id'in raw)||typeof raw.id!=='number'||!('root'in raw)||typeof raw.root!=='string'||!('timeout'in raw)||typeof raw.timeout!=='number'||!('request'in raw)||!raw.request||typeof raw.request!=='object')return
  const {id,root,timeout}=raw,request=raw.request as SqliteFileRequest
  queue=queue.then(async()=>{
    try{
      configuration??={root,timeout}
      if(closing||configuration.root!==root||configuration.timeout!==timeout)throw new Error()
      let value:unknown
      if(request.domain==='close')await close()
      else if(request.domain==='inspect'){
        const d=drafts?.proofCounts(),p=index?.proofCounts()
        value={rss:process.memoryUsage.rss(),mounts:(d?.mounts??0)+(p?.mounts??0),permissions:(d?.permissions??0)+(p?.permissions??0),nativeAclReads:(d?.nativeAclReads??0)+(p?.nativeAclReads??0)}
      }
      else if(request.domain==='drafts'){
        drafts??=new NodePrivateSqlite(root,'node-content-drafts','drafts.sqlite',timeout)
        value=await drafts.run((db:NodeSqlite)=>(runDraft??=openDraftStorage(db))(request.input))
      } else if(request.domain==='personal'){
        index??=new NodePrivateSqlite(root,'personal-directory','index.sqlite',timeout)
        value=await index.run((db:NodeSqlite)=>(runIndex??=openPersonalIndex(db))(request.input))
      } else throw new Error()
      if(process.connected)process.send?.({id,ok:true,value})
    }catch{
      if(drafts?.unsafeClose||index?.unsafeClose)abandonUnverifiedHandle()
      if(process.connected)process.send?.({id,ok:false})
    }
  })
})
