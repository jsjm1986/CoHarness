/** Ordinary paths, retained object links and real SQLite recovery must describe the same document incarnation. */
import { randomUUID } from 'node:crypto'
import fs, { mkdirSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { link, lstat, mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocTrashId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { DocumentFileAnchor } from '../src/file-object.ts'
import { DocumentIdentityStore, type DocumentIdentityRecord } from '../src/identity.ts'
import { DocumentMutationExecutor } from '../src/mutation.ts'
import { DocumentIdentityStorage } from '../src/identity-storage.ts'
import { withDirectoryRenameInterleave } from './fixtures/directory-native-interleave.mjs'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-document-mutation-')), root = join(base, 'documents')
  await mkdir(root)
  let db: DatabaseSync | undefined
  onTestFinished(async () => { db?.close(); await rm(base, { recursive: true, force: true }) })
  const storage = await DocumentIdentityStorage.open({ root, stateRoot: join(base, 'state'), filesRoot: join(base, 'files') })
  const filename = storage.databasePath
  await writeFile(filename, '', { mode: 0o600 })
  const open = () => {
    db?.close()
    db = new DatabaseSync(filename)
    const store = new DocumentIdentityStore(root, db)
    return { store, executor: new DocumentMutationExecutor(storage, store) }
  }
  let current = open()
  await current.executor.recover()
  const partial = async (path = 'report.txt', actor = 'user:1') => {
    const leaf = `.incoming/${randomUUID()}.part`
    await mkdir(join(storage.locations.filesRoot, '.incoming'), { recursive: true })
    await writeFile(join(storage.locations.filesRoot, leaf), 'same bytes')
    return { kind: 'publish' as const, source: leaf, document: {
      incarnationId: UserDocIncarnationId(randomUUID()), docId: UserDocId(path), createdBy: UserDocUploadOwnerId(actor),
      origin: 'upload' as const, bytes: 10, mediaType: 'text/plain', modifiedAt: Number((await stat(join(storage.locations.filesRoot, leaf), { bigint: true })).mtimeNs) / 1e6,
    } }
  }
  const publish = async (path?: string, actor?: string) => current.executor.run(await partial(path, actor))
  const trash = async (record: DocumentIdentityRecord) => current.executor.run({ kind: 'trash', expected: record,
    trashId: UserDocTrashId(randomUUID()), trashedAt: 10, purgeAfter: 20 })
  return { root, storage, partial, publish, trash, get store() { return current.store }, get executor() { return current.executor },
    legacyJournal() {
      const move = current.store.pending()?.directoryMove
      if (db === undefined || move === undefined) throw new Error('Legacy journal fixture requires a live directory intent.')
      db.prepare('UPDATE document_identity_pending SET directory_move=?')
        .run(JSON.stringify({ from: move.from, to: move.to, marker: move.marker }))
      db.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
        ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=2`)
    },
    reopen() { current = open(); return current } }
}

it('retains multiple trash actions alongside a same-name active upload with its own creator', async () => {
  const f = await fixture()
  const first = await f.trash(await f.publish())
  const second = await f.trash(await f.publish('report.txt', 'user:2'))
  const active = await f.publish('report.txt', 'user:3')
  expect(f.store.list().map(record => record.state).sort()).toEqual(['active', 'trash', 'trash'])
  expect(f.store.active(active.docId)?.createdBy).toBe('user:3')
  expect(new Set([first.incarnationId, second.incarnationId, active.incarnationId]).size).toBe(3)
  expect(await readFile(join(f.storage.locations.filesRoot, 'trash', `${String(first.trash!.trashId)}.bin`), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.storage.locations.filesRoot, 'trash', `${String(second.trash!.trashId)}.bin`), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.root, active.docId), 'utf8')).toBe('same bytes')
  expect(await readdir(join(f.storage.locations.filesRoot, 'anchors'))).toEqual([])
  expect(await readdir(join(f.storage.locations.filesRoot, 'removed'))).toEqual([])
})

it('restores one chosen action under another name without consuming the other same-name trash', async () => {
  const f = await fixture()
  const first = await f.trash(await f.publish())
  const other = await f.trash(await f.publish('report.txt', 'user:2'))
  const active = await f.publish('report.txt', 'user:3')
  const restored = await f.executor.run({ kind: 'restore', expected: first, trashId: first.trash!.trashId, target: UserDocId('restored.txt') })
  expect(restored).toMatchObject({ incarnationId: first.incarnationId, createdBy: 'user:1', revision: 3, docId: 'restored.txt' })
  expect(f.store.get(other.incarnationId)?.state).toBe('trash')
  expect(f.store.active(active.docId)?.incarnationId).toBe(active.incarnationId)
  const retrash = await f.trash(restored)
  await expect(f.executor.run({ kind: 'purge', expected: retrash, trashId: first.trash!.trashId })).rejects.toThrow('no longer recoverable')
  expect(await readFile(join(f.storage.locations.filesRoot, 'trash', `${String(retrash.trash!.trashId)}.bin`), 'utf8')).toBe('same bytes')
})

it('purges the selected object and retains its immutable history while a new upload reuses the name', async () => {
  const f = await fixture()
  const old = await f.trash(await f.publish())
  const purged = await f.executor.run({ kind: 'purge', expected: old, trashId: old.trash!.trashId })
  expect(purged.state).toBe('purged')
  await expect(stat(join(f.storage.locations.filesRoot, 'trash', `${String(old.trash!.trashId)}.bin`))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(f.storage.locations.filesRoot, 'objects', `${String(old.incarnationId)}.object`)))
    .rejects.toMatchObject({ code: 'ENOENT' })
  const next = await f.publish('report.txt', 'user:2')
  expect(f.store.get(old.incarnationId)?.state).toBe('purged')
  expect(f.store.active(next.docId)?.incarnationId).toBe(next.incarnationId)
})

it('preserves the creator on in-place edits and moves, refusing earlier authorization snapshots', async () => {
  const f = await fixture()
  const old = await f.publish()
  await writeFile(join(f.root, old.docId), 'edited bytes')
  const info = await stat(join(f.root, old.docId))
  const edited = await f.executor.run({ kind: 'observe', expected: old, bytes: info.size, modifiedAt: info.mtimeMs, mediaType: 'text/plain' })
  const moved = await f.executor.run({ kind: 'move', expected: edited, target: UserDocId('moved.txt') })
  expect(moved).toMatchObject({ incarnationId: old.incarnationId, revision: 3, bytes: 12, createdBy: old.createdBy })
  await expect(f.executor.run({ kind: 'trash', expected: old, trashId: UserDocTrashId(randomUUID()), trashedAt: 10, purgeAfter: 20 }))
    .rejects.toThrow()
  expect(await readFile(join(f.root, 'moved.txt'), 'utf8')).toBe('edited bytes')
})

it('refuses an identical-byte replacement and keeps it intact while retiring the earlier missing incarnation', async () => {
  const f = await fixture()
  const old = await f.publish()
  await unlink(join(f.root, old.docId))
  await writeFile(join(f.root, old.docId), 'same bytes')
  await expect(f.trash(old)).rejects.toThrow('file object changed')
  expect(f.store.get(old.incarnationId)).toEqual(old)
  const missing = await f.executor.run({ kind: 'missing', expected: old })
  expect(missing.state).toBe('missing')
  expect(await readFile(join(f.root, old.docId), 'utf8')).toBe('same bytes')
  const { createdBy: _creator, ...unowned } = old
  const adopted = await f.executor.run({ kind: 'adopt', document: { ...unowned, incarnationId: UserDocIncarnationId(randomUUID()), origin: 'legacy' } })
  expect(adopted.createdBy).toBeUndefined()
  expect(adopted.incarnationId).not.toBe(old.incarnationId)
})

it('does not retire an incarnation whose original file remains active', async () => {
  const f = await fixture(), old = await f.publish()
  await expect(f.executor.run({ kind: 'missing', expected: old })).rejects.toThrow('still present')
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(old.docId)).toEqual(old)
})

it('does not adopt an unrelated same-size target as a completed publication', async () => {
  const f = await fixture(), change = await f.partial()
  await writeFile(join(f.root, change.document.docId), 'same bytes')
  await expect(f.executor.run(change)).rejects.toThrow('target is occupied')
  expect(f.store.list()).toEqual([])
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(f.storage.locations.filesRoot, change.source), 'utf8')).toBe('same bytes')
})

it('cleans a first-publication collision without pinning the root mutation slot', async () => {
  const f = await fixture(), change = await f.partial()
  // The saved method is called below with the fixture's explicit receiver.
  // oxlint-disable-next-line typescript/unbound-method -- the interception retains its original instance through call().
  const original = DocumentFileAnchor.prototype.publish
  const spy = vi.spyOn(DocumentFileAnchor.prototype, 'publish').mockImplementation(async function (this: DocumentFileAnchor, path) {
    if (path === join(f.root, change.document.docId)) await writeFile(path, 'foreign')
    return original.call(this, path)
  })
  try { await expect(f.executor.run(change)).rejects.toThrow('another file object') } finally { spy.mockRestore() }
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.list()).toEqual([])
  expect(await readFile(join(f.root, change.document.docId), 'utf8')).toBe('foreign')
  expect(await readFile(join(f.storage.locations.filesRoot, change.source), 'utf8')).toBe('same bytes')
  await f.publish('other.txt')
})

it.each([false, true])('abandons an intent that never entered ordinary file work, with anchor=%s', async (capture) => {
  const f = await fixture(), change = await f.partial()
  await DocumentFileAnchor.withSource(f.storage, join(f.storage.locations.filesRoot, change.source), async (source) => {
    const prepared = f.store.prepare(change, source.identity)
    if (capture) await source.capture({ sequence: prepared.sequence, incarnationId: change.document.incarnationId })
  })
  f.reopen()
  await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.list()).toEqual([])
  await expect(stat(join(f.root, change.document.docId))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(f.storage.locations.filesRoot, change.source), 'utf8')).toBe('same bytes')
  await f.executor.run(change)
})

it('recovers a retained source after reopening without inferring its identity from the target bytes', async () => {
  const f = await fixture(), change = await f.partial()
  await DocumentFileAnchor.withSource(f.storage, join(f.storage.locations.filesRoot, change.source), async (source) => {
    const prepared = f.store.prepare(change, source.identity)
    await source.capture({ sequence: prepared.sequence, incarnationId: change.document.incarnationId })
    f.store.retain(prepared)
  })
  f.reopen(); await f.executor.recover()
  expect(f.store.active(change.document.docId)?.incarnationId).toBe(change.document.incarnationId)
  expect(await readFile(join(f.root, change.document.docId), 'utf8')).toBe('same bytes')
  await expect(stat(join(f.storage.locations.filesRoot, change.source))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('preserves all copies when retained recovery evidence is missing', async () => {
  const f = await fixture(), change = await f.partial()
  await DocumentFileAnchor.withSource(f.storage, join(f.storage.locations.filesRoot, change.source), async (source) => {
    const prepared = f.store.prepare(change, source.identity)
    f.store.retain(prepared)
  })
  f.reopen()
  await expect(f.executor.recover()).rejects.toThrow('evidence is missing')
  expect(f.store.pending()?.phase).toBe('retained')
  expect(await readFile(join(f.storage.locations.filesRoot, change.source), 'utf8')).toBe('same bytes')
  await expect(stat(join(f.root, change.document.docId))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('recovers a file publication after physical removal succeeds and SQLite commit fails', async () => {
  const f = await fixture(), change = await f.partial()
  const failure = new Error('Owned metadata commit interruption')
  const spy = vi.spyOn(f.store, 'commit').mockImplementation(() => { throw failure })
  try { await expect(f.executor.run(change)).rejects.toBe(failure) } finally { spy.mockRestore() }
  expect(f.store.pending()?.phase).toBe('retained')
  expect(await readFile(join(f.root, change.document.docId), 'utf8')).toBe('same bytes')
  await writeFile(join(f.storage.locations.filesRoot, change.source), 'new private file')
  f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(change.document.docId)?.incarnationId).toBe(change.document.incarnationId)
  expect(await readFile(join(f.storage.locations.filesRoot, change.source), 'utf8')).toBe('new private file')
})

it('does not remove a new active source path while recovering a committed trash cleanup', async () => {
  const f = await fixture(), original = await f.publish()
  const spy = vi.spyOn(DocumentFileAnchor.prototype, 'removePrivate').mockRejectedValueOnce(new Error('Owned cleanup interruption'))
  try { await expect(f.trash(original)).rejects.toThrow('Owned cleanup interruption') } finally { spy.mockRestore() }
  expect(f.store.pending()?.phase).toBe('committed')
  await writeFile(join(f.root, original.docId), 'replacement')
  f.reopen(); await f.executor.recover()
  expect(f.store.get(original.incarnationId)?.state).toBe('trash')
  expect(await readFile(join(f.root, original.docId), 'utf8')).toBe('replacement')
})

it('finishes committed recovery after anchor release without reexamining ordinary paths', async () => {
  const f = await fixture(), change = await f.partial()
  const spy = vi.spyOn(f.store, 'finish').mockImplementation(() => { throw new Error('Owned final journal interruption') })
  try { await expect(f.executor.run(change)).rejects.toThrow('Owned final journal interruption') } finally { spy.mockRestore() }
  expect(f.store.pending()?.phase).toBe('committed')
  await unlink(join(f.root, change.document.docId)); await writeFile(join(f.root, change.document.docId), 'replacement')
  f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(f.root, change.document.docId), 'utf8')).toBe('replacement')
})

it('serializes separate metadata connections sharing one document root', async () => {
  const f = await fixture(), first = await f.partial(), second = await f.partial()
  const db = new DatabaseSync(f.storage.databasePath)
  onTestFinished(() => { db.close() })
  const other = new DocumentMutationExecutor(f.storage, new DocumentIdentityStore(f.root, db))
  const results = await Promise.allSettled([f.executor.run(first), other.run(second)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  expect(f.store.list()).toHaveLength(1)
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(f.root, first.document.docId), 'utf8')).toBe('same bytes')
})

it('renames a directory with all document identities and empty nested directories preserved', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder', 'nested', 'empty'), { recursive: true })
  const first = await f.publish('folder/a.txt'), second = await f.publish('folder/nested/b.txt', 'user:2')
  const moved = await f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first, second])
  expect(moved.map(record => record.docId).sort()).toEqual(['renamed/a.txt', 'renamed/nested/b.txt'])
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(f.store.active(UserDocId('renamed/nested/b.txt'))?.createdBy).toBe('user:2')
  expect((await stat(join(f.root, 'renamed', 'nested', 'empty'))).isDirectory()).toBe(true)
  expect((await readdir(join(f.root, 'renamed'))).sort()).toEqual(['a.txt', 'nested'])
  await expect(stat(join(f.root, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.store.pending()).toBeUndefined()
})

it('renames an empty directory through the same durable directory proof', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'empty'))
  await expect(f.executor.renameDirectory(UserDocDirectoryId('empty'), UserDocDirectoryId('renamed'), [])).resolves.toEqual([])
  expect(await readdir(join(f.root, 'renamed'))).toEqual([])
  expect(f.store.pending()).toBeUndefined()
})

it('refuses a new untracked directory file and recovers the unused intent without moving it', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  await writeFile(join(f.root, 'folder', 'b.txt'), 'not authorized')
  await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
    .rejects.toThrow('inventory changed')
  expect(f.store.pending()?.phase).toBe('prepared')
  f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(f.root, 'folder', 'a.txt'), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.root, 'folder', 'b.txt'), 'utf8')).toBe('not authorized')
  await expect(stat(join(f.root, 'renamed'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses a directory document replaced by identical bytes after authorization', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  await unlink(join(f.root, first.docId)); await writeFile(join(f.root, first.docId), 'same bytes')
  await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
    .rejects.toThrow('replaced since authorization')
  await f.executor.recover()
  expect(f.store.get(first.incarnationId)).toEqual(first)
  expect(await readFile(join(f.root, first.docId), 'utf8')).toBe('same bytes')
})

it.each(['inventory', 'destination'] as const)('cancels a retained directory intent when its %s changes before rename', async (changed) => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const retain = f.store.retain.bind(f.store)
  const spy = vi.spyOn(f.store, 'retain').mockImplementation((pending) => {
    const result = retain(pending)
    if (changed === 'inventory') writeFileSync(join(f.root, 'folder', 'new.txt'), 'concurrent bytes')
    else {
      mkdirSync(join(f.root, 'renamed'))
      writeFileSync(join(f.root, 'renamed', 'foreign.txt'), 'foreign bytes')
    }
    return result
  })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow(changed === 'inventory' ? 'inventory changed' : 'became occupied')
  } finally { spy.mockRestore() }
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.get(first.incarnationId)).toEqual(first)
  expect(await readFile(join(f.root, first.docId), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.root, changed === 'inventory' ? 'folder/new.txt' : 'renamed/foreign.txt'), 'utf8'))
    .toBe(changed === 'inventory' ? 'concurrent bytes' : 'foreign bytes')
  if (changed === 'inventory') await expect(stat(join(f.root, 'renamed'))).rejects.toMatchObject({ code: 'ENOENT' })
  f.reopen(); await f.executor.recover()
  const next = await f.publish('next.txt')
  expect(f.store.active(UserDocId('next.txt'))?.incarnationId).toBe(next.incarnationId)
  const delivered = f.store.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 100, maxBytes: 1_000_000 })
  expect(delivered.changes.map(change => [change.action, change.document.docId])).toEqual([
    ['publish', 'folder/a.txt'], ['publish', 'next.txt'],
  ])
  expect(delivered.changes[1]?.previous).toEqual(delivered.changes[0]?.cursor)
})

it.each(['journal', 'marker-cleanup'] as const)('recovers a cancelled directory after %s fails without losing the foreign destination', async (failure) => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const retain = f.store.retain.bind(f.store)
  const interruption = new Error('Owned cancellation interruption')
  const retainSpy = vi.spyOn(f.store, 'retain').mockImplementation((pending) => {
    const result = retain(pending)
    mkdirSync(join(f.root, 'renamed'))
    writeFileSync(join(f.root, 'renamed', 'foreign.txt'), 'foreign bytes')
    return result
  })
  const cleanupSpy = failure === 'journal'
    ? vi.spyOn(f.store, 'cancelDirectory').mockImplementationOnce(() => { throw interruption })
    : vi.spyOn(DocumentFileAnchor.prototype, 'removePrivate').mockRejectedValueOnce(interruption)
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'The directory destination became occupied.' }), interruption] })
  } finally { retainSpy.mockRestore(); cleanupSpy.mockRestore() }
  expect(f.store.pending()?.phase).toBe(failure === 'journal' ? 'retained' : 'prepared')
  f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.get(first.incarnationId)).toEqual(first)
  expect(await readFile(join(f.root, first.docId), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.root, 'renamed', 'foreign.txt'), 'utf8')).toBe('foreign bytes')
  expect(await readdir(join(f.storage.locations.filesRoot, 'anchors'))).toEqual([])
  expect(await readdir(join(f.storage.locations.filesRoot, 'removed'))).toEqual([])
  const next = await f.publish('next.txt')
  expect(f.store.active(UserDocId('next.txt'))?.incarnationId).toBe(next.incarnationId)
})

it('cancels directory selection when an admitted file changes before physical rename', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const retain = f.store.retain.bind(f.store)
  const spy = vi.spyOn(f.store, 'retain').mockImplementation((pending) => {
    const result = retain(pending)
    writeFileSync(join(f.root, first.docId), 'concurrent edit')
    return result
  })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('changed after authorization')
  } finally { spy.mockRestore() }
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(f.root, first.docId), 'utf8')).toBe('concurrent edit')
  await expect(stat(join(f.root, 'renamed'))).rejects.toMatchObject({ code: 'ENOENT' })
  f.reopen(); await f.executor.recover()
  await f.publish('next.txt')
})

it('recovers a directory moved before metadata commit without touching a recreated source folder', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const spy = vi.spyOn(f.store, 'commit').mockImplementation(() => { throw new Error('Owned directory commit interruption') })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('Owned directory commit interruption')
  } finally { spy.mockRestore() }
  expect(f.store.pending()?.phase).toBe('retained')
  expect(f.store.active(first.docId)?.docId).toBe(first.docId)
  await mkdir(join(f.root, 'folder')); await writeFile(join(f.root, 'folder', 'replacement.txt'), 'new folder')
  f.reopen(); await f.executor.recover()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(await readFile(join(f.root, 'folder', 'replacement.txt'), 'utf8')).toBe('new folder')
  expect(await readdir(join(f.root, 'renamed'))).toEqual(['a.txt'])
  expect(f.store.pending()).toBeUndefined()
})

it.skipIf(process.platform === 'win32').each(['capture', 'publication'] as const)(
  'retries directory durability after native %s before committing metadata', async (boundary) => {
    const f = await fixture()
    await mkdir(join(f.root, 'folder'))
    const first = await f.publish('folder/a.txt')
    const original = fs.fsync, interrupted = Object.assign(new Error('Owned directory sync failure'), { code: 'EIO' })
    let armed = false
    fs.fsync = Object.assign((...args: Parameters<typeof original>) => {
      if (armed) args[1](interrupted)
      else original(...args)
    }, original)
    syncBuiltinESMExports()
    try {
      await withDirectoryRenameInterleave(async (_from, to) => {
        if (boundary === 'capture' ? basename(to).endsWith('.stage') : basename(to) === 'renamed') armed = true
      }, async () => {
        await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
          .rejects.toBe(interrupted)
      })
      expect(armed).toBe(true)
      const pending = f.store.pending()
      expect(pending).toMatchObject({ phase: 'retained', directoryMove: { captured: boundary === 'publication' } })
      expect(f.store.get(first.incarnationId)).toEqual(first)
      const retained = boundary === 'capture'
        ? join(f.storage.locations.filesRoot, 'directories', `${String(pending?.sequence)}.stage`, 'a.txt')
        : join(f.root, 'renamed', 'a.txt')
      expect(await readFile(retained, 'utf8')).toBe('same bytes')
      await expect(f.executor.recover()).rejects.toBe(interrupted)
      expect(f.store.pending()?.phase).toBe('retained')
    } finally { fs.fsync = original; syncBuiltinESMExports() }
    f.reopen(); await f.executor.recover()
    expect(f.store.pending()).toBeUndefined()
    expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  },
)

it('joins committed directory cleanup and preserves later replacement paths', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const spy = vi.spyOn(DocumentFileAnchor.prototype, 'removePrivate').mockRejectedValueOnce(new Error('Owned directory cleanup interruption'))
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('Owned directory cleanup interruption')
  } finally { spy.mockRestore() }
  expect(f.store.pending()?.phase).toBe('committed')
  f.reopen(); await f.executor.recover()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(await readdir(join(f.root, 'renamed'))).toEqual(['a.txt'])
  expect(await readdir(join(f.storage.locations.filesRoot, 'anchors'))).toEqual([])
  expect(await readdir(join(f.storage.locations.filesRoot, 'removed'))).toEqual([])
})

it('preserves an occupied directory destination and every source document', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder')); await mkdir(join(f.root, 'renamed'))
  const first = await f.publish('folder/a.txt')
  await writeFile(join(f.root, 'renamed', 'b.txt'), 'occupied')
  await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
    .rejects.toThrow('target is occupied')
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(f.root, 'folder', 'a.txt'), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.root, 'renamed', 'b.txt'), 'utf8')).toBe('occupied')
})

it('preserves an empty destination created after the final directory inventory check', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  let entered = 0, destinationInode: bigint | undefined
  await withDirectoryRenameInterleave(async (from, to) => {
    if (basename(from).endsWith('.stage') && basename(to) === 'renamed') {
      entered += 1
      await mkdir(join(f.root, 'renamed'))
      destinationInode = (await stat(join(f.root, 'renamed'), { bigint: true })).ino
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow()
  })
  expect(entered).toBe(1)
  expect(destinationInode).toBeDefined()
  expect((await stat(join(f.root, 'renamed'), { bigint: true })).ino).toBe(destinationInode)
  expect(await readdir(join(f.root, 'renamed'))).toEqual([])
  expect(await readFile(join(f.root, first.docId), 'utf8')).toBe('same bytes')
  expect(f.store.get(first.incarnationId)).toEqual(first)
  await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
})

it('preserves a replacement source directory at the native rename boundary', async () => {
  const f = await fixture()
  const source = join(f.root, 'folder'), held = join(f.root, 'held-original')
  await mkdir(source)
  const first = await f.publish('folder/a.txt')
  let swapped = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!swapped && basename(from) === 'folder') {
      await rename(source, held)
      await mkdir(source)
      await writeFile(join(source, 'foreign.txt'), 'unrelated bytes')
      swapped = true
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow()
  })
  expect(swapped).toBe(true)
  expect(await readFile(join(source, 'foreign.txt'), 'utf8')).toBe('unrelated bytes')
  expect(await readFile(join(held, 'a.txt'), 'utf8')).toBe('same bytes')
  await expect(stat(join(f.root, 'renamed'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.store.get(first.incarnationId)).toEqual(first)
  expect(f.store.pending()).toBeUndefined()
  await rename(source, join(f.root, 'unrelated'))
  await rename(held, source)
  f.reopen(); await f.executor.recover()
  await f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first])
  expect(await readdir(join(f.root, 'renamed'))).toEqual(['a.txt'])
  expect(await readFile(join(f.root, 'unrelated', 'foreign.txt'), 'utf8')).toBe('unrelated bytes')
  expect(await readdir(join(f.storage.locations.filesRoot, 'anchors'))).toEqual([])
  expect(await readdir(join(f.storage.locations.filesRoot, 'directories'))).toEqual([])
})

it('restores a regular file substituted for the source immediately before native capture', async () => {
  const f = await fixture(), source = join(f.root, 'folder'), held = join(f.root, 'held-original')
  await mkdir(source)
  const first = await f.publish('folder/a.txt')
  let substituted = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!substituted && basename(from) === 'folder') {
      await rename(source, held); await writeFile(source, 'foreign file'); substituted = true
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('source changed')
  })
  expect(substituted).toBe(true)
  expect(await readFile(source, 'utf8')).toBe('foreign file')
  expect(await readFile(join(held, 'a.txt'), 'utf8')).toBe('same bytes')
  expect(f.store.pending()).toBeUndefined()
  f.reopen(); await f.executor.recover()
  expect(f.store.get(first.incarnationId)).toEqual(first)
})

it.skipIf(process.platform === 'win32')('restores a substituted directory symlink without following its external target', async () => {
  const f = await fixture(), source = join(f.root, 'folder'), held = join(f.root, 'held-original')
  const outside = join(f.storage.locations.filesRoot, 'outside')
  await mkdir(source); await mkdir(outside); await writeFile(join(outside, 'foreign.txt'), 'outside bytes')
  const first = await f.publish('folder/a.txt')
  let substituted = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!substituted && basename(from) === 'folder') {
      await rename(source, held); await symlink(outside, source, 'dir'); substituted = true
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('source changed')
  })
  expect(substituted).toBe(true)
  expect((await lstat(source)).isSymbolicLink()).toBe(true)
  expect(await readdir(outside)).toEqual(['foreign.txt'])
  expect(await readFile(join(outside, 'foreign.txt'), 'utf8')).toBe('outside bytes')
  expect(f.store.pending()).toBeUndefined()
})

it.each([false, true])('refuses another directory carrying the original marker and file objects: files=%s', async (hasFile) => {
  const f = await fixture(), source = join(f.root, 'folder'), held = join(f.root, 'held-original')
  await mkdir(source)
  const first = hasFile ? await f.publish('folder/a.txt') : undefined
  let substituted = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!substituted && basename(from) === 'folder') {
      await rename(source, held)
      await mkdir(source)
      if (hasFile) await link(join(held, 'a.txt'), join(source, 'a.txt'))
      const marker = (await readdir(held)).find(name => name.startsWith('.dsh-directory-'))
      expect(marker).toBeDefined()
      await rename(join(held, String(marker)), join(source, String(marker)))
      substituted = true
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), first === undefined ? [] : [first]))
      .rejects.toThrow('directory object changed')
  })
  expect(substituted).toBe(true)
  expect(await readdir(source)).toEqual(hasFile ? ['a.txt'] : [])
  expect(await readdir(held)).toEqual(hasFile ? ['a.txt'] : [])
  await expect(stat(join(f.root, 'renamed'))).rejects.toHaveProperty('code', 'ENOENT')
  expect(f.store.pending()).toBeUndefined()
  expect(await readdir(join(f.storage.locations.filesRoot, 'anchors'))).toEqual([])
})

it('recovers a privately captured directory after its durable capture marker fails', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt'), interruption = new Error('Owned capture record interruption')
  const spy = vi.spyOn(f.store, 'captureDirectory').mockImplementationOnce(() => { throw interruption })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first])).rejects.toBe(interruption)
  } finally { spy.mockRestore() }
  expect(f.store.pending()).toMatchObject({ phase: 'retained', directoryMove: { captured: false } })
  await expect(stat(join(f.root, 'folder'))).rejects.toHaveProperty('code', 'ENOENT')
  await expect(stat(join(f.root, 'renamed'))).rejects.toHaveProperty('code', 'ENOENT')
  f.reopen(); await f.executor.recover()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(await readdir(join(f.root, 'renamed'))).toEqual(['a.txt'])
})

it('retains private bytes when occupied source and destination prevent publication and rollback', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  let blocked = false
  await withDirectoryRenameInterleave(async (from, to) => {
    if (!blocked && basename(from).endsWith('.stage') && basename(to) === 'renamed') {
      blocked = true
      await mkdir(join(f.root, 'folder')); await writeFile(join(f.root, 'folder', 'foreign.txt'), 'source occupant')
      await mkdir(join(f.root, 'renamed')); await writeFile(join(f.root, 'renamed', 'foreign.txt'), 'target occupant')
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toMatchObject({ errors: [expect.any(Error), expect.any(Error)] })
  })
  expect(blocked).toBe(true)
  expect(f.store.pending()).toMatchObject({ phase: 'retained', directoryMove: { captured: true } })
  f.reopen()
  await expect(f.executor.recover()).rejects.toBeInstanceOf(AggregateError)
  expect(await readFile(join(f.root, 'folder', 'foreign.txt'), 'utf8')).toBe('source occupant')
  expect(await readFile(join(f.root, 'renamed', 'foreign.txt'), 'utf8')).toBe('target occupant')
  await rename(join(f.root, 'folder'), join(f.root, 'other-source'))
  await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.get(first.incarnationId)).toEqual(first)
  expect(await readFile(join(f.root, 'folder', 'a.txt'), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.root, 'other-source', 'foreign.txt'), 'utf8')).toBe('source occupant')
  expect(await readFile(join(f.root, 'renamed', 'foreign.txt'), 'utf8')).toBe('target occupant')
})

it('keeps a capture journal when an externally moved publication has no known marker location', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const spy = vi.spyOn(f.store, 'commit').mockImplementationOnce(() => { throw new Error('Owned publication interruption') })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('Owned publication interruption')
  } finally { spy.mockRestore() }
  await rename(join(f.root, 'renamed'), join(f.root, 'externally-moved'))
  f.reopen()
  await expect(f.executor.recover()).rejects.toThrow('cannot be located')
  expect(f.store.pending()?.directoryMove?.captured).toBe(true)
  expect(await readFile(join(f.root, 'externally-moved', 'a.txt'), 'utf8')).toBe('same bytes')
  await rename(join(f.root, 'externally-moved'), join(f.root, 'renamed'))
  await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.createdBy).toBe('user:1')
})

it('refuses another published directory even when it carries the original private marker', async () => {
  const f = await fixture(), target = join(f.root, 'renamed'), held = join(f.root, 'held-target')
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const spy = vi.spyOn(f.store, 'commit').mockImplementationOnce(() => { throw new Error('Owned publication interruption') })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('Owned publication interruption')
  } finally { spy.mockRestore() }
  await rename(target, held); await mkdir(target); await writeFile(join(target, 'foreign.txt'), 'foreign directory')
  const marker = (await readdir(held)).find(name => name.startsWith('.dsh-directory-'))
  expect(marker).toBeDefined()
  await rename(join(held, String(marker)), join(target, String(marker)))
  f.reopen()
  await expect(f.executor.recover()).rejects.toThrow('published directory object changed')
  expect(f.store.pending()?.directoryMove?.captured).toBe(true)
  expect(await readFile(join(target, 'foreign.txt'), 'utf8')).toBe('foreign directory')
  expect(await readFile(join(held, 'a.txt'), 'utf8')).toBe('same bytes')
  await rename(target, join(f.root, 'foreign-target')); await rename(held, target)
  await rename(join(f.root, 'foreign-target', String(marker)), join(target, String(marker)))
  await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
})

it('requires original file evidence before settling a legacy publication without a recorded directory object', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const spy = vi.spyOn(f.store, 'commit').mockImplementationOnce(() => { throw new Error('Owned legacy publication interruption') })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('Owned legacy publication interruption')
  } finally { spy.mockRestore() }
  const path = join(f.root, 'renamed', 'a.txt')
  await writeFile(join(f.root, 'editor.part'), 'legacy editor bytes'); await rename(join(f.root, 'editor.part'), path)
  f.legacyJournal(); f.reopen()
  await expect(f.executor.recover()).rejects.toThrow('replaced since authorization')
  expect(f.store.pending()?.directoryMove?.source).toBeNull()
  expect(await readFile(path, 'utf8')).toBe('legacy editor bytes')
  await rename(path, join(f.root, 'retained-editor.txt'))
  await link(join(f.storage.locations.filesRoot, 'objects', `${String(first.incarnationId)}.object`), path)
  await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.createdBy).toBe('user:1')
  expect(await readFile(join(f.root, 'retained-editor.txt'), 'utf8')).toBe('legacy editor bytes')
})

it('recovers a restored capture after cancellation journaling fails following a destination collision', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt'), interruption = new Error('Owned rollback cancellation interruption')
  const spy = vi.spyOn(f.store, 'cancelDirectory').mockImplementationOnce(() => { throw interruption })
  let collided = false
  try {
    await withDirectoryRenameInterleave(async (from, to) => {
      if (!collided && basename(from).endsWith('.stage') && basename(to) === 'renamed') {
        await mkdir(join(f.root, 'renamed')); collided = true
      }
    }, async () => {
      await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
        .rejects.toMatchObject({ errors: [expect.any(Error), interruption] })
    })
  } finally { spy.mockRestore() }
  expect(collided).toBe(true)
  expect(f.store.pending()?.directoryMove?.captured).toBe(true)
  expect(await readFile(join(f.root, 'folder', 'a.txt'), 'utf8')).toBe('same bytes')
  f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.get(first.incarnationId)).toEqual(first)
  expect(await readdir(join(f.root, 'renamed'))).toEqual([])
})

it.each(['capture', 'publication'] as const)('restores the selected directory after an exclusive %s fails before its native call', async (boundary) => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt'), interruption = Object.assign(new Error('Owned native invocation failure'), { code: 'EIO' })
  let interrupted = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!interrupted && (boundary === 'capture' ? basename(from) === 'folder' : basename(from).endsWith('.stage'))) {
      interrupted = true; throw interruption
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first])).rejects.toBe(interruption)
  })
  expect(interrupted).toBe(true)
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(f.root, 'folder', 'a.txt'), 'utf8')).toBe('same bytes')
  await expect(stat(join(f.root, 'renamed'))).rejects.toHaveProperty('code', 'ENOENT')
  f.reopen(); await f.executor.recover()
  await f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first])
})

it('preserves a verified private capture replaced by an unrelated file until its original directory is restored', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt'), capture = f.store.captureDirectory.bind(f.store)
  const spy = vi.spyOn(f.store, 'captureDirectory').mockImplementationOnce((pending, source) => {
    capture(pending, source); throw new Error('Owned post-capture interruption')
  })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('Owned post-capture interruption')
  } finally { spy.mockRestore() }
  const stage = join(f.storage.locations.filesRoot, 'directories', `${String(f.store.pending()?.sequence)}.stage`)
  await rename(stage, `${stage}.retained`); await writeFile(stage, 'private replacement')
  f.reopen()
  await expect(f.executor.recover()).rejects.toThrow('capture changed after verification')
  expect(await readFile(stage, 'utf8')).toBe('private replacement')
  expect(await readFile(join(`${stage}.retained`, 'a.txt'), 'utf8')).toBe('same bytes')
  await rename(stage, `${stage}.foreign`); await rename(`${stage}.retained`, stage)
  await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(await readFile(`${stage}.foreign`, 'utf8')).toBe('private replacement')
})

it('does not recapture a new source when the selected directory moves elsewhere before retained execution', async () => {
  const f = await fixture(), source = join(f.root, 'folder'), held = join(f.root, 'held-original')
  await mkdir(source)
  const first = await f.publish('folder/a.txt'), retain = f.store.retain.bind(f.store)
  const spy = vi.spyOn(f.store, 'retain').mockImplementationOnce((pending) => {
    const result = retain(pending)
    fs.renameSync(source, held); mkdirSync(source); writeFileSync(join(source, 'foreign.txt'), 'foreign bytes')
    return result
  })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('source changed before capture')
  } finally { spy.mockRestore() }
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(source, 'foreign.txt'), 'utf8')).toBe('foreign bytes')
  expect(await readFile(join(held, 'a.txt'), 'utf8')).toBe('same bytes')
})

it('preserves an occupied private capture name and abandons only its unused reservation', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt')
  const directory = join(f.storage.locations.filesRoot, 'directories')
  await mkdir(directory)
  await mkdir(join(directory, '2.stage')); await writeFile(join(directory, '2.stage', 'foreign.txt'), 'private occupant')
  await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
    .rejects.toThrow('capture is occupied')
  expect(f.store.pending()?.phase).toBe('prepared')
  f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(await readFile(join(directory, '2.stage', 'foreign.txt'), 'utf8')).toBe('private occupant')
  expect(await readFile(join(f.root, first.docId), 'utf8')).toBe('same bytes')
  await f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first])
})

it.each(['before-capture', 'published', 'committed'] as const)('recovers a migrated schema 2 directory intent interrupted at %s', async (phase) => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt'), interruption = new Error('Owned legacy directory interruption')
  const retain = f.store.retain.bind(f.store)
  const spy = phase === 'before-capture' ? vi.spyOn(f.store, 'retain').mockImplementationOnce((pending) => {
    retain(pending); throw interruption
  }) : phase === 'published' ? vi.spyOn(f.store, 'commit').mockImplementationOnce(() => { throw interruption })
    : vi.spyOn(DocumentFileAnchor.prototype, 'removePrivate').mockRejectedValueOnce(interruption)
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first])).rejects.toBe(interruption)
  } finally { spy.mockRestore() }
  f.legacyJournal(); f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(await readFile(join(f.root, 'renamed', 'a.txt'), 'utf8')).toBe('same bytes')
  expect(await readdir(join(f.storage.locations.filesRoot, 'anchors'))).toEqual([])
})

it('preserves an ambiguous legacy directory intent instead of treating it as an unused capture', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt'), retain = f.store.retain.bind(f.store)
  const spy = vi.spyOn(f.store, 'retain').mockImplementationOnce((pending) => { retain(pending); throw new Error('Owned legacy interruption') })
  try {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow('Owned legacy interruption')
  } finally { spy.mockRestore() }
  await rename(join(f.root, 'folder'), join(f.root, 'unknown-location'))
  f.legacyJournal(); f.reopen()
  await expect(f.executor.recover()).rejects.toThrow('cannot be located')
  expect(f.store.pending()?.directoryMove).toMatchObject({ source: null, captured: false })
  expect(await readFile(join(f.root, 'unknown-location', 'a.txt'), 'utf8')).toBe('same bytes')
  await rename(join(f.root, 'unknown-location'), join(f.root, 'folder'))
  await f.executor.recover()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
})

it.skipIf(process.platform === 'win32')('preserves outside directories when the source parent changes after inventory validation', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'parent', 'folder'), { recursive: true })
  const first = await f.publish('parent/folder/a.txt')
  const outside = join(f.storage.locations.filesRoot, 'outside'), held = join(f.root, 'held-parent')
  await mkdir(join(outside, 'folder'), { recursive: true })
  await writeFile(join(outside, 'folder', 'foreign.txt'), 'outside bytes')
  let swapped = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!swapped && basename(from) === 'folder') {
      swapped = true
      await rename(join(f.root, 'parent'), held)
      await symlink(outside, join(f.root, 'parent'), 'dir')
    }
  }, async () => {
    await expect(f.executor.renameDirectory(UserDocDirectoryId('parent/folder'), UserDocDirectoryId('renamed'), [first]))
      .rejects.toThrow()
  })
  expect(swapped).toBe(true)
  expect(await readFile(join(outside, 'folder', 'foreign.txt'), 'utf8')).toBe('outside bytes')
  const pending = f.store.pending()
  expect(pending?.phase).toBe('retained')
  expect(await readFile(join(f.storage.locations.filesRoot, 'directories', `${String(pending?.sequence)}.stage`, 'a.txt'), 'utf8'))
    .toBe('same bytes')
  await unlink(join(f.root, 'parent'))
  await rename(held, join(f.root, 'parent'))
  f.reopen(); await f.executor.recover()
  expect(f.store.pending()).toBeUndefined()
  expect(f.store.active(UserDocId('renamed/a.txt'))?.incarnationId).toBe(first.incarnationId)
  expect(await readFile(join(outside, 'folder', 'foreign.txt'), 'utf8')).toBe('outside bytes')
})
