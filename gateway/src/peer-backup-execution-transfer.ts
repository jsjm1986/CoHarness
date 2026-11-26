/** Planned moves carry the original read-only Session set without inheriting execution approval. */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { readRecoveryExecutionPolicy } from './peer-backup-execution-data.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerRecoveryOperation } from './peer-backup-takeover.ts'

/** Immutable source review whose frozen Session identifiers remain private to the data owners. */
export interface RecoveryExecutionTransfer {
  operationId: string
  reviewId: string
  sha256: string
  oldSessionCount: number
}
function missing(): never { throw new PeerBackupError(409,'peer-backup/execution-policy-missing') }

/** Bind the first review at the current source epoch before staging; no new hold affects the source Runtime.
 * @param tx - current administrator transaction. @param organization - authenticated organization. @param id - new planned operation.
 */
export async function bindRecoveryExecutionTransfer(tx: PoolClient, organization: string, id: string): Promise<void> {
  const next=(await tx.query<{runtimeId:string;sourceNode:string}>(`SELECT runtime_id "runtimeId",source_node_id "sourceNode"
    FROM harness.project_recovery_operations WHERE organization_id=$1 AND id=$2`,[organization,id])).rows[0]
  if(!next)throw new PeerBackupError(409,'peer-backup/execution-policy-migration-required')
  const protocol=(await tx.query<{available:boolean}>(`SELECT to_regprocedure('harness.governance_rebuild_execution_route(uuid,uuid,uuid)') IS NOT NULL available`)).rows[0]!
  if(protocol.available){
    const route=(await tx.query<{route:string}>('SELECT harness.governance_rebuild_execution_route($1,$2,$3) route',
      [organization,next.runtimeId,next.sourceNode])).rows[0]!.route
    if(route==='blocked')throw new PeerBackupError(409,'peer-backup/execution-policy-migration-required')
    if(route==='governance'){
      const review=(await tx.query<{id:string}>(`SELECT review.id FROM harness.governance_rebuild_operations operation
        JOIN harness.governance_rebuild_runtimes r ON r.operation_id=operation.id AND r.runtime_id=$2
        JOIN harness.governance_rebuild_execution_requests request ON request.operation_id=r.id AND request.status='ready'
        JOIN harness.governance_rebuild_execution_reviews review ON review.id=request.review_id AND review.operation_id=r.id
        JOIN harness.governance_rebuild_execution_approvals approval ON approval.review_id=review.id
        WHERE operation.organization_id=$1 AND operation.state='released' AND r.node_id=$3
          AND operation.recovery_epoch=(SELECT max(recovery_epoch) FROM harness.governance_rebuild_operations WHERE organization_id=$1)
          AND harness.governance_rebuild_execution_allowed($1,$2,$3)
        FOR SHARE OF operation,r,request,review,approval`,[organization,next.runtimeId,next.sourceNode])).rows[0]
      if(!review)throw new PeerBackupError(409,'peer-backup/execution-policy-migration-required')
      await tx.query(`INSERT INTO harness.project_recovery_execution_transfers(operation_id,organization_id,runtime_id,source_governance_review_id)
        VALUES($1,$2,$3,$4)`,[id,organization,next.runtimeId,review.id])
      return
    }
  }
  const source = (await tx.query<{operationId:string;reviewId:string|null}>(`SELECT prior.id "operationId",first.id "reviewId"
    FROM harness.project_recovery_operations next JOIN harness.project_content_placement b
      ON b.organization_id=next.organization_id AND b.project_id=next.project_id
    JOIN harness.instances i ON i.organization_id=next.organization_id AND i.runtime_id=next.runtime_id
    JOIN harness.project_recovery_operations prior ON prior.organization_id=next.organization_id AND prior.runtime_id=next.runtime_id
      AND prior.target_node_id=next.source_node_id AND prior.target_volume_id=next.source_volume_id AND prior.target_epoch=next.source_epoch
    JOIN harness.project_recovery_execution_holds hold ON hold.operation_id=prior.id
    LEFT JOIN LATERAL(SELECT review.id FROM harness.project_recovery_execution_reviews review
      WHERE review.operation_id=prior.id ORDER BY review.created_at,review.id LIMIT 1) first ON true
    WHERE next.organization_id=$1 AND next.id=$2 AND next.recovery_mode='planned' AND prior.phase='published'
      AND prior.target_activated_at IS NOT NULL AND i.assigned_node_id=next.source_node_id
      AND (b.runtime_id,b.node_id,b.volume_id,b.writer_epoch)=(next.runtime_id,next.source_node_id,next.source_volume_id,next.source_epoch)
    FOR SHARE OF prior,b,i`,[organization,id])).rows[0]
  if (!source) {
    if ((await tx.query(`SELECT FROM harness.project_recovery_execution_holds h JOIN harness.project_recovery_operations r
      ON r.organization_id=h.organization_id AND r.runtime_id=h.runtime_id WHERE r.organization_id=$1 AND r.id=$2`,[organization,id])).rowCount)
      throw new PeerBackupError(409,'peer-backup/execution-policy-migration-required')
    return
  }
  if (!source.reviewId) throw new PeerBackupError(409,'peer-backup/execution-policy-migration-required')
  await tx.query(`INSERT INTO harness.project_recovery_execution_transfers(operation_id,organization_id,runtime_id,source_review_id)
    SELECT id,organization_id,runtime_id,$3 FROM harness.project_recovery_operations WHERE organization_id=$1 AND id=$2`,[organization,id,source.reviewId])
}

/** Resolve the target-owned transfer input inside the already reserved Runtime data directory.
 * @param home - exact target Runtime home. @param id - approved replacement operation.
 * @returns a private file covered by the target file witness and subsequent Runtime-data snapshots.
 */
export function recoveryExecutionTransferFile(home: string, id: string): string {
  return join(home,'storages','gateway-recovery-transfers',id+'.json')
}

function sessions(text: string, op: PeerRecoveryOperation, maxRows: number): string[] {
  const evidence=op.executionTransfer
  if (!evidence || createHash('sha256').update(text).digest('hex')!==evidence.sha256) missing()
  const policy=z.object({version:z.literal(1),mode:z.literal('new-conversations-only'),operationId:z.uuid(),pointId:z.uuid(),
    runtimeId:z.uuid(),nodeId:z.uuid(),writerEpoch:z.string(),reviewRevision:z.uuid(),oldSessionIds:z.array(z.string().min(1)).max(maxRows)}).parse(JSON.parse(text))
  if(policy.operationId!==evidence.operationId || policy.reviewRevision!==evidence.reviewId || policy.runtimeId!==op.runtimeId ||
    policy.nodeId!==op.sourceNode || policy.writerEpoch!==op.oldEpoch || policy.oldSessionIds.length!==evidence.oldSessionCount ||
    new Set(policy.oldSessionIds).size!==policy.oldSessionIds.length) missing()
  return policy.oldSessionIds
}

/** Copy the exact frozen source review from the authenticated encrypted point before source retirement.
 * @param op - planned replacement and immutable review receipt. @param payload - decrypted, verified project payload.
 * @param home - newly reserved target Runtime home. @param limits - bounded private policy allowance.
 */
export async function stageRecoveryExecutionTransfer(op: PeerRecoveryOperation, payload: string, home: string,
  limits: {maxBytes:number;maxRows:number}): Promise<void> {
  if(!op.executionTransfer) return
  if(op.recoveryMode!=='planned') missing()
  const text=await readRecoveryExecutionPolicy(join(payload,'recovery-execution',op.executionTransfer.reviewId+'.json'),limits.maxBytes)
  sessions(text,op,limits.maxRows)
  const directory=join(home,'storages','gateway-recovery-transfers')
  await mkdir(directory,{recursive:true,mode:0o700})
  await writeFile(recoveryExecutionTransferFile(home,op.id),text,{flag:'wx',mode:0o600,flush:true})
}

/** Read only the carried frozen set; source plugin, connection and Runtime approvals are never reused.
 * @param op - exact planned target coordinates. @param home - target Runtime home. @param limits - bounded private policy allowance.
 * @returns the original disaster-frozen Session identifiers, excluding later ordinary conversations.
 */
export async function transferredRecoverySessions(op: PeerRecoveryOperation, home: string,
  limits:{maxBytes:number;maxRows:number}):Promise<string[]> {
  return sessions(await readRecoveryExecutionPolicy(recoveryExecutionTransferFile(home,op.id),limits.maxBytes),op,limits.maxRows)
}

/** Prove that the receiving worker read the exact transferred policy before source retirement is eligible.
 * @param op - immutable planned move and source-review coordinates. @param home - reserved destination Runtime home.
 * @param limits - private file parsing budget.
 * @returns the verified policy digest, or null for a move with no frozen-history transfer.
 */
export async function verifyRecoveryExecutionTransfer(op:PeerRecoveryOperation,home:string,limits:{maxBytes:number;maxRows:number}):Promise<string|null>{
  if(!op.executionTransfer)return null
  await transferredRecoverySessions(op,home,limits)
  return op.executionTransfer.sha256
}
