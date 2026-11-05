/** Source-side encrypted incremental copy and isolated recovery using the restic REST backend. */
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, opendir, readFile, readdir, realpath, rm, statfs, writeFile } from 'node:fs/promises'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { z } from 'zod'
import { parseManagedSnapshot, verifyStoredFiles, type ManagedSnapshot } from './managed-files.ts'
import { privateFileState } from './node-private-file.ts'
import {
  PEER_REPOSITORY_PREFIX,
  PeerBackupError,
  peerPointSchema,
  peerPrivateDirectory,
  type PeerPoint,
} from './peer-backup-repository.ts'

/** Identity fixed by the organization policy and current space placement. */
export interface PeerBackupBinding {
  organizationId: string
  policyId: string
  revision: number
  scopeId: string
  sourceNodeId: string
  targetNodeId: string
}

/** Authorization secret is specific to this repository. The independently escrowed restic password never crosses the Gateway. */
export interface PeerBackupAccess {
  origin: string
  user: string
  token: string
  passwordFile: string
}

export const peerCaptureSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    sourceNodeId: z.uuid(),
    scopeId: z.uuid(),
    writerEpoch: z.string().regex(/^[1-9][0-9]{0,18}$/u),
    watermark: z.string().regex(/^(0|[1-9][0-9]{0,18})$/u),
    capturedAt: z.iso.datetime(),
    coveredCount: z.number().int().nonnegative(),
    gaps: z.array(z.string().min(1).max(256)).max(4096),
  })
  .strict()
export type PeerCapture = z.infer<typeof peerCaptureSchema>

/** A space owner supplies a consistent database export and pinned file versions under the private destination. */
export interface PeerBackupExporter {
  capture(binding: PeerBackupBinding, destination: string, signal: AbortSignal): Promise<PeerCapture>
  /** Validate session order, document references, plugin state and delivery receipts without starting execution. */
  validate(binding: PeerBackupBinding, capture: PeerCapture, destination: string, signal: AbortSignal): Promise<void>
}

/** Only opaque identities, time and byte counts leave the source. */
export interface PeerBackupProgress {
  phase: 'capturing' | 'transferring' | 'checking' | 'confirmed'
  pendingBytes: number | null
}

interface Config {
  executable: string
  stagingDirectory: string
  uploadKiBps: number
  downloadKiBps: number
  timeoutMs: number
  /** Maximum uncompressed bytes permitted in an isolated rehearsal, independently from ciphertext quota. */
  maxRestoreBytes: number
  maxEntries?: number
  reserveBytes: number
}

function sameBinding(point: PeerBackupBinding, policy: PeerBackupBinding): boolean {
  return (
    point.policyId === policy.policyId &&
    point.organizationId === policy.organizationId &&
    point.sourceNodeId === policy.sourceNodeId &&
    point.targetNodeId === policy.targetNodeId &&
    point.scopeId === policy.scopeId
  )
}

function endpoint(binding: PeerBackupBinding, access: PeerBackupAccess): URL {
  const url = new URL(access.origin)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
  )
    throw new PeerBackupError(503, 'peer-backup/untrusted-origin')
  return new URL(PEER_REPOSITORY_PREFIX + binding.policyId + '/', url.origin)
}

async function guardedRequest(
  url: URL,
  access: PeerBackupAccess,
  signal: AbortSignal,
  method: string,
  payload?: PeerPoint,
): Promise<Response> {
  return fetch(url, {
    method,
    signal,
    redirect: 'error',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${access.user}:${access.token}`).toString('base64'),
      ...(payload ? { 'content-type': 'application/json' } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  })
}

function matchesCapture(binding: PeerBackupBinding, capture: PeerCapture): void {
  if (
    capture.organizationId !== binding.organizationId ||
    capture.sourceNodeId !== binding.sourceNodeId ||
    capture.scopeId !== binding.scopeId ||
    Date.parse(capture.capturedAt) > Date.now() + 1000
  )
    throw new PeerBackupError(409, 'peer-backup/capture-mismatch')
}

async function verifyPayload(directory: string, maxBytes: number, maxEntries: number, signal: AbortSignal): Promise<void> {
  let bytes = 0,
    entries = 0
  const pending = [directory]
  while (pending.length) {
    const folder = pending.pop()!
    for await (const entry of await opendir(folder)) {
      signal.throwIfAborted()
      const path = join(folder, entry.name),
        info = await lstat(path)
      if (++entries > maxEntries || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
        throw new PeerBackupError(409, 'peer-backup/invalid-export')
      if (info.isDirectory()) pending.push(path)
      else {
        bytes += info.size
        if (info.nlink !== 1 || bytes > maxBytes) throw new PeerBackupError(507, 'peer-backup/export-budget')
      }
    }
  }
}

/** Private scoped recovery candidate retains no execution authority. */
export interface PeerBackupDrill {
  point: PeerPoint
  directory: string
  checkedAt: string
  recoveryMs: number
  /** Remove this candidate and its plaintext export from the isolated recovery directory. */
  dispose(): Promise<void>
}

/** Runs restic outside the Gateway event loop. Command diagnostics and detailed inventories stay on the owning computer. */
export class PeerBackupRestic {
  constructor(private readonly config: Config) {
    for (const limit of [
      config.uploadKiBps,
      config.downloadKiBps,
      config.timeoutMs,
      config.maxRestoreBytes,
      config.reserveBytes,
    ]) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('peer-backup/invalid-limit')
    }
    if (!isAbsolute(config.stagingDirectory) || !isAbsolute(config.executable))
      throw new Error('peer-backup/absolute-path-required')
  }

  private async run(
    binding: PeerBackupBinding,
    access: PeerBackupAccess,
    cwd: string,
    args: string[],
    signal: AbortSignal,
    onLine?: (line: string) => void,
    localRepository?: string,
  ): Promise<void> {
    const file = resolve(access.passwordFile)
    if (
      !isAbsolute(access.passwordFile) ||
      (await realpath(file)) !== file ||
      (await privateFileState(file, await lstat(file), 16384)) !== 'private'
    ) {
      throw new PeerBackupError(503, 'peer-backup/recovery-key-unavailable')
    }
    const password = (await readFile(file, 'utf8')).trim()
    if (password.length < 24 || password === access.token || /[\r\n\0]/u.test(password))
      throw new PeerBackupError(503, 'peer-backup/recovery-key-unavailable')
    const origin = endpoint(binding, access)
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TMPDIR: cwd,
      TMP: cwd,
      TEMP: cwd,
      RESTIC_PASSWORD_FILE: file,
      RESTIC_REST_USERNAME: access.user,
      RESTIC_REST_PASSWORD: access.token,
      RESTIC_PROGRESS_FPS: '1',
    }
    // Host proxy/cookie/credential environments are not inherited. Gateway origin is selected by the operator.
    const child = spawn(
      this.config.executable,
      [
        '--no-cache',
        '--json',
        '--repo',
        localRepository ?? 'rest:' + origin.href,
        '--limit-upload',
        String(this.config.uploadKiBps),
        '--limit-download',
        String(this.config.downloadKiBps),
        ...args,
      ],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let text = '',
      parseFailed = false
    child.stderr.resume()
    const terminate = (): void => {
      child.kill('SIGKILL')
    }
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      if (text.length > 1024 * 1024) {
        parseFailed = true
        terminate()
        return
      }
      let boundary: number
      while ((boundary = text.indexOf('\n')) !== -1) {
        const line = text.slice(0, boundary)
        text = text.slice(boundary + 1)
        try {
          onLine?.(line)
        } catch {
          parseFailed = true
          terminate()
        }
      }
    })
    signal.addEventListener('abort', terminate, { once: true })
    if (signal.aborted) terminate()
    try {
      const code = await new Promise<number | null>((ok, fail) => {
        child.once('error', (error: NodeJS.ErrnoException) =>
          fail(
            new PeerBackupError(
              503,
              error.code === 'ENOENT' ? 'peer-backup/restic-unavailable' : 'peer-backup/restic-start-failed',
            ),
          ),
        )
        child.once('close', ok)
      })
      signal.throwIfAborted()
      if (code !== 0 || parseFailed) throw new PeerBackupError(503, 'peer-backup/restic-incomplete')
      if (text) onLine?.(text)
    } finally {
      signal.removeEventListener('abort', terminate)
    }
  }

  /** Capture one policy, transfer encrypted packs and obtain the exact receiver's durable point acknowledgement. */
  async backup(
    binding: PeerBackupBinding,
    access: PeerBackupAccess,
    exporter: PeerBackupExporter,
    operationId: string,
    lifetime: AbortSignal,
    progress: (update: PeerBackupProgress) => void = () => {},
  ): Promise<PeerPoint> {
    z.uuid().parse(operationId)
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.config.timeoutMs)])
    const repo = endpoint(binding, access)
    await peerPrivateDirectory(this.config.stagingDirectory)
    const cwd = await mkdtemp(join(this.config.stagingDirectory, 'capture-'))
    try {
      const prior = await guardedRequest(new URL('points/' + operationId, repo), access, signal, 'GET')
      if (prior.ok) {
        const point = peerPointSchema.parse(await prior.json())
        if (!sameBinding(point, binding) || point.pointId !== operationId || point.revision !== binding.revision)
          throw new PeerBackupError(409, 'peer-backup/point-mismatch')
        return point
      }
      await prior.body?.cancel()
      if (prior.status !== 404) throw new PeerBackupError(503, 'peer-backup/receiver-unavailable')
      progress({ phase: 'capturing', pendingBytes: null })
      const payload = join(cwd, 'payload')
      await peerPrivateDirectory(payload)
      const capture = peerCaptureSchema.parse(await exporter.capture(binding, payload, signal))
      matchesCapture(binding, capture)
      await verifyPayload(payload, this.config.maxRestoreBytes, this.config.maxEntries ?? 100000, signal)
      await exporter.validate(binding, capture, payload, signal)
      const coordinates: PeerBackupBinding = {
        organizationId: binding.organizationId,
        scopeId: binding.scopeId,
        sourceNodeId: binding.sourceNodeId,
        targetNodeId: binding.targetNodeId,
        policyId: binding.policyId,
        revision: binding.revision,
      }
      const manifest = Buffer.from(JSON.stringify({ version: 1, binding: coordinates, pointId: operationId, capture }))
      await writeFile(join(payload, 'checkpoint.json'), manifest, { flag: 'wx', mode: 0o600 })
      const config = await guardedRequest(new URL('config', repo), access, signal, 'HEAD')
      if (config.status === 404) await this.run(binding, access, cwd, ['init', '--repository-version', '2'], signal)
      else if (!config.ok) throw new PeerBackupError(503, 'peer-backup/receiver-unavailable')
      progress({ phase: 'transferring', pendingBytes: null })
      let snapshotId: string | undefined
      await this.run(
        binding,
        access,
        cwd,
        [
          'backup',
          '--host',
          binding.sourceNodeId,
          '--tag',
          binding.scopeId,
          '--pack-size',
          '4',
          '--read-concurrency',
          '1',
          'payload',
        ],
        signal,
        (line) => {
          const event = JSON.parse(line) as {
            message_type?: string
            snapshot_id?: string
            total_bytes?: number
            bytes_done?: number
          }
          if (event.message_type === 'summary') snapshotId = event.snapshot_id
          if (
            event.message_type === 'status' &&
            typeof event.total_bytes === 'number' &&
            typeof event.bytes_done === 'number'
          ) {
            progress({ phase: 'transferring', pendingBytes: Math.max(0, event.total_bytes - event.bytes_done) })
          }
        },
      )
      if (!snapshotId || !/^[0-9a-f]{64}$/u.test(snapshotId)) throw new PeerBackupError(503, 'peer-backup/missing-snapshot')
      progress({ phase: 'checking', pendingBytes: 0 })
      await this.run(binding, access, cwd, ['check', '--no-lock'], signal)
      const storage = await guardedRequest(new URL('usage', repo), access, signal, 'GET')
      if (!storage.ok) throw new PeerBackupError(503, 'peer-backup/receiver-unavailable')
      const capacity = z
        .object({ used: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() })
        .strict()
        .parse(await storage.json())
      const point = peerPointSchema.parse({
        version: 1,
        repositoryBytes: capacity.used,
        availableBytes: capacity.remaining,
        ...coordinates,
        pointId: operationId,
        writerEpoch: capture.writerEpoch,
        watermark: capture.watermark,
        capturedAt: capture.capturedAt,
        snapshotId,
        manifestDigest: createHash('sha256').update(manifest).digest('hex'),
        coveredCount: capture.coveredCount,
        gapCount: capture.gaps.length,
        gapTypes: [
          ...new Set(
            capture.gaps.flatMap((gap) =>
              gap.startsWith('workspace-and-plugin-files')
                ? ['files', 'plugins']
                : gap.startsWith('table') || gap.startsWith('database')
                  ? ['database']
                  : gap.startsWith('plugin')
                    ? ['plugins']
                    : gap.startsWith('file')
                      ? ['files']
                      : ['unknown'],
            ),
          ),
        ],
      })
      const confirmation = await guardedRequest(new URL('points/' + operationId, repo), access, signal, 'POST', point)
      await confirmation.body?.cancel()
      if (!confirmation.ok) throw new PeerBackupError(503, 'peer-backup/confirmation-failed')
      progress({ phase: 'confirmed', pendingBytes: 0 })
      return point
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  }

  /** Recover into a fresh private directory using the independently retrieved key, byte-check the payload and validate logical ownership. */
  async drill(
    binding: PeerBackupBinding,
    pointId: string,
    access: PeerBackupAccess,
    exporter: Pick<PeerBackupExporter, 'validate'>,
    lifetime: AbortSignal,
  ): Promise<PeerBackupDrill> {
    z.uuid().parse(pointId)
    const started = Date.now(),
      signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.config.timeoutMs)])
    const response = await guardedRequest(new URL('points/' + pointId, endpoint(binding, access)), access, signal, 'GET')
    if (!response.ok) {
      await response.body?.cancel()
      throw new PeerBackupError(404, 'peer-backup/missing-point')
    }
    const point = peerPointSchema.parse(await response.json())
    if (point.pointId !== pointId || !sameBinding(point, binding))
      throw new PeerBackupError(409, 'peer-backup/point-mismatch')
    return this.restorePoint(binding, point, access, exporter, signal, started)
  }

  /** Run an isolated rehearsal from a locally exported opaque repository when the source and governance service are unavailable. */
  async drillOffline(
    point: PeerPoint,
    localRepository: string,
    passwordFile: string,
    exporter: Pick<PeerBackupExporter, 'validate'>,
    lifetime: AbortSignal,
  ): Promise<PeerBackupDrill> {
    const verified = peerPointSchema.parse(point)
    return this.restorePoint(
      verified,
      verified,
      { origin: 'http://127.0.0.1', user: '', token: '', passwordFile },
      exporter,
      AbortSignal.any([lifetime, AbortSignal.timeout(this.config.timeoutMs)]),
      Date.now(),
      localRepository,
    )
  }

  private async restorePoint(
    binding: PeerBackupBinding,
    point: PeerPoint,
    access: PeerBackupAccess,
    exporter: Pick<PeerBackupExporter, 'validate'>,
    signal: AbortSignal,
    started: number,
    localRepository?: string,
  ): Promise<PeerBackupDrill> {
    await peerPrivateDirectory(this.config.stagingDirectory)
    const directory = await mkdtemp(join(this.config.stagingDirectory, 'rehearsal-' + randomUUID() + '-'))
    const dispose = (): Promise<void> => rm(directory, { recursive: true, force: true })
    try {
      let bytes: number | undefined
      await this.run(
        binding,
        access,
        directory,
        ['stats', '--mode', 'restore-size', point.snapshotId, '--no-lock'],
        signal,
        (line) => {
          const stats = JSON.parse(line) as { total_size?: number }
          if (Number.isSafeInteger(stats.total_size)) bytes = stats.total_size
        },
        localRepository,
      )
      const disk = await statfs(directory, { bigint: true })
      if (
        bytes === undefined ||
        bytes < 0 ||
        bytes > this.config.maxRestoreBytes ||
        BigInt(bytes) + BigInt(this.config.reserveBytes) > disk.bavail * disk.bsize
      ) {
        throw new PeerBackupError(507, 'peer-backup/recovery-capacity')
      }
      await this.run(
        binding,
        access,
        directory,
        ['restore', point.snapshotId, '--no-lock', '--verify', '--target', directory],
        signal,
        undefined,
        localRepository,
      )
      const payload = join(directory, 'payload')
      if ((await readdir(directory)).some((entry) => entry !== 'payload') || (await lstat(payload)).isSymbolicLink())
        throw new PeerBackupError(409, 'peer-backup/invalid-export')
      await verifyPayload(payload, this.config.maxRestoreBytes, this.config.maxEntries ?? 100000, signal)
      const checkpoint = join(payload, 'checkpoint.json'),
        stat = await lstat(checkpoint)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
        throw new PeerBackupError(409, 'peer-backup/corrupt-point')
      const manifest = await readFile(checkpoint)
      if (manifest.byteLength > 1024 * 1024 || createHash('sha256').update(manifest).digest('hex') !== point.manifestDigest)
        throw new PeerBackupError(409, 'peer-backup/corrupt-point')
      const sealed = z
        .object({
          version: z.literal(1),
          pointId: z.uuid(),
          binding: z
            .object({
              policyId: z.uuid(),
              sourceNodeId: z.uuid(),
              targetNodeId: z.uuid(),
              scopeId: z.uuid(),
              organizationId: z.uuid(),
              revision: z.number().int().positive(),
            })
            .strict(),
          capture: peerCaptureSchema,
        })
        .strict()
        .parse(JSON.parse(manifest.toString('utf8')))
      if (
        sealed.pointId !== point.pointId ||
        sealed.binding.revision !== point.revision ||
        !sameBinding(sealed.binding, point)
      )
        throw new PeerBackupError(409, 'peer-backup/corrupt-point')
      const capture = sealed.capture
      matchesCapture(binding, capture)
      if (
        capture.writerEpoch !== point.writerEpoch ||
        capture.watermark !== point.watermark ||
        capture.capturedAt !== point.capturedAt ||
        capture.coveredCount !== point.coveredCount ||
        capture.gaps.length !== point.gapCount
      )
        throw new PeerBackupError(409, 'peer-backup/corrupt-point')
      await exporter.validate(binding, capture, payload, signal)
      return { point, directory: payload, checkedAt: new Date().toISOString(), recoveryMs: Date.now() - started, dispose }
    } catch (error) {
      await dispose()
      throw error
    }
  }
}

/** Validate the existing managed-data membership, file hashes and copied bytes within a restored checkpoint. */
export async function verifyPeerManagedFiles(directory: string, signal: AbortSignal, rootMap?: 'roots.json'): Promise<void> {
  await readVerifiedPeerManagedFiles(directory, signal, rootMap)
}

/** Verified cross-platform source paths are used only as lookup keys. The only files opened are numbered checkpoint members. */
export async function readVerifiedPeerManagedFiles(
  directory: string,
  signal: AbortSignal,
  rootMap?: 'roots.json',
): Promise<{ sourcePlatform: 'win32' | 'posix'; snapshot: ManagedSnapshot }> {
  const file = join(directory, 'manifest.json'),
    stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
    throw new PeerBackupError(409, 'peer-backup/invalid-file-manifest')
  const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
  const envelope = z
    .object({ platform: z.enum(['win32', 'posix']), snapshot: z.unknown() })
    .strict()
    .safeParse(raw)
  if (!envelope.success) {
    const snapshot = parseManagedSnapshot(raw)
    await verifyStoredFiles(directory, snapshot, signal, rootMap)
    return { sourcePlatform: process.platform === 'win32' ? 'win32' : 'posix', snapshot }
  }
  const record = z.record(z.string(), z.unknown())
  const witness = z
    .object({
      version: z.literal(1),
      roots: z.array(record),
      directories: z.array(record),
      absent: z.array(z.string()),
      files: z.array(record),
    })
    .strict()
    .parse(envelope.data.snapshot)
  const source = envelope.data.platform === 'win32' ? win32 : posix
  // Keep the original volume and component hierarchy for membership checks. Only numbered data members are opened.
  const original = new Map<string, string>()
  const mapPath = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      value.includes('\0') ||
      !source.isAbsolute(value) ||
      source.normalize(value) !== value
    ) {
      throw new PeerBackupError(409, 'peer-backup/invalid-file-manifest')
    }
    const root = source.parse(value).root
    const parts = [root, ...value.slice(root.length).split(source.sep).filter(Boolean)]
    const key = join(directory, '.logical-members', ...parts.map((part) => Buffer.from(part).toString('hex')))
    original.set(key, value)
    return key
  }
  const snapshot = parseManagedSnapshot({
    version: 1,
    roots: witness.roots.map((row) => ({ ...row, path: mapPath(row.path) })),
    directories: witness.directories.map((row) => ({ ...row, path: mapPath(row.path) })),
    absent: witness.absent.map(mapPath),
    files: witness.files.map((row) => ({ ...row, sourcePath: mapPath(row.sourcePath) })),
  })
  await verifyStoredFiles(directory, snapshot, signal, rootMap)
  return {
    sourcePlatform: envelope.data.platform,
    snapshot: {
      version: 1,
      roots: snapshot.roots.map((row) => ({ ...row, path: original.get(row.path)! })),
      directories: snapshot.directories.map((row) => ({ ...row, path: original.get(row.path)! })),
      files: snapshot.files.map((row) => ({ ...row, sourcePath: original.get(row.sourcePath)! })),
      absent: snapshot.absent.map((path) => original.get(path)!),
    },
  }
}
