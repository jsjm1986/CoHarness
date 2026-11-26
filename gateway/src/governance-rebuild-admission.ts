/** HTTP admission for the governance database generation loaded by this Gateway. */
import type { PostgresRuntimeContext } from './postgres/runtime-context.ts'
import { PeerBackupError } from './peer-backup-repository.ts'

/** Restricted admission ends only after explicit administrator review releases this recovery. */
export interface GovernanceRebuildAdmissionSnapshot {
  operationId: string
  bootstrapUserId: number
  state: 'review' | 'released'
}

interface AdmissionRow extends GovernanceRebuildAdmissionSnapshot {
  targetNodeId: string
  recoveryEpoch: string
  writeEpoch: string | null
}

function unavailable(): never {
  throw new PeerBackupError(503, 'peer-backup/governance-admission-unavailable')
}

async function read(context: PostgresRuntimeContext): Promise<AdmissionRow | undefined> {
  return (await context.pool.query<AdmissionRow>(`SELECT r.id "operationId",u.public_id::float8 "bootstrapUserId",
    r.state,r.target_node_id "targetNodeId",r.recovery_epoch::text "recoveryEpoch",c.write_epoch::text "writeEpoch"
    FROM harness.governance_rebuild_operations r
    LEFT JOIN harness.users u ON u.organization_id=r.organization_id AND u.id=r.bootstrap_user_id
    LEFT JOIN harness.cluster_control c ON c.organization_id=r.organization_id
    WHERE r.organization_id=$1 ORDER BY r.recovery_epoch DESC LIMIT 1`, [context.organizationId])).rows[0]
}

/**
 * Bind ingress to one offline import and its write epoch. A fresh import requires
 * an empty database before Gateway startup; it cannot be introduced into a
 * serving organization. Ordinary organizations have no per-request lookup.
 */
export class GovernanceRebuildAdmission {
  private released: GovernanceRebuildAdmissionSnapshot | undefined

  private constructor(private readonly context: PostgresRuntimeContext, private readonly binding: AdmissionRow) {
    if (binding.state === 'released') this.released = this.snapshot(binding)
  }

  /**
   * Inspect the loaded database generation before opening listeners or launching work.
   * @param context - current organization database and node identity.
   * @param writeEpoch - epoch captured before other Gateway dependencies load.
   * @returns the recovery guard, or undefined when the organization has never been rebuilt.
   */
  static async open(context: PostgresRuntimeContext, writeEpoch: bigint): Promise<GovernanceRebuildAdmission | undefined> {
    const row = await read(context)
    if (row === undefined) return undefined
    if (row.writeEpoch !== String(writeEpoch) || !Number.isSafeInteger(row.bootstrapUserId) || row.bootstrapUserId < 1) unavailable()
    return new GovernanceRebuildAdmission(context, row)
  }

  private snapshot(row: AdmissionRow): GovernanceRebuildAdmissionSnapshot {
    return { operationId: row.operationId, bootstrapUserId: row.bootstrapUserId, state: row.state }
  }

  private async current(): Promise<AdmissionRow> {
    const row = await read(this.context)
    if (row === undefined || row.operationId !== this.binding.operationId || row.recoveryEpoch !== this.binding.recoveryEpoch
      || row.writeEpoch !== this.binding.writeEpoch || row.targetNodeId !== this.binding.targetNodeId
      || row.bootstrapUserId !== this.binding.bootstrapUserId || this.released !== undefined && row.state !== 'released') unavailable()
    return row
  }

  /**
   * Recheck the database generation before a dedicated recovery operation, including after release.
   * @throws If the database no longer names this process's import and write epoch.
   */
  async verifyAdministration(): Promise<void> {
    await this.current()
  }

  /**
   * Read the current review state without accepting a different database generation.
   * A released recovery stays released for this process; ordinary write-epoch fencing still applies.
   * @returns the bound bootstrap administrator and recovery state.
   */
  async admission(): Promise<GovernanceRebuildAdmissionSnapshot> {
    if (this.released !== undefined) return this.released
    const row = await this.current()
    const current = this.snapshot(row)
    if (current.state === 'released') this.released = current
    return current
  }
}
