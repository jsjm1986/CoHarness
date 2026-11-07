import * as fs from 'node:fs/promises'
import type { PathLike } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { UserDocId } from '@deepseek-ai/dsh-userdoc'
import { listTrash, restoreDocument, trashDocument } from '../src/trash.ts'

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises')
  return { ...actual, link: vi.fn(actual.link), rename: vi.fn(actual.rename), unlink: vi.fn(actual.unlink) }
})

const actual = await vi.importActual<typeof fs>('node:fs/promises')

async function samePath(path: PathLike, expected: string): Promise<boolean> {
  return typeof path === 'string' && basename(path) === basename(expected)
    && await actual.realpath(dirname(path)) === await actual.realpath(dirname(expected))
}

beforeEach(() => {
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link)
  vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename)
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink)
})

async function recoverableDocument() {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-trash-publication-'))
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  const docId = UserDocId('notes.txt')
  const target = join(root, docId)
  await fs.writeFile(target, 'recoverable bytes')
  await trashDocument(root, docId, 30 * 86_400_000)
  const path = join(root, '.dsh-trash', 'manifest.json')
  const manifest = await fs.readFile(path, 'utf8')
  const records = (JSON.parse(manifest) as { records: Array<{ trashPath: string }> }).records
  const hidden = records[0]?.trashPath
  if (hidden === undefined) throw new Error('The seeded document has no hidden file.')
  return { root, docId, target, path, hidden, manifest }
}

it.each([false, true])('preserves document bytes when a trash manifest commit fails with occupied source %s', async (occupied) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'dsh-trash-rollback-'))
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
  const source = join(root, 'notes.txt'), manifest = join(root, '.dsh-trash', 'manifest.json')
  const commitFailure = Object.assign(new Error('refused trash manifest commit'), { code: 'EACCES' })
  await fs.writeFile(source, 'original bytes')
  let hidden: string | undefined
  vi.mocked(fs.rename).mockImplementation(async (from, to) => {
    if (basename(String(from)) === 'notes.txt') hidden = join(root, '.dsh-trash', basename(String(to)))
    if (to === manifest) {
      if (occupied) await actual.writeFile(source, 'concurrent document')
      throw commitFailure
    }
    return actual.rename(from, to)
  })
  const failure = await trashDocument(root, UserDocId('notes.txt'), 60_000).then(
    () => { throw new Error('Trash accepted a failed manifest commit.') },
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
  expect(await fs.readFile(source, 'utf8')).toBe(occupied ? 'concurrent document' : 'original bytes')
  if (hidden === undefined) throw new Error('Trash never retained its selected source.')
  if (occupied) {
    expect(failure).toMatchObject({ cause: { errors: [commitFailure, { code: 'EEXIST' }] } })
    expect(await fs.readFile(hidden, 'utf8')).toBe('original bytes')
    await expect(listTrash(root)).rejects.toMatchObject({ code: 'DOCUMENT_TRASH_NOT_FOUND' })
  } else {
    expect(failure).toMatchObject({ cause: commitFailure })
    await expect(fs.readFile(hidden)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listTrash(root)).toEqual([])
  }
})

it('retains both documents when an upload occupies the restore target after its lookup', async () => {
  const fixture = await recoverableDocument()
  const occupy = async (source: PathLike, target: PathLike): Promise<void> => {
    if (await samePath(source, fixture.hidden) && await samePath(target, fixture.target)) {
      await actual.writeFile(fixture.target, 'concurrent upload')
    }
  }
  vi.mocked(fs.link).mockImplementation(async (source, target) => {
    await occupy(source, target)
    return actual.link(source, target)
  })
  vi.mocked(fs.rename).mockImplementation(async (source, target) => {
    await occupy(source, target)
    return actual.rename(source, target)
  })

  await expect(restoreDocument(fixture.root, fixture.docId)).rejects.toMatchObject({ code: 'DOCUMENT_RESTORE_CONFLICT' })
  expect(await fs.readFile(fixture.target, 'utf8')).toBe('concurrent upload')
  expect(await fs.readFile(fixture.hidden, 'utf8')).toBe('recoverable bytes')
  expect(await fs.readFile(fixture.path, 'utf8')).toBe(fixture.manifest)
  expect(await listTrash(fixture.root)).toHaveLength(1)
})

it('restores under a suffix when the original name is already occupied', async () => {
  const fixture = await recoverableDocument()
  await fs.writeFile(fixture.target, 'current document')
  const restored = await restoreDocument(fixture.root, fixture.docId)
  expect(restored.docId).toBe('notes (2).txt')
  expect(await fs.readFile(restored.path, 'utf8')).toBe('recoverable bytes')
  expect(await fs.readFile(fixture.target, 'utf8')).toBe('current document')
  expect(await listTrash(fixture.root)).toEqual([])
  await expect(fs.readFile(fixture.hidden)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['hidden-removal', 'manifest-commit'] as const)('retains recoverability after failed %s', async (point) => {
  const fixture = await recoverableDocument()
  const failure = Object.assign(new Error(`refused ${point}`), { code: 'EACCES' })
  vi.mocked(fs.unlink).mockImplementation(async (path) => {
    if (point === 'hidden-removal' && await samePath(path, fixture.hidden)) throw failure
    return actual.unlink(path)
  })
  vi.mocked(fs.rename).mockImplementation(async (source, target) => {
    if (point === 'manifest-commit' && target === fixture.path) throw failure
    return actual.rename(source, target)
  })

  await expect(restoreDocument(fixture.root, fixture.docId))
    .rejects.toMatchObject({ code: 'DOCUMENT_RESTORE_CONFLICT', cause: failure })
  expect(await fs.readFile(fixture.hidden, 'utf8')).toBe('recoverable bytes')
  expect(await fs.readFile(fixture.path, 'utf8')).toBe(fixture.manifest)
  await expect(fs.readFile(fixture.target)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['refused-link', 'occupied-hidden', 'refused-cleanup'] as const)('retains file bytes and both failures after %s prevents rollback', async (point) => {
  const fixture = await recoverableDocument()
  const commitFailure = Object.assign(new Error('refused manifest commit'), { code: 'EACCES' })
  const rollbackFailure = Object.assign(new Error('refused rollback'), { code: 'EBUSY' })
  vi.mocked(fs.rename).mockImplementation(async (source, target) => {
    if (target === fixture.path) {
      if (point === 'occupied-hidden') await actual.writeFile(fixture.hidden, 'other hidden bytes')
      throw commitFailure
    }
    return actual.rename(source, target)
  })
  vi.mocked(fs.link).mockImplementation(async (source, target) => {
    if (point === 'refused-link' && await samePath(source, fixture.target) && await samePath(target, fixture.hidden)) throw rollbackFailure
    return actual.link(source, target)
  })
  vi.mocked(fs.unlink).mockImplementation(async (path) => {
    if (point === 'refused-cleanup' && await samePath(path, fixture.target)) throw rollbackFailure
    return actual.unlink(path)
  })

  const failure = await restoreDocument(fixture.root, fixture.docId).then(
    () => { throw new Error('Restore accepted a failed manifest commit.') },
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({ code: 'DOCUMENT_RESTORE_CONFLICT' })
  const combined = (failure as { cause: unknown }).cause
  expect(combined).toBeInstanceOf(AggregateError)
  if (!(combined instanceof AggregateError)) throw new Error('Restore did not retain both failure causes.')
  expect(combined.errors[0]).toBe(commitFailure)
  if (point !== 'occupied-hidden') expect(combined.errors[1]).toBe(rollbackFailure)
  expect(await fs.readFile(fixture.target, 'utf8')).toBe('recoverable bytes')
  expect(await fs.readFile(fixture.path, 'utf8')).toBe(fixture.manifest)
  if (point === 'occupied-hidden') expect(await fs.readFile(fixture.hidden, 'utf8')).toBe('other hidden bytes')
  if (point === 'refused-cleanup') expect(await fs.readFile(fixture.hidden, 'utf8')).toBe('recoverable bytes')
})
