/** Real runnable provider checks existing and late-replacement POSIX named pipes in an owned child process. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { basename, dirname, join } from 'node:path'

const bootEntry = process.env.DSH_PARTS_BOOT_ENTRY, vocabularyEntry = process.env.DSH_PARTS_VOCABULARY_ENTRY
if (bootEntry === undefined || vocabularyEntry === undefined) throw new Error('Document FIFO fixture requires explicit artifact entries.')
const { boot, resolveConfigPath } = await import(bootEntry)
const { UserDocId } = await import(vocabularyEntry)
const config = process.argv[2]
if (config === undefined) throw new Error('Document FIFO fixture requires a Loader configuration.')
const ctx = await boot('document-fifo-fixture', resolveConfigPath(config, undefined))
const execute = promisify(execFile), root = join(process.cwd(), 'documents')
let existing = 0, afterLookup = 0, handlesClosed = 0
try {
  await ctx.userDocs.resolveTarget({ name: 'initialize.txt' })
  const canonicalRoot = await fs.realpath(root)
  const pipe = join(root, 'pipe')
  await execute('mkfifo', [pipe])
  for (const method of ['stat', 'read', 'openRead']) {
    await assert.rejects(ctx.userDocs[method](UserDocId('pipe')), { code: 'DOCUMENT_NOT_FOUND' })
    existing += 1
  }
  for (const method of ['stat', 'read', 'openRead']) {
    const name = `late-${method}.txt`, path = join(root, name), open = fs.open
    await fs.writeFile(path, 'original regular file')
    let swapped = false, acquired
    fs.open = async (...args) => {
      const isDocument = typeof args[0] === 'string' && basename(args[0]) === name
        && await fs.realpath(dirname(args[0])) === canonicalRoot
      if (isDocument && !swapped) {
        swapped = true
        await fs.unlink(path)
        await execute('mkfifo', [path])
      }
      const handle = await open(...args)
      if (isDocument) acquired = handle
      return handle
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(ctx.userDocs[method](UserDocId(name)), { code: 'DOCUMENT_NOT_FOUND' })
      assert.equal(swapped, true)
      assert.equal(acquired?.fd, -1)
      afterLookup += 1; handlesClosed += 1
    } finally {
      fs.open = open; syncBuiltinESMExports()
      if (acquired !== undefined && acquired.fd !== -1) await acquired.close()
    }
  }
  process.stdout.write(`${JSON.stringify({ operation: 'fifo-refusals', existing, afterLookup, handlesClosed })}\n`)
} finally { await ctx.fiber.dispose() }
