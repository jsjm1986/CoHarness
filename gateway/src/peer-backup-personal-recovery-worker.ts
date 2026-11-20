/** Node-owned personal staging and publication run under one account file lock without stopping any Runtime. */
import type { PeerBackupDrill } from './peer-backup-restic.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import { checkPeerBackupNode } from './peer-backup-governance.ts'
import { transaction } from './postgres/database.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import type { PeerPersonalRecovery, PeerPersonalRecoveryOperation } from './peer-backup-personal-recovery.ts'

/** Target-owned file verification; callers cannot supply paths or digest claims through HTTP. */
export interface PersonalRecoveryFiles {
  stage(op:PeerPersonalRecoveryOperation,drill:PeerBackupDrill,signal:AbortSignal):Promise<{
    filesDigest:string;evidenceDigest:string;documentDigest:string;oldSessionCount:number}>
  activate(op:PeerPersonalRecoveryOperation,drill:PeerBackupDrill,signal:AbortSignal):Promise<{
    homePath:string;filesDigest:string;evidenceDigest:string;documentDigest:string}>
}

/** Existing peer engine and exact account lock for one data owner's background worker. */
export interface PersonalRecoveryWorker {
  service:PeerPersonalRecovery
  files:PersonalRecoveryFiles
  gate:PeerProjectFileGate
  drill(op:PeerPersonalRecoveryOperation,signal:AbortSignal):Promise<PeerBackupDrill>
}

/** Advance one admitted personal target phase and persist failures without reopening the old computer.
 * @param deps - owning node, independently verified point reader and physical file operator.
 * @param signal - the node service lifetime.
 */
export async function runPersonalRecoveryPhase(deps:PersonalRecoveryWorker,signal:AbortSignal):Promise<void>{
  const context=deps.service.context
  const row=(await context.pool.query<{id:string}>(`SELECT r.id FROM harness.personal_recovery_operations r JOIN harness.peer_backup_policies p
    ON p.id=r.policy_id AND p.organization_id=r.organization_id WHERE r.organization_id=$1 AND r.target_node_id=$2
      AND r.phase IN('preparing','activating') AND r.retry_at<=clock_timestamp() AND p.enabled
      AND p.revision=harness.personal_recovery_policy_revision(r.id,r.policy_revision) ORDER BY r.retry_at,r.created_at LIMIT 1`,
  [context.organizationId,context.nodeId])).rows[0]
  if(!row)return
  const op=await deps.service.get(row.id)
  try{
    await deps.gate.exclusive(op.userId,async()=>{
      const current=await deps.service.get(op.id)
      if(current.phase!==op.phase)return
      await transaction(context.pool,async tx=>{
        await lockAdministrator(tx,context,current.phase==='activating'?current.activationActor!:current.approvalActor)
        await deps.service.lockPolicy(tx,current)
        await checkPeerBackupNode(tx,current.organizationId,current.targetNode,true)
      },signal)
      const drill=await deps.drill(current,signal)
      try{
        if(current.phase==='preparing')await deps.service.confirmTarget(current.id,await deps.files.stage(current,drill,signal))
        else if(current.phase==='activating')await deps.service.publish(current.id,await deps.files.activate(current,drill,signal))
      }finally{await drill.dispose()}
    })
  }catch(error){
    if(signal.aborted)throw error
    if(error instanceof PeerBackupError&&error.code==='peer-backup/project-files-busy')return
    const code=error instanceof PeerBackupError?error.code:'peer-backup/personal-recovery-unavailable'
    await context.pool.query(`UPDATE harness.personal_recovery_operations SET retry_at=clock_timestamp()+interval '1 minute',last_error=$3
      WHERE organization_id=$1 AND id=$2 AND phase=$4`,[context.organizationId,op.id,code,op.phase])
    if(!(error instanceof PeerBackupError))console.error('[gateway] personal recovery phase failed:',error)
  }
}
