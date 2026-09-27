/**
 * Standalone deployment applier for the shared-PostgreSQL Gateway. Runs the
 * sanctioned maintenance sequence outside the serving process: cluster status,
 * maintenance windows, quiesced migration apply, coordinated dump+manifest
 * backups, registry or dump-file restores with managed-file reconciliation,
 * and rolling-restart ordering. `pg:deploy` wraps this script.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { loadConfig } from '../src/config.ts'
import { createDeploymentCommands, DeploymentCommandError, type ManagedFileEntry } from '../src/deployment-commands.ts'
import {
  createPostgresPool,
  databaseUrlFromFile,
  migrationPlan,
  runMigrations,
} from '../src/postgres/database.ts'
import { PostgresBackupService } from '../src/postgres/backup-service.ts'
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
  restore [--backup id|--dump p] [--files dir] [--grace-ms n]
                                  restore under maintenance quiesce; claims a pending request first
  restart-plan                    print the rolling restart order for live nodes`

interface Flags {
  reason?: string
  dir?: string
  backup?: string
  dump?: string
  files?: string
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
  for (const key of ['reason', 'dir', 'backup', 'dump', 'files'] as const) {
    if (flags[key] === undefined) continue
    if (typeof flags[key] !== 'string' || flags[key] === '') throw new Error(`--${key} requires a value`)
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
const cfg = loadConfig()
const databaseUrl = await databaseUrlFromFile()
const pool = createPostgresPool(databaseUrl)
const commands = createDeploymentCommands(cfg.pgDumpCommand, cfg.pgRestoreCommand)
const managedPaths = [
  cfg.principalKeyDir,
  cfg.runtimeCredentialDir,
  cfg.organizationModelCredentialKeyFile,
  cfg.webhookSecretKeyFile,
  cfg.bootstrapAdminPasswordFile,
]

async function filesDirForDump(dumpPath: string, override?: string): Promise<string> {
  if (override !== undefined) return override
  if (dumpPath.endsWith('.dump')) return `${dumpPath.slice(0, -'.dump'.length)}.files`
  throw new Error('cannot derive the managed-file directory for this dump; pass --files')
}

async function manifestFromFilesDir(filesDir: string): Promise<ManagedFileEntry[]> {
  const raw = await readFile(join(filesDir, 'manifest.json'), 'utf8')
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('managed-file manifest is not an array')
  return parsed.map((entry): ManagedFileEntry => {
    if (entry === null || typeof entry !== 'object') throw new Error('managed-file manifest entry is not an object')
    const row = entry as Record<string, unknown>
    if (typeof row.member !== 'string' || typeof row.sourcePath !== 'string'
      || typeof row.sizeBytes !== 'number' || typeof row.sha256 !== 'string') {
      throw new Error('managed-file manifest entry is malformed')
    }
    return { member: row.member, sourcePath: row.sourcePath, sizeBytes: row.sizeBytes, sha256: row.sha256 }
  })
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
  } else if (verb === 'backup' && command.length === 1) {
    if (maintenance === undefined || backups === undefined) throw new Error('organization is not provisioned; run migrations first')
    const backupDir = flags.dir ?? cfg.backupDir
    const opId = await maintenance.logOperation('backup', 'running', null, {})
    try {
      const dump = await commands.backup(backupDir, databaseUrl, managedPaths)
      const plan = await migrationPlan(pool, cfg.deployMigrationsDir)
      const writeEpoch = await maintenance.currentWriteEpoch()
      const record = await backups.record({
        path: dump.dumpPath, migrationVersion: plan.current, writeEpoch,
        sizeBytes: dump.sizeBytes, sha256: dump.sha256, managedFiles: dump.managedFiles, actor: null,
      })
      await commands.verifyDump(record.path)
      const verified = await backups.setVerified(record.id, true)
      await maintenance.finishOperation(opId, 'completed', { backupId: verified.id, path: verified.path })
      console.log(`backup=${verified.path}`)
      console.log(`backup_id=${verified.id}`)
    } catch (error) {
      await maintenance.finishOperation(opId, 'failed', { error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  } else if (verb === 'restore' && command.length === 1) {
    if (maintenance === undefined || backups === undefined) throw new Error('organization is not provisioned')
    let pending = await maintenance.claimRestoreRequest()
    let backupId = flags.backup
    let dumpPath = flags.dump
    let manifest: ManagedFileEntry[] | undefined
    if (pending !== undefined) {
      const detail = pending.detail as { backupId?: unknown }
      if (typeof detail.backupId !== 'string') throw new Error('pending restore request carries no backupId')
      backupId = detail.backupId
    }
    if (backupId !== undefined) {
      const record = await backups.get(backupId)
      dumpPath = record.path
      manifest = record.managedFiles
      if (record.status !== 'verified' && record.status !== 'restored') {
        throw new MaintenanceError(409, 'backup-not-verified')
      }
    }
    if (dumpPath === undefined) {
      throw new Error('restore requires --backup <id>, --dump <path>, or a pending admin restore request')
    }
    const filesDir = await filesDirForDump(dumpPath, flags.files)
    manifest ??= await manifestFromFilesDir(filesDir).catch(() => {
      throw new Error(`managed-file manifest unreadable under ${filesDir}; pass --files or fix the snapshot`)
    })
    const state = await maintenance.state()
    if (state.mode !== 'maintenance') {
      if (pending !== undefined) await maintenance.finishOperation(pending.id, 'aborted', { error: 'restore-requires-maintenance' })
      throw new MaintenanceError(409, 'restore-requires-maintenance')
    }
    await maintenance.beginRestore(null, backupId)
    try {
      if (flags.graceMs > 0) await delay(flags.graceMs)
      await commands.verifyDump(dumpPath)
      await commands.restoreDump(dumpPath, databaseUrl)
      await maintenance.resumeRestoring()
      const mismatchedBefore = await commands.verifyManagedFiles(managedPaths, manifest)
      await commands.restoreManagedFiles(filesDir, manifest)
      const mismatched = await commands.verifyManagedFiles(managedPaths, manifest)
      // The database snapshot committed; the epoch must advance regardless of
      // the managed-file outcome so pre-restore writers stay fenced out.
      await maintenance.completeRestore(null, backupId, {
        dumpPath,
        filesDir,
        managedFiles: manifest.length,
        driftBefore: mismatchedBefore,
        mismatchedAfter: mismatched,
      })
      if (mismatched.length > 0) {
        const detail = { backupId: backupId ?? null, dumpPath, error: `managed files still differ: ${mismatched.join(',')}` }
        if (pending !== undefined) await maintenance.finishOperation(pending.id, 'failed', detail)
        throw new DeploymentCommandError(`restore left managed files inconsistent: ${mismatched.join(',')}`)
      }
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
        const view = await maintenance.listOperations()
        const pendingOp = view.find(op => op.id === pending.id)
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
