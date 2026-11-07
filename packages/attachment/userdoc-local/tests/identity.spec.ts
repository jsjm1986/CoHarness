/** Real SQLite lifecycle records distinguish reused paths and survive process-owner restarts. */
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocTrashId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { DOCUMENT_IDENTITY_SCHEMA_VERSION, DocumentIdentityStore, type DocumentIdentityChange, type DocumentIdentityRecord, type NewDocumentIdentity } from '../src/identity.ts'

const FILE = Object.freeze({ device: '1', inode: '1' })

function fixture() {
  const db = new DatabaseSync(':memory:')
  onTestFinished(() => { db.close() })
  return { db, store: new DocumentIdentityStore('/documents', db) }
}
function document(path = 'report.txt', user = '1'): NewDocumentIdentity {
  return { incarnationId: UserDocIncarnationId(randomUUID()), docId: UserDocId(path), createdBy: UserDocUploadOwnerId(`user:${user}`),
    origin: 'upload', bytes: 5, mediaType: 'text/plain', modifiedAt: 1 }
}
function apply(store: DocumentIdentityStore, change: DocumentIdentityChange): DocumentIdentityRecord {
  const prepared = store.prepare(change, change.kind === 'missing' ? null : FILE)
  const [record] = store.commit(store.retain(prepared))
  store.finish(prepared)
  return record!
}
function publish(store: DocumentIdentityStore, input = document()) {
  return apply(store, { kind: 'publish', document: input, source: 'private/data.part' })
}
function trash(store: DocumentIdentityStore, expected: DocumentIdentityRecord) {
  return apply(store, { kind: 'trash', expected, trashId: UserDocTrashId(randomUUID()), trashedAt: 10, purgeAfter: 20 })
}

it('keeps two retained trash actions and a new active document at the same path', () => {
  const { store } = fixture()
  const first = trash(store, publish(store))
  const second = trash(store, publish(store, document('report.txt', '2')))
  const active = publish(store, document('report.txt', '3'))
  expect(new Set(store.list().map(record => record.incarnationId)).size).toBe(3)
  expect(store.active(UserDocId('report.txt'))).toEqual(active)
  expect(first.trash?.trashId).not.toBe(second.trash?.trashId)
  expect([first.createdBy, second.createdBy, active.createdBy]).toEqual(['user:1', 'user:2', 'user:3'])
})

it('retains a permanent purge while a fresh incarnation reuses its path', () => {
  const { store } = fixture()
  const old = trash(store, publish(store))
  const purged = apply(store, { kind: 'purge', expected: old, trashId: old.trash!.trashId })
  const replacement = publish(store, document('report.txt', '2'))
  expect(store.get(old.incarnationId)?.state).toBe('purged')
  expect(store.active(old.docId)?.incarnationId).toBe(replacement.incarnationId)
  expect(() => store.prepare({ kind: 'publish', document: { ...purged, origin: 'upload' }, source: 'private/data.part' }, FILE))
    .toThrow('already been published')
  expect(store.active(old.docId)?.createdBy).toBe('user:2')
})

it('refuses stale authorization and an earlier trash action after restore and retrash', () => {
  const { store } = fixture()
  const original = publish(store)
  const oldTrash = trash(store, original)
  const restored = apply(store, { kind: 'restore', expected: oldTrash, trashId: oldTrash.trash!.trashId, target: UserDocId('restored.txt') })
  const newTrash = trash(store, restored)
  expect(() => store.prepare({ kind: 'move', expected: original, target: UserDocId('other.txt') }, FILE)).toThrow('changed after')
  expect(() => store.prepare({ kind: 'purge', expected: newTrash, trashId: oldTrash.trash!.trashId }, FILE)).toThrow('no longer recoverable')
  expect(store.get(original.incarnationId)).toEqual(newTrash)
  expect(() => store.prepare({ kind: 'restore', expected: oldTrash, trashId: oldTrash.trash!.trashId, target: original.docId }, FILE))
    .toThrow('changed after')
})

it('preserves the creator across content edits and moves while advancing revisions', () => {
  const { store } = fixture()
  const original = publish(store)
  const edited = apply(store, { kind: 'observe', expected: original, bytes: 9, mediaType: 'application/json', modifiedAt: 2 })
  const moved = apply(store, { kind: 'move', expected: edited, target: UserDocId('folder/report.json') })
  expect(moved).toMatchObject({ incarnationId: original.incarnationId, createdBy: 'user:1', revision: 3, bytes: 9, docId: 'folder/report.json' })
  expect(store.active(original.docId)).toBeUndefined()
})

it('commits an observed address exchange and its linked deliveries in one transaction', () => {
  const { store } = fixture(), first = publish(store, document('first.txt', '1')), second = publish(store, document('second.txt', '2'))
  const result = store.relocateObserved([
    { expected: first, target: second.docId, file: FILE }, { expected: second, target: first.docId, file: FILE },
  ])
  expect(store.active(second.docId)).toEqual({ ...first, docId: second.docId, revision: 2 })
  expect(store.active(first.docId)).toEqual({ ...second, docId: first.docId, revision: 2 })
  expect(result.map(record => record.createdBy)).toEqual(['user:1', 'user:2'])
  const changes = store.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 100, maxBytes: 65536 }).changes.slice(-2)
  expect(changes.map(change => [change.action, change.cursor.ordinal, change.actor])).toEqual([
    ['relocate', 1, undefined], ['relocate', 2, undefined],
  ])
  expect(changes[0]?.cursor.sequence).toBe(changes[1]?.cursor.sequence)
  expect(store.pending()).toBeUndefined()
})

it('rolls an observed exchange back together with its sequence and partial delivery append', () => {
  const { store, db } = fixture(), first = publish(store, document('first.txt')), second = publish(store, document('second.txt', '2'))
  const before = store.list(), options = { limit: 100, maxBytes: 65536 }
  const projection = store.projectionChanges({ sequence: 0, ordinal: 0 }, options)
  db.exec(`CREATE TRIGGER refuse_second_relocation BEFORE INSERT ON document_projection_changes
    WHEN NEW.action='relocate' AND NEW.ordinal=2 BEGIN SELECT RAISE(ABORT,'delivery interrupted'); END`)
  const changes = [{ expected: first, target: second.docId, file: FILE }, { expected: second, target: first.docId, file: FILE }]
  expect(() => store.relocateObserved(changes)).toThrow('delivery interrupted')
  expect(store.list()).toEqual(before)
  expect(store.projectionChanges({ sequence: 0, ordinal: 0 }, options)).toEqual(projection)
  expect(db.prepare('SELECT sequence FROM document_identity_sequence WHERE slot=1').get()?.sequence).toBe(2)
  expect(store.pending()).toBeUndefined()
  db.exec('DROP TRIGGER refuse_second_relocation')
  expect(store.relocateObserved(changes)).toHaveLength(2)
  expect(store.projectionChanges(projection.head, options).head).toEqual({ sequence: 3, ordinal: 2 })
})

it('refuses stale, occupied and duplicate observed moves without releasing any current address', () => {
  const { store } = fixture(), first = publish(store, document('first.txt')), second = publish(store, document('second.txt', '2'))
  const before = store.list()
  expect(() => store.relocateObserved([{ expected: first, target: second.docId, file: FILE }])).toThrow('occupied')
  expect(() => store.relocateObserved([{ expected: { ...first, revision: 9 }, target: UserDocId('new.txt'), file: FILE }])).toThrow('changed after')
  const move = { expected: first, target: UserDocId('new.txt'), file: FILE }
  expect(() => store.relocateObserved([move, move])).toThrow('unique')
  expect(() => store.relocateObserved([move, { ...move, expected: second }])).toThrow('unique')
  const prepared = store.prepare({ kind: 'observe', expected: first, bytes: 5, mediaType: 'text/plain', modifiedAt: 2 }, FILE)
  expect(() => store.relocateObserved([move])).toThrow('awaiting recovery')
  store.abandon(prepared)
  expect(store.relocateObserved([])).toEqual([])
  expect(store.list()).toEqual(before)
})

it('does not consume another incarnation or reuse a consumed trash action', () => {
  const { store } = fixture()
  const first = trash(store, publish(store))
  const other = publish(store, document('other.txt'))
  expect(() => store.prepare({ kind: 'trash', expected: other, trashId: first.trash!.trashId, trashedAt: 10, purgeAfter: 20 }, FILE))
    .toThrow('already been used')
  expect(() => store.prepare({ kind: 'restore', expected: first, trashId: first.trash!.trashId, target: other.docId }, FILE)).toThrow('occupied')
  expect(store.pending()).toBeUndefined()
  expect(store.get(other.incarnationId)).toEqual(other)
})

it('blocks new changes until the physical work commits and cleanup finishes', () => {
  const { store } = fixture()
  const prepared = store.prepare({ kind: 'publish', document: document(), source: 'private/data.part' }, FILE)
  expect(store.active(prepared.entries[0]!.result.docId)).toBeUndefined()
  expect(() => { store.finish(prepared) }).toThrow('has not committed')
  expect(() => store.commit(prepared)).toThrow('no retained file evidence')
  expect(() => store.prepare({ kind: 'adopt', document: document('other.txt') }, FILE)).toThrow('awaiting recovery')
  const committed = store.commit(store.retain(prepared))
  expect(store.commit(prepared)).toEqual(committed)
  expect(() => { store.abandon(prepared) }).toThrow('cannot be abandoned')
  store.finish(prepared)
  expect(() => store.commit(store.retain(prepared))).toThrow('already settled')
})

it('abandons a proven uncommitted change without reserving its filename or identity', () => {
  const { store } = fixture()
  const input = document()
  const prepared = store.prepare({ kind: 'publish', document: input, source: 'private/data.part' }, FILE)
  expect(() => store.commit({ sequence: prepared.sequence + 1 })).toThrow('already settled')
  store.abandon(prepared)
  expect(publish(store, input).incarnationId).toBe(input.incarnationId)
})

it('adopts an unowned legacy file without inferring a creator from its metadata', () => {
  const { store } = fixture()
  const { createdBy: _creator, ...input } = document()
  const adopted = apply(store, { kind: 'adopt', document: { ...input, origin: 'legacy' } })
  expect(adopted.createdBy).toBeUndefined()
  const missing = apply(store, { kind: 'missing', expected: adopted })
  const replacement = publish(store, document(adopted.docId, '2'))
  expect(missing.state).toBe('missing')
  expect(replacement.incarnationId).not.toBe(adopted.incarnationId)
})

it('retains prepared and committed recovery records across connection restarts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-document-identity-'))
  const filename = join(root, 'metadata.sqlite')
  let db: DatabaseSync | undefined
  onTestFinished(async () => { db?.close(); await rm(root, { recursive: true, force: true }) })
  db = new DatabaseSync(filename)
  let store = new DocumentIdentityStore(root, db)
  const prepared = store.prepare({ kind: 'publish', document: document(), source: 'private/data.part' }, FILE)
  db.close(); db = undefined
  db = new DatabaseSync(filename); store = new DocumentIdentityStore(root, db)
  expect(store.pending()).toEqual(prepared)
  store.commit(store.retain(prepared))
  db.close(); db = undefined
  db = new DatabaseSync(filename); store = new DocumentIdentityStore(root, db)
  expect(store.pending()?.phase).toBe('committed')
  store.finish(prepared)
  expect(store.pending()).toBeUndefined()
  expect(store.get(prepared.entries[0]!.result.incarnationId)).toEqual(prepared.entries[0]!.result)
})

it.each(['version', 'application', 'nonempty'] as const)('refuses an unrelated or newer SQLite domain: %s', (mode) => {
  const db = new DatabaseSync(':memory:')
  onTestFinished(() => { db.close() })
  if (mode === 'version') db.exec(`PRAGMA user_version=${DOCUMENT_IDENTITY_SCHEMA_VERSION + 1}`)
  if (mode === 'application') db.exec('PRAGMA application_id=123')
  if (mode === 'nonempty') db.exec('CREATE TABLE other (id INTEGER)')
  expect(() => new DocumentIdentityStore('/documents', db)).toThrow()
})

it('rejects malformed durable records before any subsequent operation', () => {
  const { store, db } = fixture()
  const record = publish(store)
  db.prepare('UPDATE document_identities SET record=? WHERE incarnation_id=?').run(JSON.stringify({ ...record, revision: 0 }), record.incarnationId)
  expect(() => store.get(record.incarnationId)).toThrow('counter')
  expect(() => new DocumentIdentityStore('/documents', db)).toThrow('counter')
})


it('commits a complete directory rename and refuses an authorization snapshot missing a new file', () => {
  const { store } = fixture()
  const first = publish(store, document('folder/a.txt'))
  const second = publish(store, document('folder/nested/b.txt', '2'))
  expect(() => store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first], FILE, FILE))
    .toThrow('contents changed')
  const batch = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first, second], FILE, FILE)
  expect(store.active(first.docId)).toEqual(first)
  store.retain(batch)
  expect(() => store.commit(batch)).toThrow('no verified private capture')
  const moved = store.commit(store.captureDirectory(batch, FILE))
  expect(moved.map(record => record.docId).sort()).toEqual(['renamed/a.txt', 'renamed/nested/b.txt'])
  store.finish(batch)
  expect(store.active(first.docId)).toBeUndefined()
  expect(store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(store.active(UserDocId('renamed/nested/b.txt'))?.createdBy).toBe('user:2')
})

it('retains cancellation cleanup evidence and refuses committing a cancelled directory reservation', () => {
  const { store } = fixture(), first = publish(store, document('folder/a.txt'))
  const batch = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first], FILE, FILE)
  expect(() => store.cancelDirectory(batch)).toThrow('retained directory')
  const retained = store.retain(batch), cancelled = store.cancelDirectory(retained)
  expect(cancelled.phase).toBe('prepared')
  expect(store.pending()).toEqual(cancelled)
  expect(store.active(first.docId)).toEqual(first)
  expect(() => store.commit(cancelled)).toThrow('retained file evidence')
  store.abandon(cancelled)
  const next = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first], FILE, FILE)
  store.retain(next)
  expect(() => store.cancelDirectory(batch)).toThrow('already settled or changed')
  store.captureDirectory(next, FILE)
  store.commit(next)
  expect(() => store.cancelDirectory(next)).toThrow('retained directory')
  store.finish(next)
})

it('refuses directory cancellation for a retained file mutation', () => {
  const { store } = fixture(), first = publish(store)
  const pending = store.retain(store.prepare({ kind: 'move', expected: first, target: UserDocId('renamed.txt') }, FILE))
  expect(() => store.cancelDirectory(pending)).toThrow('retained directory')
  expect(store.pending()).toEqual(pending)
  store.commit(pending); store.finish(pending)
  expect(store.active(UserDocId('renamed.txt'))?.incarnationId).toBe(first.incarnationId)
})

it('requires the selected directory object and retained phase before recording capture', () => {
  const { store } = fixture(), first = publish(store, document('folder/a.txt'))
  const pending = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first], FILE, FILE)
  expect(() => store.captureDirectory(pending, FILE)).toThrow('retained directory')
  store.retain(pending)
  expect(() => store.captureDirectory(pending, { ...FILE, inode: '987' })).toThrow('object changed')
  expect(store.pending()?.directoryMove?.captured).toBe(false)
  const captured = store.captureDirectory(pending, FILE)
  expect(store.captureDirectory(captured, FILE)).toEqual(captured)
  expect(store.cancelDirectory(captured).directoryMove?.captured).toBe(false)
})

it.each(['prepared', 'retained', 'committed'] as const)('migrates a schema 2 directory journal in %s without changing identities or projection', (phase) => {
  const { store, db } = fixture(), first = publish(store, document('folder/a.txt'))
  const pending = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first], FILE, FILE)
  if (phase !== 'prepared') store.retain(pending)
  if (phase === 'committed') { store.captureDirectory(pending, FILE); store.commit(pending) }
  const legacy = { from: pending.directoryMove?.from, to: pending.directoryMove?.to, marker: FILE }
  db.prepare('UPDATE document_identity_pending SET directory_move=?').run(JSON.stringify(legacy))
  db.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
    ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=2`)
  const records = db.prepare('SELECT * FROM document_identities').all()
  const projection = db.prepare('SELECT * FROM document_projection_changes').all()
  const readOnly = new DocumentIdentityStore('/documents', db, 'read')
  const originalPending = readOnly.pending()
  expect(originalPending?.directoryMove).toEqual({ ...legacy, source: null, captured: phase === 'committed' })
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
  expect(db.prepare('SELECT directory_move FROM document_identity_pending').get()?.directory_move).toBe(JSON.stringify(legacy))
  const upgraded = new DocumentIdentityStore('/documents', db)
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(DOCUMENT_IDENTITY_SCHEMA_VERSION)
  expect(upgraded.rootId).toBe(store.rootId)
  expect(upgraded.pending()).toEqual(originalPending)
  expect(db.prepare('SELECT * FROM document_identities').all()).toEqual(records)
  expect(db.prepare('SELECT * FROM document_projection_changes').all()).toEqual(projection)
})

it('rolls back the schema version when a legacy directory journal migration fails', () => {
  const { store, db } = fixture()
  const pending = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [], FILE, FILE)
  const legacy = { from: pending.directoryMove?.from, to: pending.directoryMove?.to, marker: FILE }
  db.prepare('UPDATE document_identity_pending SET directory_move=?').run(JSON.stringify(legacy))
  db.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
    ALTER TABLE document_identity_storage DROP COLUMN files_volume;
    PRAGMA user_version=2; CREATE TRIGGER fail_directory_migration BEFORE UPDATE ON document_identity_pending
    BEGIN SELECT RAISE(ABORT,'Owned migration interruption'); END`)
  expect(() => new DocumentIdentityStore('/documents', db)).toThrow('Owned migration interruption')
  expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(2)
  expect(db.prepare('SELECT directory_move FROM document_identity_pending').get()?.directory_move).toBe(JSON.stringify(legacy))
  db.exec('DROP TRIGGER fail_directory_migration')
  expect(new DocumentIdentityStore('/documents', db).pending()?.directoryMove?.source).toBeNull()
})

it.each([{ captured: undefined }, { captured: 'yes' }, { captured: true }, { source: undefined }, { source: { device: '1', inode: '0' } }])(
  'rejects invalid schema 3 directory preparation: %j', (patch) => {
    const { store, db } = fixture()
    const pending = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [], FILE, FILE)
    db.prepare('UPDATE document_identity_pending SET directory_move=?').run(JSON.stringify({ ...pending.directoryMove, ...patch }))
    expect(() => new DocumentIdentityStore('/documents', db)).toThrow()
  },
)

it('does not let an abandoned operation token commit a later retry of the same incarnation', () => {
  const { store } = fixture()
  const change = { kind: 'publish' as const, document: document(), source: 'private/data.part' }
  const old = store.prepare(change, FILE)
  store.abandon(old)
  const current = store.prepare(change, FILE)
  expect(current.sequence).toBe(old.sequence + 1)
  expect(() => store.commit(old)).toThrow('already settled')
  store.commit(store.retain(current)); store.finish(current)
})


it('retains opaque creator keys used by non-Gateway upload servers', () => {
  const { store } = fixture()
  const record = publish(store, { ...document(), createdBy: UserDocUploadOwnerId('account:local-actor') })
  expect(store.get(record.incarnationId)?.createdBy).toBe('account:local-actor')
})

it.each([
  { origin: ['upload'] }, { state: ['active'] }, { bytes: -1 }, { mediaType: '' }, { modifiedAt: -1 },
  { createdBy: '' }, { createdBy: 'user:1\n' }, { incarnationId: 'wrong-id' }, { docId: '../outside' },
  { state: 'trash' }, { state: 'active', trash: { trashId: 'wrong-id' } },
])('refuses malformed committed metadata: %j', (patch) => {
  const { store, db } = fixture()
  const record = publish(store)
  db.prepare('UPDATE document_identities SET record=? WHERE incarnation_id=?').run(JSON.stringify({ ...record, ...patch }), record.incarnationId)
  expect(() => store.get(record.incarnationId)).toThrow()
  expect(() => new DocumentIdentityStore('/documents', db)).toThrow()
})

it.each(['identity', 'revision', 'path', 'state'] as const)('refuses inconsistent scalar columns: %s', (mode) => {
  const { store, db } = fixture()
  publish(store)
  const columns = { identity: 'incarnation_id', revision: 'revision', path: 'doc_id', state: 'state' } as const
  const values = { identity: randomUUID(), revision: 2, path: 'other.txt', state: 'missing' } as const
  db.prepare(`UPDATE document_identities SET ${columns[mode]}=?`).run(values[mode])
  expect(() => store.list()).toThrow('Inconsistent document identity columns')
})

it('leaves a prepared operation recoverable after SQLite rejects its metadata commit', () => {
  const { store, db } = fixture()
  const prepared = store.prepare({ kind: 'publish', document: document(), source: 'private/data.part' }, FILE)
  db.exec("CREATE TRIGGER reject_document BEFORE INSERT ON document_identities BEGIN SELECT RAISE(ABORT,'owned commit failure'); END")
  expect(() => store.commit(store.retain(prepared))).toThrow('owned commit failure')
  expect(store.pending()?.phase).toBe('retained')
  expect(store.list()).toEqual([])
  db.exec('DROP TRIGGER reject_document')
  store.commit(store.retain(prepared)); store.finish(prepared)
  expect(store.list()).toHaveLength(1)
})

it('preserves independent transaction and rollback failures', () => {
  const { store, db } = fixture()
  const original = publish(store)
  const execute = db.exec.bind(db), cleanup = new Error('Owned rollback failed')
  const spy = vi.spyOn(db, 'exec').mockImplementation((sql) => {
    if (sql === 'ROLLBACK') throw cleanup
    execute(sql)
  })
  try {
    expect(() => store.prepare({ kind: 'move', expected: { ...original, revision: 99 }, target: UserDocId('other.txt') }, FILE))
      .toThrow(expect.objectContaining({ errors: [expect.any(Error), cleanup] }))
  } finally { spy.mockRestore(); db.exec('ROLLBACK') }
  expect(store.get(original.incarnationId)).toEqual(original)
})

it('rejects stale operation sequences and inconsistent prepared or committed recovery records', () => {
  const { store, db } = fixture()
  const prepared = store.prepare({ kind: 'publish', document: document(), source: 'private/data.part' }, FILE)
  const original = JSON.stringify(prepared.entries)
  db.prepare('UPDATE document_identity_pending SET sequence=?').run(prepared.sequence + 1)
  expect(() => store.pending()).toThrow('mutation sequence')
  db.prepare('UPDATE document_identity_pending SET sequence=?').run(prepared.sequence)
  const changed = [{ ...prepared.entries[0], result: { ...prepared.entries[0]!.result, bytes: 99 } }]
  db.prepare('UPDATE document_identity_pending SET entries=?').run(JSON.stringify(changed))
  expect(() => store.pending()).toThrow('Inconsistent pending document change')
  db.prepare('UPDATE document_identity_pending SET entries=?').run(original)
  store.commit(store.retain(prepared))
  db.prepare('UPDATE document_identities SET record=?').run(JSON.stringify({ ...prepared.entries[0]!.result, bytes: 99 }))
  expect(() => store.pending()).toThrow('Inconsistent committed document change')
})

it('binds one private database to exact directory objects and retains the first binding on disagreement', () => {
  const f = fixture(), binding = { documents: { device: '1', inode: '10' }, files: { device: '1', inode: '20' } }
  f.store.bindStorage(binding)
  f.store.bindStorage(binding)
  expect(f.store.legacyImportPhase()).toBe('pending')
  const before = f.db.prepare('SELECT * FROM document_identity_storage').get()
  expect(() => { f.store.bindStorage({ ...binding, documents: { device: '1', inode: '11' } }) }).toThrow('binding changed')
  expect(() => { f.store.bindStorage({ ...binding, files: { device: '1', inode: '21' } }) }).toThrow('binding changed')
  expect(f.db.prepare('SELECT * FROM document_identity_storage').get()).toEqual(before)
})

it('refuses binding existing unbound history to a newly selected filesystem', () => {
  const f = fixture(), original = publish(f.store)
  expect(() => { f.store.bindStorage({ documents: FILE, files: FILE }) }).toThrow('unverified storage binding')
  expect(f.store.get(original.incarnationId)).toEqual(original)
})

it.each([2, 3])('verifies unbound schema %s before migration without adopting existing history', (schema) => {
  const f = fixture()
  f.db.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
    ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=${schema}`)
  const legacy = new DocumentIdentityStore('/documents', f.db, 'read')
  expect(() => { legacy.verifyLegacyStorage({ documents: FILE, files: FILE }) }).not.toThrow()
  const original = publish(legacy)
  expect(() => { legacy.verifyLegacyStorage({ documents: FILE, files: FILE }) }).toThrow('unverified storage binding')
  expect(legacy.get(original.incarnationId)).toEqual(original)
  expect(f.db.prepare('PRAGMA user_version').get()?.user_version).toBe(schema)
  expect(f.db.prepare('SELECT * FROM document_identity_storage').all()).toEqual([])
})

it('advances private legacy import only after payload preparation and keeps completion idempotent', () => {
  const f = fixture()
  expect(() => f.store.legacyImportPhase()).toThrow('unavailable')
  f.store.bindStorage({ documents: FILE, files: FILE })
  expect(() => { f.store.completeLegacyImport() }).toThrow('not retained')
  expect(f.store.legacyImportPhase()).toBe('pending')
  f.store.prepareLegacyImport()
  expect(f.store.legacyImportPhase()).toBe('prepared')
  f.store.completeLegacyImport()
  f.store.prepareLegacyImport()
  f.store.completeLegacyImport()
  expect(f.store.legacyImportPhase()).toBe('complete')
})

it('refuses a corrupted private import phase instead of trusting a public retirement marker', () => {
  const f = fixture()
  f.store.bindStorage({ documents: FILE, files: FILE })
  f.db.exec("PRAGMA ignore_check_constraints=ON; UPDATE document_identity_storage SET legacy_phase='invalid'")
  expect(() => f.store.legacyImportPhase()).toThrow('unavailable')
})

it('rolls back an interrupted storage binding without claiming its directories', () => {
  const f = fixture()
  f.db.exec(`CREATE TRIGGER fail_storage_binding BEFORE INSERT ON document_identity_storage
    BEGIN SELECT RAISE(ABORT,'storage binding interrupted'); END`)
  expect(() => { f.store.bindStorage({ documents: FILE, files: FILE }) }).toThrow('interrupted')
  expect(f.db.prepare('SELECT * FROM document_identity_storage').all()).toEqual([])
  f.db.exec('DROP TRIGGER fail_storage_binding')
  f.store.bindStorage({ documents: FILE, files: FILE })
  expect(f.store.legacyImportPhase()).toBe('pending')
})

it('refuses the earlier private schema before changing its stored root identifier', () => {
  const f = fixture(), rootId = f.store.rootId
  f.db.exec('PRAGMA user_version=1')
  expect(() => new DocumentIdentityStore('/documents', f.db)).toThrow('Unsupported')
  expect(f.db.prepare('SELECT root_id FROM document_identity_root').get()?.root_id).toBe(rootId)
})
