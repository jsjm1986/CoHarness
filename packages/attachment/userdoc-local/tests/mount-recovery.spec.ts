/** Offline recovery uses independent pre-remount bytes and original objects while retaining later permanent-deletion history. */
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { DirectoryHandle } from '@deepseek-ai/node-addon-system/directory'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { UserDocId, UserDocIncarnationId, UserDocTrashId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { DocumentIdentityFs } from '../src/identity-fs.ts'
import { DocumentIdentityStore } from '../src/identity.ts'
import { recoverDocumentIdentityMount, type DocumentBackupEntry } from '../src/backup.ts'

const VOLUME = '11111111-2222-3333-4444-555555555555'
afterEach(() => { vi.restoreAllMocks() })

async function fixture() {
  // The filesystem UUID is the only nondeterministic OS input; descriptors, inodes, SQLite and document operations are real.
  const volume = vi.spyOn(DirectoryHandle.prototype, 'volumeIdentity').mockResolvedValue(VOLUME)
  const base = await mkdtemp(join(tmpdir(), 'dsh-mount-recovery-'))
  const locations = { root: join(base, 'documents'), stateRoot: join(base, 'state'), filesRoot: join(base, 'files') }
  const owners: DocumentIdentityFs[] = []
  onTestFinished(async () => { await Promise.all(owners.map(owner => owner.dispose())); await rm(base, { recursive: true, force: true }) })
  await mkdir(locations.root)
  const owner = await DocumentIdentityFs.open(locations)
  owners.push(owner)
  const partial = join(locations.filesRoot, 'upload.part')
  await writeFile(partial, 'active bytes')
  const active = await owner.publish({ docId: UserDocId('active.txt'), name: 'active.txt', path: join(locations.root, 'active.txt') }, partial, {
    incarnationId: UserDocIncarnationId(randomUUID()), bytes: 12, origin: 'upload', createdBy: UserDocUploadOwnerId('user:7'),
  })
  await writeFile(partial, 'trash bytes')
  const second = await owner.publish({ docId: UserDocId('trash.txt'), name: 'trash.txt', path: join(locations.root, 'trash.txt') }, partial, {
    incarnationId: UserDocIncarnationId(randomUUID()), bytes: 11, origin: 'upload', createdBy: UserDocUploadOwnerId('user:8'),
  })
  const trash = await owner.trash({ docId: second.docId, ...second.identity }, 60000)
  await owner.dispose()
  const databasePath = join(locations.stateRoot, 'metadata.sqlite'), markerPath = join(locations.filesRoot, 'domain.json')
  const info = await lstat(databasePath, { bigint: true }), oldDevice = String(info.dev + 1n)
  const database = new DatabaseSync(databasePath)
  let rootId: string
  try {
    rootId = String(database.prepare('SELECT root_id FROM document_identity_root').get()?.root_id)
    database.prepare("UPDATE document_identities SET record=json_set(record,'$.file.device',?)").run(oldDevice)
    database.prepare("UPDATE document_projection_changes SET document=json_set(document,'$.file.device',?)").run(oldDevice)
    database.prepare('UPDATE document_identity_storage SET documents_device=?,files_device=?').run(oldDevice, oldDevice)
    database.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
      ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=3`)
  } finally { database.close() }
  const state = await lstat(locations.stateRoot, { bigint: true })
  await writeFile(markerPath, JSON.stringify({ version: 1, rootId, state: { device: oldDevice, inode: String(state.ino) },
    database: { device: oldDevice, inode: String(info.ino) } }))
  const entries: DocumentBackupEntry[] = []
  const capture = async (path: string): Promise<void> => {
    const info = await lstat(path, { bigint: true }), object = { device: oldDevice, inode: String(info.ino) }
    if (info.isDirectory()) {
      entries.push({ path, object })
      for (const leaf of await readdir(path)) if (!leaf.endsWith('.lock')) await capture(join(path, leaf))
    } else {
      const bytes = await readFile(path)
      entries.push({ path, object, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), modifiedAt: Number(info.mtimeNs) / 1e6 })
    }
  }
  for (const path of Object.values(locations)) await capture(path)
  const saved = join(base, 'immutable-database.sqlite')
  await copyFile(databasePath, saved)
  const reference = { databasePath: saved, entries }
  const reopen = async () => { const next = await DocumentIdentityFs.open(locations); owners.push(next); return next }
  return { locations, reference, active, trash, databasePath, markerPath, oldDevice, reopen, volume }
}

it.skipIf(process.platform === 'win32')('requires explicit verified recovery for legacy evidence and preserves later purge history and delivery cursors', async () => {
  const f = await fixture()
  const database = new DatabaseSync(f.databasePath)
  let records: ReturnType<DocumentIdentityStore['list']>, projection: ReturnType<DocumentIdentityStore['projectionChanges']>
  try {
    const store = new DocumentIdentityStore(f.locations.root, database, 'read')
    const file = { device: f.oldDevice, inode: '99999999' }
    const apply = (change: Parameters<typeof store.prepare>[0]) => {
      const pending = store.prepare(change, file), [record] = store.commit(store.retain(pending))
      store.finish(pending); return record!
    }
    const uploaded = apply({ kind: 'publish', source: 'retired.part', document: { incarnationId: UserDocIncarnationId(randomUUID()),
      docId: UserDocId('removed.txt'), createdBy: UserDocUploadOwnerId('user:9'), origin: 'upload', bytes: 5, mediaType: 'text/plain', modifiedAt: 1 } })
    const trashed = apply({ kind: 'trash', expected: uploaded, trashId: UserDocTrashId(randomUUID()), trashedAt: 1, purgeAfter: 2 })
    apply({ kind: 'purge', expected: trashed, trashId: trashed.trash!.trashId })
    records = store.list()
    projection = store.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 50, maxBytes: 65536 })
  } finally { database.close() }
  await expect(f.reopen()).rejects.toThrow()
  await recoverDocumentIdentityMount(f.locations, f.reference)
  const next = await f.reopen()
  expect((await next.stat(f.active.docId)).identity).toEqual(f.active.identity)
  expect((await next.listTrash())[0]).toMatchObject({ trashId: f.trash.trashId, identity: f.trash.identity })
  expect((await next.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 50, maxBytes: 65536 })).changes.map(change => ({
    ...change, document: { ...change.document, file: { ...change.document.file, device: f.oldDevice } },
  }))).toEqual(projection.changes)
  const current = new DatabaseSync(f.databasePath, { readOnly: true })
  try {
    expect(new DocumentIdentityStore(f.locations.root, current, 'read').list().map(record => ({
      ...record, file: { ...record.file, device: f.oldDevice },
    }))).toEqual(records)
  } finally { current.close() }
  await next.dispose()
  await recoverDocumentIdentityMount(f.locations, f.reference)
})

it.skipIf(process.platform === 'win32').each(['copied-root', 'copied-database', 'copied-document', 'changed-bytes', 'missing-proof', 'changed-snapshot', 'hard-linked-reference',
  'live-reference', 'missing-uuid', 'other-domain', 'invalid-marker', 'invalid-volume', 'changed-marker-witness', 'unsupported-marker',
  'changed-known-volume', 'incomplete-version-proof', 'pending-operation', 'new-version'] as const)('refuses %s without rewriting identity metadata', async (kind) => {
  const f = await fixture()
  if (kind === 'copied-root') { await rename(f.locations.root, `${f.locations.root}.original`); await mkdir(f.locations.root); await writeFile(join(f.locations.root, 'active.txt'), 'active bytes') }
  if (kind === 'copied-database') { await copyFile(f.databasePath, `${f.databasePath}.copy`); await rename(`${f.databasePath}.copy`, f.databasePath) }
  if (kind === 'copied-document') { await copyFile(f.active.path, `${f.active.path}.copy`); await rename(`${f.active.path}.copy`, f.active.path) }
  if (kind === 'changed-bytes') await writeFile(f.active.path, 'forged bytes')
  if (kind === 'missing-proof') f.reference.entries.splice(f.reference.entries.findIndex(entry => entry.path === f.active.path), 1)
  if (kind === 'changed-snapshot') await writeFile(f.reference.databasePath, 'unverified metadata')
  if (kind === 'hard-linked-reference') { await rm(f.reference.databasePath); await link(f.databasePath, f.reference.databasePath) }
  if (kind === 'live-reference') f.reference.databasePath = f.databasePath
  if (kind === 'missing-uuid') f.volume.mockResolvedValue(undefined)
  if (kind === 'other-domain') {
    const database = new DatabaseSync(f.databasePath)
    try { database.prepare('UPDATE document_identity_root SET root_id=?').run(randomUUID()) } finally { database.close() }
  }
  if (kind === 'invalid-marker') await writeFile(f.markerPath, 'null')
  if (kind === 'invalid-volume' || kind === 'changed-marker-witness' || kind === 'unsupported-marker') {
    const marker = JSON.parse(await readFile(f.markerPath, 'utf8')) as { version: number; state: { inode: string; volume?: string } }
    if (kind === 'invalid-volume') marker.state.volume = 'invalid'
    if (kind === 'changed-marker-witness') marker.state.inode = '0'
    if (kind === 'unsupported-marker') marker.version = 3
    await writeFile(f.markerPath, JSON.stringify(marker))
  }
  if (kind === 'changed-known-volume') {
    const database = new DatabaseSync(f.databasePath)
    try {
      new DocumentIdentityStore(f.locations.root, database)
      database.prepare('UPDATE document_identity_storage SET documents_volume=?,files_volume=?')
        .run('99999999-2222-3333-4444-555555555555', '99999999-2222-3333-4444-555555555555')
    } finally { database.close() }
  }
  if (kind === 'incomplete-version-proof') {
    const index = f.reference.entries.findIndex(entry => entry.path === f.active.path), entry = f.reference.entries[index]!
    f.reference.entries.splice(index, 1, { ...entry, sizeBytes: entry.sizeBytes! + 1 })
  }
  if (kind === 'pending-operation') {
    const database = new DatabaseSync(f.databasePath)
    try {
      const store = new DocumentIdentityStore(f.locations.root, database, 'read'), record = store.active(f.active.docId)!
      store.prepare({ kind: 'observe', expected: record, bytes: record.bytes, mediaType: record.mediaType, modifiedAt: record.modifiedAt + 1 }, record.file)
    } finally { database.close() }
  }
  if (kind === 'new-version') {
    const database = new DatabaseSync(f.databasePath)
    try {
      const store = new DocumentIdentityStore(f.locations.root, database, 'read'), record = store.active(f.active.docId)!
      const pending = store.prepare({ kind: 'observe', expected: record, bytes: record.bytes, mediaType: record.mediaType, modifiedAt: record.modifiedAt + 1 }, record.file)
      store.commit(store.retain(pending)); store.finish(pending)
    } finally { database.close() }
  }
  const before = await readFile(f.databasePath), marker = await readFile(f.markerPath)
  await expect(recoverDocumentIdentityMount(f.locations, f.reference)).rejects.toThrow()
  expect(await readFile(f.databasePath)).toEqual(before)
  expect(await readFile(f.markerPath)).toEqual(marker)
})

it.skipIf(process.platform === 'win32')('retries after marker commit and a refused metadata migration without losing retained bytes', async () => {
  const f = await fixture(), database = new DatabaseSync(f.databasePath)
  try { database.exec('CREATE TRIGGER refuse_rebind BEFORE UPDATE ON document_identity_storage BEGIN SELECT RAISE(ABORT,\'owned rebind failure\'); END') }
  finally { database.close() }
  await expect(recoverDocumentIdentityMount(f.locations, f.reference)).rejects.toThrow('owned rebind failure')
  expect(await readFile(f.active.path, 'utf8')).toBe('active bytes')
  const next = new DatabaseSync(f.databasePath)
  try { next.exec('DROP TRIGGER refuse_rebind') } finally { next.close() }
  await recoverDocumentIdentityMount(f.locations, f.reference)
  expect((await (await f.reopen()).stat(f.active.docId)).identity).toEqual(f.active.identity)
})

it.skipIf(process.platform === 'win32')('preserves source bytes when marker publication is refused or recovery is cancelled', async () => {
  const f = await fixture(), before = await readFile(f.databasePath), failure = new Error('owned marker publication failure')
  const write = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(failure)
  await expect(recoverDocumentIdentityMount(f.locations, f.reference)).rejects.toBe(failure)
  write.mockRestore()
  expect(await readFile(f.databasePath)).toEqual(before)
  const abort = new AbortController(), reason = new Error('owned recovery cancellation')
  abort.abort(reason)
  await expect(recoverDocumentIdentityMount(f.locations, f.reference, abort.signal)).rejects.toBe(reason)
  expect(await readFile(f.databasePath)).toEqual(before)
})
