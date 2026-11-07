/** Real native directory moves after a parent changes between its last stat and rename. */
import assert from 'node:assert/strict'
import fs, { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withDocumentDirectoryMove } from '../../src/directory-move.ts'

/**
 * Replace a parent after its final lexical stat while the native move owns directory handles.
 * @param side - source or destination parent to replace with an outside symlink.
 * @returns byte-preservation observations after all native handles and temporary paths settle.
 */
export async function replayDocumentDirectoryParent(side: 'source' | 'target'): Promise<Readonly<Record<string, unknown>>> {
  assert.notEqual(process.platform, 'win32', 'Windows excludes parent replacement while its directory handle is open')
  const root = await mkdtemp(join(tmpdir(), 'dsh-directory-parent-'))
  const original = fs.lstat
  try {
    const parent = join(root, 'parent'), held = join(root, 'held'), outside = join(root, 'outside')
    await mkdir(parent); await mkdir(outside)
    const source = side === 'source' ? join(parent, 'selected') : join(root, 'source')
    const target = side === 'target' ? join(parent, 'moved') : join(root, 'target')
    await mkdir(source); await writeFile(join(source, 'file.txt'), 'selected bytes')
    await mkdir(join(outside, 'selected'))
    await writeFile(join(outside, 'selected', 'foreign.txt'), 'foreign bytes')
    let observations = 0, swapped = false, renamed = false
    // The forwarding wrapper preserves the fs overload selected by the original arguments.
    fs.lstat = (async (...args: Parameters<typeof original>) => {
      const info = await original(...args)
      if (String(args[0]) === parent && ++observations === 2) {
        await rename(parent, held)
        await symlink(outside, parent, 'dir')
        swapped = true
      }
      return info
    }) as typeof original
    syncBuiltinESMExports()
    try {
      await assert.rejects(withDocumentDirectoryMove(root, source, target, async (move) => {
        await move.rename()
        renamed = move.renamed
        await move.verify()
      }), /real directory/u)
    } finally { fs.lstat = original; syncBuiltinESMExports() }
    assert.equal(swapped, true)
    assert.equal(renamed, true)
    assert.equal(await readFile(join(outside, 'selected', 'foreign.txt'), 'utf8'), 'foreign bytes')
    assert.deepEqual(await readdir(outside), ['selected'])
    assert.equal(await readFile(join(side === 'source' ? target : join(held, 'moved'), 'file.txt'), 'utf8'), 'selected bytes')
    assert.equal((await lstat(parent)).isSymbolicLink(), true)
    return { operation: `directory-${side}-parent`, outsidePreserved: true, selectedBytesPreserved: true, refused: true }
  } finally {
    fs.lstat = original; syncBuiltinESMExports()
    await rm(root, { recursive: true, force: true })
  }
}
