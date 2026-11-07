/** Durable document incarnations and prepared lifecycle changes; file operations run under the provider's root lock. */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  UserDocId, UserDocRootId, UserDocIncarnationId, UserDocTrashId, UserDocUploadOwnerId,
  UserDocError, DOCUMENT_TARGET_CONFLICT_CODE, DOCUMENT_TRASH_CONFLICT_CODE,
} from '@deepseek-ai/dsh-userdoc'
import { pathForDocId, pathForDirectoryId } from './name.ts'
import type { UserDocDirectoryId } from '@deepseek-ai/dsh-userdoc'
import { isAbsolute } from 'node:path'
import type { DocumentFileObjectId } from './file-object.ts'
import { DOCUMENT_PROJECTION_SCHEMA, DocumentProjectionJournal } from './projection.ts'
import type { DocumentProjectionBatch, DocumentProjectionCursor, DocumentProjectionReadOptions } from './projection.ts'
import { mediaTypeFor } from './media-type.ts'
import type { DocumentStorageBinding } from './identity-storage.ts'

/** Physical layout version of the private document identity database. */
export const DOCUMENT_IDENTITY_SCHEMA_VERSION = 4
const APPLICATION_ID = 0x44534844

/** Lifecycle metadata retained independently of a document's mutable path. */
export interface DocumentIdentityRecord {
  readonly incarnationId: UserDocIncarnationId
  readonly revision: number
  readonly docId: UserDocId
  readonly state: 'active' | 'trash' | 'purged' | 'missing'
  readonly createdBy?: UserDocUploadOwnerId
  readonly origin: 'upload' | 'transfer' | 'legacy' | 'admin'
  readonly bytes: number
  readonly mediaType: string
  readonly modifiedAt: number
  readonly file: DocumentFileObjectId
  readonly trash?: {
    readonly trashId: UserDocTrashId
    readonly docId: UserDocId
    readonly trashedAt: number
    readonly purgeAfter: number
  }
}

/** Metadata of one new publication; its identity is allocated before file publication. */
export type NewDocumentIdentity = Omit<DocumentIdentityRecord, 'state' | 'revision' | 'trash' | 'file'>

/** Exact version admitted by an ownership check. */
export interface ExpectedDocumentIdentity {
  readonly incarnationId: UserDocIncarnationId
  readonly revision: number
  readonly docId: UserDocId
}

/** One uniquely observed external address change, verified against the retained file object. */
export interface ObservedDocumentRelocation {
  readonly expected: ExpectedDocumentIdentity
  readonly target: UserDocId
  readonly file: DocumentFileObjectId
}

type DocumentIdentityAction =
  | { readonly kind: 'publish'; readonly document: NewDocumentIdentity; readonly source: string }
  | { readonly kind: 'adopt'; readonly document: NewDocumentIdentity; readonly trash?: NonNullable<DocumentIdentityRecord['trash']> }
  | {
    readonly kind: 'trash'
    readonly expected: ExpectedDocumentIdentity
    readonly trashId: UserDocTrashId
    readonly trashedAt: number
    readonly purgeAfter: number
  }
  | { readonly kind: 'restore'; readonly expected: ExpectedDocumentIdentity; readonly trashId: UserDocTrashId; readonly target: UserDocId }
  | { readonly kind: 'purge'; readonly expected: ExpectedDocumentIdentity; readonly trashId: UserDocTrashId }
  | { readonly kind: 'move'; readonly expected: ExpectedDocumentIdentity; readonly target: UserDocId }
  | { readonly kind: 'relocate'; readonly expected: ExpectedDocumentIdentity; readonly target: UserDocId }
  | { readonly kind: 'remove'; readonly expected: ExpectedDocumentIdentity }
  | {
    readonly kind: 'observe'
    readonly expected: ExpectedDocumentIdentity
    readonly bytes: number
    readonly mediaType: string
    readonly modifiedAt: number
  }
  | { readonly kind: 'missing'; readonly expected: ExpectedDocumentIdentity }

/** A lifecycle operation; an absent actor records an unattributed operation rather than its later delivery caller. */
export type DocumentIdentityChange = DocumentIdentityAction & { readonly actor?: UserDocUploadOwnerId }

/** One root-owned prepared change, retained until physical cleanup completes. */
export interface PendingDocumentIdentityChange {
  readonly sequence: number
  readonly phase: 'prepared' | 'retained' | 'committed'
  readonly entries: readonly {
    readonly change: DocumentIdentityChange
    readonly file: DocumentFileObjectId | null
    readonly result: DocumentIdentityRecord
  }[]
  readonly directoryMove?: {
    readonly from: UserDocDirectoryId
    readonly to: UserDocDirectoryId
    readonly marker: DocumentFileObjectId
    /** Selected directory object; null only for an intent migrated from schema 2. */
    readonly source: DocumentFileObjectId | null
    /** A verified private capture precedes possible publication at the destination. */
    readonly captured: boolean
  }
}

/** A stale identity, occupied journal or exhausted revision prevents a new filesystem operation. */
export class DocumentIdentityConflict extends UserDocError {
  /**
   * Retain the fixed lifecycle refusal for the provider's public error mapping.
   * @param message - explanation of the refused metadata operation.
   */
  constructor(message: string) { super(message, DOCUMENT_TARGET_CONFLICT_CODE); this.name = 'DocumentIdentityConflict' }
}

function stateConflict(message: string): never {
  throw new DocumentIdentityConflict(message)
}


function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid document identity record.')
  return value as Record<string, unknown>
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)) {
    throw new Error('Invalid document identity UUID.')
  }
  return value
}

function count(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error('Invalid document identity counter.')
  return value
}

function metadata(value: unknown): { bytes: number; mediaType: string; modifiedAt: number } {
  const row = object(value)
  if (typeof row.mediaType !== 'string' || row.mediaType === '' || row.mediaType.length > 255
    || /[\u0000-\u001f\u007f]/u.test(row.mediaType)
    || typeof row.modifiedAt !== 'number' || !Number.isFinite(row.modifiedAt) || row.modifiedAt < 0) {
    throw new Error('Invalid document identity metadata.')
  }
  return { bytes: count(row.bytes), mediaType: row.mediaType, modifiedAt: row.modifiedAt }
}

function documentId(root: string, value: unknown): UserDocId {
  if (typeof value !== 'string') throw new Error('Invalid document identity path.')
  pathForDocId(root, value)
  return UserDocId(value)
}

function parseExpected(root: string, value: unknown): ExpectedDocumentIdentity {
  const row = object(value)
  return { incarnationId: UserDocIncarnationId(uuid(row.incarnationId)), revision: count(row.revision, 1),
    docId: documentId(root, row.docId) }
}

function fileObject(value: unknown): DocumentFileObjectId {
  const row = object(value)
  if (typeof row.device !== 'string' || !/^(?:0|[1-9][0-9]*)$/u.test(row.device)
    || typeof row.inode !== 'string' || !/^[1-9][0-9]*$/u.test(row.inode)) throw new Error('Invalid document file evidence.')
  return { device: row.device, inode: row.inode }
}

function sameFile(left: DocumentFileObjectId, right: DocumentFileObjectId): boolean {
  return left.device === right.device && left.inode === right.inode
}

function parseTrash(root: string, value: unknown): NonNullable<DocumentIdentityRecord['trash']> {
  const item = object(value)
  const trashedAt = count(item.trashedAt), purgeAfter = count(item.purgeAfter)
  if (purgeAfter < trashedAt) throw new Error('Invalid document trash deadline.')
  return { trashId: UserDocTrashId(uuid(item.trashId)), docId: documentId(root, item.docId), trashedAt, purgeAfter }
}

function parseNewDocument(root: string, value: unknown): NewDocumentIdentity {
  const row = object(value)
  if (typeof row.origin !== 'string' || !['upload', 'transfer', 'legacy', 'admin'].includes(row.origin)) {
    throw new Error('Invalid document identity origin.')
  }
  if (row.createdBy !== undefined && (typeof row.createdBy !== 'string' || row.createdBy.length === 0 || row.createdBy.length > 256
    || /[\u0000-\u001f\u007f]/u.test(row.createdBy))) {
    throw new Error('Invalid document owner identity.')
  }
  return {
    incarnationId: UserDocIncarnationId(uuid(row.incarnationId)), docId: documentId(root, row.docId), ...metadata(row),
    origin: row.origin as NewDocumentIdentity['origin'],
    ...row.createdBy === undefined ? {} : { createdBy: UserDocUploadOwnerId(row.createdBy) },
  }
}

function parseRecord(root: string, value: unknown): DocumentIdentityRecord {
  const row = object(value)
  if (typeof row.state !== 'string' || !['active', 'trash', 'purged', 'missing'].includes(row.state)) {
    throw new Error('Invalid document identity state.')
  }
  let trash: DocumentIdentityRecord['trash']
  if (row.trash !== undefined) trash = parseTrash(root, row.trash)
  const expected = parseExpected(root, row)
  if ((row.state === 'trash') !== (trash !== undefined) || trash !== undefined && trash.docId !== expected.docId) {
    throw new Error('Invalid document trash identity.')
  }
  return {
    ...parseNewDocument(root, row), revision: expected.revision, file: fileObject(row.file),
    state: row.state as DocumentIdentityRecord['state'],
    ...trash === undefined ? {} : { trash },
  }
}

function parseAction(root: string, value: unknown): DocumentIdentityAction {
  const row = object(value)
  if (row.kind === 'publish' || row.kind === 'adopt') {
    const document = parseNewDocument(root, row.document)
    if (row.kind === 'adopt') return { kind: 'adopt', document,
      ...row.trash === undefined ? {} : { trash: parseTrash(root, row.trash) } }
    if (typeof row.source !== 'string' || row.source === '' || isAbsolute(row.source) || /[\\\u0000-\u001f\u007f]/u.test(row.source)
      || row.source.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('Invalid publication source.')
    return { kind: 'publish', document, source: row.source }
  }
  const expected = parseExpected(root, row.expected)
  switch (row.kind) {
    case 'trash': {
      const trashedAt = count(row.trashedAt), purgeAfter = count(row.purgeAfter)
      if (purgeAfter < trashedAt) throw new Error('Invalid trash retention.')
      return { kind: row.kind, expected, trashId: UserDocTrashId(uuid(row.trashId)), trashedAt, purgeAfter }
    }
    case 'restore': return { kind: row.kind, expected, trashId: UserDocTrashId(uuid(row.trashId)), target: documentId(root, row.target) }
    case 'purge': return { kind: row.kind, expected, trashId: UserDocTrashId(uuid(row.trashId)) }
    case 'move': return { kind: row.kind, expected, target: documentId(root, row.target) }
    case 'relocate': return { kind: row.kind, expected, target: documentId(root, row.target) }
    case 'remove': return { kind: row.kind, expected }
    case 'observe': return { kind: row.kind, expected, ...metadata(row) }
    case 'missing': return { kind: row.kind, expected }
    default: throw new Error('Invalid document identity operation.')
  }
}

function parseChange(root: string, value: unknown): DocumentIdentityChange {
  const row = object(value), change = parseAction(root, value)
  if (row.actor === undefined) return change
  if (typeof row.actor !== 'string' || row.actor.length === 0 || row.actor.length > 256 || /[\u0000-\u001f\u007f]/u.test(row.actor)) {
    throw new Error('Invalid document mutation actor.')
  }
  return { ...change, actor: UserDocUploadOwnerId(row.actor) }
}

/** Metadata owner for a dedicated SQLite database; its provider owns the connection and filesystem lock. */
export class DocumentIdentityStore {
  private readonly projection: DocumentProjectionJournal
  private schemaVersion: number = DOCUMENT_IDENTITY_SCHEMA_VERSION
  /** Durable metadata-domain id; a trash manifest cannot silently attach to another database. */
  readonly rootId: UserDocRootId
  /**
   * Initialize or verify the dedicated database without adopting another SQLite domain.
   * @param root - document root used to validate persisted relative paths.
   * @param database - connection owned and eventually closed by the document provider.
   * @param access - write mode migrates supported earlier schemas; read mode verifies them without changing bytes.
   */
  constructor(private readonly root: string, private readonly database: DatabaseSync, access: 'read' | 'write' = 'write') {
    const version = database.prepare('PRAGMA user_version').get()?.user_version
    const application = database.prepare('PRAGMA application_id').get()?.application_id
    if (version === 0 && application !== 0
      || version !== 0 && version !== 2 && version !== 3 && version !== DOCUMENT_IDENTITY_SCHEMA_VERSION
      || version !== 0 && application !== APPLICATION_ID) throw new Error('Unsupported document identity database version.')
    if (version === 0 && access === 'read') throw new Error('An uninitialized document identity database cannot be read.')
    if (version === 2 || version === 3) this.schemaVersion = version
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    if (version === 0 && tables.length !== 0) throw new Error('Refusing to adopt a nonempty document identity database.')
    database.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF')
    if (version === 0) this.transaction(() => {
      database.exec(`CREATE TABLE IF NOT EXISTS document_identities (
        incarnation_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK(revision>0),
        doc_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','trash','purged','missing')),
        record TEXT NOT NULL CHECK(json_valid(record))
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS document_identity_active_path ON document_identities(doc_id) WHERE state='active';
      CREATE TABLE IF NOT EXISTS document_trash_actions (
        trash_id TEXT PRIMARY KEY, incarnation_id TEXT NOT NULL REFERENCES document_identities(incarnation_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS document_identity_sequence (slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS document_identity_root (slot INTEGER PRIMARY KEY CHECK(slot=1), root_id TEXT NOT NULL);
      INSERT INTO document_identity_sequence(slot,sequence) VALUES(1,0);
      CREATE TABLE IF NOT EXISTS document_identity_pending (
        slot INTEGER PRIMARY KEY CHECK(slot=1), sequence INTEGER NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('prepared','retained','committed')),
        entries TEXT NOT NULL CHECK(json_valid(entries)),
        directory_move TEXT CHECK(directory_move IS NULL OR json_valid(directory_move))
      ) STRICT;
      CREATE TABLE document_identity_storage (
        slot INTEGER PRIMARY KEY CHECK(slot=1), documents_device TEXT NOT NULL, documents_inode TEXT NOT NULL,
        files_device TEXT NOT NULL, files_inode TEXT NOT NULL, documents_volume TEXT, files_volume TEXT,
        legacy_phase TEXT NOT NULL CHECK(legacy_phase IN ('pending','prepared','complete'))
      ) STRICT;`)
      database.prepare('INSERT INTO document_identity_root(slot,root_id) VALUES(1,?)').run(randomUUID())
      database.exec(DOCUMENT_PROJECTION_SCHEMA)
      database.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${DOCUMENT_IDENTITY_SCHEMA_VERSION}`)
    })
    this.rootId = UserDocRootId(uuid(database.prepare('SELECT root_id FROM document_identity_root WHERE slot=1').get()?.root_id))
    this.projection = new DocumentProjectionJournal(database, this.rootId, value => parseRecord(root, value))
    database.prepare('SELECT trash_id,incarnation_id FROM document_trash_actions LIMIT 0').all()
    count(database.prepare('SELECT sequence FROM document_identity_sequence WHERE slot=1').get()?.sequence)
    this.pending()
    this.list()
    if ((version === 2 || version === 3) && access === 'write') {
      this.transaction(() => {
        const pending = this.pending()
        if (version === 2 && pending?.directoryMove !== undefined) {
          this.database.prepare('UPDATE document_identity_pending SET directory_move=? WHERE slot=1')
            .run(JSON.stringify(pending.directoryMove))
        }
        this.database.exec(`ALTER TABLE document_identity_storage ADD COLUMN documents_volume TEXT;
          ALTER TABLE document_identity_storage ADD COLUMN files_volume TEXT`)
        this.database.exec(`PRAGMA user_version=${DOCUMENT_IDENTITY_SCHEMA_VERSION}`)
      })
      this.schemaVersion = DOCUMENT_IDENTITY_SCHEMA_VERSION
    }
  }

  /**
   * Prove a schema 2 or 3 store's original directories before its writable migration.
   * @param binding - current physical roots; legacy device numbers cannot be inferred from UUIDs acquired later.
   * @returns after original witnesses agree or a fresh domain has no committed history; no database bytes change.
   */
  verifyLegacyStorage(binding: DocumentStorageBinding): void {
    const row = this.database.prepare('SELECT * FROM document_identity_storage WHERE slot=1').get()
    if (row === undefined) {
      if (this.database.prepare('SELECT sequence FROM document_identity_sequence WHERE slot=1').get()?.sequence === 0) return
      throw new DocumentIdentityConflict('Existing document history cannot acquire an unverified storage binding.')
    }
    if (!sameFile(fileObject({ device: row.documents_device, inode: row.documents_inode }), binding.documents)
      || !sameFile(fileObject({ device: row.files_device, inode: row.files_inode }), binding.files)) {
      throw new DocumentIdentityConflict('Document storage binding changed; a copied root requires verified restore.')
    }
  }

  /**
   * Bind a fresh metadata domain to its public and retained-object directories.
   * @param binding - current kernel identities and descriptor-derived persistent filesystem UUIDs.
   * @returns after a fresh binding or verified remount commits; legacy witnesses require unchanged device numbers before acquiring UUIDs.
   */
  bindStorage(binding: DocumentStorageBinding): void {
    this.bindStorageInside(binding, false)
  }

  /**
   * Acquire persistent volume evidence after the offline backup verifier proves the original storage and retained files.
   * @param binding - descriptor-derived UUIDs and unchanged original directory inodes; every writer must remain stopped.
   * @returns after device normalization and UUID acquisition commit together; known UUIDs may never change.
   */
  recoverMount(binding: DocumentStorageBinding): void {
    if (binding.documents.volume === undefined || binding.files.volume === undefined) {
      throw new DocumentIdentityConflict('Mount recovery requires persistent filesystem UUIDs.')
    }
    this.bindStorageInside(binding, true)
  }

  private bindStorageInside(binding: DocumentStorageBinding, recovered: boolean): void {
    this.transaction(() => {
      const documentsVolume = binding.documents.volume ?? null, filesVolume = binding.files.volume ?? null
      const row = this.database.prepare('SELECT * FROM document_identity_storage WHERE slot=1').get()
      if (row === undefined) {
        if (this.database.prepare('SELECT sequence FROM document_identity_sequence WHERE slot=1').get()?.sequence !== 0) {
          throw new DocumentIdentityConflict('Existing document history cannot acquire an unverified storage binding.')
        }
        this.database.prepare(`INSERT INTO document_identity_storage
          (slot,documents_device,documents_inode,files_device,files_inode,documents_volume,files_volume,legacy_phase)
          VALUES(1,?,?,?,?,?,?,'pending')`)
          .run(binding.documents.device, binding.documents.inode, binding.files.device, binding.files.inode,
            documentsVolume, filesVolume)
        return
      }
      const recorded = (prefix: 'documents' | 'files') => ({
        ...fileObject({ device: row[`${prefix}_device`], inode: row[`${prefix}_inode`] }),
        ...row[`${prefix}_volume`] === null ? {} : { volume: uuid(row[`${prefix}_volume`]) },
      })
      const documents = recorded('documents'), files = recorded('files')
      const matches = (before: typeof documents, current: DocumentStorageBinding['documents']) => before.inode === current.inode
        && (before.volume === undefined ? recovered || before.device === current.device : before.volume === current.volume)
      if (!matches(documents, binding.documents) || !matches(files, binding.files)) {
        throw new DocumentIdentityConflict('Document storage binding changed; a copied root requires verified restore.')
      }
      if (documents.device === binding.documents.device && files.device === binding.files.device
        && documents.volume === binding.documents.volume && files.volume === binding.files.volume) return
      if (documents.device !== binding.documents.device) this.rebindDevice(documents.device, binding.documents.device)
      this.database.prepare('UPDATE document_identity_storage SET documents_device=?,files_device=?,documents_volume=?,files_volume=? WHERE slot=1')
        .run(binding.documents.device, binding.files.device, documentsVolume, filesVolume)
    })
  }

  private rebindDevice(before: string, after: string): void {
    const pending = this.pending()
    const file = (value: DocumentFileObjectId) => value.device === before ? { ...value, device: after } : value
    const record = (value: DocumentIdentityRecord) => ({ ...value, file: file(value.file) })
    this.database.prepare(`UPDATE document_identities SET record=json_set(record,'$.file.device',?)
      WHERE json_extract(record,'$.file.device')=?`).run(after, before)
    this.database.prepare(`UPDATE document_projection_changes SET document=json_set(document,'$.file.device',?)
      WHERE json_extract(document,'$.file.device')=?`).run(after, before)
    if (pending !== undefined) {
      const entries = pending.entries.map(entry => ({ ...entry,
        file: entry.file === null ? null : file(entry.file), result: record(entry.result),
      }))
      const move = pending.directoryMove
      const directory = move === undefined ? null : { ...move,
        marker: file(move.marker), source: move.source === null ? null : file(move.source),
      }
      this.database.prepare('UPDATE document_identity_pending SET entries=?,directory_move=? WHERE slot=1')
        .run(JSON.stringify(entries), directory === null ? null : JSON.stringify(directory))
    }
  }

  /**
   * Read the private legacy-import checkpoint.
   * @returns the recorded phase; public legacy manifests cannot supply this evidence.
   */
  legacyImportPhase(): 'pending' | 'prepared' | 'complete' {
    const phase = this.database.prepare('SELECT legacy_phase FROM document_identity_storage WHERE slot=1').get()?.legacy_phase
    if (phase !== 'pending' && phase !== 'prepared' && phase !== 'complete') {
      throw new DocumentIdentityConflict('The private document import checkpoint is unavailable.')
    }
    return phase
  }

  /** Record that every legacy payload has been committed to private storage. */
  prepareLegacyImport(): void {
    this.legacyImportPhase()
    this.database.prepare("UPDATE document_identity_storage SET legacy_phase='prepared' WHERE slot=1 AND legacy_phase='pending'").run()
  }

  /** Record the completed public legacy-format retirement after private import. */
  completeLegacyImport(): void {
    if (this.legacyImportPhase() === 'pending') throw new DocumentIdentityConflict('Legacy import has not retained its payloads.')
    this.database.prepare("UPDATE document_identity_storage SET legacy_phase='complete' WHERE slot=1 AND legacy_phase='prepared'").run()
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      try { this.database.exec('ROLLBACK') } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Document identity transaction and rollback failed.')
      }
      throw error
    }
  }

  /**
   * Read an incarnation, including retained missing and purged records.
   * @param id - durable document identity.
   * @returns its current metadata, or undefined before its first committed publication.
   */
  get(id: UserDocIncarnationId): DocumentIdentityRecord | undefined {
    const row = this.database.prepare('SELECT * FROM document_identities WHERE incarnation_id=?').get(id)
    return row === undefined ? undefined : this.readRow(row)
  }

  private readRow(row: Record<string, unknown>): DocumentIdentityRecord {
    if (typeof row.record !== 'string') throw new Error('Invalid document identity encoding.')
    const record = parseRecord(this.root, JSON.parse(row.record))
    if (record.incarnationId !== row.incarnation_id || record.revision !== row.revision
      || record.docId !== row.doc_id || record.state !== row.state) throw new Error('Inconsistent document identity columns.')
    return record
  }

  /**
   * Read the active incarnation at a path.
   * @param docId - relative file address.
   * @returns active metadata, never a retained trash or purge from the same path.
   */
  active(docId: UserDocId): DocumentIdentityRecord | undefined {
    const row = this.database.prepare("SELECT * FROM document_identities WHERE doc_id=? AND state='active'").get(docId)
    return row === undefined ? undefined : this.readRow(row)
  }

  /**
   * Read every committed incarnation for catalog reconciliation.
   * @returns detached records ordered by durable identity.
   */
  list(): DocumentIdentityRecord[] {
    return this.database.prepare('SELECT * FROM document_identities ORDER BY incarnation_id').all().map(row => this.readRow(row))
  }

  /**
   * Read committed catalog changes without deriving deletion from an incomplete file listing.
   * @param after - receiving catalog's durable position.
   * @param options - resolved item and complete-response byte bounds.
   * @returns a linked batch retained until its receiver acknowledges successful commit.
   */
  projectionChanges(after: DocumentProjectionCursor, options: DocumentProjectionReadOptions): DocumentProjectionBatch {
    return this.projection.read(after, options)
  }

  /**
   * Inspect outstanding catalog delivery without changing the committed cursor.
   * @returns whether committed changes still require receiver acknowledgement.
   */
  hasPendingProjection(): boolean { return this.projection.hasPending() }

  /**
   * Release a prefix only after its receiving catalog commits.
   * @param through - known committed receiver position.
   * @returns after prefix deletion and monotonic acknowledgement commit together.
   */
  acknowledgeProjection(through: DocumentProjectionCursor): void {
    this.transaction(() => { this.projection.acknowledge(through) })
  }

  /**
   * Read the single prepared or committed change whose physical work must settle first.
   * @returns the recovery record, or undefined when no mutation owns the root.
   */
  pending(): PendingDocumentIdentityChange | undefined {
    const row = this.database.prepare('SELECT * FROM document_identity_pending WHERE slot=1').get()
    if (row === undefined) return undefined
    if (row.phase !== 'prepared' && row.phase !== 'retained' && row.phase !== 'committed' || typeof row.entries !== 'string') {
      throw new Error('Invalid pending document identity change.')
    }
    const sequence = count(row.sequence, 1)
    if (this.database.prepare('SELECT sequence FROM document_identity_sequence WHERE slot=1').get()?.sequence !== sequence) {
      throw new Error('Inconsistent document mutation sequence.')
    }
    const rawEntries: unknown = JSON.parse(row.entries)
    if (!Array.isArray(rawEntries)) throw new Error('Invalid pending document identity batch.')
    const entries = rawEntries.map((value) => {
      const item = object(value)
      return { change: parseChange(this.root, item.change), file: item.file === null ? null : fileObject(item.file),
        result: parseRecord(this.root, item.result) }
    })
    const identities = new Set<UserDocIncarnationId>()
    for (const { change, file, result } of entries) {
      const creating = change.kind === 'publish' || change.kind === 'adopt'
      const identity = creating ? change.document : change.expected
      const target = change.kind === 'move' || change.kind === 'relocate' || change.kind === 'restore' ? change.target : identity.docId
      if (result.incarnationId !== identity.incarnationId || result.revision !== (creating ? 1 : change.expected.revision + 1)
        || result.docId !== target) throw new Error('Inconsistent document mutation identity.')
      if (identities.has(result.incarnationId)) throw new Error('Duplicate pending document incarnation.')
      identities.add(result.incarnationId)
      if (row.phase !== 'committed' && JSON.stringify(this.resultFor(change, file)) !== JSON.stringify(result)) {
        throw new Error('Inconsistent pending document change.')
      }
      if (row.phase === 'committed' && JSON.stringify(this.get(result.incarnationId)) !== JSON.stringify(result)) {
        throw new Error('Inconsistent committed document change.')
      }
    }
    let directoryMove: PendingDocumentIdentityChange['directoryMove']
    if (row.directory_move !== null) {
      if (typeof row.directory_move !== 'string') throw new Error('Invalid directory mutation.')
      const move = object(JSON.parse(row.directory_move))
      if (typeof move.from !== 'string' || typeof move.to !== 'string') throw new Error('Invalid directory mutation paths.')
      const from = move.from, to = move.to
      pathForDirectoryId(this.root, from); pathForDirectoryId(this.root, to)
      if (from === '' || to === '' || to === from || to.startsWith(`${from}/`)) throw new Error('Invalid directory mutation ancestry.')
      if (this.schemaVersion === 2 ? move.captured !== undefined : typeof move.captured !== 'boolean') {
        throw new Error('Invalid directory capture state.')
      }
      const captured = this.schemaVersion === 2 ? row.phase === 'committed' : move.captured === true
      if (row.phase === 'prepared' && captured) throw new Error('An unused directory intent cannot retain a private capture.')
      const source = this.schemaVersion === 2 || move.source === null ? null : fileObject(move.source)
      if (this.schemaVersion === 2 && move.source !== undefined) throw new Error('Invalid legacy directory source evidence.')
      directoryMove = { from: from as UserDocDirectoryId, to: to as UserDocDirectoryId, marker: fileObject(move.marker), source, captured }
      if (row.phase !== 'committed') {
        const current = this.list().filter(record => record.state === 'active' && record.docId.startsWith(`${from}/`))
        if (current.length !== entries.length || current.some(record => !identities.has(record.incarnationId))) {
          throw new Error('Inconsistent directory mutation membership.')
        }
      }
      for (const { change } of entries) {
        if (change.kind !== 'move' || !change.expected.docId.startsWith(`${from}/`)
          || change.target !== `${to}/${change.expected.docId.slice(from.length + 1)}`) {
          throw new Error('Inconsistent directory mutation contents.')
        }
      }
    }
    if (entries.length === 0 && directoryMove === undefined) throw new Error('Empty document mutation.')
    return { sequence, phase: row.phase, entries, ...directoryMove === undefined ? {} : { directoryMove } }
  }

  private resultFor(
    change: DocumentIdentityChange, evidence: DocumentFileObjectId | null, vacated?: ReadonlySet<UserDocIncarnationId>,
  ): DocumentIdentityRecord {
    if (change.kind === 'publish' || change.kind === 'adopt') {
      if (this.get(change.document.incarnationId) !== undefined) stateConflict('This document incarnation has already been published.')
      const trash = change.kind === 'adopt' ? change.trash : undefined
      if (trash === undefined && this.active(change.document.docId) !== undefined) {
        throw new UserDocError('Document target is occupied by another incarnation.', DOCUMENT_TARGET_CONFLICT_CODE)
      }
      if (trash !== undefined && this.database.prepare('SELECT trash_id FROM document_trash_actions WHERE trash_id=?').get(trash.trashId) !== undefined) {
        throw new UserDocError('The trash action identity has already been used.', DOCUMENT_TRASH_CONFLICT_CODE)
      }
      if (evidence === null) stateConflict('Publication requires a retained source file object.')
      return parseRecord(this.root, { ...change.document, revision: 1, state: trash === undefined ? 'active' : 'trash',
        file: evidence, ...trash === undefined ? {} : { trash } })
    }
    const current = this.get(change.expected.incarnationId)
    if (current === undefined || current.revision !== change.expected.revision || current.docId !== change.expected.docId) {
      stateConflict('The document changed after this operation was authorized.')
    }
    if (current.revision === Number.MAX_SAFE_INTEGER) stateConflict('The document revision cannot advance.')
    if (change.kind === 'missing') {
      if (evidence !== null) stateConflict('A missing document cannot retain a current source file.')
    } else if (change.kind !== 'purge' && evidence === null) {
      stateConflict('The document mutation requires its source file object.')
    }
    if (evidence !== null && !sameFile(evidence, current.file)) {
      stateConflict('The selected file object changed after authorization.')
    }
    const next = { ...current, revision: current.revision + 1 }
    if (change.kind === 'restore' || change.kind === 'purge') {
      if (current.state !== 'trash' || current.trash?.trashId !== change.trashId) {
        throw new UserDocError('The selected trash action is no longer recoverable.', DOCUMENT_TRASH_CONFLICT_CODE)
      }
      if (change.kind === 'purge') {
        const { trash: _trash, ...purged } = next
        return { ...purged, state: 'purged' }
      }
      const occupied = this.active(change.target)
      if (occupied !== undefined) throw new UserDocError('Restore target is occupied.', DOCUMENT_TARGET_CONFLICT_CODE)
      const { trash: _trash, ...restored } = next
      return { ...restored, docId: change.target, mediaType: mediaTypeFor(change.target), state: 'active' }
    }
    if (current.state !== 'active') stateConflict('The selected document incarnation is not active.')
    switch (change.kind) {
      case 'trash':
        if (this.database.prepare('SELECT trash_id FROM document_trash_actions WHERE trash_id=?').get(change.trashId) !== undefined) {
          throw new UserDocError('The trash action identity has already been used.', DOCUMENT_TRASH_CONFLICT_CODE)
        }
        return { ...next, state: 'trash', trash: { trashId: change.trashId, docId: current.docId,
          trashedAt: change.trashedAt, purgeAfter: change.purgeAfter } }
      case 'move': case 'relocate': {
        const occupied = this.active(change.target)
        if (occupied !== undefined && occupied.incarnationId !== current.incarnationId && vacated?.has(occupied.incarnationId) !== true) {
          throw new UserDocError('Move target is occupied.', DOCUMENT_TARGET_CONFLICT_CODE)
        }
        return { ...next, docId: change.target, mediaType: mediaTypeFor(change.target) }
      }
      case 'observe': {
        if (evidence === null) stateConflict('Observation requires its current source file.')
        return { ...next, file: evidence, bytes: change.bytes, mediaType: change.mediaType, modifiedAt: change.modifiedAt }
      }
      case 'missing': return { ...next, state: 'missing' }
      case 'remove': return { ...next, state: 'purged' }
      default: return assertNever(change)
    }
  }

  /**
   * Persist a lifecycle intent before touching ordinary file bytes.
   * @param change - exact incarnation/revision and intended physical operation.
   * @param evidence - identity pinned by the opened source; null only for an absent file.
   * @returns the prepared change to execute or recover while holding the provider's root lock.
   */
  prepare(change: DocumentIdentityChange, evidence: DocumentFileObjectId | null): PendingDocumentIdentityChange {
    return this.prepareChanges([{ change, file: evidence }])
  }

  /**
   * Reserve a directory rename only for the exact set of authorized document incarnations.
   * @param from - existing directory; the root cannot be renamed.
   * @param to - available destination directory outside the source subtree.
   * @param expected - every active document authorized below the source directory.
   * @param marker - opened private marker that will identify the moved directory during recovery.
   * @param source - kernel identity of the selected source directory.
   * @param actor - original authenticated initiator; absent records unattributed work.
   * @returns one recovery record that commits all new paths together.
   */
  prepareDirectoryMove(
    from: UserDocDirectoryId, to: UserDocDirectoryId, expected: readonly ExpectedDocumentIdentity[], marker: DocumentFileObjectId,
    source: DocumentFileObjectId, actor?: UserDocUploadOwnerId,
  ): PendingDocumentIdentityChange {
    pathForDirectoryId(this.root, from); pathForDirectoryId(this.root, to)
    if (from === '' || to === '' || from === to || to.startsWith(`${from}/`)) stateConflict('Invalid directory move.')
    return this.transaction(() => {
      const current = this.list().filter(record => record.state === 'active' && record.docId.startsWith(`${from}/`))
      const admitted = new Map(expected.map(record => [record.incarnationId, record]))
      if (admitted.size !== expected.length || admitted.size !== current.length
        || current.some((record) => { const prior = admitted.get(record.incarnationId)
          return prior === undefined || prior.revision !== record.revision || prior.docId !== record.docId })) {
        stateConflict('The directory contents changed after authorization.')
      }
      if (this.list().some(record => record.state === 'active' && record.docId.startsWith(`${to}/`))) {
        throw new UserDocError('Directory target already contains active documents.', DOCUMENT_TARGET_CONFLICT_CODE)
      }
      return this.prepareInside(current.map(record => ({ file: record.file, change: { kind: 'move' as const, expected: record,
        target: UserDocId(`${to}/${record.docId.slice(from.length + 1)}`), ...actor === undefined ? {} : { actor } } })), { from, to, marker, source, captured: false })
    })
  }

  private prepareChanges(
    changes: readonly { change: DocumentIdentityChange; file: DocumentFileObjectId | null }[],
  ): PendingDocumentIdentityChange {
    return this.transaction(() => this.prepareInside(changes))
  }

  private prepareInside(
    changes: readonly { change: DocumentIdentityChange; file: DocumentFileObjectId | null }[],
    directoryMove?: PendingDocumentIdentityChange['directoryMove'],
  ): PendingDocumentIdentityChange {
    if (this.pending() !== undefined) stateConflict('A document mutation is still awaiting recovery.')
    const entries = changes.map(({ change, file }) => ({ change, file, result: this.resultFor(change, file) }))
    const sequence = this.advanceSequence()
    this.database.prepare("INSERT INTO document_identity_pending(slot,sequence,phase,entries,directory_move) VALUES(1,?,'prepared',?,?)")
      .run(sequence, JSON.stringify(entries), directoryMove === undefined ? null : JSON.stringify(directoryMove))
    return { sequence, phase: 'prepared', entries, ...directoryMove === undefined ? {} : { directoryMove } }
  }

  private advanceSequence(): number {
    const previous = this.database.prepare('SELECT sequence FROM document_identity_sequence WHERE slot=1').get()?.sequence
    const sequence = count(previous) + 1
    if (!Number.isSafeInteger(sequence)) stateConflict('The document mutation sequence cannot advance.')
    this.database.prepare('UPDATE document_identity_sequence SET sequence=? WHERE slot=1').run(sequence)
    return sequence
  }

  private writeRecord(record: DocumentIdentityRecord): void {
    this.database.prepare(`INSERT INTO document_identities(incarnation_id,revision,doc_id,state,record) VALUES(?,?,?,?,?)
      ON CONFLICT(incarnation_id) DO UPDATE SET revision=excluded.revision,doc_id=excluded.doc_id,state=excluded.state,record=excluded.record`)
      .run(record.incarnationId, record.revision, record.docId, record.state, JSON.stringify(record))
  }

  /**
   * Commit already-observed external address changes and their deliveries atomically, including address exchanges.
   * @param relocations - unique active incarnations and destinations verified by the root-lock owner against retained objects.
   * @returns the committed versions; no file bytes, pending physical work or original creators change.
   */
  relocateObserved(relocations: readonly ObservedDocumentRelocation[]): readonly DocumentIdentityRecord[] {
    return this.transaction(() => {
      if (this.pending() !== undefined) stateConflict('A document mutation is still awaiting recovery.')
      if (relocations.length === 0) return []
      const vacated = new Set(relocations.map(change => change.expected.incarnationId))
      if (vacated.size !== relocations.length || new Set(relocations.map(change => change.target)).size !== relocations.length) {
        stateConflict('Observed document moves must have unique sources and destinations.')
      }
      const entries = relocations.map(({ expected, target, file }) => {
        const change = { kind: 'relocate' as const, expected, target }
        return { change, result: this.resultFor(change, file, vacated) }
      })
      const sequence = this.advanceSequence()
      // Releasing these addresses inside the transaction permits exchanges under the unique active-path index.
      for (const { result } of entries) {
        this.database.prepare("UPDATE document_identities SET state='missing' WHERE incarnation_id=?").run(result.incarnationId)
      }
      for (const { result } of entries) this.writeRecord(result)
      this.projection.append(sequence, entries)
      return entries.map(entry => entry.result)
    })
  }

  private selected(expected: Pick<PendingDocumentIdentityChange, 'sequence'>): PendingDocumentIdentityChange {
    const pending = this.pending()
    if (pending === undefined || pending.sequence !== expected.sequence) {
      stateConflict('The document mutation has already settled or changed.')
    }
    return pending
  }

  /**
   * Record that every source anchor is retained before ordinary paths may change.
   * @param expected - sequence whose source evidence the executor has acquired.
   * @returns the retained recovery record; repeated acquisition is harmless.
   */
  retain(expected: Pick<PendingDocumentIdentityChange, 'sequence'>): PendingDocumentIdentityChange {
    return this.transaction(() => {
      const pending = this.selected(expected)
      if (pending.phase === 'committed') stateConflict('The document mutation has already committed.')
      this.database.prepare("UPDATE document_identity_pending SET phase='retained' WHERE slot=1").run()
      return { ...pending, phase: 'retained' }
    })
  }

  /**
   * Record a verified private capture before publication, or a verified legacy publication before metadata commit.
   * @param expected - retained directory reservation whose private inventory or legacy destination was verified.
   * @param source - verified directory object, also acquired for migrated intents without source evidence.
   * @returns the durable capture state; repeating the transition is harmless.
   */
  captureDirectory(expected: Pick<PendingDocumentIdentityChange, 'sequence'>, source: DocumentFileObjectId): PendingDocumentIdentityChange {
    return this.transaction(() => {
      const pending = this.selected(expected)
      if (pending.phase !== 'retained' || pending.directoryMove === undefined) {
        stateConflict('Only a retained directory move can capture a private source.')
      }
      if (pending.directoryMove.source !== null && !sameFile(pending.directoryMove.source, source)) {
        stateConflict('The selected directory object changed during capture.')
      }
      const directoryMove = { ...pending.directoryMove, source, captured: true }
      this.database.prepare('UPDATE document_identity_pending SET directory_move=? WHERE slot=1').run(JSON.stringify(directoryMove))
      return { ...pending, directoryMove }
    })
  }

  /**
   * Cancel a retained directory intent whose executor proves the original source is restored or was never captured.
   * The prepared phase retains cleanup evidence across interruption before abandonment.
   * @param expected - retained directory sequence whose executor proved cancellation safe.
   * @returns the prepared cancellation record; file and committed intents are refused.
   */
  cancelDirectory(expected: Pick<PendingDocumentIdentityChange, 'sequence'>): PendingDocumentIdentityChange {
    return this.transaction(() => {
      const pending = this.selected(expected)
      if (pending.phase !== 'retained' || pending.directoryMove === undefined) {
        stateConflict('Only an uncommitted retained directory move can be cancelled.')
      }
      const directoryMove = { ...pending.directoryMove, captured: false }
      this.database.prepare("UPDATE document_identity_pending SET phase='prepared',directory_move=? WHERE slot=1")
        .run(JSON.stringify(directoryMove))
      return { ...pending, phase: 'prepared', directoryMove }
    })
  }

  /**
   * Commit metadata after the prepared physical operation succeeds; recovery may repeat this step.
   * @param expected - durable sequence of the retained operation.
   * @returns its committed records; no later mutation is admitted before finish.
   */
  commit(expected: Pick<PendingDocumentIdentityChange, 'sequence'>): readonly DocumentIdentityRecord[] {
    return this.transaction(() => {
      const pending = this.selected(expected)
      if (pending.phase === 'committed') return pending.entries.map(entry => entry.result)
      if (pending.phase !== 'retained') stateConflict('The document mutation has no retained file evidence.')
      if (pending.directoryMove !== undefined && !pending.directoryMove.captured) stateConflict('The directory source has no verified private capture.')
      for (const { result: record, change } of pending.entries) {
        this.writeRecord(record)
        const trash = change.kind === 'trash' ? change : change.kind === 'adopt' ? change.trash : undefined
        if (trash !== undefined) {
          this.database.prepare('INSERT INTO document_trash_actions(trash_id,incarnation_id) VALUES(?,?)')
            .run(trash.trashId, record.incarnationId)
        }
      }
      this.projection.append(pending.sequence, pending.entries)
      this.database.prepare("UPDATE document_identity_pending SET phase='committed' WHERE slot=1").run()
      return pending.entries.map(entry => entry.result)
    })
  }

  /**
   * Abandon a prepared change only after its executor proves no physical mutation remains.
   * @param expected - durable sequence of the retained operation.
   * @returns after the uncommitted recovery record is removed.
   */
  abandon(expected: Pick<PendingDocumentIdentityChange, 'sequence'>): void {
    this.transaction(() => {
      if (this.selected(expected).phase === 'committed') stateConflict('Committed document work cannot be abandoned.')
      this.database.prepare('DELETE FROM document_identity_pending WHERE slot=1').run()
    })
  }

  /**
   * Release the mutation slot after committed physical cleanup has finished.
   * @param expected - durable sequence of the retained operation.
   * @returns after the recovery record is removed durably by SQLite.
   */
  finish(expected: Pick<PendingDocumentIdentityChange, 'sequence'>): void {
    this.transaction(() => {
      if (this.selected(expected).phase !== 'committed') stateConflict('Physical document work has not committed.')
      this.database.prepare('DELETE FROM document_identity_pending WHERE slot=1').run()
    })
  }
}
