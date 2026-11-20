/** Explicit replacement readers use independent credentials; encrypted repository identity remains immutable. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import type { Queryable } from './postgres/database.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

export const recoveryAccessInput = z.object({
  id: z.uuid(), expectedRevision: z.number().int().positive(), pointId: z.uuid(), recoveryNodeId: z.uuid(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: z.iso.datetime({ offset: true }),
}).strict()

/** Require the node's current credential generation and lease without inspecting source business files.
 * @param db - current governance reader. @param organization - exact tenant. @param node - approved replacement node.
 * @returns the revocable deployment and credential coordinates retained in a read approval.
 */
export async function recoveryReaderIdentity(db: Queryable, organization: string, node: string) {
  const row = (await db.query<{ topologyRevision:number; writeEpoch:string; connectionEpoch:string|null; credentialHash:Buffer|null }>(`
    SELECT t.revision "topologyRevision",c.write_epoch::text "writeEpoch",
      CASE WHEN t.primary_node_id=n.id THEN NULL ELSE a.connection_epoch::text END "connectionEpoch",
      CASE WHEN t.primary_node_id=n.id THEN NULL ELSE a.credential_hash END "credentialHash"
    FROM harness.organizations o JOIN harness.deployment_topology t ON t.organization_id=o.id
    JOIN harness.cluster_control c ON c.organization_id=o.id JOIN harness.compute_nodes n ON n.organization_id=o.id AND n.id=$2
    LEFT JOIN harness.node_agents a ON a.organization_id=o.id AND a.node_id=n.id
    WHERE o.id=$1 AND o.status='active' AND t.enabled AND c.mode='serving' AND n.status='active'
      AND NOT EXISTS(SELECT FROM harness.node_recovery_quarantines q WHERE q.organization_id=o.id AND q.node_id=n.id)
      AND (t.primary_node_id=n.id OR a.attachment_state='managed' AND a.revoked_at IS NULL AND a.credential_hash IS NOT NULL
        AND a.connection_id IS NOT NULL AND a.lease_expires_at>clock_timestamp())`, [organization,node])).rows[0]
  if (!row) throw new PeerBackupError(403,'peer-backup/node-not-admitted')
  return row
}

/** Advertise the installed recovery protocol only while this Gateway retains its actual node admission.
 * @param db - local Gateway governance connection. @param organization - exact tenant. @param node - this Gateway's identity.
 * @param ttlMs - bounded renewal period derived from its configured worker poll interval.
 * @param workers - actually assembled scope workers, independently from the encrypted repository receiver.
 */
export async function publishRecoveryProtocol(db:Queryable,organization:string,node:string,ttlMs:number,workers:{project:boolean;personal:boolean}):Promise<void>{
  const enabled=await db.query('SELECT FROM harness.deployment_topology WHERE organization_id=$1 AND enabled',[organization])
  if(!enabled.rowCount)return
  const identity=await recoveryReaderIdentity(db,organization,node)
  await db.query(`INSERT INTO harness.peer_recovery_node_protocols(organization_id,node_id,protocol,topology_revision,write_epoch,connection_epoch,node_credential_hash,expires_at,project_ready,personal_ready)
    VALUES($1,$2,2,$3,$4,$5,$6,clock_timestamp()+$7*interval '1 millisecond',$8,$9) ON CONFLICT(organization_id,node_id) DO UPDATE SET
    protocol=2,topology_revision=excluded.topology_revision,write_epoch=excluded.write_epoch,connection_epoch=excluded.connection_epoch,
    node_credential_hash=excluded.node_credential_hash,expires_at=excluded.expires_at,project_ready=excluded.project_ready,personal_ready=excluded.personal_ready`,
    [organization,node,identity.topologyRevision,identity.writeEpoch,identity.connectionEpoch,identity.credentialHash,ttlMs,workers.project,workers.personal])
}

/** Reject old or disconnected reader/receiver implementations before third-node recovery can be approved.
 * @param db - governance reader. @param organization - exact tenant. @param policy - selected repository. @param reader - replacement node.
 */
export async function assertRecoveryProtocol(db:Queryable,organization:string,policy:string,reader:string):Promise<void>{
  if(!(await db.query(`SELECT FROM harness.peer_backup_policies p WHERE p.organization_id=$1 AND p.id=$2
    AND harness.peer_recovery_destination_supported(p.organization_id,p.target_node_id)
    AND harness.peer_recovery_destination_supported(p.organization_id,$3)`,[organization,policy,reader])).rowCount)
    throw new PeerBackupError(409,'peer-backup/recovery-protocol-upgrade-required')
}

/** Require a publishing worker independently from permission to inspect ciphertext.
 * @param db - governance reader. @param organization - exact tenant. @param policy - selected scope. @param target - replacement writer.
 */
export async function assertRecoveryWorker(db:Queryable,organization:string,policy:string,target:string):Promise<void>{
  await assertRecoveryProtocol(db,organization,policy,target)
  if(!(await db.query(`SELECT FROM harness.peer_backup_policies p WHERE p.organization_id=$1 AND p.id=$2
    AND harness.peer_recovery_worker_supported(p.organization_id,$3,p.scope_kind)`,[organization,policy,target])).rowCount)
    throw new PeerBackupError(409,'peer-backup/recovery-worker-unavailable')
}

/** Check current account ownership and destination computer access before exposing a decrypted backup.
 * @param db - current governance reader. @param organization - exact tenant. @param policy - selected backup policy. @param node - replacement reader.
 */
export async function assertRecoveryReaderOwner(db: Queryable, organization:string, policy:string, node:string):Promise<void> {
  const managed=await db.query(`SELECT FROM harness.peer_backup_policies p JOIN harness.projects project
    ON project.organization_id=p.organization_id AND project.id=p.scope_id
    WHERE p.organization_id=$1 AND p.id=$2 AND p.enabled AND p.scope_kind='project' AND p.source_node_id<>$3
      AND project.kind='standard' AND project.status='active' AND project.origin='admin' AND project.owner_user_id IS NULL
    FOR SHARE OF p,project`,[organization,policy,node])
  if(managed.rowCount)return
  const row = await db.query(`SELECT FROM harness.peer_backup_policies p
    JOIN harness.users u ON u.organization_id=p.organization_id AND u.id=CASE WHEN p.scope_kind='project' THEN
      (SELECT owner_user_id FROM harness.projects project WHERE project.organization_id=p.organization_id AND project.id=p.scope_id AND project.status='active' AND project.kind='standard')
      ELSE (SELECT owner_id FROM harness.runtime_environments runtime WHERE runtime.organization_id=p.organization_id AND runtime.id=p.scope_id AND runtime.owner_kind='user' AND runtime.retired_at IS NULL) END
    JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id AND m.status='active'
    JOIN harness.computer_use_permissions g ON g.organization_id=u.organization_id AND g.user_id=u.id AND g.node_id=$3 AND g.enabled
    WHERE p.organization_id=$1 AND p.id=$2 AND p.enabled AND p.scope_kind IN('project','personal') AND p.source_node_id<>$3
      AND u.status='active' AND u.deleted_at IS NULL
      AND (p.scope_kind<>'project' OR EXISTS(SELECT FROM harness.projects project WHERE project.organization_id=p.organization_id
        AND project.id=p.scope_id AND project.owner_user_id=u.id AND project.kind='standard' AND project.status='active'
        AND (m.role='admin' OR EXISTS(SELECT FROM harness.project_members member WHERE member.organization_id=p.organization_id
          AND member.project_id=project.id AND member.user_id=u.id AND member.access_mode IN('rw','ro') FOR SHARE)) FOR SHARE))
      FOR SHARE OF p,u,m,g`, [organization,policy,node])
  if (!row.rowCount) throw new PeerBackupError(403,'peer-backup/recovery-reader-owner-unavailable')
}

/** Register a hash-only credential for one intended recovery, expiring within the bounded online approval window.
 * @param tx - administrator-owned transaction. @param organization - exact tenant. @param policy - selected backup policy.
 * @param actor - approving administrator public ID. @param raw - explicit credential fingerprint and destination.
 * @param maxLifetimeMs - configured backup operation timeout bounding this approval.
 * @returns the immutable approval identifier; repository passwords never enter this method.
 */
export async function approveRecoveryRead(tx:PoolClient, organization:string, policy:string, actor:number, raw:unknown, maxLifetimeMs:number):Promise<string> {
  const input=recoveryAccessInput.parse(raw)
  await assertRecoveryProtocol(tx,organization,policy,input.recoveryNodeId)
  const identity=await recoveryReaderIdentity(tx,organization,input.recoveryNodeId)
  await assertRecoveryReaderOwner(tx,organization,policy,input.recoveryNodeId)
  const result=await tx.query(`INSERT INTO harness.peer_backup_recovery_access(id,organization_id,policy_id,policy_revision,point_id,
    repository_node_id,reader_node_id,credential_hash,topology_revision,write_epoch,connection_epoch,node_credential_hash,expires_at,approved_by)
    SELECT $3,p.organization_id,p.id,p.revision,q.id,p.target_node_id,$4,$5,$6,$7,$8,$9,$10,u.id
    FROM harness.peer_backup_policies p JOIN harness.peer_backup_points q ON q.policy_id=p.id AND q.organization_id=p.organization_id
    JOIN harness.users u ON u.organization_id=p.organization_id AND u.public_id=$11
    WHERE p.organization_id=$1 AND p.id=$2 AND p.enabled AND p.revision=$12 AND q.id=$13 AND q.gap_count=0
      AND p.target_node_id<>$4 AND $5<>p.append_hash AND $5<>p.recovery_hash
      AND $10::timestamptz>clock_timestamp() AND $10::timestamptz<=clock_timestamp()+$14*interval '1 millisecond'
    ON CONFLICT DO NOTHING RETURNING id`,[organization,policy,input.id,input.recoveryNodeId,input.fingerprint,
    identity.topologyRevision,identity.writeEpoch,identity.connectionEpoch,identity.credentialHash,input.expiresAt,actor,input.expectedRevision,input.pointId,maxLifetimeMs])
  if (!result.rowCount && !(await tx.query(`SELECT FROM harness.peer_backup_recovery_access a
    JOIN harness.peer_backup_policies p ON p.organization_id=a.organization_id AND p.id=a.policy_id
    WHERE a.id=$1 AND a.organization_id=$2 AND a.policy_id=$3 AND a.policy_revision=$4 AND a.point_id=$5
      AND a.reader_node_id=$6 AND a.credential_hash=$7 AND a.expires_at=$8::timestamptz
      AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp() AND p.enabled AND p.revision=a.policy_revision
      AND p.target_node_id=a.repository_node_id AND a.topology_revision=$9 AND a.write_epoch=$10
      AND a.connection_epoch IS NOT DISTINCT FROM $11::bigint AND a.node_credential_hash IS NOT DISTINCT FROM $12::bytea
    FOR SHARE OF a,p`,[input.id,organization,policy,input.expectedRevision,input.pointId,input.recoveryNodeId,input.fingerprint,input.expiresAt,
    identity.topologyRevision,identity.writeEpoch,identity.connectionEpoch,identity.credentialHash])).rowCount)
    throw new PeerBackupError(409,'peer-backup/recovery-access-changed')
  return input.id
}

/** Match an explicit reader credential and revalidate its lease, owner permission and original approval generation.
 * @param db - governance reader. @param organization - exact tenant. @param policy - selected policy.
 * @param node - credential's replacement node. @param fingerprint - SHA-256 of the supplied dedicated token; omission checks whether an approved reader is available.
 * @param point - exact recovery point, omitted only while admitting repository object reads.
 * @returns the admitted approval, whose point restricts recovery operations but not shared repository ciphertext.
 */
export async function admittedRecoveryRead(db:Queryable,organization:string,policy:string,node:string,fingerprint?:string,point?:string) {
  await assertRecoveryProtocol(db,organization,policy,node)
  const identity=await recoveryReaderIdentity(db,organization,node)
  await assertRecoveryReaderOwner(db,organization,policy,node)
  const row=(await db.query<{id:string;pointId:string;revision:number}>(`SELECT a.id,a.point_id "pointId",a.policy_revision revision
    FROM harness.peer_backup_recovery_access a JOIN harness.peer_backup_policies p ON p.id=a.policy_id AND p.organization_id=a.organization_id
    WHERE a.organization_id=$1 AND a.policy_id=$2 AND a.reader_node_id=$3 AND ($4::text IS NULL OR a.credential_hash=$4)
      AND ($5::uuid IS NULL OR a.point_id=$5) AND a.revoked_at IS NULL AND a.expires_at>clock_timestamp()
      AND p.enabled AND p.revision=a.policy_revision AND p.target_node_id=a.repository_node_id
      AND a.topology_revision=$6 AND a.write_epoch=$7 AND a.connection_epoch IS NOT DISTINCT FROM $8::bigint
      AND a.node_credential_hash IS NOT DISTINCT FROM $9::bytea ORDER BY a.created_at DESC LIMIT 1 FOR SHARE OF a,p`,
    [organization,policy,node,fingerprint??null,point??null,identity.topologyRevision,identity.writeEpoch,identity.connectionEpoch,identity.credentialHash])).rows[0]
  if (!row) throw new PeerBackupError(403,'peer-backup/recovery-access-required')
  return row
}
