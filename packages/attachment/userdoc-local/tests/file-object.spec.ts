/** Real hard links prove publication ownership independently of equal names and bytes. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile, unlink, link, symlink, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { UserDocIncarnationId } from '@deepseek-ai/dsh-userdoc'
import { DocumentFileAnchor, type DocumentFileSource, type DocumentFileObjectId } from '../src/file-object.ts'
import { DocumentIdentityStorage } from '../src/identity-storage.ts'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-document-object-')), root = join(base, 'documents')
  onTestFinished(async () => { await rm(base, { recursive: true, force: true }) })
  await mkdir(root)
  const storage = await DocumentIdentityStorage.open({ root, stateRoot: join(base, 'state'), filesRoot: join(base, 'files') })
  const source = join(root, 'source.part')
  await writeFile(source, 'same bytes')
  const token = { sequence: 1, incarnationId: UserDocIncarnationId(randomUUID()) }
  return { root, source, token, storage }
}

it('distinguishes identical bytes in different objects and preserves a foreign target', async () => {
  const f = await fixture()
  const target = join(f.root, 'report.txt')
  await writeFile(target, 'same bytes')
  const anchor = await DocumentFileAnchor.withSource(f.storage, f.source, source => source.capture(f.token))
  expect(await anchor.matches(f.source)).toBe(true)
  expect(await anchor.matches(target)).toBe(false)
  await expect(anchor.publish(target)).rejects.toThrow('another file object')
  expect(await readFile(target, 'utf8')).toBe('same bytes')
  expect(await readFile(f.source, 'utf8')).toBe('same bytes')
  await anchor.release()
})

it('recovers a retained object after its private upload partial has gone', async () => {
  const f = await fixture()
  const anchor = await DocumentFileAnchor.withSource(f.storage, f.source, source => source.capture(f.token))
  const expected = await DocumentFileAnchor.withSource(f.storage, f.source, async source => source.identity)
  await unlink(f.source)
  const resumed = await DocumentFileAnchor.reopen(f.storage, f.token, expected)
  if (resumed === undefined) throw new Error('The retained anchor must survive the source path.')
  const target = join(f.root, 'report.txt')
  await resumed.publish(target)
  await resumed.publish(target)
  expect(await resumed.matches(target)).toBe(true)
  await resumed.release()
  expect(await readFile(target, 'utf8')).toBe('same bytes')
  await anchor.release()
})

it('refuses a source replaced while its original handle is still open', async () => {
  const f = await fixture()
  await expect(DocumentFileAnchor.withSource(f.storage, f.source, async (source) => {
    await unlink(f.source)
    await writeFile(f.source, 'same bytes')
    return source.capture(f.token)
  })).rejects.toThrow('source file object has changed')
  expect(await readFile(f.source, 'utf8')).toBe('same bytes')
})

it('preserves a replaced private anchor and reports its cleanup failure', async () => {
  const f = await fixture()
  const anchor = await DocumentFileAnchor.withSource(f.storage, f.source, source => source.capture(f.token))
  await unlink(anchor.path)
  await writeFile(anchor.path, 'foreign bytes')
  await expect(anchor.publish(join(f.root, 'report.txt'))).rejects.toThrow('anchor has changed')
  const closing = anchor.release()
  expect(anchor.release()).toBe(closing)
  await expect(closing).rejects.toThrow('no longer belongs')
  expect(await readFile(anchor.path, 'utf8')).toBe('foreign bytes')
})

it('joins repeated cleanup and leaves another published link intact', async () => {
  const f = await fixture()
  const anchor = await DocumentFileAnchor.withSource(f.storage, f.source, source => source.capture(f.token))
  const target = join(f.root, 'report.txt')
  await anchor.publish(target)
  const closing = anchor.release()
  expect(anchor.release()).toBe(closing)
  await closing
  expect(await readFile(target, 'utf8')).toBe('same bytes')
})

it('accepts another hard link but refuses a symbolic link as object evidence', async () => {
  const f = await fixture()
  const alias = join(f.root, 'alias.txt'), symbolic = join(f.root, 'symbolic.txt')
  await link(f.source, alias)
  await DocumentFileAnchor.withSource(f.storage, f.source, async (source) => {
    await DocumentFileAnchor.withSource(f.storage, alias, async (linked) => { expect(linked.identity).toEqual(source.identity) })
  })
  await symlink(f.source, symbolic, 'file')
  await expect(DocumentFileAnchor.withSource(f.storage, symbolic, async source => source.identity)).rejects.toThrow('not a regular file')
})

it.each(['publish', 'detach'] as const)('refuses a symbolic leaf during %s while preserving its referent', async (operation) => {
  const f = await fixture()
  const target = join(f.root, 'symbolic.txt'), removed = join(f.storage.locations.filesRoot, 'removed', 'owned.source')
  const anchor = await DocumentFileAnchor.withSource(f.storage, f.source, source => source.capture(f.token))
  await symlink(f.source, target, 'file')
  try {
    await expect(operation === 'publish' ? anchor.publish(target) : anchor.detach(target, removed)).rejects.toThrow('not a regular file')
    expect(await readFile(f.source, 'utf8')).toBe('same bytes')
    expect(await readFile(target, 'utf8')).toBe('same bytes')
  } finally { await anchor.release() }
})

it('refuses a linked private directory without creating files in its referent', async () => {
  const f = await fixture()
  const external = await mkdtemp(join(tmpdir(), 'dsh-document-object-outside-'))
  onTestFinished(async () => { await rm(external, { recursive: true, force: true }) })
  await rm(f.storage.locations.filesRoot, { recursive: true })
  await symlink(external, f.storage.locations.filesRoot, process.platform === 'win32' ? 'junction' : 'dir')
  await expect(DocumentFileAnchor.withSource(f.storage, f.source, source => source.capture(f.token))).rejects.toThrow()
  await expect(readFile(join(external, 'anchors', `${String(f.token.sequence)}.${String(f.token.incarnationId)}.anchor`)))
    .rejects.toMatchObject({ code: 'ENOENT' })
})


it('does not capture a replacement source when the recovery anchor is absent', async () => {
  const f = await fixture()
  let expected: DocumentFileObjectId | undefined
  await DocumentFileAnchor.withSource(f.storage, f.source, async (source) => { expected = source.identity })
  if (expected === undefined) throw new Error('The opened source must provide evidence.')
  await expect(DocumentFileAnchor.reopen(f.storage, f.token, expected)).resolves.toBeUndefined()
  expect(await readFile(f.source, 'utf8')).toBe('same bytes')
})

it('refuses borrowing a source after its owner callback has returned', async () => {
  const f = await fixture()
  let borrowed: DocumentFileSource | undefined
  await DocumentFileAnchor.withSource(f.storage, f.source, async (source) => { borrowed = source })
  if (borrowed === undefined) throw new Error('The callback must observe its source.')
  await expect(borrowed.capture(f.token)).rejects.toThrow('already ended')
})
