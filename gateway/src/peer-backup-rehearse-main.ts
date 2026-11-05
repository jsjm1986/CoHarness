/** Offline recovery of one explicitly selected encrypted point into an empty, private isolation directory. */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { privateFileState } from './node-private-file.ts'
import { validatePeerControl } from './peer-backup-control-export.ts'
import { exportOfflinePeerRepository } from './peer-backup-offline.ts'
import { validatePeerPersonal, restorePeerPersonalFiles } from './peer-backup-personal.ts'
import { validatePeerProject } from './peer-backup-project-export.ts'
import { PeerBackupError, peerPrivateDirectory } from './peer-backup-repository.ts'
import { PeerBackupRestic, peerCaptureSchema, type PeerBackupExporter } from './peer-backup-restic.ts'
import { PeerSnapshotOwner } from './peer-backup-snapshot-owner.ts'

const path = z.string().refine(isAbsolute)
const configSchema = z
  .object({
    version: z.literal(1),
    organizationId: z.uuid(),
    sourceNodeId: z.uuid(),
    targetNodeId: z.uuid(),
    policyId: z.uuid(),
    pointId: z.uuid(),
    kind: z.enum(['project', 'personal', 'governance']),
    repositoryDirectory: path,
    recoveryDirectory: path,
    passwordFile: path,
    resticExecutable: path,
    snapshotExecutable: path.optional(),
    maxBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxRows: z.number().int().positive().max(100_000_000),
    reserveBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    timeoutMs: z.number().int().min(1000).max(86400000),
  })
  .strict()
function contains(base: string, target: string): boolean {
  const tail = relative(resolve(base), resolve(target))
  return !tail || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith('..' + sep))
}

/** Keep plaintext isolated after verification. The caller explicitly owns retention and operator cleanup. */
export async function rehearseOfflinePeer(configFile: string, signal: AbortSignal) {
  const file = resolve(configFile)
  if ((await realpath(file)) !== file || (await privateFileState(file, await lstat(file), 16384, signal)) !== 'private') {
    throw new PeerBackupError(403, 'peer-backup/private-configuration-required')
  }
  const config = configSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  const reserved = [
    config.repositoryDirectory,
    file,
    config.passwordFile,
    config.resticExecutable,
    ...(config.snapshotExecutable ? [config.snapshotExecutable] : []),
  ]
  for (const reservedPath of reserved) {
    if (contains(reservedPath, config.recoveryDirectory) || contains(config.recoveryDirectory, reservedPath)) {
      throw new PeerBackupError(409, 'peer-backup/invalid-layout')
    }
  }
  await peerPrivateDirectory(config.recoveryDirectory)
  if ((await readdir(config.recoveryDirectory)).length)
    throw new PeerBackupError(409, 'peer-backup/empty-recovery-area-required')
  const limits = { maxRows: config.maxRows, maxBytes: config.maxBytes, reserveBytes: config.reserveBytes }
  const engine = new PeerBackupRestic({
    executable: config.resticExecutable,
    stagingDirectory: config.recoveryDirectory,
    uploadKiBps: 1,
    downloadKiBps: 1,
    timeoutMs: config.timeoutMs,
    maxRestoreBytes: config.maxBytes,
    reserveBytes: config.reserveBytes,
  })
  const temporary = await exportOfflinePeerRepository({
    ...config,
    privateRecoveryDirectory: config.recoveryDirectory,
    signal,
  })
  try {
    const validate = { project: validatePeerProject, personal: validatePeerPersonal, governance: validatePeerControl }[
      config.kind
    ]
    const validator: Pick<PeerBackupExporter, 'validate'> = config.snapshotExecutable
      ? new PeerSnapshotOwner(config.snapshotExecutable, config.kind, config.timeoutMs, limits)
      : { validate: (binding, metadata, directory, lifetime) => validate(binding, metadata, directory, lifetime, limits) }
    const drill = await engine.drillOffline(temporary.point, temporary.repository, config.passwordFile, validator, signal)
    let personalFilesDirectory:string|undefined
    if(config.kind==='personal'&&!config.snapshotExecutable){
      const destination=join(dirname(drill.directory),'personal-content')
      try {
        const raw=await readFile(join(drill.directory,'checkpoint.json'),'utf8')
        const checkpoint=z.object({capture:peerCaptureSchema}).parse(JSON.parse(raw))
        if(await restorePeerPersonalFiles(drill.point,checkpoint.capture,drill.directory,destination,limits,signal))personalFilesDirectory=destination
      } catch(error){await drill.dispose();throw error}
    }
    return {
      pointId: drill.point.pointId,
      protectedThrough: drill.point.capturedAt,
      coveredCount: drill.point.coveredCount,
      gapCount: drill.point.gapCount,
      recoveryMs: drill.recoveryMs,
      isolatedDirectory: drill.directory,
      ...(personalFilesDirectory?{personalFilesDirectory}:{}),
      publication: 'fenced' as const,
    }
  } finally {
    await temporary.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3 || !process.argv[2])
      throw new PeerBackupError(400, 'peer-backup/configuration-file-required')
    const result = await rehearseOfflinePeer(process.argv[2], AbortSignal.timeout(86400000))
    process.stdout.write(JSON.stringify(result) + '\n')
  } catch (error) {
    process.stderr.write((error instanceof PeerBackupError ? error.code : 'peer-backup/rehearsal-failed') + '\n')
    process.exitCode = 1
  }
}
