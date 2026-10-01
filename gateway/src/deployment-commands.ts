/**
 * `pg_dump`/`pg_restore` subprocess runners and the managed-file consistency
 * manifest shared by the admin backup API and the standalone `pg:deploy`
 * applier. Commands stream the dump on stdout/stdin so a Docker Compose
 * `exec` command line works identically to a local `pg_dump` install.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import type { ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { compareManagedFiles, copyVerifiedFile, restoreManagedSnapshot, snapshotManagedFiles, verifyStoredFiles, type ManagedSnapshot, type PreservedManagedFiles } from './managed-files.ts'
import type { DeploymentDataLease } from './postgres/deployment-lock.ts'
import { DEPLOYMENT_DATA_LOCK, DEPLOYMENT_SQL_LOCK } from './postgres/maintenance-service.ts'
export type { ManagedFileEntry, ManagedSnapshot } from './managed-files.ts'

const STDERR_CAPTURE_BYTES = 8 * 1024

// These temporary relations outlive the dump's DROP/CREATE statements inside
// the same transaction. No observer can see the dump-time serving mode.
const RESTORE_PREFIX = `
DO $$ BEGIN
  IF (SELECT count(*) FROM harness.organizations) <> 1
    OR (SELECT count(*) FROM harness.cluster_control WHERE mode='restoring') <> 1 THEN
    RAISE EXCEPTION 'restore requires one provisioned organization in a coordinated restoring window';
  END IF;
END $$;
CREATE TEMP TABLE hgw_saved_control ON COMMIT DROP AS TABLE harness.cluster_control;
CREATE TEMP TABLE hgw_saved_operations ON COMMIT DROP AS TABLE harness.deployment_operations;
CREATE TEMP TABLE hgw_saved_backups ON COMMIT DROP AS TABLE harness.backup_records;
CREATE TEMP TABLE hgw_saved_nodes ON COMMIT DROP AS SELECT id,organization_id,name::text FROM harness.compute_nodes;
`

const RESTORE_SUFFIX = `
DO $$ BEGIN
  IF EXISTS (SELECT id FROM harness.organizations EXCEPT SELECT organization_id FROM hgw_saved_control)
    OR EXISTS (SELECT organization_id FROM hgw_saved_control EXCEPT SELECT id FROM harness.organizations) THEN
    RAISE EXCEPTION 'backup organization identity differs from the destination';
  END IF;
  IF EXISTS (SELECT id,organization_id,name FROM harness.compute_nodes EXCEPT SELECT * FROM hgw_saved_nodes)
    OR EXISTS (SELECT * FROM hgw_saved_nodes EXCEPT SELECT id,organization_id,name FROM harness.compute_nodes) THEN
    RAISE EXCEPTION 'backup compute node identity differs from the destination';
  END IF;
END $$;
DELETE FROM harness.cluster_control;
INSERT INTO harness.cluster_control SELECT * FROM hgw_saved_control;
UPDATE harness.cluster_control SET mode='restoring', write_epoch=write_epoch+1, updated_at=now();
DELETE FROM harness.deployment_operations;
INSERT INTO harness.deployment_operations SELECT * FROM hgw_saved_operations;
DELETE FROM harness.backup_records;
INSERT INTO harness.backup_records SELECT * FROM hgw_saved_backups;
`

function sqlText(value: string): string { return `'${value.replaceAll("'", "''")}'` }

function requireRestoreLease(lease: DeploymentDataLease): string {
  return `DO $$ BEGIN
    PERFORM pg_stat_clear_snapshot();
    IF NOT EXISTS (
      SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
      WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
        AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND l.objid=hashtext(${sqlText(DEPLOYMENT_DATA_LOCK)})::oid
        AND l.classid=(CASE WHEN hashtext(${sqlText(DEPLOYMENT_DATA_LOCK)})<0 THEN 4294967295 ELSE 0 END)::oid
        AND a.pid=${lease.owner.pid} AND EXTRACT(EPOCH FROM a.backend_start)::text=${sqlText(lease.owner.backendStart)}
        AND a.application_name=${sqlText(lease.owner.token)}
    ) THEN RAISE EXCEPTION 'restore coordinating data lease is no longer active'; END IF;
  END $$;`
}

function lockRestoreSql(): string {
  return `DO $$ BEGIN
    IF NOT pg_try_advisory_xact_lock(hashtext(${sqlText(DEPLOYMENT_SQL_LOCK)})) THEN
      RAISE EXCEPTION 'another restore SQL transaction is still running';
    END IF;
  END $$;`
}

function pairedPsql(command: readonly string[]): string[] {
  const positions = command.flatMap((argument, index) => /^pg_restore(?:\.exe)?$/u.test(basename(argument)) ? [index] : [])
  if (positions.length !== 1) throw new DeploymentCommandError('restore requires an explicit psql command for this pg_restore wrapper')
  const position = positions[0] as number
  return command.map((argument, index) => index === position
    ? join(dirname(argument), basename(argument).endsWith('.exe') ? 'psql.exe' : 'psql') : argument)
}

/** A deployment command runner bound to the configured pg_dump/pg_restore command lines. */
export interface DeploymentCommands {
  /** Write a new custom-format dump plus managed-file snapshot under `backupDir`. */
  backup(backupDir: string, databaseUrl: string, managedPaths: ManagedDataPath[], signal?: AbortSignal): Promise<DeploymentBackup>
  /** Reject an unreadable or mismatching dump and return its verified digest. */
  verifyDump(dumpPath: string, signal?: AbortSignal, expectedSha256?: string): Promise<string>
  /** Restore atomically under the exact live data lease, preserving maintenance/backup records. */
  restoreDump(dumpPath: string, databaseUrl: string, lease: DeploymentDataLease, expectedSha256: string): Promise<void>
  /** Restore a backup's managed-file snapshot over the live managed paths. */
  restoreManagedFiles(filesDir: string, manifest: ManagedSnapshot, allowed: ManagedDataPath[], signal?: AbortSignal,
    preserved?: PreservedManagedFiles): Promise<ManagedSnapshot>
  /** Live managed paths that no longer match the recorded manifest digests. */
  verifyManagedFiles(manifest: ManagedSnapshot, signal?: AbortSignal): Promise<string[]>
  /** Verify all captured file bytes and exact snapshot membership. */
  verifyStoredFiles(filesDir: string, manifest: ManagedSnapshot, signal?: AbortSignal): Promise<void>
}

/** Completed backup artifacts on disk. */
export interface DeploymentBackup {
  dumpPath: string
  filesDir: string
  sizeBytes: number
  sha256: string
  managedSnapshot: ManagedSnapshot
}

/** Deployment subprocess or filesystem work failed; the message is operator-safe. */
export class DeploymentCommandError extends Error {
  constructor(message: string) { super(message) }
}

async function run(argv: string[], input?: string | Readable, stdoutPath?: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const [command, ...args] = argv
  if (command === undefined || command === '') throw new DeploymentCommandError('empty deployment command')
  const child = spawn(command, args, {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(signal === undefined ? {} : { signal, killSignal: 'SIGKILL' }),
  })
  const stderrStream = child.stderr
  const stdoutStream = child.stdout
  const stdinStream = child.stdin
  if (stderrStream === null || stdoutStream === null || (input !== undefined && stdinStream === null)) {
    child.kill('SIGKILL')
    throw new DeploymentCommandError('deployment command streams were not piped')
  }
  let stderr = ''
  stderrStream.setEncoding('utf8')
  stderrStream.on('data', (chunk: string) => {
    if (stderr.length < STDERR_CAPTURE_BYTES) stderr += chunk
  })
  let commandError: Error | undefined
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', error => { commandError = error })
    child.once('close', exit => resolve(exit))
  })
  const pipes: Promise<void>[] = []
  if (input !== undefined && stdinStream !== null) {
    pipes.push(pipeline(typeof input === 'string' ? createReadStream(input) : input, stdinStream).catch((error: unknown) => {
      // Catalog readers may exit before consuming dump data; their exit status
      // still determines success. Pipeline closes the unread source in either case.
      if (error instanceof Error && 'code' in error
        && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')) return
      throw error
    }))
  }
  if (stdoutPath !== undefined) {
    pipes.push(pipeline(stdoutStream, createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 })))
  } else {
    stdoutStream.resume()
  }
  const [code] = await Promise.all([
    exited,
    ...pipes,
  ]).catch(async (error: unknown) => {
    child.kill('SIGKILL')
    await Promise.allSettled([exited, ...pipes])
    throw error
  })
  if (commandError !== undefined) throw commandError
  signal?.throwIfAborted()
  if (code !== 0) {
    const lines = stderr.trim().split('\n')
    const detail = lines.find(line => /\berror:/iu.test(line)) ?? lines.at(-1) ?? ''
    throw new DeploymentCommandError(`deployment command failed (exit ${String(code)}): ${argv[0]}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.once('error', reject)
    stream.on('data', (chunk: string | Buffer) => { hash.update(chunk) })
    stream.once('end', () => resolve())
  })
  return hash.digest('hex')
}

async function flush(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

/**
 * Bind PostgreSQL tools to the deployment's local or container command wrappers.
 * @param pgDumpCommand - dump executable and fixed wrapper arguments.
 * @param pgRestoreCommand - archive reader executable and fixed wrapper arguments.
 * @param psqlCommand - SQL executor; otherwise the matching pg_restore executable is replaced with its psql sibling.
 * @returns backup, verification and transactional restoration operations.
 */
export function createDeploymentCommands(
  pgDumpCommand: string[], pgRestoreCommand: string[], psqlCommand?: string[],
): DeploymentCommands {
  if (pgDumpCommand.length === 0 || pgRestoreCommand.length === 0) {
    throw new DeploymentCommandError('pg_dump and pg_restore commands must not be empty')
  }
  return {
    async backup(backupDir, databaseUrl, managedPaths, signal) {
      backupDir = resolve(backupDir)
      await mkdir(backupDir, { recursive: true, mode: 0o700 })
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID()
      const filesDir = join(backupDir, `harness-${stamp}.files`)
      const dumpPath = join(backupDir, `harness-${stamp}.dump`)
      const partial = `${dumpPath}.partial`
      try {
        await mkdir(filesDir, { mode: 0o700 })
        const managedSnapshot = await snapshotManagedFiles(managedPaths, filesDir, signal)
        await writeFile(join(filesDir, 'manifest.json'), JSON.stringify(managedSnapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
        await flush(join(filesDir, 'manifest.json'))
        await flush(filesDir)
        try {
          await run([...pgDumpCommand, '--dbname', databaseUrl, '--format=custom', '--compress=9'], undefined, partial, signal)
        } catch (error) {
          await rm(filesDir, { recursive: true, force: true })
          throw error
        }
        await flush(partial)
        await rename(partial, dumpPath)
        await flush(backupDir)
        const info = await stat(dumpPath)
        await verifyStoredFiles(filesDir, managedSnapshot, signal)
        const mismatched = await compareManagedFiles(managedSnapshot, signal)
        if (mismatched.length !== 0) throw new DeploymentCommandError('Managed data changed during database backup')
        return { dumpPath, filesDir, sizeBytes: info.size, sha256: await sha256File(dumpPath), managedSnapshot }
      } catch (error) {
        await Promise.all([rm(filesDir, { recursive: true, force: true }), rm(dumpPath, { force: true })])
        throw error
      } finally {
        await rm(partial, { force: true })
      }
    },
    async verifyDump(dumpPath, signal, expectedSha256) {
      const digest = await sha256File(dumpPath)
      if (expectedSha256 !== undefined && digest !== expectedSha256) throw new DeploymentCommandError('Database dump digest mismatch')
      await run([...pgRestoreCommand, '--list'], dumpPath, undefined, signal)
      return digest
    },
    async restoreDump(dumpPath, databaseUrl, lease, expectedSha256) {
      const signal = lease.signal
      signal.throwIfAborted()
      const sqlCommand = psqlCommand ?? pairedPsql(pgRestoreCommand)
      const directory = await mkdtemp(join(tmpdir(), 'hgw-restore-'))
      try {
        const script = join(directory, 'restore.sql')
        const staged = join(directory, 'restore.dump')
        const actual = await copyVerifiedFile(dumpPath, staged, signal)
        if (actual.sha256 !== expectedSha256) throw new DeploymentCommandError('Database dump digest mismatch')
        // Rendering first validates the complete archive before the target transaction begins.
        await run([...pgRestoreCommand, '--clean', '--if-exists', '--file=-'], staged, script, signal)
        const input = Readable.from((async function* () {
          yield lockRestoreSql()
          yield requireRestoreLease(lease)
          yield RESTORE_PREFIX
          yield* createReadStream(script)
          yield RESTORE_SUFFIX
          yield '\n-- Verify the same coordinating lease before committing.\n'
          yield requireRestoreLease(lease)
        })())
        await run([...sqlCommand, '--no-psqlrc', '--set=ON_ERROR_STOP=on', '--single-transaction',
          '--dbname', databaseUrl, '--file=-'], input, undefined, signal)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    restoreManagedFiles: restoreManagedSnapshot,
    verifyManagedFiles: compareManagedFiles,
    verifyStoredFiles,
  }
}
