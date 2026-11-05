/** Each Gateway performs only the phase addressed to its own computer and rechecks the current policy before every apply. */
import type { InstanceManager } from './instances.ts'
import type { NodeContentStore } from './node-content-store.ts'
import { checkPeerBackupNode } from './peer-backup-governance.ts'
import type { PeerBackupDrill } from './peer-backup-restic.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import type { PeerProjectFileGate } from './peer-backup-file-gate.ts'
import { stagePeerProjectFiles, type PeerProjectReplacementLayout } from './peer-backup-takeover-files.ts'
import { assertReleasedRecoveryPaths, PeerRecoveryStageRoots } from './peer-backup-takeover-reservations.ts'
import { discardPeerCandidate, stagePeerProject } from './peer-backup-takeover-stage.ts'
import { PeerProjectRecovery, type PeerRecoveryOperation } from './peer-backup-takeover.ts'

export interface PeerTakeoverDependencies {
  workGate: Pick<PeerProjectFileGate,'exclusive'>
  service: PeerProjectRecovery
  volume: Pick<NodeContentStore, 'writeVolume' | 'readVolume'>
  instances: Pick<InstanceManager, 'withStopped'>
  layout(op: PeerRecoveryOperation): Promise<PeerProjectReplacementLayout>
  drill(op: PeerRecoveryOperation, signal: AbortSignal): Promise<PeerBackupDrill>
  limits: { maxBytes: number; maxRows: number; reserveBytes: number }
}

/** Recover one durable approver-scoped phase without acquiring any browser or Runtime ownership. */
export async function runPeerRecoveryPhase(deps: PeerTakeoverDependencies, signal: AbortSignal): Promise<void> {
  const { service, volume } = deps,
    context = service.context
  const selected = (
      await context.pool.query<{ id: string; project:number; phase:string }>(
        `SELECT r.id,r.phase,project.public_id::float8 project FROM harness.project_recovery_operations r
      JOIN harness.projects project ON project.organization_id=r.organization_id AND project.id=r.project_id
      JOIN harness.peer_backup_policies p ON p.id=r.policy_id
      WHERE r.organization_id=$1 AND r.retry_at<=clock_timestamp() AND (
        (r.phase='cancelled' AND r.target_node_id=$2 AND NOT EXISTS(SELECT FROM harness.project_recovery_cleanups c WHERE c.operation_id=r.id))
        OR p.revision=harness.recovery_policy_revision(r.id,r.policy_revision) AND p.enabled AND
          (r.target_node_id=$2 AND (r.phase='prepared' OR r.phase='published' AND r.target_activated_at IS NULL)
          OR r.source_node_id=$2 AND r.phase IN('retire-approved','retiring')))
      ORDER BY (r.phase='cancelled') DESC,r.retry_at,r.created_at LIMIT 1`,
        [context.organizationId, context.nodeId],
      )
    ).rows[0]
    if (!selected) return
  try {
    await deps.workGate.exclusive(selected.project, async () => {
    try {
      signal.throwIfAborted()
      await checkPeerBackupNode(context.pool, context.organizationId, context.nodeId, true)
      const op = await service.get(selected.id)
      const reservations=new PeerRecoveryStageRoots(volume,op)
      if(op.phase==='cancelled' && op.targetNode===context.nodeId){
        await service.assertUnpublishedDestination(op,'cancelled')
        await discardPeerCandidate(volume,op,signal)
        await reservations.withdraw()
        await assertReleasedRecoveryPaths(await deps.layout(op))
        await service.acknowledgeCleanup(op)
      } else if (op.phase === 'prepared' && op.targetNode === context.nodeId) {
        const staged = (
          await volume.readVolume(
            async (db) =>
              db.query(
                `SELECT FROM node_content.recovery_candidates WHERE operation_id=$1
          AND destination_volume_id=$2 AND point_id=$3 AND manifest_digest=$4 AND phase='verified'`,
                [op.id, op.targetVolume, op.pointId, op.digest],
              ),
            signal,
          )
        ).rowCount
        if (!staged) {
          await service.assertUnpublishedDestination(op,'prepared')
          const drill = await deps.drill(op, signal)
          try {
            await service.assertUnpublishedDestination(op,'prepared')
            await reservations.withdraw()
            const layout = await deps.layout(op)
            const files = await stagePeerProjectFiles(op, drill, layout, deps.limits, signal, reservations)
            await stagePeerProject(volume, op, drill, files, deps.limits, signal)
          } finally {
            await drill.dispose()
          }
        }
        await service.confirmTarget(op.id, signal)
      } else if (op.phase === 'published' && op.targetNode === context.nodeId) await service.activateTarget(op.id, signal)
      else if (
        ['retire-approved', 'retiring'].includes(op.phase) &&
        op.sourceNode === context.nodeId &&
        op.retirementActor !== null
      )
        await service.retireSource(op.id, op.retirementActor, deps.instances, signal)
    } catch (error) {
      if (signal.aborted) throw error
      const reason = error instanceof PeerBackupError ? error.code : 'peer-backup/recovery-unavailable'
      await context.pool.query(
        `UPDATE harness.project_recovery_operations SET retry_at=clock_timestamp()+interval '1 minute',last_error=$3
        WHERE organization_id=$1 AND id=$2 AND phase=$4`,
        [context.organizationId, selected.id, reason,selected.phase],
      )
    }
    })
  } catch(error) {
    if(!(error instanceof PeerBackupError && error.code==='peer-backup/project-files-busy')) throw error
  }
}
