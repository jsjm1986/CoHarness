import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReviewStore, type StoredReview } from '../src/review-store.ts'

const faults = vi.hoisted(() => ({ link: false, removeExisting: false, unlink: '' as '' | 'pending' | 'probe', noSpace: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async link(...args: Parameters<typeof actual.link>) {
      if (faults.link) throw Object.assign(new Error('fixture link I/O failure'), { code: 'EIO' })
      try { await actual.link(...args) } catch (error) {
        if (faults.removeExisting && (error as NodeJS.ErrnoException).code === 'EEXIST') await actual.unlink(args[1])
        throw error
      }
    },
    async unlink(...args: Parameters<typeof actual.unlink>) {
      if (faults.unlink !== '' && String(args[0]).endsWith(`.${faults.unlink}`)) {
        throw Object.assign(new Error('fixture cleanup permission failure'), { code: 'EACCES' })
      }
      await actual.unlink(...args)
    },
    async statfs(...args: Parameters<typeof actual.statfs>) {
      const result = await actual.statfs(...args)
      if (faults.noSpace) result.bavail = typeof result.bavail === 'bigint' ? 0n : 0
      return result
    },
  }
})

const roots: string[] = []
afterEach(async () => {
  faults.link = false; faults.removeExisting = false; faults.unlink = ''; faults.noSpace = false
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const sessionId = SessionId('review-session')
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const review: StoredReview = {
  version: 1, sessionId,
  summary: { turn: 1, cwd: '/workspace', total: 1, added: 1, deleted: 1,
    files: [{ path: 'file.txt', display: 'file.txt', added: 1, deleted: 1 }] },
  diffs: [{ kind: 'text', path: 'file.txt', display: 'file.txt', before: true, after: true, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }] }],
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'historical-review-'))
  roots.push(root)
  const store = new ReviewStore(root, 1024 * 1024)
  return { root, store, directory: join(root, sha(sessionId)) }
}

it('reopens exact historical comparisons from disk after the recorder is gone', async () => {
  const { root, store, directory } = await fixture()
  const id = await store.save(review)
  const before = await readFile(join(directory, `${id}.json`))
  await expect(store.save({ ...review, diffs: [] })).rejects.toThrow('file indices')
  expect(await new ReviewStore(root, 1024 * 1024).read(sessionId, id)).toEqual(review)
  expect(await store.save(review)).toBe(id)
  expect(await readFile(join(directory, `${id}.json`))).toEqual(before)
  await store.probe(sessionId)
  expect(await readdir(directory)).toEqual([`${id}.json`])
  expect(await store.read(SessionId('another-session'), id)).toBeUndefined()
  expect(await new ReviewStore(join(root, 'absent'), 1024).read(sessionId, id)).toBeUndefined()
})

it('rejects corrupted bytes, oversized records and non-regular artifacts', async () => {
  const { root, store, directory } = await fixture()
  const id = await store.save(review), file = join(directory, `${id}.json`)
  await expect(new ReviewStore(root, 2).read(sessionId, id)).rejects.toThrow('storage limit')
  await expect(new ReviewStore(root, 2).save(review)).rejects.toThrow('storage limit')
  await expect(store.read(sessionId, '../outside')).rejects.toThrow('identity')
  const aborted = AbortSignal.abort(new Error('cancelled read'))
  await expect(store.read(sessionId, id, aborted)).rejects.toThrow('cancelled read')
  await writeFile(file, '{}')
  await expect(store.read(sessionId, id)).rejects.toThrow('digest mismatch')
  await expect(store.save(review)).rejects.toThrow('digest mismatch')
  await rm(file)
  await mkdir(file)
  await expect(store.read(sessionId, id)).rejects.toThrow('regular file')
  expect(await readdir(directory)).toEqual([`${id}.json`])
})

it.each([
  { ...review, sessionId: 'other' },
  { ...review, diffs: [] },
  { ...review, diffs: [{ kind: 'binary', path: 'other', display: 'file.txt' }] },
  { ...review, version: 2 },
])('rejects structurally invalid records even when the content hash matches', async (record) => {
  const { store, directory } = await fixture()
  await mkdir(directory)
  const text = JSON.stringify(record), id = sha(text)
  await writeFile(join(directory, `${id}.json`), text)
  await expect(store.read(sessionId, id)).rejects.toThrow()
})

it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses writes to unavailable storage without replacing old reviews', async () => {
  const { store, directory } = await fixture()
  const id = await store.save(review)
  await chmod(directory, 0o500)
  try {
    await expect(store.probe(sessionId)).rejects.toThrow()
    await expect(store.save({ ...review, summary: { ...review.summary, turn: 2 } })).rejects.toThrow()
    expect(await store.read(sessionId, id)).toEqual(review)
  } finally { await chmod(directory, 0o700) }
  await store.probe(sessionId)
})

it.skipIf(process.platform === 'win32')('does not follow a Session storage directory replaced by a symlink', async () => {
  const { root, store, directory } = await fixture()
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, directory)
  await expect(store.save(review)).rejects.toThrow('symbolic-link')
  expect(await readdir(outside)).toEqual([])
})

it('refuses publication failures and a concurrently removed matching artifact', async () => {
  const { store, directory } = await fixture()
  faults.link = true
  await expect(store.save(review)).rejects.toThrow('I/O failure')
  expect(await readdir(directory)).toEqual([])
  faults.link = false
  const id = await store.save(review)
  faults.removeExisting = true
  await expect(store.save(review)).rejects.toThrow('disappeared')
  expect(await store.read(sessionId, id)).toBeUndefined()
  expect(await readdir(directory)).toEqual([])
})

it('does not declare storage repaired with insufficient capacity, space or incomplete cleanup', async () => {
  const { root, store } = await fixture()
  const id = await store.save(review)
  await expect(new ReviewStore(root, 2).probe(sessionId, 100)).rejects.toThrow('storage limit')
  faults.noSpace = true
  await expect(store.probe(sessionId)).rejects.toThrow('insufficient free space')
  expect(await store.read(sessionId, id)).toEqual(review)
  faults.noSpace = false
  faults.unlink = 'probe'
  await expect(store.probe(sessionId)).rejects.toThrow('cleanup permission failure')
  faults.unlink = 'pending'
  await expect(store.save(review)).rejects.toThrow('cleanup permission failure')
  expect(await store.read(sessionId, id)).toEqual(review)
})

it('purges one released Session without deleting another owner or accepting a non-directory', async () => {
  const { store, directory } = await fixture()
  const first = review, second = { ...first, sessionId: SessionId('other-review-owner') }
  const saved = await store.save(first), other = await store.save(second)
  await expect(store.remove(sessionId, AbortSignal.abort())).rejects.toThrow()
  expect(await store.read(sessionId, saved)).toBeDefined()
  await store.remove(sessionId)
  await store.remove(sessionId)
  expect(await store.read(sessionId, saved)).toBeUndefined()
  expect(await store.read(second.sessionId, other)).toBeDefined()
  await writeFile(directory, 'not a review directory')
  await expect(store.remove(sessionId)).rejects.toThrow('not an owned directory')
  expect(await store.read(second.sessionId, other)).toBeDefined()
})
