/** Catalog delivery is ordered, bounded and atomic with real SQLite identity commits. */
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocTrashId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { DocumentIdentityStore, type DocumentIdentityChange, type DocumentIdentityRecord, type NewDocumentIdentity } from '../src/identity.ts'

const START = { sequence: 0, ordinal: 0 }, OPTIONS = { limit: 100, maxBytes: 1_000_000 }
const FILE = { device: '1', inode: '1' }

function fixture() {
  const db = new DatabaseSync(':memory:')
  onTestFinished(() => { db.close() })
  return { db, store: new DocumentIdentityStore('/documents', db) }
}

function document(name = 'report.txt', actor = 'user:1'): NewDocumentIdentity {
  return { incarnationId: UserDocIncarnationId(randomUUID()), docId: UserDocId(name), createdBy: UserDocUploadOwnerId(actor),
    origin: 'upload', bytes: 5, mediaType: 'text/plain', modifiedAt: 1 }
}

function apply(store: DocumentIdentityStore, change: DocumentIdentityChange): DocumentIdentityRecord {
  const pending = store.prepare(change, change.kind === 'missing' ? null : FILE)
  const [record] = store.commit(store.retain(pending))
  store.finish(pending)
  return record!
}

function publish(store: DocumentIdentityStore, input = document()): DocumentIdentityRecord {
  return apply(store, { kind: 'publish', document: input, source: '.upload-sessions/source.part' })
}

it('exposes each mutation once at commit and retains its detached publication snapshot', () => {
  const { store } = fixture(), input = document()
  const pending = store.prepare({ kind: 'publish', document: input, source: '.upload-sessions/source.part' }, FILE)
  expect(store.projectionChanges(START, OPTIONS)).toMatchObject({ after: START, head: START, next: START, changes: [], hasMore: false })
  store.retain(pending)
  expect(store.projectionChanges(START, OPTIONS).changes).toEqual([])
  const [committed] = store.commit(pending)
  store.commit(pending)
  store.finish(pending)
  apply(store, { kind: 'move', expected: committed!, target: UserDocId('moved.txt') })
  const batch = store.projectionChanges(START, OPTIONS)
  expect(batch.rootId).toBe(store.rootId)
  expect(batch.changes).toHaveLength(2)
  expect(batch.changes.map(change => [change.action, change.document.docId])).toEqual([['publish', 'report.txt'], ['move', 'moved.txt']])
  expect(batch.changes[0]).toMatchObject({ cursor: { sequence: 1, ordinal: 1 }, previous: START, document: committed })
  expect(Number.isSafeInteger(batch.changes[0]?.committedAt)).toBe(true)
  expect(batch.changes[1]?.previous).toEqual(batch.changes[0]?.cursor)
  expect(batch.next).toEqual(batch.head)
})

it('retains trash, restore, purge and same-name replacement as distinct ordered ownership facts', () => {
  const { store } = fixture(), original = publish(store), trashId = UserDocTrashId(randomUUID())
  const trashed = apply(store, { kind: 'trash', expected: original, trashId, trashedAt: 10, purgeAfter: 20 })
  const restored = apply(store, { kind: 'restore', expected: trashed, trashId, target: original.docId })
  const nextTrash = UserDocTrashId(randomUUID())
  const retrash = apply(store, { kind: 'trash', expected: restored, trashId: nextTrash, trashedAt: 20, purgeAfter: 30 })
  apply(store, { kind: 'purge', expected: retrash, trashId: nextTrash })
  const replacement = publish(store, document('report.txt', 'user:2'))
  const changes = store.projectionChanges(START, OPTIONS).changes
  expect(changes.map(change => change.document.state)).toEqual(['active', 'trash', 'active', 'trash', 'purged', 'active'])
  expect(changes.slice(0, 5).every(change => change.document.createdBy === 'user:1')).toBe(true)
  expect(changes[1]?.document.trash?.trashId).toBe(trashId)
  expect(changes[3]?.document.trash?.trashId).toBe(nextTrash)
  expect(changes[5]?.document).toEqual(replacement)
})

it('retains the initiating actor separately from the immutable creator and never assigns a delivery actor', () => {
  const { store } = fixture(), creator = UserDocUploadOwnerId('user:1'), actor = UserDocUploadOwnerId('user:2')
  const original = apply(store, { kind: 'publish', document: document(), source: 'private/source.part', actor: creator })
  apply(store, { kind: 'trash', expected: original, trashId: UserDocTrashId(randomUUID()), trashedAt: 10, purgeAfter: 20, actor })
  publish(store, document('another.txt'))
  const changes = store.projectionChanges(START, OPTIONS).changes
  expect(changes.map(change => change.actor)).toEqual([creator, actor, undefined])
  expect(changes[1]?.document.createdBy).toBe(creator)
})

it('links across abandoned reservations and delivers directory records on separate bounded pages', () => {
  const { store } = fixture(), first = publish(store, document('folder/a.txt')), second = publish(store, document('folder/b.txt'))
  const unused = store.prepare({ kind: 'adopt', document: document('unused.txt') }, FILE)
  store.abandon(unused)
  const before = store.projectionChanges(START, OPTIONS).head
  const pending = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first, second], FILE, FILE)
  store.retain(pending); store.captureDirectory(pending, FILE); store.commit(pending); store.finish(pending)
  const one = store.projectionChanges(before, { ...OPTIONS, limit: 1 })
  expect(one.changes).toHaveLength(1)
  expect(one.changes[0]?.previous).toEqual(before)
  expect(one.next).toEqual({ sequence: unused.sequence + 1, ordinal: 1 })
  expect(one.hasMore).toBe(true)
  store.acknowledgeProjection(one.next)
  const two = store.projectionChanges(one.next, { ...OPTIONS, limit: 1 })
  expect(two.changes).toHaveLength(1)
  expect(two.changes[0]?.previous).toEqual(one.next)
  expect(two.next).toEqual({ sequence: pending.sequence, ordinal: 2 })
  expect(two.hasMore).toBe(false)
  expect(new Set([...one.changes, ...two.changes].map(change => change.document.docId))).toEqual(new Set(['renamed/a.txt', 'renamed/b.txt']))
  expect(() => store.projectionChanges(START, OPTIONS)).toThrow('precedes the retained')
})

it('bounds the complete serialized UTF-8 batch and leaves an oversized change available for a larger budget', () => {
  const { store } = fixture()
  publish(store, document('文件一.txt', '账户:一')); publish(store, document('文件二.txt', '账户:二'))
  const first = store.projectionChanges(START, { ...OPTIONS, limit: 1 })
  const bytes = Buffer.byteLength(JSON.stringify(first))
  expect(bytes).toBeGreaterThan(JSON.stringify(first).length)
  const exact = store.projectionChanges(START, { limit: 100, maxBytes: bytes })
  expect(exact).toEqual(first)
  expect(Buffer.byteLength(JSON.stringify(exact))).toBe(bytes)
  expect(() => store.projectionChanges(START, { limit: 100, maxBytes: bytes - 1 })).toThrow('One document projection change')
  expect(store.projectionChanges(START, OPTIONS).changes).toHaveLength(2)
  const complete = store.projectionChanges(START, OPTIONS)
  expect(store.projectionChanges(START, { limit: 100, maxBytes: Buffer.byteLength(JSON.stringify(complete)) })).toEqual(complete)
})

it.each([{ limit: 0, maxBytes: 1000 }, { limit: 1, maxBytes: 0 }, { limit: NaN, maxBytes: 1000 },
  { limit: 1, maxBytes: Infinity }])('refuses invalid resolved transport bounds %j', (options) => {
  expect(() => fixture().store.projectionChanges(START, options)).toThrow('positive safe integers')
})

it('rejects a metadata-only response larger than its transport budget', () => {
  const { store } = fixture()
  expect(() => store.projectionChanges(START, { limit: 1, maxBytes: 1 })).toThrow('metadata exceeds')
})

it('acknowledges only actual committed positions and never moves acknowledgement backwards', () => {
  const { store, db } = fixture()
  const unused = store.prepare({ kind: 'publish', document: document('unused.txt'), source: 'private/source.part' }, FILE)
  store.abandon(unused)
  publish(store)
  const batch = store.projectionChanges(START, OPTIONS)
  expect(() => { store.acknowledgeProjection({ sequence: unused.sequence, ordinal: 1 }) }).toThrow('not a committed')
  expect(() => { store.acknowledgeProjection({ sequence: batch.head.sequence + 1, ordinal: 1 }) }).toThrow('exceeds')
  store.acknowledgeProjection(batch.next)
  store.acknowledgeProjection(START); store.acknowledgeProjection(batch.next)
  expect(db.prepare('SELECT count(*) AS count FROM document_projection_changes').get()?.count).toBe(0)
  expect(store.projectionChanges(batch.next, OPTIONS).changes).toEqual([])
  expect(() => store.projectionChanges(START, OPTIONS)).toThrow('precedes')
  expect(() => store.projectionChanges({ sequence: batch.head.sequence + 1, ordinal: 1 }, OPTIONS)).toThrow('exceeds')
})

it.each([{ sequence: -1, ordinal: 1 }, { sequence: 0, ordinal: 1 }, { sequence: 1, ordinal: 0 },
  { sequence: 1.5, ordinal: 1 }])('refuses an invalid delivery cursor %j', (position) => {
  const { store } = fixture()
  expect(() => store.projectionChanges(position, OPTIONS)).toThrow()
  expect(() => { store.acknowledgeProjection(position) }).toThrow()
})

it('rolls back metadata, every projection row and the commit marker when append fails mid-directory batch', () => {
  const { store, db } = fixture(), first = publish(store, document('folder/a.txt')), second = publish(store, document('folder/b.txt'))
  const before = store.projectionChanges(START, OPTIONS)
  const pending = store.prepareDirectoryMove(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first, second], FILE, FILE)
  store.retain(pending); store.captureDirectory(pending, FILE)
  db.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON document_projection_changes WHEN NEW.ordinal=2
    BEGIN SELECT RAISE(ABORT,'Owned projection append interruption'); END`)
  expect(() => store.commit(pending)).toThrow('Owned projection append interruption')
  expect(store.get(first.incarnationId)).toEqual(first)
  expect(store.get(second.incarnationId)).toEqual(second)
  expect(store.pending()?.phase).toBe('retained')
  expect(store.projectionChanges(START, OPTIONS)).toEqual(before)
  db.exec('DROP TRIGGER fail_projection')
  store.commit(pending); store.commit(pending); store.finish(pending)
  expect(store.projectionChanges(before.head, OPTIONS).changes).toHaveLength(2)
})

it('rolls back acknowledgement if deletion of the delivered prefix fails', () => {
  const { store, db } = fixture()
  publish(store)
  const before = store.projectionChanges(START, OPTIONS)
  db.exec(`CREATE TRIGGER fail_projection_delete BEFORE DELETE ON document_projection_changes
    BEGIN SELECT RAISE(ABORT,'Owned projection acknowledgement interruption'); END`)
  expect(() => { store.acknowledgeProjection(before.head) }).toThrow('Owned projection acknowledgement interruption')
  expect(store.projectionChanges(START, OPTIONS)).toEqual(before)
  db.exec('DROP TRIGGER fail_projection_delete')
  store.acknowledgeProjection(before.head)
  expect(() => store.projectionChanges(START, OPTIONS)).toThrow('precedes')
})

it('refuses a missing delivery row instead of skipping its lifecycle transition', () => {
  const { store, db } = fixture()
  publish(store, document('first.txt')); publish(store, document('second.txt'))
  db.exec('DELETE FROM document_projection_changes WHERE sequence=1')
  expect(() => store.projectionChanges(START, OPTIONS)).toThrow('delivery gap')
})

it('refuses an empty retained backlog whose durable head still promises undelivered work', () => {
  const { store, db } = fixture()
  publish(store)
  db.exec('DELETE FROM document_projection_changes')
  expect(() => store.projectionChanges(START, OPTIONS)).toThrow('delivery gap')
})

it('rejects a forged checkpoint between a directory transaction\'s committed records', () => {
  const { store } = fixture()
  publish(store)
  expect(() => store.projectionChanges({ sequence: 1, ordinal: 2 }, OPTIONS)).toThrow('exceeds')
  publish(store, document('second.txt'))
  expect(() => store.projectionChanges({ sequence: 1, ordinal: 2 }, OPTIONS)).toThrow('delivery gap')
})

it.each([
  "UPDATE document_projection_changes SET action='wrong'",
  'UPDATE document_projection_changes SET committed_at=-1',
  'UPDATE document_projection_changes SET previous_sequence=sequence,previous_ordinal=ordinal',
  "UPDATE document_projection_changes SET document='null'",
  'UPDATE document_projection_changes SET actor=\'\'',
  'UPDATE document_projection_changes SET actor=char(10)',
])('rejects malformed retained projection data: %s', (sql) => {
  const { store, db } = fixture()
  publish(store); db.exec(sql)
  expect(() => store.projectionChanges(START, OPTIONS)).toThrow()
})

it.each([
  'UPDATE document_projection_progress SET head_ordinal=0',
  'UPDATE document_projection_progress SET ack_sequence=2,ack_ordinal=1',
  'DELETE FROM document_projection_progress',
  'DELETE FROM document_projection_changes',
  'UPDATE document_projection_progress SET head_sequence=2',
])('refuses inconsistent delivery progress on owner reopen: %s', (sql) => {
  const { store, db } = fixture()
  publish(store); db.exec(sql)
  expect(() => new DocumentIdentityStore('/documents', db)).toThrow()
})

it('refuses a rewound durable mutation sequence before publishing another projection', () => {
  const { store, db } = fixture()
  publish(store)
  db.exec('UPDATE document_identity_sequence SET sequence=0')
  const pending = store.prepare({ kind: 'publish', document: document('second.txt'), source: 'private/second.part' }, FILE)
  store.retain(pending)
  expect(() => store.commit(pending)).toThrow('sequence did not advance')
  expect(store.active(UserDocId('second.txt'))).toBeUndefined()
  expect(store.projectionChanges(START, OPTIONS).changes).toHaveLength(1)
})

it('retains root identity, unacknowledged records and acknowledged prefix after closing the database connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-document-projection-')), path = join(root, 'metadata.sqlite')
  let db: DatabaseSync | undefined
  onTestFinished(async () => { db?.close(); await rm(root, { recursive: true, force: true }) })
  db = new DatabaseSync(path)
  let store = new DocumentIdentityStore(root, db)
  publish(store, document('first.txt')); publish(store, document('second.txt'))
  const batch = store.projectionChanges(START, { ...OPTIONS, limit: 1 }), rootId = store.rootId
  store.acknowledgeProjection(batch.next)
  db.close(); db = undefined
  db = new DatabaseSync(path); store = new DocumentIdentityStore(root, db)
  expect(store.rootId).toBe(rootId)
  expect(() => store.projectionChanges(START, OPTIONS)).toThrow('precedes')
  const after = store.projectionChanges(batch.next, OPTIONS)
  expect(after.changes.map(change => change.document.docId)).toEqual(['second.txt'])
  store.acknowledgeProjection(after.next)
  expect(new DocumentIdentityStore(root, db).projectionChanges(after.next, OPTIONS).changes).toEqual([])
})
