/** Explicit, operator-owned project recovery. Staging and proving retirement do not start the replacement Runtime. */
import { allocateInstancePorts } from './postgres/port-allocation.ts'
import type { ProjectOrigin } from './projects.ts'
import { checkPeerBackupNode } from './peer-backup-governance.ts'
import { lockRecoveryOwner, lockRecoveryPolicy } from './peer-backup-takeover-authority.ts'
import type { PoolClient } from 'pg'
import { z } from 'zod'
import { lockAdministrator } from './postgres/administrator-authority.ts'
import { transaction } from './postgres/database.ts'
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import type { InstanceManager, RuntimeStopLease } from './instances.ts'
import type { NodeContentBinding, NodeContentStore } from './node-content-store.ts'
import type { RuntimeId } from './runtime-catalog.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import { replacementFileDigest } from './peer-backup-file-digest.ts'
import { readProjectScheduleWitness } from './peer-backup-takeover-schedule.ts'

export interface PeerRecoveryOperation {
  id: string
  filesDigest: string | null
  targetPortBase: number | null
  policyId: string
  policyRevision: number
  origin: ProjectOrigin
  nameId: string
  retirementActor: number | null
  organizationId: string
  projectId: string
  runtimeId: RuntimeId
  sourceNode: string
  sourceVolume: string
  oldEpoch: string
  targetNode: string
  targetVolume: string
  newEpoch: string
  pointId: string
  revision: string
  digest: string
  phase: string
  publicId: number
  scheduleDigest: string | null
}
const statusProjection = `r.id,r.project_id "projectId",r.runtime_id "runtimeId",r.point_id "pointId",r.source_node_id "sourceNodeId",
  r.target_node_id "targetNodeId",r.phase,r.last_error "lastError",r.target_activated_at "targetActivatedAt",
  harness.recovery_policy_revision(r.id,r.policy_revision) "policyRevision",p.revision "currentPolicyRevision",p.enabled "policyEnabled",
  (p.revision<>harness.recovery_policy_revision(r.id,r.policy_revision) OR NOT p.enabled)
    AND r.phase<>'cancelled' AND r.target_activated_at IS NULL "reapprovalRequired",
  (r.phase='cancelled' AND NOT EXISTS(SELECT FROM harness.project_recovery_cleanups c WHERE c.operation_id=r.id)) "cleanupPending",
  (SELECT count(*)::float8 FROM harness.project_members m WHERE m.organization_id=r.organization_id AND m.project_id=r.project_id
    AND NOT harness.computer_use_allowed(r.organization_id,m.user_id,r.target_node_id)) "affectedMemberCount"`
const projection = `r.id,r.target_files_digest "filesDigest",r.target_port_base "targetPortBase",r.policy_id "policyId",harness.recovery_policy_revision(r.id,r.policy_revision) "policyRevision",p.origin,p.logical_name_id "nameId",
  (SELECT public_id::float8 FROM harness.users WHERE id=harness.recovery_retirement_actor(r.id,r.retirement_approved_by,r.retirement_approved_at) AND organization_id=r.organization_id) "retirementActor",r.organization_id "organizationId",r.project_id "projectId",r.runtime_id "runtimeId",r.source_node_id "sourceNode",r.source_volume_id "sourceVolume",
  r.source_epoch::text "oldEpoch",r.target_node_id "targetNode",r.target_volume_id "targetVolume",r.target_epoch::text "newEpoch",r.point_id "pointId",
  r.point_revision::text revision,r.manifest_digest digest,r.phase,p.public_id::float8 "publicId",r.target_schedule_digest "scheduleDigest"`
type Volume = Pick<NodeContentStore, 'readVolume' | 'writeVolume'>
interface Limits {
  maxBytes: number
  maxRows: number
}
const denied = (code: string): never => {
  throw new PeerBackupError(409, 'peer-backup/' + code)
}
export function recoveryBinding(op: PeerRecoveryOperation, side: 'source' | 'target'): NodeContentBinding {
  return {
    organizationId: op.organizationId,
    projectId: op.projectId,
    runtimeId: op.runtimeId,
    nodeId: side === 'source' ? op.sourceNode : op.targetNode,
    volumeId: side === 'source' ? op.sourceVolume : op.targetVolume,
    writerEpoch: side === 'source' ? op.oldEpoch : op.newEpoch,
  }
}

/** Read one immutable approved request and the protected scope; callers cannot supply mutable source coordinates. */
export class PeerProjectRecovery {
  constructor(
    readonly context: PostgresRuntimeContext,
    private readonly volume?: Volume,
    private readonly limits: Limits = { maxBytes: 64 << 20, maxRows: 100000 },
    private readonly instancePortBase?: number,
    private readonly currentFiles?: (op: PeerRecoveryOperation, signal: AbortSignal) => Promise<string>,
    private readonly fileGate?: PeerProjectFileGate,
  ) {}

  private async admin<T>(actor: number, work: (tx: PoolClient) => Promise<T>,
    preLock?: (tx: PoolClient) => Promise<void>): Promise<T> {
    return transaction(this.context.pool, async (tx) => {
      // Advisory locks precede every row lock so a port allocator can never
      // wait on a gateway that waits on administrator or user rows.
      if (preLock !== undefined) await preLock(tx)
      await lockAdministrator(tx, this.context, actor)
      if (
        !(
          await tx.query(
            `SELECT FROM harness.deployment_topology t JOIN harness.cluster_control c USING(organization_id)
        WHERE t.organization_id=$1 AND t.primary_node_id=$2 AND t.enabled AND c.mode='serving' FOR SHARE OF t,c`,
            [this.context.organizationId, this.context.nodeId],
          )
        ).rowCount
      )
        denied('primary-required')
      return work(tx)
    })
  }
  async get(id: string): Promise<PeerRecoveryOperation> {
    z.uuid().parse(id)
    const row = (
      await this.context.pool.query<PeerRecoveryOperation>(
        `SELECT ${projection} FROM harness.project_recovery_operations r
      JOIN harness.projects p ON p.id=r.project_id AND p.organization_id=r.organization_id WHERE r.organization_id=$1 AND r.id=$2`,
        [this.context.organizationId, id],
      )
    ).rows[0]
    return row ?? denied('recovery-not-found')
  }
  /** The primary Admin returns recovery progress without exposing node paths or decryption material. */
  async status(actor: number, id: string) {
    return this.admin(actor, async (tx) => {
      const status = (
        await tx.query(
          `SELECT ${statusProjection} FROM harness.project_recovery_operations r JOIN harness.peer_backup_policies p ON p.id=r.policy_id AND p.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.id=$2`,
          [this.context.organizationId, id],
        )
      ).rows[0]
      return status ?? denied('recovery-not-found')
    })
  }
  /** Offer only this policy's designated destination and never accept a browser-provided data path. */
  async choices(actor: number, policyId: string) {
    z.uuid().parse(policyId)
    return this.admin(actor, async (tx) => {
      const targets = (
        await tx.query<{ nodeId: string; volumeId: string }>(
          `SELECT v.node_id "nodeId",v.volume_id "volumeId" FROM harness.peer_backup_policies p
        JOIN harness.node_content_volumes v ON v.organization_id=p.organization_id AND v.node_id=p.target_node_id
        WHERE p.organization_id=$1 AND p.id=$2 AND p.scope_kind='project' AND p.enabled`,
          [this.context.organizationId, policyId],
        )
      ).rows
      const attempts = (
        await tx.query(
          `SELECT ${statusProjection} FROM harness.project_recovery_operations r JOIN harness.peer_backup_policies p
        ON p.organization_id=r.organization_id AND p.id=r.policy_id WHERE r.organization_id=$1 AND r.policy_id=$2 ORDER BY r.created_at DESC LIMIT 10`,
          [this.context.organizationId, policyId],
        )
      ).rows
      return { targets, attempts }
    })
  }

  /** Require the selected complete point and a successful independent rehearsal on the exact replacement computer. */
  async request(
    actor: number,
    input: { requestId: string; policyId: string; pointId: string; targetNode: string; targetVolume: string },
  ) {
    for (const id of Object.values(input)) z.uuid().parse(id)
    return this.admin(actor, async (tx) => {
      await checkPeerBackupNode(tx, this.context.organizationId, input.targetNode, true)
      await tx.query('SELECT FROM harness.peer_backup_policies WHERE organization_id=$1 AND id=$2 FOR SHARE',
        [this.context.organizationId,input.policyId])
      if ((await tx.query(`SELECT FROM harness.project_recovery_operations r JOIN harness.peer_backup_policies p ON p.id=$2
        WHERE r.organization_id=$1 AND r.project_id=p.scope_id AND r.target_node_id=$3 AND r.target_volume_id=$4
        AND r.phase='cancelled' AND r.id<>$5 AND NOT EXISTS(SELECT FROM harness.project_recovery_cleanups c WHERE c.operation_id=r.id)`,
        [this.context.organizationId,input.policyId,input.targetNode,input.targetVolume,input.requestId])).rowCount) denied('recovery-cleanup-pending')
      const inserted = await tx.query(
        `INSERT INTO harness.project_recovery_operations(id,organization_id,project_id,runtime_id,policy_id,
        point_id,policy_revision,approved_by,source_node_id,source_volume_id,source_epoch,target_node_id,target_volume_id,target_epoch,manifest_digest,point_revision,phase)
        SELECT $3,b.organization_id,b.project_id,b.runtime_id,p.id,q.id,p.revision,u.id,b.node_id,b.volume_id,b.writer_epoch,$6,$7,b.writer_epoch+1,
          q.manifest_digest,q.watermark,'prepared' FROM harness.peer_backup_points q JOIN harness.peer_backup_policies p ON p.id=q.policy_id AND p.organization_id=q.organization_id
        JOIN harness.project_content_placement b ON b.organization_id=p.organization_id AND b.project_id=p.scope_id AND b.node_id=p.source_node_id
          AND b.writer_epoch=q.writer_epoch JOIN harness.users u ON u.organization_id=b.organization_id AND u.public_id=$2
        JOIN harness.node_content_volumes destination ON destination.organization_id=b.organization_id AND destination.node_id=$6 AND destination.volume_id=$7
        WHERE b.organization_id=$1 AND b.source_retirement IN ('new','retired') AND p.id=$4 AND q.id=$5 AND p.enabled AND p.scope_kind='project' AND q.gap_count=0 AND b.node_id<>$6
          AND p.revision=q.revision AND p.target_node_id=$6 AND harness.node_execution_available(b.organization_id,$6)
          AND EXISTS(SELECT FROM harness.projects project WHERE project.organization_id=b.organization_id AND project.id=b.project_id
            AND project.kind='standard' AND project.status='active' AND harness.computer_use_allowed(project.organization_id,project.owner_user_id,$6)) AND EXISTS(SELECT FROM harness.peer_backup_work w WHERE w.kind='drill'
            AND w.point_id=q.id AND w.policy_id=p.id AND w.node_id=$6 AND w.revision=p.revision AND w.status='confirmed')
        ON CONFLICT(id) DO NOTHING RETURNING id`,
        [
          this.context.organizationId,
          actor,
          input.requestId,
          input.policyId,
          input.pointId,
          input.targetNode,
          input.targetVolume,
        ],
      ).catch((error: unknown) => {
        // ON CONFLICT covers only the request id; one_project_takeover rejects
        // a second operation for the same project with a bare 23505.
        if (error !== null && typeof error === 'object' && 'code' in error && String(error.code) === '23505')
          denied('recovery-operation-active')
        throw error
      })
      if (
        !inserted.rowCount &&
        !(
          await tx.query(
            `SELECT FROM harness.project_recovery_operations r WHERE r.organization_id=$1 AND r.id=$2
        AND r.policy_id=$3 AND r.point_id=$4 AND r.target_node_id=$5 AND r.target_volume_id=$6`,
            [
              this.context.organizationId,
              input.requestId,
              input.policyId,
              input.pointId,
              input.targetNode,
              input.targetVolume,
            ],
          )
        ).rowCount
      )
        denied('independent-drill-required')
      const identity = (await tx.query<{project_id:string}>('SELECT project_id FROM harness.project_recovery_operations WHERE organization_id=$1 AND id=$2',
        [this.context.organizationId,input.requestId])).rows[0]
      if (!identity) denied('verified-candidate-required')
      await lockRecoveryOwner(tx,{organizationId:this.context.organizationId,projectId:identity!.project_id,targetNode:input.targetNode})
      await this.audit(tx, actor, 'request', input.requestId)
      return input.requestId
    })
  }
  /** Approve permanent source retirement only after an independently verified target is ready. */
  async approveRetirement(actor: number, id: string): Promise<void> {
    const op = await this.get(id)
    await this.admin(actor, async (tx) => {
      await lockRecoveryPolicy(tx,op)
      const result = await tx.query(
        `UPDATE harness.project_recovery_operations r SET phase='retire-approved',
        retirement_approved_by=u.id,retirement_approved_at=now(),retry_at=now(),last_error=NULL FROM harness.users u
        WHERE r.organization_id=$1 AND r.id=$2 AND r.phase='target-ready' AND u.organization_id=r.organization_id AND u.public_id=$3`,
        [this.context.organizationId, id, actor],
      )
      if (!result.rowCount) denied('verified-candidate-required')
      await this.audit(tx, actor, 'retirement-approved', id)
    })
  }

  /** Bind a new administrative decision to this immutable recovery point and the policy revision the operator inspected. */
  async reapprove(actor: number, id: string, revision: number, phase: string): Promise<void> {
    const op = await this.get(id)
    await this.admin(actor,async tx => {
      const current = await tx.query(`SELECT FROM harness.peer_backup_policies p JOIN harness.project_recovery_operations r ON r.policy_id=p.id
        JOIN harness.peer_backup_points q ON q.id=r.point_id AND q.policy_id=p.id AND q.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.id=$2 AND p.organization_id=r.organization_id AND p.enabled AND p.revision=$3 AND r.phase=$4
        AND r.phase IN('prepared','target-ready','retire-approved','retiring','retreat','old-fenced','published') AND r.target_activated_at IS NULL
        AND p.source_node_id=r.source_node_id AND p.target_node_id=r.target_node_id AND p.scope_id=r.project_id AND p.scope_kind='project'
        AND q.gap_count=0 AND q.manifest_digest=r.manifest_digest AND q.writer_epoch=r.source_epoch AND q.watermark=r.point_revision
        FOR SHARE OF p FOR UPDATE OF r`,[op.organizationId,id,revision,phase])
      if (!current.rowCount) denied('recovery-approval-changed')
      await lockRecoveryOwner(tx,op)
      await checkPeerBackupNode(tx,op.organizationId,op.targetNode,true)
      if (!(await tx.query(`SELECT FROM harness.peer_backup_work WHERE organization_id=$1 AND policy_id=$2 AND point_id=$3
        AND node_id=$4 AND revision=$5 AND kind='drill' AND status='confirmed' FOR SHARE`,
        [op.organizationId,op.policyId,op.pointId,op.targetNode,revision])).rowCount) denied('current-revision-drill-required')
      await tx.query(`INSERT INTO harness.project_recovery_policy_approvals(organization_id,operation_id,policy_revision,approved_by)
        SELECT $1,$2,$3,u.id FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$4`,[op.organizationId,id,revision,actor])
      await tx.query('UPDATE harness.project_recovery_operations SET retry_at=clock_timestamp(),last_error=NULL WHERE id=$1',[id])
      await this.audit(tx,actor,'reapprove',id)
    })
  }

  /** An approval that has not retired the source can be cancelled without affecting its Runtime or files. */
  async cancel(actor: number, id: string): Promise<void> {
    await this.admin(actor, async (tx) => {
      // A 'retiring' op may or may not have committed its irreversible source
      // fence on the node's content volume. Move it to 'retreat' and let the
      // source worker prove which side of the fence it is on before releasing
      // the runtime freeze. lockAdministrator serializes against the fence
      // window, which holds the same locks on a second connection.
      const retreated = await tx.query(
        `UPDATE harness.project_recovery_operations SET phase='retreat',retry_at=clock_timestamp(),last_error=NULL
        WHERE organization_id=$1 AND id=$2 AND phase='retiring'`,
        [this.context.organizationId, id],
      )
      if (
        !retreated.rowCount &&
        !(
          await tx.query(
            `UPDATE harness.project_recovery_operations SET phase='cancelled',retry_at=clock_timestamp(),last_error=NULL WHERE organization_id=$1 AND id=$2
        AND phase IN ('prepared','target-ready','retire-approved')`,
            [this.context.organizationId, id],
          )
        ).rowCount
      )
        denied('verified-writer-fence-required')
      await this.audit(tx, actor, 'cancel', id)
    })
  }
  /** Resolve a retreat on the source computer: no landed fence means retirement never became irreversible. */
  async resolveRetreat(id: string, signal: AbortSignal): Promise<void> {
    if (!this.volume) throw new PeerBackupError(503, 'peer-backup/private-storage-required')
    const op = await this.get(id)
    const fence = (
      await this.volume.readVolume(
        async (db) =>
          db.query<{ schedule_digest: string; files_digest: string; generation: number; stop_operation_id: string }>(
            `SELECT schedule_digest,files_digest,generation::float8 generation,stop_operation_id::text
        FROM node_content.recovery_source_fences WHERE operation_id=$1 AND organization_id=$2 AND runtime_id=$3`,
            [id, op.organizationId, op.runtimeId],
          ),
        signal,
      )
    ).rows[0]
    await transaction(this.context.pool, async (tx) => {
      if (fence) {
        // The fence won the race: finish the interrupted 'old-fenced' commit
        // from its own evidence rather than pretending retirement never ran.
        if (fence.schedule_digest !== op.scheduleDigest || fence.files_digest !== op.filesDigest)
          denied('fence-evidence-conflict')
        const done = await tx.query(
          `UPDATE harness.project_recovery_operations SET phase='old-fenced',old_fenced_at=now(),source_schedule_digest=$3,
        stopped_generation=$4,stop_operation_id=$5,source_files_digest=$6 WHERE organization_id=$1 AND id=$2 AND phase='retreat'`,
          [op.organizationId, id, fence.schedule_digest, fence.generation, fence.stop_operation_id, fence.files_digest],
        )
        if (!done.rowCount) denied('recovery-approval-changed')
        return
      }
      const done = await tx.query(
        `UPDATE harness.project_recovery_operations SET phase='cancelled',retry_at=clock_timestamp(),last_error=NULL
        WHERE organization_id=$1 AND id=$2 AND phase='retreat'`,
        [op.organizationId, id],
      )
      if (!done.rowCount) denied('recovery-approval-changed')
    })
  }
  /** A replacement cannot touch an assigned volume or any release belonging to another approval. */
  async assertUnpublishedDestination(op:PeerRecoveryOperation,phase:'prepared'|'cancelled'):Promise<void>{
    if(op.organizationId!==this.context.organizationId || op.targetNode!==this.context.nodeId || !(await this.context.pool.query(
      `SELECT FROM harness.project_recovery_operations r JOIN harness.project_content_placement b ON b.organization_id=r.organization_id
        AND b.project_id=r.project_id AND b.runtime_id=r.runtime_id WHERE r.organization_id=$1 AND r.id=$2 AND r.phase=$3
        AND r.target_node_id=$4 AND r.target_volume_id=$5 AND b.node_id<>r.target_node_id AND b.volume_id<>r.target_volume_id`,
      [op.organizationId,op.id,phase,op.targetNode,op.targetVolume])).rowCount) denied('candidate-not-releasable')
  }
  async acknowledgeCleanup(op:PeerRecoveryOperation):Promise<void>{
    const result=await this.context.pool.query(`INSERT INTO harness.project_recovery_cleanups(operation_id,organization_id,node_id,volume_id)
      SELECT r.id,r.organization_id,r.target_node_id,r.target_volume_id FROM harness.project_recovery_operations r
        WHERE r.organization_id=$1 AND r.id=$2 AND r.target_node_id=$3 AND r.target_volume_id=$4 AND r.phase='cancelled'
      ON CONFLICT(operation_id) DO NOTHING`,[this.context.organizationId,op.id,this.context.nodeId,op.targetVolume])
    if(!result.rowCount && !(await this.context.pool.query(`SELECT FROM harness.project_recovery_cleanups WHERE operation_id=$1
      AND organization_id=$2 AND node_id=$3 AND volume_id=$4`,[op.id,op.organizationId,op.targetNode,op.targetVolume])).rowCount) denied('candidate-not-releasable')
  }
  private async audit(tx: PoolClient, actor: number, action: string, id: string) {
    await tx.query(
      `INSERT INTO harness.audit_events(organization_id,actor_user_id,action,resource_type,resource_id,detail)
      SELECT $1,u.id,$3,'project-recovery',$4,'{}' FROM harness.users u WHERE u.organization_id=$1 AND u.public_id=$2`,
      [this.context.organizationId, actor, 'admin.project-recovery.' + action, id],
    )
  }

  private async targetFileProof(tx: PoolClient, op: PeerRecoveryOperation, signal: AbortSignal): Promise<void> {
    const value = (
      await tx.query(
        `SELECT protected_roots,target_files_digest FROM node_content.recovery_candidates WHERE operation_id=$1
      AND destination_volume_id=$2 AND destination_node_id=$3 AND point_id=$4 AND manifest_digest=$5 AND phase='verified'`,
        [op.id, op.targetVolume, op.targetNode, op.pointId, op.digest],
      )
    ).rows[0]
    const roots = z
      .array(z.object({ owner: z.string(), kind: z.literal('directory'), path: z.string().min(1) }).strict())
      .length(4)
      .parse(value?.protected_roots)
    if ((await replacementFileDigest(roots, this.limits, signal)) !== value?.target_files_digest)
      denied('target-files-changed')
  }

  /** The target owns a certified local candidate. Its captured schedule receipts must match its real restored Session messages. */
  async confirmTarget(id: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    const op = await this.get(id)
    if (!this.volume || this.context.nodeId !== op.targetNode || !['prepared', 'target-ready'].includes(op.phase))
      denied('wrong-recovery-node')
    if (!this.fileGate) denied('target-file-fence-unavailable')
    await this.fileGate!.admit(op.publicId, async () => {
      await checkPeerBackupNode(this.context.pool, op.organizationId, op.targetNode, true)
      const target = recoveryBinding(op, 'target')
      if (!this.instancePortBase) denied('target-port-range-required')
      const proof = await this.volume!.readVolume(async (tx) => {
        const candidate = (
          await tx.query<{ schedule_digest: string; files_digest: string }>(
            `SELECT c.schedule_digest,c.files_digest FROM node_content.recovery_candidates c JOIN node_content.spaces s
        ON s.organization_id=c.organization_id AND s.project_id=c.project_id AND s.runtime_id=c.runtime_id AND s.volume_id=c.destination_volume_id
        AND s.node_id=c.destination_node_id AND s.writer_epoch=c.destination_epoch
        WHERE c.operation_id=$1 AND c.point_id=$2 AND c.manifest_digest=$3 AND c.destination_node_id=$4 AND c.phase='verified'`,
            [id, op.pointId, op.digest, this.context.nodeId],
          )
        ).rows[0]
        if (!candidate) denied('verified-candidate-required')
        await this.targetFileProof(tx, op, signal)
        const actual = await readProjectScheduleWitness(tx, target, this.limits)
        if (candidate!.schedule_digest !== actual) denied('schedule-witness-moved')
        return { schedule: actual, files: candidate!.files_digest }
      })
      if (op.phase === 'target-ready') {
        if (
          op.scheduleDigest !== proof.schedule ||
          op.filesDigest !== proof.files ||
          op.targetPortBase !== this.instancePortBase
        )
          denied('schedule-witness-moved')
        return
      }
      const approved = await transaction(this.context.pool, async control => {
        await lockRecoveryPolicy(control,op)
        return control.query(
        `UPDATE harness.project_recovery_operations r SET phase='target-ready',target_verified_at=now(),target_schedule_digest=$3,target_files_digest=$4,target_port_base=$5,retry_at=now(),last_error=NULL
      FROM harness.peer_backup_policies p WHERE r.organization_id=$1 AND r.id=$2 AND r.phase='prepared' AND p.id=r.policy_id AND p.enabled AND p.revision=harness.recovery_policy_revision(r.id,r.policy_revision)`,
        [op.organizationId, id, proof.schedule, proof.files, this.instancePortBase],
        )
      })
      if (!approved.rowCount) denied('recovery-approval-changed')
    })
  }

  /** This stop purpose admits only an already stopped supervised generation. A busy or unreachable old node cannot be retired. */
  async retireSource(
    id: string,
    actor: number,
    instances: Pick<InstanceManager, 'withStopped'>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<void> {
    const op = await this.get(id)
    if (
      !this.volume ||
      this.context.nodeId !== op.sourceNode ||
      !['retire-approved', 'retiring', 'old-fenced'].includes(op.phase) ||
      op.retirementActor !== actor
    )
      denied('wrong-recovery-node')
    if (op.phase === 'old-fenced') return
    const source = recoveryBinding(op, 'source')
    const state = (
      await this.context.pool.query<{ generation: number }>(
        `SELECT generation::float8 FROM harness.instances WHERE organization_id=$1 AND runtime_id=$2
      AND assigned_node_id=$3 AND desired_state='stopped' AND observed_state='stopped' AND runtime_token_hash IS NULL`,
        [op.organizationId, op.runtimeId, op.sourceNode],
      )
    ).rows[0]
    if (!state) denied('source-not-stopped')
    await instances.withStopped(
      { kind: 'project', id: op.publicId, runtimeId: op.runtimeId },
      async (lease) => {
        if (
          !lease?.wasStopped ||
          !lease.operationId ||
          lease.runtimeId !== op.runtimeId ||
          lease.generation !== state!.generation
        )
          denied('source-not-stopped')
        if (!this.fileGate) denied('file-fence-unavailable')
        const fence = await this.fileGate!.retire(op.publicId, op.id, async () => {
          const already = (
            await this.volume!.readVolume(
              async (tx) =>
                (
                  await tx.query<{ files_digest: string }>(
                    'SELECT files_digest FROM node_content.recovery_source_fences WHERE operation_id=$1 AND organization_id=$2 AND runtime_id=$3',
                    [id, op.organizationId, op.runtimeId],
                  )
                ).rows[0],
            )
          )?.files_digest
          if (!this.currentFiles && !already) denied('file-verifier-unavailable')
          const fileDigest = already ?? (await this.currentFiles!(op, signal))
          if (fileDigest !== op.filesDigest) denied('source-files-changed')
          const authority: {client?: PoolClient} = {}
          try {
            const fenced = await this.volume!.writeVolume(async (tx) => {
            const existing = (
              await tx.query<{
                schedule_digest: string
                generation: number
                stop_operation_id: string
                files_digest: string
              }>(
                `SELECT schedule_digest,generation::float8,stop_operation_id,files_digest FROM node_content.recovery_source_fences WHERE operation_id=$1
          AND organization_id=$2 AND runtime_id=$3 AND source_epoch=$4 AND destination_volume_id=$5`,
                [id, op.organizationId, op.runtimeId, op.oldEpoch, op.targetVolume],
              )
            ).rows[0]
            if (existing) return existing
            const row = await tx.query(
              `SELECT FROM node_content.spaces s WHERE (organization_id,project_id,runtime_id,node_id,volume_id,writer_epoch)=($1,$2,$3,$4,$5,$6)
          AND publication_state='published' AND revision=$7 AND NOT EXISTS(SELECT FROM node_content.project_journal_state j WHERE j.organization_id=s.organization_id
            AND j.project_id=s.project_id AND j.generating_since IS NOT NULL) AND NOT EXISTS(SELECT FROM node_content.project_journal_requests q
            WHERE q.organization_id=s.organization_id AND q.project_id=s.project_id AND (NOT q.completed OR q.delivered_at IS NULL))
          FOR UPDATE NOWAIT`,
              [
                source.organizationId,
                source.projectId,
                source.runtimeId,
                source.nodeId,
                source.volumeId,
                source.writerEpoch,
                op.revision,
              ],
            )
            if (!row.rowCount) denied('new-quiescent-point-required')
            const schedule = await readProjectScheduleWitness(tx, source, this.limits)
            if (schedule !== op.scheduleDigest) denied('schedule-witness-moved')
            await this.registerStop(op, actor, lease!)
            // The expensive witnesses are ready. Keep authorization until the node commits the irreversible fence.
            authority.client = await this.context.pool.connect()
            await authority.client.query('BEGIN')
            await lockAdministrator(authority.client,this.context,actor)
            await lockRecoveryPolicy(authority.client,op)
            await tx.query(
              `INSERT INTO node_content.recovery_source_fences(operation_id,organization_id,project_id,runtime_id,source_node_id,source_volume_id,source_epoch,
          destination_node_id,destination_volume_id,destination_epoch,generation,stop_operation_id,point_id,revision,schedule_digest,files_digest)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
              [
                id,
                op.organizationId,
                op.projectId,
                op.runtimeId,
                op.sourceNode,
                op.sourceVolume,
                op.oldEpoch,
                op.targetNode,
                op.targetVolume,
                op.newEpoch,
                lease!.generation,
                lease!.operationId,
                op.pointId,
                op.revision,
                schedule,
                fileDigest,
              ],
            )
            await tx.query(
              "UPDATE node_content.spaces SET publication_state='retired',writer_epoch=$3 WHERE organization_id=$1 AND runtime_id=$2",
              [op.organizationId, op.runtimeId, op.newEpoch],
            )
            return {
              schedule_digest: schedule,
              files_digest: fileDigest,
              generation: lease!.generation,
              stop_operation_id: lease!.operationId,
            }
            })
            return fenced
          } finally {
            if (authority.client) {
              try { await authority.client.query('ROLLBACK') } finally { authority.client.release() }
            }
          }
        })
        await this.context.pool.query(
            `UPDATE harness.project_recovery_operations SET phase='old-fenced',old_fenced_at=now(),source_schedule_digest=$3,
        stopped_generation=$4,stop_operation_id=$5,source_files_digest=$6 WHERE organization_id=$1 AND id=$2 AND phase='retiring'`,
            [
              op.organizationId,
              id,
              fence.schedule_digest,
              fence.generation,
              fence.stop_operation_id,
              fence.files_digest,
            ],
          )
      },
      actor,
      state!.generation,
      'content-publication',
    )
  }
  private async registerStop(op: PeerRecoveryOperation, actor: number, lease: RuntimeStopLease) {
    await transaction(this.context.pool, async (tx) => {
      await lockAdministrator(tx, this.context, actor)
      await lockRecoveryPolicy(tx,op)
      await checkPeerBackupNode(tx, op.organizationId, op.sourceNode, true)
      await checkPeerBackupNode(tx, op.organizationId, op.targetNode, true)
      const verified = await tx.query(
        `SELECT FROM harness.runtime_destructive_operations s JOIN harness.instances i ON i.organization_id=s.organization_id AND i.runtime_id=s.runtime_id
        JOIN harness.project_recovery_operations r ON r.organization_id=i.organization_id AND r.runtime_id=i.runtime_id
        JOIN harness.peer_backup_policies p ON p.id=r.policy_id AND p.revision=harness.recovery_policy_revision(r.id,r.policy_revision) AND p.enabled
        JOIN harness.cluster_control cc ON cc.organization_id=r.organization_id AND cc.mode='serving'
        WHERE r.id=$1 AND r.phase IN ('retire-approved','retiring') AND EXISTS(SELECT FROM harness.users u WHERE u.id=harness.recovery_retirement_actor(r.id,r.retirement_approved_by,r.retirement_approved_at) AND u.public_id=$5)
          AND NOT EXISTS(SELECT FROM harness.node_journal_deliveries j WHERE j.organization_id=r.organization_id AND j.runtime_id=r.runtime_id AND NOT j.completed)
          AND NOT EXISTS(SELECT FROM harness.node_resource_requests q WHERE q.organization_id=r.organization_id AND q.node_id=r.source_node_id
            AND q.runtime_kind='project' AND q.runtime_public_id=$6)
          AND NOT EXISTS(SELECT FROM harness.document_transfer_delivery d JOIN harness.document_scope_placement p ON p.root_id=d.root_id
            WHERE p.organization_id=r.organization_id AND p.scope_kind='project' AND p.scope_id=r.project_id AND d.delivered_at IS NULL) AND i.assigned_node_id=$2 AND s.node_id=$2 AND s.operation_id=$3
          AND s.quiescent_at IS NOT NULL AND i.generation=s.generation AND i.generation=$4 AND i.runtime_token_hash IS NULL
          AND i.desired_state='stopped' AND i.observed_state='stopping' FOR UPDATE OF s,i,r NOWAIT`,
        [op.id, op.sourceNode, lease.operationId, lease.generation, actor, op.publicId],
      ).catch((error: unknown) => {
        if (error !== null && typeof error === 'object' && 'code' in error && String(error.code) === '55P03') {
          denied('recovery-contended')
        }
        throw error
      })
      if (!verified.rowCount) denied('source-not-stopped')
      if (op.phase === 'retire-approved')
        await tx.query(
          "UPDATE harness.project_recovery_operations SET phase='retiring' WHERE id=$1 AND phase='retire-approved'",
          [op.id],
        )
    })
  }

  /** Atomically move only the proven, stopped allocation. The target must still activate its independently verified staged volume. */
  async activate(actor: number, id: string): Promise<void> {
    const op = await this.get(id)
    await this.admin(actor, async (tx) => {
      await lockRecoveryPolicy(tx,op)
      await checkPeerBackupNode(tx, op.organizationId, op.targetNode, true)
      const held = await tx.query(
        `SELECT FROM harness.project_recovery_operations r JOIN harness.peer_backup_policies p ON p.id=r.policy_id AND p.enabled AND p.revision=harness.recovery_policy_revision(r.id,r.policy_revision)
        JOIN harness.instances i ON i.organization_id=r.organization_id AND i.runtime_id=r.runtime_id AND i.project_id=r.project_id
        JOIN harness.project_content_placement b ON b.organization_id=r.organization_id AND b.project_id=r.project_id
        WHERE r.organization_id=$1 AND r.id=$2 AND r.phase='old-fenced' AND i.assigned_node_id=r.source_node_id AND i.desired_state='stopped' AND i.observed_state='stopped'
          AND i.generation=r.stopped_generation AND i.runtime_token_hash IS NULL AND b.writer_epoch=r.source_epoch AND b.volume_id=r.source_volume_id
          AND r.source_schedule_digest=r.target_schedule_digest AND harness.node_execution_available(r.organization_id,r.target_node_id)
          AND NOT EXISTS(SELECT FROM harness.runtime_destructive_operations s WHERE s.organization_id=r.organization_id AND s.runtime_id=r.runtime_id)
          FOR UPDATE OF r,i,b NOWAIT`,
        [op.organizationId, id],
      ).catch((error: unknown) => {
        if (error !== null && typeof error === 'object' && 'code' in error && String(error.code) === '55P03') {
          denied('recovery-contended')
        }
        throw error
      })
      if (!held.rowCount) denied('verified-writer-fence-required')
      await tx.query("UPDATE harness.project_recovery_operations SET phase='switching' WHERE id=$1", [id])
      await tx.query("SELECT set_config('hgw.recovery_operation',$1,true)", [id])
      if (!op.targetPortBase) denied('target-port-range-required')
      const [port] = await allocateInstancePorts(tx, op.targetNode, op.targetPortBase!, 1, op.targetNode)
      await tx.query(
        `UPDATE harness.instances SET assigned_node_id=$3,port=$4,applied_policy_revision=0,node_connection_id=NULL,
        node_connection_epoch=NULL,started_at=NULL,last_heartbeat_at=NULL,last_activity_at=NULL,updated_at=now() WHERE organization_id=$1 AND runtime_id=$2`,
        [op.organizationId, op.runtimeId, op.targetNode, port],
      )
      await tx.query('UPDATE harness.project_name_claims SET node_id=$3 WHERE organization_id=$1 AND project_id=$2', [
        op.organizationId,
        op.projectId,
        op.targetNode,
      ])
      await tx.query(
        'UPDATE harness.project_content_placement SET node_id=$3,volume_id=$4,writer_epoch=$5 WHERE organization_id=$1 AND project_id=$2',
        [op.organizationId, op.projectId, op.targetNode, op.targetVolume, op.newEpoch],
      )
      await tx.query(
        `INSERT INTO harness.project_mounts(organization_id,project_id,node_id,local_path,canonical_path,status)
        SELECT organization_id,project_id,$3,'urn:hgw:project:'||project_id::text,'urn:hgw:project:'||project_id::text,'active' FROM harness.project_content_placement
        WHERE organization_id=$1 AND project_id=$2 ON CONFLICT(project_id,node_id) DO UPDATE SET status='active',local_path=excluded.local_path,canonical_path=excluded.canonical_path`,
        [op.organizationId, op.projectId, op.targetNode],
      )
      await tx.query(
        "UPDATE harness.project_mounts SET status='missing' WHERE organization_id=$1 AND project_id=$2 AND node_id=$3",
        [op.organizationId, op.projectId, op.sourceNode],
      )
      await tx.query(
        `UPDATE harness.document_scope_placement SET node_id=$4,volume_id=$5,writer_epoch=$6 WHERE organization_id=$1
        AND scope_kind='project' AND scope_id=$2 AND node_id=$3`,
        [op.organizationId, op.projectId, op.sourceNode, op.targetNode, op.targetVolume, op.newEpoch],
      )
      await tx.query("SELECT harness.lock_document_scope_writer($1,$2,'project',$3,true)", [
        op.organizationId,
        op.targetNode,
        op.projectId,
      ])
      await tx.query("UPDATE harness.project_recovery_operations SET phase='published',published_at=now() WHERE id=$1", [id])
      await this.audit(tx, actor, 'activate', id)
    }, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['gateway-port:' + op.targetNode])
    })
  }

  /** A candidate can serve only after the committed organization pointer names this exact volume and higher writer epoch. */
  async activateTarget(id: string, signal: AbortSignal = new AbortController().signal): Promise<void> {
    const op = await this.get(id)
    if (!this.volume || op.phase !== 'published' || this.context.nodeId !== op.targetNode)
      denied('verified-writer-fence-required')
    if (!this.fileGate) denied('target-file-fence-unavailable')
    const b=recoveryBinding(op,'target')
    await this.fileGate!.admit(op.publicId, async()=>{
      const binding = `SELECT r.target_activated_at FROM harness.project_content_placement s JOIN harness.project_recovery_operations r
        ON r.organization_id=s.organization_id AND r.project_id=s.project_id AND r.runtime_id=s.runtime_id WHERE r.id=$7 AND r.phase='published'
        AND (s.organization_id,s.project_id,s.runtime_id,s.node_id,s.volume_id,s.writer_epoch)=($1,$2,$3,$4,$5,$6)`
      const coordinates=[b.organizationId,b.projectId,b.runtimeId,b.nodeId,b.volumeId,b.writerEpoch,id]
      const published=(await this.context.pool.query(binding,coordinates)).rows[0]
      if(!published) denied('verified-writer-fence-required')
      const held:{control?:PoolClient}={}
      let committed=false
      try {
        await this.volume!.writeVolume(async tx=>{
          const active=(await tx.query(`SELECT FROM node_content.recovery_candidates c JOIN node_content.spaces s USING(organization_id,project_id,runtime_id)
            WHERE c.operation_id=$1 AND c.phase='active' AND s.publication_state='published' AND c.point_id=$2 AND c.manifest_digest=$3
            AND s.writer_epoch=c.destination_epoch AND s.node_id=c.destination_node_id AND s.volume_id=c.destination_volume_id`,
            [id,op.pointId,op.digest])).rowCount===1
          if(published.target_activated_at) {
            if(!active) denied('verified-candidate-required')
            return
          }
          if(!active) {
            await this.targetFileProof(tx,op,signal)
            if(await readProjectScheduleWitness(tx,b,this.limits)!==op.scheduleDigest) denied('schedule-witness-moved')
          }
          // The local witnesses are complete. Recheck authority just before the short commit on each store.
          held.control=await this.context.pool.connect()
          await held.control.query('BEGIN')
          await lockRecoveryPolicy(held.control,op)
          await checkPeerBackupNode(held.control,op.organizationId,op.targetNode,true)
          if(!(await held.control.query(binding+' FOR SHARE OF s FOR UPDATE OF r',coordinates)).rowCount) denied('verified-writer-fence-required')
          if(active) return
          const row=await tx.query(`UPDATE node_content.recovery_candidates SET phase='active',activated_at=clock_timestamp()
            WHERE operation_id=$1 AND phase='verified' AND point_id=$2 AND manifest_digest=$3 AND schedule_digest=$4`,[id,op.pointId,op.digest,op.scheduleDigest])
          if(!row.rowCount) denied('verified-candidate-required')
          await tx.query("UPDATE node_content.spaces SET publication_state='published' WHERE organization_id=$1 AND runtime_id=$2 AND writer_epoch=$3",
            [b.organizationId,b.runtimeId,b.writerEpoch])
          await tx.query('DELETE FROM node_content.desktop_session_confirmations WHERE organization_id=$1 AND runtime_id=$2',[b.organizationId,b.runtimeId])
        },signal)
        if(held.control) {
          await held.control.query(`UPDATE harness.project_recovery_operations SET target_activated_at=clock_timestamp(),last_error=NULL
            WHERE organization_id=$1 AND id=$2 AND phase='published' AND target_activated_at IS NULL`,[op.organizationId,id])
          await held.control.query(`UPDATE harness.peer_backup_policies SET enabled=false,revision=revision+1,updated_at=clock_timestamp()
            WHERE organization_id=$1 AND id=$2 AND source_node_id=$3 AND target_node_id=$4 AND enabled`,
            [op.organizationId,op.policyId,op.sourceNode,op.targetNode])
          await held.control.query(`UPDATE harness.peer_backup_work SET status='failed',error_code='peer-backup/source-replaced',finished_at=clock_timestamp()
            WHERE organization_id=$1 AND policy_id=$2 AND status IN('running','queued')`,[op.organizationId,op.policyId])
          await held.control.query('COMMIT')
          committed=true
        }
      } finally {
        if(held.control) {
          try { if(!committed) await held.control.query('ROLLBACK') } finally { held.control.release() }
        }
      }
    })
  }
}
