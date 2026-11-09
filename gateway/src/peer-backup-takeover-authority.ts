/** Lock the active replacement owner's existing device grant, organization membership and project access for a takeover commit. */
import type { PoolClient } from 'pg'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerRecoveryOperation } from './peer-backup-takeover.ts'

export async function lockRecoveryOwner(tx: PoolClient, op: Pick<PeerRecoveryOperation,'organizationId'|'projectId'|'targetNode'>): Promise<void> {
  const owner = (await tx.query<{id:string;role:string}>(`SELECT u.id,m.role FROM harness.projects p
    JOIN harness.users u ON u.organization_id=p.organization_id AND u.id=p.owner_user_id AND u.status='active' AND u.deleted_at IS NULL
    JOIN harness.organizations o ON o.id=p.organization_id AND o.status='active'
    JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
    JOIN harness.computer_use_permissions g ON g.organization_id=u.organization_id AND g.user_id=u.id AND g.node_id=$3 AND g.enabled
    WHERE p.organization_id=$1 AND p.id=$2 AND p.kind='standard' AND p.status='active' FOR SHARE OF p,u,m,o,g`,
  [op.organizationId,op.projectId,op.targetNode])).rows[0]
  if (!owner || owner.role !== 'admin' && !(await tx.query(`SELECT FROM harness.project_members WHERE organization_id=$1 AND project_id=$2
    AND user_id=$3 AND access_mode IN('rw','ro') FOR SHARE`,[op.organizationId,op.projectId,owner.id])).rowCount) {
    throw new PeerBackupError(409,'peer-backup/project-owner-unavailable')
  }
}

/** The policy row serializes security changes against a short local writer transition. */
export async function lockRecoveryPolicy(tx: PoolClient, op: PeerRecoveryOperation): Promise<void> {
  const result = await tx.query(`SELECT FROM harness.peer_backup_policies p JOIN harness.project_recovery_operations r
    ON r.policy_id=p.id AND r.organization_id=p.organization_id WHERE r.organization_id=$1 AND r.id=$2 AND p.enabled
    AND p.source_node_id=r.source_node_id AND p.target_node_id=r.target_node_id AND p.scope_kind='project' AND p.scope_id=r.project_id
    AND p.revision=harness.recovery_policy_revision(r.id,r.policy_revision) FOR SHARE OF p,r`,[op.organizationId,op.id])
  if (!result.rowCount) throw new PeerBackupError(409,'peer-backup/recovery-approval-changed')
  await lockRecoveryOwner(tx,op)
}
