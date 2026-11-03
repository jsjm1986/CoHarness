/** Root-serialized document file mutations backed by retained objects and a SQLite recovery journal. */
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { DOCUMENT_TARGET_CONFLICT_CODE, DOCUMENT_UPLOAD_SIZE_CODE, UserDocError } from '@deepseek-ai/dsh-userdoc'
import { UserDocId, type UserDocDirectoryId, type UserDocIncarnationId, type UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { assertNestedDirectories, docIdFor, pathForDirectoryId, pathForDocId } from './name.ts'
import { DocumentFileAnchor, ensureIdentityDirectory, type DocumentFileObjectId } from './file-object.ts'
import { withDocumentDirectoryMoveRoots, type DocumentDirectoryMoveRoot } from './directory-move.ts'
import type { DocumentIdentityStorage } from './identity-storage.ts'
import { admitDocumentWrite } from './admission.ts'
import type { UserDocBackgroundWrite } from './upload.ts'
import {
  DocumentIdentityConflict, DocumentIdentityStore,
  type DocumentIdentityChange, type DocumentIdentityRecord, type ExpectedDocumentIdentity, type PendingDocumentIdentityChange,
  type ObservedDocumentRelocation,
} from './identity.ts'

function objectPath(storage: DocumentIdentityStorage, id: UserDocIncarnationId): string {
  return join(storage.locations.filesRoot, 'objects', `${String(id)}.object`)
}

function removalPath(storage: DocumentIdentityStorage, pending: PendingDocumentIdentityChange, id: UserDocIncarnationId): string {
  return join(storage.locations.filesRoot, 'removed', `${String(pending.sequence)}.${String(id)}.source`)
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function directoryObject(path: string): Promise<DocumentFileObjectId> {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.isSymbolicLink() || info.ino === 0n) throw new DocumentIdentityConflict('The selected directory object is unavailable.')
  return { device: String(info.dev), inode: String(info.ino) }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function sameFileObject(left: DocumentFileObjectId, right: DocumentFileObjectId): boolean {
  return left.device === right.device && left.inode === right.inode
}

/** Metadata and mutation capabilities borrowed only for one root-locked inspection callback. */
export interface DocumentMutationAccess {
  readonly records: Pick<DocumentIdentityStore, 'get' | 'active' | 'list' | 'rootId' | 'projectionChanges' | 'acknowledgeProjection'
    | 'hasPendingProjection' | 'legacyImportPhase' | 'prepareLegacyImport' | 'completeLegacyImport'>
  /**
   * Apply a file change while this inspection owns the root lock.
   * @param change - admitted lifecycle operation.
   * @returns its committed metadata; callers await settlement before returning from the inspection.
   */
  readonly run: (change: DocumentIdentityChange) => Promise<DocumentIdentityRecord>
  /**
   * Reconcile external address exchanges without mutating their ordinary files.
   * @param relocations - uniquely observed active objects and their new addresses.
   * @returns their committed metadata after retained-object verification and writer admission.
   */
  readonly relocate: (relocations: readonly ObservedDocumentRelocation[]) => Promise<readonly DocumentIdentityRecord[]>
  /**
   * Remove a settled directory marker only when its private retained object proves ownership.
   * @param docId - ordinary file candidate within this root.
   * @returns whether the owned control file was reclaimed; ordinary replacement files are preserved.
   */
  readonly discardRetiredDirectoryMarker: (docId: UserDocId) => Promise<boolean>
}

/** Executor owns the root file lock; its caller owns the SQLite connection until all calls settle. */
export class DocumentMutationExecutor {
  private readonly root: string
  private initialized = false
  /**
   * Bind file execution to one root and its metadata connection.
   * @param storage - explicit public, metadata and retained-object locations.
   * @param store - dedicated metadata database owned by the enclosing filesystem provider.
   * @param admit - host admission for initialization, recovery and every persistent mutation.
   */
  constructor(
    private readonly storage: DocumentIdentityStorage, private readonly store: DocumentIdentityStore,
    private readonly admit?: UserDocBackgroundWrite,
  ) {
    this.root = storage.locations.root
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.storage.verify()
    return withFileLock(this.storage.mutationPath, async () => {
      if (!this.initialized) {
        await admitDocumentWrite(this.admit, async () => {
          await this.storage.bindDomain(this.store.rootId)
          this.store.bindStorage(this.storage.binding)
          await ensureIdentityDirectory(this.storage, 'anchors')
        })
        this.initialized = true
      } else await this.storage.bindDomain(this.store.rootId, false)
      return operation()
    })
  }

  private source(change: DocumentIdentityChange): string {
    switch (change.kind) {
      case 'publish': return join(this.storage.locations.filesRoot, change.source)
      case 'adopt': return change.trash === undefined ? pathForDocId(this.root, change.document.docId)
        : join(this.root, '.dsh-trash', `${String(change.trash.trashId)}.bin`)
      case 'trash': case 'move': case 'observe': case 'remove': return pathForDocId(this.root, change.expected.docId)
      case 'relocate': return pathForDocId(this.root, change.target)
      case 'restore': case 'purge': case 'missing': return objectPath(this.storage, change.expected.incarnationId)
      default: return assertNever(change)
    }
  }

  private target(change: DocumentIdentityChange): string | undefined {
    switch (change.kind) {
      case 'publish': return pathForDocId(this.root, change.document.docId)
      case 'trash': return join(this.storage.locations.filesRoot, 'trash', `${String(change.trashId)}.bin`)
      case 'move': case 'restore': return pathForDocId(this.root, change.target)
      case 'adopt': return change.trash === undefined ? undefined
        : join(this.storage.locations.filesRoot, 'trash', `${String(change.trash.trashId)}.bin`)
      case 'observe': case 'purge': case 'missing': case 'remove': case 'relocate': return undefined
      default: return assertNever(change)
    }
  }

  /**
   * Execute a new operation after settling the previous owner's recovery record.
   * @param change - admitted identity/version and intended file operation.
   * @returns the committed metadata after private cleanup; failures retain recovery evidence.
   */
  async run(change: DocumentIdentityChange): Promise<DocumentIdentityRecord> {
    return this.locked(async () => {
      await this.recoverLocked()
      return this.runLocked(change)
    })
  }

  /**
   * Read and reconcile metadata under the same root lock as physical mutations.
   * @param operation - scope-local work; every supplied mutation must be awaited before this callback returns.
   * @param writesMetadata - whether the callback directly updates metadata outside its supplied file mutations.
   * @returns the callback result after recovery and reconciliation settle.
   */
  async inspect<T>(operation: (access: DocumentMutationAccess) => Promise<T>, writesMetadata = false): Promise<T> {
    return this.locked(async () => {
      await this.recoverLocked()
      const execute = () => operation({ records: this.store, run: change => this.runLocked(change),
        relocate: relocations => this.relocateObservedLocked(relocations),
        discardRetiredDirectoryMarker: docId => this.removeRetiredDirectoryMarker(pathForDocId(this.root, docId), basename(docId)),
      })
      return writesMetadata ? admitDocumentWrite(this.admit, execute) : execute()
    })
  }

  private async runLocked(change: DocumentIdentityChange): Promise<DocumentIdentityRecord> {
    return admitDocumentWrite(this.admit, () => this.applyLocked(change))
  }

  private async relocateObservedLocked(relocations: readonly ObservedDocumentRelocation[]): Promise<readonly DocumentIdentityRecord[]> {
    return admitDocumentWrite(this.admit, async () => {
      for (const relocation of relocations) {
        await DocumentFileAnchor.withSource(this.storage, objectPath(this.storage, relocation.expected.incarnationId), async (retained) => {
          if (!sameFileObject(retained.identity, relocation.file)) throw new DocumentIdentityConflict('The retained document identity object has changed.')
          await DocumentFileAnchor.withSource(this.storage, pathForDocId(this.root, relocation.target), (source) => {
            if (!sameFileObject(source.identity, retained.identity)) throw new DocumentIdentityConflict('The observed document moved again.')
            return Promise.resolve()
          })
        })
      }
      return this.store.relocateObserved(relocations)
    })
  }

  private async applyLocked(change: DocumentIdentityChange): Promise<DocumentIdentityRecord> {
    const sourcePath = this.source(change), targetPath = this.target(change)
    if (targetPath !== undefined && targetPath !== sourcePath && await exists(targetPath)) {
      throw new UserDocError('Document target is occupied.', DOCUMENT_TARGET_CONFLICT_CODE)
    }
    await ensureIdentityDirectory(this.storage, 'objects')
    return DocumentFileAnchor.withSource(this.storage, sourcePath, async (source) => {
      if (change.kind === 'publish' && source.bytes !== change.document.bytes) {
        throw new UserDocError('The upload size does not match its publication.', DOCUMENT_UPLOAD_SIZE_CODE)
      }
      const pending = this.store.prepare(change, change.kind === 'missing' ? null : source.identity)
      const entry = pending.entries[0]
      if (entry === undefined) throw new Error('A file mutation requires one document.')
      const anchor = await source.capture({ sequence: pending.sequence, incarnationId: entry.result.incarnationId })
      if (change.kind !== 'publish' && change.kind !== 'adopt'
        && !await anchor.matches(objectPath(this.storage, entry.result.incarnationId))) {
        await anchor.release()
        this.store.abandon(pending)
        throw new DocumentIdentityConflict('The document no longer matches its retained identity.')
      }
      if (change.kind === 'missing' && await anchor.matches(pathForDocId(this.root, change.expected.docId))) {
        await anchor.release()
        this.store.abandon(pending)
        throw new DocumentIdentityConflict('The selected document is still present at its active path.')
      }
      this.store.retain(pending)
      await this.perform(pending, anchor, true)
      return entry.result
    })
  }

  /**
   * Settle an interrupted operation without recapturing an ordinary replacement path.
   * @returns after the journal and private cleanup settle; unresolved evidence remains intact on refusal.
   */
  async recover(): Promise<void> { await this.locked(() => this.recoverLocked()) }

  /**
   * Rename one directory and commit the exact authorized document inventory together.
   * @param from - existing non-root directory.
   * @param to - unoccupied destination outside the source subtree.
   * @param expected - complete authorized incarnation/version set below the source.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @returns the admitted snapshot after path commit and marker cleanup; subsequent ordinary edits reconcile on observation.
   */
  async renameDirectory(
    from: UserDocDirectoryId, to: UserDocDirectoryId, expected: readonly ExpectedDocumentIdentity[], actor?: UserDocUploadOwnerId,
  ): Promise<readonly DocumentIdentityRecord[]> {
    return this.locked(async () => {
      await this.recoverLocked()
      return admitDocumentWrite(this.admit, async () => {
        const source = pathForDirectoryId(this.root, from), target = pathForDirectoryId(this.root, to)
        if (from === '' || from === to || to.startsWith(`${from}/`)) throw new DocumentIdentityConflict('Invalid directory move.')
        await assertNestedDirectories(this.root, source, DOCUMENT_TARGET_CONFLICT_CODE)
        const selectedDirectory = await directoryObject(source)
        await assertNestedDirectories(this.root, dirname(target), DOCUMENT_TARGET_CONFLICT_CODE)
        if (await exists(target)) throw new UserDocError('Directory target is occupied.', DOCUMENT_TARGET_CONFLICT_CODE)
        const privateDirectory = await ensureIdentityDirectory(this.storage, 'directories')
        const markerSource = join(privateDirectory, 'source.marker')
        try {
          const handle = await open(markerSource, 'wx', 0o600)
          await handle.close()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          if ((await lstat(markerSource)).size !== 0) throw new DocumentIdentityConflict('The directory marker path contains unrelated bytes.')
        }
        return DocumentFileAnchor.withSource(this.storage, markerSource, async (marker) => {
          const pending = this.store.prepareDirectoryMove(from, to, expected, marker.identity, selectedDirectory, actor)
          const anchor = await marker.capture({ sequence: pending.sequence, directory: true })
          const markerName = `.dsh-directory-${String(pending.sequence)}.part`
          if (await exists(join(privateDirectory, `${String(pending.sequence)}.stage`))) {
            throw new DocumentIdentityConflict('The private directory capture is occupied.')
          }
          await this.verifyDirectory(source, pending.entries.map(entry => entry.change.kind === 'move' ? entry.change.expected : entry.result), 'selected')
          await anchor.publish(join(source, markerName))
          this.store.retain(pending)
          await this.performDirectory({ ...pending, phase: 'retained' }, anchor, 'request')
          return pending.entries.map(entry => entry.result)
        })
      })
    })
  }

  private async verifyDirectory(
    path: string, expected: readonly ExpectedDocumentIdentity[], stage: 'selected' | 'moved', marker?: string,
    namespace?: { readonly root: string; readonly directory: UserDocDirectoryId },
  ): Promise<void> {
    const observed: string[] = []
    const directories = [path]
    while (directories.length > 0) {
      const directory = directories.pop()
      if (directory === undefined) break
      await assertNestedDirectories(namespace?.root ?? this.root, directory, DOCUMENT_TARGET_CONFLICT_CODE)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name)
        if (directory === path && entry.name === marker) continue
        if (entry.isFile() && await this.removeRetiredDirectoryMarker(file, entry.name)) continue
        if (entry.isDirectory()) directories.push(file)
        else if (entry.isFile()) observed.push(file)
        else throw new DocumentIdentityConflict('The directory contains an unsupported filesystem entry.')
      }
    }
    const admitted = new Map(expected.map(record => [record.docId, record]))
    if (admitted.size !== expected.length || observed.length !== admitted.size) {
      throw new DocumentIdentityConflict('The directory file inventory changed after authorization.')
    }
    for (const file of observed) {
      const docId = namespace === undefined ? docIdFor(this.root, file)
        : UserDocId(`${namespace.directory}/${relative(path, file).split(sep).join('/')}`)
      const selected = admitted.get(docId)
      if (selected === undefined) throw new DocumentIdentityConflict('The directory file inventory changed after authorization.')
      const record = this.store.get(selected.incarnationId)
      if (record === undefined) throw new DocumentIdentityConflict('An authorized directory document is missing.')
      await DocumentFileAnchor.withSource(this.storage, objectPath(this.storage, selected.incarnationId), async (retained) => {
        await DocumentFileAnchor.withSource(this.storage, file, (actual) => {
          if (actual.identity.device !== retained.identity.device || actual.identity.inode !== retained.identity.inode
            || actual.identity.device !== record.file.device || actual.identity.inode !== record.file.inode) {
            throw new DocumentIdentityConflict('A directory document has been replaced since authorization.')
          }
          if (stage === 'selected' && (actual.bytes !== record.bytes || actual.modifiedAt !== record.modifiedAt)) {
            throw new DocumentIdentityConflict('A directory document changed after authorization.')
          }
          return Promise.resolve()
        })
      })
    }
  }

  /** Keep an orphaned public marker identifiable until its final ordinary link is reclaimed. */
  private async releaseDirectoryMarker(anchor: DocumentFileAnchor): Promise<void> {
    await anchor.matches(anchor.path)
    if ((await lstat(anchor.path, { bigint: true })).nlink === 1n) await anchor.release()
  }

  /** Reclaim only an earlier marker proved by its retained private anchor. */
  private async removeRetiredDirectoryMarker(path: string, name: string): Promise<boolean> {
    const match = /^\.dsh-directory-([1-9][0-9]*)\.part$/iu.exec(name)
    if (match === null) return false
    const sequence = Number(match[1]), current = this.store.pending()?.sequence
    if (!Number.isSafeInteger(sequence) || current !== undefined && sequence >= current) return false
    const oldPath = join(this.storage.locations.filesRoot, 'anchors', `${String(sequence)}.directory.anchor`)
    if (!await exists(oldPath)) return false
    return DocumentFileAnchor.withSource(this.storage, oldPath, async (source) => {
      const anchor = await DocumentFileAnchor.reopen(this.storage, { sequence, directory: true }, source.identity)
      if (anchor === undefined) throw new DocumentIdentityConflict('Retired directory marker evidence disappeared.')
      if (!await anchor.matches(path)) return false
      return admitDocumentWrite(this.admit, async () => {
        const removed = join(this.storage.locations.filesRoot, 'removed', `${String(sequence)}.directory.retired`)
        await anchor.detach(path, removed)
        await anchor.removePrivate(removed)
        if (await exists(path)) throw new DocumentIdentityConflict('The directory changed during marker cleanup.')
        await this.releaseDirectoryMarker(anchor)
        return true
      })
    })
  }

  private async performDirectory(
    pending: PendingDocumentIdentityChange, anchor: DocumentFileAnchor, context: 'request' | 'recovery',
  ): Promise<void> {
    const move = pending.directoryMove
    if (move === undefined) throw new Error('Missing directory mutation.')
    const source = pathForDirectoryId(this.root, move.from), target = pathForDirectoryId(this.root, move.to)
    const markerName = `.dsh-directory-${String(pending.sequence)}.part`
    const sourceMarker = join(source, markerName), targetMarker = join(target, markerName)
    const stage = join(await ensureIdentityDirectory(this.storage, 'directories'), `${String(pending.sequence)}.stage`)
    const stageMarker = join(stage, markerName)
    const removed = join(this.storage.locations.filesRoot, 'removed', `${String(pending.sequence)}.directory.source`)
    const publicRoot: DocumentDirectoryMoveRoot = { path: this.root, identity: this.storage.binding.documents }
    const privateRoot: DocumentDirectoryMoveRoot = { path: this.storage.locations.filesRoot, identity: this.storage.binding.files }
    const shift = (fromRoot: DocumentDirectoryMoveRoot, from: string, toRoot: DocumentDirectoryMoveRoot, to: string) =>
      withDocumentDirectoryMoveRoots(fromRoot, from, toRoot, to, async (scope) => {
        await scope.rename()
        await scope.verify()
      })
    const cancel = async (error: unknown): Promise<void> => {
      try { await this.performDirectory(this.store.cancelDirectory(pending), anchor, 'recovery') } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Directory cancellation and cleanup failed.')
      }
      if (context === 'request') throw error
    }
    const rollback = async (error: unknown): Promise<void> => {
      try { await shift(privateRoot, stage, publicRoot, source) } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Directory refusal and source restoration failed.')
      }
      await cancel(error)
    }
    if (pending.phase === 'prepared') {
      if (await isDirectory(source)) await anchor.detach(sourceMarker, removed)
      await anchor.removePrivate(removed)
      await anchor.removePrivate(join(this.storage.locations.filesRoot, 'directories', 'source.marker'))
      await this.releaseDirectoryMarker(anchor)
      this.store.abandon(pending)
      return
    }
    if (pending.phase === 'retained') {
      let state = pending
      const atSource = await isDirectory(source) && await anchor.matches(sourceMarker)
      const atTarget = await isDirectory(target) && await anchor.matches(targetMarker)
      const stageExists = await exists(stage)
      if (stageExists && !await isDirectory(stage)) {
        if (move.captured || atTarget) throw new DocumentIdentityConflict('The private directory capture changed after verification.')
        await rollback(new DocumentIdentityConflict('The directory source changed during capture.'))
        return
      }
      let atStage = stageExists && await anchor.matches(stageMarker)
      if (Number(atSource) + Number(atTarget) + Number(atStage) > 1) {
        throw new DocumentIdentityConflict('The moved directory cannot be identified unambiguously.')
      }
      if (!atTarget && !atStage) {
        if (move.captured || move.source === null && !atSource) {
          if (atSource && move.source !== null && sameFileObject(await directoryObject(source), move.source)) {
            await cancel(new DocumentIdentityConflict('The captured directory was restored to its source.'))
            return
          }
          throw new DocumentIdentityConflict('A captured directory cannot be located for recovery.')
        }
        if (stageExists) {
          await rollback(new DocumentIdentityConflict('The directory source changed during capture.'))
          return
        }
        if (!atSource) {
          await cancel(new DocumentIdentityConflict('The directory source changed before capture.'))
          return
        }
        if (await exists(target)) {
          await cancel(new DocumentIdentityConflict('The directory destination became occupied.'))
          return
        }
        try { await shift(publicRoot, source, privateRoot, stage) } catch (error) {
          if (await exists(stage)) throw error
          await cancel(error)
          return
        }
        atStage = await isDirectory(stage) && await anchor.matches(stageMarker)
        if (!atStage) {
          await rollback(new DocumentIdentityConflict('The directory source changed during capture.'))
          return
        }
      }
      if (atStage) {
        const expected = pending.entries.map(entry => entry.change.kind === 'move' ? entry.change.expected : entry.result)
        try {
          if (move.source !== null && !sameFileObject(await directoryObject(stage), move.source)) {
            throw new DocumentIdentityConflict('The selected directory object changed during capture.')
          }
          await this.verifyDirectory(stage, expected, move.captured ? 'moved' : 'selected', markerName,
            { root: privateRoot.path, directory: move.from })
        } catch (error) {
          await rollback(error)
          return
        }
        await withDocumentDirectoryMoveRoots(publicRoot, source, privateRoot, stage, async (scope) => {
          await scope.sync()
          await scope.verify()
        })
        state = this.store.captureDirectory(pending, await directoryObject(stage))
        try { await shift(privateRoot, stage, publicRoot, target) } catch (error) {
          if (!await anchor.matches(stageMarker) || await anchor.matches(targetMarker)) throw error
          const code = (error as NodeJS.ErrnoException).code
          await rollback(code === 'EEXIST' || code === 'ENOTEMPTY'
            ? new UserDocError('The directory destination became occupied.', DOCUMENT_TARGET_CONFLICT_CODE, { cause: error }) : error)
          return
        }
      } else if (!move.captured && move.source !== null) {
        throw new DocumentIdentityConflict('The directory moved without a verified private capture.')
      }
      if (!await anchor.matches(targetMarker)) throw new DocumentIdentityConflict('The directory marker did not move to its destination.')
      await withDocumentDirectoryMoveRoots(publicRoot, source, privateRoot, stage, async (scope) => {
        await scope.sync()
        await scope.verify()
      })
      await withDocumentDirectoryMoveRoots(privateRoot, stage, publicRoot, target, async (scope) => {
        await scope.sync()
        await scope.verify()
      })
      if (move.source === null) {
        await this.verifyDirectory(target, pending.entries.map(entry => entry.result), 'moved', markerName)
        state = this.store.captureDirectory(state, await directoryObject(target))
      } else if (!sameFileObject(await directoryObject(target), move.source)) {
        throw new DocumentIdentityConflict('The published directory object changed.')
      }
      this.store.commit(state)
    }
    await anchor.detach(targetMarker, removed)
    await anchor.removePrivate(removed)
    await anchor.removePrivate(join(this.storage.locations.filesRoot, 'directories', 'source.marker'))
    await this.releaseDirectoryMarker(anchor)
    this.store.finish(pending)
  }

  private async recoverLocked(): Promise<void> {
    const pending = this.store.pending()
    if (pending === undefined) return
    await admitDocumentWrite(this.admit, () => this.recoverPending(pending))
  }

  private async recoverPending(pending: PendingDocumentIdentityChange): Promise<void> {
    if (pending.directoryMove !== undefined) {
      const anchor = await DocumentFileAnchor.reopen(this.storage,
        { sequence: pending.sequence, directory: true }, pending.directoryMove.marker)
      if (anchor !== undefined) await this.performDirectory(pending, anchor, 'recovery')
      else if (pending.phase === 'prepared') this.store.abandon(pending)
      else if (pending.phase === 'committed') this.store.finish(pending)
      else throw new DocumentIdentityConflict('Directory recovery evidence is missing.')
      return
    }
    const entry = pending.entries[0]
    if (entry === undefined || pending.entries.length !== 1) throw new Error('Invalid file mutation batch.')
    const anchor = await DocumentFileAnchor.reopen(this.storage,
      { sequence: pending.sequence, incarnationId: entry.result.incarnationId }, entry.file ?? entry.result.file)
    if (pending.phase === 'prepared') {
      // Ordinary file work starts only after the retained phase commits.
      await anchor?.release()
      this.store.abandon(pending)
      return
    }
    if (anchor === undefined) {
      if (pending.phase !== 'committed') throw new DocumentIdentityConflict('Document recovery evidence is missing.')
      // Anchor release follows every private cleanup and never precedes metadata commit.
      this.store.finish(pending)
      return
    }
    await this.perform(pending, anchor, false)
  }

  private async perform(pending: PendingDocumentIdentityChange, anchor: DocumentFileAnchor, fresh: boolean): Promise<void> {
    const entry = pending.entries[0]
    if (entry === undefined) throw new Error('Missing document mutation entry.')
    const { change, result } = entry
    const source = change.kind === 'restore' ? join(this.storage.locations.filesRoot, 'trash', `${String(change.trashId)}.bin`) : this.source(change)
    const target = this.target(change)
    const removed = removalPath(this.storage, pending, result.incarnationId)
    const retained = objectPath(this.storage, result.incarnationId)
    if (pending.phase !== 'committed') {
      if (target !== undefined && target !== source) {
        if (change.kind === 'trash' || change.kind === 'adopt' && change.trash !== undefined) {
          await ensureIdentityDirectory(this.storage, 'trash')
        }
        await assertNestedDirectories(this.storage.fileRoot(target), dirname(target), DOCUMENT_TARGET_CONFLICT_CODE)
        try { await anchor.publish(target) } catch (error) {
          if (fresh) {
            // No ordinary mutation has preceded this first exclusive publication.
            try { await anchor.release(); this.store.abandon(pending) } catch (cleanupError) {
              throw new AggregateError([error, cleanupError], 'Document publication and intent cleanup failed.')
            }
          }
          throw error
        }
      }
      if (change.kind === 'publish' || change.kind === 'adopt') {
        await ensureIdentityDirectory(this.storage, 'objects')
        await anchor.publish(retained)
      }
      if (target !== undefined && target !== source) await anchor.detach(source, removed)
      if (change.kind === 'remove') await anchor.detach(source, removed)
      if (change.kind === 'purge') {
        const hidden = join(this.storage.locations.filesRoot, 'trash', `${String(change.trashId)}.bin`)
        if (await exists(hidden) && !await anchor.matches(hidden)) {
          throw new DocumentIdentityConflict('The trash payload belongs to another file object.')
        }
        await anchor.detach(hidden, removed)
      }
      this.store.commit(pending)
    }
    await anchor.removePrivate(removed)
    if (result.state === 'purged' || result.state === 'missing') await anchor.removePrivate(retained)
    await anchor.release()
    this.store.finish(pending)
  }
}
