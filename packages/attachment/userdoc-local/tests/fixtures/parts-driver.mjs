/** Runnable Loader transcript for ordinary .part uploads and private filesystem path refusals. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { lstat, mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

const bootEntry = process.env.DSH_PARTS_BOOT_ENTRY, vocabularyEntry = process.env.DSH_PARTS_VOCABULARY_ENTRY
if (bootEntry === undefined || vocabularyEntry === undefined) throw new Error('Document parts fixture requires explicit artifact entries.')
const { boot, resolveConfigPath } = await import(bootEntry)
const { UserDocId, UserDocDirectoryId, UserDocError } = await import(vocabularyEntry)
const config = process.argv[2]
if (config === undefined) throw new Error('Document parts fixture requires a Loader configuration.')
const ctx = await boot('document-parts-fixture', resolveConfigPath(config, undefined))
const body = text => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() } })
const root = join(process.cwd(), 'documents')
function waitingBody() {
  let enter, release, cancelled = false
  const entered = new Promise(resolve => { enter = resolve })
  const released = new Promise(resolve => { release = resolve })
  const stream = new ReadableStream({ pull() { enter(); return released }, cancel() { cancelled = true; release() } },
    { highWaterMark: 0 })
  return { stream, entered, release, get cancelled() { return cancelled } }
}
try {
  const saved = await ctx.userDocs.save(await ctx.userDocs.resolveTarget({ name: 'archive.part' }), body('finished bytes'))
  const listed = await ctx.userDocs.list()
  assert.equal(listed.some(item => item.docId === saved.docId), true)
  const directory = await ctx.userDocs.listDirectory(UserDocDirectoryId(''))
  assert.equal(directory.documents.some(item => item.docId === saved.docId), true)
  const text = new TextDecoder().decode((await ctx.userDocs.read(saved.docId)).data)
  assert.equal(text, 'finished bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'ordinary-part', name: saved.name, recursive: true, directory: true, text })}\n`)

  const reserved = `.userdoc-${'a'.repeat(24)}.part`
  await writeFile(join(root, reserved), 'unpublished')
  assert.equal((await ctx.userDocs.list()).some(item => item.name === reserved), false)
  const target = await ctx.userDocs.resolveTarget({ name: `.userdoc-${'b'.repeat(24)}.part` })
  assert.equal(target.name, `.userdoc-${'b'.repeat(24)} (2).part`)
  const renamed = await ctx.userDocs.save(target, body('caller bytes'))
  assert.equal((await ctx.userDocs.list()).some(item => item.docId === renamed.docId), true)
  await assert.rejects(ctx.userDocs.read(UserDocId(reserved)), { code: 'INVALID_DOCUMENT_REF' })
  process.stdout.write(`${JSON.stringify({ operation: 'staging-name', hidden: true, userNameSuffixed: true, userFileVisible: true })}\n`)

  const session = await ctx.userDocs.beginUpload({ name: 'incomplete.txt', directoryId: UserDocDirectoryId(''), bytes: 0,
    fingerprint: 'invalid-state-fixture' })
  const manifestPath = join(root, '.upload-sessions', 'v1', String(session.uploadId), 'manifest.json')
  const originalManifest = await readFile(manifestPath, 'utf8')
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), state: ['uploading'] }))
  await assert.rejects(ctx.userDocs.inspectUpload(session.uploadId), { code: 'DOCUMENT_UPLOAD_NOT_FOUND' })
  assert.equal((await readFile(join(root, '.upload-sessions', 'v1', String(session.uploadId), 'data.part'))).byteLength, 0)
  await writeFile(manifestPath, originalManifest)
  await ctx.userDocs.cancelUpload(session.uploadId)
  process.stdout.write(`${JSON.stringify({ operation: 'invalid-upload-state', code: 'DOCUMENT_UPLOAD_NOT_FOUND', bytesIntact: true })}\n`)

  const aliases = ['.UPLOAD-SESSIONS', '.DSH-TRASH', '.upload-ſeſſions', '.dsh-traſh', '.upload-sessions.', '.dsh-trash ']
  for (const name of ['.upload-sessions', '.dsh-trash']) {
    await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, name, 'private.txt'), 'private bytes')
  }
  for (const alias of aliases) {
    await assert.rejects(ctx.userDocs.read(UserDocId(`${alias}/private.txt`)), { code: 'INVALID_DOCUMENT_REF' })
    await assert.rejects(ctx.userDocs.listDirectory(UserDocDirectoryId(alias)), { code: 'INVALID_DOCUMENT_DIRECTORY' })
  }
  assert.equal(await readFile(join(root, '.upload-sessions', 'private.txt'), 'utf8'), 'private bytes')
  assert.equal(await readFile(join(root, '.dsh-trash', 'private.txt'), 'utf8'), 'private bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'private-aliases', readDenials: aliases.length, directoryDenials: aliases.length,
    bytesIntact: true })}\n`)

  await assert.rejects(ctx.userDocs.resolveTarget({ name: '.UPLOAD-SESSIONS' }), { code: 'INVALID_DOCUMENT_NAME' })
  await assert.rejects(ctx.userDocs.createDirectory(UserDocDirectoryId(''), '.DSH-TRASH.'), { code: 'INVALID_DOCUMENT_DIRECTORY' })
  process.stdout.write(`${JSON.stringify({ operation: 'private-destinations', fileRejected: true, directoryRejected: true })}\n`)

  const failed = await ctx.userDocs.resolveTarget({ name: 'oversized.txt' })
  const cleanup = new Error('Owned source cancellation failure')
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65)) }, cancel() { throw cleanup } })
  await assert.rejects(ctx.userDocs.save(failed, oversized), (error) => error instanceof UserDocError
    && error.code === 'DOCUMENT_WRITE_FAILED' && error.cause instanceof AggregateError
    && error.cause.errors[0]?.code === 'DOCUMENT_TOO_LARGE' && error.cause.errors[1] === cleanup)
  await assert.rejects(lstat(failed.path), { code: 'ENOENT' })
  process.stdout.write(`${JSON.stringify({ operation: 'source-cleanup-error', bothCausesRetained: true, published: false })}\n`)

  const collided = await ctx.userDocs.resolveTarget({ name: 'collided.txt' }), open = fs.open
  const canonicalRoot = await fs.realpath(root)
  let foreign
  fs.open = async (...args) => {
    if (typeof args[0] === 'string' && typeof args[1] === 'number' && (args[1] & constants.O_EXCL) !== 0
      && basename(args[0]).startsWith('.userdoc-') && await fs.realpath(dirname(args[0])) === canonicalRoot) {
      foreign = join(root, basename(args[0]))
      await writeFile(foreign, 'another writer')
    }
    return open(...args)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(ctx.userDocs.save(collided, body('new')), { code: 'DOCUMENT_WRITE_FAILED' })
    assert.equal(typeof foreign, 'string')
    assert.equal(await readFile(foreign, 'utf8'), 'another writer')
    await assert.rejects(lstat(collided.path), { code: 'ENOENT' })
    process.stdout.write(`${JSON.stringify({ operation: 'staging-collision', foreignBytesIntact: true, published: false })}\n`)
  } finally {
    fs.open = open; syncBuiltinESMExports()
    if (foreign !== undefined) await unlink(foreign)
  }

  const selectedFolder = await ctx.userDocs.createDirectory(UserDocDirectoryId(''), 'selected-folder')
  const selectedFile = await ctx.userDocs.save(await ctx.userDocs.resolveTarget({ name: 'selected.txt', directoryId: selectedFolder.directoryId }),
    body('selected bytes'))
  const occupiedFolder = join(root, 'occupied-folder'), originalLstat = fs.lstat
  let occupied, collision
  fs.lstat = async (...args) => {
    try { return await originalLstat(...args) } catch (error) {
      if (occupied === undefined && basename(String(args[0])) === 'occupied-folder' && error.code === 'ENOENT') {
        await mkdir(occupiedFolder)
        occupied = await originalLstat(occupiedFolder, { bigint: true })
      }
      throw error
    }
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(ctx.userDocs.renameDirectory(selectedFolder.directoryId, 'occupied-folder'), (error) => {
      collision = error.code
      return collision === 'DOCUMENT_DIRECTORY_CONFLICT'
    })
  } finally { fs.lstat = originalLstat; syncBuiltinESMExports() }
  assert.ok(occupied, 'The destination must appear after the last absence observation')
  assert.equal((await lstat(occupiedFolder, { bigint: true })).ino, occupied.ino)
  assert.equal(await readFile(selectedFile.path, 'utf8'), 'selected bytes')
  await fs.rmdir(occupiedFolder)
  const selectedObject = await lstat(selectedFolder.path, { bigint: true })
  const movedFolder = await ctx.userDocs.renameDirectory(selectedFolder.directoryId, 'occupied-folder')
  assert.equal((await lstat(movedFolder.path, { bigint: true })).ino, selectedObject.ino)
  assert.equal(await readFile(join(movedFolder.path, 'selected.txt'), 'utf8'), 'selected bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'directory-target-race', code: collision, emptyTargetPreserved: true,
    sourceBytesPreserved: true, retryRenamed: true, directoryObjectPreserved: true })}\n`)

  const outside = join(process.cwd(), 'outside')
  const folder = await ctx.userDocs.createDirectory(UserDocDirectoryId(''), 'future')
  const queued = await ctx.userDocs.resolveTarget({ name: 'new.txt', directoryId: folder.directoryId })
  await mkdir(outside); await writeFile(join(outside, 'private.txt'), 'outside bytes')
  await rename(root, join(process.cwd(), 'retained-documents'))
  await symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(ctx.userDocs.read(UserDocId('private.txt')), (error) => error instanceof UserDocError && error.code === 'INVALID_DOCUMENT_REF')
  await assert.rejects(ctx.userDocs.save(queued, body('private bytes')), { code: 'INVALID_DOCUMENT_REF' })
  await assert.rejects(lstat(join(outside, 'future')), { code: 'ENOENT' })
  assert.equal(await readFile(join(outside, 'private.txt'), 'utf8'), 'outside bytes')
  process.stdout.write(`${JSON.stringify({ operation: 'replaced-root', readRejected: true, saveRejected: true, outsideIntact: true })}\n`)

  await unlink(root)
  await rename(join(process.cwd(), 'retained-documents'), root)
  const chunkSession = await ctx.userDocs.beginUpload({ name: 'pending-chunk.txt', directoryId: UserDocDirectoryId(''),
    bytes: 3, fingerprint: 'pending-chunk-disposal' })
  const unfinished = await ctx.userDocs.resolveTarget({ name: 'unfinished.txt' })
  const abort = new AbortController()
  const saveBody = waitingBody(), chunkBody = waitingBody()
  const outcome = ctx.userDocs.save(unfinished, saveBody.stream, abort.signal).then(() => true, () => false)
  const chunkOutcome = ctx.userDocs.writeUploadChunk(chunkSession.uploadId, { index: 0, start: 0, end: 2, total: 3,
    sha256: createHash('sha256').update('new').digest('hex'), body: chunkBody.stream }, abort.signal).then(() => true, () => false)
  try {
    await Promise.all([saveBody.entered, chunkBody.entered])
    await ctx.fiber.dispose()
    assert.equal(saveBody.cancelled, true)
    assert.equal(chunkBody.cancelled, true)
    assert.equal(await outcome, false)
    assert.equal(await chunkOutcome, false)
    await assert.rejects(lstat(unfinished.path), { code: 'ENOENT' })
    const manifest = JSON.parse(await readFile(join(root, '.upload-sessions', 'v1', String(chunkSession.uploadId), 'manifest.json'), 'utf8'))
    assert.equal(manifest.receivedBytes, 0)
    process.stdout.write(`${JSON.stringify({ operation: 'dispose-uploads', saveCancelled: true, published: false,
      chunkCancelled: true, acknowledgedBytes: 0 })}\n`)
  } finally {
    abort.abort(new Error('Owned save fixture cleanup'))
    saveBody.release(); chunkBody.release()
    await Promise.all([outcome, chunkOutcome])
  }
} finally { await ctx.fiber.dispose() }
