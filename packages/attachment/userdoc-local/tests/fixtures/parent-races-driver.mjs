/** Public document operations refuse replaced Linux parents through the real Loader service. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

const bootEntry = process.env.DSH_PARTS_BOOT_ENTRY, vocabularyEntry = process.env.DSH_PARTS_VOCABULARY_ENTRY
if (bootEntry === undefined || vocabularyEntry === undefined) throw new Error('Document parent fixture requires explicit artifact entries.')
const { boot, resolveConfigPath } = await import(bootEntry)
const { UserDocId, UserDocDirectoryId } = await import(vocabularyEntry)
const config = process.argv[2]
if (config === undefined || process.platform !== 'linux') throw new Error('Document parent fixture requires Linux and a Loader configuration.')
const ctx = await boot('document-parent-fixture', resolveConfigPath(config, undefined))
const root = join(process.cwd(), 'documents'), open = fs.open, rename = fs.rename, link = fs.link, mkdir = fs.mkdir
const unlink = fs.unlink
try {
  await ctx.userDocs.createDirectory(UserDocDirectoryId(''), 'save')
  const directory = join(root, 'save'), retained = join(root, 'save-retained'), outside = join(process.cwd(), 'outside-save')
  await fs.mkdir(outside); await fs.writeFile(join(outside, 'sentinel.txt'), 'unrelated file')
  const target = await ctx.userDocs.resolveTarget({ directoryId: UserDocDirectoryId('save'), name: 'notes.txt' })
  let swapped = false, sent = false, outsideWritten = false
  fs.open = async (...args) => {
    if (!swapped && basename(String(args[0])).startsWith('.userdoc-')) {
      swapped = true; await rename(directory, retained); await fs.symlink(outside, directory, 'dir')
    }
    return open(...args)
  }
  syncBuiltinESMExports()
  const body = new ReadableStream({
    async pull(controller) {
      if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('authorized upload')); return }
      outsideWritten = (await fs.readdir(outside)).some(name => name.startsWith('.userdoc-'))
      controller.close()
    },
  }, { highWaterMark: 0 })
  try {
    await assert.rejects(ctx.userDocs.save(target, body), { code: 'INVALID_DOCUMENT_REF' })
    assert.equal(swapped, true); assert.equal(outsideWritten, false)
    assert.deepEqual(await fs.readdir(outside), ['sentinel.txt'])
    assert.deepEqual(await fs.readdir(retained), [])
    process.stdout.write(`${JSON.stringify({ operation: 'ordinary-save-parent', code: 'INVALID_DOCUMENT_REF', outsideUntouched: true, partialRemoved: true })}\n`)
  } finally { fs.open = open; syncBuiltinESMExports() }

  await ctx.userDocs.createDirectory(UserDocDirectoryId(''), 'trash')
  const trashDirectory = join(root, 'trash'), trashRetained = join(root, 'trash-retained')
  const trashOutside = join(process.cwd(), 'outside-trash')
  await fs.mkdir(trashOutside); await fs.writeFile(join(trashOutside, 'notes.txt'), 'unrelated file')
  await fs.writeFile(join(trashDirectory, 'notes.txt'), 'authorized document')
  let trashSwapped = false
  fs.rename = async (...args) => {
    if (!trashSwapped && basename(String(args[0])) === 'notes.txt') {
      trashSwapped = true; await rename(trashDirectory, trashRetained); await fs.symlink(trashOutside, trashDirectory, 'dir')
    }
    return rename(...args)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(ctx.userDocs.trash(UserDocId('trash/notes.txt')), { code: 'DOCUMENT_TRASH_NOT_FOUND' })
    assert.equal(trashSwapped, true)
    assert.equal(await fs.readFile(join(trashOutside, 'notes.txt'), 'utf8'), 'unrelated file')
    assert.equal(await fs.readFile(join(trashRetained, 'notes.txt'), 'utf8'), 'authorized document')
    assert.deepEqual(await ctx.userDocs.listTrash(), [])
    process.stdout.write(`${JSON.stringify({ operation: 'ordinary-trash-parent', code: 'DOCUMENT_TRASH_NOT_FOUND', outsideUntouched: true, sourceRestored: true })}\n`)
  } finally { fs.rename = rename; syncBuiltinESMExports() }

  await ctx.userDocs.createDirectory(UserDocDirectoryId(''), 'restore')
  const restoreDirectory = join(root, 'restore'), restoreRetained = join(root, 'restore-retained')
  const restoreOutside = join(process.cwd(), 'outside-restore'), docId = UserDocId('restore/notes.txt')
  await fs.mkdir(restoreOutside); await fs.writeFile(join(restoreOutside, 'sentinel.txt'), 'unrelated file')
  await fs.writeFile(join(restoreDirectory, 'notes.txt'), 'recoverable document')
  await ctx.userDocs.trash(docId)
  let restoreSwapped = false
  fs.link = async (...args) => {
    if (!restoreSwapped && basename(String(args[1])) === 'notes.txt') {
      restoreSwapped = true; await rename(restoreDirectory, restoreRetained); await fs.symlink(restoreOutside, restoreDirectory, 'dir')
    }
    return link(...args)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(ctx.userDocs.restore(docId), { code: 'DOCUMENT_RESTORE_CONFLICT' })
    assert.equal(restoreSwapped, true)
    assert.deepEqual(await fs.readdir(restoreOutside), ['sentinel.txt'])
    assert.deepEqual(await fs.readdir(restoreRetained), [])
    assert.equal((await ctx.userDocs.listTrash()).length, 1)
    const recovered = await ctx.userDocs.restore(docId, UserDocDirectoryId(''), 'recovered.txt')
    assert.equal(await fs.readFile(recovered.path, 'utf8'), 'recoverable document')
    process.stdout.write(`${JSON.stringify({ operation: 'ordinary-restore-parent', code: 'DOCUMENT_RESTORE_CONFLICT', outsideUntouched: true, recoverable: true })}\n`)
  } finally { fs.link = link; syncBuiltinESMExports() }

  const missingParent = await ctx.userDocs.createDirectory(UserDocDirectoryId(''), 'restore-directory')
  const missing = await ctx.userDocs.createDirectory(missingParent.directoryId, 'missing')
  const missingDocId = UserDocId('restore-directory/missing/notes.txt'), missingRetained = join(root, 'restore-directory-retained')
  const missingOutside = join(process.cwd(), 'outside-restore-directory')
  await fs.mkdir(missingOutside); await fs.writeFile(join(missing.path, 'notes.txt'), 'recoverable directory document')
  await ctx.userDocs.trash(missingDocId); await fs.rmdir(missing.path)
  let directorySwapped = false
  fs.mkdir = async (...args) => {
    if (!directorySwapped && basename(String(args[0])) === 'missing') {
      directorySwapped = true; await rename(missingParent.path, missingRetained); await fs.symlink(missingOutside, missingParent.path, 'dir')
    }
    return mkdir(...args)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(ctx.userDocs.restore(missingDocId), { code: 'DOCUMENT_RESTORE_CONFLICT' })
    assert.equal(directorySwapped, true)
    assert.deepEqual(await fs.readdir(missingOutside), [])
    assert.deepEqual(await fs.readdir(missingRetained), [])
    const recovered = await ctx.userDocs.restore(missingDocId, UserDocDirectoryId(''), 'directory-recovered.txt')
    assert.equal(await fs.readFile(recovered.path, 'utf8'), 'recoverable directory document')
    process.stdout.write(`${JSON.stringify({ operation: 'restore-directory-parent', code: 'DOCUMENT_RESTORE_CONFLICT', outsideUntouched: true, recoverable: true })}\n`)
  } finally { fs.mkdir = mkdir; syncBuiltinESMExports() }

  const purgeId = UserDocId('purge-parent.txt'), trash = join(root, '.dsh-trash'), trashRetainedPath = join(root, 'purge-trash-retained')
  const purgeOutside = join(process.cwd(), 'outside-purge')
  await fs.mkdir(purgeOutside); await fs.writeFile(join(root, purgeId), 'authorized purge document')
  await ctx.userDocs.trash(purgeId)
  const hidden = (await fs.readdir(trash)).find(name => name.endsWith('.bin'))
  assert.ok(hidden)
  await fs.writeFile(join(purgeOutside, hidden), 'unrelated file')
  let purgeSwapped = false
  fs.unlink = async (...args) => {
    if (!purgeSwapped && basename(String(args[0])) === hidden) {
      purgeSwapped = true; await rename(trash, trashRetainedPath); await fs.symlink(purgeOutside, trash, 'dir')
    }
    return unlink(...args)
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(ctx.userDocs.purge(purgeId), { code: 'DOCUMENT_TRASH_NOT_FOUND' })
    assert.equal(purgeSwapped, true)
    assert.equal(await fs.readFile(join(purgeOutside, hidden), 'utf8'), 'unrelated file')
    assert.deepEqual(await fs.readdir(purgeOutside), [hidden])
    await unlink(trash); await rename(trashRetainedPath, trash)
    await ctx.userDocs.purge(purgeId)
    assert.deepEqual(await ctx.userDocs.listTrash(), [])
    process.stdout.write(`${JSON.stringify({ operation: 'ordinary-purge-parent', code: 'DOCUMENT_TRASH_NOT_FOUND', outsideUntouched: true, retryCompleted: true })}\n`)
  } finally { fs.unlink = unlink; syncBuiltinESMExports() }
} finally {
  fs.open = open; fs.rename = rename; fs.link = link; fs.mkdir = mkdir
  fs.unlink = unlink; syncBuiltinESMExports()
  await ctx.fiber.dispose()
}
