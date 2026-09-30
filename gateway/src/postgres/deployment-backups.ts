/** Shared Admin/CLI backup admission, copied-data proof and durable registration. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { GatewayConfig } from '../config.ts'
import type { DeploymentCommands } from '../deployment-commands.ts'
import { parseManagedSnapshot } from '../managed-files.ts'
import { PostgresBackupService, BackupError, type BackupRecordView } from './backup-service.ts'
import { migrationPlan } from './database.ts'
import { collectDeploymentData } from './deployment-data.ts'
import { previewBackupNodeConfiguration, type BackupNodeConfigurationView } from './deployment-control-files.ts'
import { acquireDeploymentDataLock } from './deployment-lock.ts'
import { MaintenanceError, PostgresMaintenanceService } from './maintenance-service.ts'
import type { PostgresRuntimeContext } from './runtime-context.ts'

/** Dump paths and their immutable sibling file snapshots share the same generated basename. */
export function backupFilesDirectory(dumpPath: string): string {
  if (!dumpPath.endsWith('.dump')) throw new BackupError(409, 'backup-file-directory-unknown')
  return `${dumpPath.slice(0, -'.dump'.length)}.files`
}

export class PostgresDeploymentBackups {
  private readonly maintenance: PostgresMaintenanceService
  private readonly records: PostgresBackupService

  /** Bind operations to this node, its database and the configured PostgreSQL tools. */
  constructor(
    private readonly context: PostgresRuntimeContext,
    private readonly cfg: GatewayConfig,
    private readonly databaseUrl: string,
    private readonly commands: DeploymentCommands,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.maintenance = new PostgresMaintenanceService(context, cfg.nodeStaleMs)
    this.records = new PostgresBackupService(context)
  }

  /**
   * Capture the database and all claimed local data only after writers have stopped.
   * @param actor - administrator public ID, or null for the independent applier.
   * @param directory - CLI-owned output override; never accepted from a Web request.
   * @returns a verified registry row tied to the unchanged write epoch.
   */
  async create(actor: number | null, directory = this.cfg.backupDir): Promise<BackupRecordView> {
    await using lease = await acquireDeploymentDataLock(this.context.pool)
    return await this.createWithinLease(actor, directory, lease.signal)
  }

  /**
   * Capture a pre-restore protection copy while the restore caller owns the data lease.
   * @param actor - initiating administrator, or null for the applier.
   * @param directory - private node-owned artifact directory.
   * @param signal - the caller's acquired deployment data lease.
   * @returns a complete verified backup; no restoration may precede this result.
   */
  async createWithinLease(actor: number | null, directory: string, signal: AbortSignal): Promise<BackupRecordView> {
    signal.throwIfAborted()
    const state = await this.maintenance.state()
    if (state.mode !== 'maintenance') throw new MaintenanceError(409, 'backup-requires-maintenance')
    if (!state.writersQuiesced) throw new MaintenanceError(409, 'writers-not-quiesced')
    const operation = await this.maintenance.logOperation('backup', 'running', actor, {})
    try {
      const roots = await collectDeploymentData(this.context, this.cfg)
      const dump = await this.commands.backup(directory, this.databaseUrl, roots, signal)
      const plan = await migrationPlan(this.context.pool, this.cfg.deployMigrationsDir)
      const record = await this.records.record({ path: dump.dumpPath, migrationVersion: plan.current,
        writeEpoch: BigInt(state.writeEpoch), sizeBytes: dump.sizeBytes, sha256: dump.sha256,
        managedSnapshot: dump.managedSnapshot, actor })
      const verified = await this.verify(record.id, signal)
      signal.throwIfAborted()
      await this.maintenance.finishOperation(operation, 'completed', { backupId: verified.id, path: verified.path,
        files: dump.managedSnapshot.files.length, roots: dump.managedSnapshot.roots.length })
      return verified
    } catch (error) {
      await this.maintenance.finishOperation(operation, 'failed', { error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }

  /**
   * Verify both the dump identity and every copied data member against the registry.
   * @param id - organization-scoped backup record.
   * @param signal - optional operation lease lifetime.
   * @returns the verified row; failure is recorded and propagated.
   */
  async verify(id: string, signal?: AbortSignal): Promise<BackupRecordView> {
    const record = await this.records.get(id)
    try {
      if (record.managedSnapshot === null || record.sha256 === null) throw new BackupError(409, 'backup-lacks-complete-managed-data-manifest')
      const filesDir = backupFilesDirectory(record.path)
      const stored = parseManagedSnapshot(JSON.parse(await readFile(join(filesDir, 'manifest.json'), 'utf8')))
      if (JSON.stringify(stored) !== JSON.stringify(record.managedSnapshot)) throw new BackupError(409, 'backup-manifest-differs-from-registry')
      await this.commands.verifyDump(record.path, signal, record.sha256)
      await this.commands.verifyStoredFiles(filesDir, stored, signal)
      signal?.throwIfAborted()
      return await this.records.setVerified(id, true)
    } catch (error) {
      await this.records.setVerified(id, false, error instanceof Error ? error.message : String(error))
      throw error
    }
  }

  /**
   * Read applied non-secret node settings only after the complete backup passes verification.
   * @param id - organization-scoped backup registry identity.
   * @returns settings for explicit review; the operation never saves or applies them.
   */
  async previewNodeConfiguration(id: string): Promise<BackupNodeConfigurationView> {
    const record = await this.verify(id)
    return previewBackupNodeConfiguration(id, record.managedSnapshot!, backupFilesDirectory(record.path),
      this.context, this.cfg, this.environment)
  }
}
