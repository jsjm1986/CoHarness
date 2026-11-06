/** Explicit locations for public documents, private metadata and retained filesystem objects. */

import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { isInside } from './name.ts'
import { withDocumentHandle } from './handle.ts'

// oxlint-disable-next-line typescript/no-unnecessary-condition -- filesystem constants vary by host.
const PRIVATE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** Deployment-resolved locations; private parents must already exist. */
export interface DocumentIdentityLocations {
  /** Ordinary document files exposed to the runtime workspace. */
  readonly root: string
  /** Private SQLite database and cross-process mutation lock. */
  readonly stateRoot: string
  /** Private anchors, retained objects, upload sources and trash on the document filesystem. */
  readonly filesRoot: string
}

/** Kernel directory identities bound to one metadata database. */
export interface DocumentStorageBinding {
  readonly documents: { readonly device: string; readonly inode: string; readonly volume?: string }
  readonly files: { readonly device: string; readonly inode: string; readonly volume?: string }
}

interface StorageObject {
  readonly device: string
  readonly inode: string
  readonly volume?: string
}

function privateAccess(info: { uid: number | bigint; mode: number | bigint }): void {
  /* v8 ignore next 3 -- POSIX uid/mode refusal; win32 has no getuid, so the guard can never hold there. */
  if (process.getuid !== undefined && (BigInt(info.uid) !== BigInt(process.getuid()) || (BigInt(info.mode) & 0o077n) !== 0n)) {
    throw new Error('Private document storage must be accessible only to its owning process account.')
  }
}

async function directory(path: string, privateEntry: boolean): Promise<StorageObject> {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) throw new Error('Document storage requires a real directory.')
  if (privateEntry) privateAccess(info)
  return { device: String(info.dev), inode: String(info.ino) }
}

async function privateDirectory(path: string): Promise<StorageObject> {
  await directory(dirname(path), true)
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return directory(path, true)
}

function same(left: StorageObject, right: StorageObject): boolean {
  return left.device === right.device && left.inode === right.inode
}

async function persistentObject(path: string, expected: StorageObject): Promise<StorageObject> {
  /* v8 ignore start -- win32 returns early; the DirectoryHandle identity recheck after it is POSIX-only code. */
  if (process.platform === 'win32') return expected
  const { DirectoryHandle } = await import('@deepseek-ai/node-addon-system/directory')
  const handle = await DirectoryHandle.open(path)
  return withDocumentHandle(handle, async () => {
    if (String(handle.identity.device) !== expected.device || String(handle.identity.inode) !== expected.inode) {
      throw new Error('Document storage directory changed while its volume identity was opened.')
    }
    const volume = await handle.volumeIdentity()
    if (!same(await directory(path, false), expected)) throw new Error('Document storage directory changed while its volume identity was read.')
    return { ...expected, ...volume === undefined ? {} : { volume } }
  })
  /* v8 ignore stop */
}

function recordedObject(value: unknown, expected: StorageObject, persistent: boolean): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && 'device' in value && typeof value.device === 'string' && /^(?:0|[1-9][0-9]*)$/u.test(value.device)
    && 'inode' in value && value.inode === expected.inode
    /* v8 ignore start -- only POSIX persistence writes a volume id, so win32 lanes never measure this arm. */
    && (persistent && 'volume' in value
      ? typeof value.volume === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.volume) && value.volume === expected.volume
      : value.device === expected.device)
    /* v8 ignore stop */
}

async function containsDirectory(path: string, expected: StorageObject): Promise<boolean> {
  for (let current = path;; current = dirname(current)) {
    if (same(await directory(current, false), expected)) return true
    if (dirname(current) === current) return false
  }
}

/** A provider-owned storage layout; its caller provisions OS and runtime-mount isolation. */
export class DocumentIdentityStorage {
  private metadata: StorageObject | undefined
  private constructor(
    readonly locations: DocumentIdentityLocations,
    readonly binding: DocumentStorageBinding,
    private readonly state: StorageObject,
  ) {}

  /**
   * Validate disjoint real roots and create private leaves without changing existing access rights.
   * @param locations - explicit absolute locations whose private parents belong to the provider.
   * @returns validated locations and directory identities; retained objects share the document filesystem.
   */
  static async open(locations: DocumentIdentityLocations): Promise<DocumentIdentityStorage> {
    const paths = [locations.root, locations.stateRoot, locations.filesRoot]
    if (paths.some(path => !isAbsolute(path) || resolve(path) !== path)) throw new Error('Document storage locations must be absolute.')
    const pairs = [[locations.root, locations.stateRoot], [locations.root, locations.filesRoot],
      [locations.stateRoot, locations.filesRoot]] as const
    for (const [left, right] of pairs) {
      if (isInside(left, right) || isInside(right, left)) throw new Error('Public and private document storage locations must not overlap.')
    }
    const documents = await directory(locations.root, false)
    const [documentPath, statePath, filesPath] = await Promise.all([
      realpath(locations.root),
      realpath(dirname(locations.stateRoot)).then(parent => join(parent, basename(locations.stateRoot))),
      realpath(dirname(locations.filesRoot)).then(parent => join(parent, basename(locations.filesRoot))),
    ])
    for (const [left, right] of [[documentPath, statePath], [documentPath, filesPath], [statePath, filesPath]] as const) {
      if (isInside(left, right) || isInside(right, left)) {
        throw new Error('Document storage directories resolve to overlapping locations.')
      }
    }
    const state = await privateDirectory(locations.stateRoot), files = await privateDirectory(locations.filesRoot)
    const publicDirectory = { path: documentPath, object: documents }, stateDirectory = { path: statePath, object: state }
    const fileDirectory = { path: filesPath, object: files }
    for (const [left, right] of [[publicDirectory, stateDirectory], [publicDirectory, fileDirectory],
      [stateDirectory, fileDirectory]] as const) {
      if (await containsDirectory(left.path, right.object) || await containsDirectory(right.path, left.object)) {
        throw new Error('Document storage directory objects must not contain or alias each other.')
      }
    }
    if (documents.device !== files.device) throw new Error('Retained document objects require the document filesystem.')
    const documentObject = await persistentObject(locations.root, documents)
    const fileObject = await persistentObject(locations.filesRoot, files)
    const stateObject = await persistentObject(locations.stateRoot, state)
    /* v8 ignore next -- volumes exist only on POSIX; on win32 both sides stay undefined, so the refusal cannot fire. */
    if (documentObject.volume !== fileObject.volume) throw new Error('Retained document objects require the same persistent filesystem.')
    return new DocumentIdentityStorage({ ...locations }, { documents: documentObject, files: fileObject }, stateObject)
  }

  /**
   * Re-prove directory identities and POSIX private access before using a metadata lock.
   * @returns after every location still denotes the originally opened directory.
   */
  async verify(): Promise<void> {
    const { root, stateRoot, filesRoot } = this.locations
    if (!same(await directory(root, false), this.binding.documents)
      || !same(await directory(stateRoot, true), this.state)
      || !same(await directory(filesRoot, true), this.binding.files)) {
      throw new Error('Document storage directory changed after it was opened.')
    }
  }

  /**
   * Verify the private metadata inode before SQLite can read or initialize it.
   * @returns the regular file's kernel identity after POSIX account and mode checks.
   */
  async metadataFile(): Promise<StorageObject> {
    const info = await lstat(this.databasePath, { bigint: true })
    if (!info.isFile() || info.isSymbolicLink() || info.ino === 0n) throw new Error('Private document metadata is not regular.')
    privateAccess(info)
    const identity = { device: String(info.dev), inode: String(info.ino),
      /* v8 ignore next -- the stored volume exists only where POSIX persistence wrote one. */
      ...String(info.dev) === this.state.device && this.state.volume !== undefined ? { volume: this.state.volume } : {} }
    if (this.metadata !== undefined && !same(this.metadata, identity)) {
      throw new Error('Private document metadata file changed after it was opened.')
    }
    this.metadata = identity
    return identity
  }

  /**
   * Read bounded private domain evidence without creating or upgrading it.
   * @returns parsed marker data, or absence; linked, replaced, oversized or insufficiently private files reject.
   */
  async domainMarker(): Promise<unknown> {
    const path = join(this.locations.filesRoot, 'domain.json')
    const entry = await lstat(path).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (entry === undefined) return undefined
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > 1024) throw new Error('Invalid private document domain marker.')
    privateAccess(entry)
    const handle = await open(path, PRIVATE_READ_FLAGS)
    return withDocumentHandle(handle, async () => {
      const info = await handle.stat()
      if (!info.isFile() || info.dev !== entry.dev || info.ino !== entry.ino || info.size > 1024) {
        throw new Error('Private document domain marker changed while opening.')
      }
      const bytes = Buffer.alloc(1025)
      let size = 0
      while (size < bytes.length) {
        const next = await handle.read(bytes, size, bytes.length - size, size)
        if (next.bytesRead === 0) break
        size += next.bytesRead
      }
      if (size > 1024) throw new Error('Private document domain marker is too large.')
      const parsed: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'))
      return parsed
    })
  }

  /**
   * Bind retained objects to one metadata domain without adopting another domain's files.
   * @param rootId - durable identifier from the private metadata database.
   * @param initialize - permit a fresh, empty store to acquire its private domain marker.
   * @returns after the existing private marker agrees or an empty object store is initialized.
   */
  async bindDomain(rootId: UserDocRootId, initialize = true): Promise<void> {
    await withFileLock(join(this.locations.filesRoot, 'domain'), async () => {
      await this.verify()
      const databaseId = await this.metadataFile()
      const path = join(this.locations.filesRoot, 'domain.json')
      const raw = await this.domainMarker()
      if (raw !== undefined) {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !('version' in raw) || raw.version !== 1 && raw.version !== 2
          || !('rootId' in raw) || raw.rootId !== rootId
          || !('state' in raw) || !recordedObject(raw.state, this.state, raw.version === 2)
          || !('database' in raw) || !recordedObject(raw.database, databaseId, raw.version === 2)) {
          throw new Error('Retained document objects belong to another metadata domain or database file.')
        }
        if (raw.version === 1) {
          await writeFileAtomic(path, JSON.stringify({ version: 2, rootId, state: this.state, database: databaseId }), {
            mode: 0o600, dirMode: 0o700,
          })
        }
        return
      }
      if (!initialize) throw new Error('The private document domain marker is missing.')
      const entries = await readdir(this.locations.filesRoot)
      if (entries.some(name => name !== 'domain.lock' && !/^domain\.json\.[a-f0-9]{12}\.tmp$/u.test(name))) {
        throw new Error('An unbound private document store contains existing files.')
      }
      await writeFileAtomic(path, JSON.stringify({ version: 2, rootId, state: this.state, database: databaseId }), {
        mode: 0o600, dirMode: 0o700,
      })
    })
  }

  /**
   * Select the configured file root containing one ordinary or retained path.
   * @param path - absolute provider-selected file path.
   * @returns the containing root; metadata files cannot be used as document evidence.
   */
  fileRoot(path: string): string {
    if (isInside(this.locations.root, path)) return this.locations.root
    if (isInside(this.locations.filesRoot, path)) return this.locations.filesRoot
    throw new Error('Document evidence is outside its configured file roots.')
  }

  /** Absolute path of the provider's cross-process metadata writer lock. */
  get mutationPath(): string { return join(this.locations.stateRoot, 'mutation') }
  /** Absolute path of the dedicated SQLite database. */
  get databasePath(): string { return join(this.locations.stateRoot, 'metadata.sqlite') }
  /** Open-time private directory witness; verify() must still precede its use. */
  get stateIdentity(): StorageObject { return { ...this.state } }
}
