/** A failed document move must retain its bytes when restoring the source fails. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { UserDocDirectoryId, UserDocId } from '@deepseek-ai/dsh-userdoc'
import * as rootedFs from '../src/rooted-fs.ts'
import { moveDocFile } from '../src/store.ts'

it.each([false, true])('retains original bytes after post-move validation fails (source occupied: %s)', async (occupied) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-move-rollback-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'report.txt'), target = join(root, 'archive', 'report.txt')
  await mkdir(join(root, 'archive'))
  await writeFile(source, 'original document')
  const validationFailure = new Error('Document parent changed after source removal.')
  const withRootedPaths = rootedFs.withRootedDocumentPaths
  const intercept = vi.spyOn(rootedFs, 'withRootedDocumentPaths').mockImplementation(async (base, paths, operation) =>
    withRootedPaths(base, paths, async (pinned) => {
      if (paths.length !== 2) return operation(pinned)
      let verified = false
      return operation({ ...pinned, verify: async () => {
        if (!verified) { verified = true; await pinned.verify(); return }
        await expect(readFile(source)).rejects.toMatchObject({ code: 'ENOENT' })
        if (occupied) await writeFile(source, 'concurrent document', { flag: 'wx' })
        throw validationFailure
      } })
    }))
  try {
    const failure = await moveDocFile(root, UserDocId('report.txt'), UserDocDirectoryId('archive')).then(
      () => { throw new Error('The move accepted failed directory validation.') },
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'DOCUMENT_MOVE_FAILED' })
    if (occupied) {
      expect(failure).toMatchObject({ cause: { errors: [validationFailure, { code: 'EEXIST' }] } })
      expect(await readFile(source, 'utf8')).toBe('concurrent document')
      expect(await readFile(target, 'utf8')).toBe('original document')
    } else {
      expect(failure).toMatchObject({ cause: validationFailure })
      expect(await readFile(source, 'utf8')).toBe('original document')
      await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  } finally { intercept.mockRestore() }
})
