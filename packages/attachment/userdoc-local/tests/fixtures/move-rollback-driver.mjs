/** Linux directory replacement during a real Loader document move preserves recoverable bytes. */
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'

const bootEntry = process.env.DSH_PARTS_BOOT_ENTRY, vocabularyEntry = process.env.DSH_PARTS_VOCABULARY_ENTRY
if (bootEntry === undefined || vocabularyEntry === undefined) throw new Error('Document move fixture requires explicit artifact entries.')
const { boot, resolveConfigPath } = await import(bootEntry)
const { UserDocId, UserDocDirectoryId } = await import(vocabularyEntry)
const config = process.argv[2]
if (config === undefined || process.platform !== 'linux') throw new Error('Document move fixture requires Linux and a Loader configuration.')
const ctx = await boot('document-move-fixture', resolveConfigPath(config, undefined))
const root = join(process.cwd(), 'documents'), unlink = fs.unlink
try {
  await ctx.userDocs.createDirectory(UserDocDirectoryId(''), 'archive')
  const source = join(root, 'report.txt'), target = join(root, 'archive'), retained = join(root, 'retained')
  await fs.writeFile(source, 'original document')
  const canonicalSource = await fs.realpath(source)
  let replaced = false
  fs.unlink = async path => {
    const isSource = !replaced && typeof path === 'string' && basename(path) === 'report.txt'
      && await fs.realpath(path) === canonicalSource
    await unlink(path)
    if (isSource) {
      replaced = true
      await fs.rename(target, retained)
      await fs.mkdir(target)
      await fs.writeFile(source, 'concurrent document', { flag: 'wx' })
    }
  }
  syncBuiltinESMExports()
  try {
    await assert.rejects(ctx.userDocs.move(UserDocId('report.txt'), UserDocDirectoryId('archive')), error =>
      error.code === 'DOCUMENT_MOVE_FAILED' && error.cause instanceof AggregateError
      && error.cause.errors[1]?.code === 'EEXIST')
    assert.equal(replaced, true)
    assert.equal(await fs.readFile(source, 'utf8'), 'concurrent document')
    assert.equal(await fs.readFile(join(retained, 'report.txt'), 'utf8'), 'original document')
    assert.deepEqual(await fs.readdir(target), [])
    process.stdout.write(`${JSON.stringify({ operation: 'move-rollback', rejected: true, originalRetained: true, concurrentFileIntact: true })}\n`)
  } finally { fs.unlink = unlink; syncBuiltinESMExports() }
} finally { await ctx.fiber.dispose() }
