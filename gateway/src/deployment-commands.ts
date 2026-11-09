/**
 * `pg_dump`/`pg_restore` subprocess runners and the managed-file consistency
 * manifest shared by the admin backup API and the standalone `pg:deploy`
 * applier. Connections use private framed stdin; remote command prefixes
 * include the execution-host adapter. Archive data retains streamed stdin/stdout.
 * Failure diagnostics retain a complete UTF-8 stderr prefix within eight KiB.
 */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { addAbortListener } from 'node:events'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, mkdtemp, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable, Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'

import type { ManagedDataPath } from '@deepseek-ai/dsh-managed-data'
import { compareManagedFiles, copyVerifiedFile, restoreManagedSnapshot, snapshotManagedFiles, verifyStoredFiles, type ManagedSnapshot, type PreservedManagedFiles } from './managed-files.ts'
import type { DeploymentDataLease } from './postgres/deployment-lock.ts'
import { scrubbedGatewayChildEnv } from './child-environment.ts'
import { DEPLOYMENT_DATA_LOCK, DEPLOYMENT_SQL_LOCK } from './postgres/maintenance-service.ts'
import { NODE_CONTENT_RESTORE_PREFIX, NODE_CONTENT_RESTORE_SUFFIX } from './node-content-restore-guard.ts'
import { defaultPgConnectionCommand, nativePgClient, pgConnectionFrame, pgConnectionNonce, pgConnectionMarker, pgConnectionAcknowledgement, readPgConnection, PG_METADATA_BYTES } from './pg-client-protocol.ts'
import { parseDumpMigrations, type DumpMigration } from './pg-dump-schema.ts'
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
CREATE TEMP TABLE hgw_saved_topology ON COMMIT DROP AS TABLE harness.deployment_topology;
CREATE TEMP TABLE hgw_saved_agents ON COMMIT DROP AS TABLE harness.node_agents;
CREATE TEMP TABLE hgw_saved_enrollments ON COMMIT DROP AS TABLE harness.node_agent_enrollments;
${NODE_CONTENT_RESTORE_PREFIX}
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
  IF EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid='harness.node_agent_enrollments'::regclass
      AND conname='node_agent_enrollments_created_by_organization_id_fkey') THEN
    RAISE EXCEPTION 'backup node enrollment history requires migration 102 in an isolated recovery deployment';
  END IF;
END $$;
-- Deployment authority belongs to the destination, never to a data backup.
DELETE FROM harness.node_agent_enrollments;
DELETE FROM harness.node_agents;
INSERT INTO harness.node_agents SELECT * FROM hgw_saved_agents;
UPDATE harness.node_agents SET connection_id=NULL,lease_expires_at=NULL,connection_epoch=connection_epoch+1;
INSERT INTO harness.node_agent_enrollments SELECT * FROM hgw_saved_enrollments;
DELETE FROM harness.deployment_topology;
INSERT INTO harness.deployment_topology SELECT * FROM hgw_saved_topology;
DELETE FROM harness.cluster_control;
INSERT INTO harness.cluster_control SELECT * FROM hgw_saved_control;
UPDATE harness.cluster_control SET mode='restoring', write_epoch=write_epoch+1, updated_at=now();
DELETE FROM harness.deployment_operations;
INSERT INTO harness.deployment_operations SELECT * FROM hgw_saved_operations;
DELETE FROM harness.backup_records;
INSERT INTO harness.backup_records SELECT * FROM hgw_saved_backups;
${NODE_CONTENT_RESTORE_SUFFIX}
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
  const positions = command.flatMap((argument, index) => /^pg_restore(?:\.exe)?$/iu.test(basename(argument)) ? [index] : [])
  if (positions.length !== 1) throw new DeploymentCommandError('restore requires an explicit psql command for this pg_restore wrapper')
  const position = positions[0] as number
  return command.map((argument, index) => index === position
    ? join(dirname(argument), basename(argument).toLowerCase().endsWith('.exe') ? 'psql.exe' : 'psql') : argument)
}

/**
 * Inspect only migration data through the configured offline restore client.
 * @param command - native pg_restore or its configured execution-host wrapper.
 * @param dumpPath - verified archive available on the Gateway host.
 * @param signal - deployment data lease lifetime.
 * @returns the migration identities without executing source SQL.
 */
export async function inspectDumpMigrations(command: readonly string[], dumpPath: string, signal?: AbortSignal): Promise<DumpMigration[]> {
  const output = await run([...command, '--data-only', '--schema=harness', '--table=schema_migrations', '--no-owner', '--no-privileges', '--file=-'],
    dumpPath, undefined, signal, { capture: true })
  return parseDumpMigrations(output)
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

/** Native connection resolution and wrapper readiness limits for maintenance commands. */
export interface DeploymentConnectionOptions {
  /** Local libpq adapter executable and fixed arguments. */
  command: readonly string[]
  /** Deadline for native resolution or the wrapper's private-input acknowledgement. */
  timeoutMs: number
}

/** PostgreSQL tools retain their credential inputs without unrelated Gateway secrets. */
function commandEnvironment(): NodeJS.ProcessEnv {
  const env = scrubbedGatewayChildEnv()
  for (const key of ['PGPASSWORD', 'PGPASSFILE', 'PGSSLKEY']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

interface CommandOptions {
  environment?: NodeJS.ProcessEnv
  capture?: boolean
  prefix?: Buffer
  acknowledgement?: Buffer
  readinessTimeoutMs?: number
}

async function run(argv: string[], input?: string | Readable, stdoutPath?: string, signal?: AbortSignal,
  options: CommandOptions = {}): Promise<Buffer> {
  signal?.throwIfAborted()
  const [command, ...args] = argv
  if (command === undefined || command === '') throw new DeploymentCommandError('empty deployment command')
  const hasInput = input !== undefined || options.prefix !== undefined
  const child = spawn(command, args, {
    env: options.environment ?? commandEnvironment(),
    stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  const stderrStream = child.stderr, stdoutStream = child.stdout, stdinStream = child.stdin
  if (stderrStream === null || stdoutStream === null || (hasInput && stdinStream === null)) {
    if (child.pid !== undefined) child.kill('SIGKILL')
    throw new DeploymentCommandError('deployment command streams were not piped')
  }
  let stderr = Buffer.alloc(0)
  stderrStream.setEncoding('utf8')
  stderrStream.on('data', (chunk: string) => {
    const remaining = STDERR_CAPTURE_BYTES - stderr.length
    if (remaining > 0) stderr = Buffer.concat([stderr, Buffer.from(chunk).subarray(0, remaining)])
  })
  let acceptReady!: () => void, rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { acceptReady = resolve; rejectReady = reject })
  void ready.catch(() => {})
  let acknowledged = options.acknowledgement === undefined, offset = 0
  if (acknowledged) acceptReady()
  let commandError: Error | undefined, readinessError: Error | undefined
  let readinessTimer: ReturnType<typeof setTimeout> | undefined
  const failed = (code: number | null): DeploymentCommandError => {
    const lines = new StringDecoder('utf8').write(stderr).trim().split('\n')
    const detail = lines.find(line => /\berror:/iu.test(line)) ?? lines.at(-1) ?? ''
    return new DeploymentCommandError(`deployment command failed (exit ${String(code)}): ${argv[0]}${detail === '' ? '' : ` — ${detail}`}`)
  }
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', error => { commandError = error })
    child.once('close', exit => {
      clearTimeout(readinessTimer)
      rejectReady(readinessError ?? commandError ?? (exit === 0
        ? new DeploymentCommandError('PostgreSQL private connection input was not acknowledged.') : failed(exit)))
      resolve(exit)
    })
  })
  if (options.readinessTimeoutMs !== undefined) {
    readinessTimer = setTimeout(() => {
      readinessError = new DeploymentCommandError('PostgreSQL private connection input timed out.')
      if (child.pid !== undefined) child.kill('SIGKILL')
    }, options.readinessTimeoutMs)
  }
  const cancellation = signal === undefined ? undefined : addAbortListener(signal, () => {
    if (child.pid !== undefined) child.kill('SIGKILL')
  })
  child.once('close', () => { cancellation?.[Symbol.dispose]() })
  const response = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const expected = options.acknowledgement
      if (acknowledged || expected === undefined) { callback(null, chunk); return }
      const count = Math.min(expected.length - offset, chunk.length)
      if (!chunk.subarray(0, count).equals(expected.subarray(offset, offset + count))) {
        callback(new DeploymentCommandError('PostgreSQL command requires its private connection adapter.'))
        return
      }
      offset += count
      if (offset === expected.length) {
        acknowledged = true
        clearTimeout(readinessTimer)
        acceptReady()
      }
      callback(null, chunk.subarray(count))
    },
  })
  const captured: Buffer[] = []
  let capturedBytes = 0
  const output = stdoutPath === undefined ? new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (options.capture === true) {
        capturedBytes += chunk.length
        if (capturedBytes > PG_METADATA_BYTES) {
          callback(new DeploymentCommandError('PostgreSQL private connection metadata exceeds its limit.'))
          return
        }
        captured.push(chunk)
      }
      callback()
    },
  }) : createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 })
  const pipes: Promise<void>[] = [pipeline(stdoutStream, response, output)]
  if (hasInput && stdinStream !== null) {
    const source = Readable.from((async function* () {
      if (options.prefix !== undefined) {
        yield options.prefix
        await ready
        signal?.throwIfAborted()
      }
      if (input !== undefined) yield* typeof input === 'string' ? createReadStream(input) : input
    })())
    pipes.push(pipeline(source, stdinStream).catch((error: unknown) => {
      // Catalog readers may stop before EOF; their status still determines success.
      if (error instanceof Error && 'code' in error
        && (error.code === 'EPIPE' || error.code === 'ERR_STREAM_PREMATURE_CLOSE')) return
      throw error
    }))
  }
  const [code] = await Promise.all([exited, ...pipes]).catch(async (error: unknown) => {
    if (child.pid !== undefined) child.kill('SIGKILL')
    await Promise.allSettled([exited, ...pipes])
    signal?.throwIfAborted()
    throw readinessError ?? commandError ?? error
  })
  if (commandError !== undefined) throw commandError
  signal?.throwIfAborted()
  if (readinessError !== undefined) throw readinessError
  if (code !== 0) throw failed(code)
  if (!acknowledged) throw new DeploymentCommandError('PostgreSQL private connection input was not acknowledged.')
  return Buffer.concat(captured)
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
 * @param connection - local native resolver and private-input readiness deadline.
 * @returns backup, verification and transactional restoration operations.
 */
export function createDeploymentCommands(
  pgDumpCommand: string[], pgRestoreCommand: string[], psqlCommand?: string[],
  connection: DeploymentConnectionOptions = { command: defaultPgConnectionCommand(), timeoutMs: 30_000 },
): DeploymentCommands {
  if (pgDumpCommand.length === 0 || pgRestoreCommand.length === 0) {
    throw new DeploymentCommandError('pg_dump and pg_restore commands must not be empty')
  }
  if (connection.command.length === 0 || connection.command[0] === ''
    || !Number.isInteger(connection.timeoutMs) || connection.timeoutMs < 1 || connection.timeoutMs > 2_147_483_647) {
    throw new DeploymentCommandError('invalid PostgreSQL private connection resolver or readiness deadline')
  }
  const runDatabase = async (command: string[], databaseUrl: string, input?: Readable,
    stdoutPath?: string, signal?: AbortSignal): Promise<void> => {
    const frame = pgConnectionFrame(databaseUrl), nonce = pgConnectionNonce(), environment = commandEnvironment()
    if (nativePgClient(command)) {
      if (process.platform === 'win32' && dirname(command[0] as string) !== '.') {
        const pathKey = Object.keys(environment).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
        environment[pathKey] = `${dirname(command[0] as string)};${environment[pathKey] ?? ''}`
      }
      const bytes = await run([...connection.command, '--resolve-stdin-v1', nonce], Readable.from([frame]), undefined, signal,
        { environment, capture: true, readinessTimeoutMs: connection.timeoutMs })
      const resolved = readPgConnection(bytes, nonce)
      for (const key of Object.keys(environment)) if (/^(?:PGSERVICE|PGPASSWORD)$/iu.test(key)) delete environment[key]
      if (resolved.password !== undefined) environment.PGPASSWORD = resolved.password
      await run([...command, '--dbname', resolved.connection], input, stdoutPath, signal, { environment })
    } else {
      await run([...command, pgConnectionMarker(nonce)], input, stdoutPath, signal,
        { environment, prefix: frame, acknowledgement: pgConnectionAcknowledgement(nonce), readinessTimeoutMs: connection.timeoutMs })
    }
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
          await runDatabase([...pgDumpCommand, '--format=custom', '--compress=9'], databaseUrl, undefined, partial, signal)
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
        await runDatabase([...sqlCommand, '--no-psqlrc', '--set=ON_ERROR_STOP=on', '--single-transaction',
          '--file=-'], databaseUrl, input, undefined, signal)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    },
    restoreManagedFiles: restoreManagedSnapshot,
    verifyManagedFiles: compareManagedFiles,
    verifyStoredFiles,
  }
}
