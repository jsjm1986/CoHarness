/**
 * `pg_dump`/`pg_restore` subprocess runners and the managed-file consistency
 * manifest shared by the admin backup API and the standalone `pg:deploy`
 * applier. Commands stream the dump on stdout/stdin so a Docker Compose
 * `exec` command line works identically to a local `pg_dump` install.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** One managed file captured alongside a database dump. */
export interface ManagedFileEntry {
  /** Snapshot member name inside the backup files directory. */
  member: string
  /** Absolute source path the member restores to. */
  sourcePath: string
  sizeBytes: number
  sha256: string
}

/** Managed files stay small (keys, credential material); refuse a surprise rather than truncate. */
const MANAGED_FILE_MAX_BYTES = 16 * 1024 * 1024
const MANAGED_FILE_MAX_COUNT = 512
const STDERR_CAPTURE_BYTES = 8 * 1024

/** A deployment command runner bound to the configured pg_dump/pg_restore command lines. */
export interface DeploymentCommands {
  /** Write a new custom-format dump plus managed-file snapshot under `backupDir`. */
  backup(backupDir: string, databaseUrl: string, managedPaths: string[]): Promise<DeploymentBackup>
  /** Reject a dump `pg_restore --list` cannot read. */
  verifyDump(dumpPath: string): Promise<void>
  /** Apply a dump with `--clean --if-exists`; callers own writer quiesce. */
  restoreDump(dumpPath: string, databaseUrl: string): Promise<void>
  /** Restore a backup's managed-file snapshot over the live managed paths. */
  restoreManagedFiles(filesDir: string, manifest: ManagedFileEntry[]): Promise<void>
  /** Live managed paths that no longer match the recorded manifest digests. */
  verifyManagedFiles(managedPaths: string[], manifest: ManagedFileEntry[]): Promise<string[]>
}

/** Completed backup artifacts on disk. */
export interface DeploymentBackup {
  dumpPath: string
  filesDir: string
  sizeBytes: number
  sha256: string
  managedFiles: ManagedFileEntry[]
}

/** Deployment subprocess or filesystem work failed; the message is operator-safe. */
export class DeploymentCommandError extends Error {
  constructor(message: string) { super(message) }
}

async function run(argv: string[], stdinPath?: string, stdoutPath?: string): Promise<void> {
  const [command, ...args] = argv
  if (command === undefined || command === '') throw new DeploymentCommandError('empty deployment command')
  const child = spawn(command, args, {
    stdio: [stdinPath === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
  const stderrStream = child.stderr
  const stdoutStream = child.stdout
  const stdinStream = child.stdin
  if (stderrStream === null || stdoutStream === null || (stdinPath !== undefined && stdinStream === null)) {
    child.kill('SIGKILL')
    throw new DeploymentCommandError('deployment command streams were not piped')
  }
  let stderr = ''
  stderrStream.setEncoding('utf8')
  stderrStream.on('data', (chunk: string) => {
    if (stderr.length < STDERR_CAPTURE_BYTES) stderr += chunk
  })
  const pipes: Promise<void>[] = []
  if (stdinPath !== undefined && stdinStream !== null) {
    pipes.push(new Promise<void>((resolve, reject) => {
      const input = createReadStream(stdinPath)
      input.once('error', reject)
      stdinStream.once('error', () => { /* process exit reports the failure */ })
      input.pipe(stdinStream)
      stdinStream.once('finish', () => resolve())
    }))
  }
  if (stdoutPath !== undefined) {
    pipes.push(new Promise<void>((resolve, reject) => {
      const output = createWriteStream(stdoutPath)
      output.once('error', reject)
      stdoutStream.pipe(output)
      output.once('finish', () => resolve())
    }))
  } else {
    stdoutStream.resume()
  }
  const [code] = await Promise.all([
    new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', exit => resolve(exit))
    }),
    ...pipes,
  ]).catch(async (error: unknown) => {
    child.kill('SIGKILL')
    throw error
  })
  if (code !== 0) {
    const detail = stderr.trim().split('\n').at(-1) ?? ''
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

async function manifestForPaths(managedPaths: string[], filesDir?: string): Promise<ManagedFileEntry[]> {
  const entries: ManagedFileEntry[] = []
  for (const sourcePath of managedPaths) {
    const info = await stat(sourcePath).catch(() => undefined)
    if (info === undefined) continue
    const targets: string[] = []
    if (info.isDirectory()) {
      for (const name of (await readdir(sourcePath)).sort()) {
        const child = join(sourcePath, name)
        if ((await stat(child)).isFile()) targets.push(child)
      }
    } else if (info.isFile()) {
      targets.push(sourcePath)
    }
    for (const target of targets) {
      const fileInfo = await stat(target)
      if (fileInfo.size > MANAGED_FILE_MAX_BYTES) {
        throw new DeploymentCommandError(`managed file exceeds ${String(MANAGED_FILE_MAX_BYTES)} bytes: ${target}`)
      }
      if (entries.length >= MANAGED_FILE_MAX_COUNT) {
        throw new DeploymentCommandError(`managed file set exceeds ${String(MANAGED_FILE_MAX_COUNT)} entries`)
      }
      const member = `${String(entries.length).padStart(3, '0')}-${basename(target)}`
      if (filesDir !== undefined) await copyFile(target, join(filesDir, member))
      entries.push({ member, sourcePath: target, sizeBytes: fileInfo.size, sha256: await sha256File(target) })
    }
  }
  return entries
}

export function createDeploymentCommands(pgDumpCommand: string[], pgRestoreCommand: string[]): DeploymentCommands {
  if (pgDumpCommand.length === 0 || pgRestoreCommand.length === 0) {
    throw new DeploymentCommandError('pg_dump and pg_restore commands must not be empty')
  }
  return {
    async backup(backupDir, databaseUrl, managedPaths) {
      await mkdir(backupDir, { recursive: true })
      const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
      const filesDir = join(backupDir, `harness-${stamp}.files`)
      const dumpPath = join(backupDir, `harness-${stamp}.dump`)
      const partial = `${dumpPath}.partial`
      try {
        await mkdir(filesDir, { recursive: true })
        const managedFiles = await manifestForPaths(managedPaths, filesDir)
        await writeFile(join(filesDir, 'manifest.json'), JSON.stringify(managedFiles, null, 2) + '\n')
        try {
          await run([...pgDumpCommand, '--dbname', databaseUrl, '--format=custom', '--compress=9'], undefined, partial)
        } catch (error) {
          await rm(filesDir, { recursive: true, force: true })
          throw error
        }
        await rename(partial, dumpPath)
        const info = await stat(dumpPath)
        return { dumpPath, filesDir, sizeBytes: info.size, sha256: await sha256File(dumpPath), managedFiles }
      } finally {
        await rm(partial, { force: true })
      }
    },
    async verifyDump(dumpPath) {
      await run([...pgRestoreCommand, '--list'], dumpPath)
    },
    async restoreDump(dumpPath, databaseUrl) {
      // cluster_control is excluded even from dumps that carry it: rewinding
      // the control row mid-restore would reopen the write gate between the
      // pg_restore commit and the caller's reassert. The restored table's
      // dependent index/constraint entries still churn harmlessly.
      await run([...pgRestoreCommand, '--clean', '--if-exists', '--single-transaction',
        '--exclude-table=harness.cluster_control', '--dbname', databaseUrl], dumpPath)
    },
    async restoreManagedFiles(filesDir, manifest) {
      for (const entry of manifest) {
        const digest = await sha256File(join(filesDir, entry.member)).catch(() => {
          throw new DeploymentCommandError(`backup managed file missing: ${entry.member}`)
        })
        if (digest !== entry.sha256) {
          throw new DeploymentCommandError(`backup managed file digest mismatch: ${entry.member}`)
        }
      }
      for (const entry of manifest) {
        const staging = `${entry.sourcePath}.hgw-restore`
        await copyFile(join(filesDir, entry.member), staging)
        await rename(staging, entry.sourcePath)
      }
    },
    async verifyManagedFiles(managedPaths, manifest) {
      const live = await manifestForPaths(managedPaths)
      const bySource = new Map(live.map(entry => [entry.sourcePath, entry.sha256]))
      const mismatched: string[] = []
      for (const entry of manifest) {
        if (bySource.get(entry.sourcePath) !== entry.sha256) mismatched.push(entry.sourcePath)
      }
      return mismatched
    },
  }
}
