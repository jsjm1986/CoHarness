/** Coordinated restores retain the destination's exact committed migration set. */
import type { DumpMigration } from '../pg-dump-schema.ts'
import type { Queryable } from './database.ts'
import { BackupError } from './backup-service.ts'

/**
 * Refuse a registered backup from a different schema before accepting its restore request.
 * @param database - current destination transaction.
 * @param version - migration version recorded for the verified backup.
 * @returns after the recorded version matches the destination.
 */
export async function assertRestoreMigrationVersion(database: Queryable, version: number): Promise<void> {
  const current = await database.query<{ version: number }>('SELECT COALESCE(MAX(version),0) version FROM harness.schema_migrations')
  if (current.rows[0]!.version !== version) throw new BackupError(409, 'backup-schema-version-mismatch')
}

/**
 * Check actual dump metadata before opening the restoring fence or replacing managed files.
 * @param database - destination whose deployment data lease the caller holds.
 * @param migrations - validated identities rendered from the selected immutable dump.
 * @returns after all migration versions, names and checksums match.
 */
export async function assertRestoreSchema(database: Queryable, migrations: readonly DumpMigration[]): Promise<void> {
  const current = await database.query<DumpMigration>('SELECT version,name,checksum FROM harness.schema_migrations ORDER BY version')
  if (current.rows.length !== migrations.length || current.rows.some((row, index) => {
    const source = migrations[index]!
    return row.version !== source.version || row.name !== source.name || row.checksum !== source.checksum
  })) throw new BackupError(409, 'backup-schema-differs-from-destination')
}
