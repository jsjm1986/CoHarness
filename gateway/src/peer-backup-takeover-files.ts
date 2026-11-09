/** Restore exactly one authenticated project's files into directories reserved by the receiving Gateway. */
import { chmod, lstat, mkdir, opendir, readFile, realpath, statfs, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { restoreDocumentIdentityBackup, type DocumentBackupEntry } from '@deepseek-ai/dsh-userdoc-local'
import { z } from 'zod'
import { logicalPeerFileDigest, replacementFileDigest } from './peer-backup-file-digest.ts'
import { copyVerifiedFile } from './managed-files.ts'
import {
  privateDirectoryState,
  protectedDirectoryState,
  syncStateDirectory,
  tightenPrivateFileAcl,
} from './node-private-file.ts'
import { PeerBackupError } from './peer-backup-repository.ts'
import { readVerifiedPeerManagedFiles, type PeerBackupDrill } from './peer-backup-restic.ts'
import { verifiedPeerFileRoots } from './peer-snapshot-roots.ts'
import type { PeerRecoveryOperation } from './peer-backup-takeover.ts'
import type { PeerRecoveryStageRoots } from './peer-backup-takeover-reservations.ts'
import type { ReplacementFiles } from './peer-backup-takeover-stage.ts'

interface TargetDocumentRoots {
  root: string
  stateRoot: string
  filesRoot: string
}

/** Path allocation is performed by trusted node configuration, never an Admin request or source manifest. */
export interface PeerProjectReplacementLayout {
  workspace: string
  runtimeHome: string
  /** Called after exclusive workspace creation. The existing UserDoc owner reserves its own two empty private directories. */
  documents(prepareFilesRoot?: (path:string)=>Promise<void>): Promise<TargetDocumentRoots>
}

const refused = (code: string): never => {
  throw new PeerBackupError(409, 'peer-backup/' + code)
}
const budget = (size: number, maximum: number) => {
  if (!Number.isSafeInteger(size) || size < 0 || size > maximum) refused('export-budget')
}

async function existing(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function assertEmpty(path: string) {
  const info = await lstat(path)
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (await privateDirectoryState(path, info)) !== 'private'
  )
    refused('invalid-target-files')
  const dir = await opendir(path)
  try {
    if (await dir.read()) refused('replacement-must-be-empty')
  } finally {
    await dir.close()
  }
}
async function createRoot(path: string, existence: 'absent' | 'empty') {
  const parent = dirname(path)
  if (
    !isAbsolute(path) ||
    parent === path ||
    path !== resolve(path) ||
    (await realpath(parent)) !== parent ||
    (await protectedDirectoryState(parent, await lstat(parent))) !== 'protected'
  )
    refused('invalid-target-files')
  if (existence === 'absent' || !(await existing(path))) {
    await mkdir(path, { mode: 0o700 })
    if (process.platform === 'win32') await tightenPrivateFileAcl(path)
  }
  await assertEmpty(path)
}
function within(parent: string, path: string, flavor: typeof posix | typeof win32): boolean {
  const rest = flavor.relative(parent, path)
  return !rest || (rest !== '..' && !rest.startsWith('..' + flavor.sep) && !flavor.isAbsolute(rest))
}
function tail(source: string, parts: string[], destination: string): string {
  if (
    parts.some(
      (part) =>
        !part ||
        ['.', '..'].includes(part) ||
        part.includes('\0') ||
        part.includes('/') ||
        part.includes('\\') ||
        (process.platform === 'win32' &&
          (/[<>:"|?*\u0000-\u001f]/u.test(part) ||
            /[. ]$/u.test(part) ||
            /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(part))),
    )
  )
    refused('nonportable-path')
  const result = join(destination, ...parts)
  const rest = relative(destination, result)
  if (rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest) || !source) refused('invalid-target-files')
  return result
}

/** Reconstruct and byte-check every approved member, restore UserDoc identity and derive new device witnesses. */
export async function stagePeerProjectFiles(
  op: PeerRecoveryOperation,
  drill: PeerBackupDrill,
  layout: PeerProjectReplacementLayout,
  limits: { maxBytes: number; maxRows: number; reserveBytes: number },
  signal: AbortSignal,
  reservations?: PeerRecoveryStageRoots,
): Promise<ReplacementFiles> {
  const point = drill.point
  if (
    point.gapCount ||
    point.organizationId !== op.organizationId ||
    point.scopeId !== op.projectId ||
    point.sourceNodeId !== op.sourceNode ||
    point.writerEpoch !== op.oldEpoch ||
    point.watermark !== op.revision ||
    point.pointId !== op.pointId ||
    point.manifestDigest !== op.digest
  )
    refused('point-mismatch')
  const files = join(drill.directory, 'managed')
  const roles = await verifiedPeerFileRoots(point, drill.directory, true)
  if (!roles) return refused('file-verifier-unavailable')
  const { snapshot, sourcePlatform } = await readVerifiedPeerManagedFiles(files, signal, 'roots.json')
  const flavor = sourcePlatform === 'win32' ? win32 : posix
  const locate = (role: string) => roles.roots.find((row) => row.role === role) ?? refused('file-root-mismatch')
  const workspace = locate('workspace'),
    storage = locate('runtime-data')
  const sourceHome = flavor.dirname(storage.logicalRoot)
  if (flavor.basename(storage.logicalRoot) !== 'storages' || flavor.basename(sourceHome) !== 'dsh')
    refused('file-root-mismatch')
  const count = snapshot.files.length + snapshot.directories.length + snapshot.absent.length
  const bytes = snapshot.files.reduce((total, row) => total + row.sizeBytes, 0)
  budget(count, limits.maxRows)
  budget(bytes, limits.maxBytes)
  // Both physical ownership roots are independent of all path strings in the encrypted checkpoint.
  for (const path of [layout.workspace, layout.runtimeHome]) if (await existing(path)) refused('replacement-must-be-empty')
  if (reservations) {
    await reservations.reserve('workspace',layout.workspace)
    await reservations.reserve('runtime',layout.runtimeHome)
  } else {
    await createRoot(layout.workspace,'absent')
    await createRoot(layout.runtimeHome,'absent')
  }
  const docs = await layout.documents(reservations ? path=>reservations.reserve('userdoc-files',path) : undefined)
  if (
    docs.root !== join(layout.workspace, 'documents') ||
    new Set([docs.root, docs.stateRoot, docs.filesRoot]).size !== 3 ||
    within(layout.workspace, docs.stateRoot, process.platform === 'win32' ? win32 : posix) ||
    within(layout.workspace, docs.filesRoot, process.platform === 'win32' ? win32 : posix)
  )
    refused('invalid-target-files')
  if (reservations) await reservations.reserve('userdoc-metadata',docs.stateRoot)
  else await createRoot(docs.stateRoot, 'empty')
  await createRoot(docs.filesRoot, 'empty')
  for (const path of [layout.workspace, layout.runtimeHome, docs.stateRoot, docs.filesRoot]) {
    const fs = await statfs(path, { bigint: true })
    if (fs.bavail * fs.bsize < BigInt(bytes) + BigInt(limits.reserveBytes)) refused('insufficient-space')
  }
  const assigned = new Map<string, string>([
    ['workspace', layout.workspace],
    ['runtime-data', join(layout.runtimeHome, 'storages')],
    ['userdoc-public', docs.root],
    ['userdoc-metadata', docs.stateRoot],
    ['userdoc-objects', docs.filesRoot],
  ])
  function translate(value: string, from: string, to: string) {
    const rel = flavor.relative(from, value)
    if (!within(from, value, flavor)) return refused('foreign-storage-path')
    return tail(value, rel ? rel.split(flavor.sep) : [], to)
  }
  function logical(value: string): string {
    if (!flavor.isAbsolute(value) || flavor.normalize(value) !== value) return refused('foreign-storage-path')
    for (const role of roles!.roots
      .filter((row) => row.role !== 'plugin')
      .sort((a, b) => b.logicalRoot.length - a.logicalRoot.length)) {
      if (within(role.logicalRoot, value, flavor)) return translate(value, role.logicalRoot, assigned.get(role.role)!)
    }
    if (within(sourceHome, value, flavor)) return translate(value, sourceHome, layout.runtimeHome)
    return refused('foreign-storage-path')
  }
  const scopes = roles.roots
    .map((row) => ({ ...row, target: logical(row.logicalRoot) }))
    .sort((a, b) => b.snapshotRoot.length - a.snapshotRoot.length)
  function destination(value: string) {
    const choices = scopes.filter((row) => within(row.snapshotRoot, value, flavor))
    const destinations = new Set(choices.map((row) => translate(value, row.snapshotRoot, row.target)))
    if (destinations.size !== 1) return refused('file-root-mismatch')
    return [...destinations][0]!
  }
  const before = new Set<string>(),
    claimed = new Map<string, string>()
  for (const raw of [
    ...snapshot.directories.map((row) => row.path),
    ...snapshot.files.map((row) => row.sourcePath),
    ...snapshot.absent,
  ]) {
    const name = destination(raw),
      folded = name.normalize('NFC').toLowerCase()
    if (claimed.has(folded) && claimed.get(folded) !== raw) refused('destination-path-collision')
    claimed.set(folded, raw)
  }
  for (const path of [layout.workspace, layout.runtimeHome, docs.stateRoot, docs.filesRoot]) before.add(path)
  const evidence: DocumentBackupEntry[] = []
  for (const row of snapshot.directories.slice().sort((a, b) => a.path.length - b.path.length)) {
    signal.throwIfAborted()
    const path = destination(row.path)
    if (!before.has(path)) {
      await mkdir(path, { recursive: true, mode: 0o700 })
      if (process.platform === 'win32') await tightenPrivateFileAcl(path)
    }
    if ((await realpath(path)) !== path) refused('invalid-target-files')
    evidence.push({ path, object: row.object })
  }
  for (const row of snapshot.files) {
    signal.throwIfAborted()
    const path = destination(row.sourcePath)
    // A claimed standalone plugin file may live directly under the reserved Runtime directory.
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    if ((await realpath(dirname(path))) !== dirname(path)) refused('invalid-target-files')
    const copied = await copyVerifiedFile(join(files, row.member), path, signal)
    if (copied.sha256 !== row.sha256 || copied.sizeBytes !== row.sizeBytes) refused('file-digest')
    if (process.platform !== 'win32' && (row.mode & 0o100) !== 0) await chmod(path, 0o700)
    evidence.push({ path, object: row.object, sizeBytes: row.sizeBytes, sha256: row.sha256, modifiedAt: row.modifiedAt })
  }
  const owner = roles.roots.find((row) => row.role === 'plugin' && row.owner === 'project-managed-inventory')
  if (owner) {
    const path = logical(owner.logicalRoot)
    if (
      path !== join(layout.runtimeHome, 'managed-data.jsonl') ||
      !snapshot.files.some((row) => destination(row.sourcePath) === path)
    )
      refused('invalid-plugin-inventory')
    const text = await readFile(path, 'utf8')
    if (text && !text.endsWith('\n')) refused('invalid-plugin-inventory')
    const format = z
      .object({
        version: z.literal(1),
        owner: z.string().min(1),
        kind: z.enum(['file', 'directory']),
        path: z.string().min(1),
      })
      .strict()
    const claims = text.trimEnd()
      ? text
          .trimEnd()
          .split('\n')
          .map((line) => format.parse(JSON.parse(line)))
      : []
    const mapped = claims.map((row) => {
      if (!roles.roots.some((root) => root.owner === row.owner && root.kind === row.kind && root.logicalRoot === row.path))
        refused('invalid-plugin-inventory')
      return JSON.stringify({ ...row, path: logical(row.path) })
    })
    await writeFile(path, mapped.length ? mapped.join('\n') + '\n' : '', { mode: 0o600, flush: true })
  }
  const db = new DatabaseSync(join(docs.stateRoot, 'metadata.sqlite'), { readOnly: true })
  try {
    if (db.prepare('SELECT root_id FROM document_identity_root WHERE slot=1').get()?.root_id !== roles.documentRootId)
      refused('document-root-mismatch')
  } finally {
    db.close()
  }
  await restoreDocumentIdentityBackup(docs, evidence, signal)
  const roots = []
  for (const [owner, path] of [
    ['workspace', layout.workspace],
    ['runtime', layout.runtimeHome],
    ['storage', join(layout.runtimeHome, 'storages')],
  ] as const) {
    const info = await existing(path),
      anchor = info ? path : dirname(path)
    if ((await realpath(anchor)) !== anchor) refused('invalid-target-files')
    const actual = await lstat(anchor, { bigint: true })
    if (!actual.isDirectory() || actual.isSymbolicLink()) refused('invalid-target-files')
    roots.push({ owner, path, anchorPath: anchor, device: String(actual.dev), inode: String(actual.ino), missing: !info })
  }
  for (const path of [layout.workspace, layout.runtimeHome, docs.stateRoot, docs.filesRoot]) await syncStateDirectory(path)
  const protectedRoots = [
    ['workspace', layout.workspace],
    ['runtime', layout.runtimeHome],
    ['userdoc-metadata', docs.stateRoot],
    ['userdoc-objects', docs.filesRoot],
  ].map(([owner, path]) => ({ owner: owner!, path: path!, kind: 'directory' as const }))
  return {
    workspacePath: layout.workspace,
    roots,
    protectedRoots,
    targetFilesDigest: await replacementFileDigest(protectedRoots, limits, signal),
    documentRootId: roles.documentRootId,
    localPath: logical,
    sourceFilesDigest: logicalPeerFileDigest(roles, snapshot, sourcePlatform),
  }
}
