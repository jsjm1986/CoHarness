/**
 * Backup registry binding each `pg_dump` artifact to its managed-file
 * manifest and the write epoch it was taken under. The registry is what makes
 * a restore auditable: the applier verifies the dump and records the outcome
 * on the same row administrators read.
 */
import { publicNumber, type PostgresRuntimeContext } from './runtime-context.ts'
import type { ManagedFileEntry } from '../deployment-commands.ts'

export type BackupStatus = 'recording' | 'verified' | 'failed' | 'restored'

/** Administrator-facing backup row; carries no dump contents or secrets. */
export interface BackupRecordView {
  id: string
  path: string
  format: string
  migrationVersion: number
  writeEpoch: string
  sizeBytes: number | null
  sha256: string | null
  managedFiles: ManagedFileEntry[]
  status: BackupStatus
  createdBy: number | null
  createdAt: string
  verifiedAt: string | null
  restoredAt: string | null
  error: string | null
}

/** A registry request was invalid or addressed a missing backup row. */
export class BackupError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}

function view(row: Record<string, unknown>): BackupRecordView {
  const files = row.managed_files
  return {
    id: String(row.id),
    path: String(row.path),
    format: String(row.format),
    migrationVersion: Number(row.migration_version),
    writeEpoch: String(row.write_epoch),
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    sha256: row.sha256 as string | null,
    managedFiles: Array.isArray(files) ? files as ManagedFileEntry[] : [],
    status: row.status as BackupStatus,
    createdBy: row.created_by === null ? null : publicNumber(row.created_by as string | number, 'backup actor'),
    createdAt: String(row.created_at),
    verifiedAt: row.verified_at as string | null,
    restoredAt: row.restored_at as string | null,
    error: row.error as string | null,
  }
}

const PROJECTION = `SELECT b.id,b.path,b.format,b.migration_version,b.write_epoch,b.size_bytes,b.sha256,
  b.managed_files,b.status,(SELECT u.public_id FROM harness.users u WHERE u.id=b.created_by) created_by,
  b.created_at,b.verified_at,b.restored_at,b.error FROM harness.backup_records b`

export class PostgresBackupService {
  /** @param context - database and organization owned by this Gateway */
  constructor(private readonly context: PostgresRuntimeContext) {}

  /** Newest-first registry rows for the admin deployment page and the applier. */
  async list(limit = 50): Promise<BackupRecordView[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('backup limit out of range')
    const result = await this.context.pool.query<Record<string, unknown>>(
      `${PROJECTION} WHERE b.organization_id=$1 ORDER BY b.created_at DESC LIMIT $2`,
      [this.context.organizationId, limit],
    )
    return result.rows.map(view)
  }

  /** One registry row or 404; the applier resolves the pending restore target through it. */
  async get(id: string): Promise<BackupRecordView> {
    const result = await this.context.pool.query<Record<string, unknown>>(
      `${PROJECTION} WHERE b.organization_id=$1 AND b.id=$2`,
      [this.context.organizationId, id],
    )
    const row = result.rows[0]
    if (row === undefined) throw new BackupError(404, 'backup-not-found')
    return view(row)
  }

  /**
   * Record a finished dump with its managed-file manifest. `migrationVersion`
   * and `writeEpoch` pin the backup to the schema and fencing it was taken
   * under so a restore can report drift instead of guessing.
   */
  async record(input: {
    path: string
    migrationVersion: number
    writeEpoch: bigint
    sizeBytes: number
    sha256: string
    managedFiles: ManagedFileEntry[]
    /** Public user number of the administrator, or null for the applier. */
    actor: number | null
  }): Promise<BackupRecordView> {
    let actorUuid: string | null = null
    if (input.actor !== null) {
      const user = await this.context.pool.query<{ id: string }>(
        'SELECT id FROM harness.users WHERE organization_id=$1 AND public_id=$2',
        [this.context.organizationId, String(input.actor)],
      )
      actorUuid = user.rows[0]?.id ?? null
    }
    const inserted = await this.context.pool.query<{ id: string }>(
      `INSERT INTO harness.backup_records(organization_id,path,migration_version,write_epoch,size_bytes,sha256,managed_files,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [this.context.organizationId, input.path, input.migrationVersion, input.writeEpoch.toString(),
        input.sizeBytes, input.sha256, JSON.stringify(input.managedFiles), actorUuid],
    )
    return this.get(inserted.rows[0]!.id)
  }

  /** Mark a dump verified (`pg_restore --list` succeeded) or failed. */
  async setVerified(id: string, verified: boolean, error?: string): Promise<BackupRecordView> {
    const updated = await this.context.pool.query(
      `UPDATE harness.backup_records SET status=$3, verified_at=CASE WHEN $3='verified' THEN now() ELSE verified_at END, error=$4
       WHERE organization_id=$1 AND id=$2 AND status IN ('recording','verified','failed')`,
      [this.context.organizationId, id, verified ? 'verified' : 'failed', error ?? null],
    )
    if (updated.rowCount !== 1) throw new BackupError(409, 'backup-state-conflict')
    return this.get(id)
  }
}
