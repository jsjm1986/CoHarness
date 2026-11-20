/** Direct-node recovery configuration requires current administrator and computer-use authority. */
import type { PoolClient } from 'pg'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { lockRecoveryTarget } from './peer-backup-governance.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

/** Retain local admission and computer permission until the scoped configuration transaction commits.
 * @param tx - caller-owned transaction. @param context - actual ingress node and organization.
 * @param actor - authenticated administrator public identifier.
 */
export async function lockGovernanceLocalAuthority(tx:PoolClient,context:PostgresRuntimeContext,actor:number):Promise<void>{
  await lockAdministrator(tx,context,actor)
  const entry=(await tx.query<{enabled:boolean}>(`SELECT t.enabled FROM harness.deployment_topology t
    JOIN harness.cluster_control c USING(organization_id) JOIN harness.compute_nodes n ON n.organization_id=t.organization_id AND n.id=$2
    WHERE t.organization_id=$1 AND c.mode='serving' AND n.status='active' AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q
      WHERE q.organization_id=t.organization_id AND q.node_id=n.id) FOR SHARE OF t,c,n`,[context.organizationId,context.nodeId])).rows[0]
  if(!entry)throw new PeerBackupError(409,'peer-backup/governance-local-node-not-admitted')
  const granted=await tx.query(`SELECT FROM harness.computer_use_permissions p JOIN harness.users u ON u.organization_id=p.organization_id AND u.id=p.user_id
    WHERE p.organization_id=$1 AND p.node_id=$2 AND u.public_id=$3 AND p.enabled FOR SHARE OF p`,[context.organizationId,context.nodeId,actor])
  if(granted.rowCount!==1)throw new PeerBackupError(403,'peer-backup/governance-local-computer-permission-required')
  if(entry.enabled)await lockRecoveryTarget(tx,context.organizationId,context.nodeId)
}
