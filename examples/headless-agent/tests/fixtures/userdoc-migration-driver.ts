#!/usr/bin/env node
/** Real Loader document migration and recoverable-trash refusal in one isolated runtime. */
import fs, { lstat, readFile, unlink, writeFile } from 'node:fs/promises'
import type { PathLike } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { boot, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import { DOCUMENT_MIGRATION_FAILED_CODE, DOCUMENT_TRASH_NOT_FOUND_CODE, DOCUMENT_UPLOAD_NOT_FOUND_CODE,
  UserDocDirectoryId, UserDocError } from '@deepseek-ai/dsh-userdoc'
import { purgeDueDocuments, trashDocument } from '@deepseek-ai/dsh-userdoc-local'

function body(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() },
  })
}

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('document migration fixture requires a configuration')
let ctx = await boot('userdoc-migration-snapshot', resolveConfigPath(configPath, undefined))
try {
  try {
    await ctx.userDocs.list()
    throw new Error('document migration ignored an incomplete owner record')
  } catch (error) {
    if (!(error instanceof UserDocError) || error.code !== DOCUMENT_MIGRATION_FAILED_CODE) throw error
    const currentRoot = await lstat(join(process.cwd(), 'documents')).catch((failure: unknown) => {
      if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw failure
    })
    process.stdout.write(`${JSON.stringify({
      operation: 'blocked-list', code: error.code,
      legacyText: await readFile(join(process.cwd(), 'uploads', 'brief.txt'), 'utf8'),
      currentRootExists: currentRoot !== undefined,
    })}\n`)
  }
  const lock = join(process.cwd(), '.documents-migration.lock')
  if (await readFile(lock, 'utf8') !== '') throw new Error('fixture lock ownership changed')
  await unlink(lock)
  const documents = await ctx.userDocs.list()
  process.stdout.write(`${JSON.stringify({
    operation: 'retry-list',
    documents: documents.map(document => ({ docId: document.docId, name: document.name, bytes: document.bytes })),
    migratedText: await readFile(join(process.cwd(), 'documents', 'brief.txt'), 'utf8'),
  })}\n`)
  const original = documents[0]
  if (original === undefined) throw new Error('document migration produced no document')
  await ctx.userDocs.trash(original.docId)
  const manifestPath = join(process.cwd(), 'documents', '.dsh-trash', 'manifest.json')
  const originalManifest = await readFile(manifestPath, 'utf8')
  const damagedManifest = JSON.stringify({ version: 2, records: [] })
  await writeFile(manifestPath, damagedManifest)
  const refused: string[] = []
  for (const [operation, run] of [
    ['list', () => ctx.userDocs.listTrash()],
    ['restore', () => ctx.userDocs.restore(original.docId)],
    ['purge', () => ctx.userDocs.purge(original.docId)],
  ] as const) {
    try {
      await run()
      throw new Error(`document trash accepted an unknown manifest during ${operation}`)
    } catch (error) {
      if (!(error instanceof UserDocError) || error.code !== DOCUMENT_TRASH_NOT_FOUND_CODE) throw error
      refused.push(operation)
    }
    if (await readFile(manifestPath, 'utf8') !== damagedManifest) throw new Error('document trash replaced a refused manifest')
  }
  await writeFile(manifestPath, originalManifest)
  const restored = await ctx.userDocs.restore(original.docId)
  process.stdout.write(`${JSON.stringify({
    operation: 'trash-manifest-recovery', refused,
    restoredText: await readFile(restored.path, 'utf8'),
    remainingTrash: (await ctx.userDocs.listTrash()).length,
  })}\n`)
  await ctx.userDocs.trash(restored.docId)
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { records: Array<{ trashPath: string }> }
  const hidden = manifest.records[0]?.trashPath
  if (hidden === undefined) throw new Error('document trash contains no hidden entry')
  const originalLink = fs.link
  const originalRename = fs.rename
  const occupy = async (source: PathLike, target: PathLike): Promise<void> => {
    if (source === hidden && target === restored.path) {
      await writeFile(restored.path, 'concurrent upload', { flag: 'wx' })
    }
  }
  fs.link = async (source, target) => { await occupy(source, target); return originalLink(source, target) }
  fs.rename = async (source, target) => { await occupy(source, target); return originalRename(source, target) }
  syncBuiltinESMExports()
  let conflictCode = ''
  try {
    await ctx.userDocs.restore(restored.docId)
    throw new Error('document restore overwrote a concurrent upload')
  } catch (error) {
    if (!(error instanceof UserDocError) || error.code !== 'DOCUMENT_RESTORE_CONFLICT') throw error
    conflictCode = error.code
  } finally {
    fs.link = originalLink
    fs.rename = originalRename
    syncBuiltinESMExports()
  }
  const occupiedText = await readFile(restored.path, 'utf8')
  const recoverableText = await readFile(hidden, 'utf8')
  const retry = await ctx.userDocs.restore(restored.docId)
  process.stdout.write(`${JSON.stringify({
    operation: 'restore-publication-conflict', code: conflictCode, occupiedText, recoverableText,
    retryDocId: retry.docId, retryText: await readFile(retry.path, 'utf8'),
    remainingTrash: (await ctx.userDocs.listTrash()).length,
  })}\n`)
  const root = join(process.cwd(), 'documents')
  const expired = await ctx.userDocs.save(await ctx.userDocs.resolveTarget({ name: 'retention.txt' }), body('expired bytes'))
  await trashDocument(root, expired.docId, 0)
  const now = Date.now()
  const lockEntered = Promise.withResolvers<undefined>(), lockGranted = Promise.withResolvers<undefined>()
  const originalOpen = fs.open
  let waiting = true
  fs.open = async (...args: Parameters<typeof originalOpen>) => {
    if (args[0] === `${manifestPath}.lock` && waiting) {
      waiting = false
      lockEntered.resolve(undefined)
      await lockGranted.promise
    }
    return originalOpen(...args)
  }
  syncBuiltinESMExports()
  let cleanup: Promise<number> | undefined
  try {
    cleanup = purgeDueDocuments(root, now)
    await Promise.race([lockEntered.promise, cleanup.then(() => { throw new Error('retention cleanup did not wait for its writer lock') })])
    await ctx.userDocs.purge(expired.docId)
    const replacement = await ctx.userDocs.save(await ctx.userDocs.resolveTarget({ name: 'retention.txt' }), body('new recoverable bytes'))
    await ctx.userDocs.trash(replacement.docId)
    lockGranted.resolve(undefined)
    const purged = await cleanup
    const restoredReplacement = await ctx.userDocs.restore(replacement.docId)
    process.stdout.write(`${JSON.stringify({
      operation: 'retention-after-replacement', purged,
      restoredText: await readFile(restoredReplacement.path, 'utf8'),
      remainingTrash: (await ctx.userDocs.listTrash()).length,
    })}\n`)
  } finally {
    lockGranted.resolve(undefined)
    fs.open = originalOpen
    syncBuiltinESMExports()
    await cleanup
  }
  for (const kind of ['future-version', 'missing-manifest'] as const) {
    const bytes = Buffer.from('received bytes')
    const upload = await ctx.userDocs.beginUpload({ name: `${kind}.txt`, directoryId: UserDocDirectoryId(''),
      bytes: bytes.length, fingerprint: kind })
    await ctx.userDocs.writeUploadChunk(upload.uploadId, { index: 0, start: 0, end: bytes.length - 1, total: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), body: body(bytes.toString()) })
    const directory = join(root, '.upload-sessions', 'v1', upload.uploadId), path = join(directory, 'manifest.json')
    const originalManifest = await readFile(path, 'utf8')
    await ctx.fiber.dispose()
    if (kind === 'future-version') {
      await writeFile(path, JSON.stringify({ ...JSON.parse(originalManifest) as Record<string, unknown>, formatVersion: 999 }))
    } else await unlink(path)
    ctx = await boot('userdoc-migration-snapshot', resolveConfigPath(configPath, undefined))
    let refused = false
    try { await ctx.userDocs.list() } catch (error) {
      if (kind !== 'future-version' || !(error instanceof UserDocError) || error.code !== DOCUMENT_UPLOAD_NOT_FOUND_CODE) throw error
      refused = true
    }
    const retained = await readFile(join(directory, 'data.part'), 'utf8')
    if (retained !== bytes.toString()) throw new Error('Upload cleanup lost received bytes')
    if (kind === 'future-version' && !refused) throw new Error('Unknown upload metadata was accepted')
    await writeFile(path, originalManifest)
    await ctx.userDocs.list()
    process.stdout.write(`${JSON.stringify({ operation: 'upload-metadata-recovery', kind, refused, retained,
      receivedBytes: (await ctx.userDocs.inspectUpload(upload.uploadId)).receivedBytes })}\n`)
  }
} finally {
  await ctx.fiber.dispose()
}
