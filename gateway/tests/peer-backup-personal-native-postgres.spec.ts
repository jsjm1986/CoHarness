/** Complete native personal evidence uses real persistence services without opening a Runtime. */
import { expect,it } from 'vitest'
import { createHash,randomUUID } from 'node:crypto'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { personalNativeFixture,type PersonalNativeFixture } from './peer-backup-personal-native-fixture.ts'
import { stagePersonalRecoveryFiles,readPersonalRecoveryEvidence,personalRecoveryLaunchPaths } from '../src/peer-backup-personal-stage.ts'
import { inspectPersonalSessions } from '../src/peer-backup-personal-sessions.ts'
import type { PeerPersonalRecoveryOperation } from '../src/peer-backup-personal-recovery.ts'
import type { PeerBackupDrill } from '../src/peer-backup-restic.ts'
import type { RuntimeId } from '../src/runtime-catalog.ts'
import { postgresTestDatabaseUrl } from './postgres-test-database.mjs'
const databaseUrl=postgresTestDatabaseUrl(process.env.HGW_TEST_DATABASE_URL)
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
async function input(f:PersonalNativeFixture){
  const pointId=randomUUID(),checkpoint=JSON.stringify({version:1,pointId,binding:f.binding,capture:f.captured})
  await writeFile(join(f.payload,'checkpoint.json'),checkpoint,{mode:0o600})
  const op:PeerPersonalRecoveryOperation={id:randomUUID(),organizationId:f.org,accountId:f.account,userId:f.userId,username:'owner',storageLayout:'legacy',runtimeId:f.runtime as RuntimeId,
    policyId:f.binding.policyId,policyRevision:1,pointId,repositoryNode:f.binding.targetNodeId,sourceNode:f.node,sourceGeneration:String(f.generation),oldEpoch:String(f.generation),targetNode:f.binding.targetNodeId,
    newEpoch:String(f.generation+1),sourceDocumentRoot:f.proof.documents.rootId,sourceVolume:f.volumeId,sourceDocumentEpoch:f.proof.documents.epoch,
    targetVolume:randomUUID(),targetDocumentEpoch:String(BigInt(f.proof.documents.epoch)+1n),revision:f.captured.watermark,digest:sha(checkpoint),phase:'preparing',
    filesDigest:null,evidenceDigest:null,documentDigest:null,documentReceiptOperationId:null,oldSessionCount:null,suspendedEnvironmentKeys:[],approvalActor:f.userId,activationActor:null}
  const drill:PeerBackupDrill={point:{...f.binding,version:1,pointId,writerEpoch:f.captured.writerEpoch,watermark:f.captured.watermark,capturedAt:f.captured.capturedAt,
    snapshotId:sha('native focused fixture'),manifestDigest:op.digest,coveredCount:f.captured.coveredCount,gapCount:0},directory:f.payload,checkedAt:f.captured.capturedAt,recoveryMs:0,dispose:async()=>{}}
  return {op,drill}
}
it.skipIf(databaseUrl===undefined||!process.env.HGW_TEST_NODE_CONTENT_PGDATA)('proves native personal points and privately stages original identities without overwriting another account',()=>personalNativeFixture(async f=>{
  const {op,drill}=await input(f)
  const cfg={stateRoot:join(f.root,'target-state'),usersRoot:join(f.root,'target-users')}
  await mkdir(cfg.stateRoot,{mode:0o700});await mkdir(cfg.usersRoot,{mode:0o700})
  const blocker=join(cfg.usersRoot,'owner','home','documents');await mkdir(blocker,{recursive:true,mode:0o700});await writeFile(join(blocker,'existing.txt'),'keep')
  await expect(stagePersonalRecoveryFiles(cfg,op,drill,f.limits,f.signal)).rejects.toMatchObject({code:'peer-backup/replacement-must-be-empty'})
  expect(await readFile(join(blocker,'existing.txt'),'utf8')).toBe('keep')
  const isolatedCfg={stateRoot:join(f.root,'replacement-state'),usersRoot:join(f.root,'replacement-users')}
  await mkdir(isolatedCfg.stateRoot,{mode:0o700});await mkdir(isolatedCfg.usersRoot,{mode:0o700})
  const proof=await stagePersonalRecoveryFiles(isolatedCfg,op,drill,f.limits,f.signal),prepared={...op,...proof}
  expect(proof.oldSessionCount).toBe(2)
  const evidence=await readPersonalRecoveryEvidence(isolatedCfg,prepared)
  expect(proof.suspendedEnvironmentKeys).toEqual(['DATABASE_URL','DSH_GATEWAY_CREDENTIAL_FD','HGW_DATABASE_URL','HGW_NODE_TOKEN','PGPASSWORD'])
  const stagedHome=evidence.roots.find(row=>row.role==='runtime')!.staged
  const targetEnvironment=await readFile(join(stagedHome,'.env'),'utf8')
  expect(targetEnvironment).not.toContain('retired-')
  expect(targetEnvironment).not.toContain('DSH_GATEWAY_CREDENTIAL_FD')
  expect(targetEnvironment).toContain('keep-business');expect(targetEnvironment).toContain('PGP_TEST')
  expect(await readFile(join(f.home,'.env'),'utf8')).toContain('retired-control')
  expect(await readFile(join(stagedHome,'profiles','web','node_modules','fixture-private-plugin','index.js'),'utf8')).toContain('retainedPrivatePlugin')
  expect(JSON.parse(await readFile(join(stagedHome,'profiles','web','node_modules','@deepseek-ai','dsh-model-governance','package.json'),'utf8')).name).toBe('@deepseek-ai/dsh-model-governance')
  expect(evidence.oldSessionIds).toEqual(['old-child','old-root'])
  expect(evidence.homePath).toBe(join(isolatedCfg.usersRoot,'owner','home'))
  expect(JSON.parse(await readFile(join(evidence.roots.find(row=>row.role==='runtime')!.staged,'storages','workspace.json'),'utf8')).tables.workspaces.work.path).toBe(evidence.workspaces[0]!.destination)
  expect(await stagePersonalRecoveryFiles(isolatedCfg,op,drill,f.limits,f.signal)).toEqual(proof)
  await expect(inspectPersonalSessions(join(f.home,'sessions'),f.limits,f.signal,process.platform==='win32'?'posix':'win32')).rejects.toMatchObject({code:'peer-backup/personal-session-platform-unsupported'})
  const corrupt=join(evidence.roots.find(row=>row.role==='runtime')!.staged,'sessions','corrupt-project','corrupt-session');await mkdir(corrupt,{recursive:true,mode:0o700});await writeFile(join(corrupt,'v7.jsonl'),'{}\n')
  await expect(inspectPersonalSessions(join(evidence.roots.find(row=>row.role==='runtime')!.staged,'sessions'),f.limits,f.signal)).rejects.toMatchObject({code:'peer-backup/personal-session-evidence-incomplete'})
  await expect(stagePersonalRecoveryFiles(isolatedCfg,op,drill,f.limits,f.signal)).rejects.toMatchObject({code:'peer-backup/personal-target-changed'})
}),60000)

it.skipIf(databaseUrl===undefined||!process.env.HGW_TEST_NODE_CONTENT_PGDATA)('stages a document-only personal Runtime without inventing an old workspace',()=>personalNativeFixture(async f=>{
  const {op,drill}=await input(f),cfg={stateRoot:join(f.root,'empty-state'),usersRoot:join(f.root,'empty-users')}
  await mkdir(cfg.stateRoot,{mode:0o700});await mkdir(cfg.usersRoot,{mode:0o700})
  const proof=await stagePersonalRecoveryFiles(cfg,op,drill,f.limits,f.signal),prepared={...op,...proof}
  const evidence=await readPersonalRecoveryEvidence(cfg,prepared)
  expect(proof.oldSessionCount).toBe(0)
  expect(evidence.workspaces).toEqual([])
  expect(await personalRecoveryLaunchPaths(cfg,prepared)).toEqual({home:evidence.runtimeHome,cwd:evidence.homePath,admin:false})
  expect(await readFile(join(evidence.roots.find(row=>row.role==='userdoc-public')!.staged,'document.txt'),'utf8')).toBe('important document\n')
  expect(JSON.parse(await readFile(join(evidence.roots.find(row=>row.role==='runtime')!.staged,'storages','workspace.json'),'utf8')).tables.workspaces).toEqual({})
},{emptyWorkspace:true}),60000)
