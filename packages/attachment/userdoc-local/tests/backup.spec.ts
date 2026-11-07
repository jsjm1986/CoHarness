/** Logical document recovery requires complete original witnesses and verified retained bytes. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DirectoryHandle } from '@deepseek-ai/node-addon-system/directory'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { DocumentIdentityFs } from '../src/identity-fs.ts'
import { DOCUMENT_IDENTITY_SCHEMA_VERSION, DocumentIdentityStore } from '../src/identity.ts'
import { restoreDocumentIdentityBackup, verifyDocumentIdentityBackup, type DocumentBackupEntry } from '../src/backup.ts'
import { withDirectoryRenameInterleave } from './fixtures/directory-native-interleave.mjs'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-document-backup-'))
  const locations = { root: join(base, 'documents'), stateRoot: join(base, 'state'), filesRoot: join(base, 'files') }
  const owners: DocumentIdentityFs[] = []
  onTestFinished(async () => {
    await Promise.all(owners.map(owner => owner.dispose()))
    await rm(base, { recursive: true, force: true })
  })
  await mkdir(locations.root)
  const owner = await DocumentIdentityFs.open(locations)
  owners.push(owner)
  const partial = join(locations.filesRoot, 'upload.part')
  await writeFile(partial, 'backup bytes')
  const original = await owner.publish({ docId: UserDocId('saved.txt'), name: 'saved.txt', path: join(locations.root, 'saved.txt') }, partial,
    { incarnationId: UserDocIncarnationId(randomUUID()), bytes: 12, origin: 'upload', createdBy: UserDocUploadOwnerId('user:7') })
  const capture = async () => {
    await owner.dispose()
    const entries: DocumentBackupEntry[] = [], saved = new Map<string, Uint8Array>()
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path, { bigint: true }), object = { device: String(info.dev), inode: String(info.ino) }
      if (info.isDirectory()) {
        entries.push({ path, object })
        for (const name of await readdir(path)) if (!name.endsWith('.lock')) await visit(join(path, name))
      } else {
        const bytes = await readFile(path)
        saved.set(path, bytes)
        entries.push({ path, object, sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
          modifiedAt: Number(info.mtimeNs) / 1e6 })
      }
    }
    for (const path of Object.values(locations)) await visit(path)
    const restore = async () => {
      for (const [path, bytes] of saved) {
        const temporary = `${path}.restore`
        await writeFile(temporary, bytes, { mode: 0o600 }); await rename(temporary, path)
      }
    }
    return { entries, saved, restore }
  }
  const reopen = async () => { const next = await DocumentIdentityFs.open(locations); owners.push(next); return next }
  return { owner, locations, original, capture, reopen }
}

it('restores active and trash identities without changing creator, revisions or delivery positions', async () => {
  const f = await fixture()
  const trash = await f.owner.trash({ docId: f.original.docId, ...f.original.identity }, 60000)
  const target = { docId: UserDocId('saved.txt'), name: 'saved.txt', path: f.original.path }, partial = join(f.locations.filesRoot, 'new.part')
  await writeFile(partial, 'new content')
  const replacement = await f.owner.publish(target, partial, { incarnationId: UserDocIncarnationId(randomUUID()),
    bytes: 11, origin: 'upload', createdBy: UserDocUploadOwnerId('user:8') })
  const pending = await f.owner.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 50, maxBytes: 65536 })
  const snapshot = await f.capture()
  await verifyDocumentIdentityBackup(f.locations, snapshot.entries)
  await snapshot.restore()
  await restoreDocumentIdentityBackup(f.locations, snapshot.entries)
  const next = await f.reopen()
  expect((await next.stat(replacement.docId)).identity).toEqual(replacement.identity)
  expect((await next.listTrash())[0]).toMatchObject({ trashId: trash.trashId, identity: trash.identity })
  const delivered = await next.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 50, maxBytes: 65536 })
  expect(delivered).toEqual(pending)
  const restored = await next.restore({ docId: trash.docId, ...trash.identity, trashId: trash.trashId })
  expect((await next.read(restored.docId)).data).toEqual(new TextEncoder().encode('backup bytes'))
  expect((await next.read(replacement.docId)).data).toEqual(new TextEncoder().encode('new content'))
})

it('verifies a schema 2 snapshot without migrating its immutable database and upgrades only the restored copy', async () => {
  const f = await fixture()
  await f.owner.dispose()
  const databasePath = join(f.locations.stateRoot, 'metadata.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
      ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=2`)
  } finally { database.close() }
  const markerPath = join(f.locations.filesRoot, 'domain.json')
  const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { state: { device: string; inode: string }; database: { device: string; inode: string }; rootId: string }
  await writeFile(markerPath, JSON.stringify({ version: 1, rootId: marker.rootId,
    state: { device: marker.state.device, inode: marker.state.inode },
    database: { device: marker.database.device, inode: marker.database.inode } }))
  const snapshot = await f.capture(), before = await readFile(databasePath)
  await verifyDocumentIdentityBackup(f.locations, snapshot.entries)
  expect(await readFile(databasePath)).toEqual(before)
  await snapshot.restore()
  await restoreDocumentIdentityBackup(f.locations, snapshot.entries)
  const restored = new DatabaseSync(databasePath, { readOnly: true })
  try { expect(restored.prepare('PRAGMA user_version').get()?.user_version).toBe(DOCUMENT_IDENTITY_SCHEMA_VERSION) } finally { restored.close() }
  expect((await (await f.reopen()).stat(f.original.docId)).identity).toEqual(f.original.identity)
})

it.each([2, 3])('refuses incomplete restored schema %s evidence before migrating its metadata', async (schema) => {
  const f = await fixture()
  await f.owner.dispose()
  const databasePath = join(f.locations.stateRoot, 'metadata.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    database.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
      ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=${schema}`)
  } finally { database.close() }
  const snapshot = await f.capture()
  await snapshot.restore()
  const before = await readFile(databasePath)
  const incomplete = snapshot.entries.filter(entry => entry.path !== f.original.path)
  await expect(restoreDocumentIdentityBackup(f.locations, incomplete)).rejects.toThrow('lacks object evidence')
  expect(await readFile(databasePath)).toEqual(before)
  await writeFile(f.original.path, 'forged bytes')
  await expect(restoreDocumentIdentityBackup(f.locations, snapshot.entries)).rejects.toThrow('invalid digest')
  expect(await readFile(databasePath)).toEqual(before)
  const retained = new DatabaseSync(databasePath, { readOnly: true })
  try { expect(retained.prepare('PRAGMA user_version').get()?.user_version).toBe(schema) } finally { retained.close() }
})

it.skipIf(process.platform === 'win32')('verifies a cold remounted domain without rewriting it and restores its verified snapshot onto another volume', async () => {
  const volume = vi.spyOn(DirectoryHandle.prototype, 'volumeIdentity').mockResolvedValue('11111111-2222-3333-4444-555555555555')
  try {
    const f = await fixture()
    await f.owner.dispose()
    const { DatabaseSync } = await import('node:sqlite')
    const path = join(f.locations.stateRoot, 'metadata.sqlite'), database = new DatabaseSync(path)
    const oldDevice = String((await lstat(path, { bigint: true })).dev + 1n)
    try {
      database.prepare('UPDATE document_identity_storage SET documents_device=?,files_device=?').run(oldDevice, oldDevice)
      database.prepare("UPDATE document_identities SET record=json_set(record,'$.file.device',?)").run(oldDevice)
      database.prepare("UPDATE document_projection_changes SET document=json_set(document,'$.file.device',?)").run(oldDevice)
    } finally { database.close() }
    const markerPath = join(f.locations.filesRoot, 'domain.json')
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as { state: { device: string }; database: { device: string } }
    marker.state.device = oldDevice; marker.database.device = oldDevice
    await writeFile(markerPath, JSON.stringify(marker))
    const snapshot = await f.capture(), before = await readFile(path)
    volume.mockResolvedValue('99999999-2222-3333-4444-555555555555')
    await expect(verifyDocumentIdentityBackup(f.locations, snapshot.entries)).rejects.toThrow('different identity domains')
    expect(await readFile(path)).toEqual(before)
    volume.mockResolvedValue('11111111-2222-3333-4444-555555555555')
    await verifyDocumentIdentityBackup(f.locations, snapshot.entries)
    expect(await readFile(path)).toEqual(before)
    await snapshot.restore()
    volume.mockResolvedValue('99999999-2222-3333-4444-555555555555')
    await restoreDocumentIdentityBackup(f.locations, snapshot.entries)
    expect((await (await f.reopen()).stat(f.original.docId)).identity).toEqual(f.original.identity)
    const restored = new DatabaseSync(path, { readOnly: true })
    try {
      expect(restored.prepare('SELECT documents_volume,files_volume FROM document_identity_storage').get()).toEqual({
        documents_volume: '99999999-2222-3333-4444-555555555555', files_volume: '99999999-2222-3333-4444-555555555555',
      })
    } finally { restored.close() }
  } finally { volume.mockRestore() }
})

it('refuses unsettled document mutations before snapshot verification or restored metadata migration', async () => {
  const f = await fixture()
  await f.owner.dispose()
  const databasePath = join(f.locations.stateRoot, 'metadata.sqlite')
  const { DatabaseSync } = await import('node:sqlite')
  const database = new DatabaseSync(databasePath)
  try {
    const store = new DocumentIdentityStore(f.locations.root, database), record = store.active(f.original.docId)!
    store.prepare({ kind: 'observe', expected: record, bytes: record.bytes, mediaType: record.mediaType, modifiedAt: record.modifiedAt + 1 }, record.file)
  } finally { database.close() }
  const snapshot = await f.capture(), before = await readFile(databasePath)
  await expect(verifyDocumentIdentityBackup(f.locations, snapshot.entries)).rejects.toThrow('must settle')
  await expect(restoreDocumentIdentityBackup(f.locations, snapshot.entries)).rejects.toThrow('must settle')
  expect(await readFile(databasePath)).toEqual(before)
})

it.each(['valid', 'unicode-alias', 'wrong-size', 'wrong-digest'] as const)('verifies and restores retired marker evidence: %s', async (evidence) => {
  const f = await fixture(), source = join(f.locations.root, 'folder'), held = join(f.locations.root, 'held-original')
  await mkdir(source)
  const original = await f.owner.move({ docId: f.original.docId, ...f.original.identity }, UserDocDirectoryId('folder'))
  let substituted = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!substituted && basename(from) === 'folder') {
      await rename(source, held); await mkdir(source); await writeFile(join(source, 'foreign.txt'), 'foreign bytes')
      substituted = true
    }
  }, async () => {
    await expect(f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [{ docId: original.docId, ...original.identity }]))
      .rejects.toThrow()
  })
  expect(substituted).toBe(true)
  let marker = (await readdir(held)).find(name => name.startsWith('.dsh-directory-'))
  expect(marker).toBeDefined()
  if (evidence === 'unicode-alias') {
    const alias = String(marker).replace('s', 'ſ')
    await rename(join(held, String(marker)), join(held, alias)); marker = alias
  }
  const unrelated = join(f.locations.root, 'unrelated')
  await rename(source, unrelated); await rename(held, source)
  const snapshot = await f.capture()
  expect(snapshot.entries.some(entry => entry.path === join(source, String(marker)))).toBe(true)
  if (evidence === 'wrong-size' || evidence === 'wrong-digest') {
    const entries = snapshot.entries.map(entry => entry.path !== join(source, String(marker)) ? entry : {
      ...entry, ...(evidence === 'wrong-size' ? { sizeBytes: 1 } : { sha256: '0'.repeat(64) }),
    })
    const before = await readFile(join(f.locations.stateRoot, 'metadata.sqlite'))
    await expect(verifyDocumentIdentityBackup(f.locations, entries)).rejects.toThrow('inconsistent directory marker evidence')
    expect(await readFile(join(f.locations.stateRoot, 'metadata.sqlite'))).toEqual(before)
    expect(await readFile(join(source, 'saved.txt'), 'utf8')).toBe('backup bytes')
    return
  }
  await verifyDocumentIdentityBackup(f.locations, snapshot.entries)
  await snapshot.restore(); await restoreDocumentIdentityBackup(f.locations, snapshot.entries)
  const restarted = await f.reopen(), listing = await restarted.list()
  expect(listing.some(file => file.name === marker)).toBe(false)
  expect(listing.find(file => file.docId === 'folder/saved.txt')?.identity.incarnationId).toBe(original.identity.incarnationId)
  expect(await readdir(source)).toEqual(['saved.txt'])
  expect(await readdir(join(f.locations.filesRoot, 'anchors'))).toEqual([])
  expect(await readFile(join(unrelated, 'foreign.txt'), 'utf8')).toBe('foreign bytes')
})

it.each(['duplicate', 'missing-directory', 'wrong-directory', 'wrong-object', 'wrong-size', 'wrong-digest', 'missing-digest'] as const)(
  'rejects %s evidence before rewriting identity metadata', async (kind) => {
    const f = await fixture(), snapshot = await f.capture()
    const entries: Array<{ -readonly [Key in keyof DocumentBackupEntry]: DocumentBackupEntry[Key] }> = structuredClone(snapshot.entries)
    const publicFile = entries.find(item => item.path === f.original.path)!
    if (kind === 'duplicate') entries.push(entries[0]!)
    else if (kind === 'missing-directory') entries.splice(entries.findIndex(item => item.path === f.locations.stateRoot), 1)
    else if (kind === 'wrong-directory') entries.find(item => item.path === f.locations.root)!.object = { device: '1', inode: '1' }
    else if (kind === 'wrong-object') publicFile.object = { device: '1', inode: '1' }
    else if (kind === 'wrong-size') publicFile.sizeBytes = 999
    else if (kind === 'wrong-digest') entries.find(item => item.path.endsWith('.object'))!.sha256 = '0'.repeat(64)
    else delete entries.find(item => item.path === join(f.locations.stateRoot, 'metadata.sqlite'))!.sha256
    const database = join(f.locations.stateRoot, 'metadata.sqlite'), before = await readFile(database)
    await expect(verifyDocumentIdentityBackup(f.locations, entries)).rejects.toThrow()
    expect(await readFile(database)).toEqual(before)
    expect(await readFile(f.original.path, 'utf8')).toBe('backup bytes')
  },
)

it.each([null, { version: 1, rootId: 'different' }, { version: 1, state: null }] as const)(
  'rejects incomplete private domain evidence without modifying retained bytes', async (invalid) => {
    const f = await fixture(), snapshot = await f.capture(), marker = join(f.locations.filesRoot, 'domain.json')
    const valid = JSON.parse(await readFile(marker, 'utf8')) as Record<string, unknown>
    const value = invalid === null ? null : { ...valid, ...invalid }
    const bytes = Buffer.from(JSON.stringify(value))
    await writeFile(marker, bytes)
    const info = await lstat(marker, { bigint: true })
    const entries = snapshot.entries.map(entry => entry.path !== marker ? entry : { ...entry,
      sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), modifiedAt: Number(info.mtimeNs) / 1e6 })
    await expect(verifyDocumentIdentityBackup(f.locations, entries)).rejects.toThrow()
    expect(await readFile(f.original.path, 'utf8')).toBe('backup bytes')
  },
)

it('retains recoverable bytes after interrupted marker publication and permits a complete restore retry', async () => {
  const f = await fixture(), snapshot = await f.capture()
  await snapshot.restore()
  const failure = new Error('restore marker publication failed')
  const marker = vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(failure)
  try { await expect(restoreDocumentIdentityBackup(f.locations, snapshot.entries)).rejects.toBe(failure) } finally { marker.mockRestore() }
  expect(await readFile(f.original.path, 'utf8')).toBe('backup bytes')
  await expect(f.reopen()).rejects.toThrow('metadata domain')
  await snapshot.restore()
  await restoreDocumentIdentityBackup(f.locations, snapshot.entries)
  expect((await (await f.reopen()).stat(f.original.docId)).identity).toEqual(f.original.identity)
})

it('rejects a corrupted restored payload and cancellation before changing the private database', async () => {
  const f = await fixture(), snapshot = await f.capture()
  await snapshot.restore()
  const before = await readFile(join(f.locations.stateRoot, 'metadata.sqlite'))
  await writeFile(f.original.path, 'changed data')
  await expect(restoreDocumentIdentityBackup(f.locations, snapshot.entries)).rejects.toThrow()
  const controller = new AbortController(), reason = new Error('restore lease ended')
  controller.abort(reason)
  await expect(restoreDocumentIdentityBackup(f.locations, snapshot.entries, controller.signal)).rejects.toBe(reason)
  expect(await readFile(join(f.locations.stateRoot, 'metadata.sqlite'))).toEqual(before)
})
