/** Operator-attested physical isolation revokes the entire old computer before any restored writer can be published. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { PeerRecoveryOperation } from './peer-backup-takeover.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

const positiveGeneration = z.string().regex(/^[1-9]\d{0,18}$/u)
  .pipe(z.string().refine(value => BigInt(value)<=9223372036854775807n))

/** Strict browser input: current authority coordinates and a non-secret external evidence reference. */
export const isolationConfirmation = z.object({
  confirm: z.uuid(), policyRevision: z.number().int().positive().max(2147483647),
  sourceGeneration: positiveGeneration, sourceEpoch: positiveGeneration,
  sourceNodeId: z.uuid(), pointId: z.uuid(), evidenceReference: z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/u.test(value) && !/:\/\/[^/\s]*@/u.test(value),'Use a ticket or evidence reference without credentials.'),
  isolationMethod: z.enum(['power-off', 'network-isolation']), acknowledgeDataLoss: z.literal(true),
}).strict()

/** Commit an irreversible whole-node isolation against the current generation and writer placement.
 * @param tx - administrator-authorized transaction holding the current recovery policy.
 * @param op - immutable recovery coordinates read from governance.
 * @param actor - authenticated administrator's public identifier.
 * @param primaryNode - serving entry, which cannot isolate itself.
 * @param input - untrusted browser confirmation and non-secret evidence reference.
 */
export async function confirmDisasterIsolation(tx: PoolClient, op: PeerRecoveryOperation, actor: number,
  primaryNode: string, input: unknown): Promise<void> {
  const body = isolationConfirmation.parse(input)
  const deny = (): never => { throw new PeerBackupError(409, 'peer-backup/recovery-approval-changed') }
  if (op.sourceNode === primaryNode) throw new PeerBackupError(409, 'peer-backup/isolation-primary-forbidden')
  if (body.confirm !== op.id || body.sourceNodeId !== op.sourceNode || body.pointId !== op.pointId || body.sourceEpoch !== op.oldEpoch || body.policyRevision !== op.policyRevision) deny()
  const held = await tx.query(`SELECT FROM harness.project_recovery_operations r
    JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
    JOIN harness.project_content_placement b ON b.organization_id=r.organization_id AND b.project_id=r.project_id
    JOIN harness.compute_nodes n ON n.organization_id=r.organization_id AND n.id=r.source_node_id
    WHERE r.organization_id=$1 AND r.id=$2 AND r.recovery_mode='disaster' AND r.phase='prepared' AND r.target_verified_at IS NOT NULL
    AND (b.node_id,b.volume_id,b.writer_epoch)=(r.source_node_id,r.source_volume_id,r.source_epoch)
    AND i.assigned_node_id=r.source_node_id AND i.generation=$3 AND harness.recovery_policy_revision(r.id,r.policy_revision)=$4
    FOR UPDATE OF r,i,b,n NOWAIT`,[op.organizationId,op.id,body.sourceGeneration,body.policyRevision]).catch((error: unknown) => {
    if (error !== null && typeof error==='object' && 'code' in error && error.code==='55P03')
      throw new PeerBackupError(409,'peer-backup/recovery-contended')
    throw error
  })
  if (!held.rowCount) deny()
  await tx.query(`INSERT INTO harness.project_recovery_isolations(operation_id,organization_id,source_node_id,source_generation,source_epoch,point_id,policy_revision,method,evidence_reference,confirmed_by,acknowledge_data_loss)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,u.id,true FROM harness.users u WHERE u.organization_id=$2 AND u.public_id=$10`,
    [op.id,op.organizationId,op.sourceNode,body.sourceGeneration,op.oldEpoch,op.pointId,body.policyRevision,body.isolationMethod,body.evidenceReference,actor])
  await tx.query(`INSERT INTO harness.node_recovery_quarantines(organization_id,node_id,operation_id) VALUES($1,$2,$3)
    ON CONFLICT(organization_id,node_id) DO NOTHING`,[op.organizationId,op.sourceNode,op.id])
  await tx.query(`INSERT INTO harness.project_recovery_execution_holds(operation_id,organization_id,runtime_id) VALUES($1,$2,$3)`,[op.id,op.organizationId,op.runtimeId])
  // Observation is intentionally preserved: an operator attestation is not a supervisor stop receipt.
  await tx.query(`UPDATE harness.instances SET desired_state='stopped',runtime_token_hash=NULL,stop_reason='access-change',updated_at=clock_timestamp()
    WHERE organization_id=$1 AND assigned_node_id=$2`,[op.organizationId,op.sourceNode])
  await tx.query(`UPDATE harness.node_agents SET credential_hash=NULL,revoked_at=clock_timestamp(),connection_id=NULL,lease_expires_at=NULL,
    connection_epoch=connection_epoch+1,revision=revision+1 WHERE organization_id=$1 AND node_id=$2`,[op.organizationId,op.sourceNode])
  await tx.query(`UPDATE harness.node_agent_enrollments SET consumed_at=coalesce(consumed_at,clock_timestamp()) WHERE organization_id=$1 AND node_id=$2`,[op.organizationId,op.sourceNode])
  await tx.query(`UPDATE harness.compute_nodes SET status='offline' WHERE organization_id=$1 AND id=$2`,[op.organizationId,op.sourceNode])
  await tx.query(`SELECT harness.invalidate_access($1,jsonb_build_object('nodeId',$2::uuid))`,[op.organizationId,op.sourceNode])
  await tx.query(`UPDATE harness.project_recovery_operations SET phase='externally-fenced',retry_at=clock_timestamp(),last_error=NULL WHERE id=$1`,[op.id])
}
