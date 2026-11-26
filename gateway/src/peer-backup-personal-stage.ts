/** Private native personal recovery evidence. Only opaque checksums leave the selected replacement computer. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { GatewayConfig } from './config.ts'
import type { PeerPersonalRecoveryOperation } from './peer-backup-personal-recovery.ts'
import { readPersonalRecoveryPoint,restorePeerPersonalFiles } from './peer-backup-personal.ts'
import { preparePersonalCandidate,personalCandidateDigest } from './peer-backup-personal-target.ts'
import { peerCaptureSchema, type PeerBackupDrill } from './peer-backup-restic.ts'
import { PeerBackupError, peerPrivateDirectory } from './peer-backup-repository.ts'
import { privateFileState } from './node-private-file.ts'
import { personalRuntimeLayout } from './runtime-layout.ts'

const sha=(text:string|Buffer)=>createHash('sha256').update(text).digest('hex')
const sum=z.string().regex(/^[a-f0-9]{64}$/u)
const workspace=z.object({id:z.string(),key:sum,source:z.string(),destination:z.string()}).strict()
const physical=z.object({role:z.string(),staged:z.string(),destination:z.string().nullable(),device:z.string(),inode:z.string()}).strict()
const evidenceSchema=z.object({version:z.literal(1),operationId:z.uuid(),organizationId:z.uuid(),accountId:z.uuid(),runtimeId:z.uuid(),
  sourceNode:z.uuid(),targetNode:z.uuid(),pointId:z.uuid(),pointDigest:sum,newEpoch:z.string(),documentDigest:sum,filesDigest:sum,sourceFilesDigest:sum,
  homePath:z.string(),runtimeHome:z.string(),workspaces:z.array(workspace),oldSessionIds:z.array(z.string()),roots:z.array(physical),installedDigest:sum,
  suspendedEnvironmentKeys:z.array(z.string()).max(128),retainedRecovery:z.array(z.object({key:sum,path:z.string(),sha256:sum}).strict())}).strict()
export type PersonalRecoveryEvidence=z.infer<typeof evidenceSchema>
export interface PersonalRecoveryLimits {maxBytes:number;maxRows:number;reserveBytes:number}
function fail(code:string):never{throw new PeerBackupError(409,'peer-backup/'+code)}
const root=(cfg:Pick<GatewayConfig,'stateRoot'>,op:PeerPersonalRecoveryOperation)=>join(cfg.stateRoot,'peer-personal-recovery',op.id)

/** Read the exact encrypted manifest already authenticated by the restic drill. */
export async function personalRecoveryInput(op:PeerPersonalRecoveryOperation,drill:PeerBackupDrill,limits:PersonalRecoveryLimits,signal:AbortSignal){
  const point=drill.point
  if(point.organizationId!==op.organizationId||point.scopeId!==op.runtimeId||point.sourceNodeId!==op.sourceNode||point.targetNodeId!==op.repositoryNode||
    point.pointId!==op.pointId||point.manifestDigest!==op.digest||point.writerEpoch!==op.oldEpoch||point.watermark!==op.revision||point.gapCount)
    fail('point-mismatch')
  const file=join(drill.directory,'checkpoint.json'),info=await lstat(file)
  if(!info.isFile()||info.isSymbolicLink()||info.size>1<<20)fail('corrupt-point')
  const bytes=await readFile(file)
  if(sha(bytes)!==point.manifestDigest)fail('corrupt-point')
  const sealed=z.object({version:z.literal(1),pointId:z.uuid(),binding:z.object({organizationId:z.uuid(),policyId:z.uuid(),revision:z.number().int().positive(),scopeId:z.uuid(),sourceNodeId:z.uuid(),targetNodeId:z.uuid()}).strict(),capture:peerCaptureSchema}).strict().parse(JSON.parse(bytes.toString('utf8')))
  if(sealed.pointId!==point.pointId||sealed.binding.policyId!==op.policyId||sealed.binding.organizationId!==op.organizationId||sealed.binding.scopeId!==op.runtimeId||
    sealed.binding.sourceNodeId!==op.sourceNode||sealed.binding.targetNodeId!==op.repositoryNode||sealed.binding.revision!==point.revision)fail('point-mismatch')
  const proof=await readPersonalRecoveryPoint(sealed.binding,sealed.capture,drill.directory,limits,signal,drill.space)
  if(proof.owner!==op.accountId||proof.userId!==op.userId||proof.documents.rootId!==op.sourceDocumentRoot||proof.documents.volumeId!==op.sourceVolume||
    proof.documents.epoch!==op.sourceDocumentEpoch||proof.sourceGeneration!==op.oldEpoch)fail('point-mismatch')
  return {proof,binding:sealed.binding,capture:sealed.capture}
}

/** Keep paths and old Session IDs private; the persisted checksum must match the immutable control receipt. */
export async function readPersonalRecoveryEvidence(cfg:Pick<GatewayConfig,'stateRoot'>,op:PeerPersonalRecoveryOperation):Promise<PersonalRecoveryEvidence>{
  const file=join(root(cfg,op),'evidence.json'),info=await lstat(file)
  if(await privateFileState(file,info,16<<20)!=='private'||await realpath(file)!==file)fail('personal-target-changed')
  const text=await readFile(file,'utf8'),saved=evidenceSchema.parse(JSON.parse(text))
  if(saved.operationId!==op.id||saved.organizationId!==op.organizationId||saved.accountId!==op.accountId||saved.runtimeId!==op.runtimeId||saved.sourceNode!==op.sourceNode||
    saved.targetNode!==op.targetNode||saved.pointId!==op.pointId||saved.pointDigest!==op.digest||saved.newEpoch!==op.newEpoch||
    op.evidenceDigest!==null&&sha(text)!==op.evidenceDigest||op.filesDigest!==null&&saved.filesDigest!==op.filesDigest||op.documentDigest!==null&&saved.documentDigest!==op.documentDigest||
    op.evidenceDigest!==null&&JSON.stringify(saved.suspendedEnvironmentKeys)!==JSON.stringify(op.suspendedEnvironmentKeys))
    fail('personal-target-changed')
  return saved
}

/** Verify a complete point using the replacement's real Session reader before the administrator can isolate the source. */
export async function stagePersonalRecoveryFiles(cfg:Pick<GatewayConfig,'stateRoot'|'usersRoot'>,op:PeerPersonalRecoveryOperation,
  drill:PeerBackupDrill,limits:PersonalRecoveryLimits,signal:AbortSignal,targetHome?:string){
  if(op.phase!=='preparing')fail('recovery-approval-changed')
  const {proof,binding,capture}=await personalRecoveryInput(op,drill,limits,signal)
  const base=await realpath(cfg.usersRoot),accountBase=join(base,op.username),homePath=targetHome??join(accountBase,'home')
  if(dirname(accountBase)!==base||resolve(homePath)!==homePath||homePath!==accountBase&&!homePath.startsWith(accountBase+sep))fail('invalid-target-files')
  const {dshHome:runtimeHome}=personalRuntimeLayout({usersRoot:base},op)
  const catalog=new DatabaseSync(join(drill.directory,'personal.sqlite'),{readOnly:true})
  const workspaces:z.infer<typeof workspace>[]=[]
  try{
    for(const row of catalog.prepare("SELECT body FROM records WHERE collection='workspaces'").iterate()){
      const data=JSON.parse(String(row.body)) as {id:string;value:string},value=JSON.parse(data.value) as {path:string}
      const key=sha(data.id),source=proof.roots.roots.find(item=>item.role==='workspace'&&item.key===key)
      if(!source||source.logicalSource!==value.path)fail('personal-workspace-evidence-incomplete')
      workspaces.push({id:data.id,key,source:value.path,destination:join(homePath,'recovered-workspaces',op.runtimeId,key)})
    }
  }finally{catalog.close()}
  for(const path of [runtimeHome,...workspaces.map(item=>item.destination),...(!op.documentReceiptOperationId?[join(homePath,'documents')]:[])]){
    const info=await lstat(path).catch((error:unknown)=>{if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return;throw error})
    if(info)fail('replacement-must-be-empty')
  }
  const sourceHash=createHash('sha256')
  for(const file of ['personal-files/manifest.json','personal-roots.json','personal.sqlite','personal-recovery.json'])
    for await(const bytes of createReadStream(join(drill.directory,file),{signal}))sourceHash.update(bytes)
  const sourceFilesDigest=sourceHash.digest('hex')
  const directory=root(cfg,op)
  await peerPrivateDirectory(dirname(directory));await peerPrivateDirectory(directory)
  const path=join(directory,'evidence.json'),prior=await readFile(path,'utf8').catch((error:unknown)=>{if(error instanceof Error&&'code' in error&&error.code==='ENOENT')return;throw error})
  if(prior!==undefined){
    const saved=await readPersonalRecoveryEvidence(cfg,op)
    if(saved.sourceFilesDigest!==sourceFilesDigest||saved.documentDigest!==proof.documentDigest||await personalCandidateDigest(saved.roots,limits,signal)!==saved.installedDigest)fail('personal-target-changed')
    return {filesDigest:saved.filesDigest,evidenceDigest:sha(prior),documentDigest:proof.documentDigest,oldSessionCount:saved.oldSessionIds.length,suspendedEnvironmentKeys:saved.suspendedEnvironmentKeys}
  }
  if((await lstat(base)).dev!==(await lstat(cfg.stateRoot)).dev)fail('personal-target-volume-mismatch')
  const candidate=join(directory,'candidate')
  await restorePeerPersonalFiles(binding,capture,drill.directory,candidate,limits,signal,drill.space)
  const {roots,suspendedEnvironmentKeys}=await preparePersonalCandidate(op,proof,candidate,{homePath,runtimeHome,workspaces},limits,signal)
  const installedDigest=await personalCandidateDigest(roots,limits,signal),filesDigest=installedDigest
  const retainedRecovery=proof.roots.roots.filter(row=>row.role==='recovery-private').map(row=>({key:row.key,sha256:row.expectedSha256!,path:join(candidate,'content',op.runtimeId,'recovery-private',row.key)}))
  const evidence=evidenceSchema.parse({version:1,operationId:op.id,organizationId:op.organizationId,accountId:op.accountId,runtimeId:op.runtimeId,sourceNode:op.sourceNode,targetNode:op.targetNode,
    pointId:op.pointId,pointDigest:op.digest,newEpoch:op.newEpoch,documentDigest:proof.documentDigest,filesDigest,sourceFilesDigest,homePath,runtimeHome,workspaces,oldSessionIds:proof.recovery.oldSessionIds,roots,installedDigest,retainedRecovery,suspendedEnvironmentKeys})
  const text=JSON.stringify(evidence)
  await writeFileAtomic(path,text,{mode:0o600})
  return {filesDigest,evidenceDigest:sha(text),documentDigest:proof.documentDigest,oldSessionCount:evidence.oldSessionIds.length,suspendedEnvironmentKeys}
}

/** Stable target launch paths after publication; old Session IDs never leave this local evidence file. */
export async function personalRecoveryLaunchPaths(cfg:Pick<GatewayConfig,'stateRoot'>,op:PeerPersonalRecoveryOperation){
  const saved=await readPersonalRecoveryEvidence(cfg,op)
  const cwd=saved.workspaces[0]?.destination??saved.homePath
  return {home:saved.runtimeHome,cwd,admin:false}
}
