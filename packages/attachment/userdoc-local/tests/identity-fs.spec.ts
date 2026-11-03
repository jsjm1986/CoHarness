/** Real filesystem ownership and SQLite lifetime for identity-aware document operations. */
import { randomUUID } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { copyFile, cp, link, mkdtemp, mkdir, open, readFile, readdir, rm, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import koffi from 'koffi'
import type { KoffiFunc } from 'koffi'
import { UserDocDirectoryId, UserDocId, UserDocIncarnationId, UserDocUploadOwnerId } from '@deepseek-ai/dsh-userdoc'
import { DocumentFileAnchor, type DocumentFileSource } from '../src/file-object.ts'
import type { DocumentIdentityStorage } from '../src/identity-storage.ts'
import type { UserDocBackgroundWrite } from '../src/upload.ts'
import { DocumentIdentityStore } from '../src/identity.ts'
import { DocumentIdentityFs, type IdentifiedUserDocRef, type IdentifiedUserDocTrashRef } from '../src/identity-fs.ts'
import { listTrash, trashDocument } from '../src/trash.ts'
import * as atomic from '@deepseek-ai/dsh-atomic-write'
import { withDirectoryRenameInterleave } from './fixtures/directory-native-interleave.mjs'

function selection(ref: IdentifiedUserDocRef | IdentifiedUserDocTrashRef) {
  return { docId: ref.docId, incarnationId: ref.identity.incarnationId, revision: ref.identity.revision }
}

async function fixture(admit?: UserDocBackgroundWrite) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-document-identity-fs-')), root = join(base, 'documents')
  await mkdir(root)
  const locations = { root, stateRoot: join(base, 'state'), filesRoot: join(base, 'files') }
  const owners: DocumentIdentityFs[] = []
  onTestFinished(async () => {
    await Promise.all(owners.map(owner => owner.dispose()))
    await rm(base, { recursive: true, force: true })
  })
  const open = async () => { const owner = await DocumentIdentityFs.open(locations, admit); owners.push(owner); return owner }
  let current = await open()
  const partial = async (name = 'report.txt', actor = 'user:1') => {
    const path = join(locations.filesRoot, '.upload-sessions', randomUUID(), 'data.part')
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'same bytes')
    return { path, target: { name: basename(name), docId: UserDocId(name), path: join(root, name) }, publication: {
      incarnationId: UserDocIncarnationId(randomUUID()), bytes: 10, origin: 'upload' as const, createdBy: UserDocUploadOwnerId(actor),
    } }
  }
  const publish = async (name?: string, actor?: string) => {
    const p = await partial(name, actor)
    return current.publish(p.target, p.path, p.publication)
  }
  return { root, base, locations, partial, publish, get owner() { return current },
    async reopen() { await current.dispose(); current = await open() } }
}

async function legacyFixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-document-legacy-identity-')), root = join(base, 'documents')
  await mkdir(root)
  const locations = { root, stateRoot: join(base, 'state'), filesRoot: join(base, 'files') }
  const owners: DocumentIdentityFs[] = []
  onTestFinished(async () => {
    await Promise.all(owners.map(owner => owner.dispose()))
    await rm(base, { recursive: true, force: true })
  })
  const docId = UserDocId('legacy.txt')
  await writeFile(join(root, docId), 'legacy bytes')
  const trash = await trashDocument(root, docId, 1000)
  const manifest = join(root, '.dsh-trash', 'manifest.json')
  const old = JSON.parse(await readFile(manifest, 'utf8')) as { records: Array<{ trashPath: string }> }
  const hidden = old.records[0]!.trashPath
  return { root, base, locations, docId, trash, hidden, manifest,
    async open() { const owner = await DocumentIdentityFs.open(locations); owners.push(owner); return owner } }
}

it('refuses a one-shot publication cancelled while runtime file permissions are prepared', async () => {
  const f = await fixture(), partial = await f.partial()
  const abort = new AbortController(), reason = new Error('Publication authority revoked')
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new TextEncoder().encode('one-shot body')); controller.close()
  } })
  await expect(f.owner.save(partial.target, body, {
    maxFileBytes: 65536, maxFilesPerMessage: 5, maxMessageBytes: 131072, maxInlineTextBytes: 8192,
    upload: { protocol: 'resumable-v1', chunkBytes: 1024, sessionTtlMs: 60000, resumable: true },
  }, UserDocUploadOwnerId('user:1'), abort.signal, async () => { abort.abort(reason) })).rejects.toBe(reason)
  await expect(readFile(partial.target.path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.owner.list()).toEqual([])
  expect(await readdir(join(f.locations.filesRoot, 'uploads'))).toEqual([])
})

it.each([false, true])('rejects an interrupted buffered read after source cancellation (cleanup failure: %s)', async (failCleanup) => {
  const f = await fixture(), ref = await f.publish()
  const pulling = Promise.withResolvers<undefined>(), cancelled = Promise.withResolvers<undefined>()
  const releasePull = Promise.withResolvers<undefined>(), releaseCleanup = Promise.withResolvers<undefined>()
  const abort = new AbortController(), reason = new Error('Buffered read cancelled'), cleanup = new Error('Owned source cleanup failed')
  let closed = false
  const opening = vi.spyOn(f.owner, 'openRead').mockResolvedValue({ ref, body: new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2])) },
    pull() { pulling.resolve(undefined); return releasePull.promise },
    async cancel() {
      cancelled.resolve(undefined); await releaseCleanup.promise; closed = true; releasePull.resolve(undefined)
      if (failCleanup) throw cleanup
    },
  }, { highWaterMark: 0 }) })
  let outcome: Promise<PromiseSettledResult<Awaited<ReturnType<DocumentIdentityFs['read']>>>[]> | undefined
  try {
    outcome = Promise.allSettled([f.owner.read(ref.docId, abort.signal)])
    await pulling.promise
    abort.abort(reason); await cancelled.promise
    releaseCleanup.resolve(undefined)
    const [result] = await outcome
    expect(result?.status).toBe('rejected')
    if (result?.status !== 'rejected') throw new Error('Interrupted buffered read returned partial bytes')
    if (failCleanup) expect(result.reason).toMatchObject({ errors: [reason, cleanup] })
    else expect(result.reason).toBe(reason)
    expect(closed).toBe(true)
  } finally {
    releaseCleanup.resolve(undefined); releasePull.resolve(undefined); await outcome; opening.mockRestore()
  }
})

it.each([2, 3, 4])('imports legacy trash and retains a version %s retirement marker without changing its file object or inventing a creator', async (version) => {
  const f = await legacyFixture(), before = await stat(f.hidden, { bigint: true })
  const owner = await f.open(), [trash] = await owner.listTrash()
  expect(trash).toMatchObject({ docId: f.docId, trashedAt: f.trash.trashedAt, purgeAfter: f.trash.purgeAfter,
    identity: { origin: 'legacy', revision: 1 } })
  expect(trash?.identity.createdBy).toBeUndefined()
  const retained = join(f.locations.filesRoot, 'trash', basename(f.hidden))
  const after = await stat(retained, { bigint: true })
  await expect(stat(f.hidden)).rejects.toMatchObject({ code: 'ENOENT' })
  expect([after.dev, after.ino]).toEqual([before.dev, before.ino])
  await owner.dispose()
  const marker = join(f.root, '.dsh-trash', 'manifest.json')
  const retired = JSON.parse(await readFile(marker, 'utf8')) as { identityVersion: number }
  await writeFile(marker, JSON.stringify({ ...retired, identityVersion: version }))
  const restarted = await f.open()
  expect(await restarted.listTrash()).toEqual([trash])
  await expect(listTrash(f.root)).rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
  expect(await readFile(retained, 'utf8')).toBe('legacy bytes')
  const restored = await restarted.restore({ ...selection(trash!), trashId: trash!.trashId })
  expect(restored.identity).toEqual({ ...trash!.identity, revision: 2 })
  expect(await readFile(restored.path, 'utf8')).toBe('legacy bytes')
})

it.each([3, 4])('refuses a schema %s file-by-file copy before changing its identity metadata or document bytes', async (version) => {
  const f = await fixture(), original = await f.publish()
  await f.owner.dispose()
  if (version === 3) {
    const database = new DatabaseSync(join(f.locations.stateRoot, 'metadata.sqlite'))
    try {
      database.exec(`ALTER TABLE document_identity_storage DROP COLUMN documents_volume;
        ALTER TABLE document_identity_storage DROP COLUMN files_volume; PRAGMA user_version=3`)
    } finally { database.close() }
  }
  const copyParent = await mkdtemp(join(tmpdir(), 'dsh-document-unverified-restore-')), copied = join(copyParent, 'snapshot')
  onTestFinished(() => rm(copyParent, { recursive: true, force: true }))
  await cp(f.base, copied, { recursive: true, force: false, errorOnExist: true })
  const locations = { root: join(copied, 'documents'), stateRoot: join(copied, 'state'), filesRoot: join(copied, 'files') }
  const before = await readFile(join(locations.stateRoot, 'metadata.sqlite'))
  await expect(DocumentIdentityFs.open(locations)).rejects.toThrow(version === 3 ? 'binding changed' : 'another metadata domain or database file')
  expect(await readFile(join(locations.stateRoot, 'metadata.sqlite'))).toEqual(before)
  expect(await readFile(join(locations.root, original.docId), 'utf8')).toBe('same bytes')
  await f.reopen()
  expect(await f.owner.stat(original.docId)).toEqual(original)
})

it('refuses an existing connection after its metadata file is replaced', async () => {
  const f = await fixture(), original = await f.publish()
  const database = join(f.locations.stateRoot, 'metadata.sqlite'), copied = join(f.locations.stateRoot, 'replacement.sqlite')
  await copyFile(database, copied)
  await rename(copied, database)
  await expect(f.owner.snapshot()).rejects.toThrow('metadata file changed after it was opened')
  expect(await readFile(original.path, 'utf8')).toBe('same bytes')
})

it('retries an interrupted legacy manifest commit without duplicating its imported trash action', async () => {
  const f = await legacyFixture(), before = await readFile(f.manifest, 'utf8')
  const write = atomic.writeFileAtomic
  const spy = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (path, data, options) => {
    if (path === f.manifest) throw new Error('Owned identity marker interruption')
    return write(path, data, options)
  })
  try { await expect(f.open()).rejects.toThrow('Owned identity marker interruption') } finally { spy.mockRestore() }
  expect(await readFile(f.manifest, 'utf8')).toBe(before)
  expect(await readFile(join(f.locations.filesRoot, 'trash', basename(f.hidden)), 'utf8')).toBe('legacy bytes')
  const owner = await f.open(), trash = await owner.listTrash()
  expect(trash).toHaveLength(1)
  expect(trash[0]?.identity.revision).toBe(1)
})

it('refuses an identity marker paired with a replacement empty database and preserves its retained payload', async () => {
  const f = await legacyFixture(), owner = await f.open()
  const original = await owner.listTrash()
  await owner.dispose()
  const database = join(f.locations.stateRoot, 'metadata.sqlite'), retainedDatabase = join(f.locations.stateRoot, 'retained.sqlite')
  await rename(database, retainedDatabase)
  await expect(f.open()).rejects.toThrow('another metadata domain')
  expect(await readFile(join(f.locations.filesRoot, 'trash', basename(f.hidden)), 'utf8')).toBe('legacy bytes')
  await unlink(database)
  await rename(retainedDatabase, database)
  expect(await (await f.open()).listTrash()).toEqual(original)
})

it('preserves an unindexed legacy payload instead of publishing an incomplete identity manifest', async () => {
  const f = await legacyFixture(), before = await readFile(f.manifest, 'utf8')
  const orphan = join(f.root, '.dsh-trash', `${randomUUID()}.bin`)
  await writeFile(orphan, 'unindexed bytes')
  await expect(f.open()).rejects.toThrow('absent from its recovery manifest')
  expect(await readFile(f.manifest, 'utf8')).toBe(before)
  expect(await readFile(orphan, 'utf8')).toBe('unindexed bytes')
  expect(await readFile(f.hidden, 'utf8')).toBe('legacy bytes')
})

it('keeps two same-name trash actions and the new actor-owned active incarnation across restart', async () => {
  const f = await fixture()
  const first = await f.publish(), trash1 = await f.owner.trash(selection(first), 1000)
  const second = await f.publish('report.txt', 'user:2'), trash2 = await f.owner.trash(selection(second), 1000)
  const active = await f.publish('report.txt', 'user:3')
  await f.reopen()
  expect(await f.owner.listTrash()).toHaveLength(2)
  expect(new Set((await f.owner.listTrash()).map(ref => ref.trashId))).toEqual(new Set([trash1.trashId, trash2.trashId]))
  expect(await f.owner.stat(active.docId)).toEqual(active)
  expect((await f.owner.list())[0]?.identity.createdBy).toBe('user:3')
})

it('publishes a fresh actor-owned incarnation after an external unlink without requiring a previous directory refresh', async () => {
  const f = await fixture(), original = await f.publish()
  await unlink(join(f.root, original.docId))
  const replacement = await f.publish('report.txt', 'user:2')
  expect(replacement.identity.incarnationId).not.toBe(original.identity.incarnationId)
  expect(replacement.identity.createdBy).toBe('user:2')
  const snapshot = await f.owner.snapshot()
  expect(snapshot.documents.find(record => record.incarnationId === original.identity.incarnationId)?.state).toBe('missing')
  expect(await f.owner.stat(replacement.docId)).toEqual(replacement)
})

it('preserves a uniquely moved original before publishing a replacement at its former name', async () => {
  const f = await fixture(), original = await f.publish()
  await rename(join(f.root, original.docId), join(f.root, 'archived.txt'))
  const replacement = await f.publish('report.txt', 'user:2')
  const moved = await f.owner.stat(UserDocId('archived.txt'))
  expect(moved.identity).toEqual({ ...original.identity, revision: original.identity.revision + 1 })
  expect(replacement.identity.createdBy).toBe('user:2')
  expect(replacement.identity.incarnationId).not.toBe(original.identity.incarnationId)
  expect(await readFile(moved.path, 'utf8')).toBe('same bytes')
  expect(await readFile(replacement.path, 'utf8')).toBe('same bytes')
})

it('recovers the current address of a completed publication moved outside the API', async () => {
  const f = await fixture(), p = await f.partial()
  const original = await f.owner.publish(p.target, p.path, p.publication)
  await rename(original.path, join(f.root, 'moved.txt'))
  const recovered = await f.owner.publish(p.target, p.path, p.publication)
  expect(recovered.docId).toBe('moved.txt')
  expect(recovered.identity).toEqual({ ...original.identity, revision: 2 })
  await expect(readFile(p.target.path)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('updates extension-derived presentation metadata on an external rename while preserving its creator', async () => {
  const f = await fixture(), original = await f.publish()
  await rename(original.path, join(f.root, 'renamed.json'))
  const [renamed] = await f.owner.list()
  expect(renamed).toMatchObject({ docId: 'renamed.json', mediaType: 'application/json',
    identity: { ...original.identity, revision: 2 } })
  expect(renamed?.identity.incarnationId).toBe(original.identity.incarnationId)
})

it('derives restored presentation metadata from the chosen name rather than the trashed extension', async () => {
  const f = await fixture(), original = await f.publish(), trash = await f.owner.trash(selection(original), 1000)
  const restored = await f.owner.restore({ ...selection(trash), trashId: trash.trashId }, UserDocDirectoryId(''), 'restored.pdf')
  expect(restored.mediaType).toBe('application/pdf')
  expect(restored.identity.incarnationId).toBe(original.identity.incarnationId)
  expect(restored.identity.createdBy).toBe('user:1')
  expect(await readFile(restored.path, 'utf8')).toBe('same bytes')
})

it('delivers actual filesystem mutations with the original actor and joins projection calls before database close', async () => {
  const f = await fixture(), first = await f.publish(), actor = UserDocUploadOwnerId('user:2')
  await mkdir(join(f.root, 'folder'))
  const moved = await f.owner.move(selection(first), UserDocDirectoryId('folder'), actor)
  const trash = await f.owner.trash(selection(moved), 1000, actor)
  const restored = await f.owner.restore({ ...selection(trash), trashId: trash.trashId }, UserDocDirectoryId(''), 'restored.txt', actor)
  await f.owner.remove(selection(restored), actor)
  await writeFile(join(f.root, 'external.txt'), 'external bytes')
  await f.owner.stat(UserDocId('external.txt'))
  const options = { limit: 100, maxBytes: 1_000_000 }, start = { sequence: 0, ordinal: 0 }
  const delivered = await f.owner.projectionChanges(start, options)
  expect(delivered.changes.map(change => change.action)).toEqual(['publish', 'move', 'trash', 'restore', 'remove', 'adopt'])
  expect(delivered.changes.map(change => change.actor)).toEqual(['user:1', actor, actor, actor, actor, undefined])
  expect(delivered.changes.slice(0, 5).every(change => change.document.createdBy === 'user:1')).toBe(true)
  expect(delivered.changes[5]?.document.createdBy).toBeUndefined()
  const acknowledged = f.owner.acknowledgeProjection(delivered.next)
  const disposed = f.owner.dispose()
  await Promise.all([acknowledged, disposed])
  await expect(f.owner.projectionChanges(delivered.next, options)).rejects.toThrow('closed')
  await f.reopen()
  expect((await f.owner.projectionChanges(delivered.next, options)).changes).toEqual([])
  await expect(f.owner.projectionChanges(start, options)).rejects.toThrow('precedes')
})

it('retains the authenticated directory initiator on each committed moved document', async () => {
  const f = await fixture(), actor = UserDocUploadOwnerId('user:2')
  await mkdir(join(f.root, 'folder'))
  const first = await f.publish('folder/a.txt'), second = await f.publish('folder/b.txt', 'user:3')
  const before = await f.owner.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 100, maxBytes: 1_000_000 })
  await f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [selection(first), selection(second)], actor)
  const after = await f.owner.projectionChanges(before.head, { limit: 100, maxBytes: 1_000_000 })
  expect(after.changes.map(change => change.actor)).toEqual([actor, actor])
  expect(after.changes.map(change => change.document.createdBy).sort()).toEqual(['user:1', 'user:3'])
  expect(new TextDecoder().decode(await readFile(join(f.root, 'renamed', 'a.txt')))).toBe('same bytes')
})

it.each(['replace', 'arrive', 'delete', 'move-child'] as const)(
  'recovers a published directory after an ordinary editor performs %s before metadata recovery', async (edit) => {
    const f = await fixture()
    await mkdir(join(f.root, 'folder'))
    const original = await f.publish('folder/a.txt'), actor = UserDocUploadOwnerId('user:2')
    const interruption = new Error('Owned directory metadata interruption')
    const commit = vi.spyOn(DocumentIdentityStore.prototype, 'commit').mockImplementationOnce(() => { throw interruption })
    try {
      await expect(f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [selection(original)], actor))
        .rejects.toBe(interruption)
    } finally { commit.mockRestore() }
    const path = join(f.root, 'renamed', 'a.txt')
    if (edit === 'replace') {
      await writeFile(join(f.root, 'incoming.txt'), 'atomic editor replacement')
      await rename(join(f.root, 'incoming.txt'), path)
    } else if (edit === 'arrive') await writeFile(join(f.root, 'renamed', 'new.txt'), 'concurrent document')
    else if (edit === 'delete') await unlink(path)
    else await rename(path, join(f.root, 'renamed', 'moved.txt'))
    await f.reopen()
    const listed = await f.owner.list(), snapshot = await f.owner.snapshot()
    const previous = snapshot.documents.find(record => record.incarnationId === original.identity.incarnationId)
    expect(previous?.createdBy).toBe('user:1')
    expect(previous?.state).toBe(edit === 'replace' || edit === 'delete' ? 'missing' : 'active')
    if (edit === 'replace') {
      const current = listed.find(file => file.docId === 'renamed/a.txt')
      expect(current?.identity.incarnationId).not.toBe(original.identity.incarnationId)
      expect(current?.identity.createdBy).toBeUndefined()
      await expect(f.owner.trash({ ...selection(original), docId: UserDocId('renamed/a.txt'), revision: 2 }, 60000))
        .rejects.toThrow('no longer current')
      expect(await readFile(path, 'utf8')).toBe('atomic editor replacement')
    } else if (edit === 'arrive') {
      expect(listed.find(file => file.docId === 'renamed/new.txt')?.identity.createdBy).toBeUndefined()
      expect(await readFile(join(f.root, 'renamed', 'new.txt'), 'utf8')).toBe('concurrent document')
    } else if (edit === 'move-child') {
      expect(listed.find(file => file.docId === 'renamed/moved.txt')?.identity.incarnationId).toBe(original.identity.incarnationId)
    } else expect(listed).toEqual([])
    const changes = await f.owner.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 100, maxBytes: 1000000 })
    expect(changes.changes.find(change => change.action === 'move')?.actor).toBe(actor)
    expect(changes.changes.filter(change => change.action === 'adopt').every(change => change.actor === undefined)).toBe(true)
    await f.publish('next.txt')
  },
)

it.skipIf(process.platform === 'win32')('commits an identified directory when an already-open descriptor receives a late atomic save', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const original = await f.publish('folder/a.txt')
  await writeFile(join(f.root, 'incoming.txt'), 'atomic descriptor edit')
  const parent = await open(f.root, 'r')
  onTestFinished(() => parent.close())
  const directory = await open(join(f.root, 'folder'), 'r')
  onTestFinished(() => directory.close())
  const library = koffi.load(null)
  onTestFinished(() => { library.unload() })
  const edit = library.func('int renameat(int sourceDirectory, str source, int targetDirectory, str target)') as KoffiFunc<
    (sourceDirectory: number, source: string, targetDirectory: number, target: string) => number
  >
  let edited = false
  await withDirectoryRenameInterleave(async (from, to) => {
    if (!edited && basename(from).endsWith('.stage') && basename(to) === 'renamed') {
      await new Promise<void>((resolve, reject) => {
        edit.async(parent.fd, 'incoming.txt', directory.fd, 'a.txt', (error: unknown, result: number) => {
          if (error !== null) reject(error instanceof Error ? error : new Error('Native descriptor edit failed.', { cause: error }))
          else if (result !== 0) reject(new Error(`Owned descriptor edit failed with errno ${String(koffi.errno())}.`))
          else resolve()
        })
      })
      edited = true
    }
  }, () => f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [selection(original)]))
  expect(edited).toBe(true)
  expect(await readFile(join(f.root, 'renamed', 'a.txt'), 'utf8')).toBe('atomic descriptor edit')
  const [current] = await f.owner.list()
  expect(current?.identity.incarnationId).not.toBe(original.identity.incarnationId)
  expect(current?.identity.createdBy).toBeUndefined()
  await f.reopen(); await f.publish('next.txt')
})

it.each(['list', 'directory', 'stat'] as const)('reclaims retired directory markers through %s without adopting control identities', async (operation) => {
  const f = await fixture(), source = join(f.root, 'folder'), held = join(f.root, 'held-original')
  await mkdir(source)
  const original = await f.publish('folder/a.txt')
  let swapped = false
  await withDirectoryRenameInterleave(async (from) => {
    if (!swapped && basename(from) === 'folder') {
      await rename(source, held); await mkdir(source); await writeFile(join(source, 'foreign.txt'), 'foreign bytes')
      swapped = true
    }
  }, async () => {
    await expect(f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [selection(original)]))
      .rejects.toThrow()
  })
  expect(swapped).toBe(true)
  const marker = (await readdir(held)).find(name => name.startsWith('.dsh-directory-'))
  expect(marker).toBeDefined()
  await f.reopen()
  if (operation === 'list') expect((await f.owner.list()).some(file => file.name === marker)).toBe(false)
  else if (operation === 'directory') expect((await f.owner.listDirectory(UserDocDirectoryId('held-original'))).documents.some(file => file.name === marker)).toBe(false)
  else await expect(f.owner.stat(UserDocId(`held-original/${String(marker)}`))).rejects.toHaveProperty('code', 'DOCUMENT_NOT_FOUND')
  expect(await readdir(held)).toEqual(['a.txt'])
  expect((await f.owner.snapshot()).documents.some(record => record.docId.endsWith(String(marker)))).toBe(false)
  const moved = await f.owner.stat(UserDocId('held-original/a.txt'))
  expect(moved.identity.incarnationId).toBe(original.identity.incarnationId)
  expect(moved.identity.createdBy).toBe('user:1')
  expect(await readFile(join(source, 'foreign.txt'), 'utf8')).toBe('foreign bytes')
  expect(await readdir(join(f.locations.filesRoot, 'anchors'))).toEqual([])
})

it('retains ordinary files with directory-marker names when no private anchor proves ownership', async () => {
  const f = await fixture(), name = '.dsh-directory-1.part'
  await writeFile(join(f.root, name), 'ordinary bytes')
  expect((await f.owner.list()).map(file => file.name)).toEqual([name])
  expect((await f.owner.stat(UserDocId(name))).bytes).toBe(14)
  expect(await readFile(join(f.root, name), 'utf8')).toBe('ordinary bytes')
})

it('keeps the creator identity on in-place edits and refuses a previously selected revision', async () => {
  const f = await fixture(), original = await f.publish()
  await writeFile(join(f.root, original.docId), 'edited bytes')
  const edited = await f.owner.stat(original.docId)
  expect(edited.identity).toMatchObject({ incarnationId: original.identity.incarnationId, createdBy: 'user:1', revision: 2 })
  expect(edited.bytes).toBe(12)
  await expect(f.owner.trash(selection(original), 1000)).rejects.toThrow('no longer current')
  expect(await readFile(join(f.root, original.docId), 'utf8')).toBe('edited bytes')
  const trash = await f.owner.trash(selection(edited), 1000)
  expect(trash.identity.createdBy).toBe('user:1')
})

it.each(['bytes', 'time'] as const)('refuses a directory selection after document %s change and admits a fresh selection', async (changed) => {
  const f = await fixture(), actor = UserDocUploadOwnerId('user:2')
  await mkdir(join(f.root, 'folder'))
  const original = await f.publish('folder/a.txt')
  const content = changed === 'bytes' ? 'edited after selection' : 'new bytes!'
  await writeFile(original.path, content)
  if (changed === 'time') {
    const modified = new Date(original.modifiedAt + 2000)
    await utimes(original.path, modified, modified)
  }
  await expect(f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [selection(original)], actor))
    .rejects.toThrow('changed after authorization')
  expect(await readFile(original.path, 'utf8')).toBe(content)
  await expect(stat(join(f.root, 'renamed'))).rejects.toMatchObject({ code: 'ENOENT' })
  const [edited] = await f.owner.list()
  expect(edited?.identity).toMatchObject({ incarnationId: original.identity.incarnationId, createdBy: 'user:1', revision: 2 })
  expect(edited?.bytes).toBe(changed === 'bytes' ? 22 : 10)
  await f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [selection(edited!)], actor)
  expect(await readFile(join(f.root, 'renamed', 'a.txt'), 'utf8')).toBe(content)
})

it('recovers a physically moved directory with a later in-place edit and preserves the creator identity', async () => {
  const f = await fixture()
  await mkdir(join(f.root, 'folder'))
  const original = await f.publish('folder/a.txt')
  const spy = vi.spyOn(DocumentIdentityStore.prototype, 'commit').mockImplementationOnce(() => {
    writeFileSync(join(f.root, 'renamed', 'a.txt'), 'edited after physical rename')
    throw new Error('Owned metadata commit interruption')
  })
  try {
    await expect(f.owner.renameDirectory(UserDocDirectoryId('folder'), UserDocDirectoryId('renamed'), [selection(original)]))
      .rejects.toThrow('Owned metadata commit interruption')
  } finally { spy.mockRestore() }
  await f.reopen()
  const [current] = await f.owner.list()
  expect(current?.docId).toBe('renamed/a.txt')
  expect(current?.identity).toMatchObject({ incarnationId: original.identity.incarnationId, createdBy: 'user:1', revision: 3 })
  expect(current?.bytes).toBe(28)
  expect(await readFile(join(f.root, 'renamed', 'a.txt'), 'utf8')).toBe('edited after physical rename')
  await expect(stat(join(f.root, 'folder'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('assigns an unknown creator to an external identical-byte replacement instead of inheriting the old owner', async () => {
  const f = await fixture(), original = await f.publish()
  await unlink(join(f.root, original.docId)); await writeFile(join(f.root, original.docId), 'same bytes')
  const replacement = await f.owner.stat(original.docId)
  expect(replacement.identity.incarnationId).not.toBe(original.identity.incarnationId)
  expect(replacement.identity.createdBy).toBeUndefined()
  expect(replacement.identity.origin).toBe('legacy')
  await expect(f.owner.trash(selection(original), 1000)).rejects.toThrow('no longer current')
  expect(await readFile(join(f.root, original.docId), 'utf8')).toBe('same bytes')
})

it('uses an exact object witness to preserve identity on a uniquely observed external move', async () => {
  const f = await fixture(), original = await f.publish()
  await rename(join(f.root, original.docId), join(f.root, 'moved.txt'))
  const listing = await f.owner.list()
  expect(listing).toHaveLength(1)
  expect(listing[0]).toMatchObject({ docId: 'moved.txt', identity: { ...original.identity, revision: 2 } })
  await expect(f.owner.move(selection(original), UserDocDirectoryId(''))).rejects.toThrow()
  expect(await readFile(join(f.root, 'moved.txt'), 'utf8')).toBe('same bytes')
})

it.each(['list', 'directory', 'stat-original', 'stat-replacement'] as const)(
  'preserves an external move after its former name is reused through %s', async (read) => {
    const f = await fixture(), original = await f.publish('a.txt')
    await rename(original.path, join(f.root, 'z.txt'))
    await writeFile(original.path, 'replacement bytes')
    await utimes(original.path, 2_000_000_000, 2_000_000_000)
    if (read === 'list') await f.owner.list()
    else if (read === 'directory') await f.owner.listDirectory(UserDocDirectoryId(''))
    else await f.owner.stat(UserDocId(read === 'stat-original' ? 'z.txt' : 'a.txt'))
    const moved = await f.owner.stat(UserDocId('z.txt')), replacement = await f.owner.stat(original.docId)
    expect(moved.identity).toEqual({ ...original.identity, revision: 2 })
    expect(replacement.identity.incarnationId).not.toBe(original.identity.incarnationId)
    expect(replacement.identity.createdBy).toBeUndefined()
    await expect(f.owner.trash(selection(original), 1000)).rejects.toThrow('no longer current')
    expect(await readFile(original.path, 'utf8')).toBe('replacement bytes')
    await f.reopen()
    expect(await f.owner.stat(moved.docId)).toEqual(moved)
  },
)

it.each([2, 3])('preserves every creator and incarnation when %s external file addresses rotate', async (count) => {
  const f = await fixture(), originals: IdentifiedUserDocRef[] = []
  for (let index = 0; index < count; index++) originals.push(await f.publish(`${String(index)}.txt`, `user:${String(index + 1)}`))
  const first = originals[0]!
  await rename(first.path, join(f.root, 'rotation.part'))
  for (let index = 1; index < count; index++) await rename(originals[index]!.path, originals[index - 1]!.path)
  await rename(join(f.root, 'rotation.part'), originals[count - 1]!.path)
  const listed = await f.owner.list()
  for (let index = 0; index < count; index++) {
    const original = originals[(index + 1) % count]!
    expect(listed.find(file => file.docId === originals[index]!.docId)?.identity).toEqual({ ...original.identity, revision: 2 })
  }
  const relocations = (await f.owner.projectionChanges({ sequence: 0, ordinal: 0 }, { limit: 100, maxBytes: 65536 }))
    .changes.filter(change => change.action === 'relocate')
  expect(relocations).toHaveLength(count)
  expect(new Set(relocations.map(change => change.cursor.sequence)).size).toBe(1)
  expect(relocations.every(change => change.actor === undefined)).toBe(true)
  await f.reopen()
  expect(await f.owner.list()).toEqual(listed)
})

it('recovers the completed publication nonce after its original address is reused', async () => {
  const f = await fixture(), partial = await f.partial('a.txt')
  const original = await f.owner.publish(partial.target, partial.path, partial.publication)
  await rename(original.path, join(f.root, 'z.txt'))
  await writeFile(original.path, 'replacement bytes')
  const recovered = await f.owner.publish(partial.target, partial.path, partial.publication)
  expect(recovered).toMatchObject({ docId: 'z.txt', identity: { ...original.identity, revision: 2 } })
  expect(await readFile(original.path, 'utf8')).toBe('replacement bytes')
})

it('preserves the original address owner while leaving its additional ordinary hard link unattributed', async () => {
  const f = await fixture(), original = await f.publish('a.txt')
  await link(original.path, join(f.root, 'alias.txt'))
  const listed = await f.owner.list()
  expect(listed.find(file => file.docId === 'a.txt')?.identity).toEqual(original.identity)
  expect(listed.find(file => file.docId === 'alias.txt')?.identity.createdBy).toBeUndefined()
  expect(listed.find(file => file.docId === 'alias.txt')?.identity.incarnationId).not.toBe(original.identity.incarnationId)
})

it('leaves ambiguous external hard-link destinations unattributed', async () => {
  const f = await fixture(), original = await f.publish('a.txt')
  await link(original.path, join(f.root, 'first.txt'))
  await rename(original.path, join(f.root, 'second.txt'))
  const listed = await f.owner.list()
  expect(listed).toHaveLength(2)
  expect(listed.every(file => file.identity.incarnationId !== original.identity.incarnationId
    && file.identity.createdBy === undefined)).toBe(true)
  expect((await f.owner.snapshot()).documents.find(record => record.incarnationId === original.identity.incarnationId)?.state).toBe('missing')
})

it.each([false, true])('preserves metadata when retained-object evidence is replaced (moved: %s)', async (moved) => {
  const f = await fixture(), original = await f.publish('a.txt')
  if (moved) await rename(original.path, join(f.root, 'z.txt'))
  else await unlink(original.path)
  const retained = join(f.locations.filesRoot, 'objects', `${original.identity.incarnationId}.object`)
  await writeFile(join(f.locations.filesRoot, 'foreign.part'), 'foreign private bytes')
  await rename(join(f.locations.filesRoot, 'foreign.part'), retained)
  await expect(f.owner.list()).rejects.toThrow('retained document identity object has changed')
  expect((await f.owner.snapshot()).documents.find(record => record.incarnationId === original.identity.incarnationId))
    .toMatchObject({ state: 'active', docId: 'a.txt', revision: 1, createdBy: 'user:1' })
  expect(await readFile(retained, 'utf8')).toBe('foreign private bytes')
})

it('retains an observed original when another editor moves it after address reconciliation', async () => {
  const f = await fixture(), original = await f.publish('a.txt')
  await rename(original.path, join(f.root, 'z.txt'))
  // oxlint-disable-next-line typescript/unbound-method -- The spy forwards through apply() with the actual store receiver.
  const relocate = DocumentIdentityStore.prototype.relocateObserved
  const spy = vi.spyOn(DocumentIdentityStore.prototype, 'relocateObserved')
  spy.mockImplementation(function (this: DocumentIdentityStore, ...args) {
    const result = relocate.apply(this, args)
    renameSync(join(f.root, 'z.txt'), join(f.root, 'held.txt'))
    writeFileSync(join(f.root, 'z.txt'), 'late replacement')
    return result
  })
  try { await expect(f.owner.list()).rejects.toThrow('inventory changed during observation') } finally { spy.mockRestore() }
  const listed = await f.owner.list()
  expect(listed.find(file => file.docId === 'held.txt')?.identity).toEqual({ ...original.identity, revision: 3 })
  expect(listed.find(file => file.docId === 'z.txt')?.identity.createdBy).toBeUndefined()
  expect(await readFile(join(f.root, 'held.txt'), 'utf8')).toBe('same bytes')
  expect(await readFile(join(f.root, 'z.txt'), 'utf8')).toBe('late replacement')
})

it('refuses a target replaced after inventory collection and retries without losing its original identity', async () => {
  const f = await fixture(), original = await f.publish('a.txt'), target = join(f.root, 'z.txt')
  await rename(original.path, target)
  const withSource = DocumentFileAnchor.withSource.bind(DocumentFileAnchor)
  let visits = 0
  const spy = vi.spyOn(DocumentFileAnchor, 'withSource').mockImplementation(async <T>(
    storage: DocumentIdentityStorage, path: string, operation: (source: DocumentFileSource) => Promise<T>,
  ): Promise<T> => {
    if (path === target && ++visits === 2) {
      await rename(target, join(f.root, 'held.txt')); await writeFile(target, 'replacement bytes')
    }
    return withSource(storage, path, operation)
  })
  try { await expect(f.owner.list()).rejects.toThrow('observed document moved again') } finally { spy.mockRestore() }
  expect((await f.owner.snapshot()).documents.find(record => record.incarnationId === original.identity.incarnationId))
    .toMatchObject({ docId: original.docId, revision: 1, state: 'active' })
  const listed = await f.owner.list()
  expect(listed.find(file => file.docId === 'held.txt')?.identity).toEqual({ ...original.identity, revision: 2 })
  expect(listed.find(file => file.docId === 'z.txt')?.identity.createdBy).toBeUndefined()
})

it('retains external relocation evidence when maintenance refuses metadata writer admission', async () => {
  let blocked = false
  const failure = new Error('Maintenance writer admission refused')
  const f = await fixture(async (operation) => { if (blocked) throw failure; await operation() })
  const original = await f.publish('a.txt')
  await rename(original.path, join(f.root, 'z.txt'))
  blocked = true
  await expect(f.owner.list()).rejects.toBe(failure)
  expect((await f.owner.snapshot()).documents.find(record => record.incarnationId === original.identity.incarnationId))
    .toMatchObject({ docId: original.docId, revision: 1, state: 'active' })
  expect(await readFile(join(f.root, 'z.txt'), 'utf8')).toBe('same bytes')
  blocked = false
  expect((await f.owner.list())[0]?.identity).toEqual({ ...original.identity, revision: 2 })
})

it('reconciles a case-only external rename without creating another owner identity', async () => {
  const f = await fixture(), original = await f.publish('Report.txt')
  await rename(join(f.root, 'Report.txt'), join(f.root, 'report.txt'))
  const listing = await f.owner.listDirectory(UserDocDirectoryId(''))
  expect(listing.documents).toHaveLength(1)
  expect(listing.documents[0]).toMatchObject({ docId: 'report.txt', identity: { ...original.identity, revision: 2 } })
  await expect(f.owner.stat(UserDocId('Report.txt'))).rejects.toMatchObject({ code: 'DOCUMENT_NOT_FOUND' })
})

it('restores and retrashes the selected action without consuming older or newer files at that path', async () => {
  const f = await fixture(), original = await f.publish()
  const old = await f.owner.trash(selection(original), 1000)
  const replacement = await f.publish('report.txt', 'user:2')
  const restored = await f.owner.restore({ ...selection(old), trashId: old.trashId }, UserDocDirectoryId('new/folder'), 'restored.txt')
  expect(restored).toMatchObject({ docId: 'new/folder/restored.txt', identity: { ...original.identity, revision: 3 } })
  const retrash = await f.owner.trash(selection(restored), 1000)
  await expect(f.owner.purge({ ...selection(retrash), trashId: old.trashId })).rejects.toThrow('no longer recoverable')
  expect(await f.owner.stat(replacement.docId)).toEqual(replacement)
  await f.owner.purge({ ...selection(retrash), trashId: retrash.trashId })
  expect(await f.owner.listTrash()).toEqual([])
})

it('does not republish a completed nonce after its document is purged', async () => {
  const f = await fixture(), p = await f.partial()
  const original = await f.owner.publish(p.target, p.path, p.publication)
  const trash = await f.owner.trash(selection(original), 1000)
  await f.owner.purge({ ...selection(trash), trashId: trash.trashId })
  const replacement = await f.publish('report.txt', 'user:2')
  await f.reopen()
  await expect(f.owner.publish(p.target, p.path, p.publication)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STATE' })
  expect(await f.owner.stat(replacement.docId)).toEqual(replacement)
})

it('recovers a completed publication by nonce and retained object after its partial is removed', async () => {
  const f = await fixture(), p = await f.partial()
  const original = await f.owner.publish(p.target, p.path, p.publication)
  await f.reopen()
  expect(await f.owner.publish(p.target, p.path, p.publication)).toEqual(original)
  const changed = { ...p.publication, createdBy: UserDocUploadOwnerId('user:2') }
  await expect(f.owner.publish(p.target, p.path, changed)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STATE' })
  expect(await f.owner.stat(original.docId)).toEqual(original)
})

it('preserves a replacement when an earlier completed nonce retries publication', async () => {
  const f = await fixture(), p = await f.partial()
  await f.owner.publish(p.target, p.path, p.publication)
  await unlink(p.target.path); await writeFile(p.target.path, 'same bytes')
  await expect(f.owner.publish(p.target, p.path, p.publication)).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_STATE' })
  const current = await f.owner.stat(p.target.docId)
  expect(current.identity.createdBy).toBeUndefined()
  expect(current.identity.incarnationId).not.toBe(p.publication.incarnationId)
})

it('moves exactly one selected version and retains its original creator', async () => {
  const f = await fixture(), original = await f.publish()
  await mkdir(join(f.root, 'folder'))
  const moved = await f.owner.move(selection(original), UserDocDirectoryId('folder'))
  expect(moved).toMatchObject({ docId: 'folder/report.txt', identity: { ...original.identity, revision: 2 } })
  await expect(f.owner.move(selection(original), UserDocDirectoryId(''))).rejects.toThrow()
  expect((await f.owner.listDirectory(UserDocDirectoryId('folder'))).documents).toEqual([moved])
})

it('rejects mismatched expected bytes before publishing or reserving a nonce', async () => {
  const f = await fixture(), p = await f.partial()
  await expect(f.owner.publish(p.target, p.path, { ...p.publication, bytes: 9 })).rejects.toMatchObject({ code: 'DOCUMENT_UPLOAD_SIZE' })
  expect(await f.owner.list()).toEqual([])
  expect(await readFile(p.path, 'utf8')).toBe('same bytes')
  expect((await f.owner.publish(p.target, p.path, p.publication)).bytes).toBe(10)
})

it('repeats a completed selected trash action without touching a same-name replacement', async () => {
  const f = await fixture(), original = await f.publish()
  const trashed = await f.owner.trash(selection(original), 1000)
  const replacement = await f.publish('report.txt', 'user:2')
  expect(await f.owner.trash(selection(original), 1000)).toEqual(trashed)
  expect(await f.owner.stat(replacement.docId)).toEqual(replacement)
})

it('purges only due actions and preserves a later action that remains within retention', async () => {
  const f = await fixture(), first = await f.publish()
  const due = await f.owner.trash(selection(first), 0)
  const later = await f.publish('report.txt', 'user:2')
  const retained = await f.owner.trash(selection(later), 1_000_000)
  expect(await f.owner.purgeDue(0)).toBe(0)
  expect(await f.owner.purgeDue(Date.now())).toBe(1)
  expect(await f.owner.listTrash()).toEqual([retained])
  await f.owner.purge({ ...selection(due), trashId: due.trashId })
  const snapshot = await f.owner.snapshot()
  expect(snapshot.rootId).toMatch(/^[0-9a-f-]{36}$/u)
  expect(snapshot.documents.map(record => record.state).sort()).toEqual(['purged', 'trash'])
})

it('repeats a completed immediate removal without deleting a new incarnation at the same address', async () => {
  const f = await fixture(), first = await f.publish()
  await f.owner.remove(selection(first))
  const replacement = await f.publish('report.txt', 'user:2')
  await f.owner.remove(selection(first))
  expect(await f.owner.stat(replacement.docId)).toEqual(replacement)
  expect((await f.owner.snapshot()).documents.map(record => record.state).sort()).toEqual(['active', 'purged'])
})

it('closes the database only after accepted file work settles and refuses new work during disposal', async () => {
  const f = await fixture(), original = await f.publish()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  const withSource = DocumentFileAnchor.withSource.bind(DocumentFileAnchor)
  const spy = vi.spyOn(DocumentFileAnchor, 'withSource').mockImplementation(async (root, path, operation) => {
    if (root.locations.root === f.root && path === join(f.root, original.docId)) { enter(); await released }
    return withSource(root, path, operation)
  })
  const close = vi.spyOn(DatabaseSync.prototype, 'close')
  try {
    const reading = f.owner.stat(original.docId)
    await entered
    const closing = f.owner.dispose()
    expect(f.owner.dispose()).toBe(closing)
    await expect(f.owner.list()).rejects.toThrow('closed')
    expect(close).not.toHaveBeenCalled()
    release()
    expect(await reading).toEqual(original)
    await closing
    expect(close).toHaveBeenCalledTimes(1)
  } finally { release(); spy.mockRestore(); close.mockRestore(); await f.owner.dispose() }
})


it('refuses a publication source in the public workspace without changing either file', async () => {
  const f = await fixture(), partial = await f.partial(), publicSource = join(f.root, 'caller-source.part')
  await rename(partial.path, publicSource)
  await expect(f.owner.publish(partial.target, publicSource, partial.publication)).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_REF' })
  expect(await readFile(publicSource, 'utf8')).toBe('same bytes')
  expect((await f.owner.snapshot()).documents).toEqual([])
})

it('refuses a second SQLite copy driving the same public and retained document files', async () => {
  const f = await fixture(), original = await f.publish()
  await f.owner.dispose()
  const stateRoot = join(f.base, 'second-state')
  await mkdir(stateRoot, { mode: 0o700 })
  await copyFile(join(f.locations.stateRoot, 'metadata.sqlite'), join(stateRoot, 'metadata.sqlite'))
  await expect(DocumentIdentityFs.open({ ...f.locations, stateRoot })).rejects.toThrow('another metadata domain or database file')
  await f.reopen()
  expect(await f.owner.stat(original.docId)).toEqual(original)
  expect(await readFile(original.path, 'utf8')).toBe('same bytes')
})

it('closes an unpublished metadata connection when initial writer-lock release fails', async () => {
  const f = await legacyFixture(), failure = new Error('Owned initial lock release failure')
  const lock = atomic.withFileLock, close = vi.spyOn(DatabaseSync.prototype, 'close')
  const spy = vi.spyOn(atomic, 'withFileLock').mockImplementation(async (path, operation, options) => {
    const result = await lock(path, operation, options)
    if (path === join(f.locations.stateRoot, 'mutation')) throw failure
    return result
  })
  try {
    await expect(f.open()).rejects.toBe(failure)
    expect(close).toHaveBeenCalledTimes(1)
  } finally { spy.mockRestore(); close.mockRestore() }
  expect(await readFile(f.hidden, 'utf8')).toBe('legacy bytes')
  expect(await (await f.open()).listTrash()).toHaveLength(1)
})
