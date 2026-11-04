/** Verified deployment snapshots rebind logical document identities to restored filesystem objects. */
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, rename, rm, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { UserDocRootId } from '@deepseek-ai/dsh-userdoc'
import { DocumentIdentityStore, type DocumentIdentityRecord } from './identity.ts'
import { DocumentIdentityStorage, type DocumentIdentityLocations } from './identity-storage.ts'
import { isInside, pathForDocId } from './name.ts'
import { withDocumentHandle } from './handle.ts'
import type { DocumentFileObjectId } from './file-object.ts'
import { loadNodeSqlite } from '@deepseek-ai/dsh-session-persistence-sqlite'

/** Immutable membership and digests from the deployment's verified complete snapshot. */
export interface DocumentBackupEntry {
  readonly path: string
  readonly object?: { readonly device: string; readonly inode: string }
  readonly sizeBytes?: number
  readonly sha256?: string
  readonly modifiedAt?: number
}

/** Independent immutable snapshot whose database and complete file evidence predate a device-number change. */
export interface DocumentMountRecoveryReference {
  /** Byte-verified original metadata member, never the live database or a newly captured copy. */
  readonly databasePath: string
  /** Original absolute membership and digests from the verified deployment backup. */
  readonly entries: readonly DocumentBackupEntry[]
}

interface RetainedLinks {
  readonly paths: readonly string[]
  readonly source: string
}

interface RetainedDocument extends RetainedLinks {
  readonly record: DocumentIdentityRecord
}

function same(left: { device: string; inode: string }, right: { device: string; inode: string }): boolean {
  return left.device === right.device && left.inode === right.inode
}

function object(value: unknown): { device: string; inode: string; volume?: string } {
  if (value === null || typeof value !== 'object' || !('device' in value) || typeof value.device !== 'string'
    || !('inode' in value) || typeof value.inode !== 'string') throw new Error('Document backup has an invalid object witness.')
  if ('volume' in value && (typeof value.volume !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(value.volume))) {
    throw new Error('Document backup has an invalid volume witness.')
  }
  return { device: value.device, inode: value.inode, ...'volume' in value ? { volume: value.volume as string } : {} }
}

function backupEntries(
  evidence: readonly DocumentBackupEntry[],
): (path: string) => DocumentBackupEntry & { readonly object: DocumentFileObjectId } {
  const entries = new Map(evidence.map(entry => [entry.path, entry]))
  if (entries.size !== evidence.length) throw new Error('Document backup contains duplicate evidence.')
  return (path) => {
    const result = entries.get(path)
    if (result?.object === undefined) throw new Error(`Document backup lacks object evidence: ${path}`)
    return { ...result, object: result.object }
  }
}

async function verifyFile(path: string, proof: DocumentBackupEntry, original: boolean, signal?: AbortSignal): Promise<void> {
  if (proof.sha256 === undefined || proof.sizeBytes === undefined || proof.object === undefined) {
    throw new Error('Document backup lacks complete file evidence.')
  }
  const { sizeBytes, sha256, object: expected } = proof
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  await withDocumentHandle(handle, async () => {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.size !== BigInt(sizeBytes)
      || original && !same({ device: String(before.dev), inode: String(before.ino) }, expected)) {
      throw new Error('Document backup file no longer matches its evidence.')
    }
    const hash = createHash('sha256'), bytes = Buffer.allocUnsafe(128 * 1024)
    for (;;) {
      signal?.throwIfAborted()
      const { bytesRead } = await handle.read(bytes)
      if (bytesRead === 0) break
      hash.update(bytes.subarray(0, bytesRead))
    }
    const after = await handle.stat({ bigint: true }), current = await lstat(path, { bigint: true })
    if (hash.digest('hex') !== sha256 || after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs || current.dev !== before.dev || current.ino !== before.ino) {
      throw new Error('Document backup file changed or has an invalid digest.')
    }
  })
}

async function withVerifiedDomain<T>(
  locations: DocumentIdentityLocations, evidence: readonly DocumentBackupEntry[], original: boolean,
  signal: AbortSignal | undefined,
  work: (
    storage: DocumentIdentityStorage, database: DatabaseSync, store: DocumentIdentityStore, retained: readonly RetainedDocument[],
    markers: readonly RetainedLinks[],
  ) => Promise<T>,
): Promise<T> {
  const entry = backupEntries(evidence)
  const roots = [locations.root, locations.stateRoot, locations.filesRoot]
  for (const path of roots) {
    signal?.throwIfAborted()
    const info = await lstat(path, { bigint: true })
    if (!info.isDirectory() || info.isSymbolicLink()
      || original && !same({ device: String(info.dev), inode: String(info.ino) }, entry(path).object)) {
      throw new Error('Document backup directory no longer matches its evidence.')
    }
    entry(path)
  }
  const storage = await DocumentIdentityStorage.open(locations)
  return withFileLock(storage.mutationPath, async () => {
    await storage.verify()
    const databasePath = storage.databasePath, markerPath = join(locations.filesRoot, 'domain.json')
    await verifyFile(databasePath, entry(databasePath), original, signal)
    await verifyFile(markerPath, entry(markerPath), original, signal)
    const marker = await storage.domainMarker()
    const { DatabaseSync } = await loadNodeSqlite()
    const database = new DatabaseSync(databasePath, { readOnly: original })
    try {
      const store = new DocumentIdentityStore(locations.root, database, 'read')
      if (store.pending() !== undefined || store.legacyImportPhase() !== 'complete') {
        throw new Error('Document recovery and legacy import must settle before a deployment snapshot.')
      }
      const binding = database.prepare('SELECT * FROM document_identity_storage WHERE slot=1').get()
      const agrees = (recorded: { device: string; inode: string; volume?: string }, proof: DocumentFileObjectId,
        actual: { readonly volume?: string }) => recorded.inode === proof.inode
        && (recorded.device === proof.device || recorded.volume !== undefined)
        && (recorded.volume === undefined || !original || recorded.volume === actual.volume)
      const directories = (prefix: 'documents' | 'files') => object({ device: binding?.[`${prefix}_device`],
        inode: binding?.[`${prefix}_inode`], ...binding?.[`${prefix}_volume`] == null ? {} : { volume: binding[`${prefix}_volume`] } })
      const markerObject = (value: unknown) => {
        const parsed = object(value)
        return typeof marker === 'object' && marker !== null && 'version' in marker && marker.version === 2
          ? parsed : { device: parsed.device, inode: parsed.inode }
      }
      if (!agrees(directories('documents'), entry(locations.root).object, storage.binding.documents)
        || !agrees(directories('files'), entry(locations.filesRoot).object, storage.binding.files)
        || marker === null || typeof marker !== 'object' || !('version' in marker) || marker.version !== 1 && marker.version !== 2
        || !('rootId' in marker) || marker.rootId !== store.rootId || !('state' in marker) || !('database' in marker)
        || !agrees(markerObject(marker.state), entry(locations.stateRoot).object, storage.stateIdentity)
        || !agrees(markerObject(marker.database), entry(databasePath).object, await storage.metadataFile())) {
        throw new Error('Document backup metadata and retained storage belong to different identity domains.')
      }
      const retained: RetainedDocument[] = [], objects = new Map<string, string>()
      for (const record of store.list()) {
        if (record.state !== 'active' && record.state !== 'trash') continue
        const retainedPath = join(locations.filesRoot, 'objects', `${String(record.incarnationId)}.object`)
        const ordinary = record.state === 'active' ? pathForDocId(locations.root, record.docId)
          // oxlint-disable-next-line typescript/no-non-null-assertion -- the durable parser requires trash metadata in this state.
          : join(locations.filesRoot, 'trash', `${String(record.trash!.trashId)}.bin`)
        const paths = [retainedPath, ordinary]
        const reference = entry(retainedPath)
        for (const path of paths) {
          const proof = entry(path)
          const captured = { ...record.file, device: record.file.device === binding?.documents_device
            ? entry(locations.root).object.device : record.file.device }
          if (!same(proof.object, captured) || proof.sizeBytes !== record.bytes || proof.modifiedAt !== record.modifiedAt
            || proof.sha256 !== reference.sha256) throw new Error('Document backup does not retain its committed file version.')
          await verifyFile(path, proof, original, signal)
        }
        const key = `${record.file.device}:${record.file.inode}`
        const source = objects.get(key) ?? retainedPath
        objects.set(key, source)
        retained.push({ record, paths, source })
      }
      const markers: RetainedLinks[] = []
      for (const candidate of evidence) {
        if (dirname(candidate.path) !== join(locations.filesRoot, 'anchors')) continue
        const match = /^([1-9][0-9]*)\.directory\.anchor$/u.exec(basename(candidate.path))
        if (match === null) continue
        const reference = entry(candidate.path), paths = [candidate.path]
        await verifyFile(candidate.path, reference, original, signal)
        for (const possible of evidence) {
          if (!isInside(locations.root, possible.path)) continue
          const sequence = /^\.dsh-directory-([1-9][0-9]*)\.part$/iu.exec(basename(possible.path))?.[1]
          if (sequence !== match[1] || possible.object === undefined || !same(possible.object, reference.object)) continue
          if (possible.sizeBytes !== reference.sizeBytes || possible.sha256 !== reference.sha256) {
            throw new Error('Document backup has inconsistent directory marker evidence.')
          }
          await verifyFile(possible.path, possible, original, signal)
          paths.push(possible.path)
        }
        markers.push({ source: candidate.path, paths })
      }
      signal?.throwIfAborted()
      const writable = original ? store : new DocumentIdentityStore(locations.root, database)
      return await work(storage, database, writable, retained, markers)
    } finally { database.close() }
  })
}

/**
 * Verify logical identity and original filesystem witnesses before accepting a deployment backup.
 * @param locations - Gateway-owned public, metadata and retained-object roots.
 * @param evidence - complete copied-file hashes and original directory/file witnesses.
 * @param signal - deployment lease lifetime; all runtime writers must already be stopped.
 * @returns after every committed active and trash object is proven recoverable without changing metadata.
 */
export async function verifyDocumentIdentityBackup(
  locations: DocumentIdentityLocations, evidence: readonly DocumentBackupEntry[], signal?: AbortSignal,
): Promise<void> {
  await withVerifiedDomain(locations, evidence, true, signal, async () => {})
}

/**
 * Rebind byte-verified restored files while preserving incarnation, trash action, creator and delivery positions.
 * @param locations - destinations already authorized by the independent pre-restore inventory.
 * @param evidence - immutable evidence from the verified backup whose complete bytes were just restored.
 * @param signal - exclusive deployment restore lease; callers keep every runtime stopped until success.
 * @returns after retained/public hard links, private directory binding and metadata agree on their new kernel objects.
 */
export async function restoreDocumentIdentityBackup(
  locations: DocumentIdentityLocations, evidence: readonly DocumentBackupEntry[], signal?: AbortSignal,
): Promise<void> {
  await withVerifiedDomain(locations, evidence, false, signal, async (storage, database, store, retained, markers) => {
    const records: DocumentIdentityRecord[] = []
    for (const item of [...retained, ...markers]) {
      for (const path of item.paths) {
        if (path === item.source) continue
        signal?.throwIfAborted()
        const temporary = join(dirname(path), `.dsh-restore-${randomUUID()}.part`)
        try { await link(item.source, temporary); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
      }
    }
    for (const item of retained) {
      await utimes(item.source, item.record.modifiedAt / 1000, item.record.modifiedAt / 1000)
      const info = await lstat(item.source, { bigint: true })
      const handle = await open(item.source, constants.O_RDONLY | constants.O_NOFOLLOW)
      await withDocumentHandle(handle, () => handle.sync())
      records.push({ ...item.record, file: { device: String(info.dev), inode: String(info.ino) }, modifiedAt: Number(info.mtimeNs) / 1e6 })
    }
    signal?.throwIfAborted()
    database.exec('BEGIN IMMEDIATE')
    try {
      const update = database.prepare('UPDATE document_identities SET record=? WHERE incarnation_id=?')
      for (const record of records) update.run(JSON.stringify(record), record.incarnationId)
      database.prepare(`UPDATE document_identity_storage SET documents_device=?,documents_inode=?,files_device=?,files_inode=?,
        documents_volume=?,files_volume=? WHERE slot=1`)
        .run(storage.binding.documents.device, storage.binding.documents.inode, storage.binding.files.device, storage.binding.files.inode,
          storage.binding.documents.volume ?? null, storage.binding.files.volume ?? null)
      database.exec('COMMIT')
    } catch (error) {
      try { database.exec('ROLLBACK') } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Document restore rollback failed.') }
      throw error
    }
    const state = await lstat(locations.stateRoot, { bigint: true }), metadata = await storage.metadataFile()
    await writeFileAtomic(join(locations.filesRoot, 'domain.json'), JSON.stringify({ version: 1, rootId: store.rootId,
      state: { device: String(state.dev), inode: String(state.ino) }, database: metadata }), { mode: 0o600, dirMode: 0o700 })
    store.bindStorage(storage.binding)
    await storage.bindDomain(store.rootId, false)
    const changedDirectories = new Set([
      locations.stateRoot, locations.filesRoot, ...[...retained, ...markers].flatMap(item => item.paths.map(path => dirname(path))),
    ])
    for (const directory of changedDirectories) {
      const handle = await open(directory, 'r')
      await withDocumentHandle(handle, () => handle.sync())
    }
    const handle = await open(storage.databasePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    await withDocumentHandle(handle, () => handle.sync())
    signal?.throwIfAborted()
  })
}

/**
 * Recover an original legacy store after a mount changes only its device numbers, without rolling back later purge history.
 * Every current active or trash version must match the independent snapshot's logical record, original inode and digest.
 * @param locations - original provider-owned roots; copied roots and replacement databases are refused.
 * @param reference - immutable, independently verified pre-remount snapshot; callers protect its members from modification.
 * @param signal - exclusive offline recovery lifetime; callers stop every runtime and document writer until success.
 * @returns after UUID acquisition and device normalization; interruption preserves bytes and permits the same verified retry.
 */
export async function recoverDocumentIdentityMount(
  locations: DocumentIdentityLocations, reference: DocumentMountRecoveryReference, signal?: AbortSignal,
): Promise<void> {
  const entry = backupEntries(reference.entries)
  if ([locations.root, locations.stateRoot, locations.filesRoot].some(root => isInside(root, reference.databasePath))) {
    throw new Error('Mount recovery requires an independent snapshot database outside the live storage.')
  }
  const storage = await DocumentIdentityStorage.open(locations)
  await withFileLock(storage.mutationPath, async () => {
    await storage.verify()
    const metadata = await storage.metadataFile()
    const documentVolume = storage.binding.documents.volume, fileVolume = storage.binding.files.volume, stateVolume = metadata.volume
    if (documentVolume === undefined || fileVolume === undefined || stateVolume === undefined) {
      throw new Error('Mount recovery requires persistent filesystem UUIDs for all storage locations.')
    }
    const devices = new Map<string, { device: string; volume: string }>()
    const original = async (path: string, volume: string): Promise<void> => {
      signal?.throwIfAborted()
      const info = await lstat(path, { bigint: true }), proof = entry(path).object
      const known = devices.get(proof.device)
      if (String(info.ino) !== proof.inode || known !== undefined && (known.device !== String(info.dev) || known.volume !== volume)) {
        throw new Error('Mount recovery found a copied or inconsistent original filesystem object.')
      }
      devices.set(proof.device, { device: String(info.dev), volume })
    }
    for (const [path, volume] of [[locations.root, documentVolume], [locations.filesRoot, fileVolume],
      [locations.stateRoot, stateVolume], [storage.databasePath, stateVolume]] as const) await original(path, volume)
    await verifyFile(reference.databasePath, entry(storage.databasePath), false, signal)
    const savedObject = await lstat(reference.databasePath, { bigint: true })
    if (String(savedObject.dev) === metadata.device && String(savedObject.ino) === metadata.inode) {
      throw new Error('Mount recovery cannot use a hard link to the live metadata as an independent snapshot.')
    }
    const { DatabaseSync } = await loadNodeSqlite()
    const savedDatabase = new DatabaseSync(reference.databasePath, { readOnly: true })
    let rootId: UserDocRootId
    try {
      const currentDatabase = new DatabaseSync(storage.databasePath, { readOnly: true })
      try {
        const saved = new DocumentIdentityStore(locations.root, savedDatabase, 'read')
        const current = new DocumentIdentityStore(locations.root, currentDatabase, 'read')
        rootId = current.rootId
        if (saved.rootId !== current.rootId || saved.pending() !== undefined || current.pending() !== undefined
        || saved.legacyImportPhase() !== 'complete' || current.legacyImportPhase() !== 'complete') {
          throw new Error('Mount recovery requires one settled original metadata domain.')
        }
        const savedBinding = savedDatabase.prepare('SELECT * FROM document_identity_storage WHERE slot=1').get()
        const currentBinding = currentDatabase.prepare('SELECT * FROM document_identity_storage WHERE slot=1').get()
        for (const [prefix, path, now] of [['documents', locations.root, storage.binding.documents],
          ['files', locations.filesRoot, storage.binding.files]] as const) {
          const proof = entry(path).object, savedVolume = savedBinding?.[`${prefix}_volume`], currentVolume = currentBinding?.[`${prefix}_volume`]
          if (savedBinding?.[`${prefix}_device`] !== proof.device || savedBinding[`${prefix}_inode`] !== proof.inode
          || savedVolume != null && savedVolume !== now.volume || currentBinding?.[`${prefix}_inode`] !== proof.inode
          || currentVolume != null && currentVolume !== now.volume
          || currentBinding[`${prefix}_device`] !== proof.device
            && !(currentVolume === now.volume && currentBinding[`${prefix}_device`] === now.device)) {
            throw new Error('Mount recovery reference and current directory bindings disagree.')
          }
        }
        const markerPath = join(locations.filesRoot, 'domain.json')
        const marker = await storage.domainMarker()
        if (marker === null || typeof marker !== 'object' || !('version' in marker) || !('rootId' in marker) || marker.rootId !== rootId) {
          throw new Error('Mount recovery found another private metadata domain.')
        }
        const persistent = (value: unknown) => typeof value === 'object' && value !== null && 'volume' in value
        if (marker.version === 2 && ('state' in marker && persistent(marker.state) || 'database' in marker && persistent(marker.database))) {
          await storage.bindDomain(rootId, false)
        }
        else {
          if (marker.version !== 1 && marker.version !== 2 || !('state' in marker) || !('database' in marker)
          || !same(object(marker.state), entry(locations.stateRoot).object)
          || !same(object(marker.database), entry(storage.databasePath).object)) {
            throw new Error('Mount recovery found inconsistent original metadata witnesses.')
          }
          await original(markerPath, fileVolume)
          await verifyFile(markerPath, entry(markerPath), false, signal)
        }
        const savedRecords = new Map(saved.list().map(record => [record.incarnationId, record]))
        for (const record of current.list()) {
          if (record.state !== 'active' && record.state !== 'trash') continue
          const previous = savedRecords.get(record.incarnationId), proofDevice = entry(locations.root).object.device
          if (previous === undefined || record.file.device !== proofDevice && record.file.device !== storage.binding.documents.device
          || JSON.stringify({ ...record, file: { ...record.file, device: proofDevice } }) !== JSON.stringify(previous)) {
            throw new Error('Mount recovery reference does not cover every current document version.')
          }
          const ordinary = record.state === 'active' ? pathForDocId(locations.root, record.docId)
          // oxlint-disable-next-line typescript/no-non-null-assertion -- the durable parser requires trash metadata.
            : join(locations.filesRoot, 'trash', `${String(record.trash!.trashId)}.bin`)
          const retained = join(locations.filesRoot, 'objects', `${String(record.incarnationId)}.object`)
          for (const path of [ordinary, retained]) {
            const proof = entry(path)
            if (!same(proof.object, previous.file) || proof.sizeBytes !== record.bytes || proof.modifiedAt !== record.modifiedAt) {
              throw new Error('Mount recovery has incomplete original document evidence.')
            }
            await original(path, documentVolume)
            await verifyFile(path, proof, false, signal)
          }
        }
      } finally { currentDatabase.close() }
    } finally { savedDatabase.close() }
    await storage.verify()
    await storage.metadataFile()
    signal?.throwIfAborted()
    const state = await lstat(locations.stateRoot, { bigint: true })
    await writeFileAtomic(join(locations.filesRoot, 'domain.json'), JSON.stringify({ version: 2, rootId,
      state: { device: String(state.dev), inode: String(state.ino), volume: stateVolume }, database: metadata }), {
      mode: 0o600, dirMode: 0o700,
    })
    const database = new DatabaseSync(storage.databasePath)
    try { new DocumentIdentityStore(locations.root, database).recoverMount(storage.binding) } finally { database.close() }
    await storage.bindDomain(rootId, false)
    for (const path of [locations.filesRoot, locations.stateRoot, storage.databasePath]) {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      await withDocumentHandle(handle, () => handle.sync())
    }
  })
}
