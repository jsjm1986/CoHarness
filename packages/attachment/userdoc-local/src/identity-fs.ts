/** Identity-aware document operations; one owner retains the database until every admitted operation settles. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { basename, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  DOCUMENT_NOT_FOUND_CODE, DOCUMENT_TARGET_CONFLICT_CODE, DOCUMENT_TRASH_NOT_FOUND_CODE, DOCUMENT_UPLOAD_STATE_CODE,
  UserDocDirectoryId, UserDocError, UserDocId, UserDocIncarnationId, UserDocRootId, UserDocTrashId,
} from '@deepseek-ai/dsh-userdoc'
import type {
  StoredUserDoc, UserDocDirectoryListing, UserDocIdentity, UserDocLimits, UserDocRef,
  UserDocSelection, UserDocTarget, UserDocTrashRef, UserDocTrashSelection, UserDocUploadOwnerId,
} from '@deepseek-ai/dsh-userdoc'
import { DocumentFileAnchor } from './file-object.ts'
import { DocumentIdentityStorage, type DocumentIdentityLocations } from './identity-storage.ts'
import { withDocumentHandle } from './handle.ts'
import {
  DOCUMENT_IDENTITY_SCHEMA_VERSION, DocumentIdentityConflict, DocumentIdentityStore, type DocumentIdentityRecord,
  type ObservedDocumentRelocation,
} from './identity.ts'
import { DocumentMutationExecutor, type DocumentMutationAccess } from './mutation.ts'
import { assertInside, assertNestedDirectories, docIdFor, pathForDirectoryId, pathForDocId } from './name.ts'
import { listDocDirectory, listDocFiles, resolveDocTarget, saveDocFile } from './store.ts'
import { mediaTypeFor } from './media-type.ts'
import { readLegacyTrashRecords } from './trash.ts'
import { loadNodeSqlite } from './sqlite.ts'
import type { DocumentProjectionBatch, DocumentProjectionCursor, DocumentProjectionReadOptions } from './projection.ts'
import { admitDocumentWrite } from './admission.ts'
import type { UserDocBackgroundWrite } from './upload.ts'
import { consumeDocumentBody } from './body.ts'

/** Current provider reference; older serialized Session references may lack this identity. */
export type IdentifiedUserDocRef = UserDocRef & { readonly identity: UserDocIdentity }
/** Current provider trash entry, independently addressable even when its original path is reused. */
export type IdentifiedUserDocTrashRef = UserDocTrashRef & { readonly identity: UserDocIdentity; readonly trashId: UserDocTrashId }

/** Durable publication inputs supplied by the upload, transfer or administrator owner. */
export interface DocumentPublication {
  readonly incarnationId: UserDocIncarnationId
  readonly bytes: number
  readonly origin: 'upload' | 'transfer' | 'admin'
  readonly createdBy?: UserDocUploadOwnerId
}

/** Apply runtime access to the private source inode before its public hard link appears. */
export type PreparePublishedDocument = (path: string) => Promise<void>

/* oxlint-disable-next-line typescript/no-unnecessary-condition -- POSIX flags vary by supported host. */
const DOCUMENT_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

function identity(record: DocumentIdentityRecord): UserDocIdentity {
  return { incarnationId: record.incarnationId, revision: record.revision, origin: record.origin,
    ...record.createdBy === undefined ? {} : { createdBy: record.createdBy } }
}

function ref(root: string, record: DocumentIdentityRecord): IdentifiedUserDocRef {
  return { docId: record.docId, path: pathForDocId(root, record.docId), name: basename(record.docId), bytes: record.bytes,
    mediaType: record.mediaType, modifiedAt: record.modifiedAt, identity: identity(record) }
}

function trashRef(record: DocumentIdentityRecord): IdentifiedUserDocTrashRef {
  if (record.trash === undefined) throw new Error('A trash reference requires its current action.')
  return { directoryId: record.docId.split('/').slice(0, -1).join('/') as UserDocDirectoryId,
    name: basename(record.docId), bytes: record.bytes, mediaType: record.mediaType, modifiedAt: record.modifiedAt,
    identity: identity(record), ...record.trash }
}

function selected(access: DocumentMutationAccess, expected: UserDocSelection, state: 'active' | 'trash'): DocumentIdentityRecord {
  const current = access.records.get(expected.incarnationId)
  if (current === undefined || current.state !== state || current.revision !== expected.revision || current.docId !== expected.docId) {
    throw new DocumentIdentityConflict('The selected document version is no longer current.')
  }
  return current
}

/** A document root's SQLite owner; the surrounding engine supplies upload, streaming and maintenance lifetimes. */
export class DocumentIdentityFs {
  private readonly operations = new Set<Promise<unknown>>()
  private closing: Promise<void> | undefined

  private constructor(
    private readonly root: string, private readonly database: DatabaseSync, private readonly executor: DocumentMutationExecutor,
    private readonly storage: DocumentIdentityStorage,
  ) {}

  /**
   * Open the root metadata domain under its writer lock and settle interrupted file work.
   * @param locations - explicit public directory and disjoint provider-private metadata/object locations.
   * @param admit - host writer admission for initialization and subsequent recovery, observation and mutation.
   * @returns its connection owner; a failed open closes the connection and preserves stored files.
   */
  static async open(locations: DocumentIdentityLocations, admit?: UserDocBackgroundWrite): Promise<DocumentIdentityFs> {
    return admitDocumentWrite(admit, () => this.openAdmitted(locations, admit))
  }

  private static async openAdmitted(locations: DocumentIdentityLocations, admit?: UserDocBackgroundWrite): Promise<DocumentIdentityFs> {
    const storage = await DocumentIdentityStorage.open(locations), root = storage.locations.root
    let connection: DatabaseSync | undefined
    try {
      const owner = await withFileLock(storage.mutationPath, async () => {
        await storage.verify()
        const path = storage.databasePath
        try {
          const handle = await open(path, 'wx', 0o600)
          await withDocumentHandle(handle, () => Promise.resolve())
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        await storage.metadataFile()
        const { DatabaseSync } = await loadNodeSqlite()
        const database = new DatabaseSync(path)
        connection = database
        const version = database.prepare('PRAGMA user_version').get()?.user_version
        if (version === 2 || version === 3) {
          const legacy = new DocumentIdentityStore(root, database, 'read')
          legacy.verifyLegacyStorage(storage.binding)
          await storage.bindDomain(legacy.rootId)
        }
        const store = new DocumentIdentityStore(root, database)
        return new DocumentIdentityFs(root, database, new DocumentMutationExecutor(storage, store, admit), storage)
      })
      await owner.executor.recover()
      await owner.importLegacyTrash()
      return owner
    } catch (error) {
      try { connection?.close() } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Document metadata opening and connection cleanup failed.')
      }
      throw error
    }
  }

  private async importLegacyTrash(): Promise<void> {
    const directory = join(this.root, '.dsh-trash'), path = join(directory, 'manifest.json')
    await this.executor.inspect(async (access) => {
      const legacy = await lstat(directory).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      })
      if (legacy === undefined) {
        access.records.prepareLegacyImport()
        access.records.completeLegacyImport()
        return
      }
      if (!legacy.isDirectory() || legacy.isSymbolicLink()) throw new DocumentIdentityConflict('Legacy document trash is not a real directory.')
      await withFileLock(path, async () => {
        const phase = access.records.legacyImportPhase()
        const entry = await lstat(path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
        if (entry !== undefined && (!entry.isFile() || entry.isSymbolicLink())) {
          throw new DocumentIdentityConflict('The document trash manifest is not a regular file.')
        }
        const raw: unknown = entry === undefined ? undefined : JSON.parse(await readFile(path, 'utf8'))
        const retired = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'version' in raw && raw.version === 2
        if (phase === 'complete') {
          if (retired && 'identityVersion' in raw && (raw.identityVersion === 2 || raw.identityVersion === 3 || raw.identityVersion === DOCUMENT_IDENTITY_SCHEMA_VERSION)
            && 'rootId' in raw && raw.rootId === access.records.rootId) return
          if (raw === undefined && !(await readdir(directory)).some(name => name.endsWith('.bin'))) return
          throw new DocumentIdentityConflict('Legacy document trash changed after its private migration completed.')
        }
        if (phase === 'pending') {
          if (retired) throw new DocumentIdentityConflict('A public trash marker cannot prove a private document migration.')
          const records = await readLegacyTrashRecords(this.root)
          const known = new Set(records.map(record => basename(record.trashPath)))
          const hidden = await readdir(directory)
          if (hidden.some(name => name.endsWith('.bin') && !known.has(name))) {
            throw new DocumentIdentityConflict('Document trash contains a payload absent from its recovery manifest.')
          }
          for (const record of records) {
            const id = basename(record.trashPath, '.bin')
            if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(id)) {
              throw new DocumentIdentityConflict('The legacy trash file has no valid durable identifier.')
            }
            const incarnationId = UserDocIncarnationId(id), trashId = UserDocTrashId(id)
            const current = access.records.get(incarnationId)
            if (current !== undefined) {
              if (current.state !== 'trash' || current.trash?.trashId !== trashId || current.docId !== record.docId
                || current.origin !== 'legacy' || current.createdBy !== undefined) {
                throw new DocumentIdentityConflict('Legacy trash conflicts with an existing document incarnation.')
              }
              continue
            }
            await DocumentFileAnchor.withSource(this.storage, record.trashPath, async (source) => {
              await access.run({ kind: 'adopt', document: { incarnationId, docId: record.docId, origin: 'legacy',
                bytes: source.bytes, mediaType: record.mediaType, modifiedAt: source.modifiedAt },
              trash: { trashId, docId: record.docId, trashedAt: record.trashedAt, purgeAfter: record.purgeAfter } })
            })
          }
          access.records.prepareLegacyImport()
        }
        if ((await readdir(directory)).some(name => name.endsWith('.bin'))) {
          throw new DocumentIdentityConflict('Legacy trash still contains a payload outside private storage.')
        }
        await writeFileAtomic(path, JSON.stringify({ version: 2, identityVersion: DOCUMENT_IDENTITY_SCHEMA_VERSION,
          rootId: access.records.rootId }), { mode: 0o600, dirMode: 0o700 })
        access.records.completeLegacyImport()
      })
    }, true)
  }

  private operate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing !== undefined) return Promise.reject(new Error('Document identity storage is closed.'))
    const task = Promise.resolve().then(operation)
    this.operations.add(task)
    void task.finally(() => { this.operations.delete(task) }).catch(() => {})
    return task
  }

  /**
   * Stop admission, join accepted work and close the dedicated database exactly once.
   * @returns the shared completion; callers release the filesystem engine only afterwards.
   */
  dispose(): Promise<void> {
    return this.closing ??= Promise.allSettled([...this.operations]).then(() => { this.database.close() })
  }

  private async existsExact(docId: UserDocId): Promise<boolean> {
    let parent = this.root
    for (const leaf of docId.split('/')) {
      await assertNestedDirectories(this.root, parent, DOCUMENT_NOT_FOUND_CODE)
      if (!(await readdir(parent)).includes(leaf)) return false
      parent = join(parent, leaf)
    }
    return true
  }

  private async verifyRetained(record: DocumentIdentityRecord): Promise<void> {
    const retained = join(this.storage.locations.filesRoot, 'objects', `${String(record.incarnationId)}.object`)
    await DocumentFileAnchor.withSource(this.storage, retained, (object) => {
      if (object.identity.device !== record.file.device || object.identity.inode !== record.file.inode) {
        throw new DocumentIdentityConflict('The retained document identity object has changed.')
      }
      return Promise.resolve()
    })
  }

  private async reconcileOne(access: DocumentMutationAccess, docId: UserDocId): Promise<DocumentIdentityRecord> {
    await this.reconcile(access)
    const current = access.records.active(docId)
    if (current === undefined) throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    return current
  }

  private async observe(
    access: DocumentMutationAccess, docId: UserDocId, inventory?: ReadonlyMap<UserDocId, DocumentIdentityRecord['file']>,
  ): Promise<DocumentIdentityRecord> {
    const path = pathForDocId(this.root, docId)
    if (await access.discardRetiredDirectoryMarker(docId)) throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE)
    if (!await this.existsExact(docId)) throw new UserDocError('The document path changed.', DOCUMENT_NOT_FOUND_CODE)
    let current = access.records.active(docId)
    try {
      return await DocumentFileAnchor.withSource(this.storage, path, async (source) => {
        const observed = inventory?.get(docId)
        if (inventory !== undefined && (observed === undefined
          || observed.device !== source.identity.device || observed.inode !== source.identity.inode)) {
          throw new DocumentIdentityConflict('The document inventory changed during observation.')
        }
        if (current !== undefined) {
          await this.verifyRetained(current)
          const same = source.identity.device === current.file.device && source.identity.inode === current.file.inode
          if (!same) {
            if (inventory === undefined) return this.reconcileOne(access, docId)
            await access.run({ kind: 'missing', expected: current }); current = undefined
          }
        }
        if (current === undefined) {
          if (inventory === undefined) return this.reconcileOne(access, docId)
          return access.run({ kind: 'adopt', document: { incarnationId: UserDocIncarnationId(randomUUID()), docId, origin: 'legacy',
            bytes: source.bytes, mediaType: mediaTypeFor(docId), modifiedAt: source.modifiedAt } })
        }
        if (current.bytes !== source.bytes || current.modifiedAt !== source.modifiedAt) {
          return access.run({ kind: 'observe', expected: current, bytes: source.bytes,
            mediaType: mediaTypeFor(docId), modifiedAt: source.modifiedAt })
        }
        return current
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (current !== undefined) await access.run({ kind: 'missing', expected: current })
      throw new UserDocError('Document not found.', DOCUMENT_NOT_FOUND_CODE, { cause: error })
    }
  }

  /** A complete inventory distinguishes a moved object from an absent address before its witness is released. */
  private async reconcile(access: DocumentMutationAccess, signal?: AbortSignal): Promise<IdentifiedUserDocRef[]> {
    const files: UserDocRef[] = [], locations = new Map<string, UserDocId[]>()
    const inventory = new Map<UserDocId, DocumentIdentityRecord['file']>()
    const objectKey = (file: DocumentIdentityRecord['file']) => `${file.device}:${file.inode}`
    for (const file of await listDocFiles(this.root, signal)) {
      signal?.throwIfAborted()
      if (await access.discardRetiredDirectoryMarker(file.docId)) continue
      files.push(file)
      await DocumentFileAnchor.withSource(this.storage, file.path, (source) => {
        inventory.set(file.docId, source.identity)
        const key = objectKey(source.identity), addresses = locations.get(key) ?? []
        addresses.push(file.docId); locations.set(key, addresses)
        return Promise.resolve()
      })
    }
    const active = access.records.list().filter(record => record.state === 'active'), owners = new Map<string, number>()
    for (const record of active) {
      const key = objectKey(record.file)
      owners.set(key, (owners.get(key) ?? 0) + 1)
    }
    const relocations: ObservedDocumentRelocation[] = []
    for (const record of active) {
      signal?.throwIfAborted()
      const key = objectKey(record.file), addresses = locations.get(key) ?? []
      if (addresses.includes(record.docId)) continue
      const target = addresses[0]
      if (addresses.length === 1 && owners.get(key) === 1 && target !== undefined) {
        relocations.push({ expected: record, target, file: record.file })
      } else {
        await this.verifyRetained(record)
        await access.run({ kind: 'missing', expected: record })
      }
    }
    if (relocations.length > 0) await access.relocate(relocations)
    const present = new Set(files.map(file => file.docId))
    const records: DocumentIdentityRecord[] = []
    for (const file of files) {
      signal?.throwIfAborted()
      records.push(await this.observe(access, file.docId, inventory))
    }
    for (const record of access.records.list()) {
      signal?.throwIfAborted()
      if (record.state === 'active' && !present.has(record.docId)) await access.run({ kind: 'missing', expected: record })
    }
    return records.map(record => ref(this.root, record))
  }

  /**
   * Reconcile ordinary files, preserving in-place edits and leaving external replacements' original actors unknown.
   * @param signal - optional scan cancellation.
   * @returns active references after every observed identity change commits.
   */
  list(signal?: AbortSignal): Promise<IdentifiedUserDocRef[]> {
    return this.operate(() => this.executor.inspect(access => this.reconcile(access, signal)))
  }

  /**
   * Reconcile one immediate directory without marking unscanned descendants missing.
   * @param directoryId - directory whose immediate files and folders are requested.
   * @param signal - optional scan cancellation.
   * @returns ordinary directory metadata and identified document references.
   */
  listDirectory(directoryId: UserDocDirectoryId, signal?: AbortSignal): Promise<UserDocDirectoryListing> {
    return this.operate(() => this.executor.inspect(async (access) => {
      const listing = await listDocDirectory(this.root, directoryId, signal)
      const documents: UserDocRef[] = [], present = new Set(listing.documents.map(file => file.docId))
      for (const file of listing.documents) {
        signal?.throwIfAborted()
        if (!await access.discardRetiredDirectoryMarker(file.docId)) documents.push(ref(this.root, await this.observe(access, file.docId)))
      }
      for (const record of access.records.list()) {
        if (record.state === 'active' && record.docId.split('/').slice(0, -1).join('/') === directoryId && !present.has(record.docId)) {
          await access.run({ kind: 'missing', expected: record })
        }
      }
      return { ...listing, documents }
    }))
  }

  /**
   * Reconcile and read one active identity.
   * @param docId - current ordinary address.
   * @returns its current identified reference; absence never selects retained trash at that path.
   */
  stat(docId: UserDocId): Promise<IdentifiedUserDocRef> {
    return this.operate(() => this.executor.inspect(async access => ref(this.root, await this.observe(access, docId))))
  }

  /**
   * Publish a verified private upload under its preallocated durable incarnation.
   * @param target - canonical sanitized destination.
   * @param partial - complete file within the configured provider-private file root.
   * @param publication - durable nonce, original actor, expected byte count and origin.
   * @param preparePublished - optional runtime-access preparation before public publication.
   * @param signal - optional cancellation before the physical publication starts; accepted upload finalizers omit it.
   * @returns its current active reference after commit and cleanup.
   */
  publish(
    target: UserDocTarget, partial: string, publication: DocumentPublication,
    preparePublished?: PreparePublishedDocument, signal?: AbortSignal,
  ): Promise<IdentifiedUserDocRef> {
    return this.operate(() => this.executor.inspect(async (access) => {
      signal?.throwIfAborted()
      assertInside(this.storage.locations.filesRoot, partial)
      if (pathForDocId(this.root, target.docId) !== resolve(target.path) || basename(target.path) !== target.name) {
        throw new UserDocError('Resolved document target is inconsistent.', DOCUMENT_TARGET_CONFLICT_CODE)
      }
      const { incarnationId, createdBy, origin } = publication
      let existing = access.records.get(incarnationId)
      const occupied = access.records.active(target.docId)
      if (occupied !== undefined && !await this.existsExact(occupied.docId)
        || existing?.state === 'active' && !await this.existsExact(existing.docId)) {
        await this.reconcile(access)
        existing = access.records.get(incarnationId)
      }
      if (existing !== undefined) {
        if (existing.createdBy !== createdBy || existing.origin !== origin || existing.state !== 'active') {
          throw new UserDocError('This upload incarnation has already completed and is no longer publishable.', DOCUMENT_UPLOAD_STATE_CODE)
        }
        let current = await this.observe(access, existing.docId)
        if (current.incarnationId !== incarnationId) {
          const relocated = access.records.get(incarnationId)
          if (relocated?.state === 'active') current = await this.observe(access, relocated.docId)
        }
        if (current.incarnationId !== incarnationId) {
          throw new UserDocError('The published upload was replaced by another document.', DOCUMENT_UPLOAD_STATE_CODE)
        }
        return ref(this.root, current)
      }
      await preparePublished?.(partial)
      return DocumentFileAnchor.withSource(this.storage, partial, async (source) => {
        signal?.throwIfAborted()
        return ref(this.root, await access.run({ kind: 'publish',
          ...createdBy === undefined ? {} : { actor: createdBy },
          source: relative(this.storage.locations.filesRoot, partial).split(sep).join('/'), document: {
            incarnationId, docId: target.docId, origin, bytes: publication.bytes, mediaType: mediaTypeFor(target.name),
            modifiedAt: source.modifiedAt, ...createdBy === undefined ? {} : { createdBy },
          } }))
      })
    }))
  }

  /**
   * Stream a one-shot transfer through private staging and publish its identity with the captured actor.
   * @param target - canonical public destination resolved by this document store.
   * @param body - input bytes; the configured limit is enforced while consuming them.
   * @param limits - resolved document limits.
   * @param actor - original authenticated initiator; absent records unknown ownership.
   * @param signal - optional request cancellation.
   * @param preparePublished - filesystem ownership and access applied before public publication.
   * @returns the active identity-aware reference after private staging cleanup.
   */
  async save(
    target: UserDocTarget, body: ReadableStream<Uint8Array>, limits: UserDocLimits,
    actor?: UserDocUploadOwnerId, signal?: AbortSignal, preparePublished?: PreparePublishedDocument,
  ): Promise<IdentifiedUserDocRef> {
    await this.privateDirectory('uploads')
    const stageTarget = await resolveDocTarget(this.storage.locations.filesRoot, UserDocDirectoryId('uploads'), `${randomUUID()}.part`)
    let failure: unknown
    try {
      const staged = await saveDocFile(this.storage.locations.filesRoot, stageTarget, body, limits, signal)
      return await this.publish(target, stageTarget.path, {
        incarnationId: UserDocIncarnationId(randomUUID()), bytes: staged.bytes,
        origin: 'transfer', ...(actor === undefined ? {} : { createdBy: actor }),
      }, preparePublished, signal)
    } catch (error) {
      failure = error
      throw error
    } finally {
      try {
        await unlink(stageTarget.path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        })
      } catch (cleanupError) {
        if (failure === undefined) throw cleanupError
        throw new AggregateError([failure, cleanupError], 'Document publication and staging cleanup failed.')
      }
    }
  }

  private async privateDirectory(leaf: 'uploads'): Promise<string> {
    const directory = join(this.storage.locations.filesRoot, leaf)
    try { await mkdir(directory, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await assertNestedDirectories(this.storage.locations.filesRoot, directory, DOCUMENT_UPLOAD_STATE_CODE)
    return directory
  }

  /**
   * Open the retained inode while its exact current identity is held under the root lock.
   * @param docId - current public address.
   * @returns its reference and caller-owned stream; cancel or consume the stream to close its descriptor.
   */
  openRead(docId: UserDocId): Promise<{ readonly ref: IdentifiedUserDocRef; readonly body: ReadableStream<Uint8Array> }> {
    return this.operate(() => this.executor.inspect(async (access) => {
      const current = await this.observe(access, docId)
      const path = join(this.storage.locations.filesRoot, 'objects', `${String(current.incarnationId)}.object`)
      await assertNestedDirectories(this.storage.locations.filesRoot, join(this.storage.locations.filesRoot, 'objects'), DOCUMENT_NOT_FOUND_CODE)
      const handle = await open(path, DOCUMENT_READ_FLAGS)
      try {
        const opened = await handle.stat({ bigint: true })
        if (!opened.isFile() || String(opened.dev) !== current.file.device || String(opened.ino) !== current.file.inode) {
          throw new DocumentIdentityConflict('The retained document object changed while it was opened.')
        }
        const body = Readable.toWeb(handle.createReadStream({ autoClose: true })) as ReadableStream<Uint8Array>
        return { ref: ref(this.root, current), body }
      } catch (error) {
        await handle.close()
        throw error
      }
    }))
  }

  /**
   * Buffer one retained file for callers that explicitly request an in-memory result.
   * @param docId - current public address.
   * @param signal - optional cancellation while consuming the opened stream.
   * @returns identified metadata and complete bytes; cancellation rejects after source cleanup, retaining independent cleanup failures.
   */
  async read(docId: UserDocId, signal?: AbortSignal): Promise<StoredUserDoc> {
    const opened = await this.openRead(docId)
    const chunks: Uint8Array[] = []
    let bytes = 0
    await consumeDocumentBody(opened.body, (value) => { chunks.push(value); bytes += value.byteLength }, signal)
    const data = new Uint8Array(bytes)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    return { ref: opened.ref, data }
  }

  /**
   * Trash exactly the selected active incarnation and revision.
   * @param expected - version admitted by the caller's authority check.
   * @param retentionMs - configured recoverable lifetime.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @returns a newly allocated action independent of earlier trash at this path.
   */
  trash(expected: UserDocSelection, retentionMs: number, actor?: UserDocUploadOwnerId): Promise<IdentifiedUserDocTrashRef> {
    return this.operate(() => this.executor.inspect(async (access) => {
      const previous = access.records.get(expected.incarnationId)
      if (previous?.state === 'trash' && previous.revision === expected.revision + 1 && previous.docId === expected.docId) {
        return trashRef(previous)
      }
      await this.observe(access, expected.docId)
      const current = selected(access, expected, 'active'), at = Date.now()
      return trashRef(await access.run({ kind: 'trash', expected: current, trashId: UserDocTrashId(randomUUID()),
        trashedAt: at, purgeAfter: at + retentionMs, ...actor === undefined ? {} : { actor } }))
    }))
  }

  /**
   * Read every retained action without conflating equal original paths.
   * @param signal - optional cancellation checked before reading retained actions.
   * @returns newest actions first, with identity as the deterministic tie breaker.
   */
  listTrash(signal?: AbortSignal): Promise<IdentifiedUserDocTrashRef[]> {
    return this.operate(() => this.executor.inspect((access) => {
      signal?.throwIfAborted()
      return Promise.resolve(access.records.list().filter(record => record.state === 'trash').map(trashRef)
        .sort((left, right) => right.trashedAt - left.trashedAt || left.trashId.localeCompare(right.trashId)))
    }))
  }

  /**
   * Restore exactly one action, choosing a free name inside the requested directory.
   * @param expected - current incarnation, revision and trash action.
   * @param directoryId - existing or recreated destination; omitted uses the original directory.
   * @param name - optional replacement leaf.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @param prepareDirectory - optional runtime-access preparation for recreated public directories.
   * @param preparePublished - optional runtime-access preparation before public restoration.
   * @returns the same incarnation at its restored path and new revision.
   */
  restore(
    expected: UserDocTrashSelection, directoryId?: UserDocDirectoryId, name?: string, actor?: UserDocUploadOwnerId,
    prepareDirectory?: (path: string) => Promise<void>, preparePublished?: PreparePublishedDocument,
  ): Promise<IdentifiedUserDocRef> {
    return this.operate(() => this.executor.inspect(async (access) => {
      const current = selected(access, expected, 'trash')
      if (current.trash?.trashId !== expected.trashId) throw new UserDocError('Trash action is no longer current.', DOCUMENT_TRASH_NOT_FOUND_CODE)
      const parent = directoryId ?? current.docId.split('/').slice(0, -1).join('/') as UserDocDirectoryId
      const directory = pathForDirectoryId(this.root, parent), parts = relative(this.root, directory).split(sep).filter(Boolean)
      let path = this.root
      for (const part of parts) {
        path = join(path, part)
        let created = false
        try { await mkdir(path, { mode: 0o700 }); created = true } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
        await assertNestedDirectories(this.root, path, DOCUMENT_TARGET_CONFLICT_CODE)
        if (created) await prepareDirectory?.(path)
      }
      const target = await resolveDocTarget(this.root, parent, name ?? basename(current.docId))
      await preparePublished?.(join(this.storage.locations.filesRoot, 'objects', `${String(current.incarnationId)}.object`))
      return ref(this.root, await access.run({ kind: 'restore', expected: current, trashId: expected.trashId, target: target.docId,
        ...actor === undefined ? {} : { actor } }))
    }))
  }

  /**
   * Permanently remove one selected trash action while retaining its identity history.
   * @param expected - current incarnation, revision and trash action.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @returns after its hidden payload and object witness are released.
   */
  purge(expected: UserDocTrashSelection, actor?: UserDocUploadOwnerId): Promise<void> {
    return this.operate(() => this.executor.inspect(async (access) => {
      const previous = access.records.get(expected.incarnationId)
      if (previous?.state === 'purged' && previous.docId === expected.docId && previous.revision === expected.revision + 1) return
      const current = selected(access, expected, 'trash')
      await access.run({ kind: 'purge', expected: current, trashId: expected.trashId, ...actor === undefined ? {} : { actor } })
    }))
  }

  /**
   * Purge due actions, releasing the root writer lock between candidates and rechecking each selected version.
   * @param now - retention comparison time supplied by the maintenance owner.
   * @returns the number of actions purged; a restored or replaced candidate is skipped.
   */
  purgeDue(now: number): Promise<number> {
    return this.operate(async () => {
      const candidates = await this.executor.inspect(access => Promise.resolve(access.records.list()
        .filter(record => record.state === 'trash' && record.trash !== undefined && record.trash.purgeAfter <= now)))
      let purged = 0
      for (const candidate of candidates) {
        const removed = await this.executor.inspect(async (access) => {
          const current = access.records.get(candidate.incarnationId)
          if (current?.state !== 'trash' || current.revision !== candidate.revision || current.trash === undefined
            || current.trash.trashId !== candidate.trash?.trashId || current.trash.purgeAfter > now) return false
          await access.run({ kind: 'purge', expected: current, trashId: current.trash.trashId })
          return true
        })
        if (removed) purged += 1
      }
      return purged
    })
  }

  /**
   * Permanently remove the selected active incarnation without affecting a replacement at the same path.
   * @param expected - exact active identity and revision admitted by the caller.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @returns after physical cleanup; repeating the completed removal succeeds.
   */
  remove(expected: UserDocSelection, actor?: UserDocUploadOwnerId): Promise<void> {
    return this.operate(() => this.executor.inspect(async (access) => {
      const previous = access.records.get(expected.incarnationId)
      if (previous?.state === 'purged' && previous.docId === expected.docId && previous.revision === expected.revision + 1) return
      await this.observe(access, expected.docId)
      await access.run({ kind: 'remove', expected: selected(access, expected, 'active'), ...actor === undefined ? {} : { actor } })
    }))
  }

  /**
   * Read explicit lifecycle records for catalog reconciliation; absence is never interpreted as a new deletion.
   * @returns the root's durable identity and committed records, including immutable missing and purged history.
   */
  snapshot(): Promise<{ readonly rootId: DocumentIdentityStore['rootId']; readonly documents: readonly DocumentIdentityRecord[] }> {
    return this.operate(() => this.executor.inspect(access => Promise.resolve({
      rootId: access.records.rootId, documents: access.records.list(),
    })))
  }

  /**
   * Read the identity domain used by the receiving catalog.
   * @returns the stable UUID binding this private identity database to one catalog scope.
   */
  rootId(): Promise<UserDocRootId> {
    return this.operate(() => this.executor.inspect(access => Promise.resolve(access.records.rootId)))
  }

  /**
   * Inspect catalog delivery without advancing its acknowledgement.
   * @returns whether committed changes still require catalog delivery or local acknowledgement.
   */
  hasPendingProjection(): Promise<boolean> {
    return this.operate(() => this.executor.inspect(access => Promise.resolve(access.records.hasPendingProjection())))
  }

  /**
   * Read committed delivery records after recovery while retaining this owner's database lifetime.
   * @param after - receiving catalog's durable position.
   * @param options - resolved item and complete serialized-response byte bounds.
   * @returns a linked batch; this call neither advances delivery nor deletes records.
   */
  projectionChanges(after: DocumentProjectionCursor, options: DocumentProjectionReadOptions): Promise<DocumentProjectionBatch> {
    return this.operate(() => this.executor.inspect(access => Promise.resolve(access.records.projectionChanges(after, options))))
  }

  /**
   * Release a delivery prefix after its receiving catalog commits it.
   * @param through - known committed receiver position.
   * @returns after monotonic acknowledgement and prefix deletion settle under the root lock.
   */
  acknowledgeProjection(through: DocumentProjectionCursor): Promise<void> {
    return this.operate(() => this.executor.inspect((access) => {
      access.records.acknowledgeProjection(through)
      return Promise.resolve()
    }, true))
  }

  /**
   * Move one selected active file without replacing its destination.
   * @param expected - authorized incarnation and revision.
   * @param directoryId - existing destination directory.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @returns the moved incarnation with its original creator.
   */
  move(expected: UserDocSelection, directoryId: UserDocDirectoryId, actor?: UserDocUploadOwnerId): Promise<IdentifiedUserDocRef> {
    return this.operate(() => this.executor.inspect(async (access) => {
      await this.observe(access, expected.docId)
      const current = selected(access, expected, 'active')
      const target = docIdFor(this.root, join(pathForDirectoryId(this.root, directoryId), basename(current.docId)))
      return ref(this.root, target === current.docId ? current : await access.run({ kind: 'move', expected: current, target,
        ...actor === undefined ? {} : { actor } }))
    }))
  }

  /**
   * Rename a directory after the caller authorizes its entire identified inventory.
   * Ordinary changes following publication reconcile independently of the admitted rename snapshot.
   * @param from - non-root source directory.
   * @param to - canonical available target outside the source subtree.
   * @param expected - every selected document below the source.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @returns after all path metadata and marker cleanup commit.
   */
  renameDirectory(
    from: UserDocDirectoryId, to: UserDocDirectoryId, expected: readonly UserDocSelection[], actor?: UserDocUploadOwnerId,
  ): Promise<void> {
    return this.operate(async () => { await this.executor.renameDirectory(from, to, expected, actor) })
  }
}
