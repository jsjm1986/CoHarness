import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { withFileLock, type FileLockOptions } from '@deepseek-ai/dsh-atomic-write'
import { UserDocId } from '@deepseek-ai/dsh-userdoc'
import { listTrash, purgeDocument, purgeDueDocuments, restoreDocument, trashDocument } from '../src/trash.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async () => {
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
  return { ...actual, withFileLock: vi.fn(actual.withFileLock) }
})

const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-atomic-write')>('@deepseek-ai/dsh-atomic-write')
beforeEach(() => { vi.mocked(withFileLock).mockReset().mockImplementation(actual.withFileLock) })

it.each(['replacement', 'restoration', 'renewal'] as const)('rechecks current trash after waiting behind a concurrent %s', async (change) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trash-retention-'))
  const entered = Promise.withResolvers<undefined>(), granted = Promise.withResolvers<undefined>()
  const operation: { cleanup?: Promise<number> } = {}
  onTestFinished(async () => {
    granted.resolve(undefined)
    try { await operation.cleanup } finally { await rm(root, { recursive: true, force: true }) }
  })
  const docId = UserDocId('retention.txt')
  const file = join(root, docId)
  const manifestPath = join(root, '.dsh-trash', 'manifest.json')
  await writeFile(file, 'old expired bytes')
  await trashDocument(root, docId, 0)
  const now = Date.now()
  let waiting = true
  vi.mocked(withFileLock).mockImplementation(async <T>(path: string, work: () => Promise<T>, options?: FileLockOptions): Promise<T> => {
    if (waiting && basename(path) === basename(manifestPath)
      && await realpath(dirname(path)) === await realpath(dirname(manifestPath))) {
      waiting = false
      entered.resolve(undefined)
      await granted.promise
    }
    return actual.withFileLock(path, work, options)
  })
  const cleanup = purgeDueDocuments(root, now)
  operation.cleanup = cleanup
  await Promise.race([entered.promise, cleanup.then(() => { throw new Error('Retention cleanup completed before lock admission.') })])

  if (change === 'replacement') {
    await purgeDocument(root, docId)
    await writeFile(file, 'new recoverable bytes')
    await trashDocument(root, docId, 30 * 86_400_000)
  } else if (change === 'restoration') {
    await restoreDocument(root, docId)
  } else {
    await actual.withFileLock(manifestPath, async () => {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { version: number; records: Array<{ purgeAfter: number }> }
      for (const record of manifest.records) record.purgeAfter = now + 30 * 86_400_000
      await actual.writeFileAtomic(manifestPath, JSON.stringify(manifest), { mode: 0o600 })
    })
  }
  granted.resolve(undefined)
  expect(await cleanup).toBe(0)
  if (change === 'restoration') {
    expect(await listTrash(root)).toEqual([])
    expect(await readFile(file, 'utf8')).toBe('old expired bytes')
  } else {
    expect(await listTrash(root)).toHaveLength(1)
    const restored = await restoreDocument(root, docId)
    expect(await readFile(restored.path, 'utf8')).toBe(change === 'replacement' ? 'new recoverable bytes' : 'old expired bytes')
  }
})

it('commits each expired removal once and leaves future retention intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trash-retention-expiry-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  for (const name of ['first.txt', 'second.txt', 'kept.txt']) {
    const docId = UserDocId(name)
    await writeFile(join(root, name), name)
    await trashDocument(root, docId, name === 'kept.txt' ? 30 * 86_400_000 : 0)
  }
  const now = Date.now()
  expect(await purgeDueDocuments(root, now)).toBe(2)
  expect(await purgeDueDocuments(root, now)).toBe(0)
  expect((await listTrash(root)).map(record => record.docId)).toEqual(['kept.txt'])
  const kept = await restoreDocument(root, UserDocId('kept.txt'))
  expect(await readFile(kept.path, 'utf8')).toBe('kept.txt')
})
