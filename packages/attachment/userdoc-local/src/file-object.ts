/** Exact file-object evidence for prepared document mutations; anchors live in configured private storage. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, link, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DOCUMENT_READ_FAILED_CODE, UserDocError, type UserDocIncarnationId } from '@deepseek-ai/dsh-userdoc'
import { assertInside, assertNestedDirectories } from './name.ts'
import { DocumentIdentityConflict } from './identity.ts'
import type { DocumentIdentityStorage } from './identity-storage.ts'
import { withRootedDocumentPaths } from './rooted-fs.ts'

/** Kernel file identity; content hashes and timestamps alone cannot identify an upload publication. */
export interface DocumentFileObjectId {
  readonly device: string
  readonly inode: string
}

/** A root-owned mutation selects one unique anchor name before changing ordinary paths. */
export type DocumentAnchorToken = { readonly sequence: number } & (
  | { readonly incarnationId: UserDocIncarnationId }
  | { readonly directory: true }
)

/* v8 ignore next -- Windows omits O_NOFOLLOW; lexical links and opened-file evidence are checked separately. */
// oxlint-disable-next-line typescript/no-unnecessary-condition -- some supported platforms omit O_NOFOLLOW.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0
/* v8 ignore next -- platforms without POSIX named pipes can omit O_NONBLOCK. */
// oxlint-disable-next-line typescript/no-unnecessary-condition -- some supported platforms omit O_NONBLOCK.
const NONBLOCK = constants.O_NONBLOCK ?? 0

function identity(info: BigIntStats): DocumentFileObjectId {
  if (info.ino === 0n) throw new UserDocError('This filesystem does not report a reliable file identity.', DOCUMENT_READ_FAILED_CODE)
  return { device: String(info.dev), inode: String(info.ino) }
}

function matches(left: DocumentFileObjectId, right: DocumentFileObjectId): boolean {
  return left.device === right.device && left.inode === right.inode
}

async function withRegularFile<T>(
  storage: DocumentIdentityStorage, path: string,
  operation: (handle: FileHandle, info: BigIntStats, openedPath: string) => Promise<T>,
): Promise<T> {
  const root = storage.fileRoot(path)
  assertInside(root, path)
  await assertNestedDirectories(root, dirname(path), DOCUMENT_READ_FAILED_CODE)
  return withRootedDocumentPaths(root, [path], async (rooted) => {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- one input produces one ordered pinned path.
    const openedPath = rooted.paths[0]!
    await rooted.verify()
    const before = await lstat(openedPath, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink()) throw new UserDocError('Document evidence is not a regular file.', DOCUMENT_READ_FAILED_CODE)
    const handle = await open(openedPath, constants.O_RDONLY | NOFOLLOW | NONBLOCK)
    let result: T
    try {
      const info = await handle.stat({ bigint: true })
      if (!info.isFile() || !matches(identity(before), identity(info))) {
        throw new DocumentIdentityConflict('Document changed while its file was opened.')
      }
      const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(openedPath)])
      assertInside(canonicalRoot, canonicalPath)
      await rooted.verify()
      result = await operation(handle, info, openedPath)
      await rooted.verify()
    } catch (error) {
      try { await handle.close() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Document evidence and handle cleanup failed.')
      }
      throw error
    }
    await handle.close()
    return result
  })
}

/**
 * Create one provider-owned identity directory without traversing linked components.
 * @param storage - explicit public and private file locations.
 * @param leaf - private directory owned by the journal executor.
 * @returns its validated absolute path.
 */
export async function ensureIdentityDirectory(
  storage: DocumentIdentityStorage, leaf: 'anchors' | 'objects' | 'removed' | 'directories' | 'trash',
): Promise<string> {
  await storage.verify()
  const root = storage.locations.filesRoot, directory = join(root, leaf)
  try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await assertNestedDirectories(root, directory, DOCUMENT_READ_FAILED_CODE)
  return directory
}

function anchorPath(storage: DocumentIdentityStorage, token: DocumentAnchorToken): string {
  const directory = join(storage.locations.filesRoot, 'anchors')
  const key = 'directory' in token ? 'directory' : String(token.incarnationId)
  const path = join(directory, `${String(token.sequence)}.${key}.anchor`)
  assertInside(directory, path)
  return path
}

/** A source remains open until its callback and every admitted anchor acquisition settle. */
export interface DocumentFileSource {
  readonly identity: DocumentFileObjectId
  readonly bytes: number
  readonly modifiedAt: number
  /**
   * Retain the opened object under a prepared mutation token.
   * @param token - durable mutation sequence and document identity.
   * @returns the acquired anchor; calls after the source callback are refused.
   */
  capture(token: DocumentAnchorToken): Promise<DocumentFileAnchor>
}

/** One temporary hard link retained until the corresponding journal releases its ordinary file paths. */
export class DocumentFileAnchor {
  private releasing: Promise<void> | undefined

  private constructor(
    private readonly storage: DocumentIdentityStorage,
    readonly path: string,
    private readonly expected: DocumentFileObjectId,
  ) {}

  /**
   * Keep the source object alive across intent preparation and anchor allocation.
   * @param storage - explicit public and private file locations.
   * @param path - source whose identity must remain pinned while it is recorded.
   * @param operation - callback borrowing the opened source; admitted acquisitions are joined before its handle closes.
   * @returns the callback result after source work and handle cleanup settle.
   */
  static async withSource<T>(
    storage: DocumentIdentityStorage, path: string, operation: (source: DocumentFileSource) => Promise<T>,
  ): Promise<T> {
    return withRegularFile(storage, path, async (_handle, info) => {
      const expected = identity(info), tasks = new Set<Promise<DocumentFileAnchor>>()
      let active = true
      const bytes = Number(info.size), modifiedAt = Number(info.mtimeNs) / 1e6
      if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(modifiedAt) || modifiedAt < 0) {
        throw new UserDocError('Document metadata is outside the supported range.', DOCUMENT_READ_FAILED_CODE)
      }
      const source: DocumentFileSource = { identity: expected, bytes, modifiedAt, capture: (token) => {
        if (!active) return Promise.reject(new DocumentIdentityConflict('The document source acquisition has already ended.'))
        const task = DocumentFileAnchor.capture(storage, path, token, expected)
        tasks.add(task)
        // The scope joins every acquisition, including a caller that stops awaiting it.
        void task.catch(() => {})
        return task
      } }
      const outcome = await Promise.resolve().then(() => operation(source)).then(
        value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }),
      )
      active = false
      const settled = await Promise.allSettled(tasks)
      const failures = new Set<unknown>(outcome.ok ? [] : [outcome.error])
      for (const item of settled) if (item.status === 'rejected') failures.add(item.reason)
      if (failures.size === 1) throw [...failures][0]
      if (failures.size > 1) throw new AggregateError(failures, 'Document source and anchor acquisition failed.')
      if (!outcome.ok) throw outcome.error
      return outcome.value
    })
  }

  /**
   * Reopen retained recovery evidence without adopting an ordinary target or a replacement source.
   * @param storage - explicit public and private file locations.
   * @param token - sequence and incarnation from the recovery record.
   * @param expected - identity recorded while the source handle and then this anchor kept the object alive.
   * @returns the existing anchor, or undefined when allocation never retained the source.
   */
  static async reopen(
    storage: DocumentIdentityStorage, token: DocumentAnchorToken, expected: DocumentFileObjectId,
  ): Promise<DocumentFileAnchor | undefined> {
    const path = anchorPath(storage, token)
    const anchor = new DocumentFileAnchor(storage, path, expected)
    if (await anchor.owns(path)) return anchor
    try { await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    throw new DocumentIdentityConflict('The retained document recovery object has changed.')
  }

  /**
   * Retain exactly the file recorded in a prepared intent; recovery can reopen its retained anchor.
   * @param storage - explicit public and private file locations.
   * @param source - ordinary file or private upload partial selected by the provider.
   * @param token - durable mutation sequence and document identity.
   * @param expected - source evidence persisted with that intent, never inferred from equal bytes.
   * @returns the retained anchor; a different source or existing anchor is preserved and refused.
   */
  private static async capture(
    storage: DocumentIdentityStorage, source: string, token: DocumentAnchorToken, expected: DocumentFileObjectId,
  ): Promise<DocumentFileAnchor> {
    await ensureIdentityDirectory(storage, 'anchors')
    const path = anchorPath(storage, token)
    const anchor = new DocumentFileAnchor(storage, path, expected)
    if (await anchor.owns(path)) return anchor
    await withRegularFile(storage, source, async (_handle, info, openedSource) => {
      if (!matches(identity(info), expected)) throw new DocumentIdentityConflict('The selected source file object has changed.')
      try { await link(openedSource, path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      if (!await anchor.owns(path)) throw new DocumentIdentityConflict('The document anchor does not retain the selected source.')
    })
    return anchor
  }

  private async owns(path: string): Promise<boolean> {
    try {
      return matches(await withRegularFile(this.storage, path, (_handle, info) => Promise.resolve(identity(info))), this.expected)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  private async ownsPinned(path: string): Promise<boolean> {
    try {
      const info = await lstat(path, { bigint: true })
      if (!info.isFile() || info.isSymbolicLink()) throw new UserDocError('Document evidence is not a regular file.', DOCUMENT_READ_FAILED_CODE)
      return matches(identity(info), this.expected)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }

  /**
   * Prove that a publication or cleanup target still denotes the retained file object.
   * @param path - candidate inside the document root.
   * @returns whether it is the exact retained object; an absent candidate is false.
   */
  async matches(path: string): Promise<boolean> {
    if (!await this.owns(this.path)) throw new DocumentIdentityConflict('The retained document anchor has changed.')
    return this.owns(path)
  }

  /**
   * Publish the retained object exclusively; repeating the same hard-link publication is harmless.
   * @param path - available ordinary target or hidden trash file below the root.
   * @returns after the target is linked and its public parent remains current; refusal retains recovery evidence.
   */
  async publish(path: string): Promise<void> {
    if (!await this.owns(this.path)) throw new DocumentIdentityConflict('The retained document anchor has changed.')
    const root = this.storage.fileRoot(path)
    assertInside(root, path)
    await assertNestedDirectories(root, dirname(path), DOCUMENT_READ_FAILED_CODE)
    await withRootedDocumentPaths(root, [path], async (rooted) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- one input produces one ordered pinned path.
      const target = rooted.paths[0]!
      await rooted.verify()
      try { await link(this.path, target) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (!await this.ownsPinned(target)) throw new DocumentIdentityConflict('Publication target belongs to another file object.')
      }
      await rooted.verify()
    })
  }

  /**
   * Remove an ordinary source once, retaining a private witness until metadata commits.
   * @param source - original ordinary or upload path.
   * @param removed - unique private path selected by this mutation sequence.
   * @returns after one exact removal or proof of absence; parent changes refuse and retain recovery evidence.
   */
  async detach(source: string, removed: string): Promise<void> {
    const root = this.storage.fileRoot(source)
    assertInside(root, source)
    assertInside(join(this.storage.locations.filesRoot, 'removed'), removed)
    await ensureIdentityDirectory(this.storage, 'removed')
    if (await this.matches(removed)) return
    try {
      await lstat(removed)
      throw new DocumentIdentityConflict('Document cleanup evidence is occupied by another file.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await withRootedDocumentPaths(root, [source], async (rooted) => {
      // oxlint-disable-next-line typescript/no-non-null-assertion -- one input produces one ordered pinned path.
      const selected = rooted.paths[0]!
      await rooted.verify()
      if (!await this.ownsPinned(selected)) return
      try { await rename(selected, removed) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (await this.matches(removed)) { await rooted.verify(); return }
      const conflict = new DocumentIdentityConflict('The document source changed during removal.')
      try {
        await withRegularFile(this.storage, removed, async (_handle, info, retained) => {
          await link(retained, selected)
          const restored = await lstat(selected, { bigint: true })
          if (!restored.isFile() || !matches(identity(info), identity(restored))) throw conflict
          await unlink(retained)
        })
      } catch (error) {
        throw new AggregateError([conflict, error], 'A replacement document was retained while source recovery failed.')
      }
    })
  }

  /**
   * Remove a private link after metadata commit without touching ordinary paths.
   * @param path - object or removal witness within the provider's private identity directory.
   * @returns after the matching link is gone; an absent link permits recovery to continue.
   */
  async removePrivate(path: string): Promise<void> {
    assertInside(this.storage.locations.filesRoot, path)
    if (await this.matches(path)) { await unlink(path); return }
    try { await lstat(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    throw new DocumentIdentityConflict('Private document cleanup found another file object.')
  }

  /**
   * Remove only this private anchor after ordinary-file work has settled; retained target links remain usable.
   * @returns the shared cleanup promise; a replaced private object is preserved and reported.
   */
  release(): Promise<void> {
    return this.releasing ??= Promise.resolve().then(async () => {
      const info = await lstat(this.path).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (info === undefined) return
      if (!await this.owns(this.path)) throw new DocumentIdentityConflict('The private anchor no longer belongs to this document mutation.')
      await unlink(this.path)
    })
  }
}
