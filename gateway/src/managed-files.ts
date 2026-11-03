/** Recursive, byte-verified snapshots of explicitly owned local application data. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, chown, lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ManagedDataPath } from '@deepseek-ai/dsh-managed-data'

interface FileMetadata {
  mode: number
  uid: number
  gid: number
  /** Original kernel evidence; content comparison deliberately excludes this restore-varying value. */
  object?: { device: string; inode: string }
}

/** One regular file captured alongside a database dump. */
export interface ManagedFileEntry extends FileMetadata {
  member: string
  sourcePath: string
  sizeBytes: number
  sha256: string
  /** Original nanosecond timestamp expressed in milliseconds for identity-aware restoration. */
  modifiedAt?: number
}

/** Complete directory membership, including empty directories and absent declared roots. */
export interface ManagedSnapshot {
  version: 1
  roots: ManagedDataPath[]
  directories: Array<FileMetadata & { path: string }>
  absent: string[]
  files: ManagedFileEntry[]
}

/** Verified pre-restore control files retained while application data returns to an older snapshot. */
export interface PreservedManagedFiles {
  filesDir: string
  snapshot: ManagedSnapshot
  paths: readonly string[]
}

function beneath(parent: string, path: string): boolean {
  const tail = relative(parent, path)
  return tail === '' || (!isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${sep}`))
}

async function infoOrAbsent(path: string) {
  try { return await lstat(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Canonicalize existing ancestors while refusing a symbolic root itself. */
async function canonicalRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('Managed data root must be a normalized absolute path')
  const info = await infoOrAbsent(path)
  if (info?.isSymbolicLink()) throw new Error(`Managed data root is a symbolic link: ${path}`)
  if (info !== undefined) return realpath(path)
  const parent = dirname(path)
  if (parent === path) throw new Error(`Managed data root is unavailable: ${path}`)
  return join(await canonicalRoot(parent), relative(parent, path))
}

/**
 * Resolve and deduplicate configured roots without following links inside their contents.
 * @param paths - storage ownership already checked against the deployment's permitted locations.
 * @returns canonical roots; directory ownership subsumes narrower claims.
 */
export async function normalizeManagedRoots(paths: readonly ManagedDataPath[]): Promise<ManagedDataPath[]> {
  const rows = await Promise.all(paths.map(async row => ({ ...row, path: await canonicalRoot(row.path) })))
  rows.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const result: ManagedDataPath[] = []
  for (const row of rows) {
    const info = await infoOrAbsent(row.path)
    if (info !== undefined && (row.kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
      throw new Error(`Managed data root has the wrong kind: ${row.path}`)
    }
    const previous = result.find(parent => parent.path === row.path || (parent.kind === 'directory' && beneath(parent.path, row.path)))
    if (previous?.path === row.path && previous.kind !== row.kind) throw new Error(`Conflicting managed data kinds: ${row.path}`)
    if (previous === undefined) result.push(row)
  }
  return result
}

function metadata(info: { mode: bigint; uid: bigint; gid: bigint; dev: bigint; ino: bigint }): FileMetadata {
  return { mode: Number(info.mode & 0o7777n), uid: Number(info.uid), gid: Number(info.gid),
    object: { device: String(info.dev), inode: String(info.ino) } }
}

async function fingerprint(path: string, destination?: string, signal?: AbortSignal): Promise<{
  sizeBytes: number; sha256: string; object: { device: string; inode: string }; modifiedAt: number
}> {
  signal?.throwIfAborted()
  const source = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let copied: Awaited<ReturnType<typeof open>> | undefined
  try {
    const before = await source.stat()
    const original = await source.stat({ bigint: true })
    if (!before.isFile()) throw new Error(`Managed data is not a regular file: ${path}`)
    if (destination !== undefined) copied = await open(destination, 'wx', 0o600)
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024)
    let sizeBytes = 0
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await source.read(buffer)
      if (bytesRead === 0) break
      const bytes = buffer.subarray(0, bytesRead)
      hash.update(bytes)
      sizeBytes += bytesRead
      if (copied !== undefined) {
        let position = 0
        while (position < bytesRead) {
          signal?.throwIfAborted()
          const { bytesWritten } = await copied.write(bytes.subarray(position))
          if (bytesWritten === 0) throw new Error('Managed file write made no progress')
          position += bytesWritten
        }
      }
    }
    const after = await source.stat(), current = await lstat(path)
    if (before.size !== sizeBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error(`Managed file changed during backup: ${path}`)
    }
    await copied?.sync()
    signal?.throwIfAborted()
    return { sizeBytes, sha256: hash.digest('hex'),
      object: { device: String(original.dev), inode: String(original.ino) }, modifiedAt: Number(original.mtimeNs) / 1e6 }
  } finally {
    await Promise.all([source.close(), copied?.close()])
  }
}

/**
 * Capture a regular artifact through one no-follow descriptor and hash the copied bytes.
 * @param source - caller-authorized file; replacement or mutation during copying fails.
 * @param destination - exclusively created private staging file.
 * @param signal - operation lifetime, checked between partial writes and after synchronization.
 * @returns the copied size and digest after flushing its bytes.
 */
export async function copyVerifiedFile(source: string, destination: string, signal?: AbortSignal): Promise<{ sizeBytes: number; sha256: string }> {
  const { sizeBytes, sha256 } = await fingerprint(source, destination, signal)
  return { sizeBytes, sha256 }
}

/**
 * Scan every selected data member and optionally capture its bytes in private storage.
 * @param paths - explicitly owned roots; callers must hold the writer exclusion lease.
 * @param filesDir - new private snapshot directory, or absent for a read-only comparison.
 * @param signal - aborts between reads, partial writes and entries, and after synchronization.
 * @returns a complete sorted membership and content manifest.
 */
export async function snapshotManagedFiles(paths: readonly ManagedDataPath[], filesDir?: string, signal?: AbortSignal): Promise<ManagedSnapshot> {
  const roots = await normalizeManagedRoots(paths)
  const destination = filesDir === undefined ? undefined : await canonicalRoot(resolve(filesDir))
  if (destination !== undefined && roots.some(root => beneath(root.path, destination))) {
    throw new Error('Backup directory must be outside managed data roots')
  }
  const snapshot: ManagedSnapshot = { version: 1, roots, directories: [], absent: [], files: [] }
  async function visit(path: string, root: boolean, declaredKind?: ManagedDataPath['kind']): Promise<void> {
    signal?.throwIfAborted()
    const info = await lstat(path, { bigint: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (info === undefined) {
      if (!root) throw new Error(`Managed data disappeared during backup: ${path}`)
      snapshot.absent.push(path)
    } else if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new Error(`Managed data contains a link or special file: ${path}`)
    } else if (declaredKind !== undefined && (info.isDirectory() ? 'directory' : 'file') !== declaredKind) {
      throw new Error(`Managed data root has the wrong kind: ${path}`)
    } else if (info.isDirectory()) {
      const transient = (name: string): boolean => roots.some(row => row.owner.startsWith('gateway-documents/')
        && (row.owner.endsWith('/metadata') && row.path === path && name === 'mutation.lock'
          || row.owner.endsWith('/files') && row.path === path && name === 'domain.lock'))
      const names = (await readdir(path)).filter(name => !transient(name)).sort()
      snapshot.directories.push({ path, ...metadata(info) })
      for (const name of names) await visit(join(path, name), false)
      const after = await lstat(path, { bigint: true })
      const ignoresLocks = transient('mutation.lock') || transient('domain.lock')
      if (after.dev !== info.dev || after.ino !== info.ino || after.mode !== info.mode || after.uid !== info.uid || after.gid !== info.gid
        || !ignoresLocks && after.ctimeNs !== info.ctimeNs
        || JSON.stringify((await readdir(path)).filter(name => !transient(name)).sort()) !== JSON.stringify(names)) {
        throw new Error(`Managed directory changed during backup: ${path}`)
      }
    } else {
      const member = `${snapshot.files.length.toString().padStart(8, '0')}.data`
      const digest = await fingerprint(path, filesDir === undefined ? undefined : join(filesDir, member), signal)
      snapshot.files.push({ member, sourcePath: path, ...metadata(info), ...digest })
    }
  }
  for (const root of roots) await visit(root.path, true, root.kind)
  return snapshot
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid managed snapshot object')
  return value as Record<string, unknown>
}

function absolute(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || value.includes('\0')) throw new Error('Invalid managed snapshot path')
  return value
}

function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid managed snapshot integer')
  return value
}

function parseMetadata(value: Record<string, unknown>): FileMetadata {
  const entry = { mode: integer(value.mode, 0o7777), uid: integer(value.uid), gid: integer(value.gid) }
  if (value.object === undefined) return entry
  const original = object(value.object)
  if (typeof original.device !== 'string' || !/^\d+$/u.test(original.device)
    || typeof original.inode !== 'string' || !/^[1-9]\d*$/u.test(original.inode)) throw new Error('Invalid managed snapshot object identity')
  return { ...entry, object: { device: original.device, inode: original.inode } }
}

/**
 * Validate durable snapshot metadata before any destination writes.
 * @param value - untrusted JSON from a backup or registry.
 * @returns versioned complete snapshot; legacy shallow arrays require a new backup.
 */
export function parseManagedSnapshot(value: unknown): ManagedSnapshot {
  const row = object(value)
  if (row.version !== 1 || !Array.isArray(row.roots) || !Array.isArray(row.files)
    || !Array.isArray(row.directories) || !Array.isArray(row.absent)) throw new Error('Unsupported or incomplete managed snapshot')
  const roots = row.roots.map((item): ManagedDataPath => {
    const root = object(item)
    if (typeof root.owner !== 'string' || root.owner === '' || (root.kind !== 'file' && root.kind !== 'directory')) throw new Error('Invalid managed snapshot root')
    return { owner: root.owner, kind: root.kind, path: absolute(root.path) }
  })
  const directories = row.directories.map(item => { const dir = object(item); return { path: absolute(dir.path), ...parseMetadata(dir) } })
  const absent = row.absent.map(absolute)
  const files = row.files.map((item): ManagedFileEntry => {
    const entry = object(item)
    if (typeof entry.member !== 'string' || !/^\d{8,}\.data$/u.test(entry.member)
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(entry.sha256)) throw new Error('Invalid managed snapshot member')
    if (entry.modifiedAt !== undefined && (typeof entry.modifiedAt !== 'number' || !Number.isFinite(entry.modifiedAt)
      || entry.modifiedAt < 0)) throw new Error('Invalid managed snapshot modification time')
    return { member: entry.member, sourcePath: absolute(entry.sourcePath), sizeBytes: integer(entry.sizeBytes), sha256: entry.sha256,
      ...parseMetadata(entry), ...entry.modifiedAt === undefined ? {} : { modifiedAt: entry.modifiedAt } }
  })
  const allPaths = [...absent, ...directories.map(dir => dir.path), ...files.map(file => file.sourcePath)]
  const rootsByPath = new Map(roots.map(root => [root.path, root]))
  const directoryPaths = new Set(directories.map(dir => dir.path))
  const filePaths = new Set(files.map(file => file.sourcePath))
  const absentPaths = new Set(absent)
  if (rootsByPath.size !== roots.length || new Set(allPaths).size !== allPaths.length
    || new Set(files.map(file => file.member)).size !== files.length) throw new Error('Duplicate managed snapshot member')
  const directoryRootAbove = (path: string): ManagedDataPath | undefined => {
    for (let parent = dirname(path); parent !== path; parent = dirname(path)) {
      const root = rootsByPath.get(parent)
      if (root?.kind === 'directory') return root
      path = parent
    }
    return undefined
  }
  for (const root of roots) {
    if (directoryRootAbove(root.path) !== undefined) throw new Error('Overlapping managed snapshot roots')
    if (!absentPaths.has(root.path) && !(root.kind === 'file' ? filePaths.has(root.path) : directoryPaths.has(root.path))) throw new Error('Managed snapshot root is missing')
  }
  for (const path of allPaths) {
    const root = rootsByPath.get(path) ?? directoryRootAbove(path)
    if (root === undefined || (absentPaths.has(root.path) && path !== root.path)) throw new Error('Managed snapshot member is outside its root')
    if (path !== root.path && !directoryPaths.has(dirname(path))) throw new Error('Managed snapshot parent is missing')
    if (root.kind === 'file' && directoryPaths.has(path)) throw new Error('File root cannot contain a directory')
    if (root.kind === 'directory' && path === root.path && filePaths.has(path)) throw new Error('Directory root cannot contain a file at its root')
  }
  if (absent.some(path => !rootsByPath.has(path))) throw new Error('Only a managed root may be recorded as absent')
  return { version: 1, roots, directories, absent, files }
}

/**
 * Verify the private snapshot bytes, including missing and extra data members.
 * @param filesDir - backup-owned files directory.
 * @param snapshot - previously parsed metadata.
 * @param signal - operation lifetime.
 * @returns after every stored byte matches its manifest.
 */
export async function verifyStoredFiles(filesDir: string, snapshot: ManagedSnapshot, signal?: AbortSignal): Promise<void> {
  const directory = await lstat(filesDir)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Backup member directory must be a real directory')
  const expected = [...snapshot.files.map(file => file.member), 'manifest.json'].sort()
  if (JSON.stringify((await readdir(filesDir)).sort()) !== JSON.stringify(expected)) throw new Error('Backup member set differs from its manifest')
  for (const entry of snapshot.files) {
    const actual = await fingerprint(join(filesDir, entry.member), undefined, signal)
    if (actual.sizeBytes !== entry.sizeBytes || actual.sha256 !== entry.sha256) throw new Error(`Backup managed file digest mismatch: ${entry.member}`)
  }
}

/**
 * Compare full live membership and content against a backup, including additions.
 * @param snapshot - verified snapshot selected for comparison.
 * @param signal - operation lifetime.
 * @returns paths whose kind, presence, permissions, ownership or contents differ.
 */
export async function compareManagedFiles(snapshot: ManagedSnapshot, signal?: AbortSignal): Promise<string[]> {
  const live = await snapshotManagedFiles(snapshot.roots, undefined, signal)
  const entries = (data: ManagedSnapshot) => new Map([
    ...data.absent.map(path => [path, 'absent'] as const),
    ...data.directories.map(dir => [dir.path, JSON.stringify(['directory', dir.mode, dir.uid, dir.gid])] as const),
    ...data.files.map(file => [file.sourcePath, JSON.stringify(['file', file.mode, file.uid, file.gid, file.sizeBytes, file.sha256])] as const),
  ])
  const before = entries(snapshot), now = entries(live)
  return [...new Set([...before.keys(), ...now.keys()])].sort().filter(path => before.get(path) !== now.get(path))
}

/**
 * Derive exact restored data membership while retaining explicitly classified current control files.
 * @param selected - immutable application backup selected by the administrator.
 * @param preserved - immutable pre-restore files and the node-owned paths to retain.
 * @returns a deterministic expected snapshot; neither source artifact is changed.
 */
export function deriveManagedRestoreSnapshot(selected: ManagedSnapshot, preserved?: PreservedManagedFiles): ManagedSnapshot {
  if (preserved === undefined || preserved.paths.length === 0) return selected
  const result = structuredClone(selected)
  for (const path of new Set(preserved.paths)) {
    const root = preserved.snapshot.roots.find(root => root.path === path && root.kind === 'file')
    if (root === undefined) throw new Error(`Preserved control file lacks independent ownership: ${path}`)
    const previous = result.roots.find(root => root.path === path)
    if (previous !== undefined && previous.kind !== 'file') throw new Error(`Preserved control file conflicts with a directory: ${path}`)
    if (result.roots.some(root => root.kind === 'directory' && beneath(root.path, path))) throw new Error(`Preserved control file is nested in application data: ${path}`)
    if (previous === undefined) result.roots.push(root)
    result.files = result.files.filter(file => file.sourcePath !== path)
    result.absent = result.absent.filter(absent => absent !== path)
    const file = preserved.snapshot.files.find(file => file.sourcePath === path)
    if (file === undefined) {
      if (!preserved.snapshot.absent.includes(path)) throw new Error(`Preserved control file is missing from its snapshot: ${path}`)
      result.absent.push(path)
    } else result.files.push(file)
  }
  result.roots.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  result.absent.sort()
  result.files.sort((a, b) => a.sourcePath < b.sourcePath ? -1 : a.sourcePath > b.sourcePath ? 1 : 0)
  result.files = result.files.map((file, index) => ({ ...file, member: `${index.toString().padStart(8, '0')}.data` }))
  return parseManagedSnapshot(result)
}

/**
 * Reject backup-supplied destinations absent from independently established current ownership.
 * @param snapshot - selected or derived restoration membership.
 * @param allowed - roots from the verified pre-restore ownership inventory.
 * @returns canonical authorized roots, before any database or file replacement.
 */
export async function validateManagedRestoreRoots(snapshot: ManagedSnapshot, allowed: readonly ManagedDataPath[]): Promise<ManagedDataPath[]> {
  const authorized = await normalizeManagedRoots(allowed)
  for (const root of snapshot.roots) {
    if (!authorized.some(current => (current.path === root.path && current.kind === root.kind)
      || (current.kind === 'directory' && beneath(current.path, root.path)))) throw new Error(`Restore root is not authorized by this deployment: ${root.path}`)
  }
  return authorized
}

/**
 * Refuse concurrent edits to control files instead of copying an older control revision over them.
 * @param preserved - immutable control-file evidence from the first protection backup.
 * @param signal - operation lifetime.
 * @returns when current control bytes and metadata still match that evidence.
 */
export async function verifyPreservedManagedFiles(preserved: PreservedManagedFiles, signal?: AbortSignal): Promise<void> {
  const paths = new Set(preserved.paths)
  const expected: ManagedSnapshot = { version: 1,
    roots: preserved.snapshot.roots.filter(root => paths.has(root.path)), directories: [],
    absent: preserved.snapshot.absent.filter(path => paths.has(path)),
    files: preserved.snapshot.files.filter(file => paths.has(file.sourcePath)),
  }
  if ((await compareManagedFiles(expected, signal)).length > 0) throw new Error('Current control files changed after the protection backup')
}

/**
 * Restore recorded members without silently accepting unapproved destination roots.
 * @param filesDir - verified backup directory.
 * @param selected - complete application snapshot selected for restoration.
 * @param allowed - current deployment-owned roots, never paths granted by the backup itself.
 * @param signal - operation lifetime.
 * @param preserved - explicitly classified current control files from the verified protection backup.
 * @returns the exact restored snapshot after every member has been flushed; partial failure must retain maintenance fencing.
 */
export async function restoreManagedSnapshot(filesDir: string, selected: ManagedSnapshot, allowed: readonly ManagedDataPath[], signal?: AbortSignal,
  preserved?: PreservedManagedFiles): Promise<ManagedSnapshot> {
  await verifyStoredFiles(filesDir, selected, signal)
  if (preserved !== undefined) await verifyStoredFiles(preserved.filesDir, preserved.snapshot, signal)
  const snapshot = deriveManagedRestoreSnapshot(selected, preserved)
  if (preserved !== undefined) await verifyPreservedManagedFiles(preserved, signal)
  const authorized = await validateManagedRestoreRoots(snapshot, allowed)
  // The caller retains a verified pre-restore backup. Reconcile all previously
  // owned roots, including a runtime created after the selected backup.
  const live = await snapshotManagedFiles(authorized, undefined, signal)
  const filePaths = new Set(snapshot.files.map(entry => entry.sourcePath))
  const directoryPaths = new Set(snapshot.directories.map(entry => entry.path))
  for (const file of live.files) {
    if (filePaths.has(file.sourcePath)) continue
    signal?.throwIfAborted()
    await unlink(file.sourcePath)
  }
  for (const dir of [...live.directories].sort((a, b) => b.path.length - a.path.length)) {
    if (directoryPaths.has(dir.path)) continue
    signal?.throwIfAborted()
    await rmdir(dir.path)
  }
  for (const dir of [...snapshot.directories].sort((a, b) => a.path.length - b.path.length)) {
    signal?.throwIfAborted()
    const info = await infoOrAbsent(dir.path)
    if (info !== undefined && (!info.isDirectory() || info.isSymbolicLink())) throw new Error(`Restore directory has the wrong kind: ${dir.path}`)
    await mkdir(dir.path, { recursive: true, mode: 0o700 })
    if (await realpath(dir.path) !== dir.path) throw new Error(`Restore path contains a link: ${dir.path}`)
  }
  for (const entry of snapshot.files) {
    signal?.throwIfAborted()
    if (preserved?.paths.includes(entry.sourcePath)) continue
    await mkdir(dirname(entry.sourcePath), { recursive: true, mode: 0o700 })
    if (await realpath(dirname(entry.sourcePath)) !== dirname(entry.sourcePath)) throw new Error(`Restore path contains a link: ${entry.sourcePath}`)
    const temporary = join(dirname(entry.sourcePath), `.hgw-restore-${randomUUID()}`)
    try {
      const member = selected.files.find(file => file.sourcePath === entry.sourcePath)!
      const actual = await fingerprint(join(filesDir, member.member), temporary, signal)
      if (actual.sha256 !== entry.sha256 || actual.sizeBytes !== entry.sizeBytes) throw new Error('Backup changed during restoration')
      await chown(temporary, entry.uid, entry.gid)
      await chmod(temporary, entry.mode)
      const handle = await open(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { await handle.sync() } finally { await handle.close() }
      signal?.throwIfAborted()
      await rename(temporary, entry.sourcePath)
    } finally { await rm(temporary, { force: true }) }
  }
  for (const dir of [...snapshot.directories].sort((a, b) => b.path.length - a.path.length)) {
    await chown(dir.path, dir.uid, dir.gid)
    await chmod(dir.path, dir.mode)
  }
  for (const directory of new Set([...snapshot.directories.map(dir => dir.path),
    ...authorized.map(root => dirname(root.path)), ...live.directories.map(dir => dirname(dir.path))])) {
    signal?.throwIfAborted()
    if (await infoOrAbsent(directory) === undefined) continue
    const handle = await open(directory, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }
  return snapshot
}
