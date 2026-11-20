/** Copy only one recovered Runtime's directory and tab drafts into the selected node's shared SQLite domains. */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { openPersonalIndex } from './personal-index-worker.ts'
import { prepareDraftSchema } from './node-draft-schema.ts'
import { peerPrivateDirectory,PeerBackupError } from './peer-backup-repository.ts'
import type { PeerPersonalRecoveryOperation } from './peer-backup-personal-recovery.ts'
import type { PersonalRecoveryEvidence,PersonalRecoveryLimits } from './peer-backup-personal-stage.ts'
import type { PersonalWorkspaceSnapshot } from './workspace-catalog.ts'

function fail():never{throw new PeerBackupError(409,'peer-backup/personal-target-changed')}
/** Rebind node and process generation while preserving Runtime, workspace, Session and per-tab draft identities. */
export async function importPersonalRecoveryProjection(stateRoot:string,op:PeerPersonalRecoveryOperation,directory:string,
  workspaces:PersonalRecoveryEvidence['workspaces'],limits:PersonalRecoveryLimits,signal:AbortSignal):Promise<void>{
  const source=new DatabaseSync(join(directory,'personal.sqlite'),{readOnly:true})
  const owner=JSON.stringify([op.organizationId,op.sourceNode,op.runtimeId,op.userId]),destination=JSON.stringify([op.organizationId,op.targetNode,op.runtimeId,op.userId])
  const rows:{collection:string;body:Record<string,unknown>}[]=[]
  try{
    let bytes=0
    for(const row of source.prepare('SELECT collection,body FROM records').iterate()){
      signal.throwIfAborted();bytes+=Buffer.byteLength(String(row.body))
      if(rows.length>=limits.maxRows||bytes>limits.maxBytes)fail()
      const body=JSON.parse(String(row.body)) as Record<string,unknown>
      if(row.collection!=='drafts'&&body.owner!==owner)fail()
      rows.push({collection:String(row.collection),body})
    }
  }finally{source.close()}
  const publication=rows.find(row=>row.collection==='publications')?.body
  if(!publication||String(publication.generation)!==op.oldEpoch)fail()
  const snapshot:PersonalWorkspaceSnapshot={revision:Number(publication.revision),items:rows.filter(row=>row.collection==='workspaces').map(({body})=>{
    const value=JSON.parse(String(body.value)) as PersonalWorkspaceSnapshot['items'][number],mapping=workspaces.find(row=>row.id===body.id)
    if(!mapping||value.path!==mapping.source)fail()
    return {...value,path:mapping.destination,sessionIds:rows.filter(row=>row.collection==='members'&&row.body.workspace===body.id).map(row=>String(row.body.session))}
  }),...(publication.has_conversations===1?{conversations:rows.filter(row=>row.collection==='conversations').map(row=>JSON.parse(String(row.body.value)))}:{})}
  const generation=Number(op.newEpoch)
  if(!Number.isSafeInteger(generation)||generation<1)fail()
  await peerPrivateDirectory(join(stateRoot,'personal-directory'));await peerPrivateDirectory(join(stateRoot,'node-content-drafts'))
  const catalog=new DatabaseSync(join(stateRoot,'personal-directory','index.sqlite'))
  try{
    const execute=openPersonalIndex(catalog),existing=catalog.prepare('SELECT generation,revision,digest FROM publications WHERE owner=?').get(destination)
    const digest=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
    if(existing&&(existing.generation!==generation||existing.revision!==snapshot.revision||existing.digest!==digest))fail()
    execute({op:'publish',owner:{organizationId:op.organizationId,nodeId:op.targetNode,runtimeId:op.runtimeId,userId:op.userId},input:{generation,snapshot}})
  }finally{catalog.close()}
  const drafts=new DatabaseSync(join(stateRoot,'node-content-drafts','drafts.sqlite'))
  try{
    prepareDraftSchema(drafts);drafts.exec('BEGIN IMMEDIATE')
    for(const {body} of rows.filter(row=>row.collection==='drafts')){
      signal.throwIfAborted()
      const identity=JSON.parse(String(body.identity)) as unknown[]
      if(identity.length!==7||identity[0]!==op.organizationId||identity[1]!==op.sourceNode||identity[2]!==op.userId||identity[3]!==op.runtimeId)fail()
      identity[1]=op.targetNode
      const key=JSON.stringify(identity),history=String(body.history??'[]'),revision=Number(body.revision),text=String(body.text)
      drafts.prepare('INSERT OR IGNORE INTO drafts(identity,revision,text,previous_versions) VALUES(?,?,?,?)').run(key,revision,text,history)
      const saved=drafts.prepare('SELECT revision,text,previous_versions FROM drafts WHERE identity=?').get(key)
      if(saved?.revision!==revision||saved.text!==text||saved.previous_versions!==history)fail()
    }
    drafts.exec('COMMIT')
  }finally{drafts.close()}
}
