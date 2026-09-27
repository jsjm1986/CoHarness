/**
 * Standalone deployment applier for the shared-PostgreSQL Gateway. Runs the
 * sanctioned maintenance sequence outside the serving process: cluster status,
 * maintenance windows, quiesced migration apply, coordinated dump+manifest
 * backups, registry or dump-file restores with managed-file reconciliation,
 * and rolling-restart ordering. `pg:deploy` wraps this script.
 */
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '../src/config.ts'
import { loadManagedNodeEnvironment } from '../src/node-config-store.ts'
import { createDeploymentCommands, DeploymentCommandError, type ManagedSnapshot } from '../src/deployment-commands.ts'
import {
  createPostgresPool,
  databaseUrlFromFile,
  migrationPlan,
  runMigrations,
} from '../src/postgres/database.ts'
import { PostgresBackupService } from '../src/postgres/backup-service.ts'
import { acquireDeploymentDataLock } from '../src/postgres/deployment-lock.ts'
import { adoptDeploymentInventory } from '../src/postgres/deployment-data.ts'
import { replaceCandidateDeploymentInventory } from '../src/postgres/deployment-inventory.ts'
import { backupFilesDirectory, PostgresDeploymentBackups } from '../src/postgres/deployment-backups.ts'
import { preservedDeploymentControlFiles, previewBackupNodeConfiguration } from '../src/postgres/deployment-control-files.ts'
import { deriveManagedRestoreSnapshot, parseManagedSnapshot, validateManagedRestoreRoots, verifyPreservedManagedFiles } from '../src/managed-files.ts'
import {
  MaintenanceError,
  PostgresMaintenanceService,
  type ClusterState,
} from '../src/postgres/maintenance-service.ts'
import { resolvePostgresRuntimeContext, type PostgresRuntimeContext } from '../src/postgres/runtime-context.ts'
import type { Pool } from 'pg'

const USAGE = `usage: pg:deploy <command> [flags]
  status                          cluster mode, node convergence, migration diff, recent operations
  maintenance enter [--reason r]  open a maintenance window (writers reject until exit)
  maintenance exit                close the window after verification
  apply [--grace-ms n]            apply pending migrations under maintenance quiesce
  backup [--dir path]             dump the database plus managed-file snapshot, verify, register
  inventory adopt --runtime id   register reviewed historical roots from HGW_MANAGED_DATA_APPROVAL_FILE
    [--configuration-revision n --replace-reviewed]
                                  replace a copied inventory with its complete reviewed candidate list
  restore [--backup id|--dump p] [--files dir] [--grace-ms n]
                                  restore under maintenance quiesce; claims a pending request first
  restart-plan                    print the rolling restart order for live nodes`

interface Flags {
  reason?: string
  dir?: string
  backup?: string
  dump?: string
  files?: string
  runtime?: string
  configurationRevision?: number
  replaceReviewed?: boolean
  graceMs: number
}

function parseArgs(argv: string[]): { command: string[]; flags: Flags } {
  const command: string[] = []
  const flags: Flags = { graceMs: 15_000 }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === '--reason') flags.reason = argv[++index]
    else if (arg === '--dir') flags.dir = argv[++index]
    else if (arg === '--backup') flags.backup = argv[++index]
    else if (arg === '--dump') flags.dump = argv[++index]
    else if (arg === '--files') flags.files = argv[++index]
    else if (arg === '--runtime') flags.runtime = argv[++index]
    else if (arg === '--replace-reviewed') flags.replaceReviewed = true
    else if (arg === '--configuration-revision') {
      const value = Number(argv[++index])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('--configuration-revision must be a positive integer')
      flags.configurationRevision = value
    }
    else if (arg === '--grace-ms') {
      const value = Number(argv[++index])
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('--grace-ms must be a non-negative integer')
      flags.graceMs = value
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}`)
    } else {
      command.push(arg)
    }
  }
  for (const key of ['reason', 'dir', 'backup', 'dump', 'files', 'runtime'] as const) {
    if (flags[key] === undefined) continue
    if (typeof flags[key] !== 'string' || flags[key] === '') throw new Error(`--${key} requires a value`)
  }
  if (flags.configurationRevision !== undefined || flags.replaceReviewed === true) {
    if (command.join(' ') !== 'inventory adopt' || flags.configurationRevision === undefined || flags.replaceReviewed !== true) {
      throw new Error('candidate inventory adoption requires inventory adopt --configuration-revision n --replace-reviewed')
    }
  }
  return { command, flags }
}

function printState(state: ClusterState): void {
  console.log(`mode=${state.mode}`)
  console.log(`maintenance_epoch=${state.maintenanceEpoch}`)
  console.log(`write_epoch=${state.writeEpoch}`)
  console.log(`writers_quiesced=${state.writersQuiesced}`)
  if (state.reason !== null) console.log(`reason=${state.reason}`)
  for (const node of state.nodes) {
    const heartbeat = node.lastHeartbeatAt === null ? 'never' : `${String(node.heartbeatAgeMs)}ms ago`
    const inflight = node.inflightWrites < 0 ? 'unreported' : String(node.inflightWrites)
    console.log(`node=${node.name} status=${node.status} heartbeat=${heartbeat} applied_epoch=${node.maintenanceAppliedEpoch} inflight_writes=${inflight} quiesced=${node.quiesced}`)
  }
}

async function contextOrUndefined(pool: Pool, slug: string, node: string): Promise<PostgresRuntimeContext | undefined> {
  try {
    return await resolvePostgresRuntimeContext(pool, slug, node)
  } catch {
    return undefined
  }
}

const { command, flags } = parseArgs(process.argv.slice(2))
const effectiveEnvironment = await loadManagedNodeEnvironment(process.env)
const cfg = loadConfig(effectiveEnvironment)
const databaseUrl = await databaseUrlFromFile(effectiveEnvironment)
const pool = createPostgresPool(databaseUrl)
const commands = createDeploymentCommands(cfg.pgDumpCommand, cfg.pgRestoreCommand, cfg.psqlCommand)


async function filesDirForDump(dumpPath: string, override?: string): Promise<string> {
  if (override !== undefined) return override
  if (dumpPath.endsWith('.dump')) return `${dumpPath.slice(0, -'.dump'.length)}.files`
  throw new Error('cannot derive the managed-file directory for this dump; pass --files')
}

async function manifestFromFilesDir(filesDir: string): Promise<ManagedSnapshot> {
  return parseManagedSnapshot(JSON.parse(await readFile(join(filesDir, 'manifest.json'), 'utf8')))
}

try {
  const context = await contextOrUndefined(pool, cfg.organizationSlug, cfg.computeNodeName)
  const maintenance = context === undefined ? undefined : new PostgresMaintenanceService(context, cfg.nodeStaleMs)
  const backups = context === undefined ? undefined : new PostgresBackupService(context)
  const verb = command[0]

  if (verb === 'status' && command.length === 1) {
    const plan = await migrationPlan(pool, cfg.deployMigrationsDir)
    if (maintenance !== undefined) printState(await maintenance.state())
    console.log(`migration_current=${plan.current}`)
    console.log(`migration_pending=${plan.pending.map(m => m.name).join(',') || 'none'}`)
    if (plan.drifted.length > 0) console.log(`migration_drifted=${plan.drifted.join(',')}`)
    if (maintenance !== undefined) {
      for (const op of await maintenance.listOperations(10)) {
        console.log(`operation=${op.kind} status=${op.status} at=${op.createdAt}${op.error === null ? '' : ` error=${op.error}`}`)
      }
    }
  } else if (verb === 'maintenance' && command[1] === 'enter' && command.length === 2) {
    if (maintenance === undefined) throw new Error('organization is not provisioned; run migrations first')
    printState(await maintenance.enterMaintenance(null, flags.reason))
  } else if (verb === 'maintenance' && command[1] === 'exit' && command.length === 2) {
    if (maintenance === undefined) throw new Error('organization is not provisioned')
    printState(await maintenance.exitMaintenance(null))
  } else if (verb === 'apply' && command.length === 1) {
    if (maintenance !== undefined) {
      const state = await maintenance.state()
      if (state.mode === 'restoring') throw new MaintenanceError(409, 'restore-in-progress')
      if (state.mode !== 'maintenance') {
        console.error('warning: applying outside a maintenance window; run `pg:deploy maintenance enter` first for coordinated upgrades')
      } else if (!state.writersQuiesced) {
        throw new MaintenanceError(409, 'writers-not-quiesced')
      }
      if (state.mode === 'maintenance' && flags.graceMs > 0) await delay(flags.graceMs)
    }
    const operation = maintenance === undefined ? undefined
      : await maintenance.logOperation('apply', 'running', null, {})
    try {
      const result = await runMigrations(pool, cfg.deployMigrationsDir)
      if (maintenance !== undefined && operation !== undefined) {
        await maintenance.finishOperation(operation, 'completed', { applied: result.applied, current: result.current })
      }
      console.log(JSON.stringify(result))
    } catch (error) {
      if (maintenance !== undefined && operation !== undefined) {
        await maintenance.finishOperation(operation, 'failed',
          { error: error instanceof Error ? error.message : String(error) })
      }
      throw error
    }
  } else if (verb === 'inventory' && command[1] === 'adopt' && command.length === 2) {
    if (context === undefined || maintenance === undefined) throw new Error('organization is not provisioned')
    if (flags.runtime === undefined) throw new Error('inventory adopt requires --runtime user:<id> or project:<id>')
    await using adopting = await acquireDeploymentDataLock(pool)
    adopting.signal.throwIfAborted()
    const candidate = flags.configurationRevision === undefined ? undefined
      : await replaceCandidateDeploymentInventory(context, cfg, effectiveEnvironment, flags.runtime, flags.configurationRevision, adopting.signal)
    const roots = candidate === undefined ? await adoptDeploymentInventory(context, cfg, flags.runtime) : candidate.roots
    adopting.signal.throwIfAborted()
    await maintenance.logOperation('backup', 'completed', null, { action: 'adopt-inventory', runtime: flags.runtime, roots,
      ...(candidate === undefined ? {} : { configurationRevision: flags.configurationRevision, preservedInventory: candidate.evidence }) })
    console.log(`inventory=${flags.runtime} registered_roots=${roots.length}`)
    if (candidate !== undefined) console.log(`preserved_inventory=${candidate.evidence}`)
  } else if (verb === 'backup' && command.length === 1) {
    if (context === undefined) throw new Error('organization is not provisioned; run migrations first')
    const verified = await new PostgresDeploymentBackups(context, cfg, databaseUrl, commands, effectiveEnvironment).create(null, flags.dir)
    console.log(`backup=${verified.path}`)
    console.log(`backup_id=${verified.id}`)
  } else if (verb === 'restore' && command.length === 1) {
    if (context === undefined || maintenance === undefined || backups === undefined) throw new Error('organization is not provisioned')
    await using restoring = await acquireDeploymentDataLock(pool)
    let pending: Awaited<ReturnType<PostgresMaintenanceService['claimRestoreRequest']>>
    try {
      const state = await maintenance.state()
      if (state.mode !== 'maintenance' && state.mode !== 'restoring') throw new MaintenanceError(409, 'restore-requires-maintenance')
      if (!state.writersQuiesced) throw new MaintenanceError(409, 'writers-not-quiesced')
      if (flags.backup !== undefined && flags.dump !== undefined) throw new Error('restore accepts only one of --backup or --dump')
      let checkpoint: Record<string, unknown> | undefined
      if (state.mode === 'restoring') {
        checkpoint = (await pool.query<{ detail: Record<string, unknown> }>(
          `SELECT detail FROM harness.deployment_operations WHERE organization_id=$1 AND kind='restore'
           AND status='running' AND detail->>'checkpointVersion'='1' AND detail->>'maintenanceEpoch'=$2
           ORDER BY created_at DESC LIMIT 1`, [context.organizationId, state.maintenanceEpoch])).rows[0]?.detail
        if (checkpoint === undefined || typeof checkpoint.protectionId !== 'string') throw new MaintenanceError(409, 'restore-protection-checkpoint-missing')
      } else if (flags.backup === undefined && flags.dump === undefined) pending = await maintenance.claimRestoreRequest()
      let backupId = flags.backup ?? (flags.dump === undefined && typeof checkpoint?.backupId === 'string' ? checkpoint.backupId : undefined)
      let dumpPath = flags.dump ?? (typeof checkpoint?.dumpPath === 'string' ? checkpoint.dumpPath : undefined)
      let manifest: ManagedSnapshot | undefined
      let expectedDumpHash: string | undefined
      if (pending !== undefined) {
        const detail = pending.detail as { backupId?: unknown }
        if (typeof detail.backupId !== 'string') throw new Error('pending restore request carries no backupId')
        backupId = detail.backupId
      }
      if (backupId !== undefined) {
        const record = await backups.get(backupId)
        dumpPath = record.path
        if (record.managedSnapshot === null || record.sha256 === null) throw new MaintenanceError(409, 'backup-lacks-complete-managed-data-manifest')
        manifest = record.managedSnapshot
        expectedDumpHash = record.sha256
        if (record.status !== 'verified' && record.status !== 'restored') {
          throw new MaintenanceError(409, 'backup-not-verified')
        }
      }
      if (dumpPath === undefined) {
        throw new Error('restore requires --backup <id>, --dump <path>, or a pending admin restore request')
      }
      const filesDir = await filesDirForDump(dumpPath, flags.files ?? (typeof checkpoint?.filesDir === 'string' ? checkpoint.filesDir : undefined))
      manifest ??= await manifestFromFilesDir(filesDir).catch(() => {
        throw new Error(`managed-file manifest unreadable under ${filesDir}; pass --files or fix the snapshot`)
      })
      const targetHash = await commands.verifyDump(dumpPath, restoring.signal, expectedDumpHash)
      await commands.verifyStoredFiles(filesDir, manifest, restoring.signal)
      const diskManifest = await manifestFromFilesDir(filesDir)
      if (JSON.stringify(diskManifest) !== JSON.stringify(manifest)) throw new Error('backup manifest differs from registry')
      const manifestHash = createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
      const backupWork = new PostgresDeploymentBackups(context, cfg, databaseUrl, commands, effectiveEnvironment)
      const nodePreview = await previewBackupNodeConfiguration(backupId ?? targetHash, manifest, filesDir, context, cfg, effectiveEnvironment)
      if (nodePreview.incompatibleFields.length > 0) throw new MaintenanceError(409,
        `backup-data-paths-require-explicit-migration:${nodePreview.incompatibleFields.join(',')}`)
      let protectionId: string
      if (state.mode === 'restoring') {
        if (!state.writersQuiesced) throw new MaintenanceError(409, 'writers-not-quiesced')
        await maintenance.resumeRestoring()
        const detail = checkpoint!
        if (detail.backupId !== (backupId ?? null) || detail.targetHash !== targetHash || detail.manifestHash !== manifestHash || detail.dumpPath !== resolve(dumpPath)
          || detail.filesDir !== resolve(filesDir) || detail.nodeId !== context.nodeId) throw new MaintenanceError(409, 'restore-recovery-target-mismatch')
        protectionId = detail.protectionId as string
      } else {
        // This copy precedes the fence transition and every destructive operation.
        // It is referenced atomically with the fence so a retry cannot replace it.
        const protection = await backupWork.createWithinLease(null, cfg.backupDir, restoring.signal)
        protectionId = protection.id
      }
      const protectedBackup = await backupWork.verify(protectionId, restoring.signal)
      if (protectedBackup.managedSnapshot === null) throw new MaintenanceError(409, 'restore-protection-manifest-missing')
      const managedPaths = protectedBackup.managedSnapshot.roots
      const preserved = await preservedDeploymentControlFiles({ id: backupId ?? targetHash, snapshot: manifest, filesDir },
        { snapshot: protectedBackup.managedSnapshot, filesDir: backupFilesDirectory(protectedBackup.path) }, context, cfg, effectiveEnvironment)
      const expected = deriveManagedRestoreSnapshot(manifest, preserved)
      const restoredManifestHash = createHash('sha256').update(JSON.stringify(expected)).digest('hex')
      if (checkpoint !== undefined && checkpoint.restoredManifestHash !== restoredManifestHash) throw new MaintenanceError(409, 'restore-recovery-policy-mismatch')
      await validateManagedRestoreRoots(expected, managedPaths)
      await verifyPreservedManagedFiles(preserved, restoring.signal)
      if (state.mode === 'maintenance') await maintenance.beginRestore(null, backupId, {
        checkpointVersion: 1, protectionId, maintenanceEpoch: state.maintenanceEpoch,
        dumpPath: resolve(dumpPath), filesDir: resolve(filesDir), targetHash, manifestHash, restoredManifestHash, nodeId: context.nodeId,
      })
      if (flags.graceMs > 0) await delay(flags.graceMs, undefined, { signal: restoring.signal })
      await commands.verifyDump(dumpPath, restoring.signal, targetHash)
      await commands.restoreDump(dumpPath, databaseUrl, restoring, targetHash)
      await maintenance.resumeRestoring()
      const mismatchedBefore = await commands.verifyManagedFiles(expected, restoring.signal)
      await commands.restoreManagedFiles(filesDir, manifest, managedPaths, restoring.signal, preserved)
      const mismatched = await commands.verifyManagedFiles(expected, restoring.signal)
      restoring.signal.throwIfAborted()
      if (mismatched.length > 0) {
        throw new DeploymentCommandError(`restore left managed files inconsistent: ${mismatched.join(',')}`)
      }
      await maintenance.completeRestore(null, backupId, {
        dumpPath,
        filesDir,
        managedFiles: manifest.files.length,
        driftBefore: mismatchedBefore,
        mismatchedAfter: mismatched,
        protectionId,
        protectionPath: protectedBackup.path,
        protectionFilesDir: backupFilesDirectory(protectedBackup.path),
        restoredManifestHash,
        preservedControlPaths: preserved.paths,
      })
      if (pending !== undefined) await maintenance.finishOperation(pending.id, 'completed', { backupId: backupId ?? null, dumpPath })
      console.log(`restore=ok dump=${dumpPath} files=${filesDir} epoch=advanced`)
    } catch (error) {
      // completeRestore may already have returned the window to maintenance;
      // only a still-restoring control row can take the failure transition.
      const current = await maintenance.state().catch(() => undefined)
      if (current?.mode === 'restoring') {
        await maintenance.failRestore(null, error instanceof Error ? error.message : String(error))
      }
      if (pending !== undefined) {
        const pendingId = pending.id
        const view = await maintenance.listOperations()
        const pendingOp = view.find(op => op.id === pendingId)
        if (pendingOp !== undefined && (pendingOp.status === 'pending' || pendingOp.status === 'running')) {
          await maintenance.finishOperation(pending.id, 'failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }
      throw error
    }
  } else if (verb === 'restart-plan' && command.length === 1) {
    if (maintenance === undefined) throw new Error('organization is not provisioned')
    const state = await maintenance.state()
    const live = state.nodes.filter(node => node.status !== 'offline')
    if (live.length === 0) { console.log('restart_plan=no live nodes'); process.exit(0) }
    live.forEach((node, index) => {
      console.log(`${index + 1}. drain node=${node.name} (admin api deployment/nodes/status or pg:deploy maintenance)`)
      console.log(`   stop unit, apply release, start unit`)
      console.log(`   wait heartbeat fresh then reactivate before the next node`)
    })
  } else {
    console.error(USAGE)
    process.exit(2)
  }
} finally {
  await pool.end()
}
