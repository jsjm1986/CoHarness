/** Persistent volume evidence admits a remounted original without adopting another filesystem or losing pending ownership. */
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, onTestFinished } from 'vitest'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { DocumentIdentityStore } from '../src/identity.ts'

const VOLUME = '11111111-2222-3333-4444-555555555555'
const original = { documents: { device: '1', inode: '10', volume: VOLUME }, files: { device: '1', inode: '20', volume: VOLUME } }
const remounted = { documents: { ...original.documents, device: '2' }, files: { ...original.files, device: '2' } }
const file = { device: '1', inode: '30' }

function fixture() {
  const db = new DatabaseSync(':memory:')
  onTestFinished(() => { db.close() })
  const store = new DocumentIdentityStore('/documents', db)
  store.bindStorage(original)
  const pending = store.prepare({ kind: 'publish', source: 'upload.part', actor: UserDocUploadOwnerId('user:7'), document: {
    incarnationId: UserDocIncarnationId(randomUUID()), docId: UserDocId('report.txt'), createdBy: UserDocUploadOwnerId('user:7'),
    origin: 'upload', bytes: 5, mediaType: 'text/plain', modifiedAt: 1,
  } }, file)
  const [record] = store.commit(store.retain(pending))
  store.finish(pending)
  return { db, store, record: record! }
}

it.each(['prepared', 'retained', 'committed'] as const)('normalizes device numbers in %s recovery without changing authorization or delivery positions', (phase) => {
  const { db, store, record } = fixture()
  const pending = store.prepare({ kind: 'move', expected: record, target: UserDocId('renamed.txt'), actor: UserDocUploadOwnerId('user:8') }, file)
  if (phase !== 'prepared') store.retain(pending)
  if (phase === 'committed') store.commit(pending)
  const records = store.list(), recovery = store.pending()
  const progress = db.prepare('SELECT * FROM document_projection_progress').get()
  const deliveries = store.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 50, maxBytes: 65536 })
  expect(() => { store.bindStorage(remounted) }).not.toThrow()
  expect(store.list()).toEqual(records.map(item => ({ ...item, file: { ...item.file, device: '2' } })))
  expect(store.pending()).toEqual({ ...recovery, entries: recovery!.entries.map(entry => ({
    ...entry, file: { ...entry.file, device: '2' }, result: { ...entry.result, file: { ...entry.result.file, device: '2' } },
  })) })
  expect(db.prepare('SELECT * FROM document_projection_progress').get()).toEqual(progress)
  expect(store.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 50, maxBytes: 65536 })).toEqual({
    ...deliveries, changes: deliveries.changes.map(change => ({ ...change, document: {
      ...change.document, file: { ...change.document.file, device: '2' },
    } })),
  })
  store.bindStorage(remounted)
})

it.each(['different-volume', 'missing-volume', 'changed-documents', 'changed-files'] as const)('refuses %s without rewriting records or queued operations', (kind) => {
  const { db, store } = fixture()
  const rows = () => ['document_identity_storage', 'document_identities', 'document_identity_pending', 'document_projection_changes',
    'document_projection_progress'].map(table => db.prepare(`SELECT * FROM ${table}`).all())
  const before = rows()
  const candidate = structuredClone(remounted)
  if (kind === 'different-volume') {
    candidate.documents.volume = '99999999-2222-3333-4444-555555555555'
    candidate.files.volume = candidate.documents.volume
  }
  if (kind === 'missing-volume') { Reflect.deleteProperty(candidate.documents, 'volume'); Reflect.deleteProperty(candidate.files, 'volume') }
  if (kind === 'changed-documents') candidate.documents.inode = '11'
  if (kind === 'changed-files') candidate.files.inode = '21'
  expect(() => { store.bindStorage(candidate) }).toThrow('binding changed')
  expect(rows()).toEqual(before)
})

it.each(['prepared', 'retained', 'committed', 'migrated'] as const)('retains %s directory evidence through device normalization', (phase) => {
  const { db, store } = fixture(), source = { device: '1', inode: '40' }, marker = { device: '1', inode: '41' }
  const pending = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [], marker, source)
  if (phase !== 'prepared') store.retain(pending)
  if (phase === 'committed') { store.captureDirectory(pending, source); store.commit(pending) }
  if (phase === 'migrated') {
    db.prepare('UPDATE document_identity_pending SET directory_move=?').run(JSON.stringify({
      from: 'folder', to: 'renamed', marker,
    }))
    db.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
      ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=2`)
  }
  const reopened = new DocumentIdentityStore('/documents', db)
  reopened.bindStorage(original)
  const before = reopened.pending()!
  reopened.bindStorage(remounted)
  expect(reopened.pending()?.directoryMove).toEqual({ ...before.directoryMove,
    marker: { ...marker, device: '2' }, source: phase === 'migrated' ? null : { ...source, device: '2' },
  })
})

it('retains a pending missing transition without inventing a file capture', () => {
  const { store, record } = fixture()
  store.prepare({ kind: 'missing', expected: record }, null)
  const pending = store.pending()!
  store.bindStorage(remounted)
  expect(store.pending()).toEqual({ ...pending, entries: pending.entries.map(entry => ({ ...entry,
    file: null, result: { ...entry.result, file: { ...entry.result.file, device: '2' } },
  })) })
})

it('rolls back normalization and volume evidence together when retained delivery cannot be updated', () => {
  const { db, store } = fixture(), before = store.list()
  db.exec(`CREATE TRIGGER refuse_device_rebind BEFORE UPDATE ON document_projection_changes
    BEGIN SELECT RAISE(ABORT,'owned device rebind interruption'); END`)
  expect(() => { store.bindStorage(remounted) }).toThrow('owned device rebind interruption')
  expect(store.list()).toEqual(before)
  expect(db.prepare('SELECT documents_device,files_device FROM document_identity_storage').get()).toEqual({ documents_device: '1', files_device: '1' })
  db.exec('DROP TRIGGER refuse_device_rebind')
  store.bindStorage(remounted)
})

it('requires UUID evidence even when offline recovery is requested explicitly', () => {
  const { store } = fixture()
  expect(() => { store.recoverMount({ documents: file, files: file }) }).toThrow('persistent filesystem UUIDs')
})
