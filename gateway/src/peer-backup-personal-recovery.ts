/** Explicit personal replacement preserves account, Runtime and shared-document identities without starting old work. */
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { admittedRecoveryRead,assertRecoveryWorker } from './peer-backup-recovery-access.ts'
import { checkPeerBackupNode,disableReplacedPeerSource,lockRecoveryTarget } from './peer-backup-governance.ts'
import { isolationConfirmation } from './peer-backup-disaster.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { allocateInstancePorts } from './postgres/port-allocation.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import type { PersonalRuntimeStorageLayout } from './runtime-layout.ts'

/** Immutable coordinates; local paths and frozen Session identities stay on the selected target. */
export interface PeerPersonalRecoveryOperation {
  id: string
  organizationId: string
  accountId: string
  userId: number
  username: string
  storageLayout: PersonalRuntimeStorageLayout
  runtimeId: RuntimeId
  policyId: string
  policyRevision: number
  pointId: string
  sourceNode: string
  repositoryNode: string
  sourceGeneration: string
  oldEpoch: string
  targetNode: string
  newEpoch: string
  sourceDocumentRoot: string
  sourceVolume: string
  sourceDocumentEpoch: string
  targetVolume: string
  targetDocumentEpoch: string
  revision: string
  digest: string
  phase: 'preparing' | 'prepared' | 'externally-fenced' | 'activating' | 'switching' | 'published' | 'cancelled'
  filesDigest: string | null
  evidenceDigest: string | null
  documentDigest: string | null
  documentReceiptOperationId: string | null
  oldSessionCount: number | null
  suspendedEnvironmentKeys: string[]
  approvalActor: number
  activationActor: number | null
}

const projection = `r.id,r.organization_id "organizationId",r.user_id "accountId",u.public_id::float8 "userId",u.username::text username,
  e.storage_layout "storageLayout",r.runtime_id "runtimeId",r.policy_id "policyId",harness.personal_recovery_policy_revision(r.id,r.policy_revision) "policyRevision",r.point_id "pointId",
  r.repository_node_id "repositoryNode",r.source_node_id "sourceNode",r.source_generation::text "sourceGeneration",r.source_epoch::text "oldEpoch",
  r.target_node_id "targetNode",r.target_epoch::text "newEpoch",r.source_document_root "sourceDocumentRoot",
  r.source_volume_id "sourceVolume",r.source_document_epoch::text "sourceDocumentEpoch",r.target_volume_id "targetVolume",
  r.target_document_epoch::text "targetDocumentEpoch",r.point_revision::text revision,r.manifest_digest digest,r.phase,
  r.suspended_environment_keys "suspendedEnvironmentKeys",r.target_files_digest "filesDigest",r.target_evidence_digest "evidenceDigest",r.target_document_digest "documentDigest",r.document_receipt_operation_id "documentReceiptOperationId",r.old_session_count::float8 "oldSessionCount",
  coalesce((SELECT account.public_id::float8 FROM harness.personal_recovery_policy_approvals continued JOIN harness.users account
    ON account.id=continued.approved_by AND account.organization_id=continued.organization_id WHERE continued.operation_id=r.id ORDER BY continued.policy_revision DESC LIMIT 1),approver.public_id::float8) "approvalActor",
  coalesce((SELECT account.public_id::float8 FROM harness.personal_recovery_policy_approvals continued JOIN harness.users account
    ON account.id=continued.approved_by AND account.organization_id=continued.organization_id WHERE continued.operation_id=r.id AND continued.phase='activating'
    ORDER BY continued.policy_revision DESC LIMIT 1),activator.public_id::float8) "activationActor"`
const joins = `FROM harness.personal_recovery_operations r JOIN harness.users u ON u.id=r.user_id AND u.organization_id=r.organization_id
  JOIN harness.runtime_environments e ON e.id=r.runtime_id AND e.organization_id=r.organization_id
  JOIN harness.users approver ON approver.id=r.approved_by AND approver.organization_id=r.organization_id
  LEFT JOIN harness.users activator ON activator.id=r.activation_approved_by AND activator.organization_id=r.organization_id`
const fail = (code: string): never => { throw new PeerBackupError(409, 'peer-backup/' + code) }
const digest = z.string().regex(/^[a-f0-9]{64}$/u)
const targetProof = z.object({ filesDigest: digest, evidenceDigest: digest, documentDigest: digest, oldSessionCount: z.number().int().nonnegative(),
  suspendedEnvironmentKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/u)).max(128).default([]) }).strict()

/** Keep target-account access and shared allocation quotas current until the personal writer transition commits.
   * @param tx - caller-owned authority transaction. @param op - exact account, target and Runtime allocation.
   */
export async function lockPersonalRecoveryOwner(tx: PoolClient, op: PeerPersonalRecoveryOperation): Promise<void> {
  const owner = (await tx.query(`SELECT FROM harness.users u JOIN harness.memberships m ON m.organization_id=u.organization_id AND m.user_id=u.id
    JOIN harness.organizations o ON o.id=u.organization_id
    JOIN harness.computer_use_permissions g ON g.organization_id=u.organization_id AND g.user_id=u.id AND g.node_id=$3
    WHERE u.organization_id=$1 AND u.id=$2 AND u.status='active' AND u.deleted_at IS NULL AND m.status='active' AND o.status='active' AND g.enabled
    FOR SHARE OF u,m,o,g`, [op.organizationId, op.accountId, op.targetNode])).rowCount
  if (!owner) fail('personal-owner-unavailable')
  const policies = (await tx.query<{user_id:string|null;max_total:number;max_per_node:number;override_enabled:boolean}>(`SELECT user_id,max_total,max_per_node,override_enabled
    FROM harness.runtime_allocation_policies WHERE organization_id=$1 AND (user_id IS NULL OR user_id=$2) FOR SHARE`,
  [op.organizationId, op.accountId])).rows
  const policy = policies.find(row => row.user_id === op.accountId && row.override_enabled) ?? policies.find(row => row.user_id === null)
  const count = (await tx.query<{total:number;local:number}>(`SELECT count(*)::integer total,
    count(*) FILTER(WHERE assigned_node_id=$3 AND runtime_id<>$4)::integer local FROM harness.instances WHERE organization_id=$1 AND user_id=$2`,
  [op.organizationId, op.accountId, op.targetNode, op.runtimeId])).rows[0]!
  if (!policy || count.total > policy.max_total || count.local >= policy.max_per_node) fail('personal-quota-exceeded')
  if (op.phase !== 'published' && (await tx.query(`SELECT FROM harness.instances WHERE organization_id=$1 AND user_id=$2
    AND assigned_node_id=$3 AND runtime_id<>$4 AND (desired_state<>'stopped' OR observed_state<>'stopped' OR runtime_token_hash IS NOT NULL)
    FOR SHARE`, [op.organizationId, op.accountId, op.targetNode, op.runtimeId])).rowCount) fail('personal-target-busy')
}

/** Governance-only actions never read restored content and never stop or wake any Runtime. */
export class PeerPersonalRecovery {
  constructor(readonly context: PostgresRuntimeContext, private readonly portBase?: number) {}

  private async admin<T>(actor: number, work: (tx: PoolClient) => Promise<T>, targetNode?: string): Promise<T> {
    return transaction(this.context.pool, async tx => {
      if (targetNode) await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gateway-port:' + targetNode])
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gateway-admin:' + this.context.organizationId])
      await lockAdministrator(tx, this.context, actor)
      const entry = await tx.query(`SELECT FROM harness.deployment_topology t JOIN harness.cluster_control c USING(organization_id)
        WHERE t.organization_id=$1 AND t.primary_node_id=$2 AND t.enabled AND c.mode='serving' FOR SHARE OF t,c`,
      [this.context.organizationId, this.context.nodeId])
      if (!entry.rowCount) fail('primary-required')
      return work(tx)
    })
  }

  /** Read immutable coordinates without consulting either computer's files.
   * @param id - organization-scoped recovery UUID. @returns immutable coordinates and current progress.
   */
  async get(id: string): Promise<PeerPersonalRecoveryOperation> {
    z.uuid().parse(id)
    const row = (await this.context.pool.query<PeerPersonalRecoveryOperation>(`SELECT ${projection} ${joins}
      WHERE r.organization_id=$1 AND r.id=$2`, [this.context.organizationId, id])).rows[0]
    return row ?? fail('recovery-not-found')
  }

  /** Offer designated target volumes and bounded previous requests; point completeness is independently checked on the target.
   * @param actor - current administrator public ID. @param policyId - approved personal backup policy. @returns registered destinations and bounded previous attempts.
   */
  async choices(actor: number, policyId: string) {
    z.uuid().parse(policyId)
    return this.admin(actor, async tx => {
      const targets = (await tx.query<{nodeId:string;volumeId:string}>(`SELECT v.node_id "nodeId",v.volume_id "volumeId"
        FROM harness.peer_backup_policies p JOIN harness.node_content_volumes v ON v.organization_id=p.organization_id AND v.node_id<>p.source_node_id
        JOIN harness.runtime_environments runtime ON runtime.organization_id=p.organization_id AND runtime.id=p.scope_id AND runtime.owner_kind='user' AND runtime.retired_at IS NULL
        JOIN harness.users owner ON owner.id=runtime.owner_id AND owner.organization_id=p.organization_id AND owner.status='active' AND owner.deleted_at IS NULL
        JOIN harness.computer_use_permissions g ON g.organization_id=p.organization_id AND g.user_id=owner.id AND g.node_id=v.node_id AND g.enabled
        JOIN harness.compute_nodes node ON node.organization_id=p.organization_id AND node.id=v.node_id AND node.status='active'
        WHERE p.organization_id=$1 AND p.id=$2 AND p.scope_kind='personal' AND p.enabled AND harness.peer_recovery_worker_supported(p.organization_id,v.node_id,'personal') AND harness.peer_recovery_destination_supported(p.organization_id,p.target_node_id)`, [this.context.organizationId, policyId])).rows
      const attempts = (await tx.query(`SELECT id FROM harness.personal_recovery_operations WHERE organization_id=$1 AND policy_id=$2
        ORDER BY created_at DESC LIMIT 10`, [this.context.organizationId, policyId])).rows
      const repository=(await tx.query<{repositoryNodeId:string}>('SELECT target_node_id "repositoryNodeId" FROM harness.peer_backup_policies WHERE organization_id=$1 AND id=$2',[this.context.organizationId,policyId])).rows[0]
      return { repositoryNodeId:repository?.repositoryNodeId, targets, attempts: await Promise.all(attempts.map(row => this.statusQuery(tx, String(row.id)))) }
    })
  }

  /** Return management progress with no personal titles, paths or Session identifiers.
   * @param actor - current administrator public ID. @param id - exact recovery UUID. @returns sanitized status and required confirmations.
   */
  async status(actor: number, id: string) {
    return this.admin(actor, tx => this.statusQuery(tx, id))
  }

  private async statusQuery(tx: PoolClient, id: string) {
      const row = (await tx.query(`SELECT r.id,'personal' AS "scopeKind",'disaster' AS "recoveryMode",u.public_id::float8 "userId",
        r.runtime_id "runtimeId",r.repository_node_id "repositoryNodeId",r.source_node_id "sourceNodeId",r.target_node_id "targetNodeId",r.point_id "pointId",
        r.source_generation::text "sourceGeneration",r.source_epoch::text "sourceEpoch",r.target_epoch::text "targetEpoch",
        harness.personal_recovery_policy_revision(r.id,r.policy_revision) "policyRevision",p.revision "currentPolicyRevision",p.enabled "policyEnabled",r.phase,
        CASE WHEN r.phase<>'cancelled' AND r.target_activated_at IS NULL AND NOT harness.peer_recovery_worker_supported(r.organization_id,r.target_node_id,'personal')
          THEN 'peer-backup/recovery-worker-unavailable' ELSE r.last_error END "lastError",
        r.target_activated_at "targetActivatedAt",r.old_session_count::float8 "oldSessionCount",r.suspended_environment_keys "suspendedEnvironmentKeys",
        r.phase='published' "executionReviewRequired",r.phase IN('prepared','externally-fenced','activating','published') "schedulesSuspended",
        r.phase NOT IN('published','cancelled') AND (p.revision<>harness.personal_recovery_policy_revision(r.id,r.policy_revision) OR NOT p.enabled) AS "reapprovalRequired",false AS "cleanupPending",
        (SELECT json_build_object('method',a.method,'evidenceReference',a.evidence_reference,'confirmedAt',a.confirmed_at)
          FROM harness.recovery_source_isolations a WHERE a.operation_id=r.id) isolation
        FROM harness.personal_recovery_operations r JOIN harness.users u ON u.id=r.user_id AND u.organization_id=r.organization_id
        JOIN harness.peer_backup_policies p ON p.id=r.policy_id AND p.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.id=$2`, [this.context.organizationId, id])).rows[0]
      return row ?? fail('recovery-not-found')
  }

  /** Reserve one recovery intent; target validation must complete before physical isolation can be approved.
   * @param actor - current administrator public ID. @param input - exact request, point, policy and destination identities. @returns the reserved operation UUID.
   */
  async request(actor: number, input: {requestId:string;policyId:string;pointId:string;targetNode:string;targetVolume:string}): Promise<string> {
    for (const id of Object.values(input)) z.uuid().parse(id)
    return this.admin(actor, async tx => {
      await lockRecoveryTarget(tx, this.context.organizationId, input.targetNode)
      await assertRecoveryWorker(tx,this.context.organizationId,input.policyId,input.targetNode)
      const policy=(await tx.query<{target_node_id:string}>('SELECT target_node_id FROM harness.peer_backup_policies WHERE organization_id=$1 AND id=$2',[this.context.organizationId,input.policyId])).rows[0]
      if(policy && policy.target_node_id!==input.targetNode)await admittedRecoveryRead(tx,this.context.organizationId,input.policyId,input.targetNode,undefined,input.pointId)
      const prior = (await tx.query<{id:string}>(`SELECT id FROM harness.personal_recovery_operations WHERE organization_id=$1 AND id=$2
        AND policy_id=$3 AND point_id=$4 AND target_node_id=$5 AND target_volume_id=$6`,
      [this.context.organizationId,input.requestId,input.policyId,input.pointId,input.targetNode,input.targetVolume])).rows[0]
      if (prior) return prior.id
      await tx.query('SELECT FROM harness.peer_backup_policies WHERE organization_id=$1 AND id=$2 FOR SHARE',
        [this.context.organizationId,input.policyId])
      const insert = await tx.query(`INSERT INTO harness.personal_recovery_operations(id,organization_id,user_id,runtime_id,policy_id,policy_revision,
        point_id,approved_by,source_node_id,source_generation,source_epoch,target_node_id,target_epoch,source_document_root,source_volume_id,
        source_document_epoch,target_volume_id,target_document_epoch,manifest_digest,point_revision,document_receipt_operation_id)
        SELECT $3,p.organization_id,e.owner_id,e.id,p.id,p.revision,q.id,u.id,e.node_id,i.generation,q.writer_epoch,$6,i.generation+1,
          d.root_id,d.volume_id,d.writer_epoch,$7,d.writer_epoch+1,q.manifest_digest,q.watermark,d.receipt
        FROM harness.peer_backup_policies p JOIN harness.peer_backup_points q ON q.policy_id=p.id AND q.organization_id=p.organization_id
        JOIN harness.runtime_environments e ON e.organization_id=p.organization_id AND e.id=p.scope_id AND e.node_id=p.source_node_id
        JOIN harness.instances i ON i.organization_id=e.organization_id AND i.runtime_id=e.id AND i.user_id=e.owner_id AND i.assigned_node_id=e.node_id
        JOIN harness.personal_directory_placement directory ON (directory.organization_id,directory.runtime_id,directory.owner_id,directory.node_id)=(e.organization_id,e.id,e.owner_id,e.node_id)
        JOIN LATERAL (
          SELECT root_id,volume_id,writer_epoch,NULL::uuid receipt FROM harness.document_scope_placement d
            WHERE d.organization_id=e.organization_id AND d.node_id=e.node_id AND d.scope_id=e.owner_id AND d.scope_kind='personal'
          UNION ALL SELECT receipt.root_id,receipt.source_volume_id,receipt.source_epoch,receipt.operation_id
            FROM harness.personal_recovery_document_receipts receipt JOIN harness.document_scope_placement current
              ON (current.organization_id,current.node_id,current.scope_kind,current.scope_id,current.root_id,current.volume_id,current.writer_epoch)=
                (receipt.organization_id,receipt.target_node_id,'personal',receipt.user_id,receipt.root_id,receipt.target_volume_id,receipt.target_epoch)
            WHERE receipt.organization_id=e.organization_id AND receipt.source_node_id=e.node_id AND receipt.user_id=e.owner_id AND receipt.target_node_id=$6
              AND receipt.target_volume_id=$7
        ) d ON true
        JOIN harness.node_content_volumes destination ON destination.organization_id=p.organization_id AND destination.node_id=$6 AND destination.volume_id=$7
        JOIN harness.users u ON u.organization_id=p.organization_id AND u.public_id=$2
        WHERE p.organization_id=$1 AND p.id=$4 AND q.id=$5 AND p.scope_kind='personal' AND p.enabled AND p.revision=q.revision
          AND p.source_node_id<>$6 AND p.source_node_id<>$8 AND e.owner_kind='user' AND e.retired_at IS NULL
          AND i.generation>=q.writer_epoch AND q.gap_count=0 AND NOT EXISTS(SELECT FROM harness.document_scope_placement occupied
            WHERE occupied.organization_id=p.organization_id AND occupied.node_id=$6 AND occupied.scope_kind='personal' AND occupied.scope_id=e.owner_id AND d.receipt IS NULL)
          AND EXISTS(SELECT FROM harness.peer_backup_work w WHERE w.policy_id=p.id AND w.point_id=q.id AND w.node_id=$6 AND w.revision=p.revision
            AND w.kind='drill' AND w.status='confirmed') RETURNING id`,
      [this.context.organizationId,actor,input.requestId,input.policyId,input.pointId,input.targetNode,input.targetVolume,this.context.nodeId])
        .catch((error:unknown) => {
          if (error && typeof error==='object' && 'code' in error && error.code==='23505') fail('recovery-operation-active')
          throw error
        })
      if (!insert.rowCount) fail('personal-complete-point-required')
      const op = (await tx.query<PeerPersonalRecoveryOperation>(`SELECT ${projection} ${joins} WHERE r.id=$1`, [input.requestId])).rows[0]!
      await lockPersonalRecoveryOwner(tx, op)
      await this.audit(tx,actor,'request',op.id)
      return op.id
    }, input.targetNode)
  }

  /** Continue the same immutable point after a current-policy independent drill; retired source authority stays revoked.
   * @param actor - current administrator public ID. @param id - existing operation. @param policyRevision - inspected current policy revision. @param phase - phase inspected by the administrator.
   */
  async reapprove(actor:number,id:string,policyRevision:number,phase:PeerPersonalRecoveryOperation['phase']):Promise<void>{
    z.number().int().positive().parse(policyRevision)
    const op=await this.get(id)
    await this.admin(actor,async tx=>{
      await lockRecoveryTarget(tx,op.organizationId,op.targetNode);await lockPersonalRecoveryOwner(tx,op)
      if(op.repositoryNode!==op.targetNode)await admittedRecoveryRead(tx,op.organizationId,op.policyId,op.targetNode,undefined,op.pointId)
      const row=await tx.query(`SELECT FROM harness.personal_recovery_operations r JOIN harness.peer_backup_policies p ON p.id=r.policy_id AND p.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.id=$2 AND r.phase=$3 AND r.phase IN('preparing','prepared','externally-fenced','activating')
          AND p.enabled AND p.revision=$4 AND p.scope_kind='personal' AND p.scope_id=r.runtime_id AND p.source_node_id=r.source_node_id AND p.target_node_id=r.repository_node_id
          AND EXISTS(SELECT FROM harness.peer_backup_work w WHERE w.policy_id=p.id AND w.point_id=r.point_id AND w.node_id=r.target_node_id
            AND w.kind='drill' AND w.status='confirmed' AND w.revision=p.revision) FOR UPDATE OF r,p`,[op.organizationId,id,phase,policyRevision])
      if(!row.rowCount)fail('independent-drill-required')
      await tx.query(`INSERT INTO harness.personal_recovery_policy_approvals(id,operation_id,organization_id,policy_revision,phase,approved_by)
        SELECT gen_random_uuid(),$1,$2,$3,$4,id FROM harness.users WHERE organization_id=$2 AND public_id=$5 ON CONFLICT(operation_id,policy_revision) DO NOTHING`,
      [id,op.organizationId,policyRevision,phase,actor])
      await tx.query(`UPDATE harness.personal_recovery_operations SET retry_at=clock_timestamp(),last_error=NULL WHERE id=$1`,[id])
      await this.audit(tx,actor,'reapprove',id)
    })
  }

  /** Recheck the unchanged policy and current target account before target-owned file work.
   * @param tx - caller-owned authority transaction. @param op - exact operation whose policy and owner must remain admitted.
   */
  async lockPolicy(tx: PoolClient, op: PeerPersonalRecoveryOperation): Promise<void> {
    await lockRecoveryTarget(tx,op.organizationId,op.targetNode)
    const row = await tx.query(`SELECT FROM harness.peer_backup_policies p JOIN harness.personal_recovery_operations r ON r.policy_id=p.id AND r.organization_id=p.organization_id
      WHERE r.organization_id=$1 AND r.id=$2 AND p.enabled AND p.revision=harness.personal_recovery_policy_revision(r.id,r.policy_revision)
        AND p.scope_kind='personal' AND p.scope_id=r.runtime_id AND p.source_node_id=r.source_node_id AND p.target_node_id=r.repository_node_id
      FOR SHARE OF p,r`, [op.organizationId,op.id])
    if (!row.rowCount) fail('recovery-approval-changed')
    await lockPersonalRecoveryOwner(tx,op)
    if(op.repositoryNode!==op.targetNode)await admittedRecoveryRead(tx,op.organizationId,op.policyId,op.targetNode,undefined,op.pointId)
  }

  /** Certify exact native target bytes while the original Runtime remains untouched.
   * @param id - operation owned by this target. @param input - target-generated digests, paused setting names and frozen Session count.
   */
  async confirmTarget(id:string, input:z.input<typeof targetProof>):Promise<void>{
    const proof=targetProof.parse(input), op=await this.get(id)
    if(op.targetNode!==this.context.nodeId)fail('wrong-recovery-node')
    await transaction(this.context.pool,async tx=>{
      await lockAdministrator(tx,this.context,op.approvalActor)
      await this.lockPolicy(tx,op)
      await lockRecoveryTarget(tx,op.organizationId,op.targetNode)
      if (op.documentReceiptOperationId && !(await tx.query(`SELECT FROM harness.personal_recovery_document_receipts
        WHERE operation_id=$1 AND document_digest=$2`,[op.documentReceiptOperationId,proof.documentDigest])).rowCount) fail('personal-document-point-conflict')
      const changed=await tx.query(`UPDATE harness.personal_recovery_operations SET phase='prepared',target_files_digest=$3,
        target_evidence_digest=$4,old_session_count=$5,target_document_digest=$6,target_verified_at=clock_timestamp(),suspended_environment_keys=$7::jsonb,last_error=NULL
        WHERE organization_id=$1 AND id=$2 AND phase='preparing'`,[op.organizationId,id,proof.filesDigest,proof.evidenceDigest,proof.oldSessionCount,proof.documentDigest,JSON.stringify(proof.suspendedEnvironmentKeys)])
      if(!changed.rowCount)fail('recovery-approval-changed')
    })
  }

  /** Quarantine the whole old computer after explicit physical isolation; no process observation is fabricated.
   * @param actor - current administrator public ID. @param id - prepared operation. @param input - exact coordinates and physical isolation evidence.
   */
  async confirmIsolation(actor:number,id:string,input:unknown):Promise<void>{
    const body=isolationConfirmation.parse(input),op=await this.get(id)
    await this.admin(actor,async tx=>{
      if(op.sourceNode===this.context.nodeId)fail('isolation-primary-forbidden')
      if(body.confirm!==id||body.sourceNodeId!==op.sourceNode||body.sourceGeneration!==op.sourceGeneration||body.sourceEpoch!==op.oldEpoch
        ||body.pointId!==op.pointId||body.policyRevision!==op.policyRevision)fail('recovery-approval-changed')
      await this.lockPolicy(tx,op);await lockRecoveryTarget(tx,op.organizationId,op.targetNode)
      const current=await tx.query(`SELECT FROM harness.personal_recovery_operations r JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
        JOIN harness.personal_directory_placement p ON p.organization_id=r.organization_id AND p.runtime_id=r.runtime_id
        WHERE r.id=$1 AND r.phase='prepared' AND i.assigned_node_id=r.source_node_id AND i.generation=r.source_generation
          AND p.node_id=r.source_node_id AND p.owner_id=r.user_id FOR UPDATE OF r,i,p`,[id])
      if(!current.rowCount)fail('recovery-approval-changed')
      await tx.query(`INSERT INTO harness.recovery_source_isolations(operation_id,organization_id,scope_kind,scope_id,runtime_id,source_node_id,
        source_generation,source_epoch,point_id,policy_revision,method,evidence_reference,confirmed_by,confirmed_at,acknowledge_data_loss)
        SELECT r.id,r.organization_id,'personal',r.runtime_id,r.runtime_id,r.source_node_id,r.source_generation,r.source_epoch,r.point_id,harness.personal_recovery_policy_revision(r.id,r.policy_revision),
          $3,$4,u.id,clock_timestamp(),true FROM harness.personal_recovery_operations r JOIN harness.users u ON u.organization_id=r.organization_id AND u.public_id=$2
        WHERE r.id=$1`,[id,actor,body.isolationMethod,body.evidenceReference])
      await tx.query(`INSERT INTO harness.node_recovery_quarantines(organization_id,node_id,operation_id) VALUES($1,$2,$3)
        ON CONFLICT(organization_id,node_id) DO NOTHING`,[op.organizationId,op.sourceNode,id])
      await tx.query(`INSERT INTO harness.personal_recovery_execution_holds(operation_id,organization_id,runtime_id) VALUES($1,$2,$3)`,[id,op.organizationId,op.runtimeId])
      await tx.query(`UPDATE harness.instances SET desired_state='stopped',runtime_token_hash=NULL,stop_reason='access-change',updated_at=clock_timestamp()
        WHERE organization_id=$1 AND assigned_node_id=$2`,[op.organizationId,op.sourceNode])
      await tx.query(`UPDATE harness.node_agents SET credential_hash=NULL,revoked_at=clock_timestamp(),connection_id=NULL,lease_expires_at=NULL,
        connection_epoch=connection_epoch+1,revision=revision+1 WHERE organization_id=$1 AND node_id=$2`,[op.organizationId,op.sourceNode])
      await tx.query(`UPDATE harness.node_agent_enrollments SET consumed_at=coalesce(consumed_at,clock_timestamp()) WHERE organization_id=$1 AND node_id=$2`,[op.organizationId,op.sourceNode])
      await tx.query(`UPDATE harness.compute_nodes SET status='offline' WHERE organization_id=$1 AND id=$2`,[op.organizationId,op.sourceNode])
      await tx.query(`SELECT harness.invalidate_access($1,jsonb_build_object('nodeId',$2::uuid))`,[op.organizationId,op.sourceNode])
      await tx.query(`UPDATE harness.personal_recovery_operations SET phase='externally-fenced',retry_at=clock_timestamp(),last_error=NULL WHERE id=$1`,[id])
      await this.audit(tx,actor,'isolation-confirmed',id)
    })
  }

  /** Queue publication for the target worker after the administrator reviews the verified data-loss boundary.
   * @param actor - current administrator public ID. @param id - physically isolated operation.
   */
  async activate(actor:number,id:string):Promise<void>{
    const op=await this.get(id)
    await this.admin(actor,async tx=>{
      await this.lockPolicy(tx,op);await lockRecoveryTarget(tx,op.organizationId,op.targetNode)
      const changed=await tx.query(`UPDATE harness.personal_recovery_operations SET phase='activating',activation_approved_by=u.id,
        activation_approved_at=clock_timestamp(),retry_at=clock_timestamp(),last_error=NULL FROM harness.users u
        WHERE personal_recovery_operations.organization_id=$1 AND personal_recovery_operations.id=$2 AND personal_recovery_operations.phase='externally-fenced'
          AND u.organization_id=$1 AND u.public_id=$3`,[op.organizationId,id,actor])
      if(!changed.rowCount)fail('recovery-approval-changed')
      await this.audit(tx,actor,'activate',id)
    })
  }

  /** Cancel only before irreversible source isolation; privately staged evidence remains available for controlled cleanup.
   * @param actor - current administrator public ID. @param id - operation whose source has not been isolated.
   */
  async cancel(actor:number,id:string):Promise<void>{
    await this.admin(actor,async tx=>{
      const changed=await tx.query(`UPDATE harness.personal_recovery_operations SET phase='cancelled',last_error=NULL WHERE organization_id=$1 AND id=$2
        AND phase IN('preparing','prepared')`,[this.context.organizationId,id])
      if(!changed.rowCount)fail('recovery-approval-changed')
      await this.audit(tx,actor,'cancel',id)
    })
  }

  /** Commit target-installed files under their exact digest; current grants and quotas still decide admission.
   * @param id - operation owned by this target. @param input - locally verified installation path and immutable digests.
   */
  async publish(id:string,input:{homePath:string;documentDigest:string;filesDigest:string;evidenceDigest:string}):Promise<void>{
    const op=await this.get(id)
    if(op.targetNode!==this.context.nodeId||!this.portBase||op.activationActor===null)fail('wrong-recovery-node')
    if(input.filesDigest!==op.filesDigest||input.evidenceDigest!==op.evidenceDigest)fail('personal-target-changed')
    digest.parse(input.documentDigest)
    if(input.documentDigest!==op.documentDigest)fail('personal-target-changed')
    await transaction(this.context.pool,async tx=>{
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['gateway-port:'+op.targetNode])
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))',['gateway-admin:'+op.organizationId])
      await lockAdministrator(tx,this.context,op.activationActor!)
      await this.lockPolicy(tx,op);await lockRecoveryTarget(tx,op.organizationId,op.targetNode)
      const row=await tx.query(`SELECT FROM harness.personal_recovery_operations r JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id
        JOIN harness.personal_directory_placement p ON p.organization_id=r.organization_id AND p.runtime_id=r.runtime_id
        WHERE r.id=$1 AND r.phase='activating' AND i.assigned_node_id=r.source_node_id AND i.generation=r.source_generation
          AND i.desired_state='stopped' AND i.runtime_token_hash IS NULL AND harness.node_physically_isolated(r.organization_id,r.source_node_id)
          AND p.node_id=r.source_node_id AND p.owner_id=r.user_id FOR UPDATE OF r,i,p`,[id])
      if(!row.rowCount)fail('recovery-approval-changed')
      if((await tx.query(`SELECT FROM harness.document_scope_placement WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_id=$3`,
        [op.organizationId,op.targetNode,op.accountId])).rowCount && !op.documentReceiptOperationId)fail('personal-target-documents-exist')
      const account=await tx.query<{home_path:string}>(`SELECT home_path FROM harness.node_user_accounts WHERE organization_id=$1 AND node_id=$2 AND user_id=$3 FOR UPDATE`,
        [op.organizationId,op.targetNode,op.accountId])
      if(account.rows[0]&&account.rows[0].home_path!==input.homePath)fail('personal-target-changed')
      await tx.query(`INSERT INTO harness.node_user_accounts(organization_id,node_id,user_id,home_path) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [op.organizationId,op.targetNode,op.accountId,input.homePath])
      const [port]=await allocateInstancePorts(tx,op.targetNode,this.portBase!,1,this.context.nodeName)
      await tx.query(`SELECT set_config('hgw.personal_recovery_operation',$1,true)`,[id])
      await tx.query(`UPDATE harness.personal_recovery_operations SET phase='switching' WHERE id=$1`,[id])
      if (!op.documentReceiptOperationId) await tx.query(`INSERT INTO harness.personal_recovery_document_receipts(operation_id,organization_id,user_id,source_node_id,root_id,source_volume_id,source_epoch,
        target_node_id,target_volume_id,target_epoch,document_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id,op.organizationId,op.accountId,op.sourceNode,op.sourceDocumentRoot,op.sourceVolume,op.sourceDocumentEpoch,op.targetNode,op.targetVolume,op.targetDocumentEpoch,input.documentDigest])
      await tx.query(`UPDATE harness.instances SET assigned_node_id=$3,port=$4,generation=$5,observed_state='stopped',desired_state='stopped',
        runtime_token_hash=NULL,provisioning_state='ready',stop_reason='access-change',updated_at=clock_timestamp() WHERE organization_id=$1 AND runtime_id=$2`,
      [op.organizationId,op.runtimeId,op.targetNode,port,op.newEpoch])
      await tx.query(`UPDATE harness.personal_directory_placement SET node_id=$3 WHERE organization_id=$1 AND runtime_id=$2`,[op.organizationId,op.runtimeId,op.targetNode])
      if (op.documentReceiptOperationId) {
        if (!(await tx.query(`SELECT FROM harness.personal_recovery_document_receipts r JOIN harness.document_scope_placement p
          ON (p.organization_id,p.node_id,p.scope_kind,p.scope_id,p.root_id,p.volume_id,p.writer_epoch)=
            (r.organization_id,r.target_node_id,'personal',r.user_id,r.root_id,r.target_volume_id,r.target_epoch)
          WHERE r.operation_id=$1 AND r.document_digest=$2 AND r.target_node_id=$3 AND r.user_id=$4 FOR SHARE OF r,p`,
        [op.documentReceiptOperationId,input.documentDigest,op.targetNode,op.accountId])).rowCount)fail('personal-document-point-conflict')
      } else {
      const moved=await tx.query(`UPDATE harness.document_scope_placement SET node_id=$4,volume_id=$5,writer_epoch=$6
        WHERE organization_id=$1 AND node_id=$2 AND scope_kind='personal' AND scope_id=$3 AND root_id=$7 AND volume_id=$8 AND writer_epoch=$9`,
      [op.organizationId,op.sourceNode,op.accountId,op.targetNode,op.targetVolume,op.targetDocumentEpoch,op.sourceDocumentRoot,op.sourceVolume,op.sourceDocumentEpoch])
      if(!moved.rowCount)fail('personal-target-changed')
      }
      await tx.query(`UPDATE harness.personal_recovery_operations SET phase='published',published_at=clock_timestamp(),target_activated_at=clock_timestamp(),last_error=NULL WHERE id=$1`,[id])
      await disableReplacedPeerSource(tx,{organizationId:op.organizationId,scopeKind:'personal',scopeId:op.runtimeId,sourceNodeId:op.sourceNode})
      await this.audit(tx,op.activationActor!,'published',id)
      await checkPeerBackupNode(tx,op.organizationId,op.targetNode,true)
    })
  }

  private async audit(tx:PoolClient,actor:number,action:string,id:string):Promise<void>{
    await tx.query(`INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,detail)
      SELECT $1,id,$3,'personal-recovery',$4,'{}' FROM harness.users WHERE organization_id=$1 AND public_id=$2`,
    [this.context.organizationId,actor,'admin.personal-recovery.'+action,id])
  }
}
