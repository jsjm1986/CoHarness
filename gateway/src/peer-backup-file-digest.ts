/** Compare two immutable file snapshots of the same original project without disclosing paths to the control database. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join, posix, relative, sep, win32 } from 'node:path'
import { verifiedPeerFileRoots, type PeerFileRootMap } from './peer-snapshot-roots.ts'
import { readVerifiedPeerManagedFiles, type PeerBackupBinding, type PeerBackupExporter } from './peer-backup-restic.ts'
import { snapshotManagedFiles, type ManagedSnapshot } from './managed-files.ts'
import { peerPrivateDirectory, PeerBackupError } from './peer-backup-repository.ts'

/** The comparison is insensitive to physical snapshot path and device numbers. It covers membership, logical roles, modes and bytes. */
export function logicalPeerFileDigest(
  map: PeerFileRootMap,
  snapshot: ManagedSnapshot,
  sourcePlatform: 'posix' | 'win32',
): string {
  const paths = sourcePlatform === 'win32' ? win32 : posix
  const roots = map.roots.slice().sort((a, b) => b.snapshotRoot.length - a.snapshotRoot.length)
  function logical(value: string) {
    const candidates = new Set<string>()
    for (const root of roots) {
      const rel = paths.relative(root.snapshotRoot, value)
      if (!rel) candidates.add(root.logicalRoot)
      else if (root.kind === 'directory' && rel !== '..' && !rel.startsWith('..' + paths.sep) && !paths.isAbsolute(rel))
        candidates.add(paths.join(root.logicalRoot, rel))
    }
    if (candidates.size !== 1) throw new PeerBackupError(409, 'peer-backup/file-root-mismatch')
    return [...candidates][0]!
  }
  const records = [
    ...roots.map((r) => JSON.stringify(['role', r.role, r.owner, r.kind, r.logicalRoot])),
    ...snapshot.absent.map((path) => JSON.stringify(['absent', logical(path)])),
    ...snapshot.directories.map((r) => JSON.stringify(['directory', logical(r.path), r.mode, r.uid, r.gid])),
    ...snapshot.files.map((r) =>
      JSON.stringify(['file', logical(r.sourcePath), r.mode, r.uid, r.gid, r.sizeBytes, r.sha256]),
    ),
  ].sort()
  const hash = createHash('sha256')
  for (const row of records) hash.update(row + '\n')
  return hash.digest('hex')
}

/** Take an independent fresh snapshot while the source's owning Gateway holds real quiescence. */
export async function latestPeerFileWitness(
  exporter: PeerBackupExporter,
  binding: PeerBackupBinding,
  coordinate: { oldEpoch: string; revision: string },
  staging: string,
  signal: AbortSignal,
): Promise<string> {
  await peerPrivateDirectory(staging)
  const directory = await mkdtemp(join(staging, 'current-writer-'))
  try {
    const capture = await exporter.capture(binding, directory, signal)
    if (capture.gaps.length || capture.watermark !== coordinate.revision || capture.writerEpoch !== coordinate.oldEpoch)
      throw new PeerBackupError(409, 'peer-backup/new-quiescent-point-required')
    const roots = await verifiedPeerFileRoots(binding, directory, true)
    if (!roots) throw new PeerBackupError(409, 'peer-backup/file-verifier-unavailable')
    const { snapshot, sourcePlatform } = await readVerifiedPeerManagedFiles(join(directory, 'managed'), signal, 'roots.json')
    return logicalPeerFileDigest(roots, snapshot, sourcePlatform)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** Verify the replacement's private, byte-reconstructed filesystem again immediately before publishing it. */
export async function replacementFileDigest(
  roots: readonly { owner: string; kind: 'directory'; path: string }[],
  limits: { maxRows: number; maxBytes: number },
  signal: AbortSignal,
): Promise<string> {
  const names = new Set(roots.map((root) => root.owner))
  if (
    roots.length !== 4 ||
    names.size !== 4 ||
    ['workspace', 'runtime', 'userdoc-metadata', 'userdoc-objects'].some((name) => !names.has(name))
  )
    throw new PeerBackupError(409, 'peer-backup/invalid-target-files')
  const captured = await snapshotManagedFiles(roots, undefined, signal, {
    maxEntries: limits.maxRows,
    maxBytes: limits.maxBytes,
  })
  if (captured.roots.length !== 4 || captured.absent.length)
    throw new PeerBackupError(409, 'peer-backup/invalid-target-files')
  const role = (path: string) => {
    const owner = captured.roots.find((root) => root.path === path || path.startsWith(root.path + sep))
    if (!owner) throw new PeerBackupError(409, 'peer-backup/invalid-target-files')
    return [owner.owner, relative(owner.path, path)]
  }
  const rows = [
    ...captured.files.map((f) =>
      JSON.stringify(['file', ...role(f.sourcePath), f.mode, f.uid, f.gid, f.sizeBytes, f.sha256]),
    ),
    ...captured.directories.map((d) => JSON.stringify(['directory', ...role(d.path), d.mode, d.uid, d.gid])),
  ].sort()
  const sum = createHash('sha256')
  for (const row of rows) sum.update(row + '\n')
  return sum.digest('hex')
}
